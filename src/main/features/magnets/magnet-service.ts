import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DEFAULT_MAGNET_SETTINGS, MAGNET_ROOT, magnetCodeSchema, magnetResultSchema, type MagnetResult, type MagnetRow, type MagnetSettings } from '@shared/magnets';
import { PythonTaskHost, TaskCancelledError } from '../../platform/python';
import { sourceCooldownSeconds } from '../../platform/network';

const stateSchema = z.object({
	version: z.literal(1),
	results: z.array(magnetResultSchema).max(50),
	nextRequestAt: z.number().nonnegative(),
	cooldownUntil: z.number().nonnegative(),
});
type Stored = z.infer<typeof stateSchema>;

export class MagnetService {
	private state: Stored = { version: 1, results: [], nextRequestAt: 0, cooldownUntil: 0 };
	private loading: Promise<void> | undefined;
	private writes: Promise<void> = Promise.resolve();
	private active: { id: string; controller: AbortController; settings: MagnetSettings; completion?: Promise<MagnetResult> } | undefined;
	private cancelled = new Set<string>();
	private disposed = false;
	private directory: string;

	constructor(
		root: string,
		private host: Pick<PythonTaskHost, 'run'>,
		private resolveProxy: (url: string) => Promise<string>,
		private intervalMs = 2000,
		private settings: () => MagnetSettings = () => DEFAULT_MAGNET_SETTINGS,
	) {
		this.directory = join(root, 'magnet-search');
	}

	async search(id: string, input: string, force = false): Promise<MagnetResult> {
		const code = magnetCodeSchema.parse(input);
		if (this.disposed || this.cancelled.has(id)) {
			return this.result(code, 'cancelled', '查询已取消');
		}
		const settings = structuredClone(this.settings());
		if (!settings.enabled) {
			return this.result(code, 'failed', '磁链搜索已关闭，可在设置中启用', 'disabled');
		}
		if (this.active) {
			return this.result(code, 'failed', '已有磁链查询正在进行，请稍后重试', 'busy');
		}
		const active = { id, controller: new AbortController(), settings, completion: undefined as Promise<MagnetResult> | undefined };
		this.active = active;
		active.completion = this.execute(code, force, active.controller.signal, settings).finally(() => {
			if (this.active === active) {
				this.active = undefined;
			}
		});
		return active.completion;
	}

	async cancel(id: string): Promise<void> {
		this.cancelled.add(id);
		if (this.cancelled.size > 100) {
			this.cancelled.delete(this.cancelled.values().next().value!);
		}
		if (this.active?.id === id) {
			this.active.controller.abort();
			await this.active.completion;
		}
	}

	async row(code: string, id: string): Promise<MagnetRow | undefined> {
		if (!this.settings().enabled) {
			return undefined;
		}
		await this.load();
		return this.state.results.find((result) => result.code === code && result.status === 'ready')?.items.find((item) => item.id === id);
	}

	async settingsChanged(): Promise<void> {
		if (this.active && JSON.stringify(this.active.settings) !== JSON.stringify(this.settings())) {
			this.active.controller.abort();
			await this.active.completion?.catch(() => {});
		}
	}

	async stop(): Promise<void> {
		this.disposed = true;
		this.active?.controller.abort();
		await this.active?.completion?.catch(() => {});
		await this.writes.catch(() => {});
	}

	private async load(): Promise<void> {
		if (!this.loading) {
			this.loading = (async () => {
				await mkdir(this.directory, { recursive: true });
				const path = join(this.directory, 'state.json');
				try {
					if ((await stat(path)).size > 6 * 1024 * 1024) {
						throw new Error('MAGNET_STATE_LIMIT');
					}
					this.state = stateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
						throw error;
					}
				}
				for (const result of this.state.results) {
					if (result.status === 'running') {
						result.status = 'interrupted';
						result.message = '上次查询已中断，可手动重新查询';
					}
				}
			})().catch((error) => {
				this.loading = undefined;
				throw error;
			});
		}
		await this.loading;
	}

	private async execute(code: string, force: boolean, signal: AbortSignal, settings: MagnetSettings): Promise<MagnetResult> {
		let loaded = false;
		let result = this.result(code, 'running', '正在查询 Sukebei');
		try {
			await this.load();
			loaded = true;
			signal.throwIfAborted();
			const cached = this.state.results.find((item) => item.code === code);
			if (
				!force &&
				cached &&
				(['cancelled', 'interrupted', 'failed'].includes(cached.status) ||
					(cached.status === 'ready' && cached.limit >= settings.maxResults && Date.now() - Date.parse(cached.checkedAt) < (cached.items.length ? 30 : 5) * 60_000))
			) {
				return this.present(cached, settings);
			}
			if (this.state.cooldownUntil > Date.now()) {
				return { ...this.result(code, 'failed', 'Sukebei 正在冷却，请稍后重试', 'cooldown'), retryAfter: Math.ceil((this.state.cooldownUntil - Date.now()) / 1000) };
			}
			await this.save(result);
			const proxy = await this.route(signal);
			signal.throwIfAborted();
			let requests = 0;
			const payload = await this.host.run(
				'magnet.search',
				{ code, proxy, maxResults: settings.maxResults, transport: settings.transport },
				{
					signal,
					timeoutMs: 35_000,
					onRequest: async (request) => {
						signal.throwIfAborted();
						if (request.source !== 'sukebei' || request.host !== 'sukebei.nyaa.si' || ++requests > 3) {
							throw new Error('MAGNET_REQUEST_LIMIT');
						}
						const wait = this.state.nextRequestAt - Date.now();
						if (wait > 0) {
							await delay(wait, undefined, { signal });
						}
						signal.throwIfAborted();
						this.state.nextRequestAt = Date.now() + this.intervalMs;
						await this.save(result);
					},
				},
			);
			signal.throwIfAborted();
			result = magnetResultSchema.parse({ ...(payload as object), code, limit: settings.maxResults, checkedAt: new Date().toISOString() });
			result.items = result.items.slice(0, settings.maxResults);
			if (!['ready', 'failed'].includes(result.status)) {
				throw new Error('INVALID_MAGNET_RESULT');
			}
		} catch (error) {
			result =
				signal.aborted || error instanceof TaskCancelledError
					? this.result(code, 'cancelled', '查询已取消，可手动重新查询')
					: error instanceof z.ZodError
						? this.result(code, 'failed', '磁链返回格式与解析器不匹配', 'parse_error')
						: this.result(code, 'failed', loaded ? '磁链查询未完成，请重试或检查网络设置' : '磁链查询记录无法读取，请检查本地存储', loaded ? 'network' : 'storage');
		}
		if (loaded) {
			if (result.status === 'failed') {
				this.state.cooldownUntil = Date.now() + sourceCooldownSeconds(result.reason, result.retryAfter) * 1000;
			}
			try {
				await this.save(result);
			} catch {
				return this.result(code, 'failed', '磁链查询结果未能保存，请检查本地存储', 'storage');
			}
			if (signal.aborted && result.status !== 'cancelled') {
				result = this.result(code, 'cancelled', '查询已取消，可手动重新查询');
				await this.save(result);
			}
		}
		return this.present(result, settings);
	}

	private present(result: MagnetResult, settings: MagnetSettings): MagnetResult {
		const copy = structuredClone(result);
		copy.items = copy.items.slice(0, settings.maxResults);
		copy.limit = settings.maxResults;
		return copy;
	}

	private result(code: string, status: MagnetResult['status'], message: string, reason = ''): MagnetResult {
		return { code, status, items: [], limit: this.settings().maxResults, checkedAt: new Date().toISOString(), message, reason, requests: 0, retryAfter: 0 };
	}

	private async route(signal: AbortSignal): Promise<string> {
		signal.throwIfAborted();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort = (): void => {};
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new TaskCancelledError());
			signal.addEventListener('abort', abort, { once: true });
			timer = setTimeout(() => reject(new Error('PROXY_TIMEOUT')), 5000);
		});
		try {
			return await Promise.race([this.resolveProxy(MAGNET_ROOT), cancelled]);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
		}
	}

	private save(result: MagnetResult): Promise<void> {
		this.state.results = [result, ...this.state.results.filter((item) => item.code !== result.code)].slice(0, 50);
		const content = JSON.stringify(this.state);
		this.writes = this.writes
			.catch(() => {})
			.then(async () => {
				await writeFile(join(this.directory, 'state.tmp'), content, { mode: 0o600 });
				await rename(join(this.directory, 'state.tmp'), join(this.directory, 'state.json'));
			});
		return this.writes;
	}
}

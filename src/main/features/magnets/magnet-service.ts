import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
	DEFAULT_MAGNET_SETTINGS,
	MAGNET_SOURCES,
	magnetCodeSchema,
	magnetSourceSchema,
	magnetResultSchema,
	type MagnetResult,
	type MagnetRow,
	type MagnetSettings,
	type MagnetSource,
} from '@shared/magnets';
import { PythonTaskHost, TaskCancelledError } from '../../platform/python';
import { sourceCooldownSeconds } from '../../platform/network';

const stateSchema = z.object({
	version: z.literal(1),
	results: z.array(magnetResultSchema).max(50),
	nextRequestAt: z.number().nonnegative(),
	cooldownUntil: z.number().nonnegative(),
	policies: z.partialRecord(magnetSourceSchema, z.object({ nextRequestAt: z.number().nonnegative(), cooldownUntil: z.number().nonnegative() })).default({}),
});
type Stored = z.infer<typeof stateSchema>;
type CachePolicy = 'temporary' | 'saved';

export class MagnetService {
	private state: Stored = { version: 1, results: [], nextRequestAt: 0, cooldownUntil: 0, policies: {} };
	private loading: Promise<void> | undefined;
	private writes: Promise<void> = Promise.resolve();
	private active: { id: string; code: string; cache: CachePolicy; controller: AbortController; settings: MagnetSettings; completion?: Promise<MagnetResult> } | undefined;
	private cancelled = new Set<string>();
	private disposed = false;
	private directory: string;

	constructor(
		root: string,
		private host: Pick<PythonTaskHost, 'run'>,
		private resolveProxy: (url: string) => Promise<string>,
		private intervalMs = 2000,
		private settings: () => MagnetSettings = () => DEFAULT_MAGNET_SETTINGS,
		private sitePolicy?: { permit: (source: MagnetSource, signal: AbortSignal) => Promise<void>; cooldown: (source: MagnetSource, seconds: number) => void },
	) {
		this.directory = join(root, 'magnet-search');
	}

	async search(id: string, input: string, force = false, source: MagnetSource = this.settings().source, cache: CachePolicy = 'temporary'): Promise<MagnetResult> {
		const code = magnetCodeSchema.parse(input);
		magnetSourceSchema.parse(source);
		if (this.disposed || this.cancelled.has(id)) {
			return this.result(code, 'cancelled', '查询已取消', '', source);
		}
		const settings = structuredClone(this.settings());
		if (!settings.enabled) {
			return this.result(code, 'failed', '磁链搜索已关闭，可在设置中启用', 'disabled', source);
		}
		if (this.active) {
			return this.result(code, 'failed', '已有磁链查询正在进行，请稍后重试', 'busy', source);
		}
		const active = { id, code, cache, controller: new AbortController(), settings, completion: undefined as Promise<MagnetResult> | undefined };
		this.active = active;
		active.completion = this.execute(code, force, active.controller.signal, settings, source, cache).finally(() => {
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

	async row(code: string, id: string, source: MagnetSource = 'sukebei'): Promise<MagnetRow | undefined> {
		if (!this.settings().enabled) {
			return undefined;
		}
		await this.load();
		const current = this.state.results.find((result) => result.code === code && result.source === source && result.status === 'ready')?.items.find((item) => item.id === id);
		return current ?? (await this.readSaved(code, source))?.items.find((item) => item.id === id);
	}

	async forgetSaved(input: string): Promise<void> {
		const code = magnetCodeSchema.parse(input);
		if (this.active?.code === code && this.active.cache === 'saved') {
			this.active.controller.abort();
			await this.active.completion;
		}
		this.writes = this.writes
			.catch(() => {})
			.then(async () => {
				for (const source of magnetSourceSchema.options) {
					await rm(this.savedPath(code, source), { force: true });
				}
			});
		await this.writes;
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

	private async execute(code: string, force: boolean, signal: AbortSignal, settings: MagnetSettings, source: MagnetSource, cache: CachePolicy): Promise<MagnetResult> {
		const resultFor = (status: MagnetResult['status'], message: string, reason = ''): MagnetResult => this.result(code, status, message, reason, source);
		let loaded = false;
		let result = resultFor('running', `正在查询 ${MAGNET_SOURCES[source].name}`);
		try {
			await this.load();
			loaded = true;
			signal.throwIfAborted();
			if (!force && cache === 'saved') {
				const saved = await this.readSaved(code, source);
				signal.throwIfAborted();
				if (saved) {
					return this.present(saved, settings);
				}
			}
			const cached = this.state.results.find((item) => item.code === code && item.source === source);
			if (
				!force &&
				cached &&
				(['cancelled', 'interrupted', 'failed'].includes(cached.status) ||
					(cached.status === 'ready' &&
						(cache === 'saved' || (cached.limit >= settings.maxResults && Date.now() - Date.parse(cached.checkedAt) < (cached.items.length ? 24 : 1) * 60 * 60_000))))
			) {
				if (cache === 'saved' && cached.status === 'ready') {
					await this.saveSaved(cached, signal);
				}
				return this.present(cached, settings);
			}
			const policy = this.policy(source);
			if (policy.cooldownUntil > Date.now()) {
				return {
					...resultFor('failed', `${MAGNET_SOURCES[source].name} 正在冷却，请稍后重试`, 'cooldown'),
					retryAfter: Math.ceil((policy.cooldownUntil - Date.now()) / 1000),
				};
			}
			await this.save(result);
			const proxy = await this.route(signal, source);
			signal.throwIfAborted();
			let requests = 0;
			const payload = await this.host.run(
				'magnet.search',
				{ code, proxy, maxResults: settings.maxResults, transport: source === 'javtao' ? 'fingerprint' : settings.transport, ...(source === 'javtao' ? { source } : {}) },
				{
					signal,
					timeoutMs: 35_000,
					onRequest: async (request) => {
						signal.throwIfAborted();
						if (request.source !== source || request.host !== new URL(MAGNET_SOURCES[source].root).hostname || ++requests > (source === 'javtao' ? 4 : 3)) {
							throw new Error('MAGNET_REQUEST_LIMIT');
						}
						await this.sitePolicy?.permit(source, signal);
						const wait = policy.nextRequestAt - Date.now();
						if (wait > 0) {
							await delay(wait, undefined, { signal });
						}
						signal.throwIfAborted();
						policy.nextRequestAt = Date.now() + this.intervalMs;
						await this.save(result);
					},
				},
			);
			signal.throwIfAborted();
			result = magnetResultSchema.parse({ ...(payload as object), code, source, limit: settings.maxResults, checkedAt: new Date().toISOString() });
			result.items = result.items.slice(0, settings.maxResults);
			if (!['ready', 'failed'].includes(result.status)) {
				throw new Error('INVALID_MAGNET_RESULT');
			}
		} catch (error) {
			result =
				signal.aborted || error instanceof TaskCancelledError
					? resultFor('cancelled', '查询已取消，可手动重新查询')
					: error instanceof Error && error.message === 'MAGNET_SAVED_CACHE_INVALID'
						? resultFor('failed', '已保存的磁链结果无法读取，请手动刷新', 'storage')
						: error instanceof z.ZodError
							? resultFor('failed', '磁链返回格式与解析器不匹配', 'parse_error')
							: resultFor('failed', loaded ? '磁链查询未完成，请重试或检查网络设置' : '磁链查询记录无法读取，请检查本地存储', loaded ? 'network' : 'storage');
		}
		if (loaded) {
			if (result.status === 'failed') {
				const seconds = sourceCooldownSeconds(result.reason, result.retryAfter);
				this.policy(source).cooldownUntil = Date.now() + seconds * 1000;
				if (seconds) {
					this.sitePolicy?.cooldown(source, seconds);
				}
			}
			try {
				await this.save(result);
				if (cache === 'saved' && result.status === 'ready' && !signal.aborted) {
					await this.saveSaved(result, signal);
				}
			} catch {
				return signal.aborted ? resultFor('cancelled', '查询已取消，可手动重新查询') : resultFor('failed', '磁链查询结果未能保存，请检查本地存储', 'storage');
			}
			if (signal.aborted && result.status !== 'cancelled') {
				result = resultFor('cancelled', '查询已取消，可手动重新查询');
				await this.save(result);
			}
		}
		return this.present(result, settings);
	}

	private savedPath(code: string, source: MagnetSource): string {
		const hash = createHash('sha256').update(magnetCodeSchema.parse(code)).digest('hex');
		return join(this.directory, 'saved', `${magnetSourceSchema.parse(source)}-${hash}.json`);
	}

	private async readSaved(code: string, source: MagnetSource): Promise<MagnetResult | undefined> {
		try {
			const path = this.savedPath(code, source);
			if ((await stat(path)).size > 512 * 1024) {
				throw new Error('MAGNET_SAVED_CACHE_LIMIT');
			}
			const result = magnetResultSchema.parse(JSON.parse(await readFile(path, 'utf8')));
			if (result.code !== code || result.source !== source || result.status !== 'ready') {
				throw new Error('MAGNET_SAVED_CACHE_IDENTITY');
			}
			return result;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw new Error('MAGNET_SAVED_CACHE_INVALID');
			}
			return undefined;
		}
	}

	private saveSaved(result: MagnetResult, signal: AbortSignal): Promise<void> {
		// 收藏快照独立保存，不随最近 50 次查询淘汰，也不被失败或取消结果替换。
		const path = this.savedPath(result.code, result.source);
		const content = JSON.stringify(result);
		this.writes = this.writes
			.catch(() => {})
			.then(async () => {
				signal.throwIfAborted();
				await mkdir(join(this.directory, 'saved'), { recursive: true, mode: 0o700 });
				try {
					await writeFile(`${path}.tmp`, content, { mode: 0o600 });
					signal.throwIfAborted();
					await rename(`${path}.tmp`, path);
				} finally {
					await rm(`${path}.tmp`, { force: true });
				}
			});
		return this.writes;
	}

	private present(result: MagnetResult, settings: MagnetSettings): MagnetResult {
		const copy = structuredClone(result);
		copy.items = copy.items.slice(0, settings.maxResults);
		copy.limit = settings.maxResults;
		return copy;
	}

	private result(code: string, status: MagnetResult['status'], message: string, reason = '', source: MagnetSource = 'sukebei'): MagnetResult {
		return { code, source, status, items: [], limit: this.settings().maxResults, checkedAt: new Date().toISOString(), message, reason, requests: 0, retryAfter: 0 };
	}

	private policy(source: MagnetSource): { nextRequestAt: number; cooldownUntil: number } {
		// 旧版的顶层时间字段继续属于 Sukebei，已有缓存与冷却无需重建。
		return source === 'sukebei' ? this.state : (this.state.policies[source] ??= { nextRequestAt: 0, cooldownUntil: 0 });
	}

	private async route(signal: AbortSignal, source: MagnetSource): Promise<string> {
		signal.throwIfAborted();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort = (): void => {};
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new TaskCancelledError());
			signal.addEventListener('abort', abort, { once: true });
			timer = setTimeout(() => reject(new Error('PROXY_TIMEOUT')), 5000);
		});
		try {
			return await Promise.race([this.resolveProxy(MAGNET_SOURCES[source].root), cancelled]);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
		}
	}

	private save(result: MagnetResult): Promise<void> {
		this.state.results = [result, ...this.state.results.filter((item) => item.code !== result.code || item.source !== result.source)].slice(0, 50);
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

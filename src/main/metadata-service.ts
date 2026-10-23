import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
	metadataRecordSchema,
	metadataStateSchema,
	imageAssetSchema,
	imageProbeSchema,
	workerOutcomeSchema,
	SOURCE_LABELS,
	type MetadataState,
	type QueryTask,
	type QueryRequest,
	type QueryReply,
	type SourceId,
	type MetadataRecord,
	type ImageAsset,
	type CoverCandidate,
} from '../shared/metadata';
import { coverRank, DEFAULT_COVER_PRIORITY, preferredCover } from '../shared/cover-selection';
import { planQuery } from './metadata-input';
import { PythonTaskHost, TaskCancelledError, PythonWorkerError } from './python-host';
import type { Preferences } from '../shared/subscriptions';
import { METADATA_IDS, SOURCE_BY_ID, type AllSource } from '../shared/sources';
import { allowedSourceUrl } from '../shared/source-identity';
import { sourceCooldownSeconds, sourceTransport } from './source-policy';

const policySchema = z.object({ nextRequestAt: z.number().nonnegative(), cooldownUntil: z.number().nonnegative() });
const policiesSchema = z
	.record(z.string(), policySchema)
	.transform(
		(saved) => Object.fromEntries(METADATA_IDS.map((id) => [id, saved[id] ?? { nextRequestAt: 0, cooldownUntil: 0 }])) as Record<SourceId, z.infer<typeof policySchema>>,
	);
const storedSchema = metadataStateSchema.extend({
	version: z.literal(1),
	assets: z.record(z.string().regex(/^[a-f0-9]{64}$/), imageAssetSchema.extend({ cachedAt: z.number() })),
	policies: policiesSchema,
});
type Stored = z.infer<typeof storedSchema>;
type Runner = Pick<PythonTaskHost, 'run'>;
const empty = (): Stored => ({ version: 1, revision: 0, tasks: [], assets: {}, policies: policiesSchema.parse({}) });

export class MetadataService extends EventEmitter {
	private store = empty();
	private writes: Promise<void> = Promise.resolve();
	private controller: AbortController | undefined;
	private execution: Promise<void> | undefined;
	private disposed = false;
	private storageError = '';
	private readonly directory: string;
	private readonly cache: string;
	constructor(
		dataRoot: string,
		private host: Runner,
		private resolveProxy: (url: string) => Promise<string> = async () => '',
		private intervalMs = 2000,
		private preferences?: () => Preferences,
		private credential: (source: AllSource) => string = () => '',
		private gate?: (source: AllSource, signal: AbortSignal) => Promise<void>,
	) {
		super();
		this.directory = join(dataRoot, 'metadata');
		this.cache = join(dataRoot, 'cache', 'covers');
	}

	async initialize(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		await mkdir(this.cache, { recursive: true });
		await rm(join(this.cache, 'temporary'), { recursive: true, force: true });
		await mkdir(join(this.cache, 'temporary'), { recursive: true });
		try {
			const path = join(this.directory, 'state.json');
			if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('State too large');
			this.store = storedSchema.parse(JSON.parse(await readFile(path, 'utf8')));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				if (error instanceof SyntaxError || error instanceof z.ZodError || (error instanceof Error && error.message === 'State too large')) {
					await rename(join(this.directory, 'state.json'), join(this.directory, `state.invalid-${randomUUID()}.json`));
					this.storageError = '资料查询记录无法读取，原文件已保留；当前未执行任何恢复任务。';
				} else throw error;
			}
		}
		for (const task of this.store.tasks) {
			task.coverPriority ??= [...(this.preferences?.().coverPriority ?? DEFAULT_COVER_PRIORITY)];
			if (task.status === 'running' || task.status === 'cancelling') {
				task.status = task.cancelRequestedAt ? 'cancelled' : 'interrupted';
				task.phase = task.status === 'cancelled' ? '已取消；不会自动恢复' : '上次查询意外中断；可手动重新查询';
				task.finishedAt = new Date().toISOString();
			}
		}
		delete this.store.activeId;
		for (const [id, asset] of Object.entries(this.store.assets)) {
			try {
				if ((await stat(join(this.cache, `${asset.sha256}.image`))).size !== asset.bytes) delete this.store.assets[id];
			} catch {
				delete this.store.assets[id];
			}
		}
		const byHash = new Map(Object.values(this.store.assets).map((asset) => [asset.sha256, asset]));
		for (const task of this.store.tasks)
			for (const record of task.records)
				for (const cover of record.covers) {
					if (!cover.asset) continue;
					const indexed = byHash.get(cover.asset.sha256);
					if (indexed) {
						this.store.assets[cover.id] = indexed;
						cover.asset = indexed;
					} else {
						delete cover.asset;
						cover.error = '本地封面不可用，可重新查询';
					}
				}
		await this.retainCovers();
		// 仅清理本应用封面缓存目录中的孤立文件，不访问或扫描用户媒体目录。
		const indexed = new Set(Object.values(this.store.assets).map((asset) => asset.sha256));
		for (const file of await readdir(this.cache)) if (/^[a-f0-9]{64}\.image$/.test(file) && !indexed.has(file.slice(0, 64))) await rm(join(this.cache, file), { force: true });
		await this.commit();
	}

	getState(): MetadataState {
		return structuredClone({
			revision: this.store.revision,
			tasks: this.store.tasks,
			...(this.store.activeId ? { activeId: this.store.activeId } : {}),
			...(this.storageError ? { notice: this.storageError } : {}),
		});
	}

	private async commit(): Promise<void> {
		this.store.revision++;
		// 在排队前固定快照，再串行原子替换，避免较早的写入覆盖较新的取消或结果。
		const content = JSON.stringify(this.store);
		const write = this.writes
			.catch(() => {})
			.then(async () => {
				const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
				try {
					await writeFile(temporary, content, { mode: 0o600 });
					await rename(temporary, join(this.directory, 'state.json'));
				} finally {
					await rm(temporary, { force: true });
				}
			});
		this.writes = write;
		try {
			await write;
		} catch {
			this.storageError = '无法保存资料查询状态，网络任务已停止；请检查应用数据目录。';
			this.controller?.abort();
			throw new Error(this.storageError);
		} finally {
			this.emit('state', this.getState());
		}
	}

	async query(request: QueryRequest): Promise<QueryReply> {
		if (this.disposed || this.storageError) return { ok: false, message: this.storageError || '应用正在退出' };
		if (this.store.activeId) return { ok: false, message: '已有查询正在进行，请先取消或等待完成' };
		let plan;
		try {
			plan = planQuery(request);
		} catch (error) {
			return { ok: false, message: error instanceof z.ZodError || error instanceof TypeError ? '查询输入或链接格式不正确' : (error as Error).message };
		}
		if (this.preferences) {
			const preferences = this.preferences();
			plan.sources = preferences.metadataPriority.filter((source) => plan.sources.includes(source) && preferences.enabledSources.includes(source));
			if (!plan.sources.length) return { ok: false, message: '所选资料来源已在设置中关闭，请先启用' };
		}
		const key = JSON.stringify(plan);
		const coverPriority = [...(this.preferences?.().coverPriority ?? DEFAULT_COVER_PRIORITY)];
		const cached = this.store.tasks.find(
			(task) =>
				['succeeded', 'partial'].includes(task.status) &&
				task.records.length > 0 &&
				JSON.stringify(task.plan) === key &&
				JSON.stringify(task.coverPriority) === JSON.stringify(coverPriority) &&
				Date.now() - Date.parse(task.finishedAt ?? task.startedAt) < 3600_000,
		);
		if (cached && !request.force) return { ok: true, taskId: cached.id, cached: true };
		const task: QueryTask = {
			id: randomUUID(),
			status: 'running',
			phase: '准备查询资料',
			plan,
			coverPriority,
			startedAt: new Date().toISOString(),
			records: [],
			outcomes: [],
			requests: 0,
		};
		this.store.tasks.unshift(task);
		this.store.tasks = this.store.tasks.slice(0, 20);
		this.store.activeId = task.id;
		this.controller = new AbortController();
		try {
			await this.commit();
		} catch {
			delete this.store.activeId;
			return { ok: false, message: this.storageError };
		}
		const signal = this.controller.signal;
		this.execution = this.execute(task, signal).catch(() => {
			this.storageError ||= '资料任务意外停止，已停止后续请求；请重新打开应用。';
			this.controller?.abort();
			this.emit('state', this.getState());
		});
		return { ok: true, taskId: task.id, cached: false };
	}

	private running(task: QueryTask, signal: AbortSignal): boolean {
		return task.status === 'running' && !signal.aborted && !this.disposed;
	}
	private async permit(task: QueryTask, source: SourceId, signal: AbortSignal, request: { source: string; host: string }, ceiling = 24): Promise<void> {
		if (!this.running(task, signal) || request.source !== source || task.requests >= ceiling || (this.preferences && !this.preferences().enabledSources.includes(source)))
			throw new TaskCancelledError();
		const policy = this.store.policies[source];
		if (Date.now() < policy.cooldownUntil) throw new Error('Source is cooling down');
		const wait = Math.max(0, policy.nextRequestAt - Date.now());
		task.phase = `${SOURCE_LABELS[source]} · ${wait ? '等待站点请求间隔' : '查询资料'}（${task.requests + 1}/24）`;
		await this.commit();
		if (wait) await delay(wait, undefined, { signal });
		if (this.gate) await this.gate(source, signal);
		if (!this.running(task, signal) || (this.preferences && !this.preferences().enabledSources.includes(source))) throw new TaskCancelledError();
		policy.nextRequestAt = Date.now() + (source === 'javdb' ? Math.max(this.intervalMs, 3000) : this.intervalMs);
		task.requests++;
		await this.commit();
		if (!this.running(task, signal)) throw new TaskCancelledError();
	}

	private options(task: QueryTask, source: SourceId, signal: AbortSignal, ceiling = 24) {
		return {
			signal,
			timeoutMs: 60_000,
			onRequest: (request: { source: string; host: string; sequence: number }) => this.permit(task, source, signal, request, ceiling),
			onProgress: (payload: Record<string, unknown>) => {
				if (payload.event !== 'record' || !this.running(task, signal)) return;
				const record = metadataRecordSchema.parse(payload.record);
				if (record.source !== source || task.records.length >= 30 || task.records.some((item) => item.id === record.id)) return;
				for (const cover of record.covers) delete cover.asset;
				task.records.push(record);
				void this.commit().catch(() => {});
			},
		};
	}

	private async execute(task: QueryTask, signal: AbortSignal): Promise<void> {
		try {
			for (const source of task.plan.sources) {
				if (!this.running(task, signal)) break;
				if (task.requests >= 24) {
					task.outcomes.push({
						source,
						status: 'error',
						reason: 'budget_exceeded',
						message: '整次查询已达到 24 次请求预算，本来源未派发',
						requests: 0,
						retryAfter: 0,
						warnings: [],
					});
					continue;
				}
				const cooldown = this.store.policies[source].cooldownUntil - Date.now();
				if (cooldown > 0) {
					task.outcomes.push({
						source,
						status: 'error',
						reason: 'cooldown',
						message: '来源仍在冷却中，本次没有发送请求',
						requests: 0,
						retryAfter: Math.ceil(cooldown / 1000),
						warnings: [],
					});
					await this.commit();
					continue;
				}
				try {
					task.phase = `正在查询 ${SOURCE_LABELS[source]}`;
					await this.commit();
					const proxy = await this.resolveProxy(SOURCE_BY_ID[source].root);
					if (!this.running(task, signal)) break;
					const transport = sourceTransport(source, this.preferences?.());
					const outcome = workerOutcomeSchema.parse(
						await this.host.run('metadata.query', { ...task.plan, source, proxy, cookie: this.credential(source), transport }, this.options(task, source, signal)),
					);
					if (!this.running(task, signal)) break;
					task.outcomes.push({ ...outcome, source });
					this.hold(source, outcome.reason, outcome.retryAfter);
					await this.commit();
				} catch (error) {
					if (!this.running(task, signal)) break;
					task.outcomes.push({
						source,
						status: 'error',
						reason: error instanceof PythonWorkerError ? error.code : 'network',
						message: error instanceof PythonWorkerError ? error.message : '来源连接或网络代理未准备完成',
						requests: 0,
						retryAfter: 30,
						warnings: [],
					});
					this.hold(source, 'network', 30);
				}
			}
			if (this.running(task, signal)) await this.collectCovers(task, signal);
		} finally {
			await this.retainCovers().catch(() => {});
			if (task.status === 'cancelling' || task.cancelRequestedAt) {
				task.status = 'cancelled';
				task.phase = '已取消；不会自动恢复';
			} else if (task.status !== 'interrupted') {
				const issues =
					task.outcomes.some((outcome) => outcome.status === 'error' || outcome.status === 'partial') ||
					task.records.some((record) => record.warnings.length || record.covers.some((cover) => cover.error));
				task.status = task.records.length ? (issues ? 'partial' : 'succeeded') : 'failed';
				task.phase = task.records.length ? (issues ? '已取得部分资料，请查看来源状态' : '资料查询完成') : '来源未返回可采用资料，请查看来源状态';
			}
			task.finishedAt = new Date().toISOString();
			delete this.store.activeId;
			await this.commit().catch(() => {});
		}
	}

	private hold(source: SourceId, reason: string, retryAfter: number): void {
		const seconds = sourceCooldownSeconds(reason, retryAfter);
		if (seconds) this.store.policies[source].cooldownUntil = Date.now() + seconds * 1000;
	}

	private async collectCovers(task: QueryTask, signal: AbortSignal): Promise<void> {
		for (const code of new Set(task.records.map((record) => record.code))) {
			const priority = task.coverPriority ?? DEFAULT_COVER_PRIORITY;
			const seen = new Set<string>();
			const entries = task.records
				.filter((record) => record.code === code)
				.flatMap((record) => record.covers.map((candidate) => ({ record, candidate })))
				.sort((a, b) => coverRank(a.candidate, priority) - coverRank(b.candidate, priority) || Number(b.record.source === 'dmm') - Number(a.record.source === 'dmm'))
				.filter(({ candidate }) => !seen.has(candidate.url) && !!seen.add(candidate.url));
			for (const rank of new Set(entries.map(({ candidate }) => coverRank(candidate, priority)))) {
				const measured: { record: MetadataRecord; candidate: CoverCandidate; probe: z.infer<typeof imageProbeSchema> }[] = [];
				for (const { record, candidate } of entries.filter((entry) => coverRank(entry.candidate, priority) === rank)) {
					if (!this.running(task, signal)) return;
					try {
						const cached = this.store.assets[candidate.id];
						if (cached && (await stat(join(this.cache, `${cached.sha256}.image`)).catch(() => undefined))?.size === cached.bytes) {
							candidate.probe = imageProbeSchema.parse(cached);
							measured.push({ record, candidate, probe: cached });
							continue;
						}
						// 留出最后一次请求获取选中原图，尺寸探测不能耗尽整次预算。
						if (task.requests >= 23) {
							candidate.error = '查询预算不足，封面尺寸尚未取得';
							continue;
						}
						if (this.store.policies[record.source].cooldownUntil > Date.now()) {
							candidate.error = '来源正在冷却，封面尚未取得';
							continue;
						}
						task.phase = `${code} · 比较封面尺寸`;
						await this.commit();
						const proxy = await this.resolveProxy(candidate.url);
						if (!this.running(task, signal)) return;
						const transport = sourceTransport(record.source, this.preferences?.());
						const outcome = workerOutcomeSchema.parse(
							await this.host.run(
								'metadata.coverProbe',
								{ source: record.source, code, url: candidate.url, proxy, cookie: this.credential(record.source), transport },
								this.options(task, record.source, signal, 23),
							),
						);
						if (!this.running(task, signal)) return;
						if (outcome.status === 'error' || !outcome.probe) {
							candidate.error = outcome.message || '封面尺寸尚未取得';
							this.holdImageFailure(record.source, outcome.reason, outcome.retryAfter);
							continue;
						}
						candidate.probe = outcome.probe;
						measured.push({ record, candidate, probe: outcome.probe });
					} catch {
						if (this.running(task, signal)) candidate.error = '封面尺寸尚未取得';
					}
				}
				let selected = false;
				for (const { record, candidate, probe } of measured.sort((a, b) => b.probe.width * b.probe.height - a.probe.width * a.probe.height)) {
					if (!this.running(task, signal)) return;
					if (await this.cover(task, record, candidate, probe, signal)) {
						selected = true;
						break;
					}
				}
				if (selected) break;
			}
		}
	}

	private async cover(task: QueryTask, record: MetadataRecord, candidate: CoverCandidate, probe: z.infer<typeof imageProbeSchema>, signal: AbortSignal): Promise<boolean> {
		const cached = this.store.assets[candidate.id];
		if (cached) {
			try {
				const bytes = await readFile(join(this.cache, `${cached.sha256}.image`));
				if (!this.running(task, signal)) return false;
				if (bytes.length !== cached.bytes || createHash('sha256').update(bytes).digest('hex') !== cached.sha256) throw new Error('Invalid cached cover');
				candidate.asset = cached;
				delete candidate.error;
				await this.retainCovers();
				return true;
			} catch {
				delete this.store.assets[candidate.id];
			}
		}
		if (task.requests >= 24 || this.store.policies[record.source].cooldownUntil > Date.now()) {
			candidate.error = '封面获取暂未完成，可重新查询';
			return false;
		}
		const destination = join(this.cache, 'temporary', `${randomUUID()}.image`);
		let promoted: string | undefined;
		try {
			task.phase = `${record.code} · 获取来源封面`;
			await this.commit();
			const proxy = await this.resolveProxy(candidate.url);
			if (!this.running(task, signal)) return false;
			const transport = sourceTransport(record.source, this.preferences?.());
			const outcome = workerOutcomeSchema.parse(
				await this.host.run(
					'metadata.cover',
					{
						source: record.source,
						code: record.code,
						url: candidate.url,
						expectedWidth: probe.width,
						expectedHeight: probe.height,
						destination,
						proxy,
						cookie: this.credential(record.source),
						transport,
					},
					this.options(task, record.source, signal),
				),
			);
			if (!this.running(task, signal)) return false;
			if (outcome.status === 'error' || !outcome.asset) {
				candidate.error = outcome.message;
				this.holdImageFailure(record.source, outcome.reason, outcome.retryAfter);
				return false;
			}
			const image = await readFile(destination);
			if (!this.running(task, signal)) return false;
			if (
				image.length !== outcome.asset.bytes ||
				createHash('sha256').update(image).digest('hex') !== outcome.asset.sha256 ||
				outcome.asset.width !== probe.width ||
				outcome.asset.height !== probe.height
			)
				throw new Error('Cover integrity failure');
			promoted = outcome.asset.sha256;
			await rename(destination, join(this.cache, `${outcome.asset.sha256}.image`));
			if (!this.running(task, signal)) return false;
			candidate.asset = outcome.asset;
			delete candidate.error;
			this.store.assets[candidate.id] = { ...outcome.asset, cachedAt: Date.now() };
			await this.retainCovers();
			await this.trimCache(task);
			return true;
		} catch {
			if (this.running(task, signal)) candidate.error = '封面未取得，已有资料已保留';
			return false;
		} finally {
			await rm(destination, { force: true });
			if (promoted && !Object.values(this.store.assets).some((asset) => asset.sha256 === promoted)) await rm(join(this.cache, `${promoted}.image`), { force: true });
			if (this.running(task, signal)) await this.commit();
		}
	}

	private async retainCovers(): Promise<void> {
		const referenced = new Set<string>();
		for (const task of this.store.tasks)
			for (const code of new Set(task.records.map((record) => record.code))) {
				const covers = task.records.filter((record) => record.code === code).flatMap((record) => record.covers);
				const selected = preferredCover(
					covers.filter((cover) => cover.asset),
					task.coverPriority ?? DEFAULT_COVER_PRIORITY,
				);
				for (const cover of covers) {
					if (cover === selected) referenced.add(cover.id);
					else delete cover.asset;
				}
			}
		const removed = new Set<string>();
		for (const [id, asset] of Object.entries(this.store.assets))
			if (!referenced.has(id)) {
				removed.add(asset.sha256);
				delete this.store.assets[id];
			}
		await this.commit();
		const retained = new Set(Object.values(this.store.assets).map((asset) => asset.sha256));
		for (const hash of removed) if (!retained.has(hash)) await rm(join(this.cache, `${hash}.image`), { force: true });
	}

	private holdImageFailure(source: SourceId, reason: string, retryAfter: number): void {
		// A failed CDN connection does not prove its sibling image hosts are unavailable.
		if (['rate_limited', 'challenge', 'access_denied', 'auth_required', 'region_restricted'].includes(reason)) this.hold(source, reason, retryAfter);
	}

	private async trimCache(task: QueryTask): Promise<void> {
		const protectedIds = new Set(task.records.flatMap((record) => record.covers.map((cover) => cover.id)));
		const ordered = Object.entries(this.store.assets).sort((a, b) => a[1].cachedAt - b[1].cachedAt);
		const sizes = new Map(ordered.map(([, asset]) => [asset.sha256, asset.bytes]));
		let bytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
		for (const [id, asset] of ordered) {
			if (bytes <= 128 * 1024 * 1024) break;
			if (protectedIds.has(id)) continue;
			delete this.store.assets[id];
			if (!Object.values(this.store.assets).some((item) => item.sha256 === asset.sha256)) {
				bytes -= asset.bytes;
				await rm(join(this.cache, `${asset.sha256}.image`), { force: true });
			}
			for (const old of this.store.tasks)
				for (const record of old.records)
					for (const cover of record.covers)
						if (cover.id === id) {
							delete cover.asset;
							cover.error = '封面缓存已清理，可重新查询获取';
						}
		}
	}

	async cancel(id: string): Promise<void> {
		const task = this.store.tasks.find((task) => task.id === id);
		if (!task || task.id !== this.store.activeId || task.status !== 'running') return;
		task.status = 'cancelling';
		task.cancelRequestedAt = new Date().toISOString();
		task.phase = '正在取消，停止后续请求并清理进程';
		try {
			await this.commit();
		} finally {
			this.controller?.abort();
		}
		await this.execution;
	}

	async image(sha256: string): Promise<{ bytes: Buffer; asset: ImageAsset } | undefined> {
		if (!/^[a-f0-9]{64}$/.test(sha256)) return;
		const asset = Object.values(this.store.assets).find((asset) => asset.sha256 === sha256);
		if (!asset) return;
		try {
			const bytes = await readFile(join(this.cache, `${sha256}.image`));
			if (bytes.length === asset.bytes) return { bytes, asset };
		} catch {
			/* 已清理的缓存不暴露文件路径 */
		}
	}

	sourceUrl(taskId: string, recordId: string): string | undefined {
		const record = this.store.tasks.find((task) => task.id === taskId)?.records.find((record) => record.id === recordId);
		return record ? allowedSourceUrl(record.source, record.sourceUrl) : undefined;
	}

	async stop(): Promise<void> {
		this.disposed = true;
		const task = this.store.tasks.find((task) => task.id === this.store.activeId);
		if (task?.status === 'running') {
			task.status = 'interrupted';
			task.phase = '应用已退出，可手动重新查询';
		}
		this.controller?.abort();
		await this.execution;
		await this.writes.catch(() => {});
	}
}

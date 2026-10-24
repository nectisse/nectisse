import { mergePreferences } from '@shared/preferences';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rm, readFile, rename, chmod, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { SubscriptionStore } from './subscription-store';
import { PythonTaskHost, PythonWorkerError, TaskCancelledError } from '../../platform/python';
import {
	SOURCES,
	candidateSchema,
	entryInputSchema,
	followCommandSchema,
	type SubscriptionsState,
	type FollowCommand,
	type FollowTask,
	type FollowProvider,
	type CommandReply,
	type Subscription,
	type FollowCandidate,
	type FeedEntry,
} from '@shared/subscriptions';
import { imageAssetSchema, type ImageAsset } from '@shared/metadata';
import { ALL_IDS, SOURCE_BY_ID } from '@shared/sources';
import { allowedSourceUrl, canonicalFollow as canonical, validFollowEntry } from '@shared/source-identity';
import { readSubscriptionPart } from './subscription-read';
import { InitializationStep } from '../../platform/lifecycle';
import { subscriptionFailureContext } from '@shared/subscription-failure';
import { sourceCooldownSeconds, sourceTransport } from '../../platform/network';

const outcomeSchema = z.object({
	status: z.enum(['success', 'partial', 'error']),
	reason: z.string().max(100),
	message: z.string().max(500),
	requests: z.number().int().max(24),
	retryAfter: z.number().int().max(86400),
	candidates: z.array(candidateSchema).max(8).optional(),
	coverage: z.string().max(500).optional(),
	gap: z.boolean().optional(),
	warnings: z.array(z.string()).optional(),
	asset: imageAssetSchema.optional(),
	avatarUrl: z.string().max(2000).optional(),
});
export const PROVIDER_ROOTS = Object.fromEntries(SOURCES.filter((row) => row.follow).map((row) => [row.id, row.root])) as Record<FollowProvider, string>;

export class SubscriptionsService extends EventEmitter {
	private revision = Date.now();
	private active: { task: FollowTask; controller: AbortController; promise: Promise<void> } | undefined;
	private disposed = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private notice = '';
	private initialization: InitializationStep;
	private commands = 0;
	private cachePrepared = false;
	private secureStorageWarning = false;

	constructor(
		readonly store: SubscriptionStore,
		private host: Pick<PythonTaskHost, 'run'>,
		private resolveProxy: (url: string) => Promise<string>,
		private openExternal: (url: string) => Promise<void>,
		private intervalMs = 2000,
		private gate?: (source: FollowProvider, signal: AbortSignal) => Promise<void>,
	) {
		super();
		this.initialization = new InitializationStep(async () => {
			try {
				await this.prepareCache();
			} catch (error) {
				this.notice = '订阅封面缓存未准备完成，请检查应用数据目录';
				this.publish();
				throw error;
			}
			if (this.notice === '订阅封面缓存未准备完成，请检查应用数据目录') {
				this.notice = '';
			}
			this.publish();
		});
		void this.initialization.run().catch(() => {});
	}

	initialize(): Promise<void> {
		return this.initialization.retry();
	}

	getState(): SubscriptionsState {
		const state = {
			revision: this.revision,

			preferences: readSubscriptionPart('preferences', () => this.store.preferences()),

			subscriptions: readSubscriptionPart('subscriptions', () => this.store.subscriptions()),

			entries: readSubscriptionPart('entries', () => this.store.entries()),

			tasks: readSubscriptionPart('tasks', () => this.store.tasks()),

			sources: readSubscriptionPart('sources', () =>
				SOURCES.map((source) => ({ id: source.id, credentialPresent: this.store.credentialPresent(source.id), ...this.store.source(source.id) })),
			),

			encryptionAvailable: false,
			notice: this.notice,
		};
		// Encryption availability gates credential writes, not reading local records.
		try {
			state.encryptionAvailable = this.store.cipher.available();
			this.secureStorageWarning = false;
		} catch (error) {
			if (!this.secureStorageWarning) {
				this.secureStorageWarning = true;
				try {
					this.emit('secure-storage-error', subscriptionFailureContext(error, 'secure_storage'));
				} catch {
					/* A warning cannot prevent a local read. */
				}
			}
			state.notice ||= '系统安全存储暂未就绪，仍可查看本机资料；暂时无法保存 Cookie。';
		}
		return state;
	}

	refresh(): void {
		this.publish();
	}

	start(): void {
		if (this.timer || this.disposed) {
			return;
		}

		const tick = (): void => {
			void this.tick().catch(() => {
				this.notice = '自动检查或封面补齐未完成，请检查来源与缓存状态';
				this.publish();
			});
		};

		this.timer = setInterval(tick, 30_000);
		this.timer.unref();
		tick();
	}

	async tick(): Promise<void> {
		await this.initialization.run();
		if (this.disposed || this.active || this.commands) {
			return;
		}
		const preferences = this.store.preferences();
		const due =
			preferences.automatic &&
			this.store
				.subscriptions()
				.filter(
					(sub) =>
						sub.following &&
						sub.enabled &&
						!sub.autoPaused &&
						preferences.enabledSources.includes(sub.provider) &&
						Date.parse(sub.nextCheckAt || '9999-01-01') <= Date.now() &&
						this.store.source(sub.provider).cooldownUntil <= Date.now(),
				)
				.sort((a, b) => a.nextCheckAt.localeCompare(b.nextCheckAt))[0];
		if (due) {
			this.launch('check', due.provider, '', due);
		} else {
			this.launchImages();
		}
	}

	async command(input: FollowCommand): Promise<CommandReply> {
		this.commands++;
		try {
			await this.initialization.run();
			const command = followCommandSchema.parse(input);
			if (this.disposed) {
				throw new Error('应用正在退出');
			}
			// Background images yield their worker to an explicit user operation.
			if (['lookup', 'follow', 'check', 'credential', 'preferences', 'preferences-patch', 'source-enabled'].includes(command.action)) {
				await this.yieldImages();
			}
			if (command.action === 'query-sources') {
				this.store.savePreferences({ ...this.store.preferences(), querySources: command.sources });
			} else if (command.action === 'preferences' || command.action === 'preferences-patch' || command.action === 'source-enabled') {
				const previous = this.store.preferences();
				const patch =
					command.action === 'preferences'
						? command.value
						: command.action === 'preferences-patch'
							? command.patch
							: {
									enabledSources: command.enabled
										? [...new Set([...previous.enabledSources, command.source])]
										: previous.enabledSources.filter((id) => id !== command.source),
								};
				const next = command.action === 'preferences' ? mergePreferences(command.value, {}) : mergePreferences(previous, patch);
				this.store.savePreferences(next);
				if (previous.creatorMinutes !== next.creatorMinutes || previous.performerMinutes !== next.performerMinutes) {
					for (const sub of this.store.subscriptions()) {
						if (sub.lastCheckedAt && sub.intervalMinutes === null) {
							const minutes = sub.provider === 'javdb' ? next.performerMinutes : next.creatorMinutes;
							sub.nextCheckAt = new Date(Math.max(Date.parse(sub.lastCheckedAt) + minutes * 60_000, this.store.source(sub.provider).cooldownUntil)).toISOString();
							this.store.saveSubscription(sub);
						}
					}
				}
				if (
					previous.proxyMode !== next.proxyMode ||
					previous.proxyUrl !== next.proxyUrl ||
					previous.fanboxTransport !== next.fanboxTransport ||
					previous.javdbTransport !== next.javdbTransport ||
					JSON.stringify(previous.sourceTransports) !== JSON.stringify(next.sourceTransports)
				) {
					for (const provider of ALL_IDS) {
						this.store.saveSource(provider, { ...this.store.source(provider), cooldownUntil: 0, state: '连接设置已更改，尚未验证', message: '' });
					}
				}
				if (this.active && !next.enabledSources.includes(this.active.task.provider)) {
					await this.cancel(this.active.task.id);
				}
			} else if (command.action === 'credential') {
				if (!SOURCE_BY_ID[command.provider].credential) {
					throw new Error('此来源当前不接收 Cookie');
				}
				if (this.active?.task.provider === command.provider) {
					throw new Error('请先取消该来源正在执行的任务，再修改凭据');
				}
				this.store.saveCredential(command.provider, command.cookie.trim());
				this.store.saveSource(command.provider, {
					...this.store.source(command.provider),
					state: command.cookie ? '凭据已保存，尚未验证' : '凭据已清除',
					message: '',
					checkedAt: '',
					cooldownUntil: 0,
				});
			} else if (command.action === 'lookup') {
				return { ok: true, id: this.launch('lookup', command.provider, command.query) };
			} else if (command.action === 'follow') {
				if (this.active) {
					throw new Error('请先等待或取消当前查询');
				}

				const task = this.store.tasks().find((task) => task.id === command.taskId && ['succeeded', 'partial'].includes(task.status));
				const candidate = task?.candidates.find((item) => item.ref === command.ref);
				if (!candidate || candidate.url !== canonical(candidate.provider, candidate.ref)) {
					throw new Error('请先查询并确认有效候选');
				}
				const sub = this.store.follow(candidate);
				this.publish();
				try {
					this.launch('check', sub.provider, '', sub);
				} catch (error) {
					sub.lastError = (error as Error).message;
					this.store.saveSubscription(sub);
				}
				this.publish();
				return { ok: true, id: sub.id, message: '已关注；首次检查状态显示在订阅中' };
			} else if (command.action === 'update') {
				const sub = this.store.subscription(command.id);
				if (!sub) {
					throw new Error('该订阅不存在');
				}
				if (command.intervalMinutes != null && sub.provider === 'javdb' && command.intervalMinutes < 360) {
					throw new Error('演员新作检查间隔至少 360 分钟');
				}
				if (command.enabled !== undefined) {
					sub.enabled = command.enabled;
					sub.autoPaused = false;
				}
				if (command.following !== undefined) {
					sub.following = command.following;
					sub.enabled = command.following;
					sub.autoPaused = false;
				}
				if (command.intervalMinutes !== undefined) {
					sub.intervalMinutes = command.intervalMinutes;
					if (sub.lastCheckedAt) {
						const preferences = this.store.preferences();
						const minutes = sub.intervalMinutes ?? (sub.provider === 'javdb' ? preferences.performerMinutes : preferences.creatorMinutes);
						sub.nextCheckAt = new Date(Math.max(Date.parse(sub.lastCheckedAt) + minutes * 60_000, this.store.source(sub.provider).cooldownUntil)).toISOString();
					}
				}
				this.store.saveSubscription(sub);
				if ((!sub.enabled || !sub.following) && this.active?.task.subscriptionId === sub.id) {
					if (this.active.task.kind === 'covers') {
						await this.yieldImages('subscription_paused');
					} else {
						await this.cancel(this.active.task.id);
					}
				}
			} else if (command.action === 'check') {
				const sub = this.store.subscription(command.id);
				if (!sub?.following) {
					throw new Error('请先关注这个账号或演员');
				}
				if (!sub.enabled) {
					throw new Error('订阅已暂停，请先恢复');
				}
				return { ok: true, id: this.launch('check', sub.provider, '', sub) };
			} else if (command.action === 'cancel') {
				await this.cancel(command.id);
			} else if (command.action === 'retry-images') {
				for (const entry of this.store.entries()) {
					if (
						(!command.subscriptionId || entry.subscriptionId === command.subscriptionId) &&
						entry.thumbnailUrl &&
						!entry.imageAsset &&
						entry.imageCache?.status !== 'loading'
					) {
						this.store.setImageCache([entry.id], { status: 'queued', attempts: 0, nextAttemptAt: 0, reason: '' });
					}
				}
			} else if (command.action === 'read') {
				this.store.markRead(command.ids, command.read);
			} else if (command.action === 'open') {
				const entry = command.kind === 'entry' ? this.store.entry(command.id) : undefined;
				const sub = command.kind === 'subscription' ? this.store.subscription(command.id) : entry ? this.store.subscription(entry.subscriptionId) : undefined;
				const source = command.kind === 'source' ? SOURCES.find((row) => row.id === command.id) : undefined;
				const url =
					entry && sub && validFollowEntry(sub.provider, sub.ref, entry)
						? entry.url
						: !entry && sub && sub.url === canonical(sub.provider, sub.ref)
							? sub.url
							: source?.root;
				if (url) {
					await this.openExternal(url);
				}
			}
			this.publish();
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				message: error instanceof z.ZodError || error instanceof TypeError ? '输入或设置格式不正确' : error instanceof Error ? error.message : '操作未完成',
			};
		} finally {
			this.commands--;
			this.launchImages();
		}
	}

	async image(sha256: string): Promise<{ bytes: Buffer; asset: ImageAsset } | undefined> {
		if (!/^[a-f0-9]{64}$/.test(sha256)) {
			return;
		}

		const image = this.store.images().find((row) => row.asset.sha256 === sha256);

		if (!image) {
			return;
		}
		try {
			const bytes = await readFile(join(this.store.root, 'cache/subscription-covers', `${sha256}.image`));
			if (bytes.length === image.asset.bytes && createHash('sha256').update(bytes).digest('hex') === sha256) {
				return { bytes, asset: image.asset };
			}
		} catch {
			/* 缓存缺失保留内容正文。 */
		}
		if (!this.disposed) {
			for (const row of this.store.images()) {
				if (row.asset.sha256 === sha256) {
					this.store.dropImage(row.url);
				}
			}
			this.publish();
			this.launchImages();
		}
	}

	async cancel(id: string): Promise<void> {
		const active = this.active;
		if (!active || active.task.id !== id) {
			return;
		}
		active.task.status = 'cancelling';
		active.task.cancelRequestedAt = new Date().toISOString();
		active.task.phase = '正在停止请求与清理工作者';
		try {
			this.save(active.task);
			if (active.task.kind === 'covers') {
				for (const id of active.task.imageIds ?? []) {
					const entry = this.store.entry(id);
					if (entry && !entry.imageAsset) {
						this.store.setImageCache([id], { status: 'cancelled', attempts: entry.imageCache?.attempts ?? 0, nextAttemptAt: 0, reason: 'cancelled' });
					}
				}
			} else if (active.task.subscriptionId) {
				const sub = this.store.subscription(active.task.subscriptionId);
				if (sub) {
					sub.autoPaused = true;
					this.store.saveSubscription(sub);
				}
			}
		} finally {
			active.controller.abort();
		}
		await active.promise;
	}

	async stop(): Promise<void> {
		this.disposed = true;
		if (this.timer) {
			clearInterval(this.timer);
		}
		const active = this.active;
		if (active) {
			active.task.status = 'interrupted';
			if (active.task.kind !== 'covers' && active.task.subscriptionId) {
				const sub = this.store.subscription(active.task.subscriptionId);
				if (sub) {
					sub.autoPaused = true;
					this.store.saveSubscription(sub);
				}
			}
			active.controller.abort();
			await active.promise;
		}
		await this.initialization.close();
	}

	private async prepareCache(): Promise<void> {
		const cache = join(this.store.root, 'cache', 'subscription-covers');
		await mkdir(cache, { recursive: true, mode: 0o700 });
		const indexed = new Set(this.store.images().map((row) => `${row.asset.sha256}.image`));
		for (const file of await readdir(cache)) {
			if (/^\.temporary-[a-f0-9-]+$/.test(file) || (/^[a-f0-9]{64}\.image$/.test(file) && !indexed.has(file))) {
				await rm(join(cache, file), { force: true });
			}
		}
		for (const row of this.store.images()) {
			try {
				const bytes = await readFile(join(cache, `${row.asset.sha256}.image`));
				if (bytes.length !== row.asset.bytes || createHash('sha256').update(bytes).digest('hex') !== row.asset.sha256) {
					throw new Error('Image mismatch');
				}
			} catch {
				this.store.dropImage(row.url);
			}
		}
		for (const entry of this.store.entries()) {
			if (!entry.imageAsset && entry.imageCache?.status === 'loading') {
				this.store.setImageCache([entry.id], { ...entry.imageCache, status: 'queued', attempts: Math.max(0, entry.imageCache.attempts - 1) });
			}
		}
		this.cachePrepared = true;
	}

	private publish(): void {
		this.revision++;
		this.emit('state', this.getState());
	}

	private save(task: FollowTask): void {
		this.store.saveTask(task);
		this.publish();
	}

	private launch(kind: 'lookup' | 'check', provider: FollowProvider, query: string, sub?: Subscription): string {
		if (this.active) {
			throw new Error('已有订阅查询正在进行，请先取消或等待完成');
		}
		if (!this.store.preferences().enabledSources.includes(provider)) {
			throw new Error('该来源已关闭，请先在设置中启用');
		}
		const source = this.store.source(provider);
		if (source.cooldownUntil > Date.now()) {
			throw new Error(`来源冷却至 ${new Date(source.cooldownUntil).toLocaleTimeString('zh-CN')}，本次未发送请求`);
		}
		if (sub) {
			sub.autoPaused = false;
			this.store.saveSubscription(sub);
		}
		const task: FollowTask = {
			id: randomUUID(),
			kind,
			provider,
			...(sub ? { subscriptionId: sub.id } : {}),
			status: 'running',
			phase: kind === 'lookup' ? '查询来源身份' : '检查订阅更新',
			startedAt: new Date().toISOString(),
			finishedAt: '',
			requests: 0,
			candidates: [],
			added: 0,
			reason: '',
			cancelRequestedAt: '',
		};
		const controller = new AbortController();
		this.active = { task, controller, promise: Promise.resolve() };
		this.save(task);
		this.active.promise = this.execute(task, controller.signal, query, sub).catch(() => {
			this.notice = '订阅任务停止，请检查本地存储与来源状态';
			this.publish();
		});
		return task.id;
	}

	private running(task: FollowTask, signal: AbortSignal): boolean {
		return task.status === 'running' && !signal.aborted && !this.disposed;
	}

	private async permit(task: FollowTask, signal: AbortSignal, source: string): Promise<void> {
		if (
			!this.running(task, signal) ||
			source !== task.provider ||
			(task.kind !== 'covers' && task.requests >= 24) ||
			!this.store.preferences().enabledSources.includes(task.provider)
		) {
			throw new TaskCancelledError();
		}
		const policy = this.store.source(task.provider);
		if (policy.cooldownUntil > Date.now()) {
			throw new Error('来源冷却中');
		}
		const wait = this.gate ? 0 : Math.max(0, policy.nextRequestAt - Date.now());
		task.phase =
			task.kind === 'covers'
				? `${SOURCE_BY_ID[task.provider].name} · 封面 ${task.completed ?? 0}/${task.total} · ${wait ? '等待站点间隔' : '正在缓存'}`
				: `${SOURCE_BY_ID[task.provider].name} · ${wait ? '等待站点间隔' : '正在查询'}（${task.requests + 1}/24）`;
		this.save(task);
		if (wait) {
			await delay(wait, undefined, { signal });
		}
		if (this.gate) {
			await this.gate(task.provider, signal);
		}
		if (!this.running(task, signal) || !this.store.preferences().enabledSources.includes(task.provider)) {
			throw new TaskCancelledError();
		}
		this.store.saveSource(task.provider, {
			...this.store.source(task.provider),
			nextRequestAt: Date.now() + (this.gate && task.provider === 'javdb' ? 3000 : this.intervalMs),
		});
		task.requests++;
		this.save(task);
	}

	private async execute(task: FollowTask, signal: AbortSignal, query: string, sub?: Subscription): Promise<void> {
		let discoveredAt = '';
		try {
			const preferences = this.store.preferences();
			const proxy = await this.resolveProxy(PROVIDER_ROOTS[task.provider]);
			if (!this.running(task, signal)) {
				return;
			}
			const transport = sourceTransport(task.provider, preferences);
			const outcome = outcomeSchema.parse(
				await this.host.run(
					task.kind === 'lookup' ? 'follow.lookup' : 'follow.check',
					{
						provider: task.provider,
						query,
						ref: sub?.ref,
						name: sub?.name,
						initialized: sub?.initialized ?? false,
						seen: sub ? this.store.seen(sub.id) : [],
						proxy,
						cookie: this.store.credential(task.provider),
						transport,
					},
					{
						signal,
						timeoutMs: 60_000,

						onRequest: (request) => this.permit(task, signal, request.source),

						onProgress: (payload) => {
							if (payload.event !== 'entry' || !sub || !this.running(task, signal)) {
								return;
							}
							const entry = entryInputSchema.parse(payload.entry);
							if (!validFollowEntry(task.provider, sub.ref, entry)) {
								throw new Error('条目身份不属于当前来源');
							}
							discoveredAt ||= new Date().toISOString();
							if (this.store.upsertEntry(sub, entry, discoveredAt)) {
								task.added++;
							}
							this.save(task);
						},
					},
				),
			);
			if (!this.running(task, signal)) {
				return;
			}
			task.candidates = (outcome.candidates ?? []).filter(
				(candidate) => candidate.provider === task.provider && candidate.url === canonical(candidate.provider, candidate.ref),
			);
			const current = this.store.source(task.provider);
			const cooling = sourceCooldownSeconds(outcome.reason, outcome.retryAfter);
			this.store.saveSource(task.provider, {
				...current,
				checkedAt: new Date().toISOString(),
				state: outcome.status === 'success' ? '最近访问成功' : outcome.status === 'partial' ? '部分取得' : '需要处理',
				message: outcome.status === 'success' ? '' : outcome.message,
				cooldownUntil: cooling ? Date.now() + cooling * 1000 : current.cooldownUntil,
			});
			if (sub) {
				const latest = this.store.subscription(sub.id)!;
				if (outcome.avatarUrl) {
					if (latest.avatarUrl !== outcome.avatarUrl) {
						delete latest.avatarAsset;
					}
					latest.avatarUrl = outcome.avatarUrl;
				}
				latest.lastCheckedAt = new Date().toISOString();
				latest.coverage = outcome.coverage ?? latest.coverage;
				latest.lastError = outcome.status === 'error' ? outcome.message : outcome.gap ? outcome.coverage! : (outcome.warnings ?? []).join('；');
				latest.failureCount = outcome.status === 'error' ? latest.failureCount + 1 : 0;
				latest.initialized ||= outcome.status !== 'error';
				const interval = latest.intervalMinutes ?? (task.provider === 'javdb' ? preferences.performerMinutes : preferences.creatorMinutes);
				latest.nextCheckAt = new Date(
					Math.max(
						Date.now() + Math.min(interval * Math.min(2 ** Math.max(latest.failureCount - 1, 0), 8), 10080) * 60_000,
						this.store.source(task.provider).cooldownUntil,
					),
				).toISOString();
				this.store.saveSubscription(latest);
			}
			const imageIssue = !cooling ? await this.cacheAvatars(task, signal, sub ? [this.store.subscription(sub.id)!] : task.candidates, sub) : false;
			if (!this.running(task, signal)) {
				return;
			}
			if (imageIssue && sub) {
				const latest = this.store.subscription(sub.id)!;
				latest.lastError = [latest.lastError, '部分头像或封面未取得，已保留资料与正文'].filter(Boolean).join('；');
				this.store.saveSubscription(latest);
			}
			task.status = outcome.status === 'error' ? (task.added ? 'partial' : 'failed') : outcome.status === 'partial' || outcome.gap || imageIssue ? 'partial' : 'succeeded';
			task.phase = outcome.status === 'error' ? outcome.message : outcome.coverage || (task.candidates.length ? '已取得候选，请核对后关注' : '来源未找到候选');
			task.reason = outcome.reason;
		} catch (error) {
			if (this.running(task, signal)) {
				task.status = task.added ? 'partial' : 'failed';
				task.phase = error instanceof PythonWorkerError ? error.message : '来源连接、凭据或本地存储未准备完成';
				task.reason = error instanceof PythonWorkerError ? error.code : 'network';
				if (sub) {
					const latest = this.store.subscription(sub.id)!;
					latest.lastError = task.phase;
					latest.autoPaused = true;
					this.store.saveSubscription(latest);
				}
			}
		} finally {
			if (task.status === 'cancelling' || task.cancelRequestedAt) {
				task.status = 'cancelled';
				task.phase = '已取消，不会自动恢复';
			} else if (task.status === 'running') {
				task.status = 'interrupted';
				task.phase = '任务已中断，请手动检查';
			}
			task.finishedAt = new Date().toISOString();
			this.active = undefined;
			this.save(task);
			this.launchImages();
		}
	}

	private async cacheAvatars(task: FollowTask, signal: AbortSignal, profiles: FollowCandidate[], subscription?: Subscription): Promise<boolean> {
		const cache = join(this.store.root, 'cache', 'subscription-covers');
		let issue = false;
		for (const profile of profiles.slice(0, 8)) {
			if (!this.running(task, signal) || this.store.source(task.provider).cooldownUntil > Date.now()) {
				break;
			}
			if (!profile.avatarUrl || !allowedSourceUrl(task.provider, profile.avatarUrl, 'image')) {
				continue;
			}
			let asset = this.store.image(profile.avatarUrl);
			if (asset) {
				try {
					await stat(join(cache, `${asset.sha256}.image`));
				} catch {
					this.store.dropImage(profile.avatarUrl);
					asset = undefined;
				}
			}
			if (!this.running(task, signal)) {
				break;
			}
			if (!asset) {
				if (task.requests >= 24) {
					issue = true;
					break;
				}
				const destination = join(cache, `.temporary-${randomUUID()}`);
				try {
					task.phase = '缓存来源提供的头像';
					this.save(task);
					const proxy = await this.resolveProxy(profile.avatarUrl);
					if (!this.running(task, signal)) {
						break;
					}
					const transport = sourceTransport(task.provider, this.store.preferences());
					const result = outcomeSchema.parse(
						await this.host.run(
							'follow.image',
							{ provider: task.provider, url: profile.avatarUrl, destination, proxy, transport },
							{ signal, timeoutMs: 60_000, onRequest: (request) => this.permit(task, signal, request.source) },
						),
					);
					if (!this.running(task, signal)) {
						break;
					}
					if (!result.asset) {
						issue = true;
						const seconds = sourceCooldownSeconds(result.reason, result.retryAfter);
						if (seconds) {
							this.store.saveSource(task.provider, {
								...this.store.source(task.provider),
								state: '头像暂未取得',
								message: result.message,
								cooldownUntil: Date.now() + seconds * 1000,
							});
							break;
						}
						continue;
					}
					const bytes = await readFile(destination);
					if (!this.running(task, signal)) {
						break;
					}
					if (bytes.length !== result.asset.bytes || createHash('sha256').update(bytes).digest('hex') !== result.asset.sha256) {
						throw new Error('Avatar mismatch');
					}
					await chmod(destination, 0o600);
					await rename(destination, join(cache, `${result.asset.sha256}.image`));
					if (!this.running(task, signal)) {
						break;
					}
					asset = result.asset;
					this.store.cacheImage(profile.avatarUrl, asset);
				} catch {
					issue = true;
				} finally {
					await rm(destination, { force: true });
				}
			}
			if (asset && this.running(task, signal)) {
				profile.avatarAsset = asset;
				if (subscription) {
					const latest = this.store.subscription(subscription.id)!;
					latest.avatarUrl = profile.avatarUrl;
					latest.avatarAsset = asset;
					this.store.saveSubscription(latest);
				}
				this.save(task);
			}
		}
		await this.pruneImages();
		return issue;
	}

	/** Only the already collected, most recent 500 entries participate. No post/history requests. */
	private launchImages(): void {
		if (!this.cachePrepared || this.disposed || this.active || this.commands) {
			return;
		}
		const preferences = this.store.preferences();
		const subscriptions = new Map(this.store.subscriptions().map((sub) => [sub.id, sub]));
		const pending: FeedEntry[] = [];
		let changed = false;
		for (const entry of this.store.entries()) {
			if (!entry.thumbnailUrl || entry.imageAsset) {
				continue;
			}
			const sub = subscriptions.get(entry.subscriptionId);
			if (!sub?.following || !sub.enabled || sub.autoPaused || !preferences.enabledSources.includes(sub.provider)) {
				continue;
			}
			if (!validFollowEntry(sub.provider, sub.ref, entry) || !allowedSourceUrl(sub.provider, entry.thumbnailUrl, 'image')) {
				if (entry.imageCache?.reason !== 'unsupported') {
					this.store.setImageCache([entry.id], { status: 'failed', attempts: 0, nextAttemptAt: 0, reason: 'unsupported' });
					changed = true;
				}
				continue;
			}
			if (!entry.imageCache) {
				this.store.setImageCache([entry.id], { status: 'queued', attempts: 0, nextAttemptAt: 0, reason: '' });
				changed = true;
			}
			if (entry.imageCache && !['queued', 'retry'].includes(entry.imageCache.status)) {
				continue;
			}
			if ((entry.imageCache?.nextAttemptAt ?? 0) > Date.now() || this.store.source(sub.provider).cooldownUntil > Date.now()) {
				continue;
			}
			pending.push(entry);
		}
		if (!pending.length) {
			if (changed) {
				this.publish();
			}
			return;
		}
		const first = pending[0]!;
		const entries = pending.filter((entry) => entry.subscriptionId === first.subscriptionId);
		const task: FollowTask = {
			id: randomUUID(),
			kind: 'covers',
			provider: first.provider,
			subscriptionId: first.subscriptionId,

			imageIds: entries.map((entry) => entry.id),

			completed: 0,
			total: new Set(entries.map((entry) => entry.thumbnailUrl)).size,
			status: 'running',
			phase: `正在补齐封面 · 0/${new Set(entries.map((entry) => entry.thumbnailUrl)).size}`,
			startedAt: new Date().toISOString(),
			finishedAt: '',
			requests: 0,
			candidates: [],
			added: 0,
			reason: '',
			cancelRequestedAt: '',
		};
		const controller = new AbortController();
		this.active = { task, controller, promise: Promise.resolve() };
		this.save(task);
		this.active.promise = this.cacheImages(task, controller.signal).catch(() => {
			this.notice = '封面缓存写入失败，请检查应用数据目录';
			this.publish();
		});
	}

	private async yieldImages(reason = 'foreground'): Promise<void> {
		const active = this.active;
		if (active?.task.kind !== 'covers') {
			return;
		}
		// 前台操作只是让后台队列暂退；只有显式取消才持久化 cancelRequestedAt。
		active.task.status = 'interrupted';
		active.task.reason = reason;
		active.task.phase = reason === 'subscription_paused' ? '订阅已暂停，封面等待恢复' : '封面补齐让位于当前操作，稍后继续';
		this.save(active.task);
		active.controller.abort();
		await active.promise;
	}

	private imageFailure(ids: string[], attempts: number, reason: string, retryAfter = 0): void {
		const retryable = ['network', 'timeout', 'server_error', 'rate_limited', 'access_denied', 'auth_required', 'challenge', 'region_restricted', 'budget_exceeded'].includes(
			reason,
		);
		const retry = retryable && attempts < 3;
		this.store.setImageCache(ids, {
			status: retry ? 'retry' : 'failed',
			attempts,
			nextAttemptAt: retry ? Date.now() + Math.max(retryAfter, 30 * 2 ** (attempts - 1)) * 1000 : 0,
			reason,
		});
	}

	private imageWorkerReason(error: unknown): string {
		if (error instanceof PythonWorkerError) {
			return error.code === 'WORKER_TIMEOUT' ? 'timeout' : error.code === 'UNEXPECTED_EXIT' ? 'network' : error.code;
		}
		if (error instanceof z.ZodError || (error instanceof Error && error.message === 'Image mismatch')) {
			return 'parse_error';
		}
		return ['ENOENT', 'ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EROFS', 'ERR_SQLITE_ERROR'].includes(String((error as NodeJS.ErrnoException)?.code)) ? 'cache_write' : 'network';
	}

	private async cacheImages(task: FollowTask, signal: AbortSignal): Promise<void> {
		const cache = join(this.store.root, 'cache', 'subscription-covers');
		let issue = false;
		const groups = new Map<string, string[]>();
		for (const id of task.imageIds ?? []) {
			const entry = this.store.entry(id);
			if (entry) {
				groups.set(entry.thumbnailUrl, [...(groups.get(entry.thumbnailUrl) ?? []), id]);
			}
		}
		try {
			for (const [url, ids] of groups) {
				if (!this.running(task, signal) || this.store.source(task.provider).cooldownUntil > Date.now()) {
					issue = true;
					break;
				}
				const sub = this.store.subscription(task.subscriptionId!);
				if (!sub?.following || !sub.enabled || sub.autoPaused) {
					break;
				}

				const entry = ids
					.map((id) => this.store.entry(id))
					.find((item) => item?.thumbnailUrl === url && !item.imageAsset && ['queued', 'retry'].includes(item.imageCache?.status ?? 'queued'));

				if (!entry) {
					task.completed!++;
					continue;
				}
				let cached = this.store.image(url);
				if (cached) {
					try {
						const bytes = await readFile(join(cache, `${cached.sha256}.image`));
						if (bytes.length !== cached.bytes || createHash('sha256').update(bytes).digest('hex') !== cached.sha256) {
							throw new Error('Image mismatch');
						}
					} catch {
						this.store.dropImage(url);
						cached = undefined;
					}
				}
				if (!this.running(task, signal)) {
					break;
				}
				if (cached) {
					this.store.saveImage(entry, cached);
					task.completed!++;
					this.save(task);
					continue;
				}
				const attempts = (entry.imageCache?.attempts ?? 0) + 1;
				this.store.setImageCache(ids, { status: 'loading', attempts, nextAttemptAt: 0, reason: '' });
				const destination = join(cache, `.temporary-${randomUUID()}`);
				try {
					task.phase = `${sub.name} · 正在缓存封面 ${task.completed! + 1}/${task.total}`;
					this.save(task);
					const proxy = await this.resolveProxy(url);
					if (!this.running(task, signal)) {
						break;
					}
					const transport = sourceTransport(task.provider, this.store.preferences());
					const result = outcomeSchema.parse(
						await this.host.run(
							'follow.image',
							{ provider: task.provider, url, destination, proxy, transport },
							{ signal, timeoutMs: 60_000, onRequest: (request) => this.permit(task, signal, request.source) },
						),
					);
					if (!this.running(task, signal)) {
						break;
					}
					if (!result.asset) {
						issue = true;
						this.imageFailure(ids, attempts, result.reason || 'parse_error', result.retryAfter);
						const seconds = sourceCooldownSeconds(result.reason, result.retryAfter);
						if (seconds) {
							this.store.saveSource(task.provider, {
								...this.store.source(task.provider),
								state: '封面等待重试',
								message: result.message,
								cooldownUntil: Date.now() + seconds * 1000,
							});
						}
					} else {
						const bytes = await readFile(destination);
						if (!this.running(task, signal)) {
							break;
						}
						if (bytes.length !== result.asset.bytes || createHash('sha256').update(bytes).digest('hex') !== result.asset.sha256) {
							throw new Error('Image mismatch');
						}
						await chmod(destination, 0o600);
						await rename(destination, join(cache, `${result.asset.sha256}.image`));
						if (this.running(task, signal)) {
							this.store.saveImage(entry, result.asset);
							task.added++;
							const source = this.store.source(task.provider);
							if (source.state === '封面等待重试') {
								this.store.saveSource(task.provider, { ...source, checkedAt: new Date().toISOString(), state: '最近访问成功', message: '', cooldownUntil: 0 });
							}
							await this.pruneImages();
						}
					}
				} catch (error) {
					if (this.running(task, signal)) {
						issue = true;
						const reason = this.imageWorkerReason(error);
						this.imageFailure(ids, attempts, reason);
						if (['network', 'timeout'].includes(reason)) {
							this.store.saveSource(task.provider, { ...this.store.source(task.provider), cooldownUntil: Date.now() + 30_000 });
						}
						if (reason === 'cache_write') {
							throw error;
						}
					}
				} finally {
					await rm(destination, { force: true });
				}
				if (this.running(task, signal)) {
					task.completed!++;
					this.save(task);
				}
			}
			await this.pruneImages();
			issue ||= (task.imageIds ?? []).some((id) => {
				const entry = this.store.entry(id);
				return entry && !entry.imageAsset;
			});
			if (this.running(task, signal)) {
				task.status = issue ? 'partial' : 'succeeded';
				task.phase = `${issue ? '封面补齐暂未全部完成' : '封面已补齐'} · ${task.completed}/${task.total}`;
			}
		} catch {
			if (this.running(task, signal)) {
				for (const entry of this.store.entries()) {
					if (!entry.imageAsset && entry.thumbnailUrl && ['queued', 'loading'].includes(entry.imageCache?.status ?? 'queued')) {
						this.imageFailure([entry.id], entry.imageCache?.attempts ?? 0, 'cache_write');
					}
				}
				task.status = 'failed';
				task.phase = '封面缓存未写入，请检查数据目录';
				this.notice = task.phase;
			}
		} finally {
			// 未完成的下载退回队列且不消耗重试次数；用户取消的整批任务保留取消状态。
			for (const id of task.imageIds ?? []) {
				const entry = this.store.entry(id);
				if (!entry || entry.imageAsset || entry.imageCache?.status !== 'loading') {
					continue;
				}
				this.store.setImageCache([id], {
					status: task.cancelRequestedAt ? 'cancelled' : 'queued',
					attempts: Math.max(0, entry.imageCache.attempts - 1),
					nextAttemptAt: 0,
					reason: task.cancelRequestedAt ? 'cancelled' : '',
				});
			}
			if (task.cancelRequestedAt) {
				task.status = 'cancelled';
				task.phase = '封面补齐已取消，不会自动恢复';
			} else if (task.status === 'running') {
				task.status = 'interrupted';
				task.phase = '封面补齐已中断';
			}
			task.finishedAt = new Date().toISOString();
			this.active = undefined;
			this.save(task);
			this.launchImages();
		}
	}

	private async pruneImages(): Promise<void> {
		const cache = join(this.store.root, 'cache', 'subscription-covers');
		const images = this.store.images();
		const assets = new Map(images.map((row) => [row.asset.sha256, row.asset.bytes]));
		let bytes = [...assets.values()].reduce((sum, size) => sum + size, 0);
		const referenced = new Set([...this.store.entries().map((entry) => entry.thumbnailUrl), ...this.store.subscriptions().map((sub) => sub.avatarUrl)]);
		// Retain the visible list before older, unreferenced images. Evicted entries are
		// explicit terminal states, so an automatic backfill cannot refetch in a loop.
		images.sort((a, b) => Number(referenced.has(a.url)) - Number(referenced.has(b.url)));
		for (const row of images) {
			if (bytes <= 64 * 1024 * 1024) {
				break;
			}
			this.store.dropImage(row.url, true);
			if (!this.store.images().some((item) => item.asset.sha256 === row.asset.sha256)) {
				bytes -= row.asset.bytes;
				await rm(join(cache, `${row.asset.sha256}.image`), { force: true });
			}
		}
	}
}

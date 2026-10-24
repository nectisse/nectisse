import { isPerformerProvider } from '@shared/sources';
import { mergePreferences } from '@shared/preferences';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { PythonTaskHost } from '../../platform/python';
import { SOURCES, followCommandSchema, type SubscriptionsState, type FollowCommand, type FollowProvider, type CommandReply } from '@shared/subscriptions';
import type { ImageAsset } from '@shared/metadata';
import { ALL_IDS, SOURCE_BY_ID } from '@shared/sources';
import { canonicalFollow as canonical, validFollowEntry } from '@shared/source-identity';
import { subscriptionFailureContext } from '@shared/subscription-failure';
import { SubscriptionStore } from './subscription-store';
import { readSubscriptionPart } from './subscription-read';
import { ImageCache } from './image-cache';
import { ImageBackfill } from './image-backfill';
import { FollowRunner } from './follow-runner';
import { SubscriptionScheduler } from './subscription-scheduler';
import type { ImageStore } from '../../platform/images';
export { PROVIDER_ROOTS } from './follow-runner';

export class SubscriptionsService extends EventEmitter {
	private revision = Date.now();
	private secureStorageWarning = false;
	private images: ImageCache;
	private backfill: ImageBackfill;
	private scheduler: SubscriptionScheduler;

	constructor(
		readonly store: SubscriptionStore,
		host: Pick<PythonTaskHost, 'run'>,
		resolveProxy: (url: string) => Promise<string>,
		private openExternal: (url: string) => Promise<void>,
		intervalMs = 2000,
		gate?: (source: FollowProvider, signal: AbortSignal) => Promise<void>,
		sharedImages?: ImageStore,
	) {
		super();
		this.images = new ImageCache(store, host, resolveProxy, sharedImages);
		this.backfill = new ImageBackfill(store, this.images);
		const follow = new FollowRunner(store, host, resolveProxy, this.images);
		this.scheduler = new SubscriptionScheduler(store, this.images, this.backfill, follow, () => this.publish(), intervalMs, gate);
	}

	initialize(): Promise<void> {
		return this.scheduler.initialize();
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
			notice: this.scheduler.notice,
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

	async clearImageQueue(): Promise<void> {
		await this.scheduler.command(async () => {
			const cancelled = new Set(
				this.store
					.entries()
					.filter((entry) => entry.imageCache?.status === 'cancelled')
					.map((entry) => entry.id),
			);
			for (const task of this.store.tasks()) {
				if (task.kind === 'covers' && ['running', 'cancelling'].includes(task.status)) {
					await this.cancel(task.id);
				}
			}
			this.store.clearImageReferences(cancelled);
			this.publish();
		});
	}

	start(): void {
		this.scheduler.start();
	}

	tick(): Promise<void> {
		return this.scheduler.tick();
	}

	async command(input: FollowCommand): Promise<CommandReply> {
		try {
			return await this.scheduler.command<CommandReply>(async () => {
				const command = followCommandSchema.parse(input);
				// Background images yield their worker to an explicit user operation.
				if (['lookup', 'follow', 'check', 'credential', 'preferences', 'preferences-patch', 'source-enabled'].includes(command.action)) {
					await this.scheduler.yieldImages();
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
								const minutes = isPerformerProvider(sub.provider) ? next.performerMinutes : next.creatorMinutes;
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
					if (this.scheduler.activeTask && !next.enabledSources.includes(this.scheduler.activeTask.provider)) {
						await this.cancel(this.scheduler.activeTask.id);
					}
				} else if (command.action === 'credential') {
					if (!SOURCE_BY_ID[command.provider].credential) {
						throw new Error('此来源当前不接收 Cookie');
					}
					if (this.scheduler.activeTask?.provider === command.provider) {
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
					return { ok: true, id: this.scheduler.launch('lookup', command.provider, command.query) };
				} else if (command.action === 'follow') {
					if (this.scheduler.activeTask) {
						throw new Error('请先等待或取消当前查询');
					}

					const task = this.store.tasks().find((task) => task.id === command.taskId && ['succeeded', 'partial'].includes(task.status));
					const candidate = task?.candidates.find((item) => item.ref === command.ref);
					if (!candidate || candidate.url !== canonical(candidate.provider, candidate.ref, candidate.handle)) {
						throw new Error('请先查询并确认有效候选');
					}
					const sub = this.store.follow(candidate);
					this.publish();
					try {
						this.scheduler.launch('check', sub.provider, '', sub);
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
					if (command.intervalMinutes != null && isPerformerProvider(sub.provider) && command.intervalMinutes < 360) {
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
							const minutes = sub.intervalMinutes ?? (isPerformerProvider(sub.provider) ? preferences.performerMinutes : preferences.creatorMinutes);
							sub.nextCheckAt = new Date(Math.max(Date.parse(sub.lastCheckedAt) + minutes * 60_000, this.store.source(sub.provider).cooldownUntil)).toISOString();
						}
					}
					this.store.saveSubscription(sub);
					if ((!sub.enabled || !sub.following) && this.scheduler.activeTask?.subscriptionId === sub.id) {
						if (this.scheduler.activeTask.kind === 'covers') {
							await this.scheduler.yieldImages('subscription_paused');
						} else {
							await this.cancel(this.scheduler.activeTask.id);
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
					return { ok: true, id: this.scheduler.launch('check', sub.provider, '', sub) };
				} else if (command.action === 'cancel') {
					await this.cancel(command.id);
				} else if (command.action === 'retry-images') {
					this.backfill.retry(command.subscriptionId);
				} else if (command.action === 'read') {
					this.store.markRead(command.ids, command.read);
				} else if (command.action === 'open') {
					const entry = command.kind === 'entry' ? this.store.entry(command.id) : undefined;
					const sub = command.kind === 'subscription' ? this.store.subscription(command.id) : entry ? this.store.subscription(entry.subscriptionId) : undefined;
					const source = command.kind === 'source' ? SOURCES.find((row) => row.id === command.id) : undefined;
					const url =
						entry && sub && validFollowEntry(sub.provider, sub.ref, entry)
							? entry.url
							: !entry && sub && sub.url === canonical(sub.provider, sub.ref, sub.handle)
								? sub.url
								: source?.root;
					if (url) {
						await this.openExternal(url);
					}
				}
				this.publish();
				return { ok: true };
			});
		} catch (error) {
			return {
				ok: false,
				message: error instanceof z.ZodError || error instanceof TypeError ? '输入或设置格式不正确' : error instanceof Error ? error.message : '操作未完成',
			};
		}
	}

	async image(sha256: string): Promise<{ bytes: Buffer; asset: ImageAsset } | undefined> {
		const image = await this.images.read(sha256);
		if (!image && !this.scheduler.stopped && this.images.invalidate(sha256)) {
			this.publish();
			this.scheduler.wake();
		}
		return image;
	}

	cancel(id: string): Promise<void> {
		return this.scheduler.cancel(id);
	}

	stop(): Promise<void> {
		return this.scheduler.stop();
	}

	private publish(): void {
		this.revision++;
		this.emit('state', this.getState());
	}
}

import { isPerformerProvider } from '@shared/sources';
import { SOURCES, entryInputSchema, type FollowProvider, type FollowCandidate, type Subscription } from '@shared/subscriptions';
import { allowedSourceUrl, canonicalFollow as canonical, validFollowEntry } from '@shared/source-identity';
import { sourceCooldownSeconds, sourceTransport } from '../../platform/network';
import { PythonWorkerError, type PythonTaskHost } from '../../platform/python';
import { SubscriptionStore } from './subscription-store';
import { ImageCache } from './image-cache';
import { outcomeSchema, type TaskContext } from './task-context';

export const PROVIDER_ROOTS = Object.fromEntries(SOURCES.filter((row) => row.follow).map((row) => [row.id, row.apiRoot ?? row.root])) as Record<FollowProvider, string>;

export class FollowRunner {
	constructor(
		private store: SubscriptionStore,
		private host: Pick<PythonTaskHost, 'run'>,
		private resolveProxy: (url: string) => Promise<string>,
		private images: ImageCache,
	) {}

	async run(context: TaskContext, query: string, sub?: Subscription): Promise<void> {
		const { task, signal } = context;
		let discoveredAt = '';
		try {
			const preferences = this.store.preferences();
			const proxy = await this.resolveProxy(PROVIDER_ROOTS[task.provider]);
			if (!context.running()) {
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
						xSyncState: sub?.xSyncState,
						proxy,
						cookie: this.store.credential(task.provider),
						transport,
					},
					{
						signal,
						timeoutMs: 60_000,

						onRequest: (request) => context.permit(request.source),

						onProgress: (payload) => {
							if (payload.event !== 'entry' || !sub || !context.running()) {
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
							context.save();
						},
					},
				),
			);
			if (!context.running()) {
				return;
			}
			task.candidates = (outcome.candidates ?? []).filter(
				(candidate) => candidate.provider === task.provider && candidate.url === canonical(candidate.provider, candidate.ref, candidate.handle),
			);
			if (sub?.provider === 'x' && outcome.status !== 'error') {
				const profile = outcome.profile;
				if (!profile || profile.provider !== 'x' || profile.ref !== sub.ref || profile.url !== canonical('x', sub.ref, profile.handle)) {
					throw new Error('账号资料与订阅身份不一致');
				}
			}
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
				if (latest.provider === 'x' && outcome.profile && outcome.status !== 'error') {
					latest.name = outcome.profile.name;
					latest.handle = outcome.profile.handle;
					latest.url = outcome.profile.url;
					latest.bio = outcome.profile.bio;
				}
				const avatarUrl = latest.provider === 'x' ? (outcome.status === 'error' ? undefined : outcome.profile?.avatarUrl) : outcome.avatarUrl || undefined;
				if (avatarUrl !== undefined) {
					// 新头像下载成功后再替换，失败时保留已有图片。
					latest.avatarUrl = avatarUrl;
				}
				latest.lastCheckedAt = new Date().toISOString();
				latest.coverage = outcome.coverage ?? latest.coverage;
				latest.lastError = outcome.status === 'error' ? outcome.message : outcome.gap ? outcome.coverage! : (outcome.warnings ?? []).join('；');
				latest.failureCount = outcome.status === 'error' ? latest.failureCount + 1 : 0;
				latest.initialized ||= latest.provider === 'x' ? !!latest.xSyncState : outcome.status !== 'error';
				const interval = latest.intervalMinutes ?? (isPerformerProvider(task.provider) ? preferences.performerMinutes : preferences.creatorMinutes);
				latest.nextCheckAt = new Date(
					Math.max(
						Date.now() + Math.min(interval * Math.min(2 ** Math.max(latest.failureCount - 1, 0), 8), 10080) * 60_000,
						this.store.source(task.provider).cooldownUntil,
					),
				).toISOString();
				this.store.saveSubscription(latest);
			}
			const imageIssue = !cooling ? await this.cacheAvatars(context, sub ? [this.store.subscription(sub.id)!] : task.candidates, sub) : false;
			if (!context.running()) {
				return;
			}
			if (imageIssue && sub) {
				const latest = this.store.subscription(sub.id)!;
				latest.lastError = [latest.lastError, '部分头像或封面未取得，已保留资料与正文'].filter(Boolean).join('；');
				this.store.saveSubscription(latest);
			}
			if (sub?.provider === 'x') {
				const latest = this.store.subscription(sub.id)!;
				// 头像阶段也可能取消；整轮仍有效时才提交下一次检查的观察窗口。
				if (outcome.status === 'success' && outcome.xSyncState) {
					latest.xSyncState = outcome.xSyncState;
				}
				if (outcome.gap && latest.xSyncState && !latest.xSyncState.gapSince) {
					latest.xSyncState.gapSince = new Date().toISOString();
				}
				latest.initialized ||= !!latest.xSyncState;
				this.store.saveSubscription(latest);
			}
			task.status = outcome.status === 'error' ? (task.added ? 'partial' : 'failed') : outcome.status === 'partial' || outcome.gap || imageIssue ? 'partial' : 'succeeded';
			task.phase = outcome.status === 'error' ? outcome.message : outcome.coverage || (task.candidates.length ? '已取得候选，请核对后关注' : '来源未找到候选');
			task.reason = outcome.reason;
		} catch (error) {
			if (context.running()) {
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
		}
	}

	private async cacheAvatars(context: TaskContext, profiles: FollowCandidate[], subscription?: Subscription): Promise<boolean> {
		const { task } = context;
		let issue = false;
		for (const profile of profiles.slice(0, 8)) {
			if (!context.running() || this.store.source(task.provider).cooldownUntil > Date.now()) {
				break;
			}
			if (!profile.avatarUrl || !allowedSourceUrl(task.provider, profile.avatarUrl, 'image')) {
				continue;
			}
			let asset = await this.images.find(profile.avatarUrl, 'presence');
			if (!context.running()) {
				break;
			}
			if (!asset) {
				if (task.requests >= 24) {
					issue = true;
					break;
				}
				try {
					task.phase = '缓存来源提供的头像';
					context.save();
					const result = await this.images.fetch(profile.avatarUrl, context);
					if (!context.running()) {
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
					asset = result.asset;
					this.store.cacheImage(profile.avatarUrl, asset);
				} catch {
					issue = true;
				}
			}
			if (asset && context.running()) {
				profile.avatarAsset = asset;
				if (subscription) {
					const latest = this.store.subscription(subscription.id)!;
					latest.avatarUrl = profile.avatarUrl;
					latest.avatarAsset = asset;
					this.store.saveSubscription(latest);
				}
				context.save();
			}
		}
		await this.images.prune();
		return issue;
	}
}

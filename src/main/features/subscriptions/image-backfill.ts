import { z } from 'zod';
import { PythonWorkerError } from '../../platform/python';
import { sourceCooldownSeconds } from '../../platform/network';
import { allowedSourceUrl, validFollowEntry } from '@shared/source-identity';
import type { FeedEntry, FollowProvider } from '@shared/subscriptions';
import { SubscriptionStore } from './subscription-store';
import { ImageCache } from './image-cache';
import type { TaskContext } from './task-context';

export interface CoverBatch {
	provider: FollowProvider;
	subscriptionId: string;
	imageIds: string[];
	total: number;
}

export class ImageBackfill {
	constructor(
		private store: SubscriptionStore,
		private images: ImageCache,
	) {}

	recover(): void {
		for (const entry of this.store.entries()) {
			if (!entry.imageAsset && entry.imageCache?.status === 'loading') {
				this.store.setImageCache([entry.id], { ...entry.imageCache, status: 'queued', attempts: Math.max(0, entry.imageCache.attempts - 1) });
			}
		}
	}

	retry(subscriptionId?: string): void {
		for (const entry of this.store.entries()) {
			if ((!subscriptionId || entry.subscriptionId === subscriptionId) && entry.thumbnailUrl && !entry.imageAsset && entry.imageCache?.status !== 'loading') {
				this.store.setImageCache([entry.id], { status: 'queued', attempts: 0, nextAttemptAt: 0, reason: '' });
			}
		}
	}

	/** Only the already collected, most recent 500 entries participate. */
	plan(): { batch?: CoverBatch; changed: boolean } {
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
		const first = pending[0];
		if (!first) {
			return { changed };
		}
		const entries = pending.filter((entry) => entry.subscriptionId === first.subscriptionId);
		return {
			changed,
			batch: {
				provider: first.provider,
				subscriptionId: first.subscriptionId,
				imageIds: entries.map((entry) => entry.id),
				total: new Set(entries.map((entry) => entry.thumbnailUrl)).size,
			},
		};
	}

	async run(context: TaskContext): Promise<void> {
		const { task } = context;
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
				if (!context.running() || this.store.source(task.provider).cooldownUntil > Date.now()) {
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
				const cached = await this.images.find(url);
				if (!context.running()) {
					break;
				}
				if (cached) {
					this.store.saveImage(entry, cached);
					task.completed!++;
					context.save();
					continue;
				}
				const attempts = (entry.imageCache?.attempts ?? 0) + 1;
				this.store.setImageCache(ids, { status: 'loading', attempts, nextAttemptAt: 0, reason: '' });
				try {
					task.phase = `${sub.name} · 正在缓存封面 ${task.completed! + 1}/${task.total}`;
					context.save();
					const result = await this.images.fetch(url, context);
					if (!context.running()) {
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
						if (context.running()) {
							this.store.saveImage(entry, result.asset);
							task.added++;
							const source = this.store.source(task.provider);
							if (source.state === '封面等待重试') {
								this.store.saveSource(task.provider, { ...source, checkedAt: new Date().toISOString(), state: '最近访问成功', message: '', cooldownUntil: 0 });
							}
							await this.images.prune();
						}
					}
				} catch (error) {
					if (context.running()) {
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
				}
				if (context.running()) {
					task.completed!++;
					context.save();
				}
			}
			await this.images.prune();
			issue ||= (task.imageIds ?? []).some((id) => {
				const entry = this.store.entry(id);
				return entry && !entry.imageAsset;
			});
			if (context.running()) {
				task.status = issue ? 'partial' : 'succeeded';
				task.phase = `${issue ? '封面补齐暂未全部完成' : '封面已补齐'} · ${task.completed}/${task.total}`;
			}
		} catch {
			if (context.running()) {
				for (const entry of this.store.entries()) {
					if (!entry.imageAsset && entry.thumbnailUrl && ['queued', 'loading'].includes(entry.imageCache?.status ?? 'queued')) {
						this.imageFailure([entry.id], entry.imageCache?.attempts ?? 0, 'cache_write');
					}
				}
				task.status = 'failed';
				task.phase = '封面缓存未写入，请检查数据目录';
				context.notice(task.phase);
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
		}
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
}

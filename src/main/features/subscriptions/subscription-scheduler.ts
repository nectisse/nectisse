import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SOURCE_BY_ID } from '@shared/sources';
import type { FollowTask, FollowProvider, Subscription } from '@shared/subscriptions';
import { TaskCancelledError } from '../../platform/python';
import { InitializationStep } from '../../platform/lifecycle';
import { SubscriptionStore } from './subscription-store';
import { ImageCache } from './image-cache';
import { ImageBackfill } from './image-backfill';
import { FollowRunner } from './follow-runner';
import type { TaskContext } from './task-context';

interface ActiveTask {
	task: FollowTask;
	controller: AbortController;
	promise: Promise<void>;
}

export class SubscriptionScheduler {
	private active: ActiveTask | undefined;
	private disposed = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private currentNotice = '';
	private initialization: InitializationStep;
	private commands = 0;
	private cachePrepared = false;

	constructor(
		private store: SubscriptionStore,
		private images: ImageCache,
		private backfill: ImageBackfill,
		private follow: FollowRunner,
		private changed: () => void,
		private intervalMs: number,
		private gate?: (source: FollowProvider, signal: AbortSignal) => Promise<void>,
	) {
		this.initialization = new InitializationStep(async () => {
			try {
				await this.images.prepare();
				this.backfill.recover();
				this.cachePrepared = true;
			} catch (error) {
				this.currentNotice = '订阅封面缓存未准备完成，请检查应用数据目录';
				this.changed();
				throw error;
			}
			if (this.currentNotice === '订阅封面缓存未准备完成，请检查应用数据目录') {
				this.currentNotice = '';
			}
			this.changed();
		});
		void this.initialization.run().catch(() => {});
	}

	get activeTask(): Readonly<FollowTask> | undefined {
		return this.active?.task;
	}

	get stopped(): boolean {
		return this.disposed;
	}

	get notice(): string {
		return this.currentNotice;
	}

	initialize(): Promise<void> {
		return this.initialization.retry();
	}

	async command<T>(operation: () => Promise<T>): Promise<T> {
		this.commands++;
		try {
			await this.initialization.run();
			if (this.disposed) {
				throw new Error('应用正在退出');
			}
			return await operation();
		} finally {
			this.commands--;
			this.wake();
		}
	}

	start(): void {
		if (this.timer || this.disposed) {
			return;
		}

		const tick = (): void => {
			void this.tick().catch(() => {
				this.currentNotice = '自动检查或封面补齐未完成，请检查来源与缓存状态';
				this.changed();
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
			this.wake();
		}
	}

	launch(kind: 'lookup' | 'check', provider: FollowProvider, query: string, sub?: Subscription): string {
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
		this.active.promise = this.execute(this.active, (context) => this.follow.run(context, query, sub)).catch(() => {
			this.currentNotice = '订阅任务停止，请检查本地存储与来源状态';
			this.changed();
		});
		return task.id;
	}

	async yieldImages(reason = 'foreground'): Promise<void> {
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

	wake(): void {
		if (!this.cachePrepared || this.disposed || this.active || this.commands) {
			return;
		}
		const { batch, changed } = this.backfill.plan();
		if (!batch) {
			if (changed) {
				this.changed();
			}
			return;
		}
		const task: FollowTask = {
			id: randomUUID(),
			kind: 'covers',
			provider: batch.provider,
			subscriptionId: batch.subscriptionId,

			imageIds: batch.imageIds,

			completed: 0,
			total: batch.total,
			status: 'running',
			phase: `正在补齐封面 · 0/${batch.total}`,
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
		this.active.promise = this.execute(this.active, (context) => this.backfill.run(context)).catch(() => {
			this.currentNotice = '封面缓存写入失败，请检查应用数据目录';
			this.changed();
		});
	}

	private context(task: FollowTask, signal: AbortSignal): TaskContext {
		return {
			task,
			signal,
			running: () => this.running(task, signal),
			save: () => this.save(task),
			permit: (source) => this.permit(task, signal, source),
			notice: (message) => {
				this.currentNotice = message;
			},
		};
	}

	private save(task: FollowTask): void {
		this.store.saveTask(task);
		this.changed();
	}

	private running(task: FollowTask, signal: AbortSignal): boolean {
		return this.active?.task === task && task.status === 'running' && !signal.aborted && !this.disposed;
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

	private async execute(active: ActiveTask, run: (context: TaskContext) => Promise<void>): Promise<void> {
		const { task, controller } = active;
		try {
			await run(this.context(task, controller.signal));
		} finally {
			if (task.status === 'cancelling' || task.cancelRequestedAt) {
				task.status = 'cancelled';
				task.phase = task.kind === 'covers' ? '封面补齐已取消，不会自动恢复' : '已取消，不会自动恢复';
			} else if (task.status === 'running') {
				task.status = 'interrupted';
				task.phase = task.kind === 'covers' ? '封面补齐已中断' : '任务已中断，请手动检查';
			}
			task.finishedAt = new Date().toISOString();
			if (this.active === active) {
				this.active = undefined;
				this.save(task);
				this.wake();
			}
		}
	}
}

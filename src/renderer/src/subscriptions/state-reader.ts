import type { SubscriptionsBridge, SubscriptionsState } from '../../../shared/subscriptions';
import { SUBSCRIPTION_READ, subscriptionReadCode, subscriptionReadMessage, type SubscriptionReadCode } from '../../../shared/subscription-read';

type ReadBridge = Pick<SubscriptionsBridge, 'getState' | 'onState'> & Partial<Pick<SubscriptionsBridge, 'retry'>>;
interface Callbacks {
	state: (state: SubscriptionsState) => void;
	error: (message: string) => void;
	reading: (value: boolean) => void;
	failure?: (code: SubscriptionReadCode) => void;
}
/** One bounded read cycle; a newer pushed state supersedes all older responses. */
export class SubscriptionStateReader {
	private epoch = 0;
	private revision = -1;
	private disposed = false;
	private controller?: AbortController;
	private unsubscribe: () => void;
	constructor(
		private bridge: ReadBridge,
		private callbacks: Callbacks,
		private options = { delays: [250, 1000], timeoutMs: 4000 },
	) {
		this.unsubscribe = bridge.onState((value) => {
			if (this.disposed || value.revision < this.revision) return;
			this.epoch++;
			this.controller?.abort();
			this.apply(value);
			this.callbacks.reading(false);
		});
	}
	private apply(value: SubscriptionsState): void {
		if (value.revision < this.revision) return;
		this.revision = value.revision;
		this.callbacks.state(value);
		this.callbacks.error('');
	}
	private request(signal: AbortSignal, recover: boolean): Promise<SubscriptionsState> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => finish(undefined, new Error(SUBSCRIPTION_READ.timeout)), this.options.timeoutMs);
			const abort = (): void => finish(undefined, new Error('READ_SUPERSEDED'));
			let settled = false;
			const finish = (value?: SubscriptionsState, error?: unknown): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener('abort', abort);
				if (error) reject(error);
				else resolve(value!);
			};
			signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted) abort();
			else
				void Promise.resolve()
					.then(() => {
						if (signal.aborted) throw new Error('READ_SUPERSEDED');
						return recover && this.bridge.retry ? this.bridge.retry() : this.bridge.getState();
					})
					.then(
						(value) => finish(value),
						(error) => finish(undefined, error),
					);
		});
	}
	private wait(ms: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			const done = (): void => {
				clearTimeout(timer);
				signal.removeEventListener('abort', done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			signal.addEventListener('abort', done, { once: true });
			if (signal.aborted) done();
		});
	}
	async refresh(recover = false): Promise<void> {
		if (this.disposed) return;
		const epoch = ++this.epoch;
		this.controller?.abort();
		const controller = new AbortController();
		this.controller = controller;
		const current = (): boolean => !this.disposed && this.epoch === epoch && !controller.signal.aborted;
		this.callbacks.error('');
		this.callbacks.reading(true);
		try {
			for (let attempt = 0; attempt <= this.options.delays.length && current(); attempt++) {
				try {
					const value = await this.request(controller.signal, recover && attempt === 0);
					if (current()) this.apply(value);
					return;
				} catch (error) {
					if (!current()) return;
					try {
						this.callbacks.failure?.(subscriptionReadCode(error));
					} catch {
						/* Diagnostics must not interrupt recovery. */
					}
					if (attempt === this.options.delays.length) {
						this.callbacks.error(subscriptionReadMessage(error));
						return;
					}
					await this.wait(this.options.delays[attempt]!, controller.signal);
				}
			}
		} finally {
			if (current()) this.callbacks.reading(false);
		}
	}
	dispose(): void {
		this.disposed = true;
		this.epoch++;
		this.controller?.abort();
		this.unsubscribe();
	}
}

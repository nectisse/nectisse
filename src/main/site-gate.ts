import { setTimeout as delay } from 'node:timers/promises';
import { SOURCE_BY_ID, SOURCES, type AllSource } from '@shared/sources';
import type { SubscriptionStore } from './subscription-store';

/** 资料和订阅共用同一站点闸门；同主机的三份 Wiki 共用间隔与冷却。 */
export class SiteGate {
	private pending = new Map<string, Promise<void>>();

	constructor(private store: SubscriptionStore) {}

	async permit(source: AllSource, signal: AbortSignal): Promise<void> {
		const domain = SOURCE_BY_ID[source].domains[0]!;
		const peers = SOURCES.filter((row) => row.domains[0] === domain).map((row) => row.id);
		const previous = this.pending.get(domain) ?? Promise.resolve();
		const turn = previous
			.catch(() => {})
			.then(async () => {
				signal.throwIfAborted();

				const policies = peers.map((id) => this.store.source(id));

				if (policies.some((policy) => policy.cooldownUntil > Date.now())) {
					throw new Error('来源仍在冷却中');
				}
				const wait = Math.max(0, ...policies.map((policy) => policy.nextRequestAt - Date.now()));
				if (wait) {
					await delay(wait, undefined, { signal });
				}
				signal.throwIfAborted();
				// 等待间隔时，另一条查询可能刚收到限流；放行前必须重新读取冷却状态。
				if (peers.some((id) => this.store.source(id).cooldownUntil > Date.now())) {
					throw new Error('来源仍在冷却中');
				}
				const nextRequestAt = Date.now() + (source === 'javdb' ? 3000 : 2000);
				for (const id of peers) {
					this.store.saveSource(id, { ...this.store.source(id), nextRequestAt });
				}
			});

		this.pending.set(domain, turn);
		try {
			await turn;
		} finally {
			if (this.pending.get(domain) === turn) {
				this.pending.delete(domain);
			}
		}
	}
}

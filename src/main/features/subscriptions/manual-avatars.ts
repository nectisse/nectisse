import type { ImageBytes, ImageStore } from '../../platform/images';
import type { SubscriptionStore } from './subscription-store';

const ownerFor = (id: string, hash: string): string => `manual-avatar:${id}:${hash}`;

/** 手动头像独立保存；站点刷新继续维护原头像，以便随时恢复。 */
export class ManualAvatars {
	private pending: Promise<unknown> = Promise.resolve();

	constructor(
		private store: SubscriptionStore,
		private images?: ImageStore,
	) {}

	prepare(): Promise<void> {
		return this.enqueue(async () => {
			const owners = new Set(this.store.subscriptions().flatMap((sub) => (sub.manualAvatarAsset ? [ownerFor(sub.id, sub.manualAvatarAsset.sha256)] : [])));
			await this.images?.retainPins('manual-avatar:', owners);
		});
	}

	replace(id: string, image: ImageBytes): Promise<void> {
		return this.enqueue(async () => {
			this.requireSubscription(id);
			if (!this.images) {
				throw new Error('本机图片存储尚未就绪，请重新检查');
			}
			const owner = ownerFor(id, image.asset.sha256);
			const saved = await this.images.put(owner, image, { owner });
			// 下载站点头像或更新状态可能在写图期间完成，始终合并最新订阅。
			const sub = this.requireSubscription(id);
			const previous = sub.manualAvatarAsset;
			sub.manualAvatarAsset = saved.original!;
			try {
				this.store.saveSubscription(sub);
			} catch (error) {
				if (previous?.sha256 !== image.asset.sha256) {
					await this.images.unprotect(owner).catch(() => {});
				}
				throw error;
			}
			// 先固定新图并保存记录，再释放旧图；异常中断也不会丢失当前头像。
			await this.images.retainPins(`manual-avatar:${id}:`, new Set([owner])).catch(() => {});
		});
	}

	restore(id: string): Promise<void> {
		return this.enqueue(async () => {
			const sub = this.requireSubscription(id);
			delete sub.manualAvatarAsset;
			this.store.saveSubscription(sub);
			await this.images?.retainPins(`manual-avatar:${id}:`, new Set()).catch(() => {});
		});
	}

	async drain(): Promise<void> {
		await this.pending;
	}

	private requireSubscription(id: string) {
		const sub = this.store.subscription(id);
		if (!sub) {
			throw new Error('该订阅不存在');
		}
		return sub;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.pending.catch(() => {}).then(operation);
		this.pending = task.catch(() => {});
		return task;
	}
}

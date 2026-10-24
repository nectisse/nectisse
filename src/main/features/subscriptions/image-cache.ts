import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rm, readFile, rename, chmod, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageAsset } from '@shared/metadata';
import { sourceTransport } from '../../platform/network';
import { TaskCancelledError, type PythonTaskHost } from '../../platform/python';
import { SubscriptionStore } from './subscription-store';
import { outcomeSchema, type TaskContext } from './task-context';

export class ImageCache {
	private directory: string;

	constructor(
		private store: SubscriptionStore,
		private host: Pick<PythonTaskHost, 'run'>,
		private resolveProxy: (url: string) => Promise<string>,
	) {
		this.directory = join(store.root, 'cache', 'subscription-covers');
	}

	async prepare(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const indexed = new Set(this.store.images().map((row) => `${row.asset.sha256}.image`));
		for (const file of await readdir(this.directory)) {
			if (/^\.temporary-[a-f0-9-]+$/.test(file) || (/^[a-f0-9]{64}\.image$/.test(file) && !indexed.has(file))) {
				await rm(join(this.directory, file), { force: true });
			}
		}
		for (const row of this.store.images()) {
			await this.find(row.url);
		}
	}

	async read(sha256: string): Promise<{ bytes: Buffer; asset: ImageAsset } | undefined> {
		if (!/^[a-f0-9]{64}$/.test(sha256)) {
			return;
		}
		const image = this.store.images().find((row) => row.asset.sha256 === sha256);
		if (image) {
			try {
				return { bytes: await this.verifiedBytes(image.asset), asset: image.asset };
			} catch {
				/* The caller decides whether invalidation is still allowed during shutdown. */
			}
		}
	}

	invalidate(sha256: string): boolean {
		if (!/^[a-f0-9]{64}$/.test(sha256)) {
			return false;
		}
		let changed = false;
		for (const row of this.store.images()) {
			if (row.asset.sha256 === sha256) {
				this.store.dropImage(row.url);
				changed = true;
			}
		}
		return changed;
	}

	async find(url: string, validation: 'hash' | 'presence' = 'hash'): Promise<ImageAsset | undefined> {
		const asset = this.store.image(url);
		if (!asset) {
			return;
		}
		try {
			if (validation === 'presence') {
				await stat(join(this.directory, `${asset.sha256}.image`));
			} else {
				await this.verifiedBytes(asset);
			}
			return asset;
		} catch {
			this.store.dropImage(url);
		}
	}

	async fetch(url: string, context: TaskContext) {
		const destination = join(this.directory, `.temporary-${randomUUID()}`);
		const ensureRunning = (): void => {
			if (!context.running()) {
				throw new TaskCancelledError();
			}
		};

		try {
			ensureRunning();
			const proxy = await this.resolveProxy(url);
			ensureRunning();
			const provider = context.task.provider;
			const transport = sourceTransport(provider, this.store.preferences());
			const result = outcomeSchema.parse(
				await this.host.run(
					'follow.image',
					{ provider, url, destination, proxy, transport },
					{
						signal: context.signal,
						timeoutMs: 60_000,
						onRequest: (request) => context.permit(request.source),
					},
				),
			);
			ensureRunning();
			if (result.asset) {
				const bytes = await readFile(destination);
				ensureRunning();
				this.verify(bytes, result.asset);
				await chmod(destination, 0o600);
				await rename(destination, join(this.directory, `${result.asset.sha256}.image`));
				ensureRunning();
			}
			return result;
		} finally {
			await rm(destination, { force: true });
		}
	}

	async prune(): Promise<void> {
		const images = this.store.images();
		const assets = new Map(images.map((row) => [row.asset.sha256, row.asset.bytes]));
		let bytes = [...assets.values()].reduce((sum, size) => sum + size, 0);
		const referenced = new Set([...this.store.entries().map((entry) => entry.thumbnailUrl), ...this.store.subscriptions().map((sub) => sub.avatarUrl)]);
		// Eviction is terminal until explicit retry, preventing automatic refetch loops.
		images.sort((a, b) => Number(referenced.has(a.url)) - Number(referenced.has(b.url)));
		for (const row of images) {
			if (bytes <= 64 * 1024 * 1024) {
				break;
			}
			this.store.dropImage(row.url, true);
			if (!this.store.images().some((item) => item.asset.sha256 === row.asset.sha256)) {
				bytes -= row.asset.bytes;
				await rm(join(this.directory, `${row.asset.sha256}.image`), { force: true });
			}
		}
	}

	private async verifiedBytes(asset: ImageAsset): Promise<Buffer> {
		const bytes = await readFile(join(this.directory, `${asset.sha256}.image`));
		this.verify(bytes, asset);
		return bytes;
	}

	private verify(bytes: Buffer, asset: ImageAsset): void {
		if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
			throw new Error('Image mismatch');
		}
	}
}

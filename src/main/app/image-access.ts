import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageStore, type ImageBytes } from '../platform/images';
import type { PythonTaskHost } from '../platform/python';
import { sourceCooldownSeconds, sourceTransport } from '../platform/network';
import { allowedSourceUrl } from '@shared/source-identity';
import { isMetadataSource, type AllSource } from '@shared/sources';
import { workerOutcomeSchema } from '@shared/metadata';
import type { ImageVariant } from '@shared/storage';
import type { MetadataService } from '../features/metadata';
import type { LibraryService } from '../features/library';
import type { SubscriptionsService } from '../features/subscriptions';

/** 将存档身份解析为来源请求；远程 URL 从不由 renderer 传入。 */
export class ImageAccess {
	private requests: Promise<unknown> = Promise.resolve();

	constructor(
		private root: string,
		private images: ImageStore,
		private host: Pick<PythonTaskHost, 'run'>,
		private subscriptions: () => Pick<SubscriptionsService, 'store' | 'refresh'>,
		private metadata: () => Pick<MetadataService, 'picture'>,
		private library: () => Pick<LibraryService, 'picture'>,
		private resolveProxy: (url: string) => Promise<string>,
		private permit: (source: AllSource, signal: AbortSignal) => Promise<void>,
		private imageUpdated: (id: string, asset: ImageBytes['asset']) => Promise<void> = async () => {},
	) {}

	async read(scope: string, id: string, variant: ImageVariant, signal?: AbortSignal): Promise<ImageBytes | undefined> {
		let key = '';
		let load: ((signal: AbortSignal) => Promise<ImageBytes>) | undefined;
		let priority: { unread: boolean; seen: number } | undefined;
		let entryId: string | undefined;
		if (scope === 'library') {
			const work = this.library().picture(id);
			if (!work) {
				return;
			}
			key = `collection:${work.id}`;
			const cached = await this.images.read(key, variant, undefined, signal);
			if (cached && (variant === 'thumbnail' || cached.asset.sha256 === work.cover?.asset?.sha256)) {
				return cached;
			}
			const cover = work.cover;
			if (cover?.asset && isMetadataSource(cover.source)) {
				load = async (signal) => {
					const image = await this.fetch(cover.source as AllSource, cover.url, work.code, signal, () => !!this.library().picture(id));
					if (image.asset.sha256 !== cover.asset!.sha256) {
						throw new Error('PINNED_IMAGE_CHANGED');
					}
					signal.throwIfAborted();
					await this.images.put(key, image, { owner: key });
					return image;
				};
			}
		} else if (scope === 'image') {
			const picture = this.metadata().picture(id);
			if (!picture) {
				return;
			}
			key = picture.cover.url;
			if (picture.cover.asset && isMetadataSource(picture.record.source) && !picture.cancelled) {
				load = (signal) =>
					this.fetch(picture.record.source as AllSource, key, picture.record.code, signal, () => {
						const current = this.metadata().picture(id);
						return !!current && !current.cancelled;
					});
			}
		} else if (scope === 'updates') {
			const service = this.subscriptions();
			const entry = service.store.entry(id) ?? service.store.entries().find((entry) => entry.imageAsset?.sha256 === id);
			if (!entry?.thumbnailUrl) {
				return;
			}
			key = entry.thumbnailUrl;
			entryId = entry.id;
			priority = { unread: !entry.read, seen: Date.parse(entry.firstSeenAt) };
			this.images.priority(key, priority.unread, priority.seen);
			const eligible = (): boolean => {
				const current = service.store.entry(entry.id);
				const sub = service.store.subscription(entry.subscriptionId);
				return !!current && !!sub?.following && sub.enabled && !sub.autoPaused && current.imageCache?.status !== 'cancelled';
			};
			if (eligible()) {
				load = (signal) => this.fetch(entry.provider, key, undefined, signal, eligible);
			}
		} else {
			return this.images.readHash(id);
		}
		const found = await this.images.read(key, variant, load, signal);
		if (scope === 'image' && found && this.images.isOriginal(key, found.asset.sha256)) {
			const picture = this.metadata().picture(id);
			if (picture?.cover.asset && picture.cover.asset.sha256 !== found.asset.sha256) {
				await this.imageUpdated(picture.cover.id, found.asset);
			}
		}
		if (priority) {
			this.images.priority(key, priority.unread, priority.seen);
		}
		if (entryId && found) {
			const service = this.subscriptions();
			const entry = service.store.entry(entryId);
			const thumbnail = await this.images.read(key, 'thumbnail');
			if (entry && thumbnail && entry.imageAsset?.sha256 !== thumbnail.asset.sha256) {
				service.store.saveImage(entry, thumbnail.asset);
				service.refresh();
			}
		}
		await this.images.prune();
		return found;
	}

	private fetch(source: AllSource, url: string, code: string | undefined, signal: AbortSignal, eligible: () => boolean): Promise<ImageBytes> {
		const request = this.requests
			.catch(() => {})
			.then(async () => {
				const service = this.subscriptions();
				const allowed = (): void => {
					signal.throwIfAborted();
					if (!eligible() || !service.store.preferences().enabledSources.includes(source) || !allowedSourceUrl(source, url, 'image')) {
						throw new Error('IMAGE_UNAVAILABLE');
					}
				};
				allowed();
				const temporary = join(this.root, 'images', 'requests', `${randomUUID()}.image`);
				await mkdir(join(this.root, 'images', 'requests'), { recursive: true, mode: 0o700 });
				try {
					const proxy = await this.resolveProxy(url);
					allowed();
					let requests = 0;
					const transport = sourceTransport(source, service.store.preferences());
					const result = workerOutcomeSchema.parse({
						warnings: [],
						...((await this.host.run(
							code ? 'metadata.cover' : 'follow.image',
							{
								...(code ? { source, code, cookie: service.store.credential(source) } : { provider: source }),
								url,
								destination: temporary,
								proxy,
								transport,
							},
							{
								signal,
								timeoutMs: 60_000,
								onRequest: async (request) => {
									allowed();
									if (request.source !== source || ++requests > 4) {
										throw new Error('IMAGE_REQUEST_LIMIT');
									}
									await this.permit(source, signal);
								},
							},
						)) as object),
					});
					allowed();
					if (!result.asset) {
						const seconds = sourceCooldownSeconds(result.reason, result.retryAfter);
						if (seconds) {
							const previous = service.store.source(source);
							service.store.saveSource(source, { ...previous, cooldownUntil: Math.max(previous.cooldownUntil, Date.now() + seconds * 1000) });
						}
						throw new Error('IMAGE_FETCH_FAILED');
					}
					return { bytes: await readFile(temporary), asset: result.asset };
				} finally {
					await rm(temporary, { force: true });
				}
			});
		this.requests = request;
		return request;
	}
}

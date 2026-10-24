import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageAccess } from '../src/main/app/image-access';
import { ImageStore, type ImageBytes } from '../src/main/platform/images';
import { SubscriptionStore, SubscriptionsService } from '../src/main/features/subscriptions';
import { ImageCache } from '../src/main/features/subscriptions/image-cache';
import { MetadataService } from '../src/main/features/metadata';
import { LibraryService } from '../src/main/features/library';
import type { PythonTaskHost } from '../src/main/platform/python';
import { metadataRecordSchema } from '@shared/metadata';

function image(seed: string, length: number): ImageBytes {
	const bytes = Buffer.alloc(length, seed);
	return { bytes, asset: { sha256: createHash('sha256').update(bytes).digest('hex'), width: 2184, height: 1468, bytes: length, format: 'JPEG', quality: 'standard' } };
}

const original = image('original', 100);
const thumb = image('thumbnail', 10);
const outcome = { status: 'success', reason: '', message: '', requests: 1, retryAfter: 0, asset: original.asset };

async function setup(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-image-access-'));
	const images = new ImageStore(root, () => thumb);
	await images.initialize();
	const store = new SubscriptionStore(root, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' });
	const sub = store.follow({
		provider: 'fanbox',
		ref: 'testcreator',
		name: '创作者',
		url: 'https://testcreator.fanbox.cc',
		aliases: [],
		recordType: '创作者',
		bio: '',
		evidence: '',
	});
	store.upsertEntry(sub, {
		externalId: '1',
		title: '动态',
		summary: '长期保留的摘要',
		author: '创作者',
		publishedAt: '',
		publishedPrecision: 'unknown',
		url: 'https://testcreator.fanbox.cc/posts/1',
		thumbnailUrl: 'https://pixiv.pximg.net/cover1.jpg',
		code: '',
		restricted: false,
		partial: false,
	});
	const entry = store.entries()[0]!;
	store.markRead([entry.id], true);
	const calls: string[] = [];
	let permits = 0;
	const host: Pick<PythonTaskHost, 'run'> = {
		run: async (method, params, options) => {
			calls.push(method);
			await options?.onRequest?.({ source: String(params?.provider ?? params?.source), host: 'pixiv.pximg.net', sequence: 1 });
			await writeFile(String(params?.destination), original.bytes);
			return outcome;
		},
	};
	const service = new SubscriptionsService(
		store,
		host,
		async () => '',
		async () => {},
		0,
		undefined,
		images,
	);
	await service.initialize();
	const access = new ImageAccess(
		root,
		images,
		host,
		() => service,
		() => ({ picture: () => undefined }),
		() => ({ picture: () => undefined }),
		async () => '',
		async () => {
			permits++;
		},
	);
	t.after(async () => {
		await service.stop();
		await images.close();
		store.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, images, store, service, access, host, entry, sub, calls, permits: () => permits };
}

test('清理不改摘要与已读，后台不立即重填；再次查看仅补取图片，原图按需加载并遵守来源调度', async (t) => {
	const { images, store, service, access, entry, calls, permits } = await setup(t);
	assert.equal((await access.read('updates', entry.id, 'thumbnail'))?.asset.bytes, 10);
	assert.equal((await images.usage()).originalBytes, 0);
	assert.equal((await access.read('updates', entry.id, 'original'))?.asset.bytes, 100);
	assert.deepEqual(calls, ['follow.image', 'follow.image']);
	assert.equal(permits(), 2);
	await service.clearImageQueue();
	await images.clear();
	await service.tick();
	assert.equal(calls.length, 2);
	assert.equal(store.entry(entry.id)?.summary, '长期保留的摘要');
	assert.equal(store.entry(entry.id)?.read, true);
	assert.equal(store.entry(entry.id)?.imageCache?.status, 'evicted');
	assert.equal((await access.read('updates', entry.id, 'thumbnail'))?.asset.bytes, 10);
	assert.equal(store.entry(entry.id)?.imageCache, undefined);
	assert.equal(store.entry(entry.id)?.imageAsset?.sha256, thumb.asset.sha256);
	assert.deepEqual(calls, ['follow.image', 'follow.image', 'follow.image']);
});

test('显式取消、暂停或禁用来源后，查看缺图不会绕过状态派发；清理不解除取消状态', async (t) => {
	const { store, service, access, entry, sub, calls, images } = await setup(t);
	store.setImageCache([entry.id], { status: 'cancelled', attempts: 0, nextAttemptAt: 0, reason: 'cancelled' });
	await service.clearImageQueue();
	await images.clear();
	assert.equal(store.entry(entry.id)?.imageCache?.status, 'cancelled');
	assert.equal(await access.read('updates', entry.id, 'thumbnail'), undefined);
	store.setImageCache([entry.id], { status: 'evicted', attempts: 0, nextAttemptAt: 0, reason: 'cache_limit' });
	sub.enabled = false;
	store.saveSubscription(sub);
	assert.equal(await access.read('updates', entry.id, 'thumbnail'), undefined);
	sub.enabled = true;
	store.saveSubscription(sub);
	store.savePreferences({ ...store.preferences(), enabledSources: [] });
	assert.equal(await access.read('updates', entry.id, 'thumbnail'), undefined);
	assert.equal(calls.length, 0);
});

test('旧订阅多个 URL 共用哈希迁移完整，头像与普通图共享文件，迁移后不再保留旧副本', async (t) => {
	const { images, store, root, host, sub, entry } = await setup(t);
	const second = 'https://pixiv.pximg.net/cover2.jpg';
	store.cacheImage(entry.thumbnailUrl, original.asset);
	store.cacheImage(second, original.asset);
	sub.avatarUrl = second;
	sub.avatarAsset = original.asset;
	store.saveSubscription(sub);
	const directory = join(root, 'cache', 'subscription-covers');
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, `${original.asset.sha256}.image`), original.bytes);
	await new ImageCache(store, host, async () => '', images).prepare();
	assert.deepEqual(await readdir(directory), []);
	assert.equal((await images.usage()).files, 2);
	for (const url of [entry.thumbnailUrl, second]) {
		assert.equal((await images.read(url, 'thumbnail'))?.asset.sha256, thumb.asset.sha256);
	}
	assert.equal((await images.clear()).freedBytes, 0);
	assert.deepEqual((await images.readHash(original.asset.sha256))?.bytes, original.bytes);
});

test('旧查询缓存按封面身份迁移多个引用，普通图片清理不改查询资料、来源 URL 和原图身份', async (t) => {
	const { images, root, host, service } = await setup(t);
	const record = metadataRecordSchema.parse({
		id: 'a'.repeat(64),
		source: 'dmm',
		parser: 'fixture',
		parserVersion: '1',
		code: 'NECT-024',
		contentId: 'fixture',
		sourceUrl: 'https://video.dmm.co.jp/av/content/?id=fixture',
		fetchedAt: '2026-10-24T00:00:00Z',
		title: '持久资料',
		titleLanguage: 'ja',
		people: [],
		studio: '',
		label: '',
		seller: '',
		sellerUrl: '',
		series: '',
		releaseDate: '',
		description: '长期资料',
		tags: [],
		warnings: [],
		covers: ['b', 'c'].map((id) => ({ id: id.repeat(64), source: 'dmm', url: `https://pics.dmm.co.jp/${id}.jpg`, identity: 'source-matched', asset: original.asset })),
	});
	await mkdir(join(root, 'metadata'), { recursive: true });
	await mkdir(join(root, 'cache', 'covers'), { recursive: true });
	await writeFile(join(root, 'cache', 'covers', `${original.asset.sha256}.image`), original.bytes);
	await writeFile(
		join(root, 'metadata', 'state.json'),
		JSON.stringify({
			version: 1,
			revision: 1,
			assets: Object.fromEntries(record.covers.map((cover) => [cover.id, { ...original.asset, cachedAt: Date.now() }])),
			policies: {},
			tasks: [
				{
					id: randomUUID(),
					status: 'succeeded',
					phase: '',
					plan: { kind: 'code', query: record.code, code: record.code, contentId: '', sources: ['dmm'] },
					startedAt: record.fetchedAt,
					finishedAt: record.fetchedAt,
					records: [record],
					outcomes: [],
					requests: 0,
				},
			],
		}),
	);
	// 使用共享图片存储，不运行网络查询。
	const shared = new MetadataService(root, host, async () => '', 0, undefined, undefined, undefined, images);
	t.after(() => shared.stop());
	await shared.initialize();
	assert.deepEqual(
		(await readdir(join(root, 'cache', 'covers'))).filter((name) => name.endsWith('.image')),
		[],
	);
	for (const cover of record.covers) {
		assert.ok(await images.read(cover.url, 'thumbnail'));
	}
	await images.clear();
	assert.equal(shared.picture(record.covers[0]!.id)?.cover.asset?.sha256, original.asset.sha256);
	assert.equal(shared.getState().tasks[0]?.records[0]?.description, '长期资料');
	assert.match(await readFile(join(root, 'metadata', 'state.json'), 'utf8'), /长期资料/);
	const updated = image('updated', 120);
	const updatedHost: Pick<PythonTaskHost, 'run'> = {
		run: async (_method, params) => {
			await writeFile(String(params?.destination), updated.bytes);
			return { ...outcome, asset: updated.asset };
		},
	};
	const library = new LibraryService(root, images);
	await library.initialize();
	t.after(() => library.stop());
	const access = new ImageAccess(
		root,
		images,
		updatedHost,
		() => service,
		() => shared,
		() => library,
		async () => '',
		async () => {},
		(id, asset) => shared.rememberImage(id, asset),
	);
	assert.equal((await access.read('image', record.covers[0]!.id, 'original'))?.asset.sha256, updated.asset.sha256);
	assert.equal(shared.picture(record.covers[0]!.id)?.cover.asset?.sha256, updated.asset.sha256);
	const saved = await library.save(shared.getState().tasks[0]!.records, record.covers[0]!.id, false, (hash) => access.read('image', hash, 'original'));
	assert.equal(saved.records[0]?.covers[0]?.asset?.sha256, updated.asset.sha256);
});

test('查看作品只补已选中封面，不为未选中的候选派发请求', async (t) => {
	const { root, images, store, service, host, calls } = await setup(t);
	const record = metadataRecordSchema.parse({
		id: 'a'.repeat(64),
		source: 'dmm',
		parser: 'fixture',
		parserVersion: '1',
		code: 'NECT-024',
		contentId: 'fixture',
		sourceUrl: 'https://video.dmm.co.jp/av/content/?id=fixture',
		fetchedAt: '2026-10-24T00:00:00Z',
		title: '资料',
		titleLanguage: 'ja',
		people: [],
		studio: '',
		label: '',
		seller: '',
		sellerUrl: '',
		series: '',
		releaseDate: '',
		description: '',
		tags: [],
		warnings: [],
		covers: [{ id: 'b'.repeat(64), source: 'dmm', url: 'https://pics.dmm.co.jp/fixture.jpg', identity: 'source-matched' }],
	});
	const cover = record.covers[0]!;
	const access = new ImageAccess(
		root,
		images,
		host,
		() => service,
		() => ({ picture: () => ({ record, cover, cancelled: false }) }),
		() => ({ picture: () => undefined }),
		async () => '',
		async () => {},
	);
	assert.equal(await access.read('image', cover.id, 'thumbnail'), undefined);
	assert.deepEqual(calls, []);
	cover.asset = original.asset;
	assert.equal((await access.read('image', cover.id, 'thumbnail'))?.asset.bytes, 10);
	assert.deepEqual(calls, ['metadata.cover']);
	await images.clear();
	store.savePreferences({ ...store.preferences(), enabledSources: [] });
	assert.equal(await access.read('image', cover.id, 'original'), undefined);
	assert.deepEqual(calls, ['metadata.cover']);
});

test('损坏的旧普通图片不阻断订阅启动，保留摘要与已读，并在查看时重新取图', async (t) => {
	const { root, store, images, host, entry, access } = await setup(t);
	store.saveImage(entry, original.asset);
	const directory = join(root, 'cache', 'subscription-covers');
	await writeFile(join(directory, `${original.asset.sha256}.image`), Buffer.from('damaged'));
	await new ImageCache(store, host, async () => '', images).prepare();
	assert.equal(store.entry(entry.id)?.summary, '长期保留的摘要');
	assert.equal(store.entry(entry.id)?.read, true);
	assert.equal(store.entry(entry.id)?.imageCache?.status, 'evicted');
	assert.equal((await access.read('updates', entry.id, 'thumbnail'))?.asset.sha256, thumb.asset.sha256);
});

test('收藏缩略图丢失从固定原图重建；原图文件丢失时只补原图，保持收藏快照身份', async (t) => {
	const { root, images, service, host, calls } = await setup(t);
	const cover = { id: 'b'.repeat(64), source: 'dmm' as const, url: 'https://pics.dmm.co.jp/fixture.jpg', identity: 'source-matched' as const, asset: original.asset };
	const work = { id: 'c'.repeat(64), code: 'NECT-024', cover } as NonNullable<ReturnType<import('../src/main/features/library').LibraryService['picture']>>;
	await images.put(cover.url, original, { owner: `collection:${work.id}` });
	const access = new ImageAccess(
		root,
		images,
		host,
		() => service,
		() => ({ picture: () => undefined }),
		() => ({ picture: () => work }),
		async () => '',
		async () => {},
	);
	await rm(join(root, 'images', 'objects', `${thumb.asset.sha256}.image`));
	assert.equal((await access.read('library', cover.id, 'thumbnail'))?.asset.sha256, thumb.asset.sha256);
	assert.equal(calls.length, 0);
	await rm(join(root, 'images', 'objects', `${original.asset.sha256}.image`));
	assert.equal((await access.read('library', cover.id, 'original'))?.asset.sha256, original.asset.sha256);
	assert.deepEqual(calls, ['metadata.cover']);
	assert.equal((await images.clear()).freedBytes, 0);
});

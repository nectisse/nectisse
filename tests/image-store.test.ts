import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageStore, type ImageBytes } from '../src/main/platform/images';
import { LibraryService } from '../src/main/features/library';
import { metadataRecordSchema } from '@shared/metadata';
import { DEFAULT_PREFERENCES, storedPreferencesSchema, preferencesPatchSchema } from '@shared/preferences';

function image(name: string, length = 100): ImageBytes {
	const bytes = Buffer.alloc(length, name);
	return { bytes, asset: { sha256: createHash('sha256').update(bytes).digest('hex'), width: 2184, height: 1468, bytes: bytes.length, format: 'JPEG', quality: 'standard' } };
}

const thumbnail = (original: ImageBytes): ImageBytes => image(original.asset.sha256, 10);

async function setup(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-image-store-'));
	let now = 1800000000000;
	const store = new ImageStore(root, thumbnail, () => now);
	await store.initialize();
	t.after(async () => {
		await store.close();
		await rm(root, { force: true, recursive: true });
	});
	return {
		root,
		store,
		advance: (milliseconds: number) => {
			now += milliseconds;
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(check: () => Promise<boolean>): Promise<void> {
	for (let n = 0; n < 100; n++) {
		if (await check()) {
			return;
		}
		await tick();
	}
	throw new Error('Image operation did not finish');
}

test('旧设置默认 512 MiB；容量可调整并校验范围，其他 patch 不覆盖已有容量', () => {
	const { imageCacheMiB: _removed, ...legacy } = DEFAULT_PREFERENCES;
	assert.equal(storedPreferencesSchema.parse(legacy).imageCacheMiB, 512);
	assert.equal(storedPreferencesSchema.parse({ ...legacy, imageCacheMiB: 1024 }).imageCacheMiB, 1024);
	assert.equal(preferencesPatchSchema.safeParse({ imageCacheMiB: 63 }).success, false);
	assert.equal(preferencesPatchSchema.safeParse({ imageCacheMiB: 8193 }).success, false);
	assert.deepEqual(preferencesPatchSchema.parse({ theme: 'night' }), { theme: 'night' });
});

test('同图跨 URL 与收藏只保存同一份文件；清理只计算实际释放，收藏固定原图与缩略图', async (t) => {
	const { store, root } = await setup(t);
	const original = image('shared');
	await store.put('query', original);
	await store.put('post', original, { thumbnailOnly: true });
	await store.protect('collection:one', 'query');
	assert.equal((await store.usage()).files, 2);
	assert.equal((await readdir(join(root, 'images', 'objects'))).length, 2);
	assert.equal((await store.usage()).cacheBytes, 0);
	assert.equal((await store.usage()).collectionBytes, 110);
	await store.put('ordinary', image('ordinary'));
	const result = await store.clear();
	assert.equal(result.freedBytes, 110);
	assert.equal(result.removedFiles, 2);
	assert.equal(result.usage.collectionBytes, 110);
	assert.deepEqual((await store.read('collection:one', 'original'))?.bytes, original.bytes);
	assert.equal((await store.clear()).freedBytes, 0);
	await store.unprotect('collection:one');
	assert.equal((await store.clear()).freedBytes, 110);
});

test('容量先回收最久未看的原图，再回收旧缩略图，过期不会删除旧图', async (t) => {
	const { store, advance } = await setup(t);
	await store.put('older', image('old'), { seen: 1 });
	advance(1000);
	await store.put('newer', image('new'), { seen: 2 });
	await store.setLimit(120 / 1024 / 1024);
	assert.equal((await store.usage()).originalBytes, 100);
	assert.equal((await store.usage()).thumbnailBytes, 20);
	assert.equal((await store.read('older', 'original'))?.asset.bytes, 10);
	await store.setLimit(20 / 1024 / 1024);
	assert.equal((await store.usage()).originalBytes, 0);
	advance(90 * 86400_000);
	assert.equal((await store.usage()).thumbnailBytes, 20);
	assert.ok(await store.read('newer', 'thumbnail'));
	await store.setLimit(10 / 1024 / 1024);
	assert.equal((await store.usage()).thumbnailBytes, 10);
});

test('未读、近期、经常查看的缩略图优先保留', async (t) => {
	const { store } = await setup(t);
	await store.put('unread', image('unread'), { thumbnailOnly: true, unread: true, seen: 1 });
	await store.put('frequent', image('frequent'), { thumbnailOnly: true, seen: 1 });
	await store.put('old', image('old'), { thumbnailOnly: true, seen: 1 });
	await store.put('recent', image('recent'), { thumbnailOnly: true });
	for (let n = 0; n < 3; n++) {
		await store.read('frequent', 'thumbnail');
	}
	await store.setLimit(30 / 1024 / 1024);
	assert.equal(await store.read('old', 'thumbnail'), undefined);
	for (const key of ['unread', 'frequent', 'recent']) {
		assert.ok(await store.read(key, 'thumbnail'), key);
	}
});

test('过期查看先返回旧图，后台刷新失败不删图，成功后只更新普通缓存', async (t) => {
	const { store, advance } = await setup(t);
	const old = image('old');
	await store.put('source', old, { owner: 'collection:one' });
	advance(31 * 86400_000);
	let failures = 0;
	const first = await store.read('source', 'original', async () => {
		failures++;
		throw new Error('offline');
	});
	assert.equal(first?.asset.sha256, old.asset.sha256);
	await until(async () => failures === 1);
	await tick();
	assert.ok(await store.readHash(old.asset.sha256));
	advance(61_000);
	const next = image('new');
	await store.read('source', 'original', async () => next);
	await until(async () => (await store.read('source', 'original'))?.asset.sha256 === next.asset.sha256);
	assert.equal((await store.read('collection:one', 'original'))?.asset.sha256, old.asset.sha256);
});

test('列表只保留缩略图；清理或文件缺失后按需补取，无需重查资料', async (t) => {
	const { store, root } = await setup(t);
	const original = image('source');
	let calls = 0;
	const load = async () => {
		calls++;
		return original;
	};
	assert.equal((await store.read('source', 'thumbnail', load))?.asset.bytes, 10);
	assert.equal((await store.usage()).originalBytes, 0);
	assert.equal((await store.read('source', 'original', load))?.asset.bytes, 100);
	assert.equal(calls, 2);
	await store.clear();
	assert.equal((await store.read('source', 'thumbnail', load))?.asset.bytes, 10);
	assert.equal(calls, 3);
	const thumb = thumbnail(original);
	await rm(join(root, 'images', 'objects', `${thumb.asset.sha256}.image`));
	assert.ok(await store.read('source', 'thumbnail', load));
	assert.equal(calls, 4);
});

test('并发原图与缩略图只派发一次；取消一个查看不影响另一个，全部取消后不落盘', async (t) => {
	const { store } = await setup(t);
	let calls = 0;
	const response = deferred<ImageBytes>();
	const load = async () => {
		calls++;
		return response.promise;
	};
	const abort = new AbortController();
	const first = store.read('source', 'thumbnail', load, abort.signal);
	const second = store.read('source', 'original', load);
	await tick();
	abort.abort();
	await assert.rejects(first);
	response.resolve(image('source'));
	assert.equal((await second)?.asset.bytes, 100);
	assert.equal(calls, 1);
	const late = deferred<ImageBytes>();
	const last = new AbortController();
	const cancelled = store.read('late', 'original', () => late.promise, last.signal);
	await tick();
	last.abort();
	await assert.rejects(cancelled);
	late.resolve(image('late'));
	await tick();
	await tick();
	assert.equal(await store.read('late', 'original'), undefined);
});

test('清理中断在途补图，迟到返回不重新填充；重启保留收藏固定引用', async (t) => {
	const { store, root } = await setup(t);
	await store.put('saved', image('saved'), { owner: 'collection:one' });
	let aborted = false;
	const reading = store.read(
		'late',
		'original',
		(signal) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener(
					'abort',
					() => {
						aborted = true;
						reject(new Error('cancelled'));
					},
					{ once: true },
				);
			}),
	);
	await tick();
	await store.clear();
	await reading;
	assert.equal(aborted, true);
	assert.equal((await store.usage()).cacheBytes, 0);
	await store.close();
	const next = new ImageStore(root, thumbnail);
	t.after(() => next.close());
	await next.initialize();
	assert.ok(await next.read('collection:one', 'original'));
	assert.equal((await next.clear()).freedBytes, 0);
});

function record(code: string, original: ImageBytes, suffix: string) {
	return metadataRecordSchema.parse({
		id: createHash('sha256').update(code).digest('hex'),
		source: 'dmm',
		parser: 'fixture',
		parserVersion: '1',
		code,
		contentId: 'fixture',
		sourceUrl: 'https://video.dmm.co.jp/av/content/?id=fixture',
		fetchedAt: '2026-10-24T00:00:00Z',
		title: '保留的资料',
		titleLanguage: 'ja',
		people: [],
		studio: '',
		label: '',
		seller: '',
		sellerUrl: '',
		series: '',
		releaseDate: '',
		description: '来源摘要',
		tags: [],
		warnings: [],
		covers: [
			{
				id: createHash('sha256').update(suffix).digest('hex'),
				source: 'dmm',
				url: `https://pics.dmm.co.jp/${suffix}.jpg`,
				identity: 'source-matched',
				asset: original.asset,
			},
		],
	});
}

test('迁移同哈希的多个旧收藏不会丢图；收藏与普通缓存共享文件，清理后快照和原图仍可读取', async (t) => {
	const { store, root } = await setup(t);
	const original = image('shared');
	const legacy = new LibraryService(root);
	await legacy.initialize();
	const works = [];
	for (const [code, suffix] of [
		['NECT-024', 'one'],
		['NECT-025', 'two'],
	]) {
		works.push(await legacy.save([record(code!, original, suffix!)], undefined, false, async () => original));
	}
	await legacy.stop();
	const library = new LibraryService(root, store);
	t.after(() => library.stop());
	await library.initialize();
	assert.deepEqual(await readdir(join(root, 'library', 'covers')), []);
	assert.equal((await store.usage()).files, 2);
	await store.clear();
	for (const work of works) {
		assert.ok(await store.read(`collection:${work.id}`, 'original'));
	}
	assert.equal(library.getWork(works[0]!.id)?.records[0]?.description, '来源摘要');
	await library.remove(works[0]!.id);
	assert.equal((await store.clear()).freedBytes, 0);
	await library.remove(works[1]!.id);
	assert.equal((await store.clear()).freedBytes, 110);
});

test('收藏更新写库失败时保留旧固定图，失败的新图可正常清理', async (t) => {
	const { store, root } = await setup(t);
	const { DatabaseSync } = await import('node:sqlite');
	const library = new LibraryService(root, store);
	t.after(() => library.stop());
	await library.initialize();
	const old = image('old');
	const saved = await library.save([record('NECT-024', old, 'old')], undefined, false, async () => old);
	const db = new DatabaseSync(join(root, 'library', 'library.sqlite'));
	db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON works BEGIN SELECT RAISE(FAIL,'fixture write failure'); END");
	db.close();
	const next = image('new');
	await assert.rejects(library.save([record('NECT-024', next, 'new')], undefined, true, async () => next));
	assert.equal(library.getWork(saved.id)?.records[0]?.covers[0]?.asset?.sha256, old.asset.sha256);
	await store.clear();
	assert.equal((await store.read(`collection:${saved.id}`, 'original'))?.asset.sha256, old.asset.sha256);
	assert.equal(await store.readHash(next.asset.sha256), undefined);
});

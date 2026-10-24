import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MetadataService } from '../src/main/features/metadata/metadata-service';
import { PythonTaskHost } from '../src/main/platform/python/python-host';
import { coverSource, preferredCover, type CoverSource } from '@shared/cover-selection';
import { metadataRecordSchema, type ImageAsset, type SourceId } from '@shared/metadata';
import { DEFAULT_PREFERENCES, preferencesSchema } from '@shared/subscriptions';
import { SubscriptionStore } from '../src/main/features/subscriptions/subscription-store';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

const success = { status: 'success', reason: '', message: '完成', retryAfter: 0, requests: 1, warnings: [] };
const dmm = 'https://pics.dmm.co.jp/digital/video/ssis00057/ssis00057pl.jpg';
interface Picture {
	source: SourceId;
	url: string;
	width: number;
	height: number;
	failProbe?: boolean;
	failDownload?: boolean;
	reason?: string;
}

const assetFor = (picture: Picture): ImageAsset => ({
	sha256: hash(picture.url),
	width: picture.width,
	height: picture.height,
	bytes: Buffer.byteLength(picture.url),
	format: 'JPEG',
	quality: 'standard',
});

const recordFor = (source: SourceId, pictures: Picture[]) =>
	metadataRecordSchema.parse({
		id: hash(source),
		source,
		parser: 'fixture',
		parserVersion: '1',
		code: 'SSIS-057',
		contentId: 'ssis00057',
		sourceUrl: `https://example.invalid/${source}`,
		fetchedAt: new Date().toISOString(),
		title: '封面选择检查',
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

		covers: pictures.filter((item) => item.source === source).map((item) => ({ id: hash(item.url), source, url: item.url, identity: 'source-matched' })),

		warnings: [],
	});

type Context = { after: (fn: () => Promise<void>) => void };

async function fixture(t: Context, pictures: Picture[], priority: CoverSource[] = ['dmm']) {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-cover-selection-'));
	const preferences = { ...structuredClone(DEFAULT_PREFERENCES), enabledSources: [...new Set(pictures.map((item) => item.source))], coverPriority: priority };
	const calls: { method: string; url?: string }[] = [];

	const run: PythonTaskHost['run'] = async (method, params, options) => {
		calls.push({ method, url: params?.url as string | undefined });
		const source = params!.source as SourceId;
		await options?.onRequest?.({ source, host: 'fixture.invalid', sequence: 1 });
		if (method === 'metadata.query') {
			options?.onProgress?.({ event: 'record', record: recordFor(source, pictures) });
			return success;
		}
		const picture = pictures.find((item) => item.url === params!.url)!;
		if (method === 'metadata.coverProbe') {
			return picture.failProbe
				? { ...success, status: 'error', reason: picture.reason ?? 'not_found', message: '来源图片未取得' }
				: { ...success, probe: { width: picture.width, height: picture.height, format: 'JPEG' } };
		}
		assert.equal(method, 'metadata.cover');
		if (picture.failDownload) {
			return { ...success, status: 'error', reason: 'parse_error', message: '原图解码失败' };
		}
		await writeFile(String(params!.destination), picture.url);
		return { ...success, asset: assetFor(picture) };
	};

	const service = new MetadataService(root, { run }, undefined, 0, () => preferences);
	t.after(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});
	await service.initialize();

	const query = async (force = true) => {
		const reply = await service.query({ query: 'SSIS-057', sources: preferences.enabledSources, force });
		assert.equal(reply.ok, true);
		for (let cycle = 0; cycle < 300 && service.getState().activeId; cycle++) {
			await delay(5);
		}
		assert.equal(service.getState().activeId, undefined);
		return service.getState().tasks.find((task) => task.id === reply.taskId)!;
	};

	return { root, service, calls, preferences, query };
}

test('封面图源按图片主机归并；可用图片、配置优先级和像素面积决定选择', () => {
	const image = {
		id: hash('image'),
		source: 'r18dev' as const,
		url: dmm,
		identity: 'source-matched' as const,
		asset: assetFor({ source: 'r18dev', url: dmm, width: 800, height: 500 }),
	};
	const larger = { ...image, id: hash('larger'), source: 'mgstage' as const, url: 'https://image.mgstage.com/large.jpg', asset: { ...image.asset, width: 2184, height: 1468 } };
	assert.equal(coverSource(image), 'dmm');
	assert.equal(coverSource({ ...larger, url: 'https://mgs.jp/a.jpg' }), 'mgstage');
	assert.equal(preferredCover([larger, image]), image);
	assert.equal(preferredCover([larger, image], ['mgstage']), larger);
	assert.equal(preferredCover([image, larger], []), larger);
	assert.equal(preferredCover([{ ...image, asset: undefined }, larger]), larger);
});

test('默认 DMM 优先且同源选最大图；r18 重复 URL 不重复探测，其他来源不获取图片', async (t) => {
	const pictures: Picture[] = [
		{ source: 'r18dev', url: dmm, width: 800, height: 500 },
		{ source: 'dmm', url: dmm, width: 800, height: 500 },
		{ source: 'dmm', url: dmm.replace('pics.dmm.co.jp/', 'awsimgsrc.dmm.com/dig/'), width: 2184, height: 1468 },
		{ source: 'mgstage', url: 'https://image.mgstage.com/large.jpg', width: 3000, height: 2000 },
	];
	const { root, calls, query } = await fixture(t, pictures);
	const task = await query();
	const kept = task.records.flatMap((record) => record.covers).filter((cover) => cover.asset);

	assert.equal(kept.length, 1);
	assert.equal(kept[0]!.asset!.width, 2184);
	assert.equal(calls.filter((call) => call.method === 'metadata.coverProbe').length, 2);
	assert.equal(calls.filter((call) => call.method === 'metadata.cover').length, 1);
	assert.equal(
		calls.some((call) => call.method !== 'metadata.query' && call.url?.includes('mgstage')),
		false,
	);
	assert.equal((await readdir(join(root, 'cache/covers'))).filter((file) => file.endsWith('.image')).length, 1);
	assert.equal(task.records.length, 3);
	assert.equal(task.records.flatMap((record) => record.covers).filter((cover) => cover.probe).length, 2);
});

test('JavTao 保留为候补，DMM 可用时不多缓存；用户可明确改用 JavTao', async (t) => {
	const pictures: Picture[] = [
		{ source: 'dmm', url: dmm, width: 2184, height: 1468 },
		{ source: 'javtao', url: 'https://javtao.com/upload-img/cover.webp', width: 3000, height: 2000 },
	];
	const { calls, preferences, query } = await fixture(t, pictures);
	const first = await query();
	assert.deepEqual(
		first.records
			.flatMap((record) => record.covers)
			.filter((cover) => cover.asset)
			.map((cover) => cover.source),
		['dmm'],
	);
	assert.equal(
		calls.some((call) => call.method !== 'metadata.query' && call.url?.includes('javtao.com')),
		false,
	);
	preferences.coverPriority = ['javtao', 'dmm'];
	const next = await query(false);
	assert.deepEqual(
		next.records
			.flatMap((record) => record.covers)
			.filter((cover) => cover.asset)
			.map((cover) => cover.source),
		['javtao'],
	);
});

test('单个 CDN 网络失败仍尝试其他候选，限流则停止同来源的后续请求', async (t) => {
	for (const reason of ['network', 'rate_limited']) {
		const { query, calls } = await fixture(t, [
			{ source: 'dmm', url: dmm, width: 800, height: 500, failProbe: true, reason },
			{ source: 'dmm', url: dmm.replace('pics.dmm.co.jp/', 'awsimgsrc.dmm.com/dig/'), width: 2184, height: 1468 },
		]);
		const task = await query();
		assert.equal(task.records.flatMap((record) => record.covers).filter((cover) => cover.asset).length, reason === 'network' ? 1 : 0);
		assert.equal(calls.filter((call) => call.method === 'metadata.coverProbe').length, reason === 'network' ? 2 : 1);
	}
});

test('用户优先级独立持久化；更改后不会命中旧排序的查询结果，已有结果不被替换', async (t) => {
	const pictures: Picture[] = [
		{ source: 'dmm', url: dmm, width: 2184, height: 1468 },
		{ source: 'mgstage', url: 'https://image.mgstage.com/a.jpg', width: 800, height: 500 },
	];
	const { root, service, preferences, query } = await fixture(t, pictures);
	const first = await query();
	assert.equal(first.records.flatMap((record) => record.covers).find((cover) => cover.asset)!.source, 'dmm');
	preferences.coverPriority = ['mgstage', 'dmm'];
	const second = await query(false);
	assert.notEqual(second.id, first.id);
	assert.equal(second.records.flatMap((record) => record.covers).find((cover) => cover.asset)!.source, 'mgstage');
	assert.deepEqual(service.getState().tasks.find((task) => task.id === first.id)!.coverPriority, ['dmm']);
	const store = new SubscriptionStore(root, {
		available: () => false,

		encrypt: () => Buffer.alloc(0),

		decrypt: () => '',
	});
	store.savePreferences(preferences);
	store.close();
	const restored = new SubscriptionStore(root, {
		available: () => false,

		encrypt: () => Buffer.alloc(0),

		decrypt: () => '',
	});
	assert.deepEqual(restored.preferences().coverPriority, ['mgstage', 'dmm']);
	restored.close();
	const legacy = { ...DEFAULT_PREFERENCES } as Partial<typeof DEFAULT_PREFERENCES>;
	delete legacy.coverPriority;
	assert.deepEqual(preferencesSchema.parse(legacy).coverPriority, ['dmm']);
	assert.equal(preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, coverPriority: ['dmm', 'dmm'] }).success, false);
});

test('DMM 无图时比较其余候选分辨率；最大图完整获取失败后采用下一张', async (t) => {
	for (const failDownload of [false, true]) {
		const pictures: Picture[] = [
			{ source: 'dmm', url: dmm, width: 800, height: 500, failProbe: true },
			{ source: 'mgstage', url: 'https://image.mgstage.com/a.jpg', width: 800, height: 500 },
			{ source: 'prestige', url: 'https://www.prestige-av.com/a.jpg', width: 1600, height: 1000, failDownload },
		];
		const { root, query, calls } = await fixture(t, pictures);
		const task = await query();
		const covers = task.records.flatMap((record) => record.covers).filter((cover) => cover.asset);

		assert.equal(covers.length, 1);
		assert.equal(covers[0]!.source, failDownload ? 'mgstage' : 'prestige');
		assert.equal(calls.filter((call) => call.method === 'metadata.cover').length, failDownload ? 2 : 1);
		assert.equal((await readdir(join(root, 'cache/covers'))).filter((file) => file.endsWith('.image')).length, 1);
		assert.deepEqual(await readdir(join(root, 'cache/covers/temporary')), []);
	}
});

test('重启收拢旧查询的多张封面；只清理无引用图片，相同内容哈希保持共用', async (t) => {
	const { root, service, query } = await fixture(t, [{ source: 'dmm', url: dmm, width: 800, height: 500 }]);
	const task = await query();
	await service.stop();
	const location = join(root, 'metadata/state.json');
	const saved = JSON.parse(await readFile(location, 'utf8'));
	const originalAsset = saved.assets[hash(dmm)];
	delete saved.assets[hash(dmm)];
	saved.assets[originalAsset.sha256] = originalAsset;
	const extra: Picture = { source: 'mgstage', url: 'https://image.mgstage.com/a.jpg', width: 2000, height: 1400 };
	const extraRecord = recordFor('mgstage', [extra]);
	extraRecord.covers[0]!.asset = assetFor(extra);
	saved.tasks[0].records.push(extraRecord);
	delete saved.tasks[0].coverPriority;
	saved.assets[hash(extra.url)] = { ...assetFor(extra), cachedAt: Date.now() };
	const mirror = recordFor('r18dev', [{ source: 'r18dev', url: dmm.replace('pics.dmm.co.jp', 'awsimgsrc.dmm.co.jp'), width: 800, height: 500 }]);
	mirror.covers[0]!.asset = task.records[0]!.covers[0]!.asset;
	saved.tasks[0].records.push(mirror);
	saved.assets[mirror.covers[0]!.id] = { ...mirror.covers[0]!.asset, cachedAt: Date.now() };
	await writeFile(join(root, 'cache/covers', `${hash(extra.url)}.image`), extra.url);
	await writeFile(location, JSON.stringify(saved));
	const restored = new MetadataService(
		root,
		{
			run: async () => {
				throw new Error('Startup must not fetch');
			},
		},
		undefined,
		0,
	);
	t.after(() => restored.stop());
	await restored.initialize();
	assert.equal(
		restored
			.getState()
			.tasks[0]!.records.flatMap((record) => record.covers)
			.filter((cover) => cover.asset).length,
		1,
	);
	assert.equal((await readdir(join(root, 'cache/covers'))).filter((file) => file.endsWith('.image')).length, 1);
	assert.ok(await restored.image(task.records[0]!.covers[0]!.asset!.sha256));
});

test('封面获取取消后不接收迟到图片，清理临时文件，重启不自动恢复', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-cover-cancel-'));
	let ready!: () => void;
	const downloading = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const picture: Picture = { source: 'dmm', url: dmm, width: 800, height: 500 };
	let calls = 0;

	const run: PythonTaskHost['run'] = async (method, params, options) => {
		calls++;
		await options?.onRequest?.({ source: 'dmm', host: 'pics.dmm.co.jp', sequence: 1 });
		if (method === 'metadata.query') {
			options?.onProgress?.({ event: 'record', record: recordFor('dmm', [picture]) });
			return success;
		}
		if (method === 'metadata.coverProbe') {
			return { ...success, probe: { width: 800, height: 500, format: 'JPEG' } };
		}
		await writeFile(String(params!.destination), dmm);
		ready();
		await new Promise<void>((resolve) => options!.signal!.addEventListener('abort', () => resolve(), { once: true }));
		return { ...success, asset: assetFor(picture) };
	};

	const service = new MetadataService(root, { run }, undefined, 0);
	t.after(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});
	await service.initialize();
	const reply = await service.query({ query: 'SSIS-057', sources: ['dmm'], force: true });
	await downloading;
	await service.cancel(reply.taskId!);
	assert.equal(service.getState().tasks[0]!.status, 'cancelled');
	assert.equal(calls, 3);
	assert.deepEqual(await readdir(join(root, 'cache/covers/temporary')), []);
	assert.equal((await readdir(join(root, 'cache/covers'))).filter((file) => file.endsWith('.image')).length, 0);
	await service.stop();
	const restored = new MetadataService(root, { run });
	t.after(() => restored.stop());
	await restored.initialize();
	assert.equal(restored.getState().tasks[0]!.status, 'cancelled');
	assert.equal(calls, 3);
});

test('尺寸探测也可取消，探测阶段不创建原图文件或继续派发其他候选', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-cover-probe-cancel-'));
	let ready!: () => void;
	const probing = new Promise<void>((resolve) => {
		ready = resolve;
	});
	let calls = 0;
	const picture: Picture = { source: 'dmm', url: dmm, width: 800, height: 500 };

	const run: PythonTaskHost['run'] = async (method, _params, options) => {
		calls++;
		await options?.onRequest?.({ source: 'dmm', host: 'pics.dmm.co.jp', sequence: 1 });
		if (method === 'metadata.query') {
			options?.onProgress?.({ event: 'record', record: recordFor('dmm', [picture]) });
			return success;
		}
		assert.equal(method, 'metadata.coverProbe');
		ready();
		await new Promise<void>((resolve) => options!.signal!.addEventListener('abort', () => resolve(), { once: true }));
		return { ...success, probe: { width: 800, height: 500, format: 'JPEG' } };
	};

	const service = new MetadataService(root, { run }, undefined, 0);
	t.after(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});
	await service.initialize();
	const reply = await service.query({ query: 'SSIS-057', sources: ['dmm'], force: true });
	await probing;
	await service.cancel(reply.taskId!);
	assert.equal(service.getState().tasks[0]!.status, 'cancelled');
	assert.equal(calls, 2);
	assert.deepEqual(await readdir(join(root, 'cache/covers')), ['temporary']);
});

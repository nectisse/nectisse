import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LibraryService } from '../src/main/library-service';
import { metadataRecordSchema, type ImageAsset } from '@shared/metadata';

const bytes = Buffer.from('independently validated source image fixture');
const asset: ImageAsset = { sha256: createHash('sha256').update(bytes).digest('hex'), width: 2184, height: 1468, bytes: bytes.length, format: 'JPEG', quality: 'standard' };

const readImage = async () => ({ bytes, asset });

const record = (code = 'NECT-024') =>
	metadataRecordSchema.parse({
		id: 'a'.repeat(64),
		source: 'dmm',
		parser: 'fixture',
		parserVersion: '1',
		code,
		contentId: 'native-id',
		sourceUrl: 'https://video.dmm.co.jp/av/content/?id=fixture',
		fetchedAt: '2026-10-24T00:00:00.000Z',
		title: '收藏资料快照',
		titleLanguage: 'ja',
		people: [],
		studio: '厂牌',
		label: '',
		seller: '',
		sellerUrl: '',
		series: '',
		releaseDate: '2026-10-24',
		description: '来源摘要',
		tags: ['标签'],
		covers: [{ id: 'b'.repeat(64), url: 'https://pics.dmm.co.jp/fixture.jpg', source: 'dmm', identity: 'source-matched', asset }],
		warnings: [],
	});

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-library-test-'));
	const service = new LibraryService(root);
	await service.initialize();
	t.after(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});
	return { root, service };
}

test('收藏独立保留来源快照、选择封面、尺寸和时间；清理查询缓存后重启仍可离线读取', async (t) => {
	const { root, service } = await setup(t);
	const input = record();
	const work = await service.save([input], input.covers[0]!.id, false, readImage);
	input.title = '查询后来返回的新标题';
	await mkdir(join(root, 'cache', 'covers'), { recursive: true });
	await rm(join(root, 'cache'), { recursive: true });
	await service.stop();
	const next = new LibraryService(root);
	await next.initialize();
	t.after(() => next.stop());
	assert.equal(next.getState().works.length, 1);
	assert.equal(next.getWork(work.id)?.records[0]?.title, '收藏资料快照');
	assert.equal(next.getWork(work.id)?.records[0]?.sourceUrl, record().sourceUrl);
	assert.equal(next.getState().works[0]?.cover?.asset?.width, 2184);
	assert.deepEqual((await next.image(asset.sha256))?.bytes, bytes);
	assert.equal((await stat(join(root, 'library', 'library.sqlite'))).mode & 0o777, 0o600);
});

test('同编号并发收藏去重，重复查询不会覆盖收藏；明确更新保留最初收藏时间', async (t) => {
	const { service } = await setup(t);
	const [first, second] = await Promise.all([service.save([record()], undefined, false, readImage), service.save([record()], undefined, false, readImage)]);
	assert.equal(first.id, second.id);
	assert.equal(service.getState().works.length, 1);
	const changed = record();
	changed.title = '明确采用的新标题';
	await service.save([changed], undefined, false, readImage);
	assert.equal(service.getState().works[0]?.title, '收藏资料快照');
	const updated = await service.save([changed], undefined, true, readImage);
	assert.equal(updated.savedAt, first.savedAt);
	assert.equal(service.getState().works[0]?.title, changed.title);
	const other = await service.save([record('NECT-025')], undefined, false, readImage);
	assert.notEqual(other.id, first.id);
	assert.equal(service.getState().works.length, 2);
});

test('收藏列表投影迁移保留完整快照和原图，不要求重新查询', async (t) => {
	const { root, service } = await setup(t);
	const work = await service.save([record()], undefined, false, readImage);
	await service.stop();
	const db = new DatabaseSync(join(root, 'library', 'library.sqlite'));
	db.exec('ALTER TABLE works DROP COLUMN summary');
	db.close();
	const next = new LibraryService(root);
	await next.initialize();
	t.after(() => next.stop());
	assert.equal(next.getState().works[0]?.title, '收藏资料快照');
	assert.equal(next.getWork(work.id)?.records[0]?.description, '来源摘要');
	assert.ok(await next.image(asset.sha256));
});

test('相同图片只保留一份，取消收藏不会删除其他收藏引用的封面', async (t) => {
	const { root, service } = await setup(t);
	const first = await service.save([record()], undefined, false, readImage);
	const second = await service.save([record('NECT-025')], undefined, false, readImage);
	await service.remove(first.id);
	assert.ok(await service.image(asset.sha256));
	await service.remove(second.id);
	assert.equal(await service.image(asset.sha256), undefined);
	await assert.rejects(stat(join(root, 'library', 'covers', `${asset.sha256}.image`)));
	assert.equal(service.getState().works.length, 0);
});

test('选定封面丢失或校验失败时不写入半份收藏，失败后仍可正常保存', async (t) => {
	const { service } = await setup(t);
	await assert.rejects(
		service.save([record()], undefined, false, async () => undefined),
		/LIBRARY_COVER_UNAVAILABLE/,
	);
	await assert.rejects(
		service.save([record()], undefined, false, async () => ({ bytes: Buffer.alloc(bytes.length), asset })),
		/LIBRARY_COVER_UNAVAILABLE/,
	);
	assert.equal(service.getState().works.length, 0);
	await service.save([record()], undefined, false, readImage);
	assert.equal(service.getState().works.length, 1);
});

test('仅固定所选封面，其他候选保留来源但不伪装为已保存原图；无图作品也能收藏', async (t) => {
	const { service } = await setup(t);
	const item = record();
	item.covers.push({ ...item.covers[0]!, id: 'c'.repeat(64), asset: { ...asset, sha256: 'd'.repeat(64) } });
	const saved = await service.save([item], item.covers[0]!.id, false, readImage);
	assert.equal(saved.records[0]?.covers[1]?.asset, undefined);
	const plain = record('NECT-026');
	plain.covers = [];
	const without = await service.save([plain], undefined, false, async () => {
		throw new Error('No image request is allowed');
	});
	assert.equal(without.coverId, null);
});

test('重新查询缺图时明确更新也不丢弃已有收藏封面或覆盖快照', async (t) => {
	const { service } = await setup(t);
	const first = await service.save([record()], undefined, false, readImage);
	const missing = record();
	missing.title = '本次查询不完整';
	delete missing.covers[0]!.asset;
	await assert.rejects(service.save([missing], undefined, true, readImage), /LIBRARY_COVER_UNAVAILABLE/);
	assert.equal(service.getWork(first.id)?.records[0]?.title, first.records[0]?.title);
	assert.deepEqual((await service.image(asset.sha256))?.bytes, bytes);
});

test('拒绝混合身份和未知封面，原文入口只开放保存记录的 HTTPS 来源域', async (t) => {
	const { root, service } = await setup(t);
	await assert.rejects(service.save([record(), record('NECT-025')], undefined, false, readImage));
	await assert.rejects(service.save([record()], 'e'.repeat(64), false, readImage));
	const work = await service.save([record()], undefined, false, readImage);
	assert.equal(service.sourceUrl(work.id, work.records[0]!.id), record().sourceUrl);
	assert.equal(service.sourceUrl(work.id, 'f'.repeat(64)), undefined);
	assert.equal(await service.image('../library.sqlite'), undefined);
	const unsafe = record();
	unsafe.sourceUrl = 'https://video.dmm.co.jp.evil.invalid/work';
	await service.save([unsafe], undefined, true, readImage);
	assert.equal(service.sourceUrl(work.id, unsafe.id), undefined);
	await writeFile(join(root, 'library', 'covers', `${asset.sha256}.image`), Buffer.alloc(bytes.length));
	assert.equal(await service.image(asset.sha256), undefined);
});

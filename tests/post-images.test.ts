import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entrySchema, entryImageSaveSchema } from '../src/shared/subscriptions';
import { createDesktopState } from '../src/renderer/shared/desktop/desktop';
import { createDemoFixtures } from '../src/renderer/demo/fixtures';

test('旧帖子不被当作已取得完整图库，多图在共享协议中保留顺序和尺寸', () => {
	const entry = createDemoFixtures('night').subscriptions.entries.find((entry) => entry.provider === 'x' && entry.images?.length)!;
	assert.equal(entrySchema.parse(entry).images?.length, 3);
	const legacy = { ...entry };
	delete legacy.images;
	assert.equal(entrySchema.parse(legacy).images, undefined);
	assert.deepEqual(entrySchema.parse({ ...entry, images: [] }).images, []);
	assert.equal(entrySchema.parse(entry).images?.[1]?.url, entry.images?.[1]?.url);
	assert.equal(entrySchema.parse(entry).images?.[1]?.width, 418);
	assert.equal(entrySchema.safeParse({ ...entry, images: Array.from({ length: 21 }, () => entry.images![0]) }).success, false);
});

test('多图仍使用本地图片协议，索引不会把远程地址交给网页加载', () => {
	const desktop = createDesktopState(undefined);
	const id = 'a'.repeat(64);
	const address = desktop.actions.imageUrl('updates', id, 'original', 'b'.repeat(64), 1);
	const url = new URL(address);
	assert.equal(url.protocol, 'nectisse-cover:');
	assert.equal(url.hostname, 'updates');
	assert.equal(url.pathname, '/' + id);
	assert.equal(url.searchParams.get('index'), '1');
	assert.equal(url.searchParams.get('variant'), 'original');
	assert.equal(new URL(desktop.actions.imageUrl('updates', id)).searchParams.has('index'), false);
});

test('保存图片只接受帖子身份与有界索引，不允许网页指定 URL 或文件路径', () => {
	const request = { id: 'a'.repeat(64), index: 1 };
	assert.deepEqual(entryImageSaveSchema.parse(request), request);
	for (const value of [
		{ ...request, index: -1 },
		{ ...request, index: 20 },
		{ ...request, index: 1.5 },
		{ ...request, id: '../image' },
		{ ...request, url: 'https://example.com/image.jpg' },
		{ ...request, path: '/tmp/image.jpg' },
	]) {
		assert.equal(entryImageSaveSchema.safeParse(value).success, false);
	}
});

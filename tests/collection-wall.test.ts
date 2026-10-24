import test from 'node:test';
import assert from 'node:assert/strict';
import { wallLayout, clampCamera, visibleTiles } from '../src/renderer/features/library/model/wall-layout';

test('有限拼贴中的作品只出现一次，区块不重叠，收藏增多不移动已有作品', () => {
	for (const count of [0, 1, 2, 7, 12, 13, 35, 36, 61, 5000]) {
		const layout = wallLayout(count);
		assert.equal(layout.tiles.length, count);
		assert.equal(new Set(layout.tiles.map((tile) => tile.index)).size, count);
		assert.ok(layout.tiles.every((tile) => tile.x >= 0 && tile.y >= 0 && tile.x + tile.width <= layout.extent.width && tile.y + tile.height <= layout.extent.height));
		for (const a of layout.tiles.slice(0, 61)) {
			for (const b of layout.tiles.slice(a.index + 1, 61)) {
				assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
			}
		}
	}
	assert.deepEqual(wallLayout(37).tiles, wallLayout(5000).tiles.slice(0, 37));
});

test('五千部收藏只渲染视口附近的封面，镜头移动与缩放不会生成重复实例', () => {
	const layout = wallLayout(5000);
	for (const camera of [
		{ x: 20, y: 64, scale: 1 },
		{ x: -1500, y: -5000, scale: 0.4 },
		{ x: -1600, y: -800, scale: 1.6 },
	]) {
		const tiles = visibleTiles(layout.tiles, camera, { width: 1280, height: 840 });
		assert.ok(tiles.length > 0 && tiles.length < 120);
		assert.equal(new Set(tiles.map((tile) => tile.index)).size, tiles.length);
	}
});

test('镜头缩放有上下限，小馆藏居中，大馆藏移动到边界后仍能看到内容', () => {
	const viewport = { width: 1000, height: 700 };
	const small = wallLayout(1).extent;
	const centered = clampCamera({ x: -100000, y: -100000, scale: 1 }, viewport, small);
	assert.equal(centered.x, (viewport.width - small.width) / 2);
	assert.equal(centered.y, (viewport.height - small.height) / 2);
	const layout = wallLayout(5000);
	for (const scale of [0.01, 1, 100]) {
		const camera = clampCamera({ x: -1e9, y: -1e9, scale }, viewport, layout.extent);
		assert.ok(camera.scale >= 0.4 && camera.scale <= 1.6);
		assert.ok(visibleTiles(layout.tiles, camera, viewport).length > 0);
	}
});

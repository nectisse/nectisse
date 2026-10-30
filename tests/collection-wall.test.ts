import test from 'node:test';
import assert from 'node:assert/strict';
import { wallLayout, clampCamera, homeCamera, visibleTiles, WALL_MIN_SCALE, WALL_MAX_SCALE } from '../src/renderer/features/library/model/wall-layout';

test('有限拼贴中的作品只出现一次，区块不重叠，收藏增多不移动已完整的区块', () => {
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
	assert.deepEqual(wallLayout(37).tiles.slice(0, 36), wallLayout(5000).tiles.slice(0, 36));
});

test('14 部作品及跨组尾部连续相接，不把剩余封面隔在空区另一侧', () => {
	for (const count of [14, ...Array.from({ length: 72 }, (_, index) => index + 1)]) {
		const { tiles } = wallLayout(count);
		const connected = new Set([0]);
		const queue = [tiles[0]!];
		for (const tile of queue) {
			for (const next of tiles) {
				if (connected.has(next.index)) {
					continue;
				}
				const overlapX = Math.min(tile.x + tile.width, next.x + next.width) - Math.max(tile.x, next.x);
				const overlapY = Math.min(tile.y + tile.height, next.y + next.height) - Math.max(tile.y, next.y);
				if ((overlapX > 0 && overlapY >= -6.01) || (overlapY > 0 && overlapX >= -6.01)) {
					connected.add(next.index);
					queue.push(next);
				}
			}
		}
		assert.equal(connected.size, count, `${count} 部作品中有封面被大块空白隔开`);
	}
});

test('不足十二张的尾组铺满自身矩形，边缘不会留下大块缺角', () => {
	for (let count = 1; count <= 36; count++) {
		const tail = wallLayout(count).tiles.slice(Math.floor((count - 1) / 12) * 12);
		const left = Math.min(...tail.map((tile) => tile.x));
		const top = Math.min(...tail.map((tile) => tile.y));
		const width = Math.max(...tail.map((tile) => tile.x + tile.width)) - left;
		const height = Math.max(...tail.map((tile) => tile.y + tile.height)) - top;
		const area = tail.reduce((area, tile) => area + tile.width * tile.height, 0);
		assert.ok(area / (width * height) >= 0.95, `${count} 部作品的尾组留有过大缺角`);
	}
});

test('五千部收藏只渲染视口附近的封面，镜头移动与缩放不会生成重复实例', () => {
	const layout = wallLayout(5000);
	for (const camera of [
		{ x: 20, y: 64, scale: 1 },
		{ x: 24, y: 72, scale: WALL_MIN_SCALE },
		{ x: -1500, y: -5000, scale: 0.4 },
		{ x: -1600, y: -800, scale: 1.6 },
	]) {
		const tiles = visibleTiles(layout.tiles, camera, { width: 1280, height: 840 });
		assert.ok(tiles.length > 0 && tiles.length < 200);
		assert.equal(new Set(tiles.map((tile) => tile.index)).size, tiles.length);
	}
});

test('镜头缩放有上下限，小馆藏居中，大馆藏移动到边界后仍能看到内容', () => {
	const viewport = { width: 1000, height: 700 };
	const small = { width: 306, height: 202 };
	const centered = clampCamera({ x: -100000, y: -100000, scale: 1 }, viewport, small);
	assert.equal(centered.x, (viewport.width - small.width) / 2);
	assert.equal(centered.y, 72 + (viewport.height - 72 - 80 - small.height) / 2);
	const layout = wallLayout(5000);
	for (const scale of [0.01, 1, 100]) {
		const camera = clampCamera({ x: -1e9, y: -1e9, scale }, viewport, layout.extent);
		assert.ok(camera.scale >= WALL_MIN_SCALE && camera.scale <= WALL_MAX_SCALE);
		assert.ok(visibleTiles(layout.tiles, camera, viewport).length > 0);
	}
});

test('拖到边界时保留侧边留白，并避开顶部导航和底部工具栏', () => {
	const viewport = { width: 1280, height: 840 };
	const { extent } = wallLayout(5000);
	const start = clampCamera({ x: 1e9, y: 1e9, scale: 1 }, viewport, extent);
	assert.equal(start.x, 24);
	assert.equal(start.y, 72);
	const end = clampCamera({ x: -1e9, y: -1e9, scale: 1 }, viewport, extent);
	assert.equal(end.x + extent.width, viewport.width - 24);
	assert.equal(end.y + extent.height, viewport.height - 80);
});

test('首次进入与重置使用实际视口居中，小馆藏完整展示，大馆藏从顶部开始', () => {
	for (const viewport of [
		{ width: 1000, height: 700 },
		{ width: 1280, height: 840 },
		{ width: 1920, height: 1080 },
	]) {
		for (const count of [0, 1, 2, 13, 14, 37, 5000]) {
			const { tiles, extent } = wallLayout(count);
			const home = homeCamera(viewport, extent);
			assert.ok(home.scale >= WALL_MIN_SCALE && home.scale <= 0.9);
			assert.ok(Math.abs(home.x + (extent.width * home.scale) / 2 - viewport.width / 2) < 0.01);
			assert.ok(home.y >= 72);
			if (extent.height * home.scale <= viewport.height - 72 - 80) {
				assert.ok(Math.abs(home.y + (extent.height * home.scale) / 2 - (viewport.height - 8) / 2) < 0.01);
			} else {
				assert.equal(home.y, 72);
			}
			if (count <= 14) {
				assert.ok(home.x >= 24 - 0.01);
				assert.ok(home.x + extent.width * home.scale <= viewport.width - 24 + 0.01);
				assert.ok(home.y + extent.height * home.scale <= viewport.height - 80 + 0.01);
				assert.equal(visibleTiles(tiles, home, viewport).length, count);
			}
		}
	}
});

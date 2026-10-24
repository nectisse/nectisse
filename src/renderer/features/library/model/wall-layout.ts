/*! 拼贴模板适配 Peach / Folia（AGPL-3.0）。
 * 原始模板：chthollyphile/folia-major，9a01e788ed52d25ea01b1f0d37934e5e371ae82b。
 * 复用记录：resources/notices/folia-wall.json。 */

export interface WallCamera {
	x: number;
	y: number;
	scale: number;
}

export interface WallSize {
	width: number;
	height: number;
}

export interface WallTile extends WallSize {
	index: number;
	x: number;
	y: number;
}

// 每个 12 × 8 区块恰好容纳 12 张封面，按区块镜像，续接时已有位置不变。
const patterns = [
	[
		[0, 0, 3, 2],
		[3, 0, 6, 4],
		[9, 0, 3, 2],
		[0, 2, 3, 2],
		[9, 2, 3, 4],
		[0, 4, 4, 4],
		[4, 4, 2, 2],
		[6, 4, 3, 2],
		[4, 6, 2, 2],
		[6, 6, 2, 2],
		[8, 6, 2, 2],
		[10, 6, 2, 2],
	],
	[
		[0, 0, 2, 3],
		[2, 0, 2, 3],
		[4, 0, 2, 3],
		[6, 0, 6, 4],
		[0, 3, 6, 2],
		[6, 4, 2, 4],
		[8, 4, 2, 4],
		[10, 4, 2, 2],
		[0, 5, 2, 3],
		[2, 5, 2, 3],
		[4, 5, 2, 3],
		[10, 6, 2, 2],
	],
	[
		[0, 0, 6, 4],
		[6, 0, 6, 3],
		[6, 3, 4, 3],
		[10, 3, 2, 2],
		[0, 4, 4, 2],
		[4, 4, 2, 2],
		[10, 5, 2, 3],
		[0, 6, 2, 2],
		[2, 6, 2, 2],
		[4, 6, 2, 2],
		[6, 6, 2, 2],
		[8, 6, 2, 2],
	],
	[
		[0, 0, 2, 2],
		[2, 0, 2, 2],
		[4, 0, 4, 3],
		[8, 0, 2, 4],
		[10, 0, 2, 4],
		[0, 2, 2, 3],
		[2, 2, 2, 2],
		[4, 3, 4, 3],
		[2, 4, 2, 2],
		[8, 4, 4, 4],
		[0, 5, 2, 3],
		[2, 6, 6, 2],
	],
] as const;

export function wallLayout(count: number): { tiles: WallTile[]; extent: WallSize } {
	const pitch = 104;
	const gap = 6;
	const tiles = Array.from({ length: count }, (_, index) => {
		const block = Math.floor(index / 12);
		const column = block % 3;
		const row = Math.floor(block / 3);
		const pattern = patterns[(column + row * 2) % patterns.length]!;
		const [x, y, width, height] = pattern[index % 12]!;
		const left = (column + row) % 2 ? 12 - x - width : x;
		return { index, x: (column * 12 + left) * pitch, y: (row * 8 + y) * pitch, width: width * pitch - gap, height: height * pitch - gap };
	});
	const extent = tiles.reduce((size, tile) => ({ width: Math.max(size.width, tile.x + tile.width), height: Math.max(size.height, tile.y + tile.height) }), {
		width: 0,
		height: 0,
	});
	return { tiles, extent };
}

export function clampCamera(camera: WallCamera, viewport: WallSize, extent: WallSize): WallCamera {
	const scale = Math.max(0.4, Math.min(1.6, camera.scale));
	const bound = (offset: number, content: number, screen: number, margin: number): number =>
		content * scale < screen - margin * 2 ? (screen - content * scale) / 2 : Math.min(margin, Math.max(screen - content * scale - margin, offset));
	return { scale, x: bound(camera.x, extent.width, viewport.width, 0), y: bound(camera.y, extent.height, viewport.height, 0) };
}

export function visibleTiles(tiles: WallTile[], camera: WallCamera, viewport: WallSize): WallTile[] {
	const left = (-camera.x - 160) / camera.scale;
	const top = (-camera.y - 160) / camera.scale;
	const right = left + (viewport.width + 320) / camera.scale;
	const bottom = top + (viewport.height + 320) / camera.scale;
	return tiles.filter((tile) => tile.x < right && tile.y < bottom && tile.x + tile.width > left && tile.y + tile.height > top);
}

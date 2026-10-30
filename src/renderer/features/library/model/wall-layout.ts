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

export const WALL_MIN_SCALE = 0.3;
export const WALL_MAX_SCALE = 1.6;

// 每个 12 × 8 区块恰好容纳 12 张封面；完整区块的位置不随收藏增多而改变。
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

// 完整区块保留原模板的镜像和作品顺序。
const templates = patterns.map((pattern) => [false, true].map((flipped) => pattern.map(([x, y, width, height]) => ({ x: flipped ? 12 - x - width : x, y, width, height }))));

function partialTemplate(count: number) {
	const rows = Math.ceil(Math.sqrt(count / 2));
	const height = 8 / rows;
	const slots = [];
	let remaining = count;
	for (let row = 0; row < rows; row++) {
		const columns = Math.ceil(remaining / (rows - row));
		const width = 12 / columns;
		for (let column = 0; column < columns; column++) {
			slots.push({ x: column * width, y: row * height, width, height });
		}
		remaining -= columns;
	}
	return slots;
}

export function wallLayout(count: number): { tiles: WallTile[]; extent: WallSize } {
	const pitch = 104;
	const gap = 6;
	const remainder = count % 12;
	// 有限收藏的尾组用实际张数铺满，避免循环墙模板在缺少作品时留下空洞。
	const tail = remainder ? partialTemplate(remainder) : undefined;
	const tiles = Array.from({ length: count }, (_, index) => {
		const block = Math.floor(index / 12);
		const column = block % 3;
		const row = Math.floor(block / 3);
		const template = block === Math.floor(count / 12) && tail ? tail : templates[(column + row * 2) % templates.length]![(column + row) % 2]!;
		const slot = template[index % 12]!;
		return { index, x: (column * 12 + slot.x) * pitch, y: (row * 8 + slot.y) * pitch, width: slot.width * pitch - gap, height: slot.height * pitch - gap };
	});
	const extent = tiles.reduce((size, tile) => ({ width: Math.max(size.width, tile.x + tile.width), height: Math.max(size.height, tile.y + tile.height) }), {
		width: 0,
		height: 0,
	});
	return { tiles, extent };
}

const insets = { top: 72, right: 24, bottom: 80, left: 24 };

function viewportFrame(viewport: WallSize) {
	return {
		x: insets.left,
		y: insets.top,
		width: Math.max(0, viewport.width - insets.left - insets.right),
		height: Math.max(0, viewport.height - insets.top - insets.bottom),
	};
}

export function clampCamera(camera: WallCamera, viewport: WallSize, extent: WallSize): WallCamera {
	const scale = Math.max(WALL_MIN_SCALE, Math.min(WALL_MAX_SCALE, camera.scale));
	const frame = viewportFrame(viewport);
	const bound = (offset: number, content: number, start: number, space: number): number =>
		content * scale <= space ? start + (space - content * scale) / 2 : Math.min(start, Math.max(start + space - content * scale, offset));

	return { scale, x: bound(camera.x, extent.width, frame.x, frame.width), y: bound(camera.y, extent.height, frame.y, frame.height) };
}

export function homeCamera(viewport: WallSize, extent: WallSize): WallCamera {
	const frame = viewportFrame(viewport);
	const preferred = viewport.width < 1100 ? 0.7 : 0.9;
	const scale = Math.max(WALL_MIN_SCALE, Math.min(preferred, extent.width ? frame.width / extent.width : preferred, extent.height ? frame.height / extent.height : preferred));
	// 小馆藏完整居中；大馆藏保留横向中心，从顶部开始浏览。
	return clampCamera({ scale, x: frame.x + (frame.width - extent.width * scale) / 2, y: frame.y }, viewport, extent);
}

export function visibleTiles(tiles: WallTile[], camera: WallCamera, viewport: WallSize): WallTile[] {
	const left = (-camera.x - 160) / camera.scale;
	const top = (-camera.y - 160) / camera.scale;
	const right = left + (viewport.width + 320) / camera.scale;
	const bottom = top + (viewport.height + 320) / camera.scale;
	return tiles.filter((tile) => tile.x < right && tile.y < bottom && tile.x + tile.width > left && tile.y + tile.height > top);
}

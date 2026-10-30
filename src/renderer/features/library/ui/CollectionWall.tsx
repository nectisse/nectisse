import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Images, Minus, Plus, RotateCcw, Search, X } from 'lucide-react';
import type { WorkSummary } from '@shared/library';
import { CoverImage } from '@/entities/work';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/shared/ui/dialog';
import { EmptyState } from '@/shared/components/empty-state';
import { visibleTiles, wallLayout, WALL_MIN_SCALE, WALL_MAX_SCALE, type WallCamera } from '../model/wall-layout';
import { useWallCamera } from './use-wall-camera';

export function CollectionWall({
	works,
	search,
	onSearch,
	initialCamera,
	onCameraChange,
	onClose,
	onDetails,
}: {
	works: WorkSummary[];
	search: string;
	onSearch: (value: string) => void;
	initialCamera?: WallCamera;
	onCameraChange: (camera: WallCamera) => void;
	onClose: () => void;
	onDetails: (id: string) => void;
}): React.JSX.Element {
	const layout = useMemo(() => wallLayout(works.length), [works.length]);
	const camera = useWallCamera(layout.extent, search, initialCamera, onCameraChange);
	const [tools, setTools] = useState(false);
	const [previewId, setPreviewId] = useState('');
	const preview = works.find((work) => work.id === previewId);
	const tiles = visibleTiles(layout.tiles, camera.view.camera, camera.view.size);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) {
					if (tools) {
						setTools(false);
					} else {
						onClose();
					}
				}
			}}
		>
			<DialogContent fullScreen className="collection-wall" initialFocus={camera.viewport} aria-describedby="collection-wall-help">
				<DialogTitle className="sr-only">作品照片墙</DialogTitle>
				<DialogDescription id="collection-wall-help" className="sr-only">
					拖动、触控板或方向键浏览，使用加减按钮缩放。选择封面可预览或查看作品资料，Escape 返回收藏。
				</DialogDescription>
				<div
					ref={camera.viewportRef}
					className="collection-wall-viewport"
					tabIndex={0}
					{...camera.handlers}
					onKeyDown={(event) => {
						if (event.target !== event.currentTarget) {
							return;
						}
						const directions: Record<string, [number, number]> = { ArrowLeft: [180, 0], ArrowRight: [-180, 0], ArrowUp: [0, 180], ArrowDown: [0, -180] };
						const direction = directions[event.key];
						if (direction) {
							event.preventDefault();
							camera.pan(...direction);
						}
					}}
				>
					<div ref={camera.world} className="collection-wall-world">
						{tiles.map((tile) => {
							const work = works[tile.index]!;
							return (
								<Button
									variant="media"
									size="media"
									key={work.id}
									className="collection-wall-tile"
									aria-label={`预览收藏封面 ${work.code}`}
									onClick={() => setPreviewId(work.id)}
									style={{ left: tile.x, top: tile.y, width: tile.width, height: tile.height }}
								>
									<CoverImage cover={work.cover} scope="library" />
									<span className="collection-wall-tile-copy">
										<strong>{work.code}</strong>
										<span>{work.people.slice(0, 3).join(' · ') || work.title}</span>
									</span>
								</Button>
							);
						})}
					</div>
				</div>
				<div className="collection-wall-top window-drag">
					<Button variant="ghost" size="sm" onClick={onClose}>
						<ArrowLeft />
						返回收藏
					</Button>
					<span>
						{works.length} 部作品{search && ' · 筛选结果'}
					</span>
				</div>
				{!works.length && (
					<div className="collection-wall-empty">
						<EmptyState
							icon={Images}
							title={search ? '没有匹配的收藏' : '还没有收藏作品'}
							description={search ? '换个关键词，或清除筛选继续浏览。' : '收藏作品后，封面会在这里汇成一面墙。'}
							action={search ? { label: '清除筛选', onClick: () => onSearch('') } : undefined}
						/>
					</div>
				)}
				{tools && (
					<div className="collection-wall-search">
						<Search />
						<Input aria-label="搜索照片墙" placeholder="编号、人物或标题" value={search} onChange={(event) => onSearch(event.target.value)} />
						{search && (
							<Button variant="ghost" size="icon-sm" aria-label="清除照片墙筛选" onClick={() => onSearch('')}>
								<X />
							</Button>
						)}
					</div>
				)}
				<div className="collection-wall-tools" aria-label="照片墙工具栏">
					<Button variant="ghost" size="icon-sm" aria-label="搜索照片墙" aria-expanded={tools} onClick={() => setTools(!tools)}>
						<Search />
					</Button>
					<span className="collection-wall-tools-divider" />
					<Button variant="ghost" size="icon-sm" aria-label="缩小照片墙" disabled={camera.view.camera.scale <= WALL_MIN_SCALE} onClick={() => camera.zoom(1 / 1.2)}>
						<Minus />
					</Button>
					<output aria-label="照片墙缩放">{Math.round(camera.view.camera.scale * 100)}%</output>
					<Button variant="ghost" size="icon-sm" aria-label="放大照片墙" disabled={camera.view.camera.scale >= WALL_MAX_SCALE} onClick={() => camera.zoom(1.2)}>
						<Plus />
					</Button>
					<Button variant="ghost" size="icon-sm" aria-label="重置照片墙位置" onClick={camera.reset}>
						<RotateCcw />
					</Button>
				</div>
				<p className="collection-wall-hint">拖动浏览 · 触控板移动 · Esc 返回</p>
				<Dialog
					open={!!preview}
					onOpenChange={(open) => {
						if (!open) {
							setPreviewId('');
						}
					}}
				>
					<DialogContent className="collection-wall-preview">
						{preview && (
							<>
								<header>
									<DialogTitle>{preview.code}</DialogTitle>
									<Button variant="ghost" size="icon-sm" aria-label="关闭封面预览" onClick={() => setPreviewId('')}>
										<X />
									</Button>
								</header>
								<CoverImage cover={preview.cover} scope="library" variant="original" />
								<footer>
									<DialogDescription>{preview.title}</DialogDescription>
									<Button size="sm" onClick={() => onDetails(preview.id)}>
										查看作品资料
										<ArrowUpRight />
									</Button>
								</footer>
							</>
						)}
					</DialogContent>
				</Dialog>
			</DialogContent>
		</Dialog>
	);
}

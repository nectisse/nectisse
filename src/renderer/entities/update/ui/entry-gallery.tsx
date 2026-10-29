import { useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Expand, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/shared/ui/dialog';
import { cn } from '@/shared/lib/utils';

export type EntryMedia = { key: string; image: ReactNode; thumbnail: ReactNode; label: string };

export function EntryGallery({ media, author }: { media: EntryMedia[]; author: string }): React.JSX.Element | null {
	const [index, setIndex] = useState(0);
	const [expanded, setExpanded] = useState(false);
	const [zoomed, setZoomed] = useState(false);
	const opener = useRef<HTMLButtonElement>(null);
	const active = Math.min(index, media.length - 1);
	const current = media[active];
	if (!current) {
		return null;
	}

	const change = (next: number): void => {
		setIndex(Math.max(0, Math.min(media.length - 1, next)));
		setZoomed(false);
	};

	return (
		<div className="entry-gallery" aria-label="帖子图片">
			<div className="entry-gallery-stage">
				<Button ref={opener} variant="media" size="media" className="entry-gallery-open" onClick={() => setExpanded(true)} aria-label={`查看第 ${active + 1} 张大图`}>
					<span className="entry-gallery-picture" key={current.key}>
						{current.image}
					</span>
					<span className="entry-gallery-expand">
						<Expand /> 查看大图
					</span>
				</Button>
				{media.length > 1 && (
					<>
						<Button
							variant="secondary"
							size="icon-sm"
							className="entry-gallery-previous"
							disabled={active === 0}
							aria-label="上一张图片"
							onClick={() => change(active - 1)}
						>
							<ChevronLeft />
						</Button>
						<Button
							variant="secondary"
							size="icon-sm"
							className="entry-gallery-next"
							disabled={active === media.length - 1}
							aria-label="下一张图片"
							onClick={() => change(active + 1)}
						>
							<ChevronRight />
						</Button>
					</>
				)}
			</div>
			{media.length > 1 && (
				<div className="entry-gallery-navigation">
					<div className="entry-gallery-thumbnails" aria-label="选择图片">
						{media.map((picture, position) => (
							<Button
								key={picture.key}
								variant="media"
								size="media"
								className="entry-gallery-thumbnail"
								aria-label={`查看第 ${position + 1} 张图片`}
								aria-pressed={active === position}
								onClick={() => change(position)}
							>
								{picture.thumbnail}
							</Button>
						))}
					</div>
					<span className="entry-gallery-count" aria-live="polite">
						{active + 1} / {media.length}
					</span>
				</div>
			)}
			<Dialog open={expanded} onOpenChange={setExpanded}>
				<DialogContent
					fullScreen
					className="entry-image-viewer"
					finalFocus={() => opener.current}
					onKeyDown={(event) => {
						if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
							event.preventDefault();
							change(active + (event.key === 'ArrowLeft' ? -1 : 1));
						}
					}}
				>
					<DialogTitle className="sr-only">{author}的图片</DialogTitle>
					<DialogDescription className="sr-only">{current.label}。使用左右方向键切换图片，Esc 返回详情，可切换原始大小查看。</DialogDescription>
					<div className="entry-image-viewer-toolbar">
						<span className="entry-image-viewer-position" aria-live="polite">
							{active + 1} / {media.length}
						</span>
						<div className="entry-image-viewer-actions">
							{media.length > 1 && (
								<>
									<Button variant="ghost" size="icon" disabled={active === 0} aria-label="上一张大图" onClick={() => change(active - 1)}>
										<ChevronLeft />
									</Button>
									<Button variant="ghost" size="icon" disabled={active === media.length - 1} aria-label="下一张大图" onClick={() => change(active + 1)}>
										<ChevronRight />
									</Button>
								</>
							)}
							<Button variant="ghost" size="sm" aria-pressed={zoomed} onClick={() => setZoomed(!zoomed)}>
								{zoomed ? <ZoomOut /> : <ZoomIn />}
								{zoomed ? '适合窗口' : '原始大小'}
							</Button>
							<Button variant="ghost" size="icon" aria-label="退出大图" onClick={() => setExpanded(false)}>
								<X />
							</Button>
						</div>
					</div>
					<div className={cn('entry-image-viewer-stage', zoomed && 'is-zoomed')}>
						<div key={current.key} className="entry-image-viewer-picture">
							{current.image}
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

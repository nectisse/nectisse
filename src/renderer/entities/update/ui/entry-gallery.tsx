import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { ChevronLeft, ChevronRight, Download, LoaderCircle, X } from 'lucide-react';
import type { ImageSaveReply } from '@shared/subscriptions';
import { Button } from '@/shared/ui/button';
import { DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/shared/ui/dialog';
import { toast } from '@/shared/ui/sonner';

export type EntryMedia = { key: string; image: ReactNode; thumbnail: ReactNode; label: string };

export function EntryGallery({ media, onPreview }: { media: EntryMedia[]; onPreview: (index: number) => void }): React.JSX.Element | null {
	return media.length ? (
		<div className="entry-detail-media" aria-label="帖子图片">
			{media.map((picture, index) => (
				<Button key={picture.key} variant="media" size="media" aria-label={`预览第 ${index + 1} 张图片`} onClick={() => onPreview(index)}>
					{picture.thumbnail}
				</Button>
			))}
		</div>
	) : null;
}

export function EntryImageViewer({
	media,
	index,
	onIndexChange,
	author,
	avatar,
	source,
	category,
	loading,
	warning,
	onRetry,
	onSave,
	onClose,
	returnFocus,
}: {
	media: EntryMedia[];
	index: number;
	onIndexChange: (index: number) => void;
	author: string;
	avatar?: ReactNode;
	source: string;
	category: string;
	loading?: boolean;
	warning?: string;
	onRetry: () => void;
	onSave: (index: number) => Promise<ImageSaveReply>;
	onClose: () => void;
	returnFocus: RefObject<HTMLElement | null>;
}): React.JSX.Element {
	const [saving, setSaving] = useState(false);
	const close = useRef<HTMLButtonElement>(null);
	const active = Math.max(0, Math.min(index, media.length - 1));
	const current = media[active];

	const change = (next: number): void => {
		onIndexChange(Math.max(0, Math.min(media.length - 1, next)));
	};

	const save = async (): Promise<void> => {
		if (saving || !current) {
			return;
		}
		setSaving(true);
		try {
			const reply = await onSave(active);
			if (!reply.cancelled) {
				if (reply.ok) {
					toast.success('图片已保存');
				} else {
					toast.error(reply.message ?? '图片未能保存，请重试');
				}
			}
		} catch {
			toast.error('图片未能保存，请重试');
		} finally {
			setSaving(false);
		}
	};

	return (
		<DialogContent
			fullScreen
			className="entry-image-viewer"
			overlayClassName="entry-image-overlay"
			initialFocus={close}
			finalFocus={() => (returnFocus.current?.isConnected ? returnFocus.current : document.getElementById('page-heading'))}
			onKeyDown={(event) => {
				if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
					event.preventDefault();
					change(active + (event.key === 'ArrowLeft' ? -1 : 1));
				}
			}}
		>
			<DialogTitle className="sr-only">{author}的图片</DialogTitle>
			<DialogDescription className="sr-only">{current?.label ?? '图片预览'}。使用左右方向键切换图片，Esc 返回，可保存当前原图。</DialogDescription>
			<div className="entry-image-viewer-toolbar">
				<div className="entry-image-viewer-identity">
					{avatar}
					<div>
						<strong>{author}</strong>
						<span>
							{source} · {category}
						</span>
					</div>
				</div>
				<span className="entry-image-viewer-position" aria-live="polite">
					{current ? active + 1 : 0} / {media.length}
				</span>
				<div className="entry-image-viewer-actions">
					<Button variant="ghost" size="sm" disabled={saving || !current} aria-busy={saving} aria-label="保存当前图片" onClick={() => void save()}>
						{saving ? <LoaderCircle className="spin" /> : <Download />}
						<span>{saving ? '正在准备…' : '保存图片'}</span>
					</Button>
					<span className="entry-image-viewer-divider" />
					<DialogClose render={<Button ref={close} variant="ghost" size="icon" aria-label="关闭图片预览" />}>
						<X />
					</DialogClose>
				</div>
			</div>
			{media.length > 1 && (
				<Button variant="media" size="media" className="entry-image-viewer-previous" disabled={active === 0} aria-label="上一张图片" onClick={() => change(active - 1)}>
					<ChevronLeft />
				</Button>
			)}
			<div
				className="entry-image-viewer-stage"
				onClick={(event) => {
					if (event.target === event.currentTarget) {
						onClose();
					}
				}}
			>
				<div key={current?.key} className="entry-image-viewer-picture">
					{current?.image ?? <span className="entry-image-viewer-empty">{loading ? '正在获取图片…' : '暂无可预览的图片'}</span>}
				</div>
			</div>
			{media.length > 1 && (
				<Button
					variant="media"
					size="media"
					className="entry-image-viewer-next"
					disabled={active === media.length - 1}
					aria-label="下一张图片"
					onClick={() => change(active + 1)}
				>
					<ChevronRight />
				</Button>
			)}
			<div className="entry-image-viewer-footer">
				{loading && <span role="status">正在补齐这条动态的图片…</span>}
				{warning && (
					<div className="entry-image-viewer-warning" role="status">
						<span>{warning}</span>
						<Button variant="text" size="text" onClick={onRetry}>
							重新获取
						</Button>
					</div>
				)}
				<p>{media.length > 1 ? '方向键切换图片 · Esc 返回' : 'Esc 返回'}</p>
			</div>
		</DialogContent>
	);
}

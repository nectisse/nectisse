import { useState, type ReactNode } from 'react';
import { Check, ImageOff, Images, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { cn } from '@/shared/lib/utils';

// 超长图片最多展示两倍宽度的高度，详情仍显示完整图片。
const MIN_CARD_IMAGE_RATIO = 1 / 2;

export function FeedImage({
	src,
	unavailable = '来源无图',
	alt,
	loading = 'lazy',
	showLoading = false,
}: {
	src?: string;
	unavailable?: string;
	alt: string;
	loading?: 'eager' | 'lazy';
	showLoading?: boolean;
}): React.JSX.Element {
	const [failedSrc, setFailedSrc] = useState('');
	const [loadedSrc, setLoadedSrc] = useState('');
	return src && failedSrc !== src ? (
		<>
			<img src={src} alt={alt} loading={loading} decoding="async" onLoad={() => setLoadedSrc(src)} onError={() => setFailedSrc(src)} />
			{showLoading && loadedSrc !== src && (
				<span className="feed-image-loading" role="status">
					正在加载图片…
				</span>
			)}
		</>
	) : (
		<span className="feed-image-placeholder" role="img" aria-label={src ? '封面不可用' : unavailable}>
			{src ? <ImageOff strokeWidth={1.4} /> : <ImageIcon strokeWidth={1.4} />}
			<span>{src ? '封面不可用' : unavailable}</span>
		</span>
	);
}

export function FeedItem({
	title,
	accessibleTitle = title ?? '来源内容',
	summary,
	author,
	source,
	category,
	code,
	flags = [],
	read,
	image,
	imageKey,
	imageAspectRatio,
	mediaCount = 0,
	published,
	discovered,
	onOpen,
	onRead,
	onAuthor,
	onCode,
	className,
	itemId,
	presentation = 'list',
}: {
	title?: string;
	accessibleTitle?: string;
	summary: string;
	author: string;
	source: string;
	category: string;
	code?: string;
	flags?: { label: string; warning?: boolean }[];
	read: boolean;
	image?: ReactNode;
	imageKey?: string;
	imageAspectRatio?: number;
	mediaCount?: number;
	published: ReactNode;
	discovered?: ReactNode;
	onOpen: () => void;
	onRead: () => void;
	onAuthor?: () => void;
	onCode?: () => void;
	className?: string;
	itemId?: string;
	presentation?: 'list' | 'cards';
}): React.JSX.Element {
	const [loadedImage, setLoadedImage] = useState<{ key: string | undefined; ratio: number }>();
	const knownRatio = imageAspectRatio && Number.isFinite(imageAspectRatio) && imageAspectRatio > 0 ? imageAspectRatio : 16 / 9;
	const ratio = loadedImage && loadedImage.key === imageKey ? loadedImage.ratio : knownRatio;
	const natural = presentation === 'cards';
	const thumbnail = image && (
		<Button
			variant="media"
			size="media"
			className="feed-item-thumbnail"
			style={natural ? { aspectRatio: Math.max(ratio, MIN_CARD_IMAGE_RATIO) } : undefined}
			onLoadCapture={
				natural
					? (event) => {
							const target = event.target;
							if (target instanceof HTMLImageElement && target.naturalWidth > 0 && target.naturalHeight > 0) {
								setLoadedImage({ key: imageKey, ratio: target.naturalWidth / target.naturalHeight });
							}
						}
					: undefined
			}
			onClick={onOpen}
			aria-label={`查看封面与内容：${accessibleTitle}`}
		>
			{image}
			{mediaCount > 1 && (
				<span className="feed-item-image-count" aria-label={`${mediaCount} 张图片`}>
					<Images />
					{mediaCount}
				</span>
			)}
			{natural && ratio < MIN_CARD_IMAGE_RATIO && (
				<Badge variant="secondary" className="feed-item-long-image">
					长图
				</Badge>
			)}
		</Button>
	);

	return (
		<article className={cn('feed-item', read && 'is-read', className)} data-post-id={itemId} data-read={read}>
			{presentation === 'list' && thumbnail}
			<div className="feed-item-content">
				<div className="feed-item-meta">
					<span className="sr-only">{read ? '已读' : '未读'}</span>
					{onAuthor ? (
						<Button variant="text" size="text" className="feed-item-author" title={author} onClick={onAuthor}>
							{author}
						</Button>
					) : (
						<span className="feed-item-author" title={author}>
							{author}
						</span>
					)}
					<span className="feed-item-source" title={source}>
						{source}
					</span>
					<Badge variant="secondary" className="feed-item-category">
						{category}
					</Badge>
					{flags.map((flag) => (
						<span key={flag.label} className={cn('feed-item-flag', flag.warning && 'is-warning')}>
							{flag.label}
						</span>
					))}
					<span className="feed-item-read-dot" aria-hidden="true" />
				</div>
				{title ? (
					<>
						<h2 className="feed-item-heading">
							<Button variant="text" size="text" className="feed-item-title" onClick={onOpen} aria-label={accessibleTitle}>
								<span>{title}</span>
							</Button>
						</h2>
						<p className="feed-item-summary">{summary}</p>
					</>
				) : (
					<Button variant="text" size="text" className="feed-item-summary" onClick={onOpen} aria-label={accessibleTitle}>
						{summary}
					</Button>
				)}
				{presentation === 'cards' && thumbnail}
				<div className="feed-item-footer">
					<div className="feed-item-dates">
						{code && (
							<Button variant="text" size="text" className="feed-item-code" aria-label={`查询 ${code} 资料`} onClick={onCode}>
								{code}
							</Button>
						)}
						{published}
						{discovered}
					</div>
					<Button variant="ghost" size="xs" className="feed-item-read" onClick={onRead}>
						<Check />
						{read ? '标为未读' : '标为已读'}
					</Button>
				</div>
			</div>
		</article>
	);
}

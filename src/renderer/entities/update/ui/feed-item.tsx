import { useState, type ReactNode } from 'react';
import { Check, ImageOff, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { cn } from '@/shared/lib/utils';

export function FeedImage({ src, unavailable = '来源无图', alt }: { src?: string; unavailable?: string; alt: string }): React.JSX.Element {
	const [failedSrc, setFailedSrc] = useState('');
	return src && failedSrc !== src ? (
		<img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />
	) : (
		<span className="feed-image-placeholder" role="img" aria-label={src ? '封面不可用' : unavailable}>
			{src ? <ImageOff strokeWidth={1.4} /> : <ImageIcon strokeWidth={1.4} />}
			<span>{src ? '封面不可用' : unavailable}</span>
		</span>
	);
}

export function FeedItem({
	title,
	accessibleTitle = title,
	summary,
	author,
	source,
	category,
	code,
	flags = [],
	read,
	image,
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
	title: string;
	accessibleTitle?: string;
	summary: string;
	author: string;
	source: string;
	category: string;
	code?: string;
	flags?: { label: string; warning?: boolean }[];
	read: boolean;
	image?: ReactNode;
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
	const thumbnail = image && (
		<Button variant="media" size="media" className="feed-item-thumbnail" onClick={onOpen} aria-label={`查看封面与内容：${accessibleTitle}`}>
			{image}
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
				<h2 className="feed-item-heading">
					<Button variant="text" size="text" className="feed-item-title" onClick={onOpen} aria-label={accessibleTitle}>
						<span>{title}</span>
					</Button>
				</h2>
				<p className="feed-item-summary">{summary}</p>
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

import type { ReactNode, RefObject } from 'react';
import { Check, ExternalLink, X } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/shared/ui/dialog';
import { EntryGallery, type EntryMedia } from './entry-gallery';

export function UpdateDetailDialog({
	onClose,
	title,
	author,
	avatar,
	source,
	category,
	code,
	media,
	onPreview,
	published,
	loading,
	warning,
	onRetry,
	summary,
	notice,
	onOpenSource,
	onWork,
	returnFocus,
}: {
	onClose: () => void;
	title?: string;
	author: string;
	avatar?: ReactNode;
	source: string;
	category: string;
	code?: string;
	media: EntryMedia[];
	onPreview: (index: number) => void;
	published?: ReactNode;
	loading?: boolean;
	warning?: string;
	onRetry?: () => void;
	summary: string;
	notice?: string;
	onOpenSource: () => void;
	onWork?: () => void;
	returnFocus: RefObject<HTMLElement | null>;
}): React.JSX.Element {
	return (
		<DialogContent className="entry-dialog" finalFocus={() => (returnFocus.current?.isConnected ? returnFocus.current : document.getElementById('page-heading'))}>
			<div className="entry-dialog-bar">
				{avatar}
				<div className="entry-dialog-identity">
					<span className="entry-dialog-author">{author}</span>
					<div>
						<span>{source}</span>
						<Badge variant="secondary">{category}</Badge>
						{code && <code>{code}</code>}
					</div>
				</div>
				<DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭对话框" />}>
					<X />
				</DialogClose>
			</div>
			<div className="entry-dialog-scroll" tabIndex={0} role="region" aria-label="更新详情内容">
				<DialogDescription className="sr-only">
					{author} · {source}，来源条目与已取得的摘要。
				</DialogDescription>
				<DialogTitle className={title ? 'entry-dialog-title' : 'sr-only'}>{title || `${author}的动态`}</DialogTitle>
				{(summary.trim() || notice) && (
					<section className="entry-dialog-summary">
						<p className={!summary ? 'is-empty' : undefined}>{summary || '来源未提供摘要'}</p>
						{notice && <p className="entry-dialog-notice">{notice}</p>}
					</section>
				)}
				<EntryGallery media={media} onPreview={onPreview} />
				{loading && (
					<p className="entry-dialog-status" role="status">
						正在补取这条动态的完整图片…
					</p>
				)}
				{warning && (
					<div className="entry-dialog-status" role="status">
						<span>{warning}</span>
						{onRetry && (
							<Button variant="text" size="text" onClick={onRetry}>
								重新获取
							</Button>
						)}
					</div>
				)}
			</div>
			<div className="entry-dialog-footer">
				<div className="entry-dialog-published">{published}</div>
				<Button variant="outline" size="sm" onClick={onOpenSource}>
					查看原文
					<ExternalLink />
				</Button>
				{code && onWork ? (
					<Button size="sm" onClick={onWork}>
						查询 {code} 资料
					</Button>
				) : (
					<Button size="sm" onClick={onClose}>
						<Check />
						完成阅读
					</Button>
				)}
			</div>
		</DialogContent>
	);
}

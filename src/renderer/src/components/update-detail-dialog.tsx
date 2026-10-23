import type { ReactNode, RefObject } from 'react';
import { Check, ExternalLink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

export function UpdateDetailDialog({
	open,
	onClose,
	title,
	author,
	avatar,
	source,
	category,
	code,
	image,
	details,
	summary,
	notice,
	onOpenSource,
	onWork,
	returnFocus,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	author: string;
	avatar?: ReactNode;
	source: string;
	category: string;
	code?: string;
	image: ReactNode;
	details: { label: string; value: ReactNode }[];
	summary: string;
	notice?: string;
	onOpenSource: () => void;
	onWork?: () => void;
	returnFocus: RefObject<HTMLElement | null>;
}): React.JSX.Element {
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
		>
			<DialogContent className="entry-dialog" finalFocus={() => (returnFocus.current?.isConnected ? returnFocus.current : document.getElementById('page-heading'))}>
				<div className="entry-dialog-bar">
					<Badge variant="secondary">{category}</Badge>
					<span>{source}</span>
					{code && <code>{code}</code>}
					<DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭对话框" />}>
						<X />
					</DialogClose>
				</div>
				<div className="entry-dialog-scroll" tabIndex={0} role="region" aria-label="更新详情内容">
					<DialogDescription className="sr-only">
						{author} · {source}，来源条目与已取得的摘要。
					</DialogDescription>
					<div className="entry-detail-image">{image}</div>
					<DialogTitle className="entry-dialog-title">{title}</DialogTitle>
					<div className="entry-dialog-byline">
						{avatar}
						<span>{author}</span>
					</div>
					<dl className="entry-dialog-facts">
						{details.map((detail) => (
							<div key={detail.label}>
								<dt>{detail.label}</dt>
								<dd>{detail.value}</dd>
							</div>
						))}
					</dl>
					{(summary.trim() || notice) && (
						<section className="entry-dialog-summary">
							<h3>来源摘要</h3>
							<p className={!summary ? 'is-empty' : undefined}>{summary || '来源未提供摘要'}</p>
							{notice && <p className="entry-dialog-notice">{notice}</p>}
						</section>
					)}
				</div>
				<div className="entry-dialog-footer">
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
		</Dialog>
	);
}

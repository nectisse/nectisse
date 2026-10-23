import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { Check, ExternalLink, Maximize2, Minimize2, X } from 'lucide-react';
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
	summaryLabel = '来源摘要',
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
	summaryLabel?: string;
	notice?: string;
	onOpenSource: () => void;
	onWork?: () => void;
	returnFocus: RefObject<HTMLElement | null>;
}): React.JSX.Element {
	const [imageLoaded, setImageLoaded] = useState(false);
	const [imageExpanded, setImageExpanded] = useState(false);
	useEffect(() => {
		setImageLoaded(false);
		setImageExpanded(false);
	}, [open, title]);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
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
					<DialogTitle className="entry-dialog-title">{title}</DialogTitle>
					<DialogDescription className="sr-only">
						{author} · {source}，来源条目与已取得的摘要。
					</DialogDescription>
					<div className="entry-dialog-byline">
						{avatar}
						<span>{author}</span>
					</div>
					<div className="entry-dialog-overview" data-image-expanded={imageExpanded && imageLoaded}>
						<div className="entry-dialog-media">
							<div
								className="entry-detail-image"
								onLoadCapture={() => setImageLoaded(true)}
								onErrorCapture={() => {
									setImageLoaded(false);
									setImageExpanded(false);
								}}
							>
								{image}
							</div>
							{imageLoaded && (
								<Button
									variant="ghost"
									size="xs"
									className="entry-dialog-image-toggle"
									aria-expanded={imageExpanded}
									onClick={() => setImageExpanded((previous) => !previous)}
								>
									{imageExpanded ? <Minimize2 /> : <Maximize2 />}
									{imageExpanded ? '收起封面' : '放大封面'}
								</Button>
							)}
						</div>
						<dl className="entry-dialog-facts">
							{details.map((detail) => (
								<div key={detail.label}>
									<dt>{detail.label}</dt>
									<dd>{detail.value}</dd>
								</div>
							))}
						</dl>
					</div>
					<section className="entry-dialog-summary">
						<h3>{summaryLabel}</h3>
						<p className={!summary ? 'is-empty' : undefined}>{summary || '来源未提供摘要'}</p>
						{notice && <p className="entry-dialog-notice">{notice}</p>}
					</section>
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

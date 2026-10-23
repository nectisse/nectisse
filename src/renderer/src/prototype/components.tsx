import type { ReactNode, RefObject } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Bookmark, Check, ChevronRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState as SharedEmptyState, type EmptyStateAction } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { creatorFor, type Cover, type Creator, type Site, type Tile, type Work } from './data';

export function Avatar({ creator, className }: { creator: Creator; className?: string }): React.JSX.Element {
	return typeof creator.avatar === 'number' ? (
		<span aria-hidden="true" className={cn('avatar photo-avatar', `art-${creator.avatar}`, className)} />
	) : (
		<span aria-hidden="true" className={cn('avatar letter-avatar', creator.id === 'seaside' ? 'sage' : 'mauve', className)}>
			{creator.avatar}
		</span>
	);
}

export function Photo({ tile, className }: { tile: Tile; className?: string }): React.JSX.Element {
	return <span className={cn('art-photo', `art-${tile}`, className)} aria-hidden="true" />;
}

export function Poster({ work, tile = work.tile, text = true, className }: { work: Work; tile?: Tile; text?: boolean; className?: string }): React.JSX.Element {
	return (
		<div className={cn('poster', className)}>
			<Photo tile={tile} />
			{text && (
				<>
					<span className="poster-publisher">{work.publisher}</span>
					<span className="poster-title">
						{work.title.includes('、') ? (
							<>
								{work.title.split('、')[0]}、<br />
								{work.title.split('、')[1]}
							</>
						) : (
							work.title
						)}
						<span className="poster-subtitle">{work.english}</span>
					</span>
					<span className="poster-edition">
						{work.id} / {work.year}
					</span>
				</>
			)}
		</div>
	);
}

export function SourceMark({ source }: { source: Site | string }): React.JSX.Element {
	return (
		<span aria-hidden="true" className={cn('source-mark', source === 'FANBOX' || source === 'Patreon' ? 'peach' : '')}>
			{source === 'r18.dev' ? 'r' : source[0]}
		</span>
	);
}

export function StatusBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'peach' | 'berry' }): React.JSX.Element {
	return (
		<Badge variant="secondary" className={cn('status-badge', `tone-${tone}`)}>
			{children}
		</Badge>
	);
}

export function QuietButton({ children, className, ...props }: React.ComponentProps<typeof Button>): React.JSX.Element {
	return (
		<Button variant="ghost" size="sm" className={cn('quiet-button', className)} {...props}>
			{children}
		</Button>
	);
}

export function ReviewTabs<T extends string>({
	value,
	onChange,
	items,
	label,
	children,
	segmented = false,
}: {
	value: T;
	onChange: (value: T) => void;
	items: readonly { value: T; label: ReactNode }[];
	label: string;
	children?: ReactNode;
	segmented?: boolean;
}): React.JSX.Element {
	return (
		<Tabs
			value={value}
			className="content-tabs"
			onValueChange={(next) => {
				const item = items.find((item) => item.value === next);

				if (item) {
					onChange(item.value);
				}
			}}
		>
			<TabsList variant={segmented ? 'default' : 'line'} aria-label={label} className={cn('review-tabs', segmented && 'segmented-tabs')}>
				{items.map((item) => (
					<TabsTrigger key={item.value} value={item.value}>
						{item.label}
					</TabsTrigger>
				))}
			</TabsList>
			{children !== undefined && (
				<TabsContent value={value} className="review-tab-panel">
					{children}
				</TabsContent>
			)}
		</Tabs>
	);
}

export function ReviewDialog({
	open,
	onClose,
	title,
	description,
	children,
	wide = false,
	returnFocus,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	description: string;
	children: ReactNode;
	wide?: boolean;
	returnFocus: RefObject<HTMLElement | null>;
}): React.JSX.Element {
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!value) {
					onClose();
				}
			}}
		>
			<DialogContent
				className={cn('review-dialog', wide && 'wide-dialog')}
				finalFocus={() => (returnFocus.current?.isConnected ? returnFocus.current : document.getElementById('page-heading'))}
			>
				<div className="dialog-heading">
					<div>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</div>
					<DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭对话框" />}>
						<X />
					</DialogClose>
				</div>
				<div className="dialog-body">{children}</div>
			</DialogContent>
		</Dialog>
	);
}

export function WorkCard({
	work,
	saved,
	onOpen,
	onSave,
	compact = false,
}: {
	work: Work;
	saved: boolean;
	onOpen: () => void;
	onSave: () => void;
	compact?: boolean;
}): React.JSX.Element {
	const creator = creatorFor(work.creatorId);
	return (
		<article className={cn('work-card', compact && 'compact-card')}>
			<div className="card-image">
				<Poster work={work} />
				<Button variant="text" size="text" className="card-open" onClick={onOpen} aria-label={`查看 ${work.title} 作品详情`} />
				<Button
					variant="secondary"
					size="icon-sm"
					className={cn('card-save', saved && 'is-saved')}
					onClick={onSave}
					aria-label={`${saved ? '取消保存' : '保存'} ${work.title}`}
					aria-pressed={saved}
				>
					<Bookmark fill={saved ? 'currentColor' : 'none'} />
				</Button>
			</div>
			<div className="work-code">
				<span>{work.id}</span>
				<span className="match-label">
					<Check size={11} />
					身份匹配示例
				</span>
			</div>
			<h3>
				<Button variant="text" size="text" onClick={onOpen}>
					{work.title}
				</Button>
			</h3>
			<p className="work-byline">
				{creator.name}
				<i />
				{work.year}
				<i />
				摄影作品
			</p>
			{!compact && (
				<div className="card-sources">
					<SourceMark source={work.sources[0] ?? 'DMM'} />
					<span>{work.sources.join(' · ')}</span>
					<span>{work.covers.length} 张封面</span>
				</div>
			)}
		</article>
	);
}

export function CoverChoice({ work, cover, selected, onChoose }: { work: Work; cover: Cover; selected: boolean; onChoose: () => void }): React.JSX.Element {
	return (
		<div className={cn('cover-candidate', selected && 'selected')}>
			<Poster work={work} tile={cover.tile} text={false} />
			<h3>{cover.title}</h3>
			<p>
				{cover.dimensions} · {cover.source}
			</p>
			<StatusBadge tone={cover.matched ? 'success' : 'peach'}>{cover.matched ? '身份匹配示例' : '未互证'}</StatusBadge>
			<Button variant={selected ? 'default' : 'outline'} size="sm" onClick={onChoose} aria-pressed={selected}>
				{selected && <Check />}
				{selected ? '当前封面' : '选择此封面'}
			</Button>
		</div>
	);
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: EmptyStateAction }): React.JSX.Element {
	return <SharedEmptyState icon={Check} title={title} description={children} action={action} />;
}

export function ArrowLink({ children, onClick }: { children: ReactNode; onClick: () => void }): React.JSX.Element {
	return (
		<QuietButton onClick={onClick}>
			{children}
			<ChevronRight />
		</QuietButton>
	);
}

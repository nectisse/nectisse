import { isPerformerProvider } from '@shared/sources';
import { useSubscriptions, useDesktopActions } from '@/shared/desktop';
import { feedDate, formatTimestamp as date } from '@/shared/lib/format-date';
import { useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';

import { EmptyState } from '@/shared/components/empty-state';
import { Masonry } from '@/shared/ui/masonry';

import { FeedImage, FeedItem } from './feed-item';
import { UpdateDetailDialog } from './update-detail-dialog';

import type { FeedEntry } from '@shared/subscriptions';
import { IdentityAvatar } from '@/entities/subscription';

import { SOURCE_LABELS } from '@shared/sources';

const providerName = (value: import('@shared/subscriptions').FollowProvider): string => SOURCE_LABELS[value];

function feedTitle(entry: FeedEntry): string {
	const title = entry.title || '来源未提供标题';
	if (entry.code && title.startsWith(entry.code) && /^[\s·|:：-]/.test(title.slice(entry.code.length))) {
		return title.slice(entry.code.length).replace(/^[\s·|:：-]+/, '') || title;
	}
	return title;
}

function entryCategory(entry: FeedEntry): string {
	return isPerformerProvider(entry.provider)
		? '演员新作'
		: entry.provider === 'x'
			? '原创动态'
			: ['kemono', 'pawchive', 'coomer'].includes(entry.provider)
				? '归档收录'
				: '创作者动态';
}

function EntryImage({ entry, variant = 'thumbnail' }: { entry: FeedEntry; variant?: 'thumbnail' | 'original' }): React.JSX.Element {
	const { imageUrl } = useDesktopActions();
	const state = useSubscriptions((state) => ({ preferences: state.preferences, sources: state.sources, subscriptions: state.subscriptions }));
	const sub = state.subscriptions.find((sub) => sub.id === entry.subscriptionId);
	const status = entry.imageCache?.status;
	const paused = !sub?.following || !sub.enabled || sub.autoPaused || !state.preferences.enabledSources.includes(entry.provider);
	const cooling = state.sources.some((source) => source.id === entry.provider && source.cooldownUntil > Date.now());
	const unavailable = !entry.thumbnailUrl
		? '来源无图'
		: status === 'failed'
			? '封面未取得'
			: status === 'cancelled'
				? '缓存已取消'
				: status === 'evicted'
					? '缓存已清理'
					: paused
						? '缓存已暂停'
						: status === 'loading'
							? '正在缓存'
							: status === 'retry' || cooling
								? '等待重试'
								: '排队缓存';
	return (
		<FeedImage
			key={`${entry.imageAsset?.sha256 ?? ''}:${status ?? ''}`}
			src={entry.thumbnailUrl ? imageUrl('updates', entry.id, variant) : undefined}
			unavailable={unavailable}
			alt={`${entry.title || '来源内容'} · 来源封面`}
		/>
	);
}

export function EntryList({
	entries,
	onWork,
	presentation = 'list',
	onPerson,
}: {
	entries: FeedEntry[];
	onWork: (code: string) => void;
	presentation?: 'list' | 'cards';
	onPerson?: (id: string) => void;
}): React.JSX.Element {
	const state = useSubscriptions((state) => ({ entries: state.entries, subscriptions: state.subscriptions }));
	const { invoke } = useDesktopActions();
	const [selection, setSelected] = useState<FeedEntry>();
	const selected = state.entries.find((entry) => entry.id === selection?.id) ?? selection;
	const returnFocus = useRef<HTMLElement | null>(null);
	const Layout = presentation === 'cards' ? Masonry : 'div';

	const open = (entry: FeedEntry): void => {
		returnFocus.current = document.activeElement as HTMLElement;
		setSelected(entry);
		void invoke({ action: 'read', ids: [entry.id], read: true });
	};

	return (
		<>
			{entries.length ? (
				<Layout className="feed-items real-feed-list" data-presentation={presentation}>
					{entries.map((entry) => (
						<FeedItem
							key={entry.id}
							presentation={presentation}
							itemId={entry.id}
							className="real-feed-entry"
							title={entry.provider === 'x' ? undefined : feedTitle(entry)}
							accessibleTitle={entry.title || '来源未提供标题'}
							summary={entry.summary || (entry.restricted ? '来源未提供可见摘要' : '来源未提供摘要')}
							author={entry.name}
							source={providerName(entry.provider)}
							category={entryCategory(entry)}
							code={entry.code}
							flags={[...(entry.initial ? [{ label: '初次收录' }] : []), ...(entry.restricted ? [{ label: '正文受限', warning: true }] : [])]}
							read={entry.read}
							image={presentation === 'cards' && !entry.thumbnailUrl && !entry.imageAsset ? undefined : <EntryImage entry={entry} />}
							published={
								<span
									title={
										entry.publishedAt
											? `${isPerformerProvider(entry.provider) ? '发行日期' : '发布时间'}：${entry.publishedPrecision === 'date' || isPerformerProvider(entry.provider) ? feedDate(entry.publishedAt, true) : date(entry.publishedAt)}${entry.publishedPrecision === 'approximate' ? '（估算）' : ''}`
											: '来源未提供日期'
									}
								>
									{isPerformerProvider(entry.provider) ? '发行' : '发布'}{' '}
									<time dateTime={entry.publishedAt || undefined}>
										{feedDate(entry.publishedAt, isPerformerProvider(entry.provider) || entry.publishedPrecision === 'date')}
									</time>
									{entry.publishedPrecision === 'approximate' ? '（约）' : ''}
								</span>
							}
							discovered={
								<span title={`发现时间：${date(entry.firstSeenAt)}`}>
									发现 <time dateTime={entry.firstSeenAt}>{feedDate(entry.firstSeenAt)}</time>
								</span>
							}
							onOpen={() => open(entry)}
							onRead={() => {
								void invoke({ action: 'read', ids: [entry.id], read: !entry.read });
							}}
							onCode={() => onWork(entry.code)}
							onAuthor={onPerson ? () => onPerson(entry.subscriptionId) : undefined}
						/>
					))}
				</Layout>
			) : (
				<EmptyState icon={Sparkles} title="还没有可显示的内容" description="关注并完成检查后，来源实际提供的动态或目录会出现在这里。" />
			)}
			<UpdateDetailDialog
				open={!!selected}
				onClose={() => setSelected(undefined)}
				title={selected?.provider === 'x' ? undefined : selected?.title || '来源内容'}
				author={selected?.name || ''}
				avatar={selected && <IdentityAvatar identity={state.subscriptions.find((sub) => sub.id === selected.subscriptionId) ?? { name: selected.name }} small />}
				source={selected ? providerName(selected.provider) : ''}
				category={selected ? entryCategory(selected) : ''}
				code={selected?.code}
				image={selected && <EntryImage key={selected.id} entry={selected} variant="original" />}
				details={
					selected
						? [
								{
									label: isPerformerProvider(selected.provider) ? '发行日期' : '发布时间',
									value: (
										<time dateTime={selected.publishedAt || undefined}>
											{feedDate(selected.publishedAt, isPerformerProvider(selected.provider) || selected.publishedPrecision === 'date')}
											{selected.publishedPrecision === 'approximate' ? '（估算）' : ''}
										</time>
									),
								},
								{ label: '来源页面', value: <span title={selected.url}>{new URL(selected.url).hostname}</span> },
								{ label: '发现时间', value: <time dateTime={selected.firstSeenAt}>{date(selected.firstSeenAt)}</time> },
							]
						: []
				}
				summary={isPerformerProvider(selected?.provider) ? '' : selected?.summary || ''}
				notice={
					isPerformerProvider(selected?.provider)
						? undefined
						: selected?.restricted
							? '仅显示来源公开提供的内容。'
							: selected?.partial
								? '完整正文尚未取得，可查看原文。'
								: undefined
				}
				onOpenSource={() => {
					if (selected) {
						void invoke({ action: 'open', kind: 'entry', id: selected.id });
					}
				}}
				onWork={
					selected?.code
						? () => {
								onWork(selected.code);
								setSelected(undefined);
							}
						: undefined
				}
				returnFocus={returnFocus}
			/>
		</>
	);
}

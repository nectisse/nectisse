import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BellPlus, Check, ExternalLink, LoaderCircle, Pause, Play, RefreshCw, Sparkles, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { EmptyState } from '@/components/empty-state';
import { PageHeader, PageToolbar } from '@/components/page-layout';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { OptionSelect } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { FeedImage, FeedItem } from '@/components/feed-item';
import { UpdateDetailDialog } from '@/components/update-detail-dialog';
import { ReviewTabs, StatusBadge } from '../prototype/components';
import type { FollowProvider, Subscription, FeedEntry } from '../../../shared/subscriptions';
import { useSubscriptions } from './context';
import { IdentityAvatar } from './IdentityAvatar';
import { FOLLOW_IDS, SOURCE_LABELS } from '../../../shared/sources';

const providerName = (value: FollowProvider): string => SOURCE_LABELS[value];

const date = (value: string): string => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检查');

export function TaskProgress(): React.JSX.Element | null {
	const { state, invoke } = useSubscriptions();
	const active = state.tasks.find((task) => task.kind !== 'lookup' && ['running', 'cancelling'].includes(task.status));

	return active ? (
		<div className="live-task-progress" role="status">
			<LoaderCircle className="spin" />
			<div>
				<strong>{active.phase}</strong>
				<p>{active.kind === 'covers' ? '自动补齐已收录条目的封面；查询操作优先，取消后需手动重试。' : '限当前来源与对象；停止后保留已取得资料。'}</p>
			</div>
			<Button
				size="sm"
				variant="outline"
				disabled={active.status === 'cancelling'}
				onClick={() => {
					void invoke({ action: 'cancel', id: active.id });
				}}
			>
				<X />
				取消任务
			</Button>
		</div>
	) : null;
}

function SubscriptionRow({ subscription: sub, onOpen }: { subscription: Subscription; onOpen?: (id: string) => void }): React.JSX.Element {
	const { state, invoke } = useSubscriptions();
	const busy = state.tasks.some((task) => task.kind !== 'covers' && ['running', 'cancelling'].includes(task.status));

	const update = async (value: Parameters<typeof invoke>[0]): Promise<void> => {
		const reply = await invoke(value);
		if (reply.ok) {
			toast.success('订阅已更新', { id: `subscription:${sub.id}` });
		} else {
			toast.error(reply.message || '操作失败', { id: `subscription:${sub.id}`, duration: 8000 });
		}
	};

	const status = !sub.following ? '已取消关注' : !sub.enabled ? '已暂停' : sub.autoPaused ? '自动检查已暂停' : '已关注';
	const nextCheck = !sub.following
		? '已取消关注'
		: !sub.enabled || sub.autoPaused
			? '已暂停检查'
			: !state.preferences.automatic
				? '自动检查未启用'
				: sub.nextCheckAt
					? feedDate(sub.nextCheckAt)
					: '等待首次检查';
	return (
		<article className="subscription-card">
			<div className="subscription-overview">
				<div className="subscription-card-head">
					<IdentityAvatar identity={sub} />
					<div className="subscription-identity">
						<div className="subscription-name-line">
							{onOpen ? (
								<Button variant="text" size="text" className="subscription-name" title={sub.name} onClick={() => onOpen(sub.id)}>
									{sub.name}
								</Button>
							) : (
								<h3 className="subscription-name" title={sub.name}>
									{sub.name}
								</h3>
							)}
							<StatusBadge tone={!sub.following ? 'neutral' : !sub.enabled || sub.autoPaused ? 'peach' : 'success'}>{status}</StatusBadge>
						</div>
						<p className="subscription-origin">
							{providerName(sub.provider)} · {sub.recordType} · <span>{sub.ref}</span>
						</p>
						<p className="subscription-coverage" title={sub.coverage}>
							{sub.coverage}
						</p>
					</div>
				</div>
				<dl className="subscription-metrics">
					<div>
						<dt>上次检查</dt>
						<dd title={date(sub.lastCheckedAt)}>{sub.lastCheckedAt ? feedDate(sub.lastCheckedAt) : '尚未检查'}</dd>
					</div>
					<div>
						<dt>下次检查</dt>
						<dd title={sub.nextCheckAt ? date(sub.nextCheckAt) : undefined}>{nextCheck}</dd>
					</div>
					<div>
						<dt>未读</dt>
						<dd className="subscription-unread">
							{sub.unread}
							<span> 条</span>
						</dd>
					</div>
				</dl>
			</div>
			{sub.bio && (
				<p className="subscription-bio" title={sub.bio}>
					{sub.bio}
				</p>
			)}
			{sub.lastError && (
				<p className="subscription-error" role="status">
					{sub.lastError}
				</p>
			)}
			<div className="subscription-actions">
				<Button
					size="sm"
					variant="outline"
					disabled={busy || !sub.following || !sub.enabled || !state.preferences.enabledSources.includes(sub.provider)}
					onClick={() => {
						void update({ action: 'check', id: sub.id });
					}}
				>
					<RefreshCw />
					检查更新
				</Button>
				{sub.following ? (
					<>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								void update({ action: 'update', id: sub.id, enabled: !sub.enabled || sub.autoPaused });
							}}
						>
							{sub.enabled && !sub.autoPaused ? <Pause /> : <Play />}
							{sub.enabled && !sub.autoPaused ? '暂停' : '恢复'}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								void update({ action: 'update', id: sub.id, following: false });
							}}
						>
							取消关注
						</Button>
					</>
				) : (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							void update({ action: 'update', id: sub.id, following: true });
						}}
					>
						重新关注
					</Button>
				)}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						void invoke({ action: 'open', kind: 'subscription', id: sub.id });
					}}
				>
					原主页
					<ExternalLink />
				</Button>
				<div className="subscription-frequency">
					<span>检查频率</span>
					<OptionSelect
						aria-label={`${sub.name} 检查频率`}
						value={sub.intervalMinutes ?? ''}
						onValueChange={(value) => {
							void update({ action: 'update', id: sub.id, intervalMinutes: value === '' ? null : Number(value) });
						}}
						options={[
							{ value: '', label: '使用默认频率' },
							...(sub.provider !== 'javdb' ? [30, 60, 180, 360, 1440] : [360, 720, 1440, 10080]).map((value) => ({
								value,
								label: `每 ${value >= 1440 ? `${value / 1440} 天` : value >= 60 ? `${value / 60} 小时` : `${value} 分钟`}`,
							})),
						]}
					/>
				</div>
			</div>
		</article>
	);
}

type SubscriptionKind = 'actors' | 'creators';

export function SubscriptionList({
	onAdd,
	onOpen,
	showHeading = true,
	kind: controlledKind,
	onKindChange,
}: {
	onAdd: (provider?: FollowProvider) => void;
	onOpen?: (id: string) => void;
	showHeading?: boolean;
	kind?: SubscriptionKind;
	onKindChange?: (kind: SubscriptionKind) => void;
}): React.JSX.Element {
	const { state } = useSubscriptions();
	const [localKind, setLocalKind] = useState<SubscriptionKind>('actors');
	const [archived, setArchived] = useState(false);
	const kind = controlledKind ?? localKind;

	const setKind = (value: SubscriptionKind): void => {
		setLocalKind(value);
		onKindChange?.(value);
	};

	const list = state.subscriptions.filter((sub) => (kind === 'actors' ? sub.provider === 'javdb' : sub.provider !== 'javdb') && (archived || sub.following));

	return (
		<section className="subscription-list">
			{showHeading && (
				<div className="section-heading">
					<h2>
						订阅管理<small>{state.subscriptions.filter((sub) => sub.following).length} 个订阅</small>
					</h2>
					<Button variant="outline" size="sm" onClick={() => onAdd(kind === 'actors' ? 'javdb' : 'fanbox')}>
						<BellPlus />
						添加{kind === 'creators' ? '创作者' : '演员'}
					</Button>
				</div>
			)}
			<PageToolbar
				label="关注列表工具栏"
				actions={
					<Label className="archive-filter">
						<Checkbox checked={archived} onCheckedChange={setArchived} />
						显示已取消关注的订阅
					</Label>
				}
			>
				<ReviewTabs
					segmented
					value={kind}
					onChange={setKind}
					label="订阅类型"
					items={[
						{ value: 'actors', label: '演员新作' },
						{ value: 'creators', label: '创作者动态' },
					]}
				/>
				<span className="page-toolbar-count">{list.length} 个订阅</span>
			</PageToolbar>
			{list.length ? (
				<div className="subscription-cards">
					{list.map((sub) => (
						<SubscriptionRow key={sub.id} subscription={sub} onOpen={onOpen} />
					))}
				</div>
			) : (
				<EmptyState
					icon={Users}
					title={`还没有${kind === 'creators' ? '创作者动态' : '演员新作'}订阅`}
					description={kind === 'creators' ? '添加已接入来源的创作者主页或站点身份，确认后关注。' : '按演员名查询 JavDB，核对演员卡后订阅新作。'}
					action={{ label: '添加关注', onClick: () => onAdd(kind === 'actors' ? 'javdb' : 'fanbox') }}
				/>
			)}
		</section>
	);
}

export function SubscriptionsPage({
	seed,
	onAdd,
	onSettings,
	onWork,
}: {
	seed?: { provider: FollowProvider; query: string; token: number; subscriptionId?: string };
	onAdd: (provider?: FollowProvider) => void;
	onSettings: () => void;
	onWork: (code: string) => void;
}): React.JSX.Element {
	const { state } = useSubscriptions();
	const [selected, setSelected] = useState('');
	const [kind, setKind] = useState<SubscriptionKind>('actors');
	useEffect(() => {
		if (seed) {
			setKind(seed.provider === 'javdb' ? 'actors' : 'creators');
			setSelected(seed.subscriptionId || '');
		}
	}, [seed]);
	useEffect(() => {
		document.querySelector('.page-scroll')?.scrollTo({ top: 0, behavior: 'instant' });
	}, [selected]);
	const sub = state.subscriptions.find((value) => value.id === selected);
	return (
		<div className="page subscriptions-page">
			<PageHeader
				title={sub ? (sub.provider === 'javdb' ? '演员主页' : '创作者主页') : '演员与创作者'}
				description={sub ? `${providerName(sub.provider)} · ${sub.ref}` : '留意演员的新作品，也关注创作者的动态。'}
				actions={
					<>
						{sub ? (
							<Button variant="ghost" size="sm" onClick={() => setSelected('')}>
								<ArrowLeft />
								返回关注列表
							</Button>
						) : (
							<Button variant="outline" size="sm" onClick={onSettings}>
								来源与订阅设置
							</Button>
						)}
						<Button size="sm" onClick={() => onAdd(sub?.provider ?? (kind === 'actors' ? 'javdb' : 'fanbox'))}>
							<BellPlus />
							添加关注
						</Button>
					</>
				}
			/>
			<TaskProgress />
			{sub ? (
				<>
					<SubscriptionRow subscription={sub} />
					<CollectedEntries key={sub.id} subscriptionId={sub.id} onWork={onWork} />
				</>
			) : (
				<SubscriptionList onAdd={onAdd} onOpen={setSelected} showHeading={false} kind={kind} onKindChange={setKind} />
			)}
		</div>
	);
}

function CollectedEntries({ subscriptionId, onWork }: { subscriptionId: string; onWork: (code: string) => void }): React.JSX.Element {
	const { state } = useSubscriptions();
	const entries = state.entries.filter((entry) => entry.subscriptionId === subscriptionId);
	const [page, setPage] = useState(1);
	const pageSize = 20;
	const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
	const currentPage = Math.min(page, pageCount);
	const start = (currentPage - 1) * pageSize;
	const pageEntries = entries.slice(start, start + pageSize);

	useEffect(() => {
		setPage((value) => Math.min(value, pageCount));
	}, [pageCount]);

	const changePage = (value: number): void => {
		setPage(Math.min(Math.max(value, 1), pageCount));
		const heading = document.getElementById('collected-entry-heading');
		heading?.focus({ preventScroll: true });
		heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
	};

	return (
		<section className="collected-entries" aria-labelledby="collected-entry-heading">
			<h2 className="creator-entry-heading" id="collected-entry-heading" tabIndex={-1}>
				已收录内容<span>{entries.length} 条</span>
			</h2>
			<EntryList entries={pageEntries} onWork={onWork} />
			{entries.length > 0 && (
				<footer className="collected-pagination">
					<p role="status" aria-live="polite">
						第 {start + 1}–{start + pageEntries.length} 条，共 {entries.length} 条<span>每页 {pageSize} 条</span>
					</p>
					<Pagination label="已收录内容分页" page={currentPage} pageCount={pageCount} onPageChange={changePage} />
				</footer>
			)}
		</section>
	);
}

function feedDate(value: string, dateOnly = false): string {
	if (!value) {
		return '未提供';
	}
	if (dateOnly) {
		const calendarDate = value.match(/^(\d{4})[-./](\d{2})[-./](\d{2})/);
		if (calendarDate) {
			return `${calendarDate[1]}/${calendarDate[2]}/${calendarDate[3]}`;
		}
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.valueOf())
		? '未提供'
		: parsed.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', ...(!dateOnly && { hour: '2-digit', minute: '2-digit' }), hour12: false });
}

function feedTitle(entry: FeedEntry): string {
	const title = entry.title || '来源未提供标题';
	if (entry.code && title.startsWith(entry.code) && /^[\s·|:：-]/.test(title.slice(entry.code.length))) {
		return title.slice(entry.code.length).replace(/^[\s·|:：-]+/, '') || title;
	}
	return title;
}

function entryCategory(entry: FeedEntry): string {
	return entry.provider === 'javdb'
		? '演员新作'
		: ['kemono', 'pawchive', 'coomer'].includes(entry.provider)
			? '归档收录'
			: entry.provider === 'rule34video'
				? '作者关联发布'
				: '创作者动态';
}

function EntryImage({ entry }: { entry: FeedEntry }): React.JSX.Element {
	const { state } = useSubscriptions();
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
			src={entry.imageAsset ? `nectisse-cover://updates/${entry.imageAsset.sha256}` : undefined}
			unavailable={unavailable}
			alt={`${entry.title || '来源内容'} · 来源封面`}
		/>
	);
}

export function EntryList({ entries, onWork }: { entries: FeedEntry[]; onWork: (code: string) => void }): React.JSX.Element {
	const { state, invoke } = useSubscriptions();
	const [selection, setSelected] = useState<FeedEntry>();
	const selected = state.entries.find((entry) => entry.id === selection?.id) ?? selection;
	const returnFocus = useRef<HTMLElement | null>(null);

	const open = (entry: FeedEntry): void => {
		returnFocus.current = document.activeElement as HTMLElement;
		setSelected(entry);
		void invoke({ action: 'read', ids: [entry.id], read: true });
	};

	return (
		<>
			{entries.length ? (
				<div className="feed-items real-feed-list">
					{entries.map((entry) => (
						<FeedItem
							key={entry.id}
							itemId={entry.id}
							className="real-feed-entry"
							title={feedTitle(entry)}
							accessibleTitle={entry.title || '来源未提供标题'}
							summary={entry.summary || (entry.restricted ? '来源未提供可见摘要' : '来源未提供摘要')}
							author={entry.name}
							source={providerName(entry.provider)}
							category={entryCategory(entry)}
							code={entry.code}
							flags={[...(entry.initial ? [{ label: '初次收录' }] : []), ...(entry.restricted ? [{ label: '正文受限', warning: true }] : [])]}
							read={entry.read}
							image={<EntryImage entry={entry} />}
							published={
								<span
									title={
										entry.publishedAt
											? `${entry.provider === 'javdb' ? '发行日期' : '发布时间'}：${entry.publishedPrecision === 'date' || entry.provider === 'javdb' ? feedDate(entry.publishedAt, true) : date(entry.publishedAt)}${entry.publishedPrecision === 'approximate' ? '（估算）' : ''}`
											: '来源未提供日期'
									}
								>
									{entry.provider === 'javdb' ? '发行' : '发布'}{' '}
									<time dateTime={entry.publishedAt || undefined}>
										{feedDate(entry.publishedAt, entry.provider === 'javdb' || entry.publishedPrecision === 'date')}
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
						/>
					))}
				</div>
			) : (
				<EmptyState icon={Sparkles} title="还没有可显示的内容" description="关注并完成检查后，来源实际提供的动态或目录会出现在这里。" />
			)}
			<UpdateDetailDialog
				open={!!selected}
				onClose={() => setSelected(undefined)}
				title={selected?.title || '来源内容'}
				author={selected?.name || ''}
				avatar={selected && <IdentityAvatar identity={state.subscriptions.find((sub) => sub.id === selected.subscriptionId) ?? { name: selected.name }} small />}
				source={selected ? providerName(selected.provider) : ''}
				category={selected ? entryCategory(selected) : ''}
				code={selected?.code}
				image={selected && <EntryImage key={selected.id} entry={selected} />}
				details={
					selected
						? [
								{
									label: selected.provider === 'javdb' ? '发行日期' : '发布时间',
									value: (
										<time dateTime={selected.publishedAt || undefined}>
											{feedDate(selected.publishedAt, selected.provider === 'javdb' || selected.publishedPrecision === 'date')}
											{selected.publishedPrecision === 'approximate' ? '（估算）' : ''}
										</time>
									),
								},
								{ label: '来源页面', value: <span title={selected.url}>{new URL(selected.url).hostname}</span> },
								{ label: '发现时间', value: <time dateTime={selected.firstSeenAt}>{date(selected.firstSeenAt)}</time> },
							]
						: []
				}
				summary={selected?.provider === 'javdb' ? '' : selected?.summary || ''}
				notice={
					selected?.provider === 'javdb'
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

export function UpdatesPage({ onWork, onAdd }: { onWork: (code: string) => void; onAdd: () => void }): React.JSX.Element {
	const { state, invoke } = useSubscriptions();
	const [filter, setFilter] = useState<'unread' | 'all'>('unread');
	const [kind, setKind] = useState('all');
	const [page, setPage] = useState(1);
	const pageSize = 20;
	const entries = state.entries.filter(
		(entry) =>
			(filter === 'all' || !entry.read) &&
			(kind === 'all' || (kind === 'creators' && entry.provider !== 'javdb') || (kind === 'actors' && entry.provider === 'javdb') || entry.provider === kind),
	);
	const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
	const currentPage = Math.min(page, pageCount);
	const start = (currentPage - 1) * pageSize;
	const pageEntries = entries.slice(start, start + pageSize);

	// Reading the last unread items can remove a page while its detail dialog remains open.
	useEffect(() => {
		setPage((value) => Math.min(value, pageCount));
	}, [pageCount]);

	const changePage = (value: number, focusHeading = true): void => {
		setPage(Math.min(Math.max(value, 1), pageCount));
		document.querySelector('.page-scroll')?.scrollTo({ top: 0, behavior: 'instant' });
		if (focusHeading) {
			document.getElementById('page-heading')?.focus({ preventScroll: true });
		}
	};

	const readPage = async (): Promise<void> => {
		const ids = pageEntries.filter((entry) => !entry.read).map((entry) => entry.id);

		if (!ids.length) {
			return;
		}
		const reply = await invoke({ action: 'read', ids, read: true });
		if (reply.ok) {
			toast.success(`已将本页 ${ids.length} 条更新标为已读`, { id: 'updates-read-page' });
		} else {
			toast.error(reply.message || '已读状态未能保存', { id: 'updates-read-page', duration: 8000 });
		}
	};

	return (
		<div className="page real-updates">
			<PageHeader
				title="更新"
				description={`${state.entries.filter((entry) => !entry.read).length} 条未读，来自演员新作与创作者动态。`}
				actions={
					<Button variant="outline" size="sm" onClick={onAdd}>
						<Users />
						管理关注
					</Button>
				}
			/>
			<TaskProgress />
			<PageToolbar
				label="更新工具栏"
				className="updates-toolbar"
				actions={
					<>
						<Button
							variant="ghost"
							size="sm"
							disabled={
								!state.entries.some(
									(entry) => entry.thumbnailUrl && !entry.imageAsset && ['failed', 'cancelled', 'evicted', 'retry'].includes(entry.imageCache?.status ?? ''),
								)
							}
							onClick={() => {
								void invoke({ action: 'retry-images' });
							}}
						>
							<RefreshCw />
							重试未缓存封面
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={!pageEntries.some((entry) => !entry.read)}
							onClick={() => {
								void readPage();
							}}
						>
							<Check />
							本页全部已读
						</Button>
					</>
				}
			>
				<ReviewTabs
					segmented
					value={filter}
					onChange={(value) => {
						setFilter(value);
						changePage(1, false);
					}}
					label="阅读状态"
					items={[
						{ value: 'unread', label: '未读' },
						{ value: 'all', label: '全部' },
					]}
				/>
				<OptionSelect
					className="update-type"
					aria-label="更新类型"
					value={kind}
					onValueChange={(value) => {
						setKind(value);
						changePage(1, false);
					}}
					options={[
						{ value: 'all', label: '所有类型' },
						{ value: 'actors', label: '演员新作' },
						{ value: 'creators', label: '创作者动态' },
						...FOLLOW_IDS.map((id) => ({ value: id, label: SOURCE_LABELS[id] })),
					]}
				/>
				<span className="page-toolbar-count">{entries.length} 条更新</span>
			</PageToolbar>
			<EntryList entries={pageEntries} onWork={onWork} />
			{entries.length > 0 && (
				<footer className="updates-pagination">
					<p role="status" aria-live="polite">
						第 {start + 1}–{start + pageEntries.length} 条，共 {entries.length} 条<span>每页 {pageSize} 条</span>
					</p>
					<Pagination page={currentPage} pageCount={pageCount} onPageChange={changePage} />
				</footer>
			)}
		</div>
	);
}

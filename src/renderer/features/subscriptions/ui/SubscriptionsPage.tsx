import { isPerformerProvider } from '@shared/sources';
import { useSubscriptions, useDesktopActions } from '@/shared/desktop';
import { feedDate, formatTimestamp as date } from '@/shared/lib/format-date';
import { EntryList } from '@/entities/update';
import { TaskProgress, IdentityAvatar } from '@/entities/subscription';
import { useEffect, useState } from 'react';
import { ArrowLeft, BellPlus, ExternalLink, Pause, Play, RefreshCw, Users } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { toast } from '@/shared/ui/sonner';
import { EmptyState } from '@/shared/components/empty-state';
import { PageHeader, PageToolbar } from '@/shared/components/page-layout';
import { Checkbox } from '@/shared/ui/checkbox';
import { Label } from '@/shared/ui/label';
import { OptionSelect } from '@/shared/ui/select';
import { Pagination } from '@/shared/ui/pagination';

import { ContentTabs } from '@/shared/components/content-tabs';
import { StatusBadge } from '@/shared/components/status-badge';
import type { FollowProvider, Subscription } from '@shared/subscriptions';
import { SOURCE_LABELS } from '@shared/sources';

const providerName = (value: FollowProvider): string => SOURCE_LABELS[value];

function SubscriptionRow({ subscription: sub, onOpen }: { subscription: Subscription; onOpen?: (id: string) => void }): React.JSX.Element {
	const state = useSubscriptions((state) => ({ preferences: state.preferences, tasks: state.tasks }));
	const { invoke } = useDesktopActions();
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
							{providerName(sub.provider)} · {sub.recordType} · <span title={sub.ref}>{sub.handle ? `@${sub.handle}` : sub.ref}</span>
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
							...(!isPerformerProvider(sub.provider) ? [30, 60, 180, 360, 1440] : [360, 720, 1440, 10080]).map((value) => ({
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
	const state = useSubscriptions((state) => ({ subscriptions: state.subscriptions }));
	const [localKind, setLocalKind] = useState<SubscriptionKind>('actors');
	const [archived, setArchived] = useState(false);
	const kind = controlledKind ?? localKind;

	const setKind = (value: SubscriptionKind): void => {
		setLocalKind(value);
		onKindChange?.(value);
	};

	const list = state.subscriptions.filter((sub) => (kind === 'actors' ? isPerformerProvider(sub.provider) : !isPerformerProvider(sub.provider)) && (archived || sub.following));

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
				<ContentTabs
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
	const state = useSubscriptions((state) => ({ subscriptions: state.subscriptions }));
	const [selected, setSelected] = useState('');
	const [kind, setKind] = useState<SubscriptionKind>('actors');
	useEffect(() => {
		if (seed) {
			setKind(isPerformerProvider(seed.provider) ? 'actors' : 'creators');
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
				title={sub ? (isPerformerProvider(sub.provider) ? '演员主页' : '创作者主页') : '演员与创作者'}
				description={sub ? `${providerName(sub.provider)} · ${sub.handle ? `@${sub.handle}` : sub.ref}` : '留意演员的新作品，也关注创作者的动态。'}
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
	const state = useSubscriptions((state) => ({ entries: state.entries }));
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

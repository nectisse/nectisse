import { useEffect, useLayoutEffect } from 'react';
import { BellPlus, Search, Settings2, Users } from 'lucide-react';
import type { FollowProvider } from '@shared/subscriptions';
import { isPerformerProvider } from '@shared/sources';
import { TaskProgress } from '@/entities/subscription';
import { useSubscriptions } from '@/shared/desktop';
import type { PeopleScope, PeopleView } from '@/shared/lib/people-navigation';
import { PageHeader, PageToolbar } from '@/shared/components/page-layout';
import { ContentTabs } from '@/shared/components/content-tabs';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Checkbox } from '@/shared/ui/checkbox';
import { PersonCard } from './PersonCard';
import { PersonProfile } from './PersonProfile';
import { SubscriptionRow } from './SubscriptionRow';
import { PeopleArtwork } from './PeopleArtwork';

export function SubscriptionsPage({
	scope,
	view,
	onViewChange,
	onAdd,
	onSettings,
	onWork,
}: {
	scope: PeopleScope;
	view: PeopleView;
	onViewChange: (patch: Partial<PeopleView>) => void;
	onAdd: (provider?: FollowProvider) => void;
	onSettings: () => void;
	onWork: (code: string) => void;
}): React.JSX.Element {
	const subscriptions = useSubscriptions((state) => state.subscriptions.filter((sub) => isPerformerProvider(sub.provider) === (scope === 'actors')));
	const entries = useSubscriptions((state) => state.entries);
	const sub = subscriptions.find((sub) => sub.id === view.selectedId);
	const name = scope === 'actors' ? '演员' : '创作者';
	const defaultProvider = scope === 'actors' ? 'javdb' : 'fanbox';
	const list = subscriptions.filter(
		(sub) =>
			((view.tab === 'manage' && view.archived) || sub.following) &&
			`${sub.name} ${sub.ref} ${sub.handle ?? ''} ${sub.aliases.join(' ')}`.toLowerCase().includes(view.query.toLowerCase()),
	);

	useLayoutEffect(() => {
		document.querySelector('.page-scroll')?.scrollTo({ top: view.selectedId ? 0 : view.scrollTop, behavior: 'instant' });
	}, [scope, view.selectedId]);

	useEffect(() => {
		if (view.selectedId && !sub) {
			onViewChange({ selectedId: '' });
		}
	}, [sub, view.selectedId, onViewChange]);

	const open = (id: string): void => {
		onViewChange({ selectedId: id, scrollTop: document.querySelector('.page-scroll')?.scrollTop ?? 0 });
	};

	if (sub) {
		return <PersonProfile key={sub.id} subscription={sub} onBack={() => onViewChange({ selectedId: '' })} onAdd={onAdd} onWork={onWork} />;
	}

	return (
		<div className="page people-page" data-scope={scope}>
			<div className="people-heading">
				<PeopleArtwork scope={scope} />
				<PageHeader
					title={name}
					description={scope === 'actors' ? '关注熟悉的面孔，留意新的作品。' : '关注创作的人，也关注作品之外的日常。'}
					actions={
						<>
							<Button variant="ghost" size="sm" onClick={onSettings}>
								<Settings2 />
								来源设置
							</Button>
							<Button size="sm" onClick={() => onAdd(defaultProvider)}>
								<BellPlus />
								添加关注
							</Button>
						</>
					}
				/>
			</div>
			<ContentTabs
				value={view.tab}
				onChange={(tab) => onViewChange({ tab })}
				label={`${name}页面`}
				items={[
					{ value: 'browse', label: '浏览' },
					{ value: 'manage', label: '管理' },
				]}
			/>
			<TaskProgress />
			<PageToolbar
				label={`${name}列表工具栏`}
				className="people-toolbar"
				actions={
					view.tab === 'manage' ? (
						<Label className="archive-filter">
							<Checkbox checked={view.archived} onCheckedChange={(archived) => onViewChange({ archived })} />
							显示已取消关注的订阅
						</Label>
					) : undefined
				}
			>
				<div className="people-search">
					<Search />
					<Input aria-label={`搜索${name}`} placeholder={`搜索${name}姓名或账号`} value={view.query} onChange={(event) => onViewChange({ query: event.target.value })} />
				</div>
				<span className="page-toolbar-count">
					{list.length} 位{name}
				</span>
			</PageToolbar>
			{list.length ? (
				view.tab === 'browse' ? (
					<div className="people-grid">
						{list.map((sub) => (
							<PersonCard key={sub.id} subscription={sub} latest={entries.find((entry) => entry.subscriptionId === sub.id)} onOpen={() => open(sub.id)} />
						))}
					</div>
				) : (
					<div className="subscription-cards">
						{list.map((sub) => (
							<SubscriptionRow key={sub.id} subscription={sub} onOpen={open} />
						))}
					</div>
				)
			) : (
				<EmptyState
					icon={Users}
					title={view.query ? `没有匹配的${name}` : `还没有关注的${name}`}
					description={view.query ? '试试其他姓名或账号。' : `添加${name}并确认身份后，会在这里显示。`}
					action={view.query ? undefined : { label: '添加关注', onClick: () => onAdd(defaultProvider) }}
				/>
			)}
		</div>
	);
}

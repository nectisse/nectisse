import { useMetadata, useLibrary, useSubscriptions, useDesktopActions, useSubscriptionStatus } from '@/shared/desktop';
import { useEffect, useRef, useState } from 'react';
import { Bookmark, Check, Database, LoaderCircle, Search, Settings2, UserRound, Users, WifiOff } from 'lucide-react';
import type { RuntimeState } from '@shared/protocol';
import type { FollowProvider } from '@shared/subscriptions';
import { isPerformerProvider } from '@shared/sources';
import { Button } from '@/shared/ui/button';
import { WorkspaceToolbar } from '@/app/ui/WorkspaceToolbar';
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert';
import { MetadataWorkspace } from '@/features/work-query';
import { SettingsPage } from '@/features/settings';
import { SubscriptionsPage, AddFollowDialog, type FollowDialogSeed } from '@/features/subscriptions';
import { IdentityAvatar } from '@/entities/subscription';
import { LibraryPage, SaveWorkButton } from '@/features/library';

import type { PeopleScope, PeopleView } from '@/shared/lib/people-navigation';
import type { Page, WorkspaceNavigation } from './workspace-navigation';

const nav = [
	{ page: 'query', label: '资料查询', icon: Search },
	{ page: 'library', label: '作品收藏', icon: Bookmark },
	{ page: 'actors', label: '演员', icon: UserRound },
	{ page: 'creators', label: '创作者', icon: Users },
] as const;

export function Workspace({
	runtime,
	bridgeError,
	onRetry,
	navigation,
	onNavigate,
	onDemo,
	onExitDemo,
}: {
	runtime: RuntimeState;
	bridgeError: boolean;
	onRetry: () => void;
	navigation: WorkspaceNavigation;
	onNavigate: (patch: Partial<WorkspaceNavigation>) => void;
	onDemo: () => void;
	onExitDemo?: () => void;
}): React.JSX.Element {
	const actions = useDesktopActions();
	const { invoke, reloadSubscriptions: reload } = actions;
	const libraryCount = useLibrary((state) => state.works.length);
	const [librarySeed, setLibrarySeed] = useState<{ id: string; token: number }>();
	const state = useSubscriptions((state) => ({ subscriptions: state.subscriptions, notice: state.notice, theme: state.preferences.theme }));
	const { error, reading } = useSubscriptionStatus();
	const { page, settingsSection } = navigation;
	const setPage = (page: Page): void => onNavigate({ page, scrollTop: 0 });
	const setSettingsSection = (settingsSection: WorkspaceNavigation['settingsSection']): void => onNavigate({ settingsSection });
	const updatePeople = (scope: PeopleScope, patch: Partial<PeopleView>): void => onNavigate({ [scope]: { ...navigation[scope], ...patch } });
	const openPerson = (id: string, provider: FollowProvider): void => {
		const scope = isPerformerProvider(provider) ? 'actors' : 'creators';
		onNavigate({ page: scope, [scope]: { ...navigation[scope], selectedId: id, scrollTop: document.querySelector('.page-scroll')?.scrollTop ?? 0 } });
	};
	const [followSeed, setFollowSeed] = useState<FollowDialogSeed>();
	const followTrigger = useRef<HTMLElement | null>(null);
	const followSequence = useRef(0);
	const [workSeed, setWorkSeed] = useState<{ query: string; token: number }>();
	const [queryTaskId, setQueryTaskId] = useState<string | null>(null);
	const metadataTask = useMetadata((state) => state.tasks.find((task) => task.id === state.activeId));

	useEffect(() => {
		const open = (): void => {
			onExitDemo?.();
			setPage('settings');
		};

		const key = (event: KeyboardEvent): void => {
			if ((event.metaKey || event.ctrlKey) && event.key === ',') {
				event.preventDefault();
				open();
			} else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				setPage('query');
				setWorkSeed({ query: '', token: Date.now() });
			}
		};

		window.addEventListener('keydown', key);
		return () => {
			window.removeEventListener('keydown', key);
		};
	}, [actions, onExitDemo, onNavigate]);

	useEffect(() => {
		document.documentElement.dataset.theme = state.theme;
		document.documentElement.classList.toggle('dark', state.theme === 'night');
	}, [state.theme]);

	const previousPage = useRef(page);
	useEffect(() => {
		document.querySelector('.page-scroll')?.scrollTo(0, previousPage.current === page ? navigation.scrollTop : 0);
		previousPage.current = page;
	}, [page]);

	const add = (provider: FollowProvider = 'javdb', query = ''): void => {
		followTrigger.current = document.activeElement as HTMLElement;
		setFollowSeed({ provider, query, token: ++followSequence.current });
	};

	const work = (query: string): void => {
		setPage('query');
		setWorkSeed({ query, token: Date.now() });
	};

	const openLibrary = (id: string): void => {
		setLibrarySeed({ id, token: Date.now() });
		setPage('library');
	};

	const openSourceSettings = (): void => {
		onNavigate({ page: 'settings', settingsSection: 'sources', scrollTop: 0 });
	};

	const retryServices = (): void => {
		void reload();
		if (bridgeError || runtime.phase === 'error') {
			onRetry();
		}
	};

	const subscriptions = useSubscriptions((state) => state.subscriptions);
	const followed = subscriptions.filter((sub) => sub.following);
	const active = useSubscriptions((state) => state.tasks.find((task) => ['running', 'cancelling'].includes(task.status)));
	return (
		<div className="app-shell workspace-shell">
			<aside className="sidebar">
				<div className="titlebar-space window-drag" />
				<button className="brand" aria-label="Nectisse 资料查询" onClick={() => setPage('query')}>
					<span>
						<span className="brand-name">Nectisse</span>
						<small>A PRIVATE COLLECTION</small>
					</span>
				</button>
				<p className="nav-label">我的空间</p>
				<nav aria-label="主导航">
					{nav.map((item) => (
						<Button
							key={item.page}
							variant="ghost"
							className={`nav-item ${page === item.page ? 'selected' : ''}`}
							aria-label={item.label}
							aria-current={page === item.page ? 'page' : undefined}
							onClick={() => {
								if (item.page === 'library') {
									setLibrarySeed(undefined);
								}
								onNavigate({
									page: item.page,
									scrollTop: 0,
									...(['actors', 'creators'].includes(item.page) ? { [item.page]: { ...navigation[item.page as PeopleScope], selectedId: '' } } : {}),
								});
							}}
						>
							<item.icon />
							<span>{item.label}</span>
							{item.page === 'query' ? (
								<kbd>⌘ K</kbd>
							) : (item.page === 'actors' || item.page === 'creators') &&
							  state.subscriptions.some((sub) => sub.unread > 0 && isPerformerProvider(sub.provider) === (item.page === 'actors')) ? (
								<span className="unread-count" aria-hidden="true">
									{state.subscriptions
										.filter((sub) => isPerformerProvider(sub.provider) === (item.page === 'actors'))
										.reduce((count, sub) => count + sub.unread, 0)}
								</span>
							) : item.page === 'library' ? (
								<span className="nav-count" aria-hidden="true">
									{libraryCount}
								</span>
							) : item.page === 'creators' || item.page === 'actors' ? (
								<span className="nav-count" aria-hidden="true">
									{followed.filter((sub) => isPerformerProvider(sub.provider) === (item.page === 'actors')).length}
								</span>
							) : null}
						</Button>
					))}
				</nav>
				<div className="sidebar-rule" />
				<p className="nav-label following-label">
					正在关注<span>{followed.length}</span>
				</p>
				<div className="sidebar-following">
					{followed.slice(0, 5).map((sub) => (
						<button
							className="sidebar-author"
							key={sub.id}
							onClick={() => {
								openPerson(sub.id, sub.provider);
							}}
						>
							<IdentityAvatar identity={sub} small />
							<span>
								{sub.name}
								<small>{isPerformerProvider(sub.provider) ? '演员新作' : '创作者动态'}</small>
							</span>
							{sub.unread > 0 && <i className="new-dot" />}
						</button>
					))}
					{!followed.length && (
						<p className="following-empty">
							还没有关注对象
							<br />
							添加关注后会在这里显示。
						</p>
					)}
				</div>
				<div className="sidebar-bottom">
					<Button variant="ghost" className={`nav-item ${page === 'settings' ? 'selected' : ''}`} aria-label="设置" onClick={() => setPage('settings')}>
						<Settings2 />
						<span>设置</span>
						<kbd>⌘ ,</kbd>
					</Button>
					<div className="private-space">
						<span>
							私人资料库<small>收藏与关注保存在本机</small>
						</span>
					</div>
				</div>
			</aside>
			<section className="app-main">
				<WorkspaceToolbar
					page={page === 'query' ? '资料查询' : page === 'library' ? '作品收藏' : page === 'actors' ? '演员' : page === 'creators' ? '创作者' : '设置'}
					theme={state.theme}
					onQuery={() => {
						setPage('query');
						setWorkSeed({ query: '', token: Date.now() });
					}}
					onTheme={() => {
						void actions.updatePreferences({ theme: state.theme === 'cream' ? 'night' : 'cream' });
					}}
				/>
				{onExitDemo && (
					<div className="demo-mode-bar" role="region" aria-label="示例数据模式">
						<span>示例数据 · 本次操作不保存到资料库</span>
						<Button variant="outline" size="sm" className="exit-visual-demo" onClick={onExitDemo}>
							返回真实工作区
						</Button>
					</div>
				)}
				<main className="page-scroll">
					{(runtime.phase === 'error' || bridgeError || error || state.notice) && (
						<Alert className="environment-alert">
							{error ? <Database /> : <WifiOff />}
							<AlertTitle>{error ? '本地资料暂未就绪' : '应用服务需要处理'}</AlertTitle>
							<AlertDescription>
								{error || state.notice || runtime.message}
								<Button variant="outline" size="sm" disabled={reading} onClick={retryServices}>
									重新检查
								</Button>
							</AlertDescription>
						</Alert>
					)}
					{page === 'query' ? (
						<MetadataWorkspace
							seed={workSeed}
							selectedTaskId={queryTaskId}
							onSelectTask={(id) => {
								setQueryTaskId(id);
								if (id) {
									setWorkSeed(undefined);
								}
							}}
							onClear={() => setWorkSeed(undefined)}
							onPerformer={(query, provider = 'javdb') => add(provider, query)}
							renderSaveAction={(props) => <SaveWorkButton {...props} onOpen={openLibrary} />}
						/>
					) : page === 'library' ? (
						<LibraryPage seed={librarySeed} onQuery={work} />
					) : page === 'actors' || page === 'creators' ? (
						<SubscriptionsPage
							key={page}
							scope={page}
							view={navigation[page]}
							onViewChange={(patch) => updatePeople(page, patch)}
							onAdd={(provider) => add(provider)}
							onSettings={openSourceSettings}
							onWork={work}
						/>
					) : (
						<SettingsPage
							onAdd={(provider) => add(provider)}
							onDemo={() => {
								onNavigate({ scrollTop: document.querySelector('.page-scroll')?.scrollTop ?? 0 });
								onDemo();
							}}
							section={settingsSection}
							onSectionChange={setSettingsSection}
							demo={!!onExitDemo}
						/>
					)}
				</main>
				<footer className="preview-footer">
					<span>{active?.phase ?? (reading ? '正在读取设置与订阅' : onExitDemo ? '示例数据 · 仅保留在本次会话' : '私人空间 · SQLite 本机存储')}</span>
					<div className="runtime-indicator" role="status" data-testid="runtime-status" data-phase={bridgeError ? 'error' : runtime.phase}>
						{active || metadataTask || runtime.phase === 'starting' ? <LoaderCircle className="spin" /> : runtime.phase === 'ready' ? <Check /> : <WifiOff />}
						<span>{metadataTask?.phase || (runtime.phase === 'ready' ? (onExitDemo ? '示例数据就绪' : '采集环境就绪') : runtime.message)}</span>
						{active && (
							<button
								disabled={active.status === 'cancelling'}
								onClick={() => {
									void invoke({ action: 'cancel', id: active.id });
								}}
							>
								取消订阅任务
							</button>
						)}
						{metadataTask && (
							<button
								onClick={() => {
									void actions.metadata.cancel(metadataTask.id);
								}}
							>
								取消资料查询
							</button>
						)}
					</div>
				</footer>
			</section>
			<AddFollowDialog
				seed={followSeed}
				returnFocus={followTrigger}
				onClose={() => setFollowSeed(undefined)}
				onSettings={openSourceSettings}
				onFollow={(id, provider) => {
					setFollowSeed(undefined);
					openPerson(id, provider);
				}}
			/>
		</div>
	);
}

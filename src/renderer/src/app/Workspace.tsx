import { useMetadata, useLibrary, useSubscriptions, useDesktopActions, useSubscriptionStatus } from '@/state';
import { useEffect, useRef, useState } from 'react';
import { Bookmark, Check, Database, LoaderCircle, Search, Settings2, Sparkles, Users, WifiOff } from 'lucide-react';
import type { RuntimeState } from '@shared/protocol';
import type { FollowProvider } from '@shared/subscriptions';
import { Button } from '@/components/ui/button';
import { WorkspaceToolbar } from '@/components/workspace-toolbar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import MetadataWorkspace from '@/metadata/MetadataWorkspace';
import VisualPrototype from '@/prototype/VisualPrototype';
import { SettingsPage, type SettingsSection } from '@/settings/SettingsPage';
import { SubscriptionsPage } from '@/subscriptions/SubscriptionsPage';
import { UpdatesPage } from '@/updates/UpdatesPage';
import { AddFollowDialog, type FollowDialogSeed } from '@/subscriptions/AddFollowDialog';
import { IdentityAvatar } from '@/subscriptions/IdentityAvatar';
import { LibraryPage } from '@/library/LibraryPage';

type Page = 'query' | 'library' | 'creators' | 'updates' | 'settings';
const nav = [
	{ page: 'query', label: '资料查询', icon: Search },
	{ page: 'library', label: '作品收藏', icon: Bookmark },
	{ page: 'creators', label: '演员与创作者', icon: Users },
	{ page: 'updates', label: '更新', icon: Sparkles },
] as const;

export function Workspace({ runtime, bridgeError, onRetry }: { runtime: RuntimeState; bridgeError: boolean; onRetry: () => void }): React.JSX.Element {
	const actions = useDesktopActions();
	const { invoke, reloadSubscriptions: reload } = actions;
	const libraryCount = useLibrary((state) => state.works.length);
	const [librarySeed, setLibrarySeed] = useState<{ id: string; token: number }>();
	const state = useSubscriptions((state) => ({ unread: state.entries.filter((entry) => !entry.read).length, notice: state.notice, theme: state.preferences.theme }));
	const { error, reading } = useSubscriptionStatus();
	const [page, setPage] = useState<Page>('query');
	const [demo, setDemo] = useState(false);
	const [settingsSection, setSettingsSection] = useState<SettingsSection>('sources');
	const [seed, setSeed] = useState<{ provider: FollowProvider; query: string; token: number; subscriptionId?: string }>();
	const [followSeed, setFollowSeed] = useState<FollowDialogSeed>();
	const followTrigger = useRef<HTMLElement | null>(null);
	const followSequence = useRef(0);
	const [workSeed, setWorkSeed] = useState<{ query: string; token: number }>();
	const metadataTask = useMetadata((state) => state.tasks.find((task) => task.id === state.activeId));

	useEffect(() => {
		const open = (): void => {
			setDemo(false);
			setPage('settings');
		};

		const unsubscribe = actions.onSettings(open);

		const key = (event: KeyboardEvent): void => {
			if ((event.metaKey || event.ctrlKey) && event.key === ',') {
				event.preventDefault();
				open();
			} else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !demo) {
				event.preventDefault();
				setPage('query');
				setWorkSeed({ query: '', token: Date.now() });
			}
		};

		window.addEventListener('keydown', key);
		return () => {
			unsubscribe?.();
			window.removeEventListener('keydown', key);
		};
	}, [demo, actions]);

	useEffect(() => {
		if (!demo) {
			document.documentElement.dataset.theme = state.theme;
			document.documentElement.classList.toggle('dark', state.theme === 'night');
		}
	}, [state.theme, demo]);

	useEffect(() => {
		document.querySelector('.page-scroll')?.scrollTo(0, 0);
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
		setSettingsSection('sources');
		setPage('settings');
	};

	const retryServices = (): void => {
		void reload();
		if (bridgeError || runtime.phase === 'error') {
			onRetry();
		}
	};

	const followed = useSubscriptions((state) => state.subscriptions.filter((sub) => sub.following));
	const active = useSubscriptions((state) => state.tasks.find((task) => ['running', 'cancelling'].includes(task.status)));
	const exitDemo = (): void => {
		setDemo(false);
		requestAnimationFrame(() => document.getElementById('open-visual-demo')?.focus());
	};

	if (demo) {
		return (
			<>
				<VisualPrototype runtime={runtime} bridgeError={bridgeError} onRetry={onRetry} />
				<Button className="exit-visual-demo" onClick={exitDemo}>
					返回真实工作区
				</Button>
			</>
		);
	}
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
								setPage(item.page);
							}}
						>
							<item.icon />
							<span>{item.label}</span>
							{item.page === 'query' ? (
								<kbd>⌘ K</kbd>
							) : item.page === 'updates' && state.unread > 0 ? (
								<span className="unread-count" aria-hidden="true">
									{state.unread}
								</span>
							) : item.page === 'library' ? (
								<span className="nav-count" aria-hidden="true">
									{libraryCount}
								</span>
							) : item.page === 'creators' ? (
								<span className="nav-count" aria-hidden="true">
									{followed.length}
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
								setPage('creators');
								setSeed({ provider: sub.provider, query: '', token: Date.now(), subscriptionId: sub.id });
							}}
						>
							<IdentityAvatar identity={sub} small />
							<span>
								{sub.name}
								<small>{sub.provider === 'javdb' ? '演员新作' : '创作者动态'}</small>
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
					page={page === 'query' ? '资料查询' : page === 'library' ? '作品收藏' : page === 'creators' ? '演员与创作者' : page === 'updates' ? '更新' : '设置'}
					theme={state.theme}
					onQuery={() => {
						setPage('query');
						setWorkSeed({ query: '', token: Date.now() });
					}}
					onTheme={() => {
						void actions.updatePreferences({ theme: state.theme === 'cream' ? 'night' : 'cream' });
					}}
				/>
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
						<MetadataWorkspace seed={workSeed} onPerformer={(name) => add('javdb', name)} onLibrary={openLibrary} />
					) : page === 'library' ? (
						<LibraryPage seed={librarySeed} onQuery={work} />
					) : page === 'creators' ? (
						<SubscriptionsPage seed={seed} onAdd={(provider) => add(provider)} onSettings={openSourceSettings} onWork={work} />
					) : page === 'updates' ? (
						<UpdatesPage onWork={work} onAdd={() => setPage('creators')} />
					) : (
						<SettingsPage onAdd={(provider) => add(provider)} onDemo={() => setDemo(true)} section={settingsSection} onSectionChange={setSettingsSection} />
					)}
				</main>
				<footer className="preview-footer">
					<span>{active?.phase ?? (reading ? '正在读取设置与订阅' : '私人空间 · SQLite 本机存储')}</span>
					<div className="runtime-indicator" role="status" data-testid="runtime-status" data-phase={bridgeError ? 'error' : runtime.phase}>
						{active || metadataTask || runtime.phase === 'starting' ? <LoaderCircle className="spin" /> : runtime.phase === 'ready' ? <Check /> : <WifiOff />}
						<span>{metadataTask?.phase || (runtime.phase === 'ready' ? '采集环境就绪' : runtime.message)}</span>
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
					setPage('creators');
					setSeed({ provider, query: '', token: Date.now(), subscriptionId: id });
				}}
			/>
		</div>
	);
}

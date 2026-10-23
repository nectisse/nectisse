import { useEffect, useState } from 'react';
import { Bookmark, Check, ChevronRight, Info, Database, LoaderCircle, Search, Settings2, Sparkles, Users, WifiOff } from 'lucide-react';
import type { RuntimeState } from '../../../shared/protocol';
import type { QueryTask } from '../../../shared/metadata';
import type { FollowProvider } from '../../../shared/subscriptions';
import { Button } from '@/components/ui/button';
import { WorkspaceToolbar } from '@/components/workspace-toolbar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import MetadataWorkspace from '../metadata/MetadataWorkspace';
import VisualPrototype from '../prototype/VisualPrototype';
import { SettingsPage } from './SettingsPage';
import { SubscriptionsPage, UpdatesPage } from './SubscriptionsPage';
import { useSubscriptions } from './context';
import { IdentityAvatar } from './IdentityAvatar';
import { LibraryPage } from '../library/LibraryPage';
import { useLibrary } from '../library/context';

type Page = 'query' | 'library' | 'creators' | 'updates' | 'settings';
const nav = [
	{ page: 'query', label: '资料查询', icon: Search },
	{ page: 'library', label: '作品收藏', icon: Bookmark },
	{ page: 'creators', label: '演员与创作者', icon: Users },
	{ page: 'updates', label: '更新', icon: Sparkles },
] as const;
export function Workspace({ runtime, bridgeError, onRetry }: { runtime: RuntimeState; bridgeError: boolean; onRetry: () => void }): React.JSX.Element {
	const { state: libraryState } = useLibrary();
	const [librarySeed, setLibrarySeed] = useState<{ id: string; token: number }>();
	const { state, invoke, error, reading, reload } = useSubscriptions();
	const [page, setPage] = useState<Page>('query');
	const [demo, setDemo] = useState(false);
	const [seed, setSeed] = useState<{ provider: FollowProvider; query: string; token: number; subscriptionId?: string }>();
	const [workSeed, setWorkSeed] = useState<{ query: string; token: number }>();
	const [metadataTask, setMetadataTask] = useState<QueryTask>();
	useEffect(() => {
		const open = (): void => {
			setDemo(false);
			setPage('settings');
		};
		const unsubscribe = window.nectisse?.subscriptions?.onSettings(open);
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
	}, [demo]);
	useEffect(() => {
		if (!demo) {
			document.documentElement.dataset.theme = state.preferences.theme;
			document.documentElement.classList.toggle('dark', state.preferences.theme === 'night');
		}
	}, [state.preferences.theme, demo]);
	useEffect(() => {
		if (!window.nectisse?.metadata) return;
		const apply = (next: Awaited<ReturnType<typeof window.nectisse.metadata.getState>>): void => setMetadataTask(next.tasks.find((task) => task.id === next.activeId));
		const unsubscribe = window.nectisse.metadata.onState(apply);
		void window.nectisse.metadata
			.getState()
			.then(apply)
			.catch(() => {});
		return unsubscribe;
	}, []);
	useEffect(() => {
		document.querySelector('.page-scroll')?.scrollTo(0, 0);
	}, [page]);
	const add = (provider: FollowProvider = 'javdb', query = ''): void => {
		setPage('creators');
		setSeed({ provider, query, token: Date.now() });
	};
	const work = (query: string): void => {
		setPage('query');
		setWorkSeed({ query, token: Date.now() });
	};
	const openLibrary = (id: string): void => {
		setLibrarySeed({ id, token: Date.now() });
		setPage('library');
	};
	const retryServices = (): void => {
		void reload();
		if (bridgeError || runtime.phase === 'error') onRetry();
	};
	const followed = state.subscriptions.filter((sub) => sub.following);
	const active = state.tasks.find((task) => ['running', 'cancelling'].includes(task.status));
	if (demo)
		return (
			<>
				<VisualPrototype runtime={runtime} bridgeError={bridgeError} onRetry={onRetry} />
				<Button className="exit-visual-demo" onClick={() => setDemo(false)}>
					返回真实工作区
				</Button>
			</>
		);
	return (
		<div className="app-shell workspace-shell">
			<aside className="sidebar">
				<div className="titlebar-space window-drag" />
				<button className="brand" aria-label="Nectisse 资料查询" onClick={() => setPage('query')}>
					<svg className="brand-mark" viewBox="0 0 36 36" fill="none" aria-hidden="true">
						<path d="M10 27V10c0-3 4-4 6-1l10 18V10M10 18c5-6 11-6 16 0" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
						<path d="M6 30c6-3 18-3 24 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity=".5" />
					</svg>
					<span>
						Nectisse<small>A PRIVATE COLLECTION</small>
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
								if (item.page === 'library') setLibrarySeed(undefined);
								setPage(item.page);
							}}
						>
							<item.icon />
							<span>{item.label}</span>
							{item.page === 'query' ? (
								<kbd>⌘ K</kbd>
							) : item.page === 'updates' && state.entries.some((entry) => !entry.read) ? (
								<span className="unread-count" aria-hidden="true">
									{state.entries.filter((entry) => !entry.read).length}
								</span>
							) : item.page === 'library' ? (
								<span className="nav-count" aria-hidden="true">
									{libraryState.works.length}
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
							从一个主页或演员名开始。
						</p>
					)}
					<Button variant="ghost" className="all-authors" onClick={() => add()}>
						添加关注
						<ChevronRight />
					</Button>
				</div>
				<div className="sidebar-bottom">
					<p className="background-note">
						关闭窗口后仍在后台运行
						<br />
						<kbd>⌘ Q</kbd> 退出 Nectisse
					</p>
					<Button variant="ghost" className={`nav-item ${page === 'settings' ? 'selected' : ''}`} aria-label="设置" onClick={() => setPage('settings')}>
						<Settings2 />
						<span>设置</span>
						<kbd>⌘ ,</kbd>
					</Button>
					<div className="private-space">
						<span className="private-symbol">N</span>
						<span>
							私人资料库<small>收藏与关注保存在本机</small>
						</span>
						<Info size={14} />
					</div>
				</div>
			</aside>
			<section className="app-main">
				<WorkspaceToolbar
					page={page === 'query' ? '资料查询' : page === 'library' ? '作品收藏' : page === 'creators' ? '演员与创作者' : page === 'updates' ? '更新' : '设置'}
					theme={state.preferences.theme}
					onQuery={() => {
						setPage('query');
						setWorkSeed({ query: '', token: Date.now() });
					}}
					onDemo={() => setDemo(true)}
					onTheme={() => {
						void invoke({ action: 'preferences', value: { ...state.preferences, theme: state.preferences.theme === 'cream' ? 'night' : 'cream' } });
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
						<SubscriptionsPage seed={seed} onSettings={() => setPage('settings')} onWork={work} />
					) : page === 'updates' ? (
						<UpdatesPage onWork={work} onAdd={() => setPage('creators')} />
					) : (
						<SettingsPage onAdd={(provider) => add(provider)} />
					)}
				</main>
				<footer className="preview-footer">
					<span>{active ? active.phase : reading ? '正在读取设置与订阅' : '私人空间 · SQLite 本机存储'}</span>
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
									void window.nectisse.metadata.cancel(metadataTask.id);
								}}
							>
								取消资料查询
							</button>
						)}
					</div>
				</footer>
			</section>
		</div>
	);
}

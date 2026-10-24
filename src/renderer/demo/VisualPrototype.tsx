import { useMetadata, useDesktopActions } from '@/shared/desktop';
// App-hosted visual review of the existing four-page design. This is an
// in-memory prototype, deliberately separate from future source adapters.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Archive, Check, ChevronRight, LoaderCircle, Moon, Search, Settings2, Sparkles, Sun, Users, WifiOff } from 'lucide-react';
import type { RuntimeState } from '@shared/protocol';
import { Button } from '@/shared/ui/button';
import { FeedImage, UpdateDetailDialog } from '@/entities/update';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { RadioGroup, RadioGroupItem } from '@/shared/ui/radio-group';
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert';
import { cn } from '@/shared/lib/utils';
import { Avatar, CoverChoice, Photo, Poster, QuietButton, ReviewDialog, StatusBadge } from './components';
import { CreatorPage, UpdatesPage, type Frequency } from './creator-pages';
import { creators, creatorFor, firstCreator, firstWork, initialReadIds, posts, type Creator, type Post, type Route, type Site, type Work } from './data';
import { QueryPage, WorkDetail, type DateOverride } from './work-pages';

type Dialog = { kind: 'source' | 'preview' | 'compare' | 'about' | 'settings' } | { kind: 'post'; post: Post };
type DateChoice = 'primary' | 'mirror' | 'manual';
const navigation = [
	{ page: 'query', title: '资料查询', icon: Search },
	{ page: 'detail', title: '作品档案', icon: Archive },
	{ page: 'updates', title: '更新', icon: Sparkles },
	{ page: 'creator', title: '创作者', icon: Users },
] as const;

export default function VisualPrototype({ runtime, bridgeError, onRetry }: { runtime: RuntimeState; bridgeError: boolean; onRetry: () => void }): React.JSX.Element {
	const actions = useDesktopActions();
	const [route, setRoute] = useState<Route>({ page: 'query' });
	const activeMetadata = useMetadata((state) => state.tasks.find((task) => task.id === state.activeId));

	const [work, setWork] = useState<Work>(firstWork);
	const [creator, setCreator] = useState<Creator>(firstCreator);
	const [theme, setTheme] = useState<'cream' | 'night'>('cream');
	const [query, setQuery] = useState('午後');
	const [submittedQuery, setSubmittedQuery] = useState('午後');
	const [sources, setSources] = useState<Set<Site>>(new Set(['DMM', 'r18.dev']));
	const [recent, setRecent] = useState(['NECT-024', '午後', '白石 澪', '海辺']);
	const [saved, setSaved] = useState<Set<string>>(new Set());
	const [read, setRead] = useState(initialReadIds);
	const [followed, setFollowed] = useState(new Set(creators.map((item) => item.id)));
	const [coverChoices, setCoverChoices] = useState<Record<string, number>>({});
	const [dates, setDates] = useState<Record<string, DateOverride>>({});
	const [frequencies, setFrequencies] = useState<Record<string, Frequency>>({});
	const [feedFilter, setFeedFilter] = useState<'unread' | 'all'>('unread');
	const [creatorFilter, setCreatorFilter] = useState('');
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [dateChoice, setDateChoice] = useState<DateChoice>('primary');
	const [manualDate, setManualDate] = useState(firstWork.releaseDate);
	const [notice, setNotice] = useState<{ message: string } | null>(null);
	const scroll = useRef<HTMLElement>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	const unreadCount = posts.filter((post) => !read.has(post.id)).length;
	const selectedCover = coverChoices[work.id] ?? 0;
	const cover = work.covers[selectedCover] ?? work.covers[0]!;

	const notify = (message: string): void => setNotice({ message });

	const open = (next: Dialog): void => {
		returnFocus.current = document.activeElement as HTMLElement | null;
		setDialog(next);
	};

	const openWork = (next: Work): void => {
		setWork(next);
		setRoute({ page: 'detail' });
		setDialog(null);
	};

	const openCreator = (next: Creator): void => {
		setCreator(next);
		setRoute({ page: 'creator' });
		setDialog(null);
	};

	const openPost = (post: Post): void => {
		open({ kind: 'post', post });
		setRead((previous) => new Set(previous).add(post.id));
	};

	const toggleRead = (post: Post): void =>
		setRead((previous) => {
			const next = new Set(previous);
			if (next.has(post.id)) {
				next.delete(post.id);
			} else {
				next.add(post.id);
			}
			return next;
		});

	const toggleSaved = (item: Work): void => {
		setSaved((previous) => {
			const next = new Set(previous);
			if (next.has(item.id)) {
				next.delete(item.id);
			} else {
				next.add(item.id);
			}
			return next;
		});
		notify(`${item.id} 的保存状态已切换，仅保留在本次预览中。`);
	};

	const selectCover = (index: number): void => {
		setCoverChoices((previous) => ({ ...previous, [work.id]: index }));
		notify('已切换当前封面预览，没有修改或导出文件。');
	};

	const queryFor = (value: string): void => {
		setQuery(value);
		setSubmittedQuery(value);
		setRoute({ page: 'query' });
	};

	const openSources = (): void => {
		const override = dates[work.id];
		setDateChoice(override?.manual ? 'manual' : override?.value === work.mirrorDate ? 'mirror' : 'primary');
		setManualDate(override?.value ?? work.releaseDate);
		open({ kind: 'source' });
	};

	const reset = (): void => {
		setRead(initialReadIds());
		setSaved(new Set());
		setFollowed(new Set(creators.map((item) => item.id)));
		setCoverChoices({});
		setDates({});
		setFrequencies({});
		setFeedFilter('unread');
		setCreatorFilter('');
		setSources(new Set(['DMM', 'r18.dev']));
		setWork(firstWork);
		setCreator(firstCreator);
		queryFor('午後');
		setDialog(null);
		notify('模拟数据已还原。所有状态仅保留在本次预览中。');
	};

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		document.documentElement.classList.toggle('dark', theme === 'night');
	}, [theme]);

	useEffect(() => {
		scroll.current?.scrollTo(0, 0);
		document.title = `${route.page === 'query' ? '资料查询' : route.page === 'detail' ? work.title : route.page === 'creator' ? creator.name : '更新'} · Nectisse`;
	}, [route.page, work.id, work.title, creator.id, creator.name]);

	useEffect(() => {
		if (!notice) {
			return;
		}

		const timer = setTimeout(() => setNotice(null), 3600);

		return () => clearTimeout(timer);
	}, [notice]);

	useEffect(() => {
		const keydown = (event: KeyboardEvent): void => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				setDialog(null);
				setRoute({ page: 'query' });
				requestAnimationFrame(() => {
					const input = document.getElementById('work-query') as HTMLInputElement | null;
					input?.focus();
					input?.select();
				});
			}
		};

		window.addEventListener('keydown', keydown);
		return () => window.removeEventListener('keydown', keydown);
	}, []);

	const readingPost = dialog?.kind === 'post' ? dialog.post : undefined;
	let dialogTitle = '';
	let dialogDescription = '';
	let dialogContent: ReactNode = null;
	if (dialog?.kind === 'source') {
		dialogTitle = '发行日期 · 来源与采用值';
		dialogDescription = '保留来源原值，单独选择采用值。所有日期与来源记录均为示例。';
		dialogContent = (
			<>
				<RadioGroup
					aria-label="选择发行日期"
					className="source-choices"
					value={dateChoice}
					onValueChange={(value) => {
						if (value === 'primary' || value === 'mirror' || value === 'manual') {
							setDateChoice(value);
						}
					}}
				>
					{(['primary', ...(work.sources.length > 1 ? ['mirror'] : []), 'manual'] as DateChoice[]).map((choice) => (
						<Label key={choice} className={cn('source-choice', dateChoice === choice && 'selected')}>
							<RadioGroupItem value={choice} />
							<span>
								<strong>{choice === 'manual' ? '手动修正' : (choice === 'primary' ? work.releaseDate : work.mirrorDate).replaceAll('-', '.')}</strong>
								<small>
									{choice === 'manual' ? '锁定此字段，刷新不覆盖（演示）' : `${choice === 'primary' ? work.sources[0] : work.sources[1]} · 来源原值保留`}
								</small>
							</span>
							{choice === 'primary' && <StatusBadge tone="success">主要来源</StatusBadge>}
						</Label>
					))}
				</RadioGroup>
				{dateChoice === 'manual' && (
					<Label className="manual-date-label">
						手动发行日期
						<Input aria-label="手动发行日期" type="date" value={manualDate} onChange={(event) => setManualDate(event.target.value)} />
					</Label>
				)}
				<p className="panel-note">选择只改变本次预览的采用值，不删除来源证据，不写入数据库。</p>
				<div className="dialog-actions">
					<Button variant="outline" onClick={() => setDialog(null)}>
						取消
					</Button>
					<Button
						disabled={dateChoice === 'manual' && !manualDate}
						onClick={() => {
							setDates((previous) => ({
								...previous,
								[work.id]: {
									value: dateChoice === 'manual' ? manualDate : dateChoice === 'primary' ? work.releaseDate : work.mirrorDate,
									manual: dateChoice === 'manual',
								},
							}));
							setDialog(null);
							notify('发行日期采用值已更新，仅用于本次预览。');
						}}
					>
						采用此日期
					</Button>
				</div>
			</>
		);
	} else if (dialog?.kind === 'preview' || dialog?.kind === 'compare') {
		const compare = dialog.kind === 'compare';
		dialogTitle = compare ? '封面比较' : '作品封面 · 原图预览';
		dialogDescription = '素材为生成摄影图集，来源、尺寸与核验状态均用于视觉演示。';
		dialogContent = compare ? (
			<div className="dialog-cover-grid">
				{work.covers.map((candidate, index) => (
					<CoverChoice key={index} work={work} cover={candidate} selected={selectedCover === index} onChoose={() => selectCover(index)} />
				))}
			</div>
		) : (
			<div className="preview-cover">
				<Poster work={work} tile={cover.tile} />
				<p>
					{cover.title} · {cover.source} · 尺寸示例 {cover.dimensions}
				</p>
				<Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'compare' })}>
					比较其他封面
				</Button>
			</div>
		);
	} else if (dialog?.kind === 'settings') {
		dialogTitle = '预览设置';
		dialogDescription = '当前只确认布局与视觉风格，设置不会持久化。';
		dialogContent = (
			<>
				<h2 className="settings-label">外观</h2>
				<div className="appearance-choices">
					{(
						[
							{ value: 'cream', name: '奶油档案', note: '暖灰、奶油白与黑莓紫', icon: Sun },
							{ value: 'night', name: '黑莓夜间', note: '沉静的紫灰与柔和文字', icon: Moon },
						] as const
					).map((item) => (
						<Button
							variant="text"
							size="text"
							key={item.value}
							className={cn('appearance-choice', theme === item.value && 'selected')}
							onClick={() => setTheme(item.value)}
							aria-pressed={theme === item.value}
						>
							<item.icon />
							<strong>{item.name}</strong>
							<small>{item.note}</small>
							{theme === item.value && <Check className="appearance-check" />}
						</Button>
					))}
				</div>
				<div className="settings-reset">
					<div>
						<h2 className="settings-label">模拟数据</h2>
						<p>还原关注、保存、封面选择、采用日期和已读状态。</p>
					</div>
					<Button variant="outline" onClick={reset}>
						重置演示
					</Button>
				</div>
			</>
		);
	} else if (dialog?.kind === 'about') {
		dialogTitle = '你的私人空间 · Nectisse';
		dialogDescription = '此处是独立的视觉演示，示例操作不会保存到真实资料库。';
		dialogContent = (
			<div className="about-prototype">
				<p>真实工作区提供资料查询、作品收藏、照片墙和创作者订阅，资料与已取得图片保存在本机。</p>
				<p>这里使用虚构的作品、创作者和动态，保存、关注与已读等演示状态仅保留在本次预览中。</p>
				<p>返回真实工作区可查询、收藏和管理订阅。演示不会自动开始采集。</p>
				<Button onClick={() => setDialog(null)}>开始浏览</Button>
			</div>
		);
	}

	return (
		<div className="app-shell">
			<aside className="sidebar">
				<div className="titlebar-space window-drag" />
				<Button variant="text" size="text" className="brand" aria-label="Nectisse 资料查询" onClick={() => setRoute({ page: 'query' })}>
					<span>
						<span className="brand-name">Nectisse</span>
						<small>A PRIVATE COLLECTION</small>
					</span>
				</Button>
				<p className="nav-label">我的空间</p>
				<nav aria-label="主导航">
					{navigation.map((item) => (
						<Button
							key={item.page}
							variant="ghost"
							className={cn('nav-item', route.page === item.page && 'selected')}
							aria-label={item.title}
							aria-current={route.page === item.page ? 'page' : undefined}
							onClick={() => setRoute({ page: item.page })}
						>
							<item.icon />
							<span>{item.title}</span>
							{item.page === 'query' ? (
								<kbd>⌘ K</kbd>
							) : item.page === 'updates' && unreadCount > 0 ? (
								<span className="unread-count" aria-hidden="true">
									{unreadCount}
								</span>
							) : item.page === 'creator' ? (
								<span className="nav-count" aria-hidden="true">
									{followed.size}
								</span>
							) : null}
						</Button>
					))}
				</nav>
				<div className="sidebar-rule" />
				<p className="nav-label following-label">
					正在关注<span>{followed.size}</span>
				</p>
				<div className="sidebar-following">
					{creators
						.filter((item) => followed.has(item.id))
						.map((item) => (
							<Button
								variant="text"
								size="text"
								className={cn('sidebar-author', route.page === 'creator' && item.id === creator.id && 'selected')}
								key={item.id}
								onClick={() => openCreator(item)}
							>
								<Avatar creator={item} />
								<span>
									{item.name}
									<small>{item.handle}</small>
								</span>
								{posts.some((post) => post.creatorId === item.id && !read.has(post.id)) && <i className="new-dot" />}
							</Button>
						))}
					{!followed.size && <p className="following-empty">还没有关注的创作者</p>}
					<QuietButton className="all-authors" onClick={() => openCreator(firstCreator)}>
						查看创作者主页
						<ChevronRight />
					</QuietButton>
				</div>
				<div className="sidebar-bottom">
					<Button variant="ghost" className="nav-item" onClick={() => open({ kind: 'settings' })}>
						<Settings2 />
						<span>预览设置</span>
					</Button>
					<div className="private-space">
						<span>
							私人资料库<small>只属于你的收藏</small>
						</span>
					</div>
				</div>
			</aside>
			<section className="app-main">
				<header className="toolbar window-drag">
					<nav className="breadcrumb" aria-label="当前位置">
						{route.page === 'detail' ? (
							<>
								<Button variant="text" size="text" onClick={() => setRoute({ page: 'query' })}>
									资料查询
								</Button>
								<ChevronRight />
								<span>{work.id}</span>
								<ChevronRight />
								<span className="current">作品详情</span>
							</>
						) : route.page === 'creator' ? (
							<>
								<span>创作者</span>
								<ChevronRight />
								<span className="current">{creator.name}</span>
							</>
						) : (
							<span className="current">{route.page === 'query' ? '资料查询' : '更新'}</span>
						)}
					</nav>
					<div className="toolbar-right">
						<Button variant="text" size="text" className="demo-badge" onClick={() => open({ kind: 'about' })}>
							模拟数据
						</Button>
						<span className="local-indicator">
							<i />
							本地空间
						</span>
						<Button
							variant="ghost"
							size="sm"
							className="theme-toggle"
							aria-label={`切换到${theme === 'cream' ? '黑莓夜间' : '奶油档案'}`}
							onClick={() => setTheme((previous) => (previous === 'cream' ? 'night' : 'cream'))}
						>
							{theme === 'cream' ? <Moon /> : <Sun />}
							<span>{theme === 'cream' ? '黑莓夜间' : '奶油档案'}</span>
						</Button>
					</div>
				</header>
				<main ref={scroll} className="page-scroll">
					{(runtime.phase === 'error' || bridgeError) && (
						<Alert className="environment-alert">
							<WifiOff />
							<AlertTitle>采集环境暂不可用 · 仍可浏览视觉预览</AlertTitle>
							<AlertDescription>
								<p>{bridgeError ? '应用通信未建立，请重新打开应用。' : runtime.message}</p>
								{!bridgeError && (
									<Button variant="outline" size="sm" onClick={onRetry}>
										重新检查
									</Button>
								)}
							</AlertDescription>
						</Alert>
					)}
					{route.page === 'query' ? (
						<QueryPage
							query={query}
							submittedQuery={submittedQuery}
							onChange={setQuery}
							onSubmit={() => {
								setSubmittedQuery(query);
								if (query.trim()) {
									setRecent((previous) => [query.trim(), ...previous.filter((item) => item !== query.trim())].slice(0, 4));
								}
								notify('已筛选本地模拟资料，没有向原站发送请求。');
							}}
							selectedSources={sources}
							onSource={(source) =>
								setSources((previous) => {
									const next = new Set(previous);
									if (next.has(source)) {
										next.delete(source);
									} else {
										next.add(source);
									}
									return next;
								})
							}
							recent={recent}
							onRecent={queryFor}
							onReset={() => {
								queryFor('');
								setSources(new Set(['DMM', 'r18.dev', 'JavDB']));
							}}
							saved={saved}
							onOpen={openWork}
							onSave={toggleSaved}
							notify={notify}
						/>
					) : route.page === 'detail' ? (
						<WorkDetail
							key={work.id}
							work={work}
							selectedCover={selectedCover}
							onCover={selectCover}
							saved={saved.has(work.id)}
							onSave={() => toggleSaved(work)}
							onQuery={() => setRoute({ page: 'query' })}
							onCreator={() => openCreator(creatorFor(work.creatorId))}
							onPreview={() => open({ kind: 'preview' })}
							onCompare={() => open({ kind: 'compare' })}
							onSource={openSources}
							dateOverride={dates[work.id]}
							notify={notify}
						/>
					) : route.page === 'creator' ? (
						<CreatorPage
							key={creator.id}
							creator={creator}
							followed={followed.has(creator.id)}
							onFollow={() => {
								setFollowed((previous) => {
									const next = new Set(previous);
									if (next.has(creator.id)) {
										next.delete(creator.id);
									} else {
										next.add(creator.id);
									}
									return next;
								});
								notify('已切换关注状态，仅用于本次预览；已收录的示例动态保留。');
							}}
							frequency={frequencies[creator.id] ?? '每小时'}
							onFrequency={(frequency) => setFrequencies((previous) => ({ ...previous, [creator.id]: frequency }))}
							read={read}
							onPost={openPost}
							onRead={toggleRead}
							onWork={openWork}
							saved={saved}
							onSave={toggleSaved}
							notify={notify}
						/>
					) : (
						<UpdatesPage
							read={read}
							filter={feedFilter}
							onFilter={setFeedFilter}
							creatorFilter={creatorFilter}
							onCreatorFilter={setCreatorFilter}
							onPost={openPost}
							onRead={toggleRead}
							onReadAll={(items) => {
								setRead((previous) => new Set([...previous, ...items.map((item) => item.id)]));
								notify('当前筛选列表已标为已读，其他创作者的未读状态保留。');
							}}
							onCreator={openCreator}
							notify={notify}
						/>
					)}
				</main>
				<footer className="preview-footer">
					<Button variant="text" size="text" onClick={() => open({ kind: 'about' })}>
						<i />
						视觉预览 · 虚构内容，不连接原站
					</Button>
					<div className="runtime-indicator" role="status" data-testid="runtime-status" data-phase={bridgeError ? 'error' : runtime.phase}>
						{activeMetadata || runtime.phase === 'starting' ? <LoaderCircle className="spin" /> : bridgeError || runtime.phase === 'error' ? <WifiOff /> : <Check />}
						<span>{activeMetadata?.phase ?? (bridgeError ? '应用通信未就绪' : runtime.phase === 'ready' ? '采集环境就绪' : runtime.message)}</span>
						{activeMetadata && (
							<Button
								variant="text"
								size="text"
								disabled={activeMetadata.status === 'cancelling'}
								onClick={() => {
									void actions.metadata.cancel(activeMetadata.id).catch(() => notify('网络进程已停止，请检查查询状态与应用数据目录。'));
								}}
							>
								取消
							</Button>
						)}
					</div>
				</footer>
			</section>
			<ReviewDialog
				open={dialog !== null && dialog.kind !== 'post'}
				onClose={() => setDialog(null)}
				title={dialogTitle}
				description={dialogDescription}
				wide={dialog?.kind === 'compare'}
				returnFocus={returnFocus}
			>
				{dialogContent}
			</ReviewDialog>
			<UpdateDetailDialog
				open={!!readingPost}
				onClose={() => setDialog(null)}
				title={readingPost?.title || '动态详情'}
				author={readingPost ? creatorFor(readingPost.creatorId).name : ''}
				avatar={readingPost && <Avatar creator={creatorFor(readingPost.creatorId)} />}
				source={readingPost?.source || ''}
				category={readingPost?.type || '动态'}
				image={readingPost?.tile !== undefined ? <Photo tile={readingPost.tile} /> : <FeedImage alt="来源无图" />}
				details={
					readingPost
						? [
								{ label: '发布时间', value: readingPost.publishedAt.replaceAll('.', '/') },
								{ label: '来源页面', value: readingPost.source },
								{ label: '发现时间', value: '示例未提供' },
							]
						: []
				}
				summary={readingPost?.body || ''}
				notice="虚构动态，仅用于视觉确认，未请求原站。"
				onOpenSource={() => notify('原文入口为演示，不会打开或访问真实站点。')}
				returnFocus={returnFocus}
			/>
			{notice && (
				<div className="preview-toast" role="status">
					<Check />
					<span>{notice.message}</span>
				</div>
			)}
		</div>
	);
}

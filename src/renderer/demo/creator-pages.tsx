import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, ExternalLink, Plus, RefreshCw, Settings2, Users } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { FeedImage, FeedItem } from '@/entities/update';
import { OptionSelect } from '@/shared/ui/select';
import { Label } from '@/shared/ui/label';
import { cn } from '@/shared/lib/utils';
import { ArrowLink, Avatar, EmptyState, Photo, Poster, QuietButton, ReviewTabs, SourceMark, StatusBadge, WorkCard } from './components';
import { creatorFor, creators, posts, works, type Creator, type Post, type Work } from './data';

export function PostCard({
	post,
	read,
	onOpen,
	onRead,
	onCreator,
	expanded = false,
}: {
	post: Post;
	read: boolean;
	onOpen: () => void;
	onRead: () => void;
	onCreator: () => void;
	expanded?: boolean;
}): React.JSX.Element {
	const creator = creatorFor(post.creatorId);
	const textual = post.type === '公告' || post.type === '进度更新';
	if (!expanded) {
		return (
			<FeedItem
				className="update-item"
				itemId={post.id}
				title={post.title}
				summary={post.body}
				author={creator.name}
				source={post.source}
				category={post.type}
				read={read}
				image={post.tile !== undefined ? <Photo tile={post.tile} /> : <FeedImage alt="来源无图" />}
				published={
					<span>
						发布 <time dateTime={post.publishedAt.replaceAll('.', '-').replace(' ', 'T')}>{post.publishedAt.replaceAll('.', '/')}</time>
					</span>
				}
				onOpen={onOpen}
				onRead={onRead}
				onAuthor={onCreator}
			/>
		);
	}
	return (
		<article className={cn('creator-feed-card', read && 'is-read')} data-post-id={post.id}>
			<div className="post-content">
				<div className="post-byline">
					<SourceMark source={post.source} />
					<span>{post.source}</span>
					<StatusBadge tone={textual ? 'peach' : 'berry'}>{post.type}</StatusBadge>
					<time dateTime={post.publishedAt.replaceAll('.', '-').replace(' ', 'T')} className="post-time">
						{post.time}
					</time>
				</div>
				<h2 className="post-heading">
					<Button variant="text" size="text" onClick={onOpen}>
						{post.title}
					</Button>
				</h2>
				<p className="post-body">{post.body}</p>
				{post.tile !== undefined && (
					<Button variant="text" size="text" className="creator-feed-image" onClick={onOpen} aria-label={`阅读动态：${post.title}`}>
						<Photo tile={post.tile} />
					</Button>
				)}
				<div className="post-footer">
					<span>
						{post.tile === undefined ? '文字' : '公开'}动态 · {read ? '已读' : '未读'}
					</span>
					<ArrowLink onClick={onOpen}>阅读动态</ArrowLink>
				</div>
			</div>
		</article>
	);
}

type CreatorTab = 'posts' | 'works' | 'identities';
export type Frequency = '每小时' | '每天' | '仅手动';

export function CreatorPage({
	creator,
	followed,
	onFollow,
	frequency,
	onFrequency,
	read,
	onPost,
	onRead,
	onWork,
	saved,
	onSave,
	notify,
}: {
	creator: Creator;
	followed: boolean;
	onFollow: () => void;
	frequency: Frequency;
	onFrequency: (frequency: Frequency) => void;
	read: Set<string>;
	onPost: (post: Post) => void;
	onRead: (post: Post) => void;
	onWork: (work: Work) => void;
	saved: Set<string>;
	onSave: (work: Work) => void;
	notify: (message: string) => void;
}): React.JSX.Element {
	const [tab, setTab] = useState<CreatorTab>('posts');
	const ownPosts = posts.filter((post) => post.creatorId === creator.id);
	const ownWorks = works.filter((work) => work.creatorId === creator.id);

	return (
		<div className="page creator-page">
			<div className="creator-banner">
				<Photo tile={creator.banner} />
				<div className="creator-banner-text">
					The quiet in between.
					<small>LIGHT, EVERYDAY LIFE, AND LITTLE THINGS.</small>
				</div>
			</div>
			<div className="creator-identity">
				<Avatar creator={creator} className="creator-avatar" />
				<div className="creator-name">
					<h1 id="page-heading" tabIndex={-1}>
						{creator.name}
						<span className="identity-mark" title="站点身份关联示例">
							<Check />
						</span>
					</h1>
					<p>
						{creator.handle} / {creator.tagline}
					</p>
				</div>
				<div className="creator-header-actions">
					<Button onClick={onFollow} aria-pressed={followed}>
						{followed ? <Check /> : <Plus />}
						{followed ? '已关注' : '关注创作者'}
					</Button>
					<Button variant="outline" onClick={() => notify(`已演示检查 ${creator.name} 的 ${creator.sites.join('、')}，未访问原站。`)}>
						<RefreshCw />
						检查更新
					</Button>
				</div>
			</div>
			<p className="creator-bio">{creator.bio}</p>
			<div className="creator-account-row">
				{creator.sites.map((source) => (
					<Button variant="text" size="text" key={source} onClick={() => setTab('identities')}>
						<SourceMark source={source} />
						{source}
						<ExternalLink />
					</Button>
				))}
				<span className="separator">|</span>
				<span>{ownPosts.length} 篇示例动态</span>
				<span>{ownWorks.length} 件关联作品</span>
			</div>
			<div className="creator-content">
				<section>
					<ReviewTabs<CreatorTab>
						value={tab}
						onChange={setTab}
						label="创作者内容"
						items={[
							{
								value: 'posts',
								label: (
									<>
										最新动态<small>{ownPosts.length}</small>
									</>
								),
							},
							{
								value: 'works',
								label: (
									<>
										关联作品<small>{ownWorks.length}</small>
									</>
								),
							},
							{ value: 'identities', label: '站点身份' },
						]}
					>
						{tab === 'posts' ? (
							ownPosts.map((post) => (
								<PostCard
									key={post.id}
									post={post}
									read={read.has(post.id)}
									onOpen={() => onPost(post)}
									onRead={() => onRead(post)}
									onCreator={() => {}}
									expanded
								/>
							))
						) : tab === 'works' ? (
							ownWorks.length ? (
								<div className="creator-work-grid">
									{ownWorks.map((work) => (
										<WorkCard key={work.id} work={work} saved={saved.has(work.id)} onOpen={() => onWork(work)} onSave={() => onSave(work)} compact />
									))}
								</div>
							) : (
								<EmptyState title="还没有关联作品">只有已确认的作品关系才会出现在这里。</EmptyState>
							)
						) : (
							creator.sites.map((source) => (
								<div className="source-record" key={source}>
									<div className="source-record-heading">
										<SourceMark source={source} />
										<strong>{source}</strong>
										<StatusBadge tone={followed ? 'success' : 'neutral'}>{followed ? '已关注 · 示例' : '未关注'}</StatusBadge>
									</div>
									<p>
										账号示例：
										{creator.handle.toLowerCase().replaceAll(' ', '-')}
										<br />
										由用户确认关联 · 虚构站点身份
									</p>
									<code className="source-url">
										https://demo.nectisse.invalid/{source.toLowerCase()}
										/creators/{creator.id}
									</code>
									<p className="panel-note">{source === 'FANBOX' ? '范围示例：公开动态与有界分页。' : '范围示例：仅检查公开首页，较早动态可能未覆盖。'}</p>
								</div>
							))
						)}
					</ReviewTabs>
				</section>
				<aside className="creator-aside">
					<section className="aside-block">
						<h2>关注设置</h2>
						<div className="aside-keyvalue">
							<Label htmlFor="check-frequency">检查频率</Label>
							<OptionSelect
								id="check-frequency"
								aria-label="检查频率"
								className="w-28"
								value={frequency}
								onValueChange={onFrequency}
								options={[
									{ value: '每小时', label: '每小时' },
									{ value: '每天', label: '每天' },
									{ value: '仅手动', label: '仅手动' },
								]}
							/>
						</div>
						<div className="aside-keyvalue">
							<span>最近检查示例</span>
							<strong>今天 14:32</strong>
						</div>
						<div className="aside-keyvalue">
							<span>关注状态</span>
							<strong>{followed ? '已关注' : '未关注'}</strong>
						</div>
						<p className="aside-note">频率仅作交互预览，不会启动自动检查。</p>
						<Button variant="outline" size="sm" onClick={() => notify('关注设置仅保留在本次预览中，不会执行定时任务。')}>
							<Settings2 />
							调整关注设置
						</Button>
					</section>
					<section className="aside-block">
						<h2>关注的来源</h2>
						{creator.sites.map((source) => (
							<div key={source} className="aside-source-group">
								<div className="aside-source">
									<SourceMark source={source} />
									{source}
									<StatusBadge tone={source === 'FANBOX' ? 'success' : 'neutral'}>{source === 'FANBOX' ? '分页示例' : '公开首页'}</StatusBadge>
								</div>
								<p className="aside-note">{source === 'FANBOX' ? '公开动态 · 向前翻页需设置范围。' : '仅检查公开首页，较早动态可能未覆盖。'}</p>
							</div>
						))}
					</section>
					<section className="aside-block">
						<div className="aside-heading">
							<h2>关联作品</h2>
							<ArrowLink onClick={() => setTab('works')}>查看全部</ArrowLink>
						</div>
						{ownWorks.length ? (
							ownWorks.map((work) => (
								<Button variant="text" size="text" key={work.id} className="related-work" onClick={() => onWork(work)}>
									<Poster work={work} text={false} />
									<span>
										{work.title}
										<small>
											{work.id}
											<br />
											{work.year} · 摄影作品
										</small>
									</span>
									<ChevronRight size={13} />
								</Button>
							))
						) : (
							<p>暂无已确认的关联作品。</p>
						)}
					</section>
				</aside>
			</div>
		</div>
	);
}

export function UpdatesPage({
	read,
	filter,
	onFilter,
	creatorFilter,
	onCreatorFilter,
	onPost,
	onRead,
	onReadAll,
	onCreator,
	notify,
}: {
	read: Set<string>;
	filter: 'unread' | 'all';
	onFilter: (filter: 'unread' | 'all') => void;
	creatorFilter: string;
	onCreatorFilter: (id: string) => void;
	onPost: (post: Post) => void;
	onRead: (post: Post) => void;
	onReadAll: (posts: readonly Post[]) => void;
	onCreator: (creator: Creator) => void;
	notify: (message: string) => void;
}): React.JSX.Element {
	const unread = posts.filter((post) => !read.has(post.id)).length;
	const displayed = posts.filter((post) => (!creatorFilter || post.creatorId === creatorFilter) && (filter === 'all' || !read.has(post.id)));
	const grouped = new Map<string, Post[]>();
	for (const post of displayed) {
		const date = post.publishedAt.slice(0, 10);
		const group = grouped.get(date) ?? [];
		group.push(post);
		grouped.set(date, group);
	}
	return (
		<div className="page updates-page">
			<div className="page-heading">
				<div>
					<p className="eyebrow">FROM THE CREATORS YOU FOLLOW</p>
					<h1 id="page-heading" tabIndex={-1}>
						更新
					</h1>
					<p>{unread ? `有 ${unread} 条未读动态，来自你关注的创作者。` : '这一刻，没有待阅读的新动态。'}</p>
				</div>
				<Button onClick={() => notify(`已演示检查全部 ${creators.length} 位创作者；当前仅展示内置动态。`)}>
					<RefreshCw />
					检查更新
					<ChevronDown />
				</Button>
			</div>
			<div className="updates-layout">
				<section>
					<div className="feed-filterbar">
						<ReviewTabs<'unread' | 'all'>
							value={filter}
							onChange={onFilter}
							label="已读筛选"
							segmented
							items={[
								{
									value: 'unread',
									label: (
										<>
											未读<small>{unread}</small>
										</>
									),
								},
								{ value: 'all', label: '全部动态' },
							]}
						/>
						<QuietButton onClick={() => onReadAll(displayed)} disabled={!displayed.some((post) => !read.has(post.id))}>
							<Check />
							当前列表全部已读
						</QuietButton>
					</div>
					<p className="check-status">
						<Check />
						14:32 检查完成示例<span>·</span>仅展示内置动态
					</p>
					{creatorFilter && (
						<div className="creator-filter-summary">
							正在查看：{creatorFor(creatorFilter).name}
							<QuietButton onClick={() => onCreatorFilter('')}>清除筛选</QuietButton>
						</div>
					)}
					{displayed.length ? (
						Array.from(grouped, ([date, group]) => (
							<section key={date} aria-label={date}>
								<h2 className="day-label">{date === '2026.10.23' ? '今天 · 10 月 23 日' : date === '2026.10.22' ? '昨天 · 10 月 22 日' : '10 月 21 日'}</h2>
								<div className="feed-items">
									{group.map((post) => (
										<PostCard
											key={post.id}
											post={post}
											read={read.has(post.id)}
											onOpen={() => onPost(post)}
											onRead={() => onRead(post)}
											onCreator={() => onCreator(creatorFor(post.creatorId))}
										/>
									))}
								</div>
							</section>
						))
					) : (
						<EmptyState title="未读已清空，随时回来看看。" action={{ label: '查看全部动态', onClick: () => onFilter('all') }}>
							已读状态仅保留在本次预览中。
						</EmptyState>
					)}
					<p className="feed-end">{displayed.length ? '已经看到本次示例列表的最后一条。' : '没有进行历史抓取或网络检查。'}</p>
				</section>
				<aside className="updates-aside">
					<section className="aside-block">
						<h2>按创作者查看</h2>
						<Button
							variant="text"
							size="text"
							className={cn('creator-filter', !creatorFilter && 'selected')}
							onClick={() => onCreatorFilter('')}
							aria-pressed={!creatorFilter}
						>
							<Users />
							<span>全部创作者</span>
							<small>{creators.length}</small>
						</Button>
						{creators.map((creator) => {
							const count = posts.filter((post) => post.creatorId === creator.id && !read.has(post.id)).length;
							return (
								<Button
									variant="text"
									size="text"
									key={creator.id}
									className={cn('creator-filter', creatorFilter === creator.id && 'selected')}
									onClick={() => onCreatorFilter(creator.id)}
									aria-pressed={creatorFilter === creator.id}
								>
									<Avatar creator={creator} />
									<span>{creator.name}</span>
									{count > 0 && <small>{count}</small>}
								</Button>
							);
						})}
						<QuietButton className="manage-follow" onClick={() => onCreator(creatorFor(creatorFilter))}>
							管理关注
							<ChevronRight />
						</QuietButton>
					</section>
					<section className="aside-block">
						<h2>来源状态 · 示例</h2>
						{(['FANBOX', 'Patreon'] as const).map((source) => (
							<div className="aside-keyvalue" key={source}>
								<span>
									<SourceMark source={source} />
									{source}
								</span>
								<StatusBadge tone={source === 'Patreon' ? 'neutral' : 'success'}>{source === 'Patreon' ? '公开首页' : '公开动态'}</StatusBadge>
							</div>
						))}
						<p className="aside-note">站点能力尚未验证；公告和进度更新也出现在动态中。</p>
					</section>
					<section className="aside-block">
						<h2>只看你在意的更新</h2>
						<p>
							新作品、拍摄手记、公告，
							<br />
							还有那些尚在进行中的想法。
						</p>
					</section>
				</aside>
			</div>
		</div>
	);
}

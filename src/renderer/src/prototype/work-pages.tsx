import { useState } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Clock3, Download, ExternalLink, Grid2X2, Image, Info, LockKeyhole, Plus, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { OptionSelect } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { ArrowLink, Avatar, CoverChoice, EmptyState, Poster, QuietButton, ReviewTabs, StatusBadge, WorkCard } from './components';
import { creatorFor, dateLabel, sourceUrl, works, type Site, type Work } from './data';
import { SourceProvenance, type SourceSnapshot } from '../metadata/SourceProvenance';

export function QueryPage({
	query,
	submittedQuery,
	onChange,
	onSubmit,
	selectedSources,
	onSource,
	recent,
	onRecent,
	onReset,
	saved,
	onOpen,
	onSave,
	notify,
}: {
	query: string;
	submittedQuery: string;
	onChange: (query: string) => void;
	onSubmit: () => void;
	selectedSources: Set<Site>;
	onSource: (source: Site) => void;
	recent: string[];
	onRecent: (query: string) => void;
	onReset: () => void;
	saved: Set<string>;
	onOpen: (work: Work) => void;
	onSave: (work: Work) => void;
	notify: (message: string) => void;
}): React.JSX.Element {
	const [sort, setSort] = useState('relevance');
	const term = submittedQuery.trim().toLocaleLowerCase();
	const results = works
		.filter((work) => {
			const creator = creatorFor(work.creatorId);
			const matches =
				!term ||
				[work.id, work.title, work.translation, work.english, creator.name].some((value) => value.toLocaleLowerCase().includes(term)) ||
				term.includes(work.id.toLowerCase());
			return matches && work.sources.some((source) => selectedSources.has(source));
		})
		.toSorted((a, b) => (sort === 'newest' ? b.releaseDate.localeCompare(a.releaseDate) : 0));
	return (
		<div className="page query-page">
			<div className="page-heading">
				<div>
					<p className="eyebrow">WORKS & THEIR STORIES</p>
					<h1 id="page-heading" tabIndex={-1}>
						资料查询
					</h1>
					<p>从一个编号、一段片名，或一个原站链接开始。</p>
				</div>
				<QuietButton onClick={() => notify('最近查询显示在页面下方，仅保留本次演示记录。')}>
					查询记录
					<Clock3 />
				</QuietButton>
			</div>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					onSubmit();
				}}
				className="query-box"
			>
				<div className="query-input-row">
					<Search size={21} strokeWidth={1.5} />
					<Input
						id="work-query"
						aria-label="作品编号、标题或原站链接"
						value={query}
						onChange={(event) => onChange(event.target.value)}
						placeholder="作品编号、标题或原站链接"
						autoComplete="off"
						spellCheck={false}
					/>
					<Button type="submit" size="lg">
						查询资料
						<ChevronRight />
					</Button>
				</div>
				<div className="query-source-row">
					<span>资料来源</span>
					{(['DMM', 'r18.dev', 'JavDB'] as const).map((source) => (
						<Button
							variant="outline"
							size="sm"
							key={source}
							type="button"
							className={cn('source-chip', !selectedSources.has(source) && 'inactive')}
							aria-pressed={selectedSources.has(source)}
							onClick={() => onSource(source)}
						>
							{selectedSources.has(source) ? <Check /> : <Plus />}
							{source === 'DMM' ? 'DMM / FANZA' : source}
						</Button>
					))}
					<Button variant="ghost" size="sm" type="button" className="source-auto" onClick={() => notify('来源选项仅筛选内置示例；当前没有站点连接器。')}>
						自动匹配来源
						<ChevronDown />
					</Button>
				</div>
			</form>
			<p className="query-caption">
				<Info />
				按标题查询时，先确认作品，再保存资料。当前仅查询本地模拟数据。
			</p>
			<div className="section-heading">
				<h2>
					查询结果<small>{results.length} 个示例候选</small>
				</h2>
				<div className="section-tools">
					<OptionSelect
						aria-label="查询结果排序"
						className="w-36"
						value={sort}
						onValueChange={setSort}
						options={[
							{ value: 'relevance', label: '相关度' },
							{ value: 'newest', label: '发行日期 · 最新' },
						]}
					/>
					<Grid2X2 size={15} />
				</div>
			</div>
			{results.length ? (
				<div className="result-grid">
					{results.map((work) => (
						<WorkCard key={work.id} work={work} saved={saved.has(work.id)} onOpen={() => onOpen(work)} onSave={() => onSave(work)} />
					))}
				</div>
			) : (
				<EmptyState title={selectedSources.size ? '没有匹配的示例作品' : '先选择一个资料来源'} action={{ label: '查看全部示例', onClick: onReset }}>
					可尝试“午後”“NECT-024”或“白石 澪”。这不是原站搜索结果。
				</EmptyState>
			)}
			<div className="query-recent">
				<span>最近查询</span>
				{recent.map((value) => (
					<Button variant="text" size="text" key={value} onClick={() => onRecent(value)}>
						<Clock3 />
						{value}
					</Button>
				))}
			</div>
		</div>
	);
}

export interface DateOverride {
	value: string;
	manual: boolean;
}
type DetailTab = 'info' | 'covers' | 'sources';

export function WorkDetail({
	work,
	selectedCover,
	onCover,
	saved,
	onSave,
	onQuery,
	onCreator,
	onPreview,
	onCompare,
	onSource,
	dateOverride,
	notify,
}: {
	work: Work;
	selectedCover: number;
	onCover: (index: number) => void;
	saved: boolean;
	onSave: () => void;
	onQuery: () => void;
	onCreator: () => void;
	onPreview: () => void;
	onCompare: () => void;
	onSource: () => void;
	dateOverride?: DateOverride;
	notify: (message: string) => void;
}): React.JSX.Element {
	const [tab, setTab] = useState<DetailTab>('info');
	const creator = creatorFor(work.creatorId);
	const cover = work.covers[selectedCover] ?? work.covers[0]!;
	const release = dateOverride?.value ?? work.releaseDate;
	const snapshots: SourceSnapshot[] = work.sources.map((source, index) => ({
		id: source,
		name: source === 'DMM' ? 'DMM / FANZA' : source,
		url: sourceUrl(work, source),
		fetchedAt: '2026-10-23T06:32:00.000Z',
		contentId: work.id,
		parserVersion: '视觉演示',
		warnings: [],
		fields: [
			{ key: 'title', label: '标题', value: work.title },
			{ key: 'releaseDate', label: '发行日期', value: index ? work.mirrorDate : work.releaseDate },
			{ key: 'studio', label: '厂牌', value: work.publisher },
			{ key: 'series', label: '系列', value: index ? '' : work.series },
			{ key: 'people', label: '创作者', value: index ? '' : creator.name },
			{ key: 'tags', label: '标签', value: index ? '' : work.tags.join('、') },
			{ key: 'description', label: '简介', value: index ? '' : work.summary },
		],
	}));
	return (
		<div className="page detail-page">
			<div className="detail-top">
				<QuietButton onClick={onQuery}>
					<ArrowLeft />
					返回查询结果
				</QuietButton>
				<QuietButton onClick={() => notify(`已演示刷新 ${work.id}；没有发出网络请求。`)}>
					<RefreshCw />
					刷新这部作品
				</QuietButton>
			</div>
			<div className="detail-layout">
				<section className="detail-art" aria-label="作品封面">
					<Button variant="text" size="text" className="cover-preview-button" onClick={onPreview} aria-label="预览当前封面">
						<Poster work={work} tile={cover.tile} className="cover-main" />
					</Button>
					<div className="cover-caption">
						<span>
							<Image />
							{cover.title} · {cover.dimensions}
						</span>
						<QuietButton onClick={onPreview}>
							查看原图
							<ExternalLink />
						</QuietButton>
					</div>
					<div className="cover-thumbs">
						{work.covers.map((candidate, index) => (
							<Button
								variant="text"
								size="text"
								key={index}
								className={cn('cover-thumb', selectedCover === index && 'selected')}
								aria-label={`查看封面候选 ${index + 1}`}
								aria-pressed={selectedCover === index}
								onClick={() => onCover(index)}
							>
								<Poster work={work} tile={candidate.tile} text={false} />
							</Button>
						))}
						<Button variant="text" size="text" className="cover-more" onClick={() => setTab('covers')}>
							全部 {work.covers.length} 张
						</Button>
					</div>
				</section>
				<section className="work-info">
					<p className="eyebrow">WORK / {work.id}</p>
					<h1 id="page-heading" tabIndex={-1} className="detail-title">
						{work.title}
					</h1>
					<p className="detail-subtitle">
						{work.translation}
						<small>摄影作品 · {work.year}</small>
					</p>
					<div className="detail-status">
						<StatusBadge tone="success">
							<Check />
							作品身份匹配示例
						</StatusBadge>
						<StatusBadge>{work.sources.length} 个资料来源</StatusBadge>
						<StatusBadge>{work.covers.length} 张封面</StatusBadge>
					</div>
					<ReviewTabs<DetailTab>
						value={tab}
						onChange={setTab}
						label="作品详情分区"
						items={[
							{ value: 'info', label: '作品资料' },
							{
								value: 'covers',
								label: (
									<>
										封面<small>{work.covers.length}</small>
									</>
								),
							},
							{
								value: 'sources',
								label: (
									<>
										来源<small>{work.sources.length}</small>
									</>
								),
							},
						]}
					>
						{tab === 'info' ? (
							<>
								<div className="work-credit">
									<Avatar creator={creator} />
									<div>
										<Button variant="text" size="text" className="credit-name" onClick={onCreator}>
											{creator.name}
										</Button>
										<p>创作者 · {creator.handle}</p>
									</div>
									<ArrowLink onClick={onCreator}>创作者主页</ArrowLink>
								</div>
								<dl className="facts-grid">
									<div>
										<dt>作品编号</dt>
										<dd>
											{work.id}
											<span className="field-dot" title="来源字段示例" />
										</dd>
									</div>
									<div>
										<dt>发行日期</dt>
										<dd>
											<Button variant="text" size="text" onClick={onSource} className="field-value">
												{dateLabel(release)}
												{dateOverride?.manual ? <LockKeyhole size={12} /> : <Info size={12} />}
											</Button>
										</dd>
									</div>
									<div>
										<dt>厂牌</dt>
										<dd>
											{work.publisher}
											<span className="field-dot" />
										</dd>
									</div>
									<div>
										<dt>系列</dt>
										<dd>
											{work.series}
											<span className="field-dot" />
										</dd>
									</div>
									<div>
										<dt>作品类型</dt>
										<dd>摄影作品集</dd>
									</div>
									<div>
										<dt>资料来源</dt>
										<dd>{work.sources.join(' · ')}</dd>
									</div>
								</dl>
								{work.sources.length > 1 && (
									<Button variant="text" size="text" className="conflict-note" onClick={onSource}>
										<Info />
										<span>
											{dateOverride ? `已${dateOverride.manual ? '手动修正并锁定' : '选择采用值'}，查看来源记录` : '发行日期存在 2 个来源值，可查看并选择'}
										</span>
										<ChevronRight />
									</Button>
								)}
								<h2 className="summary-title">标签</h2>
								<div className="tag-row">
									{work.tags.map((tag) => (
										<StatusBadge key={tag}>{tag}</StatusBadge>
									))}
								</div>
								<h2 className="summary-title">作品简介</h2>
								<p className="summary-text">{work.summary}</p>
								<p className="micro-note">虚构作品与简介，仅供布局预览。</p>
							</>
						) : tab === 'covers' ? (
							<>
								<div className="section-heading">
									<h2>
										选择作品封面<small>{work.covers.length} 个候选</small>
									</h2>
								</div>
								<div className="cover-candidates">
									{work.covers.map((candidate, index) => (
										<CoverChoice key={index} work={work} cover={candidate} selected={selectedCover === index} onChoose={() => onCover(index)} />
									))}
								</div>
								<p className="panel-note">来源、尺寸与核验状态均为示例。素材为生成摄影图集，选择只改变本次预览。</p>
								<Button variant="outline" size="sm" onClick={onCompare}>
									<Image />
									并排比较
								</Button>
							</>
						) : (
							<SourceProvenance
								snapshots={snapshots}
								demo
								onOpenSource={() => notify('这是 .invalid 示例链接，不会打开或请求真实站点。')}
								onResolveDifference={work.sources.length > 1 ? onSource : undefined}
								preferredValues={
									dateOverride
										? {
												releaseDate: {
													value: dateOverride.value,
													source: dateOverride.manual
														? '手动修正 · 已锁定（演示）'
														: (snapshots.find((snapshot) =>
																snapshot.fields.some((field) => field.key === 'releaseDate' && field.value === dateOverride.value),
															)?.name ?? '本次预览采用值'),
												},
											}
										: undefined
								}
							/>
						)}
					</ReviewTabs>
					<div className="detail-actions">
						<Button onClick={onSave}>
							{saved ? <Check /> : <Plus />}
							{saved ? '已保存 · 演示' : '保存到作品档案'}
						</Button>
						<Button variant="outline" onClick={() => notify('封面导出入口预览；当前不会创建或保存文件。')}>
							<Download />
							导出封面
						</Button>
					</div>
					<p className="source-footnote">
						<Clock3 />
						资料获取于 2026.10.23 14:32 · 模拟记录
					</p>
				</section>
			</div>
		</div>
	);
}

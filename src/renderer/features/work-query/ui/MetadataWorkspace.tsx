import { useMetadata, useMetadataStatus, useSubscriptions, useDesktopActions, useSubscriptionStatus } from '@/shared/desktop';
import { firstAvailableField, WorkDetail, CoverImage } from '@/entities/work';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { preferredCover } from '@shared/cover-selection';
import { Check, ChevronRight, Clock3, Info, LoaderCircle, RefreshCw, Search, Square, X } from 'lucide-react';
import { MetadataSourcePicker } from './MetadataSourcePicker';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/shared/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/ui/table';
import { toast } from '@/shared/ui/sonner';
import { EmptyState } from '@/shared/components/empty-state';
import { PageHeader, PageToolbar } from '@/shared/components/page-layout';
import { Input } from '@/shared/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert';
import { QuietButton } from '@/shared/components/quiet-button';
import { StatusBadge } from '@/shared/components/status-badge';
import { SOURCE_LABELS, isActiveTask, type SourceId, type QueryTask, type MetadataRecord } from '@shared/metadata';
import { LEGACY_METADATA_IDS } from '@shared/sources';

const statusLabels = { running: '查询中', cancelling: '正在取消', cancelled: '已取消', succeeded: '已完成', partial: '部分取得', failed: '未取得', interrupted: '已中断' };

function groupRecordsByCode(records: MetadataRecord[], order: readonly SourceId[]): MetadataRecord[][] {
	const map = new Map<string, MetadataRecord[]>();
	const priority: readonly string[] = [...order, ...LEGACY_METADATA_IDS];
	for (const record of records) {
		map.set(record.code, [...(map.get(record.code) ?? []), record]);
	}
	return [...map.values()].map((group) => group.toSorted((a, b) => priority.indexOf(a.source) - priority.indexOf(b.source)));
}

const fetched = (value: string): string => new Date(value).toLocaleString('zh-CN', { hour12: false });

interface SaveActionInput {
	taskId: string;
	code: string;
	coverId?: string;
	disabled?: boolean;
	allowUpdate?: boolean;
}

function SourceStatus({ task }: { task: QueryTask }): React.JSX.Element {
	return (
		<div className="live-source-status">
			{task.plan.sources.map((source) => {
				const outcome = task.outcomes.find((outcome) => outcome.source === source);

				return (
					<div key={source}>
						<strong>{SOURCE_LABELS[source]}</strong>
						<span className={outcome?.status === 'error' || outcome?.status === 'partial' ? 'source-problem' : ''}>
							{outcome
								? outcome.status === 'success' && !task.records.some((record) => record.source === source)
									? '没有返回候选；来源未说明具体原因'
									: outcome.status === 'success'
										? '资料已取得'
										: outcome.message
								: isActiveTask(task)
									? '等待或查询中'
									: '未执行'}
						</span>
						{outcome && outcome.retryAfter > 0 && <small>本次冷却 {outcome.retryAfter} 秒</small>}
					</div>
				);
			})}
		</div>
	);
}

export default function MetadataWorkspace({
	seed,
	onPerformer,
	renderSaveAction,
}: { seed?: { query: string; token: number }; onPerformer?: (name: string) => void; renderSaveAction?: (input: SaveActionInput) => ReactNode } = {}): React.JSX.Element {
	const actions = useDesktopActions();
	const subscriptionState = useSubscriptions((state) => ({ preferences: state.preferences }));
	const { invoke } = useDesktopActions();
	const { reading } = useSubscriptionStatus();

	useEffect(() => {
		if (seed) {
			setQuery(seed.query);
			setSelectedCode('');
		}
	}, [seed]);

	const state = useMetadata((state) => state);
	const { error: metadataError } = useMetadataStatus();
	const [query, setQuery] = useState('');
	const [savingSources, setSavingSources] = useState(false);
	const [selectedTaskId, setSelectedTaskId] = useState('');
	const [selectedCode, setSelectedCode] = useState('');

	useEffect(() => {
		if (seed && !selectedCode) {
			document.getElementById('work-query')?.focus();
		}
	}, [seed, selectedCode]);

	const initializationError = !!metadataError;
	const [submitting, setSubmitting] = useState(false);
	const [recentOpen, setRecentOpen] = useState(false);
	const historyTrigger = useRef<HTMLButtonElement | null>(null);
	const historyTitle = useRef<HTMLHeadingElement | null>(null);

	useEffect(() => {
		document.querySelector('.page-scroll')?.scrollTo({ top: 0, behavior: 'instant' });
	}, [selectedCode]);

	const task = state.tasks.find((task) => task.id === selectedTaskId) ?? state.tasks[0];
	const active = state.tasks.find((task) => task.id === state.activeId);
	const busy = submitting || !!active || savingSources || reading;
	const sources = subscriptionState.preferences.querySources;
	const activeSources = sources.filter((source) => subscriptionState.preferences.enabledSources.includes(source));
	const currentGroups = groupRecordsByCode(task?.records ?? [], subscriptionState.preferences.metadataPriority);
	const selectedRecords = currentGroups.find((group) => group[0]?.code === selectedCode);

	const saveSources = async (sources: SourceId[]): Promise<void> => {
		if (busy) {
			return;
		}
		setSavingSources(true);
		try {
			const reply = await invoke({ action: 'query-sources', sources });
			if (!reply.ok) {
				toast.error(reply.message || '资料来源未能保存，请重试。', { id: 'query-sources-save' });
			}
		} finally {
			setSavingSources(false);
		}
	};

	const retryInitialization = async (): Promise<void> => {
		setSubmitting(true);
		try {
			await actions.reloadMetadata();
		} finally {
			setSubmitting(false);
		}
	};

	const submit = async (force = false, value = query): Promise<void> => {
		if (!value.trim() || !activeSources.length || busy) {
			return;
		}
		setSubmitting(true);
		setSelectedCode('');
		try {
			const reply = await actions.metadata.query({ query: value, sources: activeSources, force });
			if (reply.ok && reply.taskId) {
				setSelectedTaskId(reply.taskId);
				if (reply.cached) {
					toast.info('已读取本地查询结果', { id: 'metadata-query', description: '结果保留 1 小时；重新采集可发起新查询。' });
				}
			} else {
				toast.error(reply.message || '无法开始查询', { id: 'metadata-query', duration: 8000 });
			}
		} catch {
			toast.error('无法开始查询，请检查输入与运行环境。', { id: 'metadata-query', duration: 8000 });
		} finally {
			setSubmitting(false);
		}
	};

	if (task && selectedRecords) {
		return (
			<>
				<WorkDetail
					key={`${task.id}-${selectedCode}`}
					records={selectedRecords}
					task={task}
					onPerformer={onPerformer}
					onOpenSource={(recordId) => {
						void actions.metadata.openSource(task.id, recordId);
					}}
					headerActions={renderSaveAction?.({
						taskId: task.id,
						code: selectedRecords[0]!.code,
						coverId: preferredCover(
							selectedRecords.flatMap((record) => record.covers),
							task.coverPriority,
						)?.id,
						disabled: isActiveTask(task),
						allowUpdate: true,
					})}
					onBack={() => setSelectedCode('')}
					onRefresh={() => {
						setQuery(selectedCode);
						void submit(true, selectedCode);
					}}
				/>
				{active && (
					<div className="live-floating-task">
						<LoaderCircle className="spin" />
						{active.phase}
						<Button
							variant="outline"
							size="sm"
							disabled={active.status === 'cancelling'}
							onClick={() => {
								void actions.metadata.cancel(active.id).catch(() => toast.error('取消状态保存失败，网络进程已停止。', { id: 'metadata-cancel', duration: 8000 }));
							}}
						>
							取消查询
						</Button>
					</div>
				)}
			</>
		);
	}
	return (
		<div className="page query-page live-query" data-testid="live-query">
			<PageHeader
				title="资料查询"
				description="查询作品资料与封面，留下每项信息的来处。"
				actions={
					<Button ref={historyTrigger} variant="outline" size="sm" onClick={() => setRecentOpen(true)} aria-haspopup="dialog" aria-expanded={recentOpen}>
						<Clock3 />
						查询记录
					</Button>
				}
			/>
			<form
				className="query-box"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<div className="query-input-row">
					<Search size={21} strokeWidth={1.5} />
					<Input
						id="work-query"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						aria-label="作品编号、标题或原站链接"
						placeholder="作品编号、标题或原站链接，例如 SSIS-057"
						autoComplete="off"
						spellCheck={false}
					/>
					<Button type="submit" size="lg" disabled={busy || query.trim().length < 2 || !activeSources.length}>
						{submitting ? <LoaderCircle className="spin" /> : null}查询资料
						<ChevronRight />
					</Button>
				</div>
				<MetadataSourcePicker
					selected={sources}
					enabled={subscriptionState.preferences.enabledSources}
					busy={busy}
					onChange={(next) => {
						void saveSources(next);
					}}
				/>
			</form>
			<p className="query-caption">
				<Info />
				标题目前由 DMM 返回最多 3 个候选；FC2 在线可用性待验证，仅解析商品字段，不推断出演人物。
			</p>
			{initializationError && (
				<Alert className="live-message">
					<Info />
					<AlertTitle>查询服务暂未就绪</AlertTitle>
					<AlertDescription className="live-initialization-recovery">
						<span>本机查询记录或缓存未能准备完成，可在恢复存储访问后重新检查。</span>
						<Button
							variant="outline"
							size="sm"
							disabled={submitting}
							onClick={() => {
								void retryInitialization();
							}}
						>
							重新检查查询服务
						</Button>
					</AlertDescription>
				</Alert>
			)}
			{state.notice && (
				<Alert className="live-message">
					<Info />
					<AlertTitle>资料查询</AlertTitle>
					<AlertDescription>{state.notice}</AlertDescription>
				</Alert>
			)}
			{active && (
				<div className="live-task-progress" role="status">
					<LoaderCircle className="spin" />
					<div>
						<strong>{active.phase}</strong>
						<p>限当前输入及所选来源，最多 24 个网络请求，无自动重试。</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						disabled={active.status === 'cancelling'}
						onClick={() => {
							void actions.metadata
								.cancel(active.id)
								.catch(() => toast.error('取消状态保存失败，网络进程已停止，请检查应用数据目录。', { id: 'metadata-cancel', duration: 8000 }));
						}}
					>
						<Square />
						{active.status === 'cancelling' ? '正在取消' : '取消查询'}
					</Button>
				</div>
			)}
			<Dialog open={recentOpen} onOpenChange={setRecentOpen}>
				<DialogContent className="query-history-dialog" finalFocus={historyTrigger} initialFocus={historyTitle}>
					<header className="query-history-header">
						<div>
							<DialogTitle ref={historyTitle} tabIndex={-1}>
								查询记录
							</DialogTitle>
							<DialogDescription>选择记录，查看已保存在本机的查询结果。</DialogDescription>
						</div>
						<DialogClose render={<Button className="query-history-close" variant="ghost" size="icon-sm" aria-label="关闭查询记录" />}>
							<X />
						</DialogClose>
					</header>
					<div className="query-history-scroll">
						{state.tasks.length ? (
							<Table className="query-history-table" aria-label="本地查询记录">
								<TableHeader>
									<TableRow>
										<TableHead>查询内容</TableHead>
										<TableHead className="query-history-time-cell">查询时间</TableHead>
										<TableHead className="query-history-status-cell">状态</TableHead>
										<TableHead className="query-history-indicator-cell">
											<span className="sr-only">当前记录</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{state.tasks.map((previous) => {
										const date = new Date(previous.startedAt);
										return (
											<TableRow
												key={previous.id}
												className="query-history-row"
												data-current={previous.id === task?.id || undefined}
												onClick={() => {
													setSelectedTaskId(previous.id);
													setSelectedCode('');
													setQuery(previous.plan.query);
													setRecentOpen(false);
													document.querySelector('.page-scroll')?.scrollTo({ top: 0, behavior: 'instant' });
												}}
											>
												<TableCell>
													<Button
														variant="text"
														size="text"
														className="query-history-open"
														aria-current={previous.id === task?.id ? 'true' : undefined}
														aria-label={`查看查询记录 ${previous.plan.query}`}
													>
														<span className="query-history-query" title={previous.plan.query}>
															{previous.plan.query}
														</span>
														<small>{new Set(previous.records.map((record) => record.code)).size} 部作品</small>
													</Button>
												</TableCell>
												<TableCell className="query-history-time-cell">
													<time dateTime={previous.startedAt} title={fetched(previous.startedAt)} aria-label={fetched(previous.startedAt)}>
														<span>{date.toLocaleDateString('zh-CN')}</span>
														<small>{date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</small>
													</time>
												</TableCell>
												<TableCell className="query-history-status-cell">
													<StatusBadge tone={previous.status === 'succeeded' ? 'success' : previous.status === 'partial' ? 'peach' : 'neutral'}>
														{statusLabels[previous.status]}
													</StatusBadge>
												</TableCell>
												<TableCell className="query-history-indicator-cell">{previous.id === task?.id && <Check aria-label="当前记录" />}</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						) : (
							<EmptyState compact headingLevel={3} icon={Clock3} title="还没有查询记录" description="查询作品后，可以在这里重新查看结果。" />
						)}
					</div>
					<footer className="query-history-footer">
						<span>{state.tasks.length} 条记录</span>
						<DialogClose render={<Button variant="outline" size="sm" />}>关闭</DialogClose>
					</footer>
				</DialogContent>
			</Dialog>
			{task ? (
				<>
					<PageToolbar
						label="查询结果工具栏"
						className="query-results-toolbar"
						actions={
							<>
								<StatusBadge tone={task.status === 'succeeded' ? 'success' : task.status === 'partial' ? 'peach' : 'neutral'}>
									{statusLabels[task.status]}
								</StatusBadge>
								<QuietButton
									disabled={busy}
									onClick={() => {
										setQuery(task.plan.query);
										void submit(true, task.plan.query);
									}}
								>
									<RefreshCw />
									重新采集
								</QuietButton>
							</>
						}
					>
						<h2>查询结果</h2>
						<span className="page-toolbar-count">
							{currentGroups.length} 部作品 · {task.records.length} 条来源记录
						</span>
					</PageToolbar>
					{currentGroups.length ? (
						<div className="result-grid live-result-grid">
							{currentGroups.map((records) => {
								const cover = preferredCover(
									records.flatMap((record) => record.covers),
									task.coverPriority,
								);
								return (
									<article className="work-card" key={records[0]!.code}>
										<Button
											variant="text"
											size="text"
											className="live-card-open"
											onClick={() => setSelectedCode(records[0]!.code)}
											aria-label={`查看真实作品 ${records[0]!.code}`}
										>
											<CoverImage cover={cover} />
											<span className="work-code">
												<span>{records[0]!.code}</span>
												<span className="match-label">
													<Check size={11} />
													来源身份已核对
												</span>
											</span>
											<h3>{firstAvailableField(records, 'title') || '标题未取得'}</h3>
										</Button>
										<p className="work-byline">
											{firstAvailableField(records, 'releaseDate') || '日期未取得'}
											<i />
											{records.map((record) => SOURCE_LABELS[record.source]).join(' · ')}
										</p>
										<p className="live-card-caption">
											{cover?.asset ? `${cover.asset.width} × ${cover.asset.height} · 已缓存来源封面` : cover?.error || '资料已保留，封面尚未取得'}
										</p>
										{renderSaveAction?.({ taskId: task.id, code: records[0]!.code, coverId: cover?.id, disabled: isActiveTask(task) })}
									</article>
								);
							})}
						</div>
					) : (
						<EmptyState
							icon={Search}
							title={
								isActiveTask(task)
									? '正在等待来源返回资料'
									: task.status === 'cancelled'
										? '这次查询已取消'
										: task.status === 'interrupted'
											? '上次查询已中断'
											: '本次没有取得可采用资料'
							}
							description={task.status === 'cancelled' ? '已停止后续请求；重开应用不会恢复这次任务。' : '来源失败与没有作品分别记录；可在下方查看具体原因。'}
						/>
					)}
					<SourceStatus task={task} />
					<p className="source-footnote">
						<Clock3 />
						{fetched(task.startedAt)} · {task.requests} 个请求 · 原文链接与来源原值保留在详情中
					</p>
				</>
			) : (
				<div className="live-welcome">
					<div className="live-welcome-icon">
						<Search strokeWidth={1.2} />
					</div>
					<p className="eyebrow">A PLACE FOR THEIR STORIES</p>
					<h2>从一部值得留下的作品开始。</h2>
					<p>
						输入编号查找资料，或输入标题确认候选。
						<br />
						每个来源独立记录，失败也会清楚地告诉你。
					</p>
					<div className="live-examples">
						<span>例如</span>
						{['SSIS-057', 'MIDV-012'].map((code) => (
							<Button variant="text" size="text" key={code} onClick={() => setQuery(code)}>
								{code}
								<ChevronRight size={11} />
							</Button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

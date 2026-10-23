import { useEffect, useState } from 'react';
import { ArrowLeft, Bookmark, Images, LoaderCircle, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { EmptyState } from '@/components/empty-state';
import { PageHeader, PageToolbar } from '@/components/page-layout';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { OptionSelect } from '@/components/ui/select';
import { ReviewTabs } from '../prototype/components';
import { CoverImage, RealDetail } from '../metadata/MetadataWorkspace';
import type { SavedWork } from '../../../shared/library';
import { useLibrary } from './context';

export function LibraryPage({ seed, onQuery }: { seed?: { id: string; token: number }; onQuery: (code: string) => void }): React.JSX.Element {
	const { state, loading, error, reload } = useLibrary();
	const [view, setView] = useState<'cards' | 'wall'>('cards');
	const [search, setSearch] = useState('');
	const [sort, setSort] = useState('saved');
	const [visible, setVisible] = useState(60);
	const [selected, setSelected] = useState(seed?.id ?? '');
	const [work, setWork] = useState<SavedWork>();
	const [detailError, setDetailError] = useState('');
	const [confirm, setConfirm] = useState(false);
	const [removing, setRemoving] = useState(false);

	useEffect(() => {
		setSelected(seed?.id ?? '');
	}, [seed]);

	useEffect(() => {
		setVisible(60);
	}, [search, sort, view]);

	useEffect(() => {
		document.querySelector('.page-scroll')?.scrollTo(0, 0);
	}, [selected, view]);

	useEffect(() => {
		if (!selected) {
			setWork(undefined);
			return;
		}
		let live = true;
		setDetailError('');
		void window.nectisse.library
			.getWork(selected)
			.then((next) => {
				if (live) {
					setWork(next);
					if (!next) {
						setSelected('');
					}
				}
			})
			.catch(() => {
				if (live) {
					setDetailError('这部作品的收藏暂时无法读取，请重新检查收藏库。');
				}
			});
		return () => {
			live = false;
		};
	}, [selected, state]);

	const remove = async (): Promise<void> => {
		if (!work) {
			return;
		}
		setRemoving(true);
		try {
			const reply = await window.nectisse.library.remove(work.id);
			if (reply.ok) {
				setSelected('');
				setConfirm(false);
				toast.success('已取消收藏', { id: 'library-remove', description: work.code });
			} else {
				toast.error(reply.message || '取消收藏未完成', { id: 'library-remove', duration: 8000 });
			}
		} catch {
			toast.error('收藏服务暂未响应，请重新检查后重试。', { id: 'library-remove', duration: 8000 });
		} finally {
			setRemoving(false);
		}
	};

	if (selected) {
		return (
			<>
				{work?.id === selected ? (
					<RealDetail
						key={work.updatedAt}
						records={work.records}
						scope="library"
						magnetOrigin={{ kind: 'library', id: work.id }}
						coverId={work.coverId}
						backLabel="返回作品收藏"
						onBack={() => setSelected('')}
						onRefresh={() => onQuery(work.code)}
						onOpenSource={(recordId) => {
							void window.nectisse.library.openSource(work.id, recordId).catch(() => {
								toast.error('原文链接暂时无法打开。', { duration: 8000 });
							});
						}}
						actions={
							<div className="library-detail-actions">
								<span>收藏于 {new Date(work.savedAt).toLocaleDateString('zh-CN')} · 本机资料快照</span>
								<Button className="library-remove-button" variant="ghost" size="sm" onClick={() => setConfirm(true)}>
									<Trash2 />
									取消收藏
								</Button>
								<p>重新采集后，可在查询详情明确更新这份收藏。</p>
							</div>
						}
					/>
				) : (
					<div className="page">
						<PageHeader
							title="作品详情"
							description="读取已收藏的本机资料。"
							actions={
								<Button variant="ghost" size="sm" onClick={() => setSelected('')}>
									<ArrowLeft />
									返回作品收藏
								</Button>
							}
						/>
						<p className="panel-note">{detailError || '正在读取收藏资料…'}</p>
						{detailError && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									void reload();
								}}
							>
								重新检查收藏库
							</Button>
						)}
					</div>
				)}
				<Dialog
					open={confirm}
					onOpenChange={(open) => {
						if (!removing) {
							setConfirm(open);
						}
					}}
				>
					<DialogContent className="library-remove-dialog" finalFocus={() => document.querySelector<HTMLElement>('.library-remove-button')}>
						<DialogTitle>取消收藏这部作品？</DialogTitle>
						<DialogDescription>移除此作品的收藏资料和不再使用的收藏封面。已有查询记录及订阅动态保留。</DialogDescription>
						<div>
							<Button variant="outline" size="sm" disabled={removing} onClick={() => setConfirm(false)}>
								保留收藏
							</Button>
							<Button
								variant="destructive"
								size="sm"
								disabled={removing}
								onClick={() => {
									void remove();
								}}
							>
								{removing && <LoaderCircle className="spin" />}确认取消收藏
							</Button>
						</div>
					</DialogContent>
				</Dialog>
			</>
		);
	}
	const term = search.trim().toLocaleLowerCase();
	const works = state.works
		.filter((work) => [work.code, work.title, work.studio, ...work.people, ...work.tags].join(' ').toLocaleLowerCase().includes(term))
		.toSorted((a, b) =>
			sort === 'code'
				? a.code.localeCompare(b.code, undefined, { numeric: true })
				: sort === 'release'
					? b.releaseDate.localeCompare(a.releaseDate)
					: b.savedAt.localeCompare(a.savedAt),
		);

	return (
		<div className="page library-page">
			<PageHeader
				title="作品收藏"
				description={`${state.works.length} 部作品，资料与选定封面保存在本机。`}
				actions={
					<Button variant="outline" size="sm" onClick={() => onQuery('')}>
						<Search />
						查询作品
					</Button>
				}
			/>
			{error && (
				<Alert>
					<Bookmark />
					<AlertTitle>收藏库需要处理</AlertTitle>
					<AlertDescription>
						{error}
						<Button
							variant="outline"
							size="sm"
							disabled={loading}
							onClick={() => {
								void reload();
							}}
						>
							重新检查收藏库
						</Button>
					</AlertDescription>
				</Alert>
			)}
			<PageToolbar
				label="收藏工具栏"
				actions={
					<>
						<div className="library-search">
							<Search aria-hidden="true" />
							<Input aria-label="搜索收藏作品" placeholder="编号、标题、人物或标签" value={search} onChange={(event) => setSearch(event.target.value)} />
						</div>
						<OptionSelect
							className="library-sort"
							aria-label="收藏排序"
							value={sort}
							onValueChange={setSort}
							options={[
								{ value: 'saved', label: '最近收藏' },
								{ value: 'release', label: '发行日期' },
								{ value: 'code', label: '作品编号' },
							]}
						/>
					</>
				}
			>
				<ReviewTabs
					value={view}
					onChange={setView}
					label="收藏视图"
					segmented
					items={[
						{ value: 'cards', label: '资料卡片' },
						{ value: 'wall', label: '照片墙' },
					]}
				/>
			</PageToolbar>
			{loading ? (
				<EmptyState icon={LoaderCircle} busy description="正在打开本机收藏…" />
			) : error && !state.works.length ? (
				<EmptyState description="收藏库恢复后会显示已保存作品。" />
			) : !works.length ? (
				<EmptyState
					icon={Images}
					title={term ? '没有匹配的收藏' : '把值得留下的作品，放在一起。'}
					description={term ? '试试其他编号、人物或标签。' : '查询作品后点击“收藏作品”，就能在这里浏览资料和封面。'}
					action={!term ? { label: '开始查询', onClick: () => onQuery('') } : undefined}
				/>
			) : (
				<>
					<div className={`library-grid ${view === 'wall' ? 'library-wall' : 'library-cards'}`} aria-label={view === 'wall' ? '作品照片墙' : '收藏作品列表'}>
						{works.slice(0, visible).map((work) => (
							<Card key={work.id} className="library-work gap-0 py-0 ring-0">
								<Button
									variant="text"
									size="text"
									className="library-work-open"
									aria-label={`查看收藏作品 ${work.code}`}
									onClick={() => {
										setSelected(work.id);
									}}
								>
									<CoverImage cover={work.cover} scope="library" />
									<span className="library-work-caption">
										<strong>{work.code}</strong>
										{view === 'cards' && (
											<>
												<span className="library-work-title">{work.title}</span>
												<small>{work.people.slice(0, 3).join('、') || work.studio || '人物资料未提供'}</small>
												<small>{work.releaseDate || '发行日期未提供'}</small>
											</>
										)}
									</span>
								</Button>
							</Card>
						))}
					</div>
					{works.length > visible && (
						<div className="library-more">
							<Button variant="outline" size="sm" onClick={() => setVisible((value) => value + 60)}>
								显示更多 · 剩余 {works.length - visible} 部
							</Button>
						</div>
					)}
				</>
			)}
		</div>
	);
}

import { useSubscriptions, useDesktopActions } from '@/shared/desktop';
import { EntryList } from '@/entities/update';
import { useEffect, useState } from 'react';
import { Check, RefreshCw, Users } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { toast } from '@/shared/ui/sonner';

import { PageHeader, PageToolbar } from '@/shared/components/page-layout';

import { OptionSelect } from '@/shared/ui/select';
import { Pagination } from '@/shared/ui/pagination';

import { ContentTabs } from '@/shared/components/content-tabs';

import { TaskProgress } from '@/entities/subscription';
import { FOLLOW_IDS, SOURCE_LABELS } from '@shared/sources';

export function UpdatesPage({ onWork, onAdd }: { onWork: (code: string) => void; onAdd: () => void }): React.JSX.Element {
	const state = useSubscriptions((state) => ({ entries: state.entries }));
	const { invoke } = useDesktopActions();
	const [filter, setFilter] = useState<'unread' | 'all'>('unread');
	const [kind, setKind] = useState('all');
	const [page, setPage] = useState(1);
	const pageSize = 20;
	const entries = state.entries.filter(
		(entry) =>
			(filter === 'all' || !entry.read) &&
			(kind === 'all' || (kind === 'creators' && entry.provider !== 'javdb') || (kind === 'actors' && entry.provider === 'javdb') || entry.provider === kind),
	);
	const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
	const currentPage = Math.min(page, pageCount);
	const start = (currentPage - 1) * pageSize;
	const pageEntries = entries.slice(start, start + pageSize);

	// Reading the last unread items can remove a page while its detail dialog remains open.
	useEffect(() => {
		setPage((value) => Math.min(value, pageCount));
	}, [pageCount]);

	const changePage = (value: number, focusHeading = true): void => {
		setPage(Math.min(Math.max(value, 1), pageCount));
		document.querySelector('.page-scroll')?.scrollTo({ top: 0, behavior: 'instant' });
		if (focusHeading) {
			document.getElementById('page-heading')?.focus({ preventScroll: true });
		}
	};

	const readPage = async (): Promise<void> => {
		const ids = pageEntries.filter((entry) => !entry.read).map((entry) => entry.id);

		if (!ids.length) {
			return;
		}
		const reply = await invoke({ action: 'read', ids, read: true });
		if (reply.ok) {
			toast.success(`已将本页 ${ids.length} 条更新标为已读`, { id: 'updates-read-page' });
		} else {
			toast.error(reply.message || '已读状态未能保存', { id: 'updates-read-page', duration: 8000 });
		}
	};

	return (
		<div className="page real-updates">
			<PageHeader
				title="更新"
				description={`${state.entries.filter((entry) => !entry.read).length} 条未读，来自演员新作与创作者动态。`}
				actions={
					<Button variant="outline" size="sm" onClick={onAdd}>
						<Users />
						管理关注
					</Button>
				}
			/>
			<TaskProgress />
			<PageToolbar
				label="更新工具栏"
				className="updates-toolbar"
				actions={
					<>
						<Button
							variant="ghost"
							size="sm"
							disabled={
								!state.entries.some(
									(entry) => entry.thumbnailUrl && !entry.imageAsset && ['failed', 'cancelled', 'evicted', 'retry'].includes(entry.imageCache?.status ?? ''),
								)
							}
							onClick={() => {
								void invoke({ action: 'retry-images' });
							}}
						>
							<RefreshCw />
							重试未缓存封面
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={!pageEntries.some((entry) => !entry.read)}
							onClick={() => {
								void readPage();
							}}
						>
							<Check />
							本页全部已读
						</Button>
					</>
				}
			>
				<ContentTabs
					segmented
					value={filter}
					onChange={(value) => {
						setFilter(value);
						changePage(1, false);
					}}
					label="阅读状态"
					items={[
						{ value: 'unread', label: '未读' },
						{ value: 'all', label: '全部' },
					]}
				/>
				<OptionSelect
					className="update-type"
					aria-label="更新类型"
					value={kind}
					onValueChange={(value) => {
						setKind(value);
						changePage(1, false);
					}}
					options={[
						{ value: 'all', label: '所有类型' },
						{ value: 'actors', label: '演员新作' },
						{ value: 'creators', label: '创作者动态' },
						...FOLLOW_IDS.map((id) => ({ value: id, label: SOURCE_LABELS[id] })),
					]}
				/>
				<span className="page-toolbar-count">{entries.length} 条更新</span>
			</PageToolbar>
			<EntryList entries={pageEntries} onWork={onWork} />
			{entries.length > 0 && (
				<footer className="updates-pagination">
					<p role="status" aria-live="polite">
						第 {start + 1}–{start + pageEntries.length} 条，共 {entries.length} 条<span>每页 {pageSize} 条</span>
					</p>
					<Pagination page={currentPage} pageCount={pageCount} onPageChange={changePage} />
				</footer>
			)}
		</div>
	);
}

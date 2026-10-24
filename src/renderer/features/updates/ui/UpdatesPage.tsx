import { Check, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { useDesktopActions, useSubscriptions } from '@/shared/desktop';
import { EntryList } from '@/entities/update';
import { FOLLOW_IDS, SOURCE_LABELS, isPerformerProvider } from '@shared/sources';
import type { PeopleScope, PeopleView } from '@/shared/lib/people-navigation';
import { Button } from '@/shared/ui/button';
import { toast } from '@/shared/ui/sonner';
import { PageToolbar } from '@/shared/components/page-layout';
import { ContentTabs } from '@/shared/components/content-tabs';
import { OptionSelect } from '@/shared/ui/select';
import { Pagination } from '@/shared/ui/pagination';

export function UpdatesPage({
	scope,
	view,
	onViewChange,
	onWork,
	onPerson,
}: {
	scope: PeopleScope;
	view: PeopleView['feed'];
	onViewChange: (view: PeopleView['feed']) => void;
	onWork: (code: string) => void;
	onPerson: (id: string) => void;
}): React.JSX.Element {
	const scoped = useSubscriptions((state) => state.entries.filter((entry) => isPerformerProvider(entry.provider) === (scope === 'actors')));
	const { invoke } = useDesktopActions();
	const entries = scoped.filter((entry) => (view.filter === 'all' || !entry.read) && (view.source === 'all' || entry.provider === view.source));
	const pageSize = 20;
	const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
	const currentPage = Math.min(view.page, pageCount);
	const start = (currentPage - 1) * pageSize;
	const pageEntries = entries.slice(start, start + pageSize);
	const title = scope === 'actors' ? '最近新作' : '最新动态';
	const headingId = `${scope}-updates-heading`;
	useEffect(() => {
		if (view.page > pageCount) {
			onViewChange({ ...view, page: pageCount });
		}
	}, [view, pageCount, onViewChange]);

	const changePage = (page: number): void => {
		onViewChange({ ...view, page });
		const heading = document.getElementById(headingId);
		heading?.focus({ preventScroll: true });
		heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
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
			toast.error(reply.message || '已读状态未能保存', { id: 'updates-read-page' });
		}
	};

	return (
		<section className="real-updates people-updates" aria-labelledby={headingId}>
			<div className="people-section-heading">
				<h2 id={headingId} tabIndex={-1}>
					{title}
				</h2>
				<span>{scoped.filter((entry) => !entry.read).length} 条未读</span>
			</div>
			<PageToolbar
				label="更新工具栏"
				className="updates-toolbar"
				actions={
					<>
						<Button
							variant="ghost"
							size="sm"
							disabled={
								!scoped.some(
									(entry) => entry.thumbnailUrl && !entry.imageAsset && ['failed', 'cancelled', 'evicted', 'retry'].includes(entry.imageCache?.status ?? ''),
								)
							}
							onClick={() => {
								for (const subscriptionId of new Set(scoped.filter((entry) => entry.thumbnailUrl && !entry.imageAsset).map((entry) => entry.subscriptionId))) {
									void invoke({ action: 'retry-images', subscriptionId });
								}
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
					value={view.filter}
					onChange={(filter) => onViewChange({ ...view, filter, page: 1 })}
					label="阅读状态"
					items={[
						{ value: 'unread', label: '未读' },
						{ value: 'all', label: '全部' },
					]}
				/>
				<OptionSelect
					className="update-type"
					aria-label="更新来源"
					value={view.source}
					onValueChange={(source) => onViewChange({ ...view, source, page: 1 })}
					options={[
						{ value: 'all', label: '所有来源' },
						...FOLLOW_IDS.filter((id) => isPerformerProvider(id) === (scope === 'actors')).map((id) => ({ value: id, label: SOURCE_LABELS[id] })),
					]}
				/>
				<span className="page-toolbar-count">{entries.length} 条更新</span>
			</PageToolbar>
			<EntryList entries={pageEntries} onWork={onWork} onPerson={onPerson} />
			{entries.length > 0 && (
				<footer className="updates-pagination">
					<p role="status" aria-live="polite">
						第 {start + 1}–{start + pageEntries.length} 条，共 {entries.length} 条<span>每页 {pageSize} 条</span>
					</p>
					<Pagination page={currentPage} pageCount={pageCount} onPageChange={changePage} />
				</footer>
			)}
		</section>
	);
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import type { Subscription } from '@shared/subscriptions';
import { useDesktopActions, useSubscriptions } from '@/shared/desktop';
import { EntryList } from '@/entities/update';
import { ContentTabs } from '@/shared/components/content-tabs';
import { PageToolbar } from '@/shared/components/page-layout';
import { Button } from '@/shared/ui/button';
import { Pagination } from '@/shared/ui/pagination';
import { toast } from '@/shared/ui/sonner';
import { useSubscriptionControls } from '../model/use-subscription-controls';

export function CollectedEntries({
	subscription: sub,
	onWork,
	presentation = 'list',
	title = '已收录内容',
}: {
	subscription: Subscription;
	onWork: (code: string) => void;
	presentation?: 'list' | 'cards';
	title?: string;
}): React.JSX.Element {
	const collected = useSubscriptions((state) => state.entries.filter((entry) => entry.subscriptionId === sub.id));
	const { invoke } = useDesktopActions();
	const { canCheck, update } = useSubscriptionControls(sub);
	const [filter, setFilter] = useState<'unread' | 'all'>('all');
	const [page, setPage] = useState(1);
	const [visibleCount, setVisibleCount] = useState(20);
	const more = useRef<HTMLDivElement>(null);
	const stream = presentation === 'cards';
	const entries = collected.filter((entry) => filter === 'all' || !entry.read);
	const pageSize = 20;
	const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
	const currentPage = Math.min(page, pageCount);
	const start = stream ? 0 : (currentPage - 1) * pageSize;
	const visibleEntries = entries.slice(start, stream ? visibleCount : start + pageSize);
	const hasMore = stream && visibleCount < entries.length;
	const canRetry = collected.some((entry) => entry.thumbnailUrl && !entry.imageAsset && ['failed', 'cancelled', 'evicted', 'retry'].includes(entry.imageCache?.status ?? ''));

	useEffect(() => {
		setPage((value) => Math.min(value, pageCount));
	}, [pageCount]);

	const loadMore = useCallback((): void => {
		setVisibleCount((count) => Math.min(count + pageSize, entries.length));
	}, [entries.length]);

	useEffect(() => {
		const target = more.current;
		if (!hasMore || !target) {
			return;
		}
		const observer = new IntersectionObserver(
			(items) => {
				if (items.some((item) => item.isIntersecting)) {
					loadMore();
				}
			},
			{ root: target.closest('.page-scroll'), rootMargin: '0px 0px 240px 0px' },
		);
		observer.observe(target);
		return () => observer.disconnect();
	}, [hasMore, loadMore, visibleCount, filter]);

	const changePage = (value: number): void => {
		setPage(Math.min(Math.max(value, 1), pageCount));
		const heading = document.getElementById('collected-entry-heading');
		heading?.focus({ preventScroll: true });
		heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
	};

	const readVisible = async (): Promise<void> => {
		const ids = visibleEntries.filter((entry) => !entry.read).map((entry) => entry.id);
		if (!ids.length) {
			return;
		}
		const reply = await invoke({ action: 'read', ids, read: true });
		if (reply.ok) {
			toast.success(`已将${stream ? '已加载的' : '本页'} ${ids.length} 条更新标为已读`, { id: 'person-read-page' });
		} else {
			toast.error(reply.message || '已读状态未能保存', { id: 'person-read-page' });
		}
	};

	return (
		<section className="collected-entries" aria-labelledby="collected-entry-heading">
			<h2 className="creator-entry-heading" id="collected-entry-heading" tabIndex={-1}>
				{title}
			</h2>
			<PageToolbar
				label="更新工具栏"
				className="updates-toolbar person-updates-toolbar"
				actions={
					<>
						<Button
							variant="outline"
							size="sm"
							disabled={!canCheck}
							onClick={() => {
								void update({ action: 'check', id: sub.id });
							}}
						>
							<RefreshCw />
							检查更新
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={!canRetry}
							onClick={() => {
								void invoke({ action: 'retry-images', subscriptionId: sub.id });
							}}
						>
							<RefreshCw />
							重试未缓存封面
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={!visibleEntries.some((entry) => !entry.read)}
							onClick={() => {
								void readVisible();
							}}
						>
							<Check />
							{stream ? '标记已加载为已读' : '本页全部已读'}
						</Button>
					</>
				}
			>
				<ContentTabs
					segmented
					value={filter}
					onChange={(value) => {
						setFilter(value);
						setPage(1);
						setVisibleCount(pageSize);
					}}
					label="阅读状态"
					items={[
						{ value: 'unread', label: '未读' },
						{ value: 'all', label: '全部' },
					]}
				/>
				<span className="page-toolbar-count">{entries.length} 条更新</span>
			</PageToolbar>
			<EntryList entries={visibleEntries} onWork={onWork} presentation={presentation} />
			{stream && entries.length > 0 && (
				<div className="creator-load-more" ref={more}>
					<p role="status" aria-live="polite">
						{hasMore ? `已加载 ${visibleEntries.length} / ${entries.length} 条动态` : `已显示全部 ${entries.length} 条动态`}
					</p>
					{hasMore && (
						<Button variant="ghost" size="sm" onClick={loadMore}>
							加载更多
						</Button>
					)}
				</div>
			)}
			{!stream && entries.length > 0 && (
				<footer className="collected-pagination">
					<p role="status" aria-live="polite">
						第 {start + 1}–{start + visibleEntries.length} 条，共 {entries.length} 条<span>每页 {pageSize} 条</span>
					</p>
					<Pagination label="已收录内容分页" page={currentPage} pageCount={pageCount} onPageChange={changePage} />
				</footer>
			)}
		</section>
	);
}

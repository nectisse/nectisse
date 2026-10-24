import { useEffect, useState } from 'react';
import { useSubscriptions } from '@/shared/desktop';
import { EntryList } from '@/entities/update';
import { Pagination } from '@/shared/ui/pagination';

export function CollectedEntries({
	subscriptionId,
	onWork,
	presentation = 'list',
	title = '已收录内容',
}: {
	subscriptionId: string;
	onWork: (code: string) => void;
	presentation?: 'list' | 'cards';
	title?: string;
}): React.JSX.Element {
	const entries = useSubscriptions((state) => state.entries.filter((entry) => entry.subscriptionId === subscriptionId));
	const [page, setPage] = useState(1);
	const pageSize = 20;
	const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
	const currentPage = Math.min(page, pageCount);
	const start = (currentPage - 1) * pageSize;
	const pageEntries = entries.slice(start, start + pageSize);

	useEffect(() => {
		setPage((value) => Math.min(value, pageCount));
	}, [pageCount]);

	const changePage = (value: number): void => {
		setPage(Math.min(Math.max(value, 1), pageCount));
		const heading = document.getElementById('collected-entry-heading');
		heading?.focus({ preventScroll: true });
		heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
	};

	return (
		<section className="collected-entries" aria-labelledby="collected-entry-heading">
			<h2 className="creator-entry-heading" id="collected-entry-heading" tabIndex={-1}>
				{title}
				<span>{entries.length} 条</span>
			</h2>
			<EntryList entries={pageEntries} onWork={onWork} presentation={presentation} />
			{entries.length > 0 && (
				<footer className="collected-pagination">
					<p role="status" aria-live="polite">
						第 {start + 1}–{start + pageEntries.length} 条，共 {entries.length} 条<span>每页 {pageSize} 条</span>
					</p>
					<Pagination label="已收录内容分页" page={currentPage} pageCount={pageCount} onPageChange={changePage} />
				</footer>
			)}
		</section>
	);
}

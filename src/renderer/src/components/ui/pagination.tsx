import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { Button } from './button';

export function Pagination({ page, pageCount, onPageChange, label = '更新分页' }: { page: number; pageCount: number; onPageChange: (page: number) => void; label?: string }): React.JSX.Element {
	const visible = new Set([1, pageCount, page - 1, page, page + 1]);
	if (page <= 3) [2, 3, 4].forEach(value => visible.add(value));
	if (page >= pageCount - 2) [pageCount - 3, pageCount - 2, pageCount - 1].forEach(value => visible.add(value));
	const pages = [...visible].filter(value => value >= 1 && value <= pageCount).sort((a, b) => a - b);
	const items: (number | string)[] = [];
	pages.forEach((value, index) => {
		const previous = pages[index - 1];
		if (previous && value - previous === 2) items.push(previous + 1);
		else if (previous && value - previous > 2) items.push(`gap-${value}`);
		items.push(value);
	});
	return <nav data-slot="pagination" aria-label={label}>
		<ul className="flex items-center gap-1" data-slot="pagination-content">
			<li><Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="上一页"><ChevronLeft />上一页</Button></li>
			{items.map(value => <li key={value}>{typeof value === 'number'
				? <Button variant={value === page ? 'outline' : 'ghost'} size="icon-sm" aria-label={`第 ${value} 页`} aria-current={value === page ? 'page' : undefined} onClick={() => onPageChange(value)}>{value}</Button>
				: <span className="flex size-8 items-center justify-center text-muted-foreground" aria-hidden="true"><MoreHorizontal className="size-4" /></span>}</li>)}
			<li><Button variant="ghost" size="sm" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)} aria-label="下一页">下一页<ChevronRight /></Button></li>
		</ul>
	</nav>;
}

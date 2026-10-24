import type { HTMLAttributes } from 'react';
import { cn } from '@/shared/lib/utils';
import './masonry.css';

function connectMasonry(node: HTMLDivElement | null): (() => void) | undefined {
	if (!node) {
		return;
	}
	const observed = new Set<HTMLElement>();

	const measure = (item: HTMLElement): void => {
		const gap = Number.parseFloat(getComputedStyle(node).columnGap) || 0;
		const span = `span ${Math.ceil(item.getBoundingClientRect().height + gap)}`;
		if (item.style.gridRowEnd !== span) {
			item.style.gridRowEnd = span;
		}
	};

	const resize = new ResizeObserver((entries) => {
		for (const entry of entries) {
			measure(entry.target as HTMLElement);
		}
	});

	const sync = (): void => {
		for (const item of observed) {
			if (item.parentElement !== node) {
				resize.unobserve(item);
				observed.delete(item);
			}
		}
		for (const child of node.children) {
			if (child instanceof HTMLElement && !observed.has(child)) {
				observed.add(child);
				resize.observe(child);
				measure(child);
			}
		}
	};

	// 只调整网格占位，保留 DOM 顺序、焦点和追加前的卡片位置。
	const mutation = new MutationObserver(sync);
	mutation.observe(node, { childList: true });
	sync();

	return () => {
		mutation.disconnect();
		resize.disconnect();
	};
}

export function Masonry({ className, children, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
	return (
		<div {...props} className={cn('masonry-grid', className)} ref={connectMasonry}>
			{children}
		</div>
	);
}

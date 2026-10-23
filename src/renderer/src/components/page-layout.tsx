import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Shared desktop page frame: title and actions always start on the same row. */
export function PageHeader({ title, description, actions }: { title: string; description: ReactNode; actions?: ReactNode }): React.JSX.Element {
	return (
		<header className="page-heading workspace-page-heading">
			<div className="page-heading-copy">
				<h1 id="page-heading" tabIndex={-1}>
					{title}
				</h1>
				<p>{description}</p>
			</div>
			{actions && <div className="page-heading-actions">{actions}</div>}
		</header>
	);
}

/** Filters stay together; view-wide actions sit at the trailing edge. */
export function PageToolbar({ label, children, actions, className }: { label: string; children: ReactNode; actions?: ReactNode; className?: string }): React.JSX.Element {
	return (
		<section aria-label={label} className={cn('page-toolbar', className)}>
			<div className="page-toolbar-filters">{children}</div>
			{actions && <div className="page-toolbar-actions">{actions}</div>}
		</section>
	);
}

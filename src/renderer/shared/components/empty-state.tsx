import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';

export interface EmptyStateAction {
	label: string;
	onClick: () => void;
}

export function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	compact = false,
	busy = false,
	headingLevel = 2,
	className,
}: {
	icon?: LucideIcon;
	title?: ReactNode;
	description: ReactNode;
	action?: EmptyStateAction;
	compact?: boolean;
	busy?: boolean;
	headingLevel?: 2 | 3;
	className?: string;
}): React.JSX.Element {
	const Heading = headingLevel === 3 ? 'h3' : 'h2';
	return (
		<div data-slot="empty-state" className={cn('empty-panel', compact && 'empty-panel-compact', className)} role={busy ? 'status' : undefined}>
			{Icon && <Icon aria-hidden="true" strokeWidth={1.3} className={cn('empty-panel-icon', busy && 'spin')} />}
			<div className="empty-panel-copy">
				{title && <Heading className="empty-panel-title">{title}</Heading>}
				<p className="empty-panel-description">{description}</p>
			</div>
			{action && (
				<div className="empty-panel-actions">
					<Button type="button" variant="outline" size="sm" onClick={action.onClick}>
						{action.label}
					</Button>
				</div>
			)}
		</div>
	);
}

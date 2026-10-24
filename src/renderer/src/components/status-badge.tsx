import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function StatusBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'peach' | 'berry' }): React.JSX.Element {
	return (
		<Badge variant="secondary" className={cn('status-badge', `tone-${tone}`)}>
			{children}
		</Badge>
	);
}

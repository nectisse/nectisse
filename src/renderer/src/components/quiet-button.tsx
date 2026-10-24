import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function QuietButton({ children, className, ...props }: React.ComponentProps<typeof Button>): React.JSX.Element {
	return (
		<Button variant="ghost" size="sm" className={cn('quiet-button', className)} {...props}>
			{children}
		</Button>
	);
}

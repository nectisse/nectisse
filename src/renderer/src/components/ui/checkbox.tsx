import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
	return <CheckboxPrimitive.Root data-slot="checkbox" className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded border border-input bg-background outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-disabled:opacity-50', className)} {...props}>
		<CheckboxPrimitive.Indicator data-slot="checkbox-indicator"><Check className="size-3" /></CheckboxPrimitive.Indicator>
	</CheckboxPrimitive.Root>;
}

export { Checkbox };

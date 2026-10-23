import type { ComponentProps } from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: ComponentProps<'input'>) {
	return <InputPrimitive type={type} data-slot="input" className={cn(
		'h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive',
		className,
	)} {...props} />;
}

export { Input };

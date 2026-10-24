import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

// shadcn/ui Base UI Select, adapted to the app's compact desktop controls.
// https://ui.shadcn.com/docs/components/base/select
const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
	return <SelectPrimitive.Value data-slot="select-value" className={cn('min-w-0 flex-1 truncate text-left', className)} {...props} />;
}

function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
	return (
		<SelectPrimitive.Trigger
			data-slot="select-trigger"
			className={cn(
				'inline-flex h-9 w-44 min-w-0 shrink-0 items-center justify-between gap-3 rounded-md border border-input bg-background px-3 text-xs text-foreground outline-none select-none hover:bg-accent/30 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-50',
				className,
			)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon render={<ChevronDown className="pointer-events-none size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />} />
		</SelectPrimitive.Trigger>
	);
}

function SelectContent({
	className,
	children,
	side = 'bottom',
	sideOffset = 4,
	align = 'start',
	alignOffset = 0,
	alignItemWithTrigger = false,
	...props
}: SelectPrimitive.Popup.Props & Pick<SelectPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align' | 'alignOffset' | 'alignItemWithTrigger'>) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Positioner
				side={side}
				sideOffset={sideOffset}
				align={align}
				alignOffset={alignOffset}
				alignItemWithTrigger={alignItemWithTrigger}
				className="isolate z-80"
			>
				<SelectPrimitive.Popup
					data-slot="select-content"
					className={cn(
						'relative max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-md outline-none',
						className,
					)}
					{...props}
				>
					<SelectPrimitive.ScrollUpArrow className="flex h-6 items-center justify-center bg-popover">
						<ChevronUp className="size-3.5" />
					</SelectPrimitive.ScrollUpArrow>
					<SelectPrimitive.List className="p-1">{children}</SelectPrimitive.List>
					<SelectPrimitive.ScrollDownArrow className="flex h-6 items-center justify-center bg-popover">
						<ChevronDown className="size-3.5" />
					</SelectPrimitive.ScrollDownArrow>
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	);
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
	return (
		<SelectPrimitive.Item
			data-slot="select-item"
			className={cn(
				'relative flex min-h-8 w-full cursor-default items-center rounded-md py-1.5 pr-7 pl-2 text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50',
				className,
			)}
			{...props}
		>
			<SelectPrimitive.ItemText className="min-w-0 flex-1">{children}</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center">
				<Check className="size-3.5" aria-hidden="true" />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}

function OptionSelect<Value extends string | number>({
	value,
	options,
	onValueChange,
	className,
	id,
	disabled,
	'aria-label': label,
}: {
	value: Value;
	options: readonly { value: Value; label: string }[];
	onValueChange: (value: Value) => void;
	className?: string;
	id?: string;
	disabled?: boolean;
	'aria-label': string;
}) {
	return (
		<Select
			items={options}
			value={value}
			disabled={disabled}
			onValueChange={(next) => {
				if (next !== null) {
					onValueChange(next);
				}
			}}
		>
			<SelectTrigger id={id} aria-label={label} className={className}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent aria-label={`${label}选项`}>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem, OptionSelect };

import type { ReactNode } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/shared/ui/tabs';
import { cn } from '@/shared/lib/utils';

export function ContentTabs<T extends string>({
	value,
	onChange,
	items,
	label,
	children,
	segmented = false,
}: {
	value: T;
	onChange: (value: T) => void;
	items: readonly { value: T; label: ReactNode }[];
	label: string;
	children?: ReactNode;
	segmented?: boolean;
}): React.JSX.Element {
	return (
		<Tabs
			value={value}
			className="content-tabs"
			onValueChange={(next) => {
				const item = items.find((item) => item.value === next);

				if (item) {
					onChange(item.value);
				}
			}}
		>
			<TabsList variant={segmented ? 'default' : 'line'} aria-label={label} className={cn('review-tabs', segmented && 'segmented-tabs')}>
				{items.map((item) => (
					<TabsTrigger key={item.value} value={item.value}>
						{item.label}
					</TabsTrigger>
				))}
			</TabsList>
			{children !== undefined && (
				<TabsContent value={value} className="review-tab-panel">
					{children}
				</TabsContent>
			)}
		</Tabs>
	);
}

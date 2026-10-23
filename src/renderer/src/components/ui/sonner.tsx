import type { CSSProperties } from 'react';
import { CircleCheck, CircleX, Info, LoaderCircle, TriangleAlert } from 'lucide-react';
import { Toaster as Sonner, toast, type ToasterProps } from 'sonner';
import { cn } from '@/lib/utils';

// A single app-wide Sonner surface, using the same tokens as the shadcn controls.
export function Toaster({ className, ...props }: ToasterProps): React.JSX.Element {
	return <Sonner
		className={cn('nectisse-toaster', className)}
		position="bottom-right"
		offset={{ bottom: 44, right: 24 }}
		visibleToasts={3}
		duration={4500}
		gap={8}
		closeButton
		customAriaLabel="操作反馈"
		style={{ '--normal-bg': 'var(--popover)', '--normal-text': 'var(--popover-foreground)', '--normal-border': 'var(--border)', '--border-radius': '8px', '--width': '340px' } as CSSProperties}
		icons={{ success: <CircleCheck className="size-4" style={{ color: 'var(--success)' }} />, error: <CircleX className="size-4 text-destructive" />, info: <Info className="size-4" />, warning: <TriangleAlert className="size-4" />, loading: <LoaderCircle className="size-4 animate-spin" /> }}
		toastOptions={{ closeButtonAriaLabel: '关闭提示', style: { fontFamily: 'var(--font-sans)', fontSize: 12, lineHeight: 1.6, padding: '14px 16px', gap: 10, boxShadow: '0 4px 18px #0002' } }}
		{...props}
	/>;
}

export { toast };

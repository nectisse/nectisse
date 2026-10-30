import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { cn } from '@/shared/lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogClose = DialogPrimitive.Close;
const DialogTitle = DialogPrimitive.Title;
const DialogDescription = DialogPrimitive.Description;

function DialogContent({ className, children, fullScreen = false, overlayClassName, ...props }: DialogPrimitive.Popup.Props & { fullScreen?: boolean; overlayClassName?: string }) {
	return (
		<DialogPrimitive.Portal>
			<DialogPrimitive.Backdrop data-slot="dialog-overlay" className={cn('fixed inset-0 z-50 bg-black/35', overlayClassName)} />
			<DialogPrimitive.Popup
				data-slot="dialog-content"
				className={cn(
					'z-60 flex flex-col overflow-hidden border border-input bg-popover text-popover-foreground outline-none',
					fullScreen
						? 'fixed inset-0 h-dvh w-screen max-h-none'
						: 'fixed top-1/2 left-1/2 max-h-[calc(100dvh-64px)] w-[min(560px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 rounded-xl shadow-xl',
					className,
				)}
				{...props}
			>
				{children}
			</DialogPrimitive.Popup>
		</DialogPrimitive.Portal>
	);
}

export { Dialog, DialogContent, DialogClose, DialogTitle, DialogDescription };

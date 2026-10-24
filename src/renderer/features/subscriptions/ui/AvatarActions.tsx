import { useState } from 'react';
import { ImagePlus, RotateCcw } from 'lucide-react';
import type { Subscription } from '@shared/subscriptions';
import { useDesktopActions } from '@/shared/desktop';
import { Button } from '@/shared/ui/button';
import { toast } from '@/shared/ui/sonner';

export function AvatarActions({ subscription: sub }: { subscription: Subscription }): React.JSX.Element {
	const { uploadAvatar, invoke } = useDesktopActions();
	const [busy, setBusy] = useState(false);

	const change = async (restore = false): Promise<void> => {
		if (busy) {
			return;
		}
		setBusy(true);
		try {
			const reply = restore ? await invoke({ action: 'restore-avatar', id: sub.id }) : await uploadAvatar(sub.id);
			if ('cancelled' in reply && reply.cancelled) {
				return;
			}
			if (reply.ok) {
				toast.success(restore ? '已恢复站点头像' : '头像已保存', { id: `avatar:${sub.id}` });
			} else {
				toast.error(reply.message || '头像未能更新，请重试', { id: `avatar:${sub.id}` });
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="person-avatar-actions" aria-busy={busy}>
			{sub.manualAvatarAsset && (
				<Button variant="ghost" size="sm" disabled={busy} onClick={() => void change(true)}>
					<RotateCcw />
					恢复站点头像
				</Button>
			)}
			<Button variant="outline" size="sm" disabled={busy} onClick={() => void change()}>
				<ImagePlus />
				{sub.manualAvatarAsset ? '更换头像' : '上传头像'}
			</Button>
		</div>
	);
}

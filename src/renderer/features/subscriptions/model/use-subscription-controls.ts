import type { FollowCommand, Subscription } from '@shared/subscriptions';
import { useDesktopActions, useSubscriptions } from '@/shared/desktop';
import { feedDate } from '@/shared/lib/format-date';
import { toast } from '@/shared/ui/sonner';

export function useSubscriptionControls(sub: Subscription) {
	const preferences = useSubscriptions((state) => state.preferences);
	const busy = useSubscriptions((state) => state.tasks.some((task) => task.kind !== 'covers' && ['running', 'cancelling'].includes(task.status)));
	const { invoke } = useDesktopActions();
	const sourceEnabled = preferences.enabledSources.includes(sub.provider);
	const status = !sub.following ? '已取消关注' : !sub.enabled ? '已暂停' : sub.autoPaused ? '自动检查已暂停' : '已关注';
	const statusTone = !sub.following ? 'neutral' : !sub.enabled || sub.autoPaused ? 'peach' : 'success';
	const nextCheck = !sub.following
		? '已取消关注'
		: !sub.enabled || sub.autoPaused
			? '已暂停检查'
			: !preferences.automatic
				? '自动检查未启用'
				: sub.nextCheckAt
					? feedDate(sub.nextCheckAt)
					: '等待首次检查';

	const update = async (command: FollowCommand): Promise<void> => {
		const reply = await invoke(command);
		if (reply.ok) {
			toast.success('订阅已更新', { id: `subscription:${sub.id}` });
		} else {
			toast.error(reply.message || '操作失败', { id: `subscription:${sub.id}`, duration: 8000 });
		}
	};

	const openSource = (): void => {
		void invoke({ action: 'open', kind: 'subscription', id: sub.id }).then((reply) => {
			if (!reply.ok) {
				toast.error(reply.message || '原主页暂时无法打开');
			}
		});
	};

	return { status, statusTone, nextCheck, sourceEnabled, canCheck: !busy && sub.following && sub.enabled && sourceEnabled, update, openSource } as const;
}

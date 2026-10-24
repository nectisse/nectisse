import { useSubscriptions, useDesktopActions } from '@/shared/desktop';
import { LoaderCircle, X } from 'lucide-react';
import { Button } from '@/shared/ui/button';

export function TaskProgress(): React.JSX.Element | null {
	const state = useSubscriptions((state) => ({ tasks: state.tasks }));
	const { invoke } = useDesktopActions();
	const active = state.tasks.find((task) => task.kind !== 'lookup' && ['running', 'cancelling'].includes(task.status));

	return active ? (
		<div className="live-task-progress" role="status">
			<LoaderCircle className="spin" />
			<div>
				<strong>{active.phase}</strong>
				<p>{active.kind === 'covers' ? '自动补齐已收录条目的封面；查询操作优先，取消后需手动重试。' : '限当前来源与对象；停止后保留已取得资料。'}</p>
			</div>
			<Button
				size="sm"
				variant="outline"
				disabled={active.status === 'cancelling'}
				onClick={() => {
					void invoke({ action: 'cancel', id: active.id });
				}}
			>
				<X />
				取消任务
			</Button>
		</div>
	) : null;
}

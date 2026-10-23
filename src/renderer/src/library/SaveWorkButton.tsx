import { useState } from 'react';
import { BookmarkPlus, Check, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLibrary } from './context';
import { toast } from '@/components/ui/sonner';

export function SaveWorkButton({
	taskId,
	code,
	coverId,
	disabled,
	allowUpdate = false,
	onOpen,
}: {
	taskId: string;
	code: string;
	coverId?: string;
	disabled?: boolean;
	allowUpdate?: boolean;
	onOpen?: (id: string) => void;
}): React.JSX.Element {
	const { state, loading, error } = useLibrary();
	const existing = state.works.find((work) => work.code === code);
	const [pending, setPending] = useState(false);
	const save = async (replace = false): Promise<void> => {
		setPending(true);
		const id = `library-save:${code}`;
		try {
			const reply = await window.nectisse.library.save({ taskId, code, coverId, replace });
			if (reply.ok) toast.success(replace ? '收藏资料已更新' : '作品资料已收藏', { id, description: code });
			else toast.error(reply.message || '收藏未完成', { id, duration: 8000 });
		} catch {
			toast.error('收藏服务暂未响应，可在作品收藏中重新检查。', { id, duration: 8000 });
		} finally {
			setPending(false);
		}
	};
	return (
		<div className="work-save-action">
			<div>
				<Button
					variant="outline"
					size="sm"
					title={error ? '收藏服务未就绪，可在作品收藏中重新检查。' : undefined}
					disabled={disabled || loading || pending || !!error}
					onClick={() => (existing ? onOpen?.(existing.id) : void save())}
				>
					{pending ? <LoaderCircle className="spin" /> : existing ? <Check /> : <BookmarkPlus />}
					{existing ? '已收藏 · 查看' : '收藏作品'}
				</Button>
				{existing && allowUpdate && (
					<Button
						variant="ghost"
						size="sm"
						disabled={disabled || pending || !!error}
						onClick={() => {
							void save(true);
						}}
					>
						<RefreshCw />
						更新收藏
					</Button>
				)}
			</div>
		</div>
	);
}

import { useRef, useState, type RefObject } from 'react';
import { ArrowDown, ArrowUp, RotateCcw, X } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/shared/ui/dialog';
import { OptionSelect } from '@/shared/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/ui/table';
import { SOURCE_LABELS, type AllSource } from '@shared/sources';

const labels = {
	cover: {
		title: '封面选择',
		description: '优先使用靠前图源的封面，每部作品只保留一张。',
		list: '封面优先图源',
		priority: '封面优先级',
		note: '未命中优先图源时按分辨率选择；同一图源取最大分辨率。DMM 图片统一归入 DMM / FANZA。下次查询生效，已有收藏保留。',
	},
	metadata: {
		title: '资料采用顺序',
		description: '按来源顺序采用第一个非空字段，保留各站原值。',
		list: '资料来源优先级',
		priority: '资料优先级',
		note: '排序不改变来源的启用状态；仅查询本次选中且已启用的来源，封面优先级单独设置。',
	},
} as const;

export function SourcePriorityDialog<T extends AllSource>({
	kind,
	open,
	onOpenChange,
	returnFocus,
	priority,
	defaultPriority,
	additionalSources,
	onChange,
}: {
	kind: keyof typeof labels;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	returnFocus: RefObject<HTMLButtonElement | null>;
	priority: T[];
	defaultPriority: readonly T[];
	additionalSources?: readonly T[];
	onChange: (value: T[]) => Promise<void>;
}): React.JSX.Element {
	const [saving, setSaving] = useState(false);
	const pending = useRef(false);
	const heading = useRef<HTMLHeadingElement | null>(null);
	const copy = labels[kind];
	const remaining = additionalSources?.filter((id) => !priority.includes(id));
	const update = async (next: T[]): Promise<void> => {
		if (pending.current) {
			return;
		}
		pending.current = true;
		setSaving(true);
		try {
			await onChange(next);
		} finally {
			pending.current = false;
			setSaving(false);
		}
	};

	const move = (index: number, delta: number): void => {
		const next = [...priority];
		[next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
		void update(next);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="source-priority-dialog" initialFocus={heading} finalFocus={returnFocus}>
				<header className="source-priority-heading">
					<div>
						<DialogTitle ref={heading} tabIndex={-1}>
							{copy.title}
						</DialogTitle>
						<DialogDescription>{copy.description}</DialogDescription>
					</div>
					<DialogClose render={<Button variant="ghost" size="icon-sm" aria-label={`关闭${copy.title}`} />}>
						<X />
					</DialogClose>
				</header>
				{remaining && (
					<div className="source-priority-add">
						<OptionSelect<T | ''>
							aria-label="添加封面优先图源"
							value=""
							disabled={saving || !remaining.length}
							options={[
								{ value: '', label: remaining.length ? '添加优先图源' : '已添加全部图源' },
								...remaining.map((id) => ({ value: id, label: SOURCE_LABELS[id] })),
							]}
							onValueChange={(id) => {
								const source = remaining.find((value) => value === id);
								if (source) {
									void update([...priority, source]);
								}
							}}
						/>
						<span>{priority.length} 个优先图源</span>
					</div>
				)}
				<div className="source-priority-scroll">
					<Table className="source-priority-table" data-kind={kind} aria-label={copy.list} aria-busy={saving}>
						<TableHeader>
							<TableRow>
								<TableHead className="source-priority-rank">顺序</TableHead>
								<TableHead>{kind === 'cover' ? '图源' : '来源'}</TableHead>
								<TableHead className="source-priority-actions-cell">调整</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{priority.map((id, index) => (
								<TableRow className="source-priority-item" key={id}>
									<TableCell className="source-priority-rank">{String(index + 1).padStart(2, '0')}</TableCell>
									<TableCell className="source-priority-name" title={SOURCE_LABELS[id]}>
										{SOURCE_LABELS[id]}
									</TableCell>
									<TableCell className="source-priority-actions-cell">
										<div className="source-priority-actions">
											<Button
												variant="ghost"
												size="icon-sm"
												disabled={saving || index === 0}
												aria-label={`上移 ${SOURCE_LABELS[id]} ${copy.priority}`}
												onClick={() => move(index, -1)}
											>
												<ArrowUp />
											</Button>
											<Button
												variant="ghost"
												size="icon-sm"
												disabled={saving || index === priority.length - 1}
												aria-label={`下移 ${SOURCE_LABELS[id]} ${copy.priority}`}
												onClick={() => move(index, 1)}
											>
												<ArrowDown />
											</Button>
											{additionalSources && (
												<Button
													variant="ghost"
													size="icon-sm"
													disabled={saving}
													aria-label={`移除 ${SOURCE_LABELS[id]} ${copy.priority}`}
													onClick={() => {
														void update(priority.filter((value) => value !== id));
													}}
												>
													<X />
												</Button>
											)}
										</div>
									</TableCell>
								</TableRow>
							))}
							{!priority.length && (
								<TableRow>
									<TableCell colSpan={3} className="source-priority-fallback">
										未指定优先图源，所有合格候选按分辨率选择。
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</div>
				<p className="source-priority-note">{copy.note}</p>
				<footer className="source-priority-footer">
					<Button
						variant="ghost"
						size="sm"
						disabled={saving || priority.join(',') === defaultPriority.join(',')}
						onClick={() => {
							void update([...defaultPriority]);
						}}
					>
						<RotateCcw />
						恢复默认
					</Button>
					<div>
						<span>自动保存</span>
						<DialogClose render={<Button variant="outline" size="sm" />}>完成</DialogClose>
					</div>
				</footer>
			</DialogContent>
		</Dialog>
	);
}

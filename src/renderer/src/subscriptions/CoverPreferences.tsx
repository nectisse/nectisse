import { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Image, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { OptionSelect } from '@/components/ui/select';
import { COVER_SOURCE_IDS, DEFAULT_COVER_PRIORITY, type CoverSource } from '../../../shared/cover-selection';
import { SOURCE_LABELS } from '../../../shared/sources';

export function CoverPreferences({ priority, onChange }: { priority: CoverSource[]; onChange: (value: CoverSource[]) => Promise<void> }): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const remaining = COVER_SOURCE_IDS.filter((id) => !priority.includes(id));
	const move = (index: number, delta: number): void => {
		const next = [...priority];
		[next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
		void onChange(next);
	};
	return (
		<Card className="cover-preferences gap-0 py-0 ring-0">
			<Collapsible open={open} onOpenChange={setOpen}>
				<CollapsibleTrigger render={<Button variant="ghost" aria-label="配置封面优先级" className="cover-preferences-trigger" />}>
					<Image aria-hidden="true" />
					<span>
						<strong>封面选择</strong>
						<small>
							{priority.length
								? `${priority
										.slice(0, 3)
										.map((id) => SOURCE_LABELS[id])
										.join(' → ')}${priority.length > 3 ? '…' : ''} 优先`
								: '按分辨率选择'}{' '}
							· 每部作品只保留一张
						</small>
					</span>
					<ChevronDown className={open ? 'rotate-180' : undefined} />
				</CollapsibleTrigger>
				<CollapsibleContent className="cover-preferences-content">
					<p>按顺序尝试优先图源，同一优先级取分辨率最大的可用封面；未列入的图源按分辨率兜底。</p>
					{priority.length ? (
						<ol aria-label="封面优先图源">
							{priority.map((id, index) => (
								<li key={id}>
									<span>
										<small>{index + 1}</small>
										{SOURCE_LABELS[id]}
									</span>
									<div>
										<Button
											variant="ghost"
											size="icon-xs"
											aria-label={`上移 ${SOURCE_LABELS[id]} 封面优先级`}
											disabled={index === 0}
											onClick={() => move(index, -1)}
										>
											<ArrowUp />
										</Button>
										<Button
											variant="ghost"
											size="icon-xs"
											aria-label={`下移 ${SOURCE_LABELS[id]} 封面优先级`}
											disabled={index === priority.length - 1}
											onClick={() => move(index, 1)}
										>
											<ArrowDown />
										</Button>
										<Button
											variant="ghost"
											size="icon-xs"
											aria-label={`移除 ${SOURCE_LABELS[id]} 封面优先级`}
											onClick={() => {
												void onChange(priority.filter((value) => value !== id));
											}}
										>
											<X />
										</Button>
									</div>
								</li>
							))}
						</ol>
					) : (
						<p className="cover-priority-fallback">所有合格候选统一比较分辨率。</p>
					)}
					<div className="cover-preferences-actions">
						<OptionSelect
							aria-label="添加封面优先图源"
							value=""
							disabled={!remaining.length}
							options={[{ value: '', label: '添加优先图源' }, ...remaining.map((id) => ({ value: id, label: SOURCE_LABELS[id] }))]}
							onValueChange={(id) => {
								if (COVER_SOURCE_IDS.includes(id as CoverSource) && !priority.includes(id as CoverSource)) void onChange([...priority, id as CoverSource]);
							}}
						/>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								void onChange([...DEFAULT_COVER_PRIORITY]);
							}}
						>
							恢复默认
						</Button>
					</div>
					<p>仅使用本次查询取得的图片地址，r18.dev 等资料站提供的 DMM 图片归入 DMM / FANZA。修改对下次查询生效，已有收藏封面保留。</p>
				</CollapsibleContent>
			</Collapsible>
		</Card>
	);
}

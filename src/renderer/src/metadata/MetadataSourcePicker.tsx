import { useState } from 'react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { METADATA_IDS, SOURCE_LABELS } from '@shared/sources';
import type { AllSource, SourceId } from '@shared/sources';

export function MetadataSourcePicker({
	selected,
	enabled,
	busy,
	onChange,
}: {
	selected: SourceId[];
	enabled: AllSource[];
	busy: boolean;
	onChange: (sources: SourceId[]) => void;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	return (
		<Collapsible open={open} onOpenChange={setOpen} className="metadata-source-picker">
			<CollapsibleTrigger render={<Button variant="ghost" size="sm" className="metadata-source-trigger" />} aria-label="调整资料来源">
				<span>资料来源 · 已选择 {selected.filter((id) => enabled.includes(id)).length} 个</span>
				<span>
					按作品类型匹配
					<ChevronDown className={open ? 'rotate-180' : ''} />
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="query-source-row">
					{METADATA_IDS.map((id) => (
						<Button
							variant="outline"
							size="sm"
							key={id}
							type="button"
							className={cn('source-chip', !selected.includes(id) && 'inactive')}
							disabled={busy || !enabled.includes(id)}
							aria-label={`查询使用 ${SOURCE_LABELS[id]}`}
							aria-pressed={selected.includes(id) && enabled.includes(id)}
							title={enabled.includes(id) ? '仅查询适用于当前作品类型的来源' : '先在设置的来源与账号中启用'}
							onClick={() => onChange(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id])}
						>
							{selected.includes(id) && enabled.includes(id) ? <Check /> : <Plus />}
							<span className="min-w-0 truncate">{SOURCE_LABELS[id]}</span>
						</Button>
					))}
				</div>
				<div className="metadata-source-footer">
					<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onChange(METADATA_IDS.filter((id) => enabled.includes(id)))}>
						选择全部已启用来源
					</Button>
					<p>灰色来源需在设置中启用；本次最多 24 个网络请求。</p>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

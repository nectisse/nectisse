import { usePreferences } from '@/shared/desktop';
import { firstAvailableField } from '../model/fields';
import { useState, type ReactNode } from 'react';
import { ArrowLeft, Check, ChevronRight, Clock3, Info, RefreshCw } from 'lucide-react';
import { coverSource, preferredCover } from '@shared/cover-selection';
import { SOURCE_LABELS, isActiveTask, type MetadataRecord, type QueryTask } from '@shared/metadata';
import type { MagnetOrigin } from '@shared/magnets';
import { Button } from '@/shared/ui/button';
import { PageHeader } from '@/shared/components/page-layout';
import { ContentTabs } from '@/shared/components/content-tabs';
import { StatusBadge } from '@/shared/components/status-badge';
import { CoverImage } from './CoverImage';
import { WorkPeople } from './WorkPeople';
import { SourceProvenance, metadataSnapshot, differingFields } from './SourceProvenance';
import { MagnetSearch } from './MagnetSearch';

const fetched = (value: string): string => new Date(value).toLocaleString('zh-CN', { hour12: false });

export function WorkDetail({
	records,
	task,
	onBack,
	onRefresh,
	onPerformer,
	headerActions,
	scope = 'image',
	coverId,
	backLabel = '返回查询结果',
	actions,
	onOpenSource,
	magnetOrigin,
}: {
	onPerformer?: (name: string) => void;
	records: MetadataRecord[];
	task?: QueryTask;
	onBack: () => void;
	onRefresh?: () => void;
	headerActions?: ReactNode;
	scope?: 'image' | 'library';
	coverId?: string | null;
	backLabel?: string;
	actions?: ReactNode;
	onOpenSource?: (recordId: string) => void;
	magnetOrigin?: MagnetOrigin;
}): React.JSX.Element {
	const [tab, setTab] = useState<'info' | 'sources' | 'magnets'>('info');
	const magnetsEnabled = usePreferences((state) => state.magnetSearch.enabled);
	const selectedTab = tab === 'magnets' && !magnetsEnabled ? 'info' : tab;
	const origin: MagnetOrigin | undefined = magnetOrigin ?? (task ? { kind: 'query', taskId: task.id, code: records[0]!.code } : undefined);
	const covers = records.flatMap((record) => record.covers);
	const selected =
		(coverId ? (covers.find((cover) => cover.id === coverId && cover.asset) ?? covers.find((cover) => cover.id === coverId)) : undefined) ??
		preferredCover(covers, task?.coverPriority);
	const people = firstAvailableField(records, 'people');
	const title = firstAvailableField(records, 'title') || '标题未取得';
	const facts = [
		['作品编号', records[0]!.code],
		['发行日期', firstAvailableField(records, 'releaseDate') || '未取得'],
		['厂牌', firstAvailableField(records, 'studio') || '未取得'],
		['品牌', firstAvailableField(records, 'label') || '未取得'],
		['系列', firstAvailableField(records, 'series') || '未取得'],
		['卖家', firstAvailableField(records, 'seller') || '未取得'],
		...(firstAvailableField(records, 'deliveryDate') ? [['配信开始日', firstAvailableField(records, 'deliveryDate')]] : []),
	];
	const snapshots = records.map(metadataSnapshot);
	const differences = differingFields(snapshots);
	return (
		<div className="page detail-page live-detail">
			<PageHeader
				title="作品详情"
				description={`${records[0]!.code} · ${scope === 'library' ? '已收藏的本机资料快照' : '查询资料与来源封面'}`}
				actions={
					<>
						<Button variant="ghost" size="sm" onClick={onBack}>
							<ArrowLeft />
							{backLabel}
						</Button>
						{onRefresh && (
							<Button variant="outline" size="sm" onClick={onRefresh} disabled={task && isActiveTask(task)}>
								<RefreshCw />
								重新查询这部作品
							</Button>
						)}
						{headerActions}
					</>
				}
			/>
			<div className="detail-layout">
				<section>
					<CoverImage cover={selected} scope={scope} className="live-cover-main" />
					<div className="cover-caption">
						<span>
							{selected ? SOURCE_LABELS[coverSource(selected)] : '来源封面'}
							{selected?.asset ? ` · ${selected.asset.width} × ${selected.asset.height}` : ''}
						</span>
						<span>{selected?.asset?.quality === 'small' ? '小尺寸原图' : '来源原图'}</span>
					</div>
				</section>
				<section className="work-info">
					<span className="detail-code">{records[0]!.code}</span>
					<h2 className="detail-title">{title}</h2>
					<div className="detail-status">
						<StatusBadge tone="success">
							<Check />
							作品身份已核对
						</StatusBadge>
						<StatusBadge>{records.length} 个来源记录</StatusBadge>
						<StatusBadge>{selected?.asset ? '封面已缓存' : '封面未取得'}</StatusBadge>
					</div>
					{actions}
					<ContentTabs<'info' | 'sources' | 'magnets'>
						value={selectedTab}
						onChange={setTab}
						label="真实作品详情"
						items={[
							{ value: 'info', label: '作品资料' },
							{ value: 'sources', label: '来源与差异' },
							...(origin && magnetsEnabled ? [{ value: 'magnets' as const, label: '磁链搜索' }] : []),
						]}
					>
						{selectedTab === 'info' ? (
							<>
								<dl className="facts-grid">
									{facts.map(([label, value]) => (
										<div key={label}>
											<dt>{label}</dt>
											<dd>{value}</dd>
										</div>
									))}
								</dl>
								{differences.length > 0 && (
									<Button variant="text" size="text" className="conflict-note" onClick={() => setTab('sources')}>
										<Info />
										<span>{differences.length} 个字段存在来源差异，原值均已保留</span>
										<ChevronRight />
									</Button>
								)}
								<h2 className="summary-title">人物与角色</h2>
								{people.length ? (
									<WorkPeople people={people} onPerformer={onPerformer} />
								) : (
									<p className="summary-text">来源没有提供人物资料。不会从标题推断人物身份。</p>
								)}
								<h2 className="summary-title">标签 · 来源原词</h2>
								<div className="tag-row">
									{firstAvailableField(records, 'tags').map((tag, index) => (
										<StatusBadge key={`${tag}-${index}`}>{tag}</StatusBadge>
									))}
								</div>
								<h2 className="summary-title">作品简介</h2>
								<p className="summary-text">{firstAvailableField(records, 'description') || '来源未提供可用简介'}</p>
								<p className="panel-note">
									{scope === 'library'
										? '保留收藏时采用的资料顺序及各来源原值。人物、卖家与可关注账号保持各自角色。'
										: '采用顺序由设置中的资料优先级决定；FC2 独立查询。人物、卖家与可关注账号保持各自角色。'}
								</p>
							</>
						) : selectedTab === 'magnets' && origin ? (
							<MagnetSearch key={records[0]!.code} origin={origin} code={records[0]!.code} />
						) : (
							<SourceProvenance
								snapshots={snapshots}
								onOpenSource={(snapshot) => {
									if (onOpenSource) {
										onOpenSource(snapshot.id);
									}
								}}
							/>
						)}
					</ContentTabs>
					{tab === 'info' &&
						records
							.flatMap((record) => record.warnings)
							.map((warning, index) => (
								<p key={index} className="panel-note source-problem">
									{warning}
								</p>
							))}
					<p className="source-footnote">
						<Clock3 />
						实际获取于 {fetched(records[0]!.fetchedAt)}
					</p>
				</section>
			</div>
		</div>
	);
}

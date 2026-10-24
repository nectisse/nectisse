import { useId, useState } from 'react';
import { Check, ChevronDown, ExternalLink, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { StatusBadge } from '@/components/status-badge';
import { SOURCE_LABELS, type MetadataRecord } from '@shared/metadata';

interface SnapshotField {
	key: string;
	label: string;
	value: string;
	comparisonKey?: string;
}

export interface SourceSnapshot {
	id: string;
	name: string;
	url: string;
	fetchedAt: string;
	contentId: string;
	parserVersion: string;
	fields: SnapshotField[];
	warnings: string[];
}

export function metadataSnapshot(record: MetadataRecord): SourceSnapshot {
	const roles = { performer: '出演', director: '导演', seller: '卖家' };
	return {
		id: record.id,
		name: SOURCE_LABELS[record.source],
		url: record.sourceUrl,
		fetchedAt: record.fetchedAt,
		contentId: record.contentId,
		parserVersion: record.parserVersion,
		warnings: record.warnings,
		fields: [
			{ key: 'title', label: '标题', value: record.title },
			{ key: 'releaseDate', label: '发行日期', value: record.releaseDate },
			{ key: 'deliveryDate', label: '配信开始日', value: record.deliveryDate },
			{ key: 'studio', label: '厂牌', value: record.studio },
			{ key: 'label', label: '品牌', value: record.label },
			{ key: 'series', label: '系列', value: record.series },
			{ key: 'seller', label: '卖家', value: record.seller },
			{
				key: 'people',
				label: '人物与角色',
				value: record.people.map((person) => `${person.name}（${roles[person.role]}）`).join('、'),
				comparisonKey: JSON.stringify(record.people.map((person) => `${person.role}:${person.name}`).sort()),
			},
			{ key: 'tags', label: '标签', value: record.tags.join('、'), comparisonKey: JSON.stringify([...record.tags].sort()) },
			{ key: 'description', label: '简介', value: record.description },
		],
	};
}

function fieldGroups(snapshots: SourceSnapshot[], key: string): { value: string; sources: string[]; comparisonKey: string }[] {
	const groups = new Map<string, { value: string; sources: string[]; comparisonKey: string }>();
	for (const snapshot of snapshots) {
		const field = snapshot.fields.find((field) => field.key === key);

		// 缺失不是冲突；只有两个来源都给出非空且不同的值才显示字段差异。
		if (!field?.value.trim()) {
			continue;
		}
		const comparisonKey = field.comparisonKey ?? field.value.trim();
		const group = groups.get(comparisonKey);
		if (group) {
			if (!group.sources.includes(snapshot.name)) {
				group.sources.push(snapshot.name);
			}
		} else {
			groups.set(comparisonKey, { value: field.value, sources: [snapshot.name], comparisonKey });
		}
	}
	return [...groups.values()];
}

export function differingFields(snapshots: SourceSnapshot[]): SnapshotField[] {
	const fields = new Map(snapshots.flatMap((snapshot) => snapshot.fields).map((field) => [field.key, field]));
	return [...fields.values()].filter((field) => fieldGroups(snapshots, field.key).length > 1);
}

const dateLabel = (value: string): string => {
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? value || '未记录' : date.toLocaleString('zh-CN', { hour12: false });
};

const hostname = (value: string): string => {
	try {
		return new URL(value).hostname;
	} catch {
		return value;
	}
};

function SourceValue({ value }: { value: string }): React.JSX.Element {
	const [expanded, setExpanded] = useState(false);
	const id = useId();
	return (
		<div className="provenance-value">
			<p id={id} className={value.length > 160 && !expanded ? 'provenance-value-clamped' : undefined}>
				{value}
			</p>
			{value.length > 160 && (
				<Button
					variant="text"
					size="text"
					className="provenance-expand-text"
					aria-expanded={expanded}
					aria-controls={id}
					onClick={() => setExpanded((previous) => !previous)}
				>
					{expanded ? '收起全文' : '展开全文'}
				</Button>
			)}
		</div>
	);
}

export function SourceProvenance({
	snapshots,
	onOpenSource,
	demo = false,
	preferredValues,
	onResolveDifference,
}: {
	snapshots: SourceSnapshot[];
	onOpenSource: (snapshot: SourceSnapshot) => void;
	demo?: boolean;
	preferredValues?: Record<string, { value: string; source: string }>;
	onResolveDifference?: () => void;
}): React.JSX.Element {
	const [expandedId, setExpandedId] = useState(snapshots.length === 1 ? snapshots[0]!.id : '');
	const differences = differingFields(snapshots);
	const id = useId();
	return (
		<div className="source-provenance">
			<section aria-labelledby={`${id}-comparison`}>
				<div className="provenance-section-heading">
					<h2 id={`${id}-comparison`}>字段对照</h2>
					{differences.length > 0 && <StatusBadge tone="peach">{differences.length} 项差异</StatusBadge>}
					{onResolveDifference && differences.length > 0 && (
						<Button variant="ghost" size="sm" onClick={onResolveDifference}>
							查看字段差异
						</Button>
					)}
				</div>
				{differences.length > 0 ? (
					<>
						<p className="provenance-description">{demo ? '示例采用值仅用于本次预览。' : '按资料优先级采用首个可用值，保留各来源原文。'}缺失字段不计为差异。</p>
						<Card className="provenance-card gap-0 py-0 ring-0">
							<Table className="provenance-table provenance-comparison" aria-label="来源字段差异对照">
								<TableHeader>
									<TableRow>
										<TableHead>字段</TableHead>
										<TableHead>当前采用</TableHead>
										<TableHead>其他来源原值</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{differences.map((field) => {
										const groups = fieldGroups(snapshots, field.key);
										const preferred = preferredValues?.[field.key];
										const current = preferred ?? { value: groups[0]!.value, source: groups[0]!.sources.join(' · ') };
										const alternatives = preferred ? groups.filter((group) => group.value !== preferred.value) : groups.slice(1);
										return (
											<TableRow key={field.key}>
												<TableCell className="provenance-field-name">{field.label}</TableCell>
												<TableCell>
													<div className="provenance-adopted">
														<SourceValue value={current.value} />
														<small>{current.source}</small>
													</div>
												</TableCell>
												<TableCell>
													<div className="provenance-alternatives">
														{alternatives.map((group) => (
															<div key={group.comparisonKey}>
																<SourceValue value={group.value} />
																<small>{group.sources.join(' · ')}</small>
															</div>
														))}
													</div>
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</Card>
					</>
				) : (
					<div className="provenance-consistent">
						{snapshots.length > 1 ? <Check /> : <Info />}
						<p>
							{snapshots.length > 1 ? '已取得的字段未发现不同值。' : '当前仅有一个来源，暂无法交叉对照。'}
							<span>可在下方查看各来源提供的原始资料。</span>
						</p>
					</div>
				)}
			</section>
			<section aria-labelledby={`${id}-records`}>
				<div className="provenance-section-heading">
					<h2 id={`${id}-records`}>来源记录</h2>
					<span>
						{snapshots.length} 个来源 · 展开查看原始资料{demo ? ' · 演示' : ''}
					</span>
				</div>
				<Card className="provenance-card provenance-records gap-0 py-0 ring-0">
					{snapshots.map((snapshot) => {
						const provided = snapshot.fields.filter((field) => field.value.trim());
						const missing = snapshot.fields.filter((field) => !field.value.trim());

						return (
							<Collapsible
								key={snapshot.id}
								className="provenance-record"
								open={expandedId === snapshot.id}
								onOpenChange={(open) => setExpandedId(open ? snapshot.id : '')}
							>
								<CollapsibleTrigger render={<Button variant="text" size="text" className="provenance-record-trigger" aria-label={`${snapshot.name} 原始资料`} />}>
									<span className="provenance-source-mark" aria-hidden="true">
										{snapshot.name[0]}
									</span>
									<span className="provenance-source-name">
										<strong>{snapshot.name}</strong>
										<small>
											{hostname(snapshot.url)} · {provided.length} 个字段
										</small>
									</span>
									<StatusBadge tone={demo ? 'neutral' : 'success'}>{demo ? '示例记录' : '身份已核对'}</StatusBadge>
									<ChevronDown className="provenance-chevron" />
								</CollapsibleTrigger>
								<CollapsibleContent className="provenance-record-content">
									<div className="provenance-record-meta">
										<div>
											<span>获取时间</span>
											<time dateTime={snapshot.fetchedAt}>{dateLabel(snapshot.fetchedAt)}</time>
										</div>
										<Button variant="outline" size="sm" onClick={() => onOpenSource(snapshot)}>
											查看原文
											<ExternalLink />
										</Button>
									</div>
									<Table className="provenance-table live-source-fields" aria-label={`${snapshot.name} 来源字段`}>
										<TableBody>
											{provided.map((field) => (
												<TableRow key={field.key}>
													<TableCell className="provenance-field-name">{field.label}</TableCell>
													<TableCell>
														<SourceValue value={field.value} />
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
									{missing.length > 0 && (
										<p className="provenance-missing">
											<span>未提供</span>
											{missing.map((field) => field.label).join('、')}
										</p>
									)}
									{snapshot.warnings.length > 0 && (
										<Alert className="provenance-warning">
											<Info />
											<AlertDescription>
												{snapshot.warnings.map((warning) => (
													<p key={warning}>{warning}</p>
												))}
											</AlertDescription>
										</Alert>
									)}
									<Collapsible className="provenance-technical">
										<CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
											采集信息
											<ChevronDown className="provenance-chevron" />
										</CollapsibleTrigger>
										<CollapsibleContent>
											<dl>
												<div>
													<dt>商品身份</dt>
													<dd>{snapshot.contentId || '未取得'}</dd>
												</div>
												<div>
													<dt>解析器版本</dt>
													<dd>{snapshot.parserVersion || '未记录'}</dd>
												</div>
												<div>
													<dt>原文地址</dt>
													<dd>
														<code>{snapshot.url}</code>
													</dd>
												</div>
											</dl>
										</CollapsibleContent>
									</Collapsible>
								</CollapsibleContent>
							</Collapsible>
						);
					})}
				</Card>
			</section>
			<p className="provenance-footnote">
				{demo ? '虚构来源与字段，仅用于布局预览。采用值的调整只保留在本次演示中。' : '原始资料按来源保留，收藏保存当前资料快照。手动字段修正尚未接入。'}
			</p>
		</div>
	);
}

import { Fragment, useState } from 'react';
import { ArrowUp, ChevronDown, ExternalLink, KeyRound, Search, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { EmptyState } from '@/components/empty-state';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OptionSelect } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SOURCES, SOURCE_LABELS, isFollowProvider, type SourceSpec } from '../../../shared/sources';
import type { AllSource, FollowProvider, Preferences } from '../../../shared/subscriptions';
import { StatusBadge } from '../prototype/components';
import { useSubscriptions } from './context';
import { CoverPreferences } from './CoverPreferences';

function Credential({ provider }: { provider: AllSource }): React.JSX.Element {
	const { state, invoke } = useSubscriptions();
	const [cookie, setCookie] = useState('');
	const [busy, setBusy] = useState(false);
	const present = state.sources.find((row) => row.id === provider)?.credentialPresent;
	const save = async (value: string): Promise<void> => {
		setBusy(true);
		try {
			const reply = await invoke({ action: 'credential', provider, cookie: value });
			if (reply.ok) setCookie('');
			if (reply.ok) toast.success(value ? '已安全保存；有效性以实际查询为准' : '已清除本机凭据', { id: `credential:${provider}` });
			else toast.error(reply.message || '保存失败', { id: `credential:${provider}`, duration: 8000 });
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			className="source-credential-form"
			onSubmit={(event) => {
				event.preventDefault();
				void save(cookie);
			}}
		>
			<Label htmlFor={`cookie-${provider}`}>
				<KeyRound size={13} />
				Cookie<small>{present ? '已加密保存' : '未配置'}</small>
			</Label>
			<Input
				id={`cookie-${provider}`}
				type="password"
				value={cookie}
				onChange={(event) => setCookie(event.target.value)}
				autoComplete="off"
				spellCheck={false}
				placeholder={present ? '原值不回显，输入新 Cookie 以替换' : '粘贴浏览器中的 Cookie 请求头'}
				aria-label={`${provider} Cookie`}
			/>
			<div className="settings-actions">
				<Button size="sm" disabled={busy || !cookie.trim() || !state.encryptionAvailable}>
					安全保存
				</Button>
				{present && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => {
							void save('');
						}}
					>
						清除 Cookie
					</Button>
				)}
			</div>
			<p className="source-detail-note">仅供本站使用，通过 macOS 安全存储加密；登录与浏览器验证以实际访问为准。</p>
			{!state.encryptionAvailable && <p className="source-problem">系统安全存储不可用，当前不会保存 Cookie。</p>}
		</form>
	);
}

function SourceDetail({
	source,
	onAdd,
	save,
}: {
	source: SourceSpec;
	onAdd: (provider?: FollowProvider) => void;
	save: (patch: Partial<Preferences>) => Promise<void>;
}): React.JSX.Element {
	const { state, invoke } = useSubscriptions();
	const preferences = state.preferences;
	const status = state.sources.find((row) => row.id === source.id);
	const transport =
		preferences.sourceTransports[source.id] ??
		(source.id === 'fanbox'
			? preferences.fanboxTransport
			: source.id === 'javdb'
				? preferences.javdbTransport
				: ['dmm', 'r18dev', 'fc2'].includes(source.id)
					? 'httpx'
					: 'fingerprint');
	return (
		<div className="source-detail" id={`source-detail-${source.id}`}>
			<div className="source-detail-about">
				<h3>{source.name}</h3>
				<p>{source.note}</p>
				<dl className="source-detail-facts">
					<div>
						<dt>账号</dt>
						<dd>{!source.available ? '前置条件见来源说明' : source.credential ? (status?.credentialPresent ? 'Cookie 已保存' : '未配置 Cookie') : '公开资料连接'}</dd>
					</div>
					<div>
						<dt>最近访问</dt>
						<dd>{status?.checkedAt ? new Date(status.checkedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未检查'}</dd>
					</div>
					<div>
						<dt>访问状态</dt>
						<dd>{status?.state || '未检查'}</dd>
					</div>
				</dl>
				{status?.message && (
					<p className="source-problem" role="status">
						{status.message}
					</p>
				)}
				{!!status?.cooldownUntil && status.cooldownUntil > Date.now() && (
					<p className="source-problem">冷却至 {new Date(status.cooldownUntil).toLocaleTimeString('zh-CN')}</p>
				)}
				<div className="settings-actions">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							void invoke({ action: 'open', kind: 'source', id: source.id });
						}}
					>
						打开站点
						<ExternalLink />
					</Button>
					{isFollowProvider(source.id) && (
						<Button type="button" variant="ghost" size="sm" onClick={() => onAdd(source.id as FollowProvider)}>
							查询并添加关注
						</Button>
					)}
				</div>
			</div>
			{source.available && (
				<div className="source-detail-controls">
					<div className="source-transport-field">
						<Label htmlFor={`transport-${source.id}`}>连接方式</Label>
						<OptionSelect
							id={`transport-${source.id}`}
							aria-label={`${source.id} 传输`}
							className="w-full"
							value={transport}
							onValueChange={(value) => {
								void save({ sourceTransports: { ...preferences.sourceTransports, [source.id]: value as 'httpx' | 'fingerprint' } });
							}}
							options={[
								{ value: 'httpx', label: '标准连接' },
								{ value: 'fingerprint', label: '浏览器指纹' },
							]}
						/>
						<p className="source-detail-note">沿用全局代理；浏览器指纹不等于完成登录或验证。</p>
					</div>
					{source.credential && <Credential key={source.id} provider={source.id} />}
				</div>
			)}
		</div>
	);
}

const capabilities = (source: SourceSpec): string =>
	[
		source.metadata ? '资料' : '',
		source.metadata && source.images.length && source.id !== 'javdb' ? '封面' : '',
		source.follow ? (source.id === 'javdb' ? '演员新作' : '动态订阅') : '',
	]
		.filter(Boolean)
		.join(' · ') || '—';
const statusLabel = (value: string | undefined): string => (value?.includes('尚未验证') ? '待验证' : value === '最近访问成功' ? '最近成功' : value || '未检查');

export function SourceCatalog({ onAdd, save }: { onAdd: (provider?: FollowProvider) => void; save: (patch: Partial<Preferences>) => Promise<void> }): React.JSX.Element {
	const { state } = useSubscriptions();
	const [filter, setFilter] = useState('all');
	const [search, setSearch] = useState('');
	const [selected, setSelected] = useState<AllSource | null>(null);
	const [priorityOpen, setPriorityOpen] = useState(false);
	const preferences = state.preferences;
	const visible = SOURCES.filter(
		(row) =>
			(filter === 'all' ||
				(filter === 'enabled' && preferences.enabledSources.includes(row.id)) ||
				(filter === 'metadata' && row.metadata) ||
				(filter === 'follow' && row.follow) ||
				(filter === 'reference' && !row.available)) &&
			`${row.name} ${row.id} ${row.note}`.toLowerCase().includes(search.toLowerCase()),
	);
	return (
		<div className="source-catalog">
			<CoverPreferences priority={preferences.coverPriority} onChange={(coverPriority) => save({ coverPriority })} />
			<div className="source-catalog-controls">
				<div className="source-search">
					<Search size={14} aria-hidden="true" />
					<Input aria-label="搜索来源" placeholder="搜索站点名称或能力" value={search} onChange={(event) => setSearch(event.target.value)} />
				</div>
				<OptionSelect
					aria-label="来源用途"
					value={filter}
					onValueChange={setFilter}
					options={[
						{ value: 'all', label: `全部来源 · ${SOURCES.length}` },
						{ value: 'enabled', label: '已启用' },
						{ value: 'metadata', label: '作品资料与封面' },
						{ value: 'follow', label: '演员／创作者订阅' },
						{ value: 'reference', label: '需要额外适配' },
					]}
				/>
				<span className="source-catalog-count">{preferences.enabledSources.length} 个已启用</span>
			</div>
			<Card className="settings-card source-table-card gap-0 py-0 ring-0">
				<Table aria-label="站点来源" className="source-table">
					<TableHeader>
						<TableRow>
							<TableHead>站点</TableHead>
							<TableHead>用途</TableHead>
							<TableHead>访问状态</TableHead>
							<TableHead className="source-enable-cell">启用</TableHead>
							<TableHead className="source-config-cell">
								<span className="sr-only">配置</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{visible.map((source) => {
							const status = state.sources.find((row) => row.id === source.id);
							const open = selected === source.id;
							return (
								<Fragment key={source.id}>
									<TableRow className="settings-source" data-state={open ? 'selected' : undefined}>
										<TableCell>
											<div className="source-identity">
												<span className="source-monogram" aria-hidden="true">
													{source.name.slice(0, 1).toUpperCase()}
												</span>
												<div>
													<strong title={source.name}>{source.name}</strong>
													<small>{source.domains[0] || source.id}</small>
												</div>
											</div>
										</TableCell>
										<TableCell className="source-capabilities">{capabilities(source)}</TableCell>
										<TableCell>
											<span title={status?.state}>
												<StatusBadge tone={status?.state === '最近访问成功' ? 'success' : status?.message ? 'peach' : 'neutral'}>
													{!source.available ? '需要额外适配' : statusLabel(status?.state)}
												</StatusBadge>
											</span>
										</TableCell>
										<TableCell className="source-enable-cell">
											<Switch
												aria-label={`启用 ${source.name}`}
												disabled={!source.available}
												checked={preferences.enabledSources.includes(source.id)}
												onCheckedChange={(checked) => {
													void save({
														enabledSources: checked
															? [...preferences.enabledSources, source.id]
															: preferences.enabledSources.filter((id) => id !== source.id),
													});
												}}
											/>
										</TableCell>
										<TableCell className="source-config-cell">
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												aria-label={`配置 ${source.name}`}
												aria-expanded={open}
												aria-controls={open ? `source-detail-${source.id}` : undefined}
												onClick={() => setSelected(open ? null : source.id)}
											>
												{open ? <ChevronDown /> : <Settings2 />}
											</Button>
										</TableCell>
									</TableRow>
									{open && (
										<TableRow className="source-detail-row">
											<TableCell colSpan={5}>
												<SourceDetail source={source} onAdd={onAdd} save={save} />
											</TableCell>
										</TableRow>
									)}
								</Fragment>
							);
						})}
					</TableBody>
				</Table>
				{!visible.length && (
					<EmptyState
						compact
						headingLevel={3}
						icon={Search}
						title="没有匹配的来源"
						description="试试其他名称，或清除当前筛选。"
						action={{
							label: '清除筛选',
							onClick: () => {
								setSearch('');
								setFilter('all');
							},
						}}
					/>
				)}
				<div className="source-table-footer">
					<span>{visible.length} 个来源</span>
					<span>按需启用 · 配置连接与账号后，在查询中验证</span>
				</div>
			</Card>
			<Collapsible open={priorityOpen} onOpenChange={setPriorityOpen} className="source-priority">
				<CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" />}>
					<ArrowUp />
					资料采用顺序
					<ChevronDown className={priorityOpen ? 'rotate-180' : ''} />
				</CollapsibleTrigger>
				<CollapsibleContent>
					<p className="source-detail-note">采用第一个非空值，保留各站原值；仅请求本次选中且已启用的来源。</p>
					<div className="source-priority-list">
						{preferences.metadataPriority.map((id, index) => (
							<div className="source-priority-item" key={id}>
								<span>
									<small>{String(index + 1).padStart(2, '0')}</small>
									{SOURCE_LABELS[id]}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									disabled={index === 0}
									aria-label={`提高 ${id} 优先级`}
									onClick={() => {
										const priority = [...preferences.metadataPriority];
										[priority[index - 1], priority[index]] = [priority[index]!, priority[index - 1]!];
										void save({ metadataPriority: priority });
									}}
								>
									<ArrowUp />
								</Button>
							</div>
						))}
					</div>
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}

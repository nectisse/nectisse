import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, Check, FileText, Globe2, HardDrive, Monitor, Network, Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/page-layout';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OptionSelect } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { FollowProvider, Preferences } from '../../../shared/subscriptions';
import { StatusBadge } from '../prototype/components';
import { useSubscriptions } from './context';
import { SourceCatalog } from './SourceCatalog';
import { DiagnosticsDialog } from './DiagnosticsDialog';

function SettingRow({ label, description, children }: { label: string; description?: string; children: ReactNode }): React.JSX.Element {
	return (
		<div className="settings-row">
			<div className="settings-row-label">
				<h3>{label}</h3>
				{description && <p>{description}</p>}
			</div>
			<div className="settings-value">{children}</div>
		</div>
	);
}

const sections = [
	{ value: 'sources', label: '来源与账号', icon: Globe2 },
	{ value: 'subscriptions', label: '订阅管理', icon: Bell },
	{ value: 'network', label: '网络与存储', icon: Network },
	{ value: 'general', label: '外观与应用', icon: Palette },
] as const;

export type SettingsSection = (typeof sections)[number]['value'];

export function SettingsPage({
	onAdd,
	onDemo,
	section,
	onSectionChange,
}: {
	onAdd: (provider?: FollowProvider) => void;
	onDemo: () => void;
	section: SettingsSection;
	onSectionChange: (section: SettingsSection) => void;
}): React.JSX.Element {
	const { state, invoke } = useSubscriptions();
	const [proxy, setProxy] = useState(state.preferences.proxyUrl);
	const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
	const diagnosticsTrigger = useRef<HTMLButtonElement | null>(null);
	const preferences = state.preferences;

	useEffect(() => {
		setProxy(preferences.proxyUrl);
	}, [preferences.proxyUrl]);

	const save = async (patch: Partial<Preferences>): Promise<void> => {
		const reply = await invoke({ action: 'preferences', value: { ...preferences, ...patch } });
		if (reply.ok) {
			toast.success('设置已保存', { id: 'settings-save' });
		} else {
			toast.error(reply.message || '设置未保存', { id: 'settings-save', duration: 8000 });
		}
	};

	return (
		<div className="page settings-page">
			<PageHeader title="设置" description="管理资料来源、订阅与本机连接。" />
			<Tabs
				value={section}
				onValueChange={(value) => {
					const next = sections.find((item) => item.value === value);
					if (next) {
						onSectionChange(next.value);
					}
				}}
				className="settings-tabs"
			>
				<TabsList variant="line" aria-label="设置分区">
					{sections.map((item) => (
						<TabsTrigger key={item.value} value={item.value}>
							<item.icon aria-hidden="true" />
							{item.label}
						</TabsTrigger>
					))}
				</TabsList>
				<TabsContent value="sources">
					<SourceCatalog onAdd={onAdd} save={save} />
				</TabsContent>
				<TabsContent value="subscriptions">
					<section className="settings-section settings-preferences">
						<div className="settings-section-heading">
							<h2>默认检查策略</h2>
							<p>单个订阅可以设置自己的频率。</p>
						</div>
						<Card className="settings-card gap-0 py-0 ring-0">
							<SettingRow label="自动检查" description="仅在 App 运行期间执行；取消任务后需手动恢复。">
								<Switch
									checked={preferences.automatic}
									aria-label="自动检查订阅"
									onCheckedChange={(automatic) => {
										void save({ automatic });
									}}
								/>
							</SettingRow>
							<SettingRow label="创作者动态">
								<OptionSelect
									aria-label="创作者默认检查频率"
									className="w-full"
									value={preferences.creatorMinutes}
									onValueChange={(creatorMinutes) => {
										void save({ creatorMinutes });
									}}
									options={[
										{ value: 30, label: '每 30 分钟' },
										{ value: 60, label: '每小时' },
										{ value: 180, label: '每 3 小时' },
										{ value: 360, label: '每 6 小时' },
										{ value: 1440, label: '每天' },
									]}
								/>
							</SettingRow>
							<SettingRow label="演员新作">
								<OptionSelect
									aria-label="演员默认检查频率"
									className="w-full"
									value={preferences.performerMinutes}
									onValueChange={(performerMinutes) => {
										void save({ performerMinutes });
									}}
									options={[
										{ value: 360, label: '每 6 小时' },
										{ value: 720, label: '每 12 小时' },
										{ value: 1440, label: '每天' },
										{ value: 10080, label: '每周' },
									]}
								/>
							</SettingRow>
							<div className="settings-card-note">
								<Check size={14} />
								<p>首次检查来源首页；增量最多两页。较早内容未覆盖时，会在订阅中注明。</p>
							</div>
						</Card>
					</section>
				</TabsContent>
				<TabsContent value="network">
					<section className="settings-section settings-preferences">
						<div className="settings-section-heading">
							<h2>连接方式</h2>
							<p>所有已启用的来源共用代理设置。</p>
						</div>
						<Card className="settings-card gap-0 py-0 ring-0">
							<SettingRow label="网络代理" description="仅影响 Nectisse 的请求。">
								<OptionSelect
									aria-label="网络代理"
									className="w-full"
									value={preferences.proxyMode}
									onValueChange={(value) => {
										const proxyMode = value as Preferences['proxyMode'];
										if (proxyMode === 'custom' && !proxy.trim()) {
											toast.error('填写下方代理地址，再保存独立代理', { id: 'settings-save', duration: 8000 });
											return;
										}
										void save({ proxyMode, proxyUrl: proxy });
									}}
									options={[
										{ value: 'system', label: '使用系统代理' },
										{ value: 'direct', label: '直接连接' },
										{ value: 'custom', label: '独立代理' },
									]}
								/>
							</SettingRow>
							<form
								className="settings-proxy-form"
								onSubmit={(event) => {
									event.preventDefault();
									void save({ proxyMode: 'custom', proxyUrl: proxy });
								}}
							>
								<Label htmlFor="proxy-address">独立代理地址</Label>
								<div className="settings-proxy-controls">
									<Input
										id="proxy-address"
										value={proxy}
										aria-label="独立代理地址"
										onChange={(event) => setProxy(event.target.value)}
										placeholder="http://127.0.0.1:7890"
										autoComplete="off"
										spellCheck={false}
									/>
									<Button variant="outline" disabled={!proxy.trim()}>
										保存并使用
									</Button>
								</div>
								<p className="settings-field-hint">支持 HTTP 与 SOCKS；例如 http://127.0.0.1:7890 或 socks5h://127.0.0.1:7890。</p>
							</form>
							<div className="settings-card-note">
								<p>各站的连接方式在“来源与账号”中配置；遇到地区限制时，请调整代理出口。</p>
							</div>
						</Card>
					</section>
					<section className="settings-section settings-preferences">
						<div className="settings-section-heading">
							<h2>本机存储</h2>
						</div>
						<Card className="settings-card gap-0 py-0 ring-0">
							<SettingRow label="资料与订阅" description="设置、订阅与已读状态保存在应用数据目录，重启后保留。">
								<HardDrive size={17} className="text-muted-foreground" />
							</SettingRow>
							<SettingRow label="封面缓存" description="自动补齐最近 500 条更新封面，优先保留当前列表；超额清理旧缓存。">
								<span className="settings-storage-limit">作品 128 MiB · 订阅 64 MiB</span>
							</SettingRow>
						</Card>
					</section>
				</TabsContent>
				<TabsContent value="general">
					<section className="settings-section settings-preferences">
						<div className="settings-section-heading">
							<h2>外观</h2>
						</div>
						<Card className="settings-card gap-0 py-0 ring-0">
							<SettingRow label="界面主题">
								<OptionSelect
									value={preferences.theme}
									aria-label="界面主题"
									className="w-full"
									onValueChange={(value) => {
										void save({ theme: value as Preferences['theme'] });
									}}
									options={[
										{ value: 'cream', label: '奶油档案' },
										{ value: 'night', label: '黑莓夜间' },
									]}
								/>
							</SettingRow>
						</Card>
					</section>
					<section className="settings-section settings-preferences" aria-labelledby="visual-demo-heading">
						<div className="settings-section-heading">
							<h2 id="visual-demo-heading">视觉演示</h2>
						</div>
						<Card className="settings-card gap-0 py-0 ring-0">
							<SettingRow label="示例资料预览" description="浏览示例作品、创作者与更新，演示操作不保存到资料库。">
								<Button id="open-visual-demo" variant="outline" size="sm" onClick={onDemo}>
									<Monitor aria-hidden="true" />
									打开演示
								</Button>
							</SettingRow>
						</Card>
					</section>
					<section className="settings-section settings-preferences">
						<div className="settings-section-heading">
							<h2>运行与退出</h2>
						</div>
						<Card className="settings-card gap-0 py-0 ring-0">
							<SettingRow label="关闭窗口" description="App 保持运行，继续按设置检查订阅。">
								<StatusBadge>后台运行</StatusBadge>
							</SettingRow>
							<SettingRow label="退出 Nectisse" description="停止本应用的任务与工作者。">
								<kbd className="settings-shortcut">⌘ Q</kbd>
							</SettingRow>
							<SettingRow label="Nectisse 0.1.0">
								<StatusBadge>本机开发版</StatusBadge>
							</SettingRow>
						</Card>
					</section>
					<section className="settings-section settings-preferences">
						<div className="settings-section-heading">
							<h2>诊断与排查</h2>
						</div>
						<Card className="settings-card gap-0 py-0 ring-0">
							<SettingRow label="诊断日志" description="查看最近的启动与本地读取异常，复制信息以便排查。">
								<Button ref={diagnosticsTrigger} variant="outline" size="sm" aria-label="查看诊断日志" onClick={() => setDiagnosticsOpen(true)}>
									<FileText />
									查看日志
								</Button>
							</SettingRow>
						</Card>
					</section>
				</TabsContent>
			</Tabs>
			<DiagnosticsDialog open={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} returnFocus={diagnosticsTrigger} />
		</div>
	);
}

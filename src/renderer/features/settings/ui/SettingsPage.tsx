import { usePreferences, useDesktopActions } from '@/shared/desktop';
import type { PreferencesPatch, Preferences } from '@shared/preferences';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, Check, ExternalLink, FileText, Globe2, Magnet, Monitor, Network, Palette } from 'lucide-react';
import { EXTERNAL_MAGNET_SITES, MAGNET_SOURCES, magnetSourceSchema } from '@shared/magnets';
import { Button } from '@/shared/ui/button';
import { toast } from '@/shared/ui/sonner';
import { PageHeader } from '@/shared/components/page-layout';
import { Card } from '@/shared/ui/card';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { OptionSelect } from '@/shared/ui/select';
import { Switch } from '@/shared/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs';
import type { FollowProvider } from '@shared/subscriptions';
import { StatusBadge } from '@/shared/components/status-badge';
import { SourceCatalog } from './SourceCatalog';
import { DiagnosticsDialog } from './DiagnosticsDialog';
import { StorageSection } from './StorageSection';

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
	{ value: 'magnets', label: '磁链搜索', icon: Magnet },
	{ value: 'network', label: '网络与存储', icon: Network },
	{ value: 'general', label: '外观与应用', icon: Palette },
] as const;

export type SettingsSection = (typeof sections)[number]['value'];

export function SettingsPage({
	onAdd,
	onDemo,
	section,
	onSectionChange,
	demo = false,
}: {
	onAdd: (provider?: FollowProvider) => void;
	onDemo: () => void;
	section: SettingsSection;
	onSectionChange: (section: SettingsSection) => void;
	demo?: boolean;
}): React.JSX.Element {
	const preferences = usePreferences((state) => state);
	const { updatePreferences, magnets } = useDesktopActions();
	const [proxy, setProxy] = useState(preferences.proxyUrl);
	const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
	const diagnosticsTrigger = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		setProxy(preferences.proxyUrl);
	}, [preferences.proxyUrl]);

	const save = async (patch: PreferencesPatch): Promise<void> => {
		const reply = await updatePreferences(patch);
		if (reply.ok) {
			toast.success('设置已保存', { id: 'settings-save' });
		} else {
			toast.error(reply.message || '设置未保存', { id: 'settings-save', duration: 8000 });
		}
	};

	const openMagnetSite = async (): Promise<void> => {
		try {
			if (!(await magnets.openSite('heimacili'))) {
				throw new Error('UNAVAILABLE');
			}
		} catch {
			toast.error('黑马磁力未能打开，请稍后重试。');
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
				<TabsContent value="magnets">
					<section className="settings-section settings-preferences" aria-labelledby="magnet-source-heading">
						<div className="settings-section-heading">
							<h2 id="magnet-source-heading">搜索来源</h2>
							<p>按作品编号查询 Sukebei 或 JavTao，外部站点在浏览器中打开。</p>
						</div>
						<Card className="settings-card gap-0 py-0 ring-0">
							<SettingRow label="启用磁链搜索" description="仅在作品详情中查询和复制磁链。">
								<Switch
									aria-label="启用磁链搜索"
									checked={preferences.magnetSearch.enabled}
									onCheckedChange={(enabled) => {
										void save({ magnetSearch: { enabled } });
									}}
								/>
							</SettingRow>
							<SettingRow label="默认搜索来源" description="作品详情中仍可临时切换来源。">
								<OptionSelect
									aria-label="默认磁链来源"
									value={preferences.magnetSearch.source}
									disabled={!preferences.magnetSearch.enabled}
									options={magnetSourceSchema.options.map((value) => ({ value, label: MAGNET_SOURCES[value].name }))}
									onValueChange={(source) => {
										void save({ magnetSearch: { source } });
									}}
								/>
							</SettingRow>
							<SettingRow label={EXTERNAL_MAGNET_SITES.heimacili.name} description="heimacili.org · 在浏览器中自行搜索。">
								<Button
									variant="outline"
									size="sm"
									aria-label="打开黑马磁力"
									onClick={() => {
										void openMagnetSite();
									}}
								>
									<ExternalLink />
									打开网站
								</Button>
							</SettingRow>
						</Card>
					</section>
					<section className="settings-section settings-preferences" aria-labelledby="magnet-options-heading">
						<div className="settings-section-heading">
							<h2 id="magnet-options-heading">查询策略</h2>
						</div>
						<Card className="settings-card gap-0 py-0 ring-0">
							<SettingRow label="每次结果上限" description="按来源页面顺序取匹配结果。">
								<OptionSelect
									aria-label="磁链结果上限"
									value={preferences.magnetSearch.maxResults}
									disabled={!preferences.magnetSearch.enabled}
									onValueChange={(maxResults) => {
										void save({ magnetSearch: { maxResults } });
									}}
									options={[
										{ value: 5, label: '5 条' },
										{ value: 10, label: '10 条' },
										{ value: 20, label: '20 条' },
									]}
								/>
							</SettingRow>
							<SettingRow label="连接方式" description={preferences.magnetSearch.source === 'javtao' ? 'JavTao 使用浏览器指纹连接。' : undefined}>
								<OptionSelect
									aria-label="磁链连接方式"
									value={preferences.magnetSearch.source === 'javtao' ? 'fingerprint' : preferences.magnetSearch.transport}
									disabled={!preferences.magnetSearch.enabled || preferences.magnetSearch.source === 'javtao'}
									onValueChange={(transport) => {
										void save({ magnetSearch: { transport } });
									}}
									options={[
										{ value: 'httpx', label: '标准连接' },
										{ value: 'fingerprint', label: '浏览器指纹' },
									]}
								/>
							</SettingRow>
							<div className="settings-card-note">
								<Network size={14} />
								<p>代理沿用“网络与存储”中的设置。更改查询配置会停止正在进行的磁链查询。</p>
							</div>
						</Card>
					</section>
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
					<StorageSection />
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
							<h2 id="visual-demo-heading">示例数据</h2>
						</div>
						<Card className="settings-card gap-0 py-0 ring-0">
							<SettingRow label="示例资料预览" description="使用同一套界面浏览示例作品、演员与创作者，演示操作仅保留在本次会话。">
								<Button id="open-visual-demo" variant="outline" size="sm" onClick={onDemo}>
									<Monitor aria-hidden="true" />
									{demo ? '重置演示' : '打开演示'}
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

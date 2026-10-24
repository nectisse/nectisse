import { useState } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw, Settings2 } from 'lucide-react';
import type { FollowProvider, Subscription } from '@shared/subscriptions';
import { SOURCE_LABELS, isPerformerProvider } from '@shared/sources';
import { IdentityAvatar, TaskProgress } from '@/entities/subscription';
import { FeedImage } from '@/entities/update';
import { useDesktopActions, useSubscriptions } from '@/shared/desktop';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/shared/ui/dialog';
import { StatusBadge } from '@/shared/components/status-badge';
import { useSubscriptionControls } from '../model/use-subscription-controls';
import { CollectedEntries } from './CollectedEntries';
import { SubscriptionRow } from './SubscriptionRow';

export function PersonProfile({
	subscription: sub,
	onBack,
	onAdd,
	onSettings,
	onWork,
}: {
	subscription: Subscription;
	onBack: () => void;
	onAdd: (provider?: FollowProvider) => void;
	onSettings: () => void;
	onWork: (code: string) => void;
}): React.JSX.Element {
	const entries = useSubscriptions((state) => state.entries.filter((entry) => entry.subscriptionId === sub.id));
	const { imageUrl } = useDesktopActions();
	const { status, statusTone, canCheck, update, openSource } = useSubscriptionControls(sub);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const cover = entries.find((entry) => entry.imageAsset)?.imageAsset;
	const actor = isPerformerProvider(sub.provider);
	const providerName = SOURCE_LABELS[sub.provider];

	return (
		<div className="page creator-page real-creator-page person-profile" data-kind={actor ? 'actors' : 'creators'}>
			<div className="creator-profile-navigation">
				<Button variant="ghost" size="sm" onClick={onBack}>
					<ArrowLeft />
					返回关注列表
				</Button>
				<Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
					<Settings2 />
					关注设置
				</Button>
			</div>
			<div className="creator-banner real-creator-banner" aria-hidden="true">
				{cover && <FeedImage src={imageUrl('updates', cover.sha256)} alt="" />}
			</div>
			<header className="creator-identity">
				<div className="creator-profile-avatar">
					<IdentityAvatar identity={sub} />
				</div>
				<div className="creator-name">
					<h1 id="page-heading" tabIndex={-1}>
						{sub.name}
					</h1>
					<p>
						{sub.handle ? `@${sub.handle}` : sub.ref} / {providerName}
					</p>
				</div>
				<div className="creator-header-actions">
					<StatusBadge tone={statusTone}>{status}</StatusBadge>
					<Button
						variant="outline"
						size="sm"
						disabled={!canCheck}
						onClick={() => {
							void update({ action: 'check', id: sub.id });
						}}
					>
						<RefreshCw />
						检查更新
					</Button>
				</div>
			</header>
			{sub.bio && <p className="creator-bio">{sub.bio}</p>}
			<div className="creator-account-row">
				<Button variant="text" size="text" onClick={openSource}>
					{providerName} 原主页
					<ExternalLink />
				</Button>
				<span className="separator" aria-hidden="true">
					|
				</span>
				<span>
					{entries.length} {actor ? '件已收录作品' : '条动态'}
				</span>
				<span>{sub.unread} 条未读</span>
			</div>
			<TaskProgress />
			<div className="creator-content">
				<CollectedEntries key={sub.id} subscriptionId={sub.id} onWork={onWork} presentation={actor ? 'list' : 'cards'} title={actor ? '已收录作品' : '最新动态'} />
				<aside className="creator-aside" aria-label="人物资料">
					<section className="aside-block">
						<h2>{actor ? '演员资料' : '创作者资料'}</h2>
						<div className="aside-source">
							<span>{providerName}</span>
							<StatusBadge>{sub.recordType}</StatusBadge>
						</div>
						{sub.aliases.length > 0 && <p className="creator-profile-coverage">别名：{sub.aliases.join(' / ')}</p>}
						{sub.coverage && <p className="creator-profile-coverage">{sub.coverage}</p>}
						{sub.lastError && (
							<p className="creator-profile-error" role="status">
								{sub.lastError}
							</p>
						)}
						<Button variant="ghost" size="sm" onClick={onSettings}>
							<Settings2 />
							来源与订阅设置
						</Button>
					</section>
				</aside>
			</div>
			<Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
				<DialogContent className="person-settings-dialog">
					<DialogTitle>关注设置</DialogTitle>
					<DialogDescription>管理 {sub.name} 的关注状态与检查频率。</DialogDescription>
					<SubscriptionRow subscription={sub} />
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							setSettingsOpen(false);
							onAdd(sub.provider);
						}}
					>
						添加其他关注
					</Button>
					<DialogClose render={<Button size="sm" />}>完成</DialogClose>
				</DialogContent>
			</Dialog>
		</div>
	);
}

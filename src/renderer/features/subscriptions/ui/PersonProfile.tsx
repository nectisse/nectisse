import { useState } from 'react';
import { ArrowLeft, ExternalLink, Settings2 } from 'lucide-react';
import type { FollowProvider, Subscription } from '@shared/subscriptions';
import { SOURCE_LABELS, isPerformerProvider } from '@shared/sources';
import { IdentityAvatar, TaskProgress } from '@/entities/subscription';
import { useSubscriptions } from '@/shared/desktop';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/shared/ui/dialog';
import { StatusBadge } from '@/shared/components/status-badge';
import { useSubscriptionControls } from '../model/use-subscription-controls';
import { CollectedEntries } from './CollectedEntries';
import { SubscriptionRow } from './SubscriptionRow';
import { PeopleArtwork } from './PeopleArtwork';

export function PersonProfile({
	subscription: sub,
	onBack,
	onAdd,
	onWork,
}: {
	subscription: Subscription;
	onBack: () => void;
	onAdd: (provider?: FollowProvider) => void;
	onWork: (code: string) => void;
}): React.JSX.Element {
	const entries = useSubscriptions((state) => state.entries.filter((entry) => entry.subscriptionId === sub.id));
	const { status, statusTone, openSource } = useSubscriptionControls(sub);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const actor = isPerformerProvider(sub.provider);
	const providerName = SOURCE_LABELS[sub.provider];
	const unread = entries.filter((entry) => !entry.read).length;
	const aliases = sub.aliases.filter((alias) => alias !== sub.name);

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
			<header className="person-overview" aria-label={actor ? '演员资料' : '创作者资料'}>
				<div className="person-cover">
					<PeopleArtwork scope={actor ? 'actors' : 'creators'} />
				</div>
				<div className="creator-profile-avatar">
					<IdentityAvatar identity={sub} />
				</div>
				<div className="creator-name">
					<h1 id="page-heading" tabIndex={-1}>
						{sub.name}
					</h1>
					<div className="person-account">
						<span>{providerName}</span>
						{sub.handle && <span>@{sub.handle}</span>}
						<Button variant="text" size="text" aria-label={`${providerName} 原主页`} onClick={openSource}>
							原主页
							<ExternalLink />
						</Button>
						{status !== '已关注' && <StatusBadge tone={statusTone}>{status}</StatusBadge>}
					</div>
					{sub.bio && <p className="creator-bio">{sub.bio}</p>}
					{aliases.length > 0 && <p className="person-aliases">别名：{aliases.join(' / ')}</p>}
					{sub.coverage && <p className="creator-profile-coverage">{sub.coverage}</p>}
				</div>
				<dl className="person-stats">
					<div>
						<dt>{actor ? '已收录作品' : '动态'}</dt>
						<dd>{entries.length}</dd>
					</div>
					<div data-unread={unread > 0}>
						<dt>未读</dt>
						<dd>{unread}</dd>
					</div>
				</dl>
			</header>
			{sub.lastError && (
				<p className="creator-profile-error" role="status">
					{sub.lastError}
				</p>
			)}
			<TaskProgress />
			<div className="creator-content">
				<CollectedEntries subscription={sub} onWork={onWork} presentation={actor ? 'list' : 'cards'} title={actor ? '最近新作' : '最新动态'} />
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

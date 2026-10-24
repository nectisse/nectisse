import { ArrowLeft, ExternalLink } from 'lucide-react';
import type { Subscription } from '@shared/subscriptions';
import { SOURCE_LABELS, isPerformerProvider } from '@shared/sources';
import { IdentityAvatar, TaskProgress } from '@/entities/subscription';
import { Button } from '@/shared/ui/button';
import { StatusBadge } from '@/shared/components/status-badge';
import { useSubscriptionControls } from '../model/use-subscription-controls';
import { CollectedEntries } from './CollectedEntries';
import { AvatarActions } from './AvatarActions';
import { PeopleArtwork } from './PeopleArtwork';

export function PersonProfile({ subscription: sub, onBack, onWork }: { subscription: Subscription; onBack: () => void; onWork: (code: string) => void }): React.JSX.Element {
	const { status, statusTone, openSource } = useSubscriptionControls(sub);
	const actor = isPerformerProvider(sub.provider);
	const providerName = SOURCE_LABELS[sub.provider];
	const unread = sub.unread;
	const aliases = sub.aliases.filter((alias) => alias !== sub.name);

	return (
		<div className="page creator-page real-creator-page person-profile" data-kind={actor ? 'actors' : 'creators'}>
			<div className="creator-profile-navigation">
				<Button variant="ghost" size="sm" onClick={onBack}>
					<ArrowLeft />
					返回关注列表
				</Button>
				<AvatarActions subscription={sub} />
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
						<dd>{sub.collected ?? 0}</dd>
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
		</div>
	);
}

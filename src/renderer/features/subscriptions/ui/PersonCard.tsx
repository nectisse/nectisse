import type { FeedEntry, Subscription } from '@shared/subscriptions';
import { SOURCE_LABELS } from '@shared/sources';
import { useDesktopActions } from '@/shared/desktop';
import { Button } from '@/shared/ui/button';
import { feedDate } from '@/shared/lib/format-date';
import { FeedImage } from '@/entities/update';

export function PersonCard({ subscription: sub, latest, onOpen }: { subscription: Subscription; latest?: FeedEntry; onOpen: () => void }): React.JSX.Element {
	const { imageUrl } = useDesktopActions();
	return (
		<Button variant="media" size="media" className="person-card" onClick={onOpen} aria-label={`查看${sub.name}的主页`}>
			<span className="person-card-portrait">
				{sub.avatarAsset ? (
					<FeedImage src={imageUrl('avatars', sub.avatarAsset.sha256)} alt={`${sub.name}的来源头像`} />
				) : (
					<span className="person-card-initial">{Array.from(sub.name)[0] ?? '?'}</span>
				)}
				{sub.unread > 0 && <span className="person-card-unread">{sub.unread} 条未读</span>}
			</span>
			<span className="person-card-copy">
				<strong className="person-card-name" title={sub.name}>
					{sub.name}
				</strong>
				<span className="person-card-source">
					{SOURCE_LABELS[sub.provider]}
					{sub.handle ? ` · @${sub.handle}` : ''}
				</span>
				<span className="person-card-latest" title={latest?.title}>
					{latest ? `${feedDate(latest.publishedAt)} · ${latest.title}` : '等待新的内容'}
				</span>
			</span>
		</Button>
	);
}

import { personAvatar, type Subscription } from '@shared/subscriptions';
import { useDesktopActions } from '@/shared/desktop';
import { Button } from '@/shared/ui/button';
import { FeedImage } from '@/entities/update';

export function PersonCard({ subscription: sub, onOpen }: { subscription: Subscription; onOpen: () => void }): React.JSX.Element {
	const { imageUrl } = useDesktopActions();
	const avatar = personAvatar(sub);
	return (
		<Button variant="media" size="media" className="person-card" onClick={onOpen} aria-label={`查看${sub.name}的主页`}>
			<span className="person-card-portrait">
				{avatar ? (
					<FeedImage src={imageUrl('avatars', avatar.sha256)} alt={`${sub.name}的头像`} />
				) : (
					<span className="person-card-initial">{Array.from(sub.name)[0] ?? '?'}</span>
				)}
				{sub.unread > 0 && <span className="person-card-unread">{sub.unread} 条未读</span>}
			</span>
			<span className="person-card-copy">
				<strong className="person-card-name" title={sub.name}>
					{sub.name}
				</strong>
				{sub.handle && (
					<span className="person-card-account" title={`@${sub.handle}`}>
						@{sub.handle}
					</span>
				)}
			</span>
		</Button>
	);
}

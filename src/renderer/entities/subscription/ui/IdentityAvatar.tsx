import { Avatar, AvatarImage, AvatarFallback } from '@/shared/ui/avatar';
import { personAvatar, type FollowCandidate, type Subscription } from '@shared/subscriptions';
import { useDesktopActions } from '@/shared/desktop';

export function IdentityAvatar({
	identity,
	small = false,
}: {
	identity: Pick<FollowCandidate, 'name' | 'avatarAsset'> & Pick<Partial<Subscription>, 'manualAvatarAsset'>;
	small?: boolean;
}): React.JSX.Element {
	const { imageUrl } = useDesktopActions();
	const avatar = personAvatar(identity);
	return (
		<Avatar className={`identity-avatar${small ? ' small' : ''}`}>
			{avatar && <AvatarImage src={imageUrl('avatars', avatar.sha256)} alt={`${identity.name}的头像`} />}
			<AvatarFallback>{Array.from(identity.name)[0] || '?'}</AvatarFallback>
		</Avatar>
	);
}

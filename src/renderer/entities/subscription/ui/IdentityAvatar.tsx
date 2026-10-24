import { Avatar, AvatarImage, AvatarFallback } from '@/shared/ui/avatar';
import type { FollowCandidate } from '@shared/subscriptions';
import { useDesktopActions } from '@/shared/desktop';

export function IdentityAvatar({ identity, small = false }: { identity: Pick<FollowCandidate, 'name' | 'avatarAsset'>; small?: boolean }): React.JSX.Element {
	const { imageUrl } = useDesktopActions();
	return (
		<Avatar className={`identity-avatar${small ? ' small' : ''}`}>
			{identity.avatarAsset && <AvatarImage src={imageUrl('avatars', identity.avatarAsset.sha256)} alt={`${identity.name}的来源头像`} />}
			<AvatarFallback>{Array.from(identity.name)[0] || '?'}</AvatarFallback>
		</Avatar>
	);
}

import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import type { FollowCandidate } from '../../../shared/subscriptions';

export function IdentityAvatar({ identity, small = false }: { identity: Pick<FollowCandidate, 'name' | 'avatarAsset'>; small?: boolean }): React.JSX.Element {
	return (
		<Avatar className={`identity-avatar${small ? ' small' : ''}`}>
			{identity.avatarAsset && <AvatarImage src={`nectisse-cover://avatars/${identity.avatarAsset.sha256}`} alt={`${identity.name}的来源头像`} />}
			<AvatarFallback>{Array.from(identity.name)[0] || '?'}</AvatarFallback>
		</Avatar>
	);
}

import { useEffect, useState } from 'react';
import { Image } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import type { CoverCandidate } from '@shared/metadata';
import { useDesktopActions } from '@/shared/desktop';

export function CoverImage({
	cover,
	className,
	scope = 'image',
	variant = 'thumbnail',
}: {
	cover?: CoverCandidate;
	className?: string;
	scope?: 'image' | 'library';
	variant?: 'thumbnail' | 'original';
}): React.JSX.Element {
	const { imageUrl } = useDesktopActions();
	const [broken, setBroken] = useState(false);

	useEffect(() => setBroken(false), [cover?.id, cover?.asset?.sha256, variant]);

	return (
		<div className={cn('live-cover', className)}>
			{cover?.asset && !broken ? (
				<img src={imageUrl(scope, cover.id, variant)} alt="来源作品封面" loading="lazy" decoding="async" onError={() => setBroken(true)} />
			) : (
				<div className="live-cover-placeholder">
					<Image strokeWidth={1.2} />
					<span>{broken ? '封面暂时无法取得' : cover?.error || (scope === 'library' ? '此收藏尚未保存封面' : '来源未提供封面')}</span>
				</div>
			)}
		</div>
	);
}

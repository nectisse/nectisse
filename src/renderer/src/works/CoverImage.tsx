import { useEffect, useState } from 'react';
import { Image } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CoverCandidate } from '@shared/metadata';

export function CoverImage({ cover, className, scope = 'image' }: { cover?: CoverCandidate; className?: string; scope?: 'image' | 'library' }): React.JSX.Element {
	const [broken, setBroken] = useState(false);

	useEffect(() => setBroken(false), [cover?.asset?.sha256]);

	return (
		<div className={cn('live-cover', className)}>
			{cover?.asset && !broken ? (
				<img src={`nectisse-cover://${scope}/${cover.asset.sha256}`} alt="来源作品封面" loading="lazy" decoding="async" onError={() => setBroken(true)} />
			) : (
				<div className="live-cover-placeholder">
					<Image strokeWidth={1.2} />
					<span>{cover?.error || (broken ? '本地封面不可用，可重新查询' : scope === 'library' ? '此收藏尚未保存封面' : '封面尚未取得')}</span>
				</div>
			)}
		</div>
	);
}

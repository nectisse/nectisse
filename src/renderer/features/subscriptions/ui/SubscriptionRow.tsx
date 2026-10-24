import type { Subscription } from '@shared/subscriptions';
import { SOURCE_LABELS } from '@shared/sources';
import { IdentityAvatar } from '@/entities/subscription';
import { feedDate, formatTimestamp as date } from '@/shared/lib/format-date';
import { ExternalLink, Pause, Play, RefreshCw } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { StatusBadge } from '@/shared/components/status-badge';
import { useSubscriptionControls } from '../model/use-subscription-controls';
import { SubscriptionFrequency } from './SubscriptionFrequency';

export function SubscriptionRow({ subscription: sub, onOpen }: { subscription: Subscription; onOpen?: (id: string) => void }): React.JSX.Element {
	const { status, statusTone, nextCheck, canCheck, update, openSource } = useSubscriptionControls(sub);
	return (
		<article className="subscription-card">
			<div className="subscription-overview">
				<div className="subscription-card-head">
					<IdentityAvatar identity={sub} />
					<div className="subscription-identity">
						<div className="subscription-name-line">
							{onOpen ? (
								<Button variant="text" size="text" className="subscription-name" title={sub.name} onClick={() => onOpen(sub.id)}>
									{sub.name}
								</Button>
							) : (
								<h3 className="subscription-name" title={sub.name}>
									{sub.name}
								</h3>
							)}
							<StatusBadge tone={statusTone}>{status}</StatusBadge>
						</div>
						<p className="subscription-origin">
							{SOURCE_LABELS[sub.provider]} · {sub.recordType} · <span title={sub.ref}>{sub.handle ? `@${sub.handle}` : sub.ref}</span>
						</p>
						<p className="subscription-coverage" title={sub.coverage}>
							{sub.coverage}
						</p>
					</div>
				</div>
				<dl className="subscription-metrics">
					<div>
						<dt>上次检查</dt>
						<dd title={date(sub.lastCheckedAt)}>{sub.lastCheckedAt ? feedDate(sub.lastCheckedAt) : '尚未检查'}</dd>
					</div>
					<div>
						<dt>下次检查</dt>
						<dd title={sub.nextCheckAt ? date(sub.nextCheckAt) : undefined}>{nextCheck}</dd>
					</div>
					<div>
						<dt>未读</dt>
						<dd className="subscription-unread">
							{sub.unread}
							<span> 条</span>
						</dd>
					</div>
				</dl>
			</div>
			{sub.bio && (
				<p className="subscription-bio" title={sub.bio}>
					{sub.bio}
				</p>
			)}
			{sub.lastError && (
				<p className="subscription-error" role="status">
					{sub.lastError}
				</p>
			)}
			<div className="subscription-actions">
				<Button
					size="sm"
					variant="outline"
					disabled={!canCheck}
					onClick={() => {
						void update({ action: 'check', id: sub.id });
					}}
				>
					<RefreshCw />
					检查更新
				</Button>
				{sub.following ? (
					<>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								void update({ action: 'update', id: sub.id, enabled: !sub.enabled || sub.autoPaused });
							}}
						>
							{sub.enabled && !sub.autoPaused ? <Pause /> : <Play />}
							{sub.enabled && !sub.autoPaused ? '暂停' : '恢复'}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								void update({ action: 'update', id: sub.id, following: false });
							}}
						>
							取消关注
						</Button>
					</>
				) : (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							void update({ action: 'update', id: sub.id, following: true });
						}}
					>
						重新关注
					</Button>
				)}
				<Button variant="ghost" size="sm" onClick={openSource}>
					原主页
					<ExternalLink />
				</Button>
				<div className="subscription-frequency">
					<span>检查频率</span>
					<SubscriptionFrequency
						subscription={sub}
						onChange={(intervalMinutes) => {
							void update({ action: 'update', id: sub.id, intervalMinutes });
						}}
					/>
				</div>
			</div>
		</article>
	);
}

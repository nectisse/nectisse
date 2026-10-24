import { isPerformerProvider } from '@shared/sources';
import type { Subscription } from '@shared/subscriptions';
import { OptionSelect } from '@/shared/ui/select';

export function SubscriptionFrequency({ subscription: sub, onChange }: { subscription: Subscription; onChange: (minutes: number | null) => void }): React.JSX.Element {
	return (
		<OptionSelect
			aria-label={`${sub.name} 检查频率`}
			value={sub.intervalMinutes ?? ''}
			onValueChange={(value) => onChange(value === '' ? null : Number(value))}
			options={[
				{ value: '', label: '使用默认频率' },
				...(isPerformerProvider(sub.provider) ? [360, 720, 1440, 10080] : [30, 60, 180, 360, 1440]).map((value) => ({
					value,
					label: `每 ${value >= 1440 ? `${value / 1440} 天` : value >= 60 ? `${value / 60} 小时` : `${value} 分钟`}`,
				})),
			]}
		/>
	);
}

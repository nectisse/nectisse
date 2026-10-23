/** Fixed diagnostic codes only: never propagate persisted values or credentials. */
export const SUBSCRIPTION_READ = {
	unavailable: 'SUBSCRIPTIONS_UNAVAILABLE',
	storage: 'SUBSCRIPTIONS_STORAGE_READ',
	invalid: 'SUBSCRIPTIONS_INVALID_DATA',
	timeout: 'SUBSCRIPTIONS_READ_TIMEOUT',
} as const;
export type SubscriptionReadCode = (typeof SUBSCRIPTION_READ)[keyof typeof SUBSCRIPTION_READ];

export function subscriptionReadCode(error: unknown): SubscriptionReadCode {
	const message = error instanceof Error ? error.message : '';
	return Object.values(SUBSCRIPTION_READ).find((code) => message.includes(code)) ?? SUBSCRIPTION_READ.unavailable;
}

export function subscriptionReadMessage(error: unknown): string {
	const code = subscriptionReadCode(error);
	return code === SUBSCRIPTION_READ.storage
		? '暂时无法读取本地设置与订阅。请检查应用数据目录的权限与可用空间，然后重试。'
		: code === SUBSCRIPTION_READ.invalid
			? '本地设置或订阅记录的格式与当前版本不兼容。原有数据已保留，请使用最新版本后重试。'
			: code === SUBSCRIPTION_READ.timeout
				? '读取设置与订阅超时。请稍后重试，原有数据已保留。'
				: '设置与订阅服务暂时未能响应。请重新读取，原有数据已保留。';
}

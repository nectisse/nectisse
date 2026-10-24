import type { Preferences } from '@shared/preferences';
import type { AllSource } from '@shared/sources';

/** 查询、头像和封面沿用同一传输设置；逐来源配置优先于旧版专用设置。 */
export function sourceTransport(source: AllSource, preferences?: Preferences): 'httpx' | 'fingerprint' | 'browser' {
	const configured = preferences?.sourceTransports[source];
	if (configured) {
		return configured;
	}
	if (source === 'fanbox') {
		return preferences?.fanboxTransport ?? 'httpx';
	}
	if (source === 'javdb') {
		return preferences?.javdbTransport ?? 'httpx';
	}
	if (source === 'fc2ppvdb') {
		return 'browser';
	}
	return ['dmm', 'r18dev', 'fc2'].includes(source) ? 'httpx' : 'fingerprint';
}

/** 解析失败不触发站点冷却；限流使用来源给出的等待时间，最长一天。 */
export function sourceCooldownSeconds(reason: string, retryAfter = 0): number {
	if (reason === 'rate_limited') {
		return Math.min(86400, Math.max(60, retryAfter));
	}
	if (['challenge', 'access_denied', 'auth_required', 'region_restricted'].includes(reason)) {
		return 300;
	}
	if (['network', 'timeout', 'server_error'].includes(reason)) {
		return 30;
	}
	return 0;
}

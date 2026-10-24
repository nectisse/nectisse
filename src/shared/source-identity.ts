import { SOURCE_BY_ID, type AllSource, type FollowProvider, type LegacyMetadataSource } from '@shared/sources';

const legacyPageDomains = { fc2club: ['fc2club.top'], kmib: ['k-mib.com'] };

/** 按用途使用登记的域名清单，查询与收藏共享同一套来源外链校验。 */
export function allowedSourceUrl(source: AllSource | LegacyMetadataSource, value: string, kind: 'page' | 'image' = 'page'): string | undefined {
	try {
		const url = new URL(value);
		const spec = SOURCE_BY_ID[source as AllSource];
		// 旧收藏仍可打开原文，已移除来源不再获取远程图片。
		const domains = spec ? (kind === 'image' ? spec.images : spec.domains) : kind === 'page' ? legacyPageDomains[source as LegacyMetadataSource] : [];
		if (url.protocol !== 'https:' || url.username || url.password || url.port) {
			return;
		}
		return domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : undefined;
	} catch {
		return;
	}
}

export function canonicalFollow(provider: FollowProvider, ref: string): string {
	const invalid = (): never => {
		throw new Error('来源原生身份不正确');
	};

	if (provider === 'fanbox') {
		return /^[a-z0-9_-]{1,64}$/.test(ref) && !['www', 'api'].includes(ref) ? `https://${ref}.fanbox.cc/` : invalid();
	}
	if (provider === 'javdb') {
		return /^[A-Za-z0-9]{1,16}$/.test(ref) ? `https://javdb.com/actors/${ref}` : invalid();
	}
	if (['kemono', 'pawchive', 'coomer'].includes(provider)) {
		const match = /^([a-z0-9_-]{1,32})\/([A-Za-z0-9_.-]{1,64})$/.exec(ref);
		return match && !['.', '..'].includes(match[2]!) ? `${SOURCE_BY_ID[provider].root}${match[1]}/user/${match[2]}` : invalid();
	}
	if (provider === 'patreon') {
		if (/^user\/\d+$/.test(ref)) {
			return `https://www.patreon.com/user?u=${ref.slice(5)}`;
		}
		return /^[A-Za-z0-9_-]{1,80}$/.test(ref) && !['posts', 'join', 'login', 'signup', 'home', 'explore'].includes(ref.toLowerCase())
			? `https://www.patreon.com/cw/${ref}`
			: invalid();
	}
	return invalid();
}

export function validFollowEntry(provider: FollowProvider, ref: string, entry: { url: string; externalId: string }): boolean {
	try {
		const url = new URL(entry.url);
		if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
			return false;
		}
		if (provider === 'fanbox') {
			return url.hostname === `${ref}.fanbox.cc` && url.pathname === `/posts/${entry.externalId}` && /^\d+$/.test(entry.externalId);
		}
		if (provider === 'javdb') {
			return url.hostname === 'javdb.com' && url.pathname === entry.externalId && /^\/v\/[A-Za-z0-9]+$/.test(entry.externalId);
		}
		if (['kemono', 'pawchive', 'coomer'].includes(provider)) {
			return /^[A-Za-z0-9_.-]{1,64}$/.test(entry.externalId) && entry.url === `${canonicalFollow(provider, ref)}/post/${entry.externalId}`;
		}
		if (!/^\d+$/.test(entry.externalId)) {
			return false;
		}
		if (provider === 'patreon') {
			return ['www.patreon.com', 'patreon.com'].includes(url.hostname) && new RegExp(`^/posts/(?:[A-Za-z0-9_-]+-)?${entry.externalId}/?$`).test(url.pathname);
		}
		return false;
	} catch {
		return false;
	}
}

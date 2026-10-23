import { SOURCE_BY_ID, type AllSource, type FollowProvider } from './sources';

/** 按用途使用登记的域名清单，查询与收藏共享同一套来源外链校验。 */
export function allowedSourceUrl(source: AllSource, value: string, kind: 'page' | 'image' = 'page'): string | undefined {
	try {
		const url = new URL(value);
		const domains = kind === 'image' ? SOURCE_BY_ID[source].images : SOURCE_BY_ID[source].domains;
		if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
		return domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : undefined;
	} catch {
		return;
	}
}

export function canonicalFollow(provider: FollowProvider, ref: string): string {
	const invalid = (): never => {
		throw new Error('来源原生身份不正确');
	};
	if (provider === 'fanbox') return /^[a-z0-9_-]{1,64}$/.test(ref) && !['www', 'api'].includes(ref) ? `https://${ref}.fanbox.cc/` : invalid();
	if (provider === 'javdb') return /^[A-Za-z0-9]{1,16}$/.test(ref) ? `https://javdb.com/actors/${ref}` : invalid();
	if (['kemono', 'pawchive', 'coomer'].includes(provider)) {
		const match = /^([a-z0-9_-]{1,32})\/([A-Za-z0-9_.-]{1,64})$/.exec(ref);
		return match && !['.', '..'].includes(match[2]!) ? `${SOURCE_BY_ID[provider].root}${match[1]}/user/${match[2]}` : invalid();
	}
	if (provider === 'rule34video') return /^[a-z0-9][a-z0-9_-]{0,80}$/.test(ref) ? `https://rule34video.com/models/${ref}/` : invalid();
	if (provider === 'patreon') {
		if (/^user\/\d+$/.test(ref)) return `https://www.patreon.com/user?u=${ref.slice(5)}`;
		return /^[A-Za-z0-9_-]{1,80}$/.test(ref) && !['posts', 'join', 'login', 'signup', 'home', 'explore'].includes(ref.toLowerCase())
			? `https://www.patreon.com/cw/${ref}`
			: invalid();
	}
	return /^subscribestar\.(adult|com)\/[A-Za-z0-9_-]{1,80}$/.test(ref) && !['posts', 'search', 'login', 'signup'].includes(ref.split('/')[1]!.toLowerCase())
		? `https://${ref}`
		: invalid();
}

export function validFollowEntry(provider: FollowProvider, ref: string, entry: { url: string; externalId: string }): boolean {
	try {
		const url = new URL(entry.url);
		if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return false;
		if (provider === 'fanbox') return url.hostname === `${ref}.fanbox.cc` && url.pathname === `/posts/${entry.externalId}` && /^\d+$/.test(entry.externalId);
		if (provider === 'javdb') return url.hostname === 'javdb.com' && url.pathname === entry.externalId && /^\/v\/[A-Za-z0-9]+$/.test(entry.externalId);
		if (['kemono', 'pawchive', 'coomer'].includes(provider))
			return /^[A-Za-z0-9_.-]{1,64}$/.test(entry.externalId) && entry.url === `${canonicalFollow(provider, ref)}/post/${entry.externalId}`;
		if (!/^\d+$/.test(entry.externalId)) return false;
		if (provider === 'patreon')
			return ['www.patreon.com', 'patreon.com'].includes(url.hostname) && new RegExp(`^/posts/(?:[A-Za-z0-9_-]+-)?${entry.externalId}/?$`).test(url.pathname);
		if (provider === 'subscribestar') return url.hostname === ref.split('/')[0] && url.pathname === `/posts/${entry.externalId}`;
		return url.hostname === 'rule34video.com' && new RegExp(`^/video/${entry.externalId}/[A-Za-z0-9_-]*/?$`).test(url.pathname);
	} catch {
		return false;
	}
}

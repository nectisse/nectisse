import { SOURCE_BY_ID, type AllSource } from './sources';
import type { CoverCandidate } from './metadata';

export const COVER_SOURCE_IDS = [
	'dmm',
	'mgstage',
	'prestige',
	'faleno',
	'dahlia',
	'1pondo',
	'fc2',
	'duga',
	'kmib',
	'javbus',
	'avbase',
	'fc2cmadb',
	'fc2ppvdb',
	'javten',
	'javarchive',
	'avsox',
	'fc2club',
	'freejavbt',
	'airav',
] as const;
export type CoverSource = (typeof COVER_SOURCE_IDS)[number];
export const DEFAULT_COVER_PRIORITY: CoverSource[] = ['dmm'];

export function coverSource(cover: Pick<CoverCandidate, 'source' | 'url'>): AllSource {
	let host: string;
	try {
		host = new URL(cover.url).hostname.toLowerCase();
	} catch {
		return cover.source;
	}
	for (const id of COVER_SOURCE_IDS) {
		if (SOURCE_BY_ID[id].domains.some((domain) => host === domain || host.endsWith(`.${domain}`)) || (id === 'mgstage' && (host === 'mgs.jp' || host.endsWith('.mgs.jp'))))
			return id;
	}
	return cover.source;
}

export function coverRank(cover: Pick<CoverCandidate, 'source' | 'url'>, priority: readonly CoverSource[]): number {
	const index = priority.indexOf(coverSource(cover) as CoverSource);
	return index < 0 ? priority.length : index;
}

export function preferredCover(covers: readonly CoverCandidate[], priority: readonly CoverSource[] = DEFAULT_COVER_PRIORITY): CoverCandidate | undefined {
	return covers.reduce<CoverCandidate | undefined>((best, cover) => {
		if (!best) return cover;
		if (!!cover.asset !== !!best.asset) return cover.asset ? cover : best;
		const rank = coverRank(cover, priority),
			previous = coverRank(best, priority);
		if (rank !== previous) return rank < previous ? cover : best;
		return (cover.asset?.width ?? 0) * (cover.asset?.height ?? 0) > (best.asset?.width ?? 0) * (best.asset?.height ?? 0) ? cover : best;
	}, undefined);
}

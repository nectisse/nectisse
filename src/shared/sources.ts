import catalog from '../../python/src/nectisse_worker/source_catalog.json';

export type AllSource = keyof typeof catalog;
export const METADATA_IDS = [
	'dmm',
	'r18dev',
	'1pondo',
	'fc2',
	'fc2cmadb',
	'fc2ppvdb',
	'javten',
	'javarchive',
	'avbase',
	'javbus',
	'javdb',
	'sougouwiki',
	'av_neme',
	'av_name',
	'kmib',
	'makers',
	'prestige',
	'faleno',
	'dahlia',
	'mgstage',
	'avsox',
	'fc2club',
	'freejavbt',
	'airav',
] as const;
export const FOLLOW_IDS = ['fanbox', 'javdb', 'patreon', 'subscribestar', 'kemono', 'pawchive', 'coomer', 'rule34video'] as const;
export type SourceId = (typeof METADATA_IDS)[number];
export const DEFAULT_QUERY_SOURCES: SourceId[] = ['dmm', 'r18dev', 'fc2'];
export type FollowProvider = (typeof FOLLOW_IDS)[number];
export const ALL_IDS = Object.keys(catalog) as [AllSource, ...AllSource[]];
export interface SourceSpec {
	id: AllSource;
	name: string;
	group: string;
	engine: string;
	metadata: boolean;
	follow: boolean;
	families: string[];
	root: string;
	domains: string[];
	images: string[];
	note: string;
	capabilities: string;
	credential: boolean;
	available: boolean;
}

export const SOURCES: SourceSpec[] = ALL_IDS.map((id) => ({
	id,
	...catalog[id],
	capabilities: catalog[id].note,
	credential: catalog[id].credential === 'cookie',
	available: catalog[id].metadata || catalog[id].follow,
}));

export const SOURCE_BY_ID = Object.fromEntries(SOURCES.map((source) => [source.id, source])) as Record<AllSource, (typeof SOURCES)[number]>;
export const SOURCE_LABELS = Object.fromEntries(SOURCES.map((source) => [source.id, source.name])) as Record<AllSource, string>;
export const DEFAULT_METADATA_ORDER: SourceId[] = [
	'dmm',
	'r18dev',
	'makers',
	'prestige',
	'faleno',
	'dahlia',
	'mgstage',
	'1pondo',
	'fc2',
	'fc2cmadb',
	'fc2ppvdb',
	'javten',
	'avbase',
	'javdb',
	'javarchive',
	'avsox',
	'fc2club',
	'freejavbt',
	'airav',
	'sougouwiki',
	'av_neme',
	'av_name',
	'kmib',
	'javbus',
];
export const DEFAULT_ENABLED: AllSource[] = ['dmm', 'r18dev', 'fc2', 'fanbox', 'javdb'];

export const isFollowProvider = (value: string): value is FollowProvider => (FOLLOW_IDS as readonly string[]).includes(value);

export const isMetadataSource = (value: string): value is SourceId => (METADATA_IDS as readonly string[]).includes(value);

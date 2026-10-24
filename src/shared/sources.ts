import catalog from '../../python/src/nectisse_worker/source_catalog.json';

export type AllSource = keyof typeof catalog;
export const METADATA_IDS = [
	'dmm',
	'r18dev',
	'1pondo',
	'fc2',
	'fc2ppvdb',
	'javten',
	'javarchive',
	'avbase',
	'javbus',
	'javdb',
	'javtao',
	'sougouwiki',
	'av_neme',
	'av_name',
	'makers',
	'prestige',
	'faleno',
	'dahlia',
	'mgstage',
	'avsox',
	'freejavbt',
	'airav',
] as const;
export const FOLLOW_IDS = ['fanbox', 'javdb', 'javtao', 'x', 'patreon', 'kemono', 'pawchive', 'coomer'] as const;
export const PERFORMER_PROVIDERS = ['javdb', 'javtao'] as const;
export const RETIRED_SOURCE_IDS = ['rule34video', 'subscribestar', 'rule34xxx', 'rule34paheal', 'fc2club', 'kmib', 'fc2cmadb'] as const;
// 仅用于读取既有资料与收藏，不参与新查询。
export const LEGACY_METADATA_IDS = ['fc2club', 'kmib', 'fc2cmadb'] as const;
export type LegacyMetadataSource = (typeof LEGACY_METADATA_IDS)[number];
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
	apiRoot?: string;
	requestDomains?: string[];
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
export const SOURCE_LABELS = {
	...(Object.fromEntries(SOURCES.map((source) => [source.id, source.name])) as Record<AllSource, string>),
	fc2club: 'FC2Club（已移除）',
	kmib: 'K-MIB（已移除）',
	fc2cmadb: 'FC2CMADB（已移除）',
};
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
	'fc2ppvdb',
	'javten',
	'avbase',
	'javdb',
	'javtao',
	'javarchive',
	'avsox',
	'freejavbt',
	'airav',
	'sougouwiki',
	'av_neme',
	'av_name',
	'javbus',
];
export const DEFAULT_ENABLED: AllSource[] = ['dmm', 'r18dev', 'fc2', 'fanbox', 'javdb'];

export const isFollowProvider = (value: string): value is FollowProvider => (FOLLOW_IDS as readonly string[]).includes(value);

export const isPerformerProvider = (value: string | undefined): boolean => value !== undefined && (PERFORMER_PROVIDERS as readonly string[]).includes(value);

export const isMetadataSource = (value: string): value is SourceId => (METADATA_IDS as readonly string[]).includes(value);

export function withoutRetiredSources(value: unknown): unknown {
	return Array.isArray(value) ? value.filter((id) => !(RETIRED_SOURCE_IDS as readonly unknown[]).includes(id)) : value;
}

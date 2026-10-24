export const COVER_SOURCE_IDS = [
	'dmm',
	'mgstage',
	'prestige',
	'faleno',
	'dahlia',
	'1pondo',
	'fc2',
	'duga',
	'javbus',
	'avbase',
	'javtao',
	'fc2ppvdb',
	'javten',
	'javarchive',
	'avsox',
	'freejavbt',
	'airav',
] as const;
export type CoverSource = (typeof COVER_SOURCE_IDS)[number];
export const DEFAULT_COVER_PRIORITY: CoverSource[] = ['dmm'];

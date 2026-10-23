// Visual review fixtures only. No identities, URLs, source results or dimensions
// here represent verified sites. All changes stay in React memory.
export type Site = 'DMM' | 'r18.dev' | 'JavDB' | 'FANBOX' | 'Patreon' | 'SubscribeStar';
export type Tile = 0 | 1 | 2 | 3 | 4 | 5;
export type Route = { page: 'query' | 'detail' | 'creator' | 'updates' };

export interface Creator {
	id: string;
	name: string;
	handle: string;
	tagline: string;
	bio: string;
	avatar: Tile | string;
	banner: Tile;
	sites: Site[];
}

export interface Cover {
	tile: Tile;
	title: string;
	source: string;
	dimensions: string;
	matched: boolean;
}

export interface Work {
	id: string;
	title: string;
	translation: string;
	english: string;
	creatorId: string;
	year: string;
	publisher: string;
	series: string;
	releaseDate: string;
	mirrorDate: string;
	tile: Tile;
	sources: Site[];
	summary: string;
	tags: string[];
	covers: Cover[];
}

export interface Post {
	id: string;
	creatorId: string;
	source: Site;
	time: string;
	publishedAt: string;
	title: string;
	body: string;
	tile?: Tile;
	type: string;
	initiallyRead?: boolean;
}

export const creators: readonly Creator[] = [
	{
		id: 'mio',
		name: '白石 澪',
		handle: 'mio atelier',
		tagline: '写真と、日々のこと。',
		bio: '用影像记录日常里，短暂而温柔的瞬间。',
		avatar: 0,
		banner: 3,
		sites: ['FANBOX', 'Patreon'],
	},
	{
		id: 'rin',
		name: '青木 凛',
		handle: 'rin photographs',
		tagline: '光と、静かな部屋。',
		bio: '从一个安静的房间开始，慢慢找到光的轮廓。',
		avatar: 1,
		banner: 1,
		sites: ['Patreon'],
	},
	{
		id: 'akari',
		name: '灯里工作室',
		handle: 'akari studio',
		tagline: '关于创作，也关于等待。',
		bio: '记录作品完成之前，那些细小而温柔的过程。',
		avatar: '灯',
		banner: 4,
		sites: ['SubscribeStar'],
	},
	{
		id: 'seaside',
		name: 'Seaside Notes',
		handle: '海岸影像日记',
		tagline: 'Between the sea and the last train.',
		bio: '沿着海岸线，收集缓慢的傍晚。',
		avatar: 'S',
		banner: 2,
		sites: ['FANBOX'],
	},
];

export const works: readonly Work[] = [
	{
		id: 'NECT-024',
		title: '午後、窓辺にて',
		translation: '午后，窗边',
		english: 'AFTERNOON, BY THE WINDOW',
		creatorId: 'mio',
		year: '2026',
		publisher: 'MIO ATELIER',
		series: '日々の記録',
		releaseDate: '2026-10-18',
		mirrorDate: '2026-10-15',
		tile: 0,
		sources: ['DMM', 'r18.dev'],
		summary: '窗帘透过的光，和慢下来的一整个下午。\n以安静的室内光线，记录那些不必被解释的日常瞬间。',
		tags: ['自然光', '室内摄影', '日常记录'],
		covers: [
			{ tile: 0, title: '官方商品图', source: 'DMM', dimensions: '2,184 × 3,276', matched: true },
			{ tile: 3, title: '取景备选', source: 'r18.dev', dimensions: '1,000 × 1,500', matched: false },
			{ tile: 4, title: '作品集备选', source: '单一来源', dimensions: '1,200 × 1,800', matched: false },
		],
	},
	{
		id: 'NECT-018',
		title: '午後の余白',
		translation: '午后的留白',
		english: 'THE SPACE BETWEEN HOURS',
		creatorId: 'rin',
		year: '2026',
		publisher: 'RIN PHOTOGRAPHS',
		series: '静かな部屋',
		releaseDate: '2026-09-28',
		mirrorDate: '2026-09-26',
		tile: 1,
		sources: ['DMM', 'JavDB'],
		summary: '在阴天的房间里，寻找属于自己的安静。\n一组关于留白、等待与光影的摄影记录。',
		tags: ['光影', '室内摄影', '静物'],
		covers: [
			{ tile: 1, title: '主要封面', source: 'DMM', dimensions: '1,600 × 2,400', matched: true },
			{ tile: 4, title: '取景备选', source: '单一来源', dimensions: '1,000 × 1,500', matched: false },
		],
	},
	{
		id: 'SEA-012',
		title: '海辺の午後',
		translation: '海边的午后',
		english: 'A QUIET AFTERNOON BY THE SEA',
		creatorId: 'seaside',
		year: '2025',
		publisher: 'SEASIDE NOTES',
		series: '海岸線の日記',
		releaseDate: '2025-11-06',
		mirrorDate: '2025-11-05',
		tile: 2,
		sources: ['r18.dev'],
		summary: '在最后一班列车经过之前，沿着海岸走了一段。\n把风、灯光与潮汐，留给那些缓慢的傍晚。',
		tags: ['海岸', '旅行记录', '傍晚'],
		covers: [
			{ tile: 2, title: '作品主视觉', source: 'r18.dev', dimensions: '1,600 × 2,400', matched: true },
			{ tile: 5, title: '夜间取景', source: '单一来源', dimensions: '1,000 × 1,500', matched: false },
		],
	},
];

export const posts: readonly Post[] = [
	{
		id: 'mio-october',
		creatorId: 'mio',
		source: 'FANBOX',
		time: '14:20',
		publishedAt: '2026.10.23 14:20',
		title: '十月的拍摄手记：让光再停留一会儿',
		body: '这次想记录的，是雨停之前的一小段时间。整理了几张拍摄中的照片，也写下一些关于光线和新作品的想法。',
		tile: 5,
		type: '拍摄手记',
	},
	{
		id: 'rin-room',
		creatorId: 'rin',
		source: 'Patreon',
		time: '11:45',
		publishedAt: '2026.10.23 11:45',
		title: '新系列《静かな部屋》· 第一组照片',
		body: '从一个安静的房间开始。关于新系列的色调、取景，以及接下来想继续尝试的方向。',
		tile: 1,
		type: '作品发布',
	},
	{
		id: 'mio-progress',
		creatorId: 'mio',
		source: 'FANBOX',
		time: '09:10',
		publishedAt: '2026.10.23 09:10',
		title: '关于下一组作品的进度，和一点小调整',
		body: '下周的拍摄会稍微晚一些，想留出更多时间准备场景。新的发布日期确认后会在这里告诉大家，谢谢你们一直耐心等待。',
		type: '进度更新',
	},
	{
		id: 'akari-schedule',
		creatorId: 'akari',
		source: 'SubscribeStar',
		time: '昨天',
		publishedAt: '2026.10.22 18:00',
		title: '十月末的更新安排',
		body: '这一周会陆续整理创作笔记与新系列的前期准备。完整安排将在后续的公告中更新，感谢每一位关注我们的朋友。',
		type: '公告',
	},
	{
		id: 'seaside-train',
		creatorId: 'seaside',
		source: 'FANBOX',
		time: '10 月 21 日',
		publishedAt: '2026.10.21 17:30',
		title: '海岸线旁，最后一班列车',
		body: '在天色完全暗下来之前，沿着站台走了一段路。这组记录留给那些缓慢的傍晚。',
		tile: 2,
		type: '创作笔记',
		initiallyRead: true,
	},
];

export const firstWork = works[0]!;
export const firstCreator = creators[0]!;
export const creatorFor = (id: string): Creator => creators.find((creator) => creator.id === id) ?? firstCreator;
export const initialReadIds = (): Set<string> => new Set(posts.filter((post) => post.initiallyRead).map((post) => post.id));
export const sourceUrl = (work: Work, source: Site): string => `https://demo.nectisse.invalid/${source.toLowerCase()}/works/${work.id}`;
export const dateLabel = (value: string): string => value.replaceAll('-', '.');

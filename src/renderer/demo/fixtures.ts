import { DEFAULT_PREFERENCES, type Preferences } from '@shared/preferences';
import { SOURCES } from '@shared/sources';
import type { FeedEntry, Subscription, SubscriptionsState } from '@shared/subscriptions';
import { metadataRecordSchema, type ImageAsset, type MetadataRecord, type MetadataState } from '@shared/metadata';
import { summarizeWork, type SavedWork } from '@shared/library';

export const demoHash = (index: number): string => index.toString(16).padStart(64, '0');

export const demoAsset = (index: number): ImageAsset => ({ sha256: demoHash(index), width: 418, height: 627, format: 'JPEG', bytes: 100000, quality: 'standard' });

export function createDemoFixtures(theme: Preferences['theme']) {
	const now = new Date().toISOString();
	const profiles = [
		{ provider: 'javdb', ref: 'DemoMio', name: '白石 澪', bio: '写真与日常。用影像记录安静的瞬间。', recordType: '演员', url: 'https://javdb.com/actors/DemoMio' },
		{ provider: 'javtao', ref: 'demo-rin', name: '青木 凛', bio: '从一个安静的房间开始，慢慢找到光的轮廓。', recordType: '演员', url: 'https://javtao.com/actress/demo-rin' },
		{
			provider: 'fanbox',
			ref: 'demo-atelier',
			name: '灯里工作室',
			bio: '记录作品完成之前，那些细小而温柔的过程。\n摄影、创作手记与每周的日常。',
			recordType: '创作者',
			url: 'https://demo-atelier.fanbox.cc/',
		},
		{
			provider: 'x',
			ref: '1900000000000000001',
			handle: 'seaside_demo',
			name: 'Seaside Notes',
			bio: '沿着海岸线，收集缓慢的傍晚。',
			recordType: '公开账号',
			url: 'https://x.com/seaside_demo',
		},
		{
			provider: 'patreon',
			ref: 'user/100001',
			name: 'Rin Photographs',
			bio: '光与安静的房间，正在进行中的创作。',
			recordType: '创作者',
			url: 'https://www.patreon.com/user?u=100001',
		},
	] as const;
	const subscriptions: Subscription[] = profiles.map((profile, index) => ({
		...profile,
		id: crypto.randomUUID(),
		aliases: [],
		evidence: '内置虚构示例，不代表真实人物或站点资料。',
		avatarAsset: demoAsset(index + 1),
		kind: index < 2 ? 'performer_releases' : 'creator_posts',
		following: true,
		enabled: true,
		autoPaused: false,
		intervalMinutes: null,
		createdAt: now,
		initialized: true,
		lastCheckedAt: now,
		nextCheckAt: '',
		lastError: '',
		coverage: '内置示例内容',
		failureCount: 0,
		unread: 2,
	}));
	const entries: FeedEntry[] = subscriptions.flatMap((sub, index) =>
		Array.from({ length: 3 }, (_, offset) => {
			const actor = sub.kind === 'performer_releases';
			const id = String(1900000000000000100n + BigInt(index * 3 + offset));
			return {
				id: demoHash(100 + index * 3 + offset),
				subscriptionId: sub.id,
				provider: sub.provider,
				externalId: sub.provider === 'javdb' ? `/v/Demo${offset + 1}` : sub.provider === 'javtao' ? `/demo-${offset + 1}` : id,
				name: sub.name,
				author: sub.name,
				...(sub.provider === 'x' ? { authorRef: sub.ref, authorHandle: sub.handle, postKind: 'original' as const } : {}),
				title: actor
					? ['午後、窓辺にて', '午後の余白', '海辺の午後'][offset]!
					: ['十月的拍摄手记：让光再停留一会儿', '关于下一次创作的一些想法', '沿着海岸，走到天黑'][offset]!,
				summary: actor ? '' : '日常里很小的片段，也值得慢慢记录。\n这是内置的虚构示例，你可以打开阅读、切换已读状态，体验与真实资料相同的页面。',
				publishedAt: new Date(Date.now() - (index * 3 + offset) * 3600000).toISOString(),
				publishedPrecision: actor ? ('date' as const) : ('exact' as const),
				url:
					sub.provider === 'javdb'
						? `https://javdb.com/v/Demo${offset + 1}`
						: sub.provider === 'javtao'
							? `https://javtao.com/demo-${offset + 1}`
							: sub.provider === 'x'
								? `${sub.url}/status/${id}`
								: sub.provider === 'patreon'
									? `https://www.patreon.com/posts/${id}`
									: `${sub.url}posts/${id}`,
				thumbnailUrl: offset === 1 ? '' : 'https://demo.nectisse.invalid/cover.jpg',
				...(sub.provider === 'x' && offset !== 1
					? { images: [0, 1, 2].map((picture) => ({ url: `https://demo.nectisse.invalid/photo-${picture}.jpg`, width: 418, height: 627 })) }
					: {}),
				...(offset === 1 ? {} : { imageAsset: demoAsset(((index + offset) % 6) + 1) }),
				code: actor ? ['NECT-024', 'NECT-018', 'SEA-012'][offset]! : '',
				restricted: false,
				partial: false,
				firstSeenAt: now,
				read: offset === 2,
				initial: false,
			};
		}),
	);
	const records: MetadataRecord[] = ['NECT-024', 'NECT-018', 'SEA-012'].flatMap((code, index) =>
		(['dmm', 'r18dev'] as const).map((source, sourceIndex) =>
			metadataRecordSchema.parse({
				id: demoHash(200 + index * 2 + sourceIndex),
				source,
				parser: 'demo',
				parserVersion: '1',
				code,
				contentId: code.toLowerCase(),
				sourceUrl: `https://demo.nectisse.invalid/${source}/${code}`,
				fetchedAt: now,
				title: ['午後、窓辺にて', '午後の余白', '海辺の午後'][index],
				titleLanguage: 'ja',
				people: [{ name: subscriptions[index % 2]!.name, role: 'performer', sourceIdentity: '' }],
				studio: 'Nectisse Atelier',
				label: '摄影与日常',
				series: '日々の記録',
				seller: '',
				sellerUrl: '',
				releaseDate: '2026-10-18',
				description: '窗帘透过的光，和慢下来的一整个下午。\n内置虚构资料，用于体验作品查询、收藏与来源比较。',
				tags: ['摄影', '日常', '光影'],
				covers: [
					{
						id: demoHash(300 + index * 2 + sourceIndex),
						url: `https://demo.nectisse.invalid/${code}.jpg`,
						source,
						identity: 'source-matched',
						asset: demoAsset(index + 1),
					},
				],
				warnings: [],
			}),
		),
	);
	const metadata: MetadataState = {
		revision: 1,
		tasks: [
			{
				id: crypto.randomUUID(),
				status: 'succeeded',
				phase: '示例资料已载入',
				plan: { kind: 'title', query: '示例作品', code: '', contentId: '', sources: ['dmm', 'r18dev'] },
				startedAt: now,
				finishedAt: now,
				records,
				outcomes: [],
				requests: 0,
			},
		],
	};
	const saved: SavedWork = {
		id: demoHash(400),
		code: 'NECT-024',
		savedAt: now,
		updatedAt: now,
		records: records.filter((record) => record.code === 'NECT-024'),
		coverId: demoHash(300),
	};
	const subscriptionsState: SubscriptionsState = {
		revision: 1,
		preferences: { ...structuredClone(DEFAULT_PREFERENCES), enabledSources: ['dmm', 'r18dev', 'javdb', 'javtao', 'fanbox', 'x', 'patreon'], theme },
		subscriptions,
		entries,
		tasks: [],
		sources: SOURCES.map((source) => ({ id: source.id, credentialPresent: false, checkedAt: '', state: '示例数据', message: '', cooldownUntil: 0 })),
		encryptionAvailable: false,
		notice: '',
	};
	return { subscriptions: subscriptionsState, metadata, saved: [saved], library: { revision: 1, works: [summarizeWork(saved)] } };
}

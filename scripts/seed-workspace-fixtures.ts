import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SubscriptionStore } from '../src/main/subscription-store';
import { DEFAULT_PREFERENCES } from '../src/shared/subscriptions';
import { metadataRecordSchema, type ImageAsset, type QueryTask } from '../src/shared/metadata';

const root = process.argv[2];
if (!root || !basename(root).startsWith('nectisse-workspace-review-')) {
	throw new Error('仅允许写入本次视觉检查的临时目录');
}
const imagePath = new URL('../src/renderer/src/prototype/assets/editorial-sheet.png', import.meta.url);
const bytes = await readFile(imagePath);
const hash = createHash('sha256').update(bytes).digest('hex');
const asset: ImageAsset = { sha256: hash, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length, format: 'PNG', quality: 'standard' };
for (const folder of ['covers', 'subscription-covers']) {
	const target = join(root, 'cache', folder);
	await mkdir(target, { recursive: true });
	await copyFile(imagePath, join(target, `${hash}.image`));
}
const timestamp = '2026-10-23T10:00:00.000Z';
const store = new SubscriptionStore(root, {
	available: () => false,

	encrypt: () => {
		throw new Error('视觉检查不使用凭据');
	},

	decrypt: () => '',
});
store.savePreferences({ ...DEFAULT_PREFERENCES, automatic: false });
const creator = store.follow({
	provider: 'fanbox',
	ref: 'nectisse-visual-fixture',
	name: '白石 澪 · 私人作品与创作手记（布局检查样本）',
	url: 'https://example.invalid/creator',
	aliases: [],
	recordType: '创作者',
	bio: '这里是用于检查真实工作区布局的本地样本。较长的简介应自然换行，关注状态、检查频率和操作按钮保持对齐。',
	evidence: '本地视觉检查样本，不连接原站。',
});
creator.initialized = true;
creator.lastCheckedAt = timestamp;
creator.coverage = '布局检查样本 · 首页与有界分页';
store.saveSubscription(creator);
const actor = store.follow({
	provider: 'javdb',
	ref: 'nectisse-actor-fixture',
	name: '三宫 椿（布局检查样本）',
	url: 'https://example.invalid/actor',
	aliases: [],
	recordType: '演员',
	bio: '',
	evidence: '本地视觉检查样本。',
});
actor.initialized = true;
actor.lastCheckedAt = timestamp;
actor.coverage = '布局检查样本 · 演员新作首页';
store.saveSubscription(actor);
for (const [index, title, summary, withImage] of [
	[1, '十月的拍摄手记：让光再停留一会儿（布局检查样本）', '一条带有封面的创作者动态，用于检查封面、标题、摘要与已读操作的行列关系。', true],
	[
		2,
		'关于下一次作品发布的公告：进度、日程与一些仍在进行中的想法（布局检查样本）',
		'这是一条没有封面的公告。\n摘要较长时应省略为一行，保留固定封面位置，底部的时间与已读操作保持对齐。',
		false,
	],
	[3, '（来源未提供摘要的布局检查样本）', '', false],
] as const) {
	store.upsertEntry(
		creator,
		{
			externalId: String(index),
			title,
			summary,
			author: creator.name,
			publishedAt: timestamp,
			publishedPrecision: 'exact',
			url: `https://example.invalid/posts/${index}`,
			thumbnailUrl: withImage ? 'https://example.invalid/fixture.png' : '',
			code: '',
			restricted: false,
			partial: false,
		},
		timestamp,
	);
}
store.upsertEntry(
	actor,
	{
		externalId: 'actor-1',
		title: 'NECT-024 ' + '光影、摄影手记与作品发布：用于检查超长标题在更新条目中的两行省略。'.repeat(6) + '（布局检查样本）',
		summary: '用于检查演员条目的标签、发布时间和作品资料入口。',
		author: actor.name,
		publishedAt: '2026-10-23',
		publishedPrecision: 'date',
		url: 'https://example.invalid/work',
		thumbnailUrl: '',
		code: 'NECT-024',
		restricted: false,
		partial: false,
	},
	timestamp,
);
const imageEntry = store.entries(creator.id).find((entry) => entry.externalId === '1')!;
store.saveImage(imageEntry, asset);
const missingImageEntry = store.entries(creator.id).find((entry) => entry.externalId === '2')!;
store.saveImage(missingImageEntry, { ...asset, sha256: 'b'.repeat(64) });
store.close();

const records = (['dmm', 'r18dev'] as const).map((source, index) =>
	metadataRecordSchema.parse({
		id: createHash('sha256').update(source).digest('hex'),
		source,
		parser: 'visual-fixture',
		parserVersion: 'fixture',
		code: 'NECT-024',
		contentId: 'visual-fixture',
		sourceUrl: `https://example.invalid/${source}`,
		fetchedAt: timestamp,
		title: '午後、窓辺にて — 用于检查长标题换行与来源字段对齐的作品资料',
		titleLanguage: 'ja',
		people: [{ name: '白石 澪（布局检查样本）', role: 'performer', sourceIdentity: '' }],
		studio: '暖光作品社（布局检查样本）',
		label: 'Nectisse',
		series: '日常与光的记录',
		seller: '',
		sellerUrl: '',
		releaseDate: index ? '2026-10-24' : '2026-10-23',
		description: '这份资料仅用于检查真实工作区的视觉与交互。标题、日期与封面都是本地样本；不会向来源发送请求。',
		tags: ['摄影', '日常', '长标签应能自然换行并保持间距'],
		covers: [{ id: createHash('sha256').update(`cover-${source}`).digest('hex'), url: 'https://example.invalid/fixture.png', source, identity: 'source-matched', asset }],
		warnings: [],
	}),
);
const task: QueryTask = {
	id: randomUUID(),
	status: 'succeeded',
	phase: '本地布局检查样本',
	plan: { kind: 'code', query: 'NECT-024', code: 'NECT-024', contentId: '', sources: ['dmm', 'r18dev'] },
	startedAt: timestamp,
	finishedAt: timestamp,
	records,

	outcomes: ['dmm', 'r18dev'].map((source) => ({ source: source as 'dmm' | 'r18dev', status: 'success', reason: '', message: '', retryAfter: 0, requests: 0, warnings: [] })),

	requests: 0,
};
await mkdir(join(root, 'metadata'), { recursive: true });
await writeFile(
	join(root, 'metadata/state.json'),
	JSON.stringify({ version: 1, revision: 1, tasks: [task], assets: { [hash]: { ...asset, cachedAt: Date.now() } }, policies: {} }),
);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SOURCES, METADATA_IDS, FOLLOW_IDS, SOURCE_BY_ID, RETIRED_SOURCE_IDS } from '@shared/sources';
import { DEFAULT_PREFERENCES, preferencesPatchSchema } from '@shared/preferences';
import { followCommandSchema, followTaskSchema } from '@shared/subscriptions';
import { queryRequestSchema } from '@shared/metadata';
import { randomUUID } from 'node:crypto';
import { canonicalFollow, validFollowEntry } from '@shared/source-identity';
import { planQuery } from '../src/main/features/metadata/metadata-input';
import { MetadataService } from '../src/main/features/metadata/metadata-service';
import { SubscriptionStore } from '../src/main/features/subscriptions/subscription-store';
import { SubscriptionsService } from '../src/main/features/subscriptions/subscriptions-service';
import { SiteGate } from '../src/main/platform/network/site-gate';
import type { PythonTaskHost } from '../src/main/platform/python/python-host';

const cipher = {
	available: () => false,

	encrypt: () => Buffer.alloc(0),

	decrypt: () => '',
};
const success = { status: 'success', reason: '', message: '完成', requests: 1, retryAfter: 0, warnings: [] };

async function directory(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-sources-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test('来源目录只将已接入能力暴露为可派发，不把历史、标签或论坛身份当创作者发布', () => {
	assert.deepEqual(
		SOURCES.filter((row) => row.metadata)
			.map((row) => row.id)
			.sort(),
		[...METADATA_IDS].sort(),
	);
	assert.deepEqual(
		SOURCES.filter((row) => row.follow)
			.map((row) => row.id)
			.sort(),
		[...FOLLOW_IDS].sort(),
	);
	for (const id of ['f95zone', 'simpcity', 'duga'] as const) {
		assert.equal(SOURCE_BY_ID[id].available, false);
	}
	assert.equal(SOURCE_BY_ID.javdb.metadata, true);
	assert.equal(SOURCE_BY_ID.javdb.follow, true);
});

test('资料路由尊重 FC2 家族与日期式编号的发行方证据，原生链接不保存额外 token', () => {
	const base = { sources: [...METADATA_IDS], force: false };
	const fc2 = planQuery({ ...base, query: 'FC2-PPV-1234567' });
	assert.ok(fc2.sources.includes('javten'));
	assert.equal(fc2.sources.includes('dmm'), false);
	assert.throws(() => planQuery({ ...base, query: '092415_001' }), /发行方/);
	assert.deepEqual(planQuery({ ...base, query: 'https://www.1pondo.tv/movies/092415_001/' }).sources, ['1pondo']);
	assert.deepEqual(planQuery({ ...base, sources: ['1pondo'], query: '092415_001' }).sources, ['1pondo']);
	assert.equal(planQuery({ ...base, query: 'https://javdb.com/v/Ab123?token=private' }).sourceUrl, 'https://javdb.com/v/Ab123');
	assert.throws(() => planQuery({ ...base, query: 'https://www.k-mib.com/video/video-view.php?idx=7' }), /未识别此站点/);
	assert.throws(() => planQuery({ ...base, query: 'https://fc2club.top/html/FC2-1234567.html' }), /未识别此站点/);
	assert.throws(() => planQuery({ ...base, query: 'https://127.0.0.1/video/video-view.php?idx=7' }));
});

test('旧设置迁移保留代理、来源开关与已读数据，补齐新来源顺序', async (t) => {
	const root = await directory(t);
	const store = new SubscriptionStore(root, cipher);
	const legacy = { ...store.preferences(), metadataPriority: ['r18dev', 'dmm', 'fc2'], proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7890' } as Record<string, unknown>;
	delete legacy.sourceTransports;
	store.db.prepare('INSERT INTO preferences VALUES(1,?)').run(JSON.stringify(legacy));
	store.close();
	const restored = new SubscriptionStore(root, cipher);
	const current = restored.preferences();
	assert.equal(current.proxyUrl, legacy.proxyUrl);
	assert.equal(current.proxyMode, 'custom');
	assert.deepEqual(current.metadataPriority.slice(0, 3), ['r18dev', 'dmm', 'fc2']);
	assert.equal(current.metadataPriority.length, METADATA_IDS.length);
	assert.deepEqual(current.enabledSources, legacy.enabledSources);
	assert.deepEqual(current.sourceTransports, {});
	restored.close();
});

test('已移除来源不出现在目录中，也不能通过设置或查询命令重新启用', () => {
	for (const id of RETIRED_SOURCE_IDS) {
		assert.equal(
			SOURCES.some((source) => source.id === (id as string)),
			false,
		);
		assert.equal(preferencesPatchSchema.safeParse({ enabledSources: [id] }).success, false);
		assert.equal(followCommandSchema.safeParse({ action: 'lookup', provider: id, query: 'creator' }).success, false);
		assert.equal(queryRequestSchema.safeParse({ query: 'ABC-001', sources: [id] }).success, false);
	}
});

test('旧设置去除已移除来源；旧订阅、动态与任务不参与运行，仍保留在数据库中', async (t) => {
	const root = await directory(t);
	const store = new SubscriptionStore(root, cipher);
	const active = store.follow({
		provider: 'patreon',
		ref: 'creator',
		url: canonicalFollow('patreon', 'creator'),
		name: '作者',
		recordType: '主页',
		aliases: [],
		bio: '',
		evidence: '',
	});
	store.upsertEntry(active, {
		externalId: '12345',
		title: '公告',
		summary: '',
		author: '作者',
		publishedAt: '',
		publishedPrecision: 'unknown',
		url: 'https://www.patreon.com/posts/12345',
		thumbnailUrl: '',
		code: '',
		restricted: false,
		partial: true,
	});
	store.markRead([store.entries()[0]!.id], true);
	const task = followTaskSchema.parse({
		id: randomUUID(),
		kind: 'check',
		provider: 'patreon',
		status: 'succeeded',
		phase: '',
		startedAt: '2026-10-01',
		finishedAt: '',
		requests: 0,
		candidates: [],
		added: 0,
		reason: '',
		cancelRequestedAt: '',
	});
	store.saveTask(task);
	store.db.prepare('INSERT INTO preferences VALUES(1,?)').run(
		JSON.stringify({
			...DEFAULT_PREFERENCES,
			enabledSources: [...DEFAULT_PREFERENCES.enabledSources, ...RETIRED_SOURCE_IDS],
			querySources: ['kmib', 'fc2club'],
			metadataPriority: ['kmib', 'r18dev', 'fc2club'],
			coverPriority: ['kmib', 'dmm', 'fc2club'],
			sourceTransports: { kmib: 'fingerprint', subscribestar: 'httpx', javdb: 'fingerprint' },
			proxyMode: 'custom',
			proxyUrl: 'http://127.0.0.1:7890',
			theme: 'night',
		}),
	);
	const retiredIds: string[] = [];
	for (const provider of ['subscribestar', 'rule34video']) {
		const id = randomUUID();
		retiredIds.push(id);
		store.db.prepare('INSERT INTO subscriptions VALUES(?,?,?,?)').run(id, provider, 'creator', JSON.stringify({ ...active, id, provider }));
		store.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?)').run(id, id, '12345', JSON.stringify({ ...store.entries()[0], id, subscriptionId: id, provider }), '2026-11-01');
		for (let i = 0; i < 20; i++) {
			store.db.prepare('INSERT INTO follow_tasks VALUES(?,?,?)').run(randomUUID(), '2026-11-01', JSON.stringify({ ...task, provider, status: 'running' }));
		}
	}
	store.close();
	const restored = new SubscriptionStore(root, cipher);
	t.after(() => restored.close());
	const preferences = restored.preferences();
	assert.deepEqual(preferences.querySources, []);
	assert.deepEqual(preferences.enabledSources, DEFAULT_PREFERENCES.enabledSources);
	assert.equal(preferences.metadataPriority[0], 'r18dev');
	assert.equal(preferences.metadataPriority.length, METADATA_IDS.length);
	assert.deepEqual(preferences.coverPriority, ['dmm']);
	assert.deepEqual(preferences.sourceTransports, { javdb: 'fingerprint' });
	assert.equal(preferences.proxyUrl, 'http://127.0.0.1:7890');
	assert.equal(preferences.theme, 'night');
	assert.deepEqual(
		restored.subscriptions().map((sub) => sub.id),
		[active.id],
	);
	assert.equal(restored.entries().length, 1);
	assert.equal(restored.entries()[0]!.read, true);
	assert.deepEqual(
		restored.tasks().map((item) => item.id),
		[task.id],
	);
	for (const id of retiredIds) {
		assert.equal(restored.subscription(id), undefined);
		assert.equal(restored.entry(id), undefined);
		assert.deepEqual(restored.entries(id), []);
	}
	assert.equal(restored.db.prepare('SELECT count(*) AS n FROM subscriptions').get()?.n, 3);
	assert.equal(restored.db.prepare('SELECT count(*) AS n FROM entries').get()?.n, 3);
	assert.equal(restored.db.prepare('SELECT count(*) AS n FROM follow_tasks').get()?.n, 41);
});

test('扩展资料链仍限制整次 24 个请求，预算耗尽的来源不再创建工作者', async (t) => {
	let calls = 0;

	const run: PythonTaskHost['run'] = async (_method, params, options) => {
		calls++;
		for (let sequence = 1; sequence <= 8; sequence++) {
			await options?.onRequest?.({ source: String(params?.source), host: 'fixture.test', sequence });
		}
		return { ...success, requests: 8 };
	};

	const service = new MetadataService(await directory(t), { run }, async () => '', 0);
	await service.initialize();
	await service.query({ query: 'SSIS-057', sources: ['dmm', 'r18dev', 'avbase', 'javbus'], force: false });
	for (let i = 0; i < 400 && service.getState().activeId; i++) {
		await delay(5);
	}
	const task = service.getState().tasks[0]!;
	assert.equal(task.requests, 24);
	assert.equal(calls, 3);
	assert.equal(task.outcomes.find((row) => row.source === 'javbus')?.reason, 'budget_exceeded');
	await service.stop();
});

test('订阅保存已接入来源的原生身份，不按相同显示名合并', async (t) => {
	const store = new SubscriptionStore(await directory(t), cipher);
	for (const [provider, ref] of [
		['patreon', 'creator'],
		['kemono', 'fanbox/123'],
		['pawchive', 'patreon/123'],
		['coomer', 'onlyfans/123'],
	] as const) {
		const sub = store.follow({ provider, ref, url: canonicalFollow(provider, ref), name: '相同显示名', recordType: '来源身份', aliases: [], bio: '', evidence: '来源已核对' });
		assert.equal(sub.kind, 'creator_posts');
	}
	assert.equal(store.subscriptions().length, 4);
	store.close();
});

test('扩展订阅不会接收另一账号、另一主机或不匹配的帖子身份', () => {
	assert.equal(validFollowEntry('kemono', 'fanbox/123', { externalId: '456', url: 'https://kemono.cr/fanbox/user/123/post/456' }), true);
	assert.equal(validFollowEntry('kemono', 'fanbox/123', { externalId: '456', url: 'https://kemono.cr/fanbox/user/999/post/456' }), false);
	assert.equal(validFollowEntry('patreon', 'creator', { externalId: '456', url: 'https://www.patreon.com/posts/announcement-456' }), true);
	assert.throws(() => canonicalFollow('coomer', 'onlyfans/..'));
});

test('所有来源的启用、Cookie 和传输策略都经过真实派发约束', async (t) => {
	const store = new SubscriptionStore(await directory(t), cipher);
	const calls: string[] = [];

	const run: PythonTaskHost['run'] = async (_method, params) => {
		calls.push(String(params?.provider));
		assert.equal(params?.transport, 'httpx');
		return { ...success, candidates: [] };
	};

	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	assert.equal((await service.command({ action: 'lookup', provider: 'patreon', query: 'creator' })).ok, false);
	await service.command({
		action: 'preferences',
		value: { ...store.preferences(), enabledSources: [...store.preferences().enabledSources, 'patreon'], sourceTransports: { patreon: 'httpx' } },
	});
	assert.equal((await service.command({ action: 'lookup', provider: 'patreon', query: 'creator' })).ok, true);
	for (let i = 0; i < 200 && service.getState().tasks.some((row) => row.status === 'running'); i++) {
		await delay(5);
	}
	assert.deepEqual(calls, ['patreon']);
	await service.stop();
	store.close();
});

test('资料与订阅共享站点间隔，同主机 Wiki 共享冷却且排队可取消', async (t) => {
	const store = new SubscriptionStore(await directory(t), cipher);
	const gate = new SiteGate(store);
	await gate.permit('javdb', new AbortController().signal);
	assert.ok(store.source('javdb').nextRequestAt > Date.now() + 2500);
	const controller = new AbortController();
	const pending = gate.permit('javdb', controller.signal);
	controller.abort();
	await assert.rejects(pending);
	store.saveSource('av_name', { ...store.source('av_name'), cooldownUntil: Date.now() + 10000 });
	await assert.rejects(gate.permit('av_neme', new AbortController().signal), /冷却/);
	store.close();
});

test('等待站点间隔时新增的共享冷却会阻止当前排队请求', async (t) => {
	const store = new SubscriptionStore(await directory(t), cipher);
	t.after(() => store.close());
	const gate = new SiteGate(store);
	store.saveSource('av_name', { ...store.source('av_name'), nextRequestAt: Date.now() + 100 });
	const pending = gate.permit('av_neme', new AbortController().signal);
	await delay(5);
	store.saveSource('av_name', { ...store.source('av_name'), cooldownUntil: Date.now() + 10000 });
	await assert.rejects(pending, /冷却/);
	assert.equal(store.source('av_neme').nextRequestAt, 0);
});

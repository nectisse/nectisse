import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SOURCES, METADATA_IDS, FOLLOW_IDS, SOURCE_BY_ID } from '../src/shared/sources';
import { canonicalFollow, validFollowEntry } from '../src/shared/source-identity';
import { planQuery } from '../src/main/metadata-input';
import { MetadataService } from '../src/main/metadata-service';
import { SubscriptionStore } from '../src/main/subscription-store';
import { SubscriptionsService } from '../src/main/subscriptions-service';
import { SiteGate } from '../src/main/site-gate';
import type { PythonTaskHost } from '../src/main/python-host';

const cipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
const success = { status: 'success', reason: '', message: '完成', requests: 1, retryAfter: 0, warnings: [] };
async function directory(t: { after: (fn: () => Promise<void>) => void }): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'nectisse-sources-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('来源目录只将已接入能力暴露为可派发，不把历史、标签或论坛身份当创作者发布', () => {
	assert.deepEqual(SOURCES.filter(row => row.metadata).map(row => row.id).sort(), [...METADATA_IDS].sort());
	assert.deepEqual(SOURCES.filter(row => row.follow).map(row => row.id).sort(), [...FOLLOW_IDS].sort());
	for (const id of ['rule34xxx', 'rule34paheal', 'f95zone', 'simpcity', 'duga'] as const) assert.equal(SOURCE_BY_ID[id].available, false);
	assert.equal(SOURCE_BY_ID.javdb.metadata, true); assert.equal(SOURCE_BY_ID.javdb.follow, true);
});

test('资料路由尊重 FC2 家族与日期式编号的发行方证据，原生链接不保存额外 token', () => {
	const base = { sources: [...METADATA_IDS], force: false };
	const fc2 = planQuery({ ...base, query: 'FC2-PPV-1234567' });
	assert.ok(fc2.sources.includes('fc2cmadb')); assert.ok(fc2.sources.includes('fc2club')); assert.equal(fc2.sources.includes('dmm'), false);
	assert.throws(() => planQuery({ ...base, query: '092415_001' }), /发行方/);
	assert.deepEqual(planQuery({ ...base, query: 'https://www.1pondo.tv/movies/092415_001/' }).sources, ['1pondo']);
	assert.deepEqual(planQuery({ ...base, sources: ['1pondo'], query: '092415_001' }).sources, ['1pondo']);
	assert.equal(planQuery({ ...base, query: 'https://javdb.com/v/Ab123?token=private' }).sourceUrl, 'https://javdb.com/v/Ab123');
	assert.equal(planQuery({ ...base, query: 'https://www.k-mib.com/video/video-view.php?idx=7&token=private' }).sourceUrl, 'https://www.k-mib.com/video/video-view.php?idx=7');
	assert.throws(() => planQuery({ ...base, query: 'https://127.0.0.1/video/video-view.php?idx=7' }));
});

test('旧设置迁移保留代理、来源开关与已读数据，补齐新来源顺序', async t => {
	const root = await directory(t); const store = new SubscriptionStore(root, cipher);
	const legacy = { ...store.preferences(), metadataPriority: ['r18dev', 'dmm', 'fc2'], proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7890' } as Record<string, unknown>;
	delete legacy.sourceTransports;
	store.db.prepare('INSERT INTO preferences VALUES(1,?)').run(JSON.stringify(legacy));
	store.close();
	const restored = new SubscriptionStore(root, cipher);
	const current = restored.preferences(); assert.equal(current.proxyUrl, legacy.proxyUrl); assert.equal(current.proxyMode, 'custom'); assert.deepEqual(current.metadataPriority.slice(0, 3), ['r18dev', 'dmm', 'fc2']); assert.equal(current.metadataPriority.length, METADATA_IDS.length); assert.deepEqual(current.enabledSources, legacy.enabledSources); assert.deepEqual(current.sourceTransports, {}); restored.close();
});

test('扩展资料链仍限制整次 24 个请求，预算耗尽的来源不再创建工作者', async t => {
	let calls = 0;
	const run: PythonTaskHost['run'] = async (_method, params, options) => { calls++; for (let sequence = 1; sequence <= 8; sequence++) await options?.onRequest?.({ source: String(params?.source), host: 'fixture.test', sequence }); return { ...success, requests: 8 }; };
	const service = new MetadataService(await directory(t), { run }, async () => '', 0); await service.initialize();
	await service.query({ query: 'SSIS-057', sources: ['dmm', 'r18dev', 'avbase', 'javbus'], force: false });
	for (let i = 0; i < 400 && service.getState().activeId; i++) await delay(5);
	const task = service.getState().tasks[0]!; assert.equal(task.requests, 24); assert.equal(calls, 3); assert.equal(task.outcomes.find(row => row.source === 'javbus')?.reason, 'budget_exceeded'); await service.stop();
});

test('订阅保存全部已接入来源的原生身份；SubscribeStar 两个主机互不合并', async t => {
	const store = new SubscriptionStore(await directory(t), cipher);
	for (const [provider, ref] of [['patreon', 'creator'], ['subscribestar', 'subscribestar.com/creator'], ['subscribestar', 'subscribestar.adult/creator'], ['kemono', 'fanbox/123'], ['pawchive', 'patreon/123'], ['coomer', 'onlyfans/123'], ['rule34video', 'creator']] as const) {
		const sub = store.follow({ provider, ref, url: canonicalFollow(provider, ref), name: '相同显示名', recordType: '来源身份', aliases: [], bio: '', evidence: '来源已核对' });
		assert.equal(sub.kind, 'creator_posts');
	}
	assert.equal(store.subscriptions().length, 7); store.close();
});

test('扩展订阅不会接收另一账号、另一主机或不匹配的帖子身份', () => {
	assert.equal(validFollowEntry('kemono', 'fanbox/123', { externalId: '456', url: 'https://kemono.cr/fanbox/user/123/post/456' }), true);
	assert.equal(validFollowEntry('kemono', 'fanbox/123', { externalId: '456', url: 'https://kemono.cr/fanbox/user/999/post/456' }), false);
	assert.equal(validFollowEntry('subscribestar', 'subscribestar.adult/creator', { externalId: '456', url: 'https://subscribestar.com/posts/456' }), false);
	assert.equal(validFollowEntry('patreon', 'creator', { externalId: '456', url: 'https://www.patreon.com/posts/announcement-456' }), true);
	assert.equal(validFollowEntry('rule34video', 'creator', { externalId: '456', url: 'https://rule34video.com/video/456/announcement/' }), true);
	assert.throws(() => canonicalFollow('coomer', 'onlyfans/..'));
});

test('所有来源的启用、Cookie 和传输策略都经过真实派发约束', async t => {
	const store = new SubscriptionStore(await directory(t), cipher); const calls: string[] = [];
	const run: PythonTaskHost['run'] = async (_method, params) => { calls.push(String(params?.provider)); assert.equal(params?.transport, 'httpx'); return { ...success, candidates: [] }; };
	const service = new SubscriptionsService(store, { run }, async () => '', async () => {}, 0);
	assert.equal((await service.command({ action: 'lookup', provider: 'patreon', query: 'creator' })).ok, false);
	await service.command({ action: 'preferences', value: { ...store.preferences(), enabledSources: [...store.preferences().enabledSources, 'patreon'], sourceTransports: { patreon: 'httpx' } } });
	assert.equal((await service.command({ action: 'lookup', provider: 'patreon', query: 'creator' })).ok, true);
	for (let i = 0; i < 200 && service.getState().tasks.some(row => row.status === 'running'); i++) await delay(5);
	assert.deepEqual(calls, ['patreon']); await service.stop(); store.close();
});

test('资料与订阅共享站点间隔，同主机 Wiki 共享冷却且排队可取消', async t => {
	const store = new SubscriptionStore(await directory(t), cipher); const gate = new SiteGate(store);
	await gate.permit('javdb', new AbortController().signal);
	assert.ok(store.source('javdb').nextRequestAt > Date.now() + 2500);
	const controller = new AbortController(); const pending = gate.permit('javdb', controller.signal); controller.abort(); await assert.rejects(pending);
	store.saveSource('av_name', { ...store.source('av_name'), cooldownUntil: Date.now() + 10000 });
	await assert.rejects(gate.permit('av_neme', new AbortController().signal), /冷却/); store.close();
});

test('等待站点间隔时新增的共享冷却会阻止当前排队请求', async t => {
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

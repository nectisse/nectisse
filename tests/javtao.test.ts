import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { MagnetService } from '../src/main/features/magnets/magnet-service';
import { SubscriptionsService, SubscriptionStore } from '../src/main/features/subscriptions';
import { TaskCancelledError, type PythonTaskHost } from '../src/main/platform/python/python-host';
import { planQuery } from '../src/main/features/metadata/metadata-input';
import { DEFAULT_MAGNET_SETTINGS, magnetResultSchema, type MagnetSource } from '@shared/magnets';
import { DEFAULT_PREFERENCES, preferencesSchema } from '@shared/preferences';
import { canonicalFollow, validFollowEntry } from '@shared/source-identity';
import { isPerformerProvider } from '@shared/sources';
import type { FollowCandidate } from '@shared/subscriptions';

const success = { status: 'success', reason: '', message: '', retryAfter: 0, requests: 1, warnings: [] };
const candidate: FollowCandidate = {
	provider: 'javtao',
	ref: 'actor-a',
	name: '演员甲',
	url: 'https://javtao.com/actress/actor-a',
	aliases: [],
	recordType: '演员目录',
	bio: '',
	evidence: '实际目录链接',
};
const entry = {
	externalId: '/test-001',
	title: 'TEST-001 作品',
	summary: '',
	author: '演员甲',
	publishedAt: '2026-01-02',
	publishedPrecision: 'date' as const,
	url: 'https://javtao.com/test-001',
	thumbnailUrl: '',
	code: 'TEST-001',
	restricted: false,
	partial: false,
};

async function directory(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-javtao-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function idle(service: SubscriptionsService): Promise<void> {
	for (let turn = 0; turn < 200; turn++) {
		if (!service.getState().tasks.some((task) => ['running', 'cancelling'].includes(task.status))) {
			return;
		}
		await delay(5);
	}
	throw new Error('Subscription task did not finish');
}

const magnetRow = (source: MagnetSource) => ({
	id: 'a'.repeat(40),
	title: 'TEST-001 作品',
	magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
	url: source === 'javtao' ? 'https://javtao.com/test-001' : 'https://sukebei.nyaa.si/view/1',
	size: '2.3 GB',
	uploadedAt: null,
	seeders: null,
	leechers: null,
	completed: null,
});

test('JavTao 路由保留作品身份，演员与作品链接不能互换；旧磁链设置补齐原来源', () => {
	assert.equal(isPerformerProvider('javtao'), true);
	assert.equal(canonicalFollow('javtao', 'actor-a'), candidate.url);
	assert.equal(validFollowEntry('javtao', 'actor-a', entry), true);
	assert.equal(validFollowEntry('javtao', 'actor-a', { ...entry, url: 'https://example.org/test-001' }), false);
	const request = { query: 'https://javtao.com/test-001?token=private', sources: ['javtao'] as const, force: false };
	assert.equal(planQuery({ ...request, sources: [...request.sources] }).sourceUrl, 'https://javtao.com/test-001');
	assert.throws(() => planQuery({ ...request, query: candidate.url, sources: [...request.sources] }));
	const { source: _source, ...legacy } = DEFAULT_MAGNET_SETTINGS;
	assert.equal(preferencesSchema.parse({ ...DEFAULT_PREFERENCES, magnetSearch: legacy }).magnetSearch.source, 'sukebei');
	assert.equal(
		magnetResultSchema.safeParse({ code: 'TEST-001', source: 'sukebei', status: 'ready', items: [magnetRow('javtao')], checkedAt: new Date().toISOString(), message: '' })
			.success,
		false,
	);
});

test('JavTao 关注归入演员新作、采用演员频率，去重和已读状态在重启后保留', async (t) => {
	const root = await directory(t);
	const cipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
	const store = new SubscriptionStore(root, cipher);
	store.savePreferences({ ...store.preferences(), enabledSources: [...store.preferences().enabledSources, 'javtao'], performerMinutes: 720 });
	const run: PythonTaskHost['run'] = async (method, params, options) => {
		assert.equal(params?.transport, 'fingerprint');
		await options?.onRequest?.({ source: 'javtao', host: 'javtao.com', sequence: 1 });
		if (method === 'follow.lookup') {
			return { ...success, candidates: [candidate] };
		}
		options?.onProgress?.({ event: 'entry', entry });
		return { ...success, coverage: '已检查当前演员页', gap: false };
	};
	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	await service.initialize();
	try {
		const lookup = await service.command({ action: 'lookup', provider: 'javtao', query: '演员甲' });
		await idle(service);
		const followed = await service.command({ action: 'follow', taskId: lookup.id!, ref: 'actor-a' });
		assert.equal(followed.ok, true);
		await idle(service);
		const sub = service.getState().subscriptions[0]!;
		assert.equal(sub.kind, 'performer_releases');
		assert.ok(Date.parse(sub.nextCheckAt) - Date.parse(sub.lastCheckedAt) >= 719 * 60_000);
		assert.equal((await service.command({ action: 'update', id: sub.id, intervalMinutes: 60 })).ok, false);
		await service.command({ action: 'read', ids: [service.getState().entries[0]!.id], read: true });
		await service.command({ action: 'check', id: sub.id });
		await idle(service);
		assert.equal(service.getState().entries.length, 1);
		assert.equal(service.getState().entries[0]!.read, true);
	} finally {
		await service.stop();
		store.close();
	}
	const restored = new SubscriptionStore(root, cipher);
	assert.equal(restored.subscriptions()[0]!.kind, 'performer_releases');
	assert.equal(restored.entries()[0]!.read, true);
	restored.close();
});

test('磁链缓存、原文操作及冷却按来源隔离；JavTao 强制指纹并通过共享站点许可', async (t) => {
	const root = await directory(t);
	const calls: string[] = [];
	const permitted: string[] = [];
	let limited = false;
	const run: PythonTaskHost['run'] = async (_method, params, options) => {
		const source = (params?.source ?? 'sukebei') as MagnetSource;
		calls.push(source);
		if (source === 'javtao') {
			assert.equal(params?.transport, 'fingerprint');
		}
		await options?.onRequest?.({ source, host: source === 'javtao' ? 'javtao.com' : 'sukebei.nyaa.si', sequence: 1 });
		return limited && source === 'javtao'
			? { status: 'failed', items: [], message: '限流', reason: 'rate_limited', retryAfter: 120 }
			: { status: 'ready', items: [magnetRow(source)], message: '' };
	};
	const service = new MagnetService(
		root,
		{ run },
		async () => '',
		0,
		() => DEFAULT_MAGNET_SETTINGS,
		{
			permit: async (source) => {
				permitted.push(source);
			},

			cooldown: (source) => {
				assert.equal(source, 'javtao');
			},
		},
	);
	try {
		await service.search('sukebei', 'TEST-001');
		await service.search('javtao', 'TEST-001', false, 'javtao');
		assert.equal((await service.row('TEST-001', 'a'.repeat(40), 'javtao'))!.url, 'https://javtao.com/test-001');
		assert.equal((await service.row('TEST-001', 'a'.repeat(40)))!.url, 'https://sukebei.nyaa.si/view/1');
		await service.search('cached', 'TEST-001', false, 'javtao');
		assert.deepEqual(calls, ['sukebei', 'javtao']);
		assert.deepEqual(permitted, calls);
		limited = true;
		assert.equal((await service.search('limited', 'TEST-002', true, 'javtao')).reason, 'rate_limited');
		assert.equal((await service.search('cooldown', 'TEST-003', true, 'javtao')).reason, 'cooldown');
		assert.equal((await service.search('unaffected', 'TEST-003', true)).status, 'ready');
	} finally {
		await service.stop();
	}
	const saved = JSON.parse(await readFile(join(root, 'magnet-search/state.json'), 'utf8'));
	assert.equal(
		saved.results.some((result: { source: string; code: string }) => result.source === 'sukebei' && result.code === 'TEST-001'),
		true,
	);
	assert.equal(
		saved.results.some((result: { source: string; code: string }) => result.source === 'javtao' && result.code === 'TEST-001'),
		true,
	);
});

test('JavTao 显式取消后重启不恢复，旧版 Sukebei 文件无需迁移工具', async (t) => {
	const root = await directory(t);
	let calls = 0;
	const run: PythonTaskHost['run'] = async (_method, _params, options) => {
		calls++;
		await new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new TaskCancelledError()), { once: true }));
		return {};
	};
	const service = new MagnetService(root, { run }, async () => '', 0);
	const pending = service.search('cancel', 'TEST-001', false, 'javtao');
	for (let turn = 0; turn < 200 && !calls; turn++) {
		await delay(5);
	}
	assert.equal(calls, 1);
	await service.cancel('cancel');
	assert.equal((await pending).status, 'cancelled');
	await service.stop();
	const restored = new MagnetService(root, { run }, async () => '', 0);
	assert.equal((await restored.search('restart', 'TEST-001', false, 'javtao')).status, 'cancelled');
	assert.equal(calls, 1);
	await restored.stop();
	const path = join(root, 'magnet-search/state.json');
	const legacy = {
		version: 1,
		nextRequestAt: 0,
		cooldownUntil: 0,
		results: [{ code: 'TEST-001', status: 'ready', items: [magnetRow('sukebei')], limit: 20, checkedAt: new Date().toISOString(), message: '' }],
	};
	await writeFile(path, JSON.stringify(legacy));
	const old = new MagnetService(root, { run }, async () => '', 0);
	assert.equal((await old.search('legacy', 'TEST-001')).source, 'sukebei');
	assert.equal(calls, 1);
	await old.stop();
});

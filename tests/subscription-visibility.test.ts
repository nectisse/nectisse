import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionStore } from '../src/main/features/subscriptions/subscription-store';
import { SubscriptionsService } from '../src/main/features/subscriptions/subscriptions-service';

const input = (index: number) => ({
	externalId: String(index),
	title: `记录 ${index}`,
	summary: '已收录资料',
	author: '三上悠亜',
	publishedAt: '',
	publishedPrecision: 'unknown' as const,
	url: `https://javdb.com/v/fixture${index}`,
	thumbnailUrl: '',
	code: `TEST-${index}`,
	restricted: false,
	partial: false,
});

test('较早关注演员的 40 条记录在全库超过 500 条、再次检查未发现新作后仍然可见', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-subscription-visibility-'));
	const store = new SubscriptionStore(root, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' });
	const actor = store.follow({ provider: 'javdb', ref: 'Av2e', name: '三上悠亜', url: 'https://javdb.com/actors/Av2e', aliases: [], recordType: '演员', bio: '', evidence: '' });
	actor.initialized = true;
	store.saveSubscription(actor);
	for (let n = 0; n < 40; n++) {
		store.upsertEntry(actor, input(n), '2026-10-23T12:06:07.327Z');
	}
	const other = store.follow({
		provider: 'javdb',
		ref: 'Other',
		name: '另一位演员',
		url: 'https://javdb.com/actors/Other',
		aliases: [],
		recordType: '演员',
		bio: '',
		evidence: '',
	});
	for (let n = 0; n < 533; n++) {
		store.upsertEntry(other, input(n + 40), '2026-10-24T12:00:00.000Z');
	}
	const service = new SubscriptionsService(
		store,
		{
			run: async (_method, _params, options) => {
				options?.onProgress?.({ event: 'entry', entry: input(0) });
				return { status: 'success', reason: '', message: '', requests: 0, retryAfter: 0, coverage: '已覆盖到上次记录', gap: false };
			},
		},
		async () => '',
		async () => {},
		0,
	);
	t.after(async () => {
		await service.stop();
		store.close();
		await rm(root, { recursive: true, force: true });
	});
	assert.equal(store.entries(actor.id).length, 40);
	await service.command({ action: 'check', id: actor.id });
	for (let n = 0; n < 100 && service.getState().tasks.some((task) => ['running', 'cancelling'].includes(task.status)); n++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(store.entries(actor.id).length, 40, '数据库应保留原有记录');
	const first = service.getEntries({ subscriptionId: actor.id, page: 1, pageSize: 20, unread: false });
	const second = service.getEntries({ subscriptionId: actor.id, page: 2, pageSize: 20, unread: false });
	assert.equal(first.total, 40);
	assert.equal(first.entries.length + second.entries.length, 40, '人物分页不能因其他关注的记录较新而变成空列表');
	assert.equal(service.getState().subscriptions.find((sub) => sub.id === actor.id)?.collected, 40);
	assert.equal(service.getState().subscriptions.find((sub) => sub.id === actor.id)?.latestEntry?.id, first.entries[0]?.id);
});

for (const provider of ['javdb', 'fanbox'] as const) {
	test(`${provider} 单个关注超过 500 条时仍能分页读完，未读筛选与已读操作只影响该关注`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'nectisse-person-pages-'));
		const store = new SubscriptionStore(root, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' });
		t.after(async () => {
			store.close();
			await rm(root, { recursive: true, force: true });
		});
		const sub = store.follow({
			provider,
			ref: 'fixture',
			name: '分页测试',
			url: provider === 'javdb' ? 'https://javdb.com/actors/fixture' : 'https://fixture.fanbox.cc',
			aliases: [],
			recordType: provider === 'javdb' ? '演员' : '创作者',
			bio: '',
			evidence: '',
		});
		for (let n = 0; n < 541; n++) {
			store.upsertEntry(sub, input(n), '2026-10-23T12:00:00.000Z');
		}
		const ids: string[] = [];
		for (let page = 1; page <= 28; page++) {
			const result = store.entryPage({ subscriptionId: sub.id, page, pageSize: 20, unread: false });
			assert.equal(result.total, 541);
			ids.push(...result.entries.map((entry) => entry.id));
		}
		assert.equal(ids.length, 541);
		assert.equal(new Set(ids).size, 541);
		store.markRead(ids.slice(0, 20), true);
		const unread = store.entryPage({ subscriptionId: sub.id, page: 1, pageSize: 20, unread: true });
		assert.equal(unread.total, 521);
		assert.ok(unread.entries.every((entry) => !entry.read));
		assert.deepEqual(
			unread.entries.map((entry) => entry.id),
			ids.slice(20, 40),
		);
		assert.equal(store.subscriptions()[0]?.collected, 541);
		assert.equal(store.subscriptions()[0]?.unread, 521);
	});
}

test('人物页缓存不依赖全局条目，旧演员标为已读和重新检查后从独立分页接口更新', async (t) => {
	const { QueryObserver } = await import('@tanstack/react-query');
	const { createDesktopQueries, queryKeys } = await import('../src/renderer/shared/desktop/queries');
	const { createDemoBridge } = await import('../src/renderer/demo/bridge');
	const bridge = createDemoBridge();
	const state = await bridge.subscriptions.getState();
	const sub = state.subscriptions[0]!;
	const entries = structuredClone(state.entries.filter((entry) => entry.subscriptionId === sub.id));
	let reads = 0;
	bridge.subscriptions.getEntries = async (request) => {
		reads++;
		return structuredClone({ entries, total: entries.length, page: request.page, pageSize: request.pageSize });
	};
	const queries = createDesktopQueries(() => bridge);
	const observer = new QueryObserver(queries.client, queries.entries(sub.id, false, 1, true));
	const release = observer.subscribe(() => {});
	t.after(() => {
		release();
		queries.client.clear();
	});
	await observer.refetch();
	const before = { ...structuredClone(state), entries: [] };
	const after = structuredClone(before);
	entries[0]!.read = true;
	after.subscriptions[0]!.unread = sub.unread - 1;
	await queries.syncSubscriptions(before, after);
	assert.ok(queries.client.getQueryData<{ entries: typeof entries }>(queryKeys.entries(sub.id, false, 1))?.entries[0]?.read);
	assert.equal(reads, 2);
	entries[0]!.summary = '同一记录重新检查后的摘要';
	const checked = structuredClone(after);
	checked.subscriptions[0]!.lastCheckedAt = new Date().toISOString();
	await queries.syncSubscriptions(after, checked);
	assert.equal(observer.getCurrentResult().data?.entries[0]?.summary, '同一记录重新检查后的摘要');
});

test('加载超过 500 条创作者动态后，批量已读按本机命令预算分批，不截掉剩余记录', async () => {
	const { createDesktopState } = await import('../src/renderer/shared/desktop/desktop');
	const { createDemoBridge } = await import('../src/renderer/demo/bridge');
	const bridge = createDemoBridge();
	const requests: string[][] = [];
	bridge.subscriptions.command = async (command) => {
		if (command.action === 'read') {
			requests.push(command.ids);
		}
		return { ok: true };
	};
	const desktop = createDesktopState(bridge);
	const ids = Array.from({ length: 541 }, (_, index) => `record-${index}`);
	const result = await desktop.actions.markRead(ids, true);
	assert.equal(result.ok, true);
	assert.equal(result.processed, 541);
	assert.deepEqual(
		requests.map((ids) => ids.length),
		[500, 41],
	);
	assert.deepEqual(requests.flat(), ids);
	desktop.queries.client.clear();
});

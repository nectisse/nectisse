import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SOURCES, SOURCE_BY_ID, DEFAULT_ENABLED } from '@shared/sources';
import { allowedSourceUrl, canonicalFollow, validFollowEntry } from '@shared/source-identity';
import { candidateSchema, type FollowCandidate, type EntryInput, type FollowTask } from '@shared/subscriptions';
import { SubscriptionStore } from '../src/main/features/subscriptions/subscription-store';
import { SubscriptionsService } from '../src/main/features/subscriptions/subscriptions-service';
import { PROVIDER_ROOTS } from '../src/main/features/subscriptions/follow-runner';
import { sourceTransport } from '../src/main/platform/network/source-policy';
import type { PythonTaskHost } from '../src/main/platform/python/python-host';

const ref = '1722511982610538496';
const postId = '2113542950370304375';
const checkedAt = '2026-10-24T00:00:00.000Z';
const success = { status: 'success', reason: '', message: '完成', requests: 1, retryAfter: 0, warnings: [] };
const cipher = {
	available: () => false,

	encrypt: () => Buffer.alloc(0),

	decrypt: () => '',
};

function profile(handle = 'creator_1'): FollowCandidate {
	return candidateSchema.parse({
		provider: 'x',
		ref,
		handle,
		name: '原创作者',
		url: `https://x.com/${handle}`,
		aliases: [],
		bio: '简介',
		recordType: '公开账号 · 本人原创',
		evidence: '已核对数字用户ID',
	});
}

function entry(handle = 'creator_1', externalId = postId): EntryInput {
	return {
		externalId,
		title: '原创正文',
		summary: '原创正文\n第二行',
		author: '原创作者',
		authorRef: ref,
		authorHandle: handle,
		postKind: 'original',
		publishedAt: checkedAt,
		publishedPrecision: 'exact',
		url: `https://x.com/${handle}/status/${externalId}`,
		thumbnailUrl: '',
		code: '',
		restricted: false,
		partial: false,
	};
}

async function directory(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'nectisse-x-follow-'));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

async function idle(service: SubscriptionsService, id?: string): Promise<FollowTask | undefined> {
	for (let i = 0; i < 300; i++) {
		const tasks = service.getState().tasks;
		const task = id ? tasks.find((item) => item.id === id) : tasks[0];
		if (task && !['running', 'cancelling'].includes(task.status)) {
			return task;
		}
		await delay(5);
	}
	throw new Error('X task did not finish');
}

test('X 请求、主页与图片分别登记；默认不启用且使用 HTTPX', () => {
	assert.equal(SOURCES.find((source) => source.id === 'x')?.follow, true);
	assert.equal(SOURCE_BY_ID.x.metadata, false);
	assert.equal(SOURCE_BY_ID.x.credential, false);
	assert.equal(
		DEFAULT_ENABLED.some((id) => id === 'x'),
		false,
	);
	assert.equal(sourceTransport('x'), 'httpx');
	assert.equal(PROVIDER_ROOTS.x, 'https://api.fxtwitter.com');
	assert.equal(SOURCE_BY_ID.x.root, 'https://x.com/');
	assert.deepEqual(SOURCE_BY_ID.x.requestDomains, ['api.fxtwitter.com']);
	assert.equal(allowedSourceUrl('x', 'https://api.fxtwitter.com/2/profile/test'), undefined);
	assert.equal(allowedSourceUrl('x', 'https://pbs.twimg.com/image.jpg', 'image'), 'https://pbs.twimg.com/image.jpg');
	assert.equal(allowedSourceUrl('x', 'https://video.twimg.com/video.mp4', 'image'), undefined);
	assert.equal(allowedSourceUrl('x', 'https://pbs.twimg.com.evil.example/image.jpg', 'image'), undefined);
});

test('数字身份与账号主页分离；X 条目必须核对作者ID、原创类型及原文路径', () => {
	assert.equal(canonicalFollow('x', ref, 'renamed'), 'https://x.com/renamed');
	assert.throws(() => canonicalFollow('x', ref));
	assert.throws(() => canonicalFollow('x', 'not-an-id', 'creator_1'));
	assert.equal(validFollowEntry('x', ref, entry()), true);
	assert.equal(validFollowEntry('x', ref, entry('renamed')), true);
	for (const patch of [
		{ authorRef: '123' },
		{ postKind: undefined },
		{ authorHandle: 'other' },
		{ url: `https://twitter.com/creator_1/status/${postId}` },
		{ url: `https://x.com/creator_1/status/${postId}?redirect=1` },
	]) {
		assert.equal(validFollowEntry('x', ref, { ...entry(), ...patch }), false);
	}
});

test('X 查询、确认、改名、去重、已读与观察窗口重启保留；代理按 API 地址解析', async (t) => {
	const root = await directory(t);
	const store = new SubscriptionStore(root, cipher);
	let checking = 0;
	const proxies: string[] = [];
	const opened: string[] = [];
	const run: PythonTaskHost['run'] = async (method, params, options) => {
		assert.equal(params?.provider, 'x');
		assert.equal(params?.transport, 'httpx');
		assert.equal(params?.cookie, '');
		await options?.onRequest?.({ source: 'x', host: 'api.fxtwitter.com', sequence: 1 });
		if (method === 'follow.lookup') {
			return { ...success, candidates: [profile()] };
		}
		assert.equal(method, 'follow.check');
		assert.equal(params?.ref, ref);
		checking++;
		const handle = checking > 1 ? 'renamed' : 'creator_1';
		options?.onProgress?.({ event: 'entry', entry: entry(handle) });
		if (checking > 1) {
			assert.deepEqual(params?.xSyncState, { windowIds: [postId], checkedAt });
			options?.onProgress?.({ event: 'entry', entry: entry(handle, '2113542950370304376') });
		}
		return { ...success, profile: profile(handle), coverage: '已检查本人原创', xSyncState: { windowIds: [postId], checkedAt } };
	};
	const service = new SubscriptionsService(
		store,
		{ run },
		async (url) => {
			proxies.push(url);
			return '';
		},
		async (url) => {
			opened.push(url);
		},
		0,
	);
	t.after(async () => {
		await service.stop();
		store.close();
	});
	assert.equal((await service.command({ action: 'lookup', provider: 'x', query: '@creator_1' })).ok, false);
	assert.deepEqual(proxies, []);
	await service.command({ action: 'source-enabled', source: 'x', enabled: true });
	assert.equal((await service.command({ action: 'credential', provider: 'x', cookie: 'not-needed' })).ok, false);
	const lookup = await service.command({ action: 'lookup', provider: 'x', query: '@creator_1' });
	const task = (await idle(service, lookup.id))!;
	assert.equal(task.candidates[0]?.ref, ref);
	const follow = await service.command({ action: 'follow', taskId: task.id, ref });
	assert.equal(follow.ok, true);
	await idle(service);
	const id = service.getState().entries[0]!.id;
	await service.command({ action: 'read', ids: [id], read: true });
	const refresh = await service.command({ action: 'check', id: follow.id! });
	await idle(service, refresh.id);
	assert.equal(service.getState().subscriptions.length, 1);
	assert.equal(service.getState().subscriptions[0]?.handle, 'renamed');
	assert.equal(service.getState().entries.length, 2);
	assert.equal(service.getState().entries.find((item) => item.id === id)?.read, true);
	await service.command({ action: 'open', kind: 'subscription', id: follow.id! });
	await service.command({ action: 'open', kind: 'entry', id });
	assert.deepEqual(opened, ['https://x.com/renamed', `https://x.com/renamed/status/${postId}`]);
	assert.ok(proxies.every((url) => url === 'https://api.fxtwitter.com'));
	await service.stop();
	const restored = new SubscriptionStore(root, cipher);
	t.after(() => restored.close());
	assert.equal(restored.subscriptions()[0]?.ref, ref);
	assert.equal(restored.subscriptions()[0]?.url, 'https://x.com/renamed');
	assert.equal(restored.entries().find((item) => item.id === id)?.read, true);
	assert.deepEqual(restored.subscriptions()[0]?.xSyncState, { windowIds: [postId], checkedAt });
});

async function setup(t: { after: (fn: () => Promise<void>) => void }, run: PythonTaskHost['run']) {
	const store = new SubscriptionStore(await directory(t), cipher);
	store.savePreferences({ ...store.preferences(), enabledSources: [...store.preferences().enabledSources, 'x'] });
	const sub = store.follow(profile());
	sub.initialized = true;
	sub.xSyncState = { windowIds: [postId], checkedAt };
	store.saveSubscription(sub);
	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	t.after(async () => {
		await service.stop();
		store.close();
	});
	return { service, store, sub };
}

test('检查补入旧原创后仍按发布时间显示，已读与首次发现时间不变', async (t) => {
	const newest = { ...entry('creator_1', '2113968472447439133'), publishedAt: '2026-10-24T12:18:54Z' };
	const recent = { ...entry('creator_1', '2113593679055343959'), publishedAt: '2026-10-23T11:29:36Z' };
	const older = { ...entry('creator_1', '2109604073288904890'), publishedAt: '2026-10-12T11:16:20Z' };
	const { service, store, sub } = await setup(t, async (_method, _params, options) => {
		for (const item of [newest, older, recent]) {
			options?.onProgress?.({ event: 'entry', entry: item });
		}
		return { ...success, profile: profile(), xSyncState: { windowIds: [newest.externalId], checkedAt } };
	});
	store.upsertEntry(sub, newest, '2026-10-24T18:25:04.373Z');
	store.upsertEntry(sub, recent, '2026-10-24T18:25:04.373Z');
	const newestId = store.entries(sub.id)[0]!.id;
	store.markRead([newestId], true);
	const reply = await service.command({ action: 'check', id: sub.id });
	assert.equal((await idle(service, reply.id))?.status, 'succeeded');
	const page = store.entryPage({ subscriptionId: sub.id, unread: false, page: 1, pageSize: 20 });
	assert.deepEqual(
		page.entries.map((item) => item.externalId),
		[newest.externalId, recent.externalId, older.externalId],
	);
	assert.equal(store.subscriptions()[0]?.latestEntry?.externalId, newest.externalId);
	assert.deepEqual(
		store.entryPage({ subscriptionId: sub.id, unread: true, page: 1, pageSize: 20 }).entries.map((item) => item.externalId),
		[recent.externalId, older.externalId],
	);
	const paged = [1, 2, 3].flatMap((page) => store.entryPage({ subscriptionId: sub.id, unread: false, page, pageSize: 1 }).entries);
	assert.deepEqual(
		paged.map((item) => item.externalId),
		[newest.externalId, recent.externalId, older.externalId],
	);
	assert.equal(store.entry(newestId)?.firstSeenAt, '2026-10-24T18:25:04.373Z');
	assert.equal(store.entry(newestId)?.read, true);
	assert.equal(store.entries(sub.id)[0]?.externalId, older.externalId, '后台近期快照继续按发现时间选取，避免漏掉补入条目的图片任务');
	await service.stop();
	const restored = new SubscriptionStore(store.root, cipher);
	t.after(() => restored.close());
	assert.deepEqual(
		restored.entryPage({ subscriptionId: sub.id, unread: false, page: 1, pageSize: 20 }).entries.map((item) => item.externalId),
		[newest.externalId, recent.externalId, older.externalId],
	);
});

test('部分页失败保留已到达原创和旧窗口；缺口在之后成功时继续保留', async (t) => {
	let count = 0;
	const { service, store, sub } = await setup(t, async (_method, _params, options) => {
		count++;
		if (count === 1) {
			options?.onProgress?.({ event: 'entry', entry: entry() });
			return { ...success, status: 'partial', reason: 'parse_error', gap: true, profile: profile(), coverage: '分页重复，覆盖尚未确认' };
		}
		return {
			...success,
			profile: profile(),
			coverage: '此前仍有缺口',
			gap: true,
			xSyncState: { windowIds: [postId], checkedAt, gapSince: store.subscription(sub.id)!.xSyncState!.gapSince },
		};
	});
	let reply = await service.command({ action: 'check', id: sub.id });
	await idle(service, reply.id);
	assert.equal(store.entries().length, 1);
	assert.equal(store.subscription(sub.id)?.xSyncState?.checkedAt, checkedAt);
	const gapSince = store.subscription(sub.id)?.xSyncState?.gapSince;
	assert.ok(gapSince);
	reply = await service.command({ action: 'check', id: sub.id });
	await idle(service, reply.id);
	assert.equal(store.subscription(sub.id)?.xSyncState?.gapSince, gapSince);
});

test('作者不匹配的条目不入库，已有观察窗口不推进', async (t) => {
	const { service, store, sub } = await setup(t, async (_method, _params, options) => {
		options?.onProgress?.({ event: 'entry', entry: { ...entry(), authorRef: '123' } });
		return { ...success, profile: { ...profile(), ref: '123' }, xSyncState: { windowIds: ['123'], checkedAt: '2026-10-25T00:00:00.000Z' } };
	});
	const reply = await service.command({ action: 'check', id: sub.id });
	const task = await idle(service, reply.id);
	assert.equal(task?.status, 'failed');
	assert.equal(store.entries().length, 0);
	assert.equal(store.subscription(sub.id)?.ref, ref);
	assert.equal(store.subscription(sub.id)?.xSyncState?.checkedAt, checkedAt);
});

test('返回另一账号资料时保留原关注身份、主页与观察窗口', async (t) => {
	const { service, store, sub } = await setup(t, async () => ({
		...success,
		profile: { ...profile('other'), ref: '123' },
		xSyncState: { windowIds: ['123'], checkedAt: '2026-10-25T00:00:00.000Z' },
	}));
	const reply = await service.command({ action: 'check', id: sub.id });
	assert.equal((await idle(service, reply.id))?.status, 'failed');
	assert.equal(store.subscription(sub.id)?.ref, ref);
	assert.equal(store.subscription(sub.id)?.url, 'https://x.com/creator_1');
	assert.equal(store.subscription(sub.id)?.xSyncState?.checkedAt, checkedAt);
});

test('取消后的迟到原创、账号改名和观察窗口不提交', async (t) => {
	let release: (() => void) | undefined;
	let started = false;
	const { service, store, sub } = await setup(t, async (_method, _params, options) => {
		started = true;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		options?.onProgress?.({ event: 'entry', entry: entry('renamed') });
		return { ...success, profile: profile('renamed'), xSyncState: { windowIds: [postId], checkedAt: '2026-10-25T00:00:00.000Z' } };
	});
	const reply = await service.command({ action: 'check', id: sub.id });
	for (let i = 0; i < 100 && !started; i++) {
		await delay(5);
	}
	assert.ok(started);
	const cancelling = service.cancel(reply.id!);
	release!();
	await cancelling;
	assert.equal(store.entries().length, 0);
	assert.equal(store.subscription(sub.id)?.handle, 'creator_1');
	assert.equal(store.subscription(sub.id)?.xSyncState?.checkedAt, checkedAt);
});

test('检查完成后在头像阶段取消，也不推进观察窗口', async (t) => {
	let release: (() => void) | undefined;
	let fetchingAvatar = false;
	const { service, store, sub } = await setup(t, async (method) => {
		if (method === 'follow.check') {
			return {
				...success,
				profile: { ...profile(), avatarUrl: 'https://pbs.twimg.com/profile_images/123/avatar_200x200.jpg' },
				xSyncState: { windowIds: ['123'], checkedAt: '2026-10-25T00:00:00.000Z' },
			};
		}
		assert.equal(method, 'follow.image');
		fetchingAvatar = true;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return { ...success, status: 'error', reason: 'cancelled' };
	});
	const reply = await service.command({ action: 'check', id: sub.id });
	for (let i = 0; i < 100 && !fetchingAvatar; i++) {
		await delay(5);
	}
	assert.ok(fetchingAvatar);
	assert.equal(store.subscription(sub.id)?.xSyncState?.checkedAt, checkedAt);
	const cancelling = service.cancel(reply.id!);
	release!();
	await cancelling;
	assert.deepEqual(store.subscription(sub.id)?.xSyncState, { windowIds: [postId], checkedAt });
});

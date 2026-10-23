import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { SubscriptionStore, type Cipher } from '../src/main/subscription-store';
import { SubscriptionsService } from '../src/main/subscriptions-service';
import { PythonTaskHost, TaskCancelledError } from '../src/main/python-host';
import type { FollowCandidate } from '../src/shared/subscriptions';
const candidate: FollowCandidate = {
	provider: 'fanbox',
	ref: 'testcreator',
	name: '公开作者',
	url: 'https://testcreator.fanbox.cc/',
	aliases: [],
	recordType: '创作者主页',
	bio: '介绍',
	evidence: '接口核对',
};
const success = { status: 'success', reason: '', message: '完成', requests: 1, retryAfter: 0 };
const entry = {
	externalId: '123',
	title: '纯文字进度',
	summary: '不含附件的进度公告',
	author: candidate.name,
	publishedAt: '2026-10-22T12:00:00Z',
	publishedPrecision: 'exact' as const,
	url: 'https://testcreator.fanbox.cc/posts/123',
	thumbnailUrl: '',
	code: '',
	restricted: false,
	partial: false,
};
// 仅测试注入的编码器；生产依赖 Electron safeStorage，而非此夹具。
const cipher: Cipher = {
	available: () => true,

	encrypt: (text) => Buffer.from(Buffer.from(text).toString('base64')),

	decrypt: (bytes) => Buffer.from(bytes.toString(), 'base64').toString(),
};
type Run = PythonTaskHost['run'];

async function directory(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-subscriptions-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function idle(service: SubscriptionsService): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (!service.getState().tasks.some((task) => ['running', 'cancelling'].includes(task.status))) {
			return;
		}
		await delay(5);
	}
	throw new Error('Task still running');
}

const runner: Run = async (method, params, options) => {
	await options?.onRequest?.({ source: 'fanbox', host: 'api.fanbox.cc', sequence: 1 });
	if (method === 'follow.lookup') {
		return { ...success, candidates: [candidate] };
	}
	assert.equal(params?.ref, candidate.ref);
	options?.onProgress?.({ event: 'entry', entry });
	return { ...success, coverage: '已覆盖到上次记录', gap: false };
};

test('真实候选才能关注，关注去重；条目与已读重启保留，摘要不因缺资源过滤', async (t) => {
	const root = await directory(t);
	const store = new SubscriptionStore(root, cipher);
	const service = new SubscriptionsService(
		store,
		{ run: runner },
		async () => '',
		async () => {},
		0,
	);
	assert.equal((await service.command({ action: 'follow', taskId: '11111111-1111-4111-8111-111111111111', ref: 'testcreator' })).ok, false);
	const lookup = await service.command({ action: 'lookup', provider: 'fanbox', query: 'testcreator' });
	await idle(service);
	const reply = await service.command({ action: 'follow', taskId: lookup.id!, ref: candidate.ref });
	await idle(service);
	assert.equal(reply.ok, true);
	assert.equal(service.getState().subscriptions.length, 1);
	assert.equal(service.getState().entries[0]!.summary, entry.summary);
	await service.command({ action: 'read', ids: [service.getState().entries[0]!.id], read: true });
	await service.command({ action: 'check', id: reply.id! });
	await idle(service);
	assert.equal(service.getState().entries.length, 1);
	assert.equal(service.getState().entries[0]!.read, true);
	await service.command({ action: 'follow', taskId: lookup.id!, ref: candidate.ref });
	await idle(service);
	assert.equal(service.getState().subscriptions.length, 1);
	await service.stop();
	store.close();
	const restored = new SubscriptionStore(root, cipher);
	assert.equal(restored.subscriptions().length, 1);
	assert.equal(restored.entries()[0]!.read, true);
	restored.close();
});

test('来源开关实际阻止查询；设置与凭据持久化、原值不出现在快照', async (t) => {
	const root = await directory(t);
	const store = new SubscriptionStore(root, cipher);
	let calls = 0;
	const service = new SubscriptionsService(
		store,
		{
			run: async () => {
				calls++;
				return success;
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await service.command({ action: 'preferences', value: { ...store.preferences(), enabledSources: ['dmm'], theme: 'night' } });
	assert.equal((await service.command({ action: 'lookup', provider: 'fanbox', query: 'testcreator' })).ok, false);
	assert.equal(calls, 0);
	const secret = 'session=subscription-test-private';
	await service.command({ action: 'credential', provider: 'fanbox', cookie: secret });
	assert.equal(store.credential('fanbox'), secret);
	assert.equal(JSON.stringify(service.getState()).includes(secret), false);
	await service.stop();
	store.close();
	assert.equal((await readFile(join(root, 'nectisse.sqlite'))).includes(Buffer.from(secret)), false);
	const restored = new SubscriptionStore(root, cipher);
	assert.equal(restored.preferences().theme, 'night');
	assert.equal(restored.credential('fanbox'), secret);
	restored.close();
});

test('首次检查失败仍保留关注，错误与下次检查可见', async (t) => {
	const store = new SubscriptionStore(await directory(t), cipher);

	const run: Run = async (method) =>
		method === 'follow.lookup' ? { ...success, candidates: [candidate] } : { ...success, status: 'error', reason: 'auth_required', message: '登录过期' };

	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	const lookup = await service.command({ action: 'lookup', provider: 'fanbox', query: candidate.ref });
	await idle(service);
	await service.command({ action: 'follow', taskId: lookup.id!, ref: candidate.ref });
	await idle(service);
	const sub = service.getState().subscriptions[0]!;
	assert.equal(sub.following, true);
	assert.equal(sub.initialized, false);
	assert.equal(sub.lastError, '登录过期');
	assert.ok(sub.nextCheckAt);
	assert.equal(service.getState().entries.length, 0);
	await service.stop();
	store.close();
});

test('取消先落盘，迟到条目不提交；重启及自动调度不会重启该任务', async (t) => {
	const root = await directory(t);
	const store = new SubscriptionStore(root, cipher);
	const sub = store.follow(candidate);
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let durable = '';

	const run: Run = async (_method, _params, options) => {
		await options?.onRequest?.({ source: 'fanbox', host: 'api.fanbox.cc', sequence: 1 });
		started();
		await new Promise<void>((_resolve, reject) => {
			options?.signal?.addEventListener(
				'abort',
				() => {
					durable = store.tasks()[0]!.status;
					options.onProgress?.({ event: 'entry', entry });
					reject(new TaskCancelledError());
				},
				{ once: true },
			);
		});
		return success;
	};

	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	const reply = await service.command({ action: 'check', id: sub.id });
	await ready;
	await service.command({ action: 'cancel', id: reply.id! });
	assert.equal(durable, 'cancelling');
	assert.equal(store.tasks()[0]!.status, 'cancelled');
	assert.equal(store.entries().length, 0);
	assert.equal(store.subscription(sub.id)!.autoPaused, true);
	store.savePreferences({ ...store.preferences(), automatic: true });
	await service.tick();
	assert.equal(store.tasks().length, 1);
	await service.stop();
	store.close();
	const restored = new SubscriptionStore(root, cipher);
	assert.equal(restored.tasks()[0]!.status, 'cancelled');
	assert.equal(restored.subscription(sub.id)!.autoPaused, true);
	restored.close();
});

test('暂停、取消关注保留内容；仅当前筛选条目标已读；来源外原文不能打开', async (t) => {
	const store = new SubscriptionStore(await directory(t), cipher);
	const sub = store.follow(candidate);
	store.upsertEntry(sub, entry);
	store.upsertEntry(sub, { ...entry, externalId: '124', url: 'https://testcreator.fanbox.cc/posts/124' });
	const opened: string[] = [];
	const service = new SubscriptionsService(
		store,
		{ run: runner },
		async () => '',
		async (url) => {
			opened.push(url);
		},
		0,
	);
	await service.command({ action: 'read', ids: [store.entries()[0]!.id], read: true });
	assert.equal(store.entries().filter((entry) => entry.read).length, 1);
	await service.command({ action: 'update', id: sub.id, following: false });
	assert.equal(store.entries().length, 2);
	assert.equal(store.subscription(sub.id)!.following, false);
	await service.command({ action: 'open', kind: 'entry', id: 'https://evil.example/' });
	assert.equal(opened.length, 0);
	await service.command({ action: 'open', kind: 'subscription', id: sub.id });
	assert.deepEqual(opened, [candidate.url]);
	await service.stop();
	store.close();
});

test('安全存储不可用时拒绝保存，代理认证与过短演员频率不被静默接受', async (t) => {
	const store = new SubscriptionStore(await directory(t), { ...cipher, available: () => false });
	const service = new SubscriptionsService(
		store,
		{ run: runner },
		async () => '',
		async () => {},
		0,
	);
	assert.equal((await service.command({ action: 'credential', provider: 'fanbox', cookie: 'test=value' })).ok, false);
	assert.equal(store.credentialPresent('fanbox'), false);
	assert.equal(
		(await service.command({ action: 'preferences', value: { ...store.preferences(), proxyMode: 'custom', proxyUrl: 'http://user:secret@localhost:8080' } })).ok,
		false,
	);
	const sub = store.follow({ ...candidate, provider: 'javdb', ref: 'A123', url: 'https://javdb.com/actors/A123' });
	assert.equal((await service.command({ action: 'update', id: sub.id, intervalMinutes: 60 })).ok, false);
	await service.stop();
	store.close();
});

test('JavDB 演员确认与新作使用独立原生身份，不与同名创作者合并', async (t) => {
	const store = new SubscriptionStore(await directory(t), cipher);
	store.follow(candidate);
	const actor: FollowCandidate = { ...candidate, provider: 'javdb', ref: 'A123', url: 'https://javdb.com/actors/A123', recordType: '有碼' };

	const run: Run = async (method, _params, options) => {
		await options?.onRequest?.({ source: 'javdb', host: 'javdb.com', sequence: 1 });
		if (method === 'follow.lookup') {
			return { ...success, candidates: [actor] };
		}
		options?.onProgress?.({ event: 'entry', entry: { ...entry, externalId: '/v/Work123', url: 'https://javdb.com/v/Work123', title: 'SSIS-057 目录作品', code: 'SSIS-057' } });
		return { ...success, coverage: '初次收录：仅首页', gap: false };
	};

	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	const lookup = await service.command({ action: 'lookup', provider: 'javdb', query: actor.name });
	await idle(service);
	const followed = await service.command({ action: 'follow', taskId: lookup.id!, ref: actor.ref });
	await idle(service);
	assert.equal(followed.ok, true);
	assert.equal(store.subscriptions().length, 2);
	assert.equal(store.entries()[0]!.code, 'SSIS-057');
	assert.equal(store.entries()[0]!.initial, true);
	await service.command({ action: 'check', id: followed.id! });
	await idle(service);
	assert.equal(store.entries().length, 1);
	await service.stop();
	store.close();
});

test('自动检查按到期订阅执行；未开启、暂停和取消意图均不派发', async (t) => {
	const store = new SubscriptionStore(await directory(t), cipher);
	const sub = store.follow(candidate);
	sub.initialized = true;
	sub.nextCheckAt = '2020-01-01T00:00:00Z';
	store.saveSubscription(sub);
	let calls = 0;

	const run: Run = async (...args) => {
		calls++;
		return runner(...args);
	};

	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	await service.tick();
	assert.equal(calls, 0);
	store.savePreferences({ ...store.preferences(), automatic: true });
	await service.tick();
	await idle(service);
	assert.equal(calls, 1);
	assert.ok(Date.parse(store.subscription(sub.id)!.nextCheckAt) > Date.now());
	const paused = store.subscription(sub.id)!;
	paused.autoPaused = true;
	paused.nextCheckAt = '2020-01-01T00:00:00Z';
	store.saveSubscription(paused);
	await service.tick();
	assert.equal(calls, 1);
	await service.stop();
	store.close();
});

test('动态封面遭遇 429 后停止派发剩余图片，正文保留且来源冷却持久化', async (t) => {
	const store = new SubscriptionStore(await directory(t), cipher);
	const sub = store.follow(candidate);
	let images = 0;

	const run: Run = async (method, _params, options) => {
		if (method === 'follow.image') {
			images++;
			return { ...success, status: 'error', reason: 'rate_limited', retryAfter: 120, message: '图床正在限流' };
		}
		for (let index = 1; index <= 3; index++) {
			options?.onProgress?.({
				event: 'entry',
				entry: { ...entry, externalId: String(index), url: `https://testcreator.fanbox.cc/posts/${index}`, thumbnailUrl: `https://pixiv.pximg.net/cover${index}.jpg` },
			});
		}
		return { ...success, coverage: '首页', gap: false };
	};

	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	await service.command({ action: 'check', id: sub.id });
	await idle(service);
	assert.equal(images, 1);
	assert.equal(store.entries().length, 3);
	assert.equal(store.tasks()[0]!.status, 'partial');
	assert.ok(store.source('fanbox').cooldownUntil > Date.now());
	await service.stop();
	store.close();
});

test('演员候选头像随关注保存，本机缓存可读且检查复用；重启保留与淘汰回退', async (t) => {
	const root = await directory(t);
	const store = new SubscriptionStore(root, cipher);
	const actor: FollowCandidate = { ...candidate, provider: 'javdb', ref: 'A123', url: 'https://javdb.com/actors/A123', avatarUrl: 'https://c0.jdbstatic.com/avatars/a/A123.jpg' };
	const bytes = await readFile(new URL('../src/renderer/src/prototype/assets/editorial-sheet.png', import.meta.url));
	const asset = { sha256: createHash('sha256').update(bytes).digest('hex'), width: 128, height: 128, bytes: bytes.length, format: 'PNG', quality: 'small' };
	let images = 0;

	const run: Run = async (method, params, options) => {
		await options?.onRequest?.({ source: 'javdb', host: method === 'follow.image' ? 'c0.jdbstatic.com' : 'javdb.com', sequence: 1 });
		if (method === 'follow.lookup') {
			return { ...success, candidates: [actor] };
		}
		if (method === 'follow.image') {
			images++;
			assert.equal(params?.cookie, undefined);
			await writeFile(String(params?.destination), bytes);
			return { ...success, asset };
		}
		return { ...success, avatarUrl: actor.avatarUrl, coverage: '首页', gap: false };
	};

	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	const lookup = await service.command({ action: 'lookup', provider: 'javdb', query: actor.name });
	await idle(service);
	assert.equal(service.getState().tasks[0]!.candidates[0]!.avatarAsset?.sha256, asset.sha256);
	const followed = await service.command({ action: 'follow', taskId: lookup.id!, ref: actor.ref });
	await idle(service);
	assert.equal(store.subscription(followed.id!)?.avatarAsset?.sha256, asset.sha256);
	assert.equal(images, 1);
	assert.deepEqual((await service.image(asset.sha256))?.bytes, bytes);
	await service.stop();
	store.close();
	const restored = new SubscriptionStore(root, cipher);
	assert.equal(restored.subscription(followed.id!)?.avatarAsset?.sha256, asset.sha256);
	restored.dropImage(actor.avatarUrl!);
	assert.equal(restored.subscription(followed.id!)?.avatarAsset, undefined);
	restored.close();
});

test('旧订阅在检查时补头像；头像限流保留身份和正文并停止后续派发', async (t) => {
	const store = new SubscriptionStore(await directory(t), cipher);
	const sub = store.follow(candidate);
	let images = 0;

	const run: Run = async (method, _params, options) => {
		if (method === 'follow.image') {
			images++;
			return { ...success, status: 'error', reason: 'rate_limited', retryAfter: 120, message: '头像图床限流' };
		}
		options?.onProgress?.({ event: 'entry', entry: { ...entry, thumbnailUrl: 'https://pixiv.pximg.net/cover.jpg' } });
		return { ...success, avatarUrl: 'https://pixiv.pximg.net/avatar.jpg', coverage: '首页' };
	};

	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	await service.command({ action: 'check', id: sub.id });
	await idle(service);
	assert.equal(store.subscription(sub.id)?.avatarUrl, 'https://pixiv.pximg.net/avatar.jpg');
	assert.equal(images, 1);
	assert.equal(store.entries().length, 1);
	assert.equal(store.subscription(sub.id)?.following, true);
	assert.ok(store.source('fanbox').cooldownUntil > Date.now());
	assert.equal(store.tasks()[0]!.status, 'partial');
	await service.stop();
	store.close();
});

test('取消头像下载不提交迟到图片，清理临时文件；非来源头像不派发', async (t) => {
	const root = await directory(t);
	const store = new SubscriptionStore(root, cipher);
	let began!: () => void;
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});

	const run: Run = async (method, params, options) => {
		if (method === 'follow.lookup') {
			return { ...success, candidates: [{ ...candidate, avatarUrl: 'https://pixiv.pximg.net/avatar.jpg' }] };
		}
		began();
		await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
		await writeFile(String(params?.destination), 'late-avatar');
		return { ...success, asset: { sha256: createHash('sha256').update('late-avatar').digest('hex'), width: 128, height: 128, bytes: 11, format: 'PNG', quality: 'small' } };
	};

	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	const lookup = await service.command({ action: 'lookup', provider: 'fanbox', query: candidate.ref });
	await started;
	await service.command({ action: 'cancel', id: lookup.id! });
	assert.equal(store.tasks()[0]!.status, 'cancelled');
	assert.equal(store.images().length, 0);
	assert.equal(store.tasks()[0]!.candidates[0]!.avatarAsset, undefined);
	assert.deepEqual(await readdir(join(root, 'cache/subscription-covers')), []);
	await service.stop();
	let calls = 0;
	const other = new SubscriptionsService(
		store,
		{
			run: async (method) => {
				calls++;
				assert.equal(method, 'follow.lookup');
				return { ...success, candidates: [{ ...candidate, avatarUrl: 'https://evil.example/avatar.jpg' }] };
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await other.command({ action: 'lookup', provider: 'fanbox', query: candidate.ref });
	await idle(other);
	assert.equal(calls, 1);
	await other.stop();
	store.close();
});

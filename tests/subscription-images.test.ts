import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionStore, type Cipher } from '../src/main/features/subscriptions/subscription-store';
import { SubscriptionsService } from '../src/main/features/subscriptions/subscriptions-service';
import { TaskCancelledError, type PythonTaskHost } from '../src/main/platform/python/python-host';
import type { EntryInput, FollowCandidate, Subscription, SubscriptionsState } from '@shared/subscriptions';

const cipher: Cipher = {
	available: () => false,

	encrypt: () => Buffer.alloc(0),

	decrypt: () => '',
};
const candidate: FollowCandidate = {
	provider: 'fanbox',
	ref: 'testcreator',
	name: 'Test',
	url: 'https://testcreator.fanbox.cc',
	aliases: [],
	recordType: '创作者',
	bio: '',
	evidence: '',
};
const success = { status: 'success', reason: '', message: '', requests: 1, retryAfter: 0 };
type Run = PythonTaskHost['run'];
const bytes = Buffer.from('image-fixture');
const asset = { sha256: createHash('sha256').update(bytes).digest('hex'), width: 100, height: 100, bytes: bytes.length, format: 'JPEG' as const, quality: 'small' as const };

const image = (index: number): EntryInput => ({
	externalId: String(index),
	title: `Post ${index}`,
	summary: '正文',
	author: 'Test',
	publishedAt: '',
	publishedPrecision: 'unknown',
	url: `https://testcreator.fanbox.cc/posts/${index}`,
	thumbnailUrl: `https://pixiv.pximg.net/cover${index}.jpg`,
	code: '',
	restricted: false,
	partial: false,
});

async function setup(t: test.TestContext, count = 1): Promise<{ root: string; store: SubscriptionStore; sub: Subscription }> {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-images-test-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SubscriptionStore(root, cipher);
	const sub = store.follow(candidate);
	for (let index = 1; index <= count; index++) {
		store.upsertEntry(sub, image(index));
	}
	return { root, store, sub };
}

async function idle(service: SubscriptionsService): Promise<void> {
	for (let index = 0; index < 1000; index++) {
		if (!service.getState().tasks.some((task) => ['running', 'cancelling'].includes(task.status))) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('Images did not settle');
}

const runImage: Run = async (method, params, options) => {
	assert.equal(method, 'follow.image');
	await options?.onRequest?.({ source: String(params?.provider), host: 'pixiv.pximg.net', sequence: 1 });
	await writeFile(String(params?.destination), bytes);
	return { ...success, asset };
};

test('启动即补齐超过 3 张和 24 张旧封面，不依赖自动检查；重复 URL 只请求一次，重启复用', async (t) => {
	const { root, store, sub } = await setup(t, 30);
	store.upsertEntry(sub, { ...image(31), thumbnailUrl: image(1).thumbnailUrl });
	let requests = 0;

	const run: Run = async (...args) => {
		requests++;
		assert.equal(args[1]?.proxy, 'http://127.0.0.1:7890');
		assert.equal(args[1]?.transport, 'fingerprint');
		return runImage(...args);
	};

	store.savePreferences({ ...store.preferences(), fanboxTransport: 'fingerprint' });
	const service = new SubscriptionsService(
		store,
		{ run },
		async () => 'http://127.0.0.1:7890',
		async () => {},
		0,
	);
	assert.equal(store.preferences().automatic, false);
	await service.tick();
	await idle(service);
	assert.equal(requests, 30);
	assert.equal(store.entries().filter((entry) => entry.imageAsset).length, 31);
	assert.equal(store.tasks()[0]?.requests, 30);
	assert.equal(store.tasks()[0]?.completed, 30);
	assert.deepEqual((await service.image(asset.sha256))?.bytes, bytes);
	await service.stop();
	store.close();
	const restored = new SubscriptionStore(root, cipher);
	const other = new SubscriptionsService(
		restored,
		{
			run: async () => {
				throw new Error('Cached images must not refetch');
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await other.tick();
	await idle(other);
	assert.equal(restored.entries().filter((entry) => entry.imageAsset).length, 31);
	await other.stop();
	restored.close();
});

test('一次真实更新收录后自动继续处理所有封面，不额外检查动态和历史', async (t) => {
	const { store, sub } = await setup(t, 0);
	let checks = 0;
	let images = 0;

	const run: Run = async (...args) => {
		if (args[0] === 'follow.image') {
			images++;
			return runImage(...args);
		}
		checks++;
		assert.equal(args[0], 'follow.check');
		for (let index = 1; index <= 9; index++) {
			args[2]?.onProgress?.({ event: 'entry', entry: image(index) });
		}
		return success;
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
	assert.equal(checks, 1);
	assert.equal(images, 9);
	assert.equal(store.entries().filter((entry) => entry.imageAsset).length, 9);
	await service.stop();
	store.close();
});

test('限流持久化退避，重试成功后继续补齐余项，永久失败不会阻塞下一张', async (t) => {
	const { root, store } = await setup(t, 5);
	let requests = 0;
	const limited = new SubscriptionsService(
		store,
		{
			run: async () => {
				requests++;
				return { ...success, status: 'error', reason: 'rate_limited', retryAfter: 120 };
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await limited.tick();
	await idle(limited);
	assert.equal(requests, 1);
	assert.equal(store.entries()[0]?.imageCache?.status, 'retry');
	await limited.stop();
	store.close();
	const restored = new SubscriptionStore(root, cipher);
	const retried = new SubscriptionsService(
		restored,
		{
			run: async (...args) => {
				requests++;
				if (String(args[1]?.url).endsWith('cover2.jpg')) {
					return { ...success, status: 'error', reason: 'not_found' };
				}
				return runImage(...args);
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await retried.tick();
	assert.equal(requests, 1);
	restored.saveSource('fanbox', { ...restored.source('fanbox'), cooldownUntil: 0 });
	for (const entry of restored.entries()) {
		if (entry.imageCache?.status === 'retry') {
			restored.setImageCache([entry.id], { ...entry.imageCache, nextAttemptAt: 0 });
		}
	}
	await retried.tick();
	await idle(retried);
	assert.equal(requests, 6);
	assert.equal(restored.entries().filter((entry) => entry.imageAsset).length, 4);
	assert.equal(restored.entries().find((entry) => entry.externalId === '2')?.imageCache?.status, 'failed');
	await retried.tick();
	assert.equal(requests, 6);
	await retried.stop();
	restored.close();
});

test('暂时失败最多尝试三次；不会在每轮检查或重启后无限重试', async (t) => {
	const { store } = await setup(t);
	let requests = 0;
	const service = new SubscriptionsService(
		store,
		{
			run: async () => {
				requests++;
				return { ...success, status: 'error', reason: 'network' };
			},
		},
		async () => '',
		async () => {},
		0,
	);
	for (let index = 1; index <= 3; index++) {
		store.saveSource('fanbox', { ...store.source('fanbox'), cooldownUntil: 0 });
		const entry = store.entries()[0]!;
		if (entry.imageCache) {
			store.setImageCache([entry.id], { ...entry.imageCache, nextAttemptAt: 0 });
		}
		await service.tick();
		await idle(service);
	}
	assert.equal(requests, 3);
	assert.equal(store.entries()[0]?.imageCache?.status, 'failed');
	store.saveSource('fanbox', { ...store.source('fanbox'), cooldownUntil: 0 });
	await service.tick();
	assert.equal(requests, 3);
	await service.stop();
	store.close();
});

test('取消先持久化整个有限队列，迟到图片不提交，重启不自动恢复；可明确重试', async (t) => {
	const { root, store } = await setup(t, 6);
	let began!: () => void;
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	let durable = '';
	const service = new SubscriptionsService(
		store,
		{
			run: async (_method, params, options) => {
				began();
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener(
						'abort',
						() => {
							durable = store.tasks()[0]!.status;
							resolve();
						},
						{ once: true },
					),
				);
				await writeFile(String(params?.destination), bytes);
				return { ...success, asset };
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await service.tick();
	await started;
	await service.command({ action: 'cancel', id: store.tasks()[0]!.id });
	assert.equal(durable, 'cancelling');
	assert.equal(store.tasks()[0]!.status, 'cancelled');
	assert.ok(store.entries().every((entry) => entry.imageCache?.status === 'cancelled' && !entry.imageAsset));
	assert.deepEqual(await readdir(join(root, 'cache/subscription-covers')), []);
	await service.stop();
	store.close();
	const restored = new SubscriptionStore(root, cipher);
	let calls = 0;
	const other = new SubscriptionsService(
		restored,
		{
			run: async (...args) => {
				calls++;
				return runImage(...args);
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await other.tick();
	await idle(other);
	assert.equal(calls, 0);
	await other.command({ action: 'retry-images' });
	await idle(other);
	assert.equal(calls, 6);
	assert.equal(restored.entries().filter((entry) => entry.imageAsset).length, 6);
	await other.stop();
	restored.close();
});

test('前台身份查询优先，中断的封面稍后继续，不误记用户取消或耗尽重试预算', async (t) => {
	const { store } = await setup(t, 4);
	let began!: () => void;
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	let blocked = true;
	const methods: string[] = [];

	const run: Run = async (...args) => {
		methods.push(args[0]);
		if (args[0] === 'follow.lookup') {
			return { ...success, candidates: [candidate] };
		}
		if (blocked) {
			blocked = false;
			began();
			await new Promise<void>((_resolve, reject) => args[2]?.signal?.addEventListener('abort', () => reject(new TaskCancelledError()), { once: true }));
		}
		return runImage(...args);
	};

	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	await service.tick();
	await started;
	const lookup = await service.command({ action: 'lookup', provider: 'fanbox', query: 'testcreator' });
	assert.equal(lookup.ok, true);
	await idle(service);
	assert.deepEqual(methods, ['follow.image', 'follow.lookup', 'follow.image', 'follow.image', 'follow.image', 'follow.image']);
	assert.ok(store.entries().every((entry) => entry.imageAsset));
	assert.equal(store.tasks().find((task) => task.reason === 'foreground')?.status, 'interrupted');
	await service.stop();
	store.close();
});

test('退出清理在途任务，普通未完成封面下次启动继续，取消意图独立保留', async (t) => {
	const { root, store } = await setup(t, 2);
	let began!: () => void;
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	const service = new SubscriptionsService(
		store,
		{
			run: async (_method, _params, options) => {
				began();
				await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new TaskCancelledError()), { once: true }));
				return success;
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await service.tick();
	await started;
	await service.stop();
	assert.equal(store.tasks()[0]?.status, 'interrupted');
	assert.ok(store.entries().every((entry) => entry.imageCache?.status === 'queued'));
	store.close();
	const restored = new SubscriptionStore(root, cipher);
	const other = new SubscriptionsService(
		restored,
		{ run: runImage },
		async () => '',
		async () => {},
		0,
	);
	await other.tick();
	await idle(other);
	assert.ok(restored.entries().every((entry) => entry.imageAsset));
	await other.stop();
	restored.close();
});

test('缺失或损坏的缓存自动修复；来源提供新 URL 时不沿用旧封面', async (t) => {
	const { root, store, sub } = await setup(t, 2);
	for (const entry of store.entries()) {
		store.saveImage(entry, asset);
	}
	let requests = 0;
	const service = new SubscriptionsService(
		store,
		{
			run: async (...args) => {
				requests++;
				return runImage(...args);
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await service.tick();
	await idle(service);
	assert.equal(requests, 2);
	await writeFile(join(root, 'cache/subscription-covers', `${asset.sha256}.image`), 'bad-cache');
	assert.equal(await service.image(asset.sha256), undefined);
	await idle(service);
	assert.equal(requests, 4);
	store.upsertEntry(sub, { ...image(1), thumbnailUrl: 'https://pixiv.pximg.net/new.jpg' });
	assert.equal(store.entries().find((entry) => entry.externalId === '1')?.imageAsset, undefined);
	await service.tick();
	await idle(service);
	assert.equal(requests, 5);
	await service.stop();
	store.close();
});

test('来源关闭、订阅暂停、取消检查与不可信 URL 不发图片请求', async (t) => {
	const { store, sub } = await setup(t, 2);
	store.upsertEntry(sub, { ...image(3), thumbnailUrl: 'https://127.0.0.1/private.jpg' });
	const service = new SubscriptionsService(
		store,
		{ run: runImage },
		async () => '',
		async () => {},
		0,
	);
	await service.command({ action: 'preferences', value: { ...store.preferences(), enabledSources: ['dmm'] } });
	await service.tick();
	assert.equal(store.tasks().length, 0);
	await service.command({ action: 'update', id: sub.id, enabled: false });
	await service.command({ action: 'preferences', value: { ...store.preferences(), enabledSources: ['fanbox'] } });
	await service.tick();
	assert.equal(store.tasks().length, 0);
	await service.command({ action: 'update', id: sub.id, enabled: true });
	await idle(service);
	assert.equal(store.entries().filter((entry) => entry.imageAsset).length, 2);
	assert.equal(store.entries().find((entry) => entry.externalId === '3')?.imageCache?.reason, 'unsupported');
	await service.stop();
	store.close();
});

test('最近 500 条的补齐边界固定，不遍历全历史、纯文字条目不请求图片', async (t) => {
	const { store, sub } = await setup(t, 501);
	store.upsertEntry(sub, { ...image(502), thumbnailUrl: '' });
	let requests = 0;
	const service = new SubscriptionsService(
		store,
		{
			run: async (...args) => {
				requests++;
				return runImage(...args);
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await service.tick();
	await idle(service);
	assert.ok(requests <= 500);
	assert.equal(store.db.prepare('SELECT count(*) AS n FROM entries').get()?.n, 502);
	assert.ok(store.entries().every((entry) => entry.imageAsset || !entry.thumbnailUrl));
	await service.stop();
	store.close();
});

test('崩溃在取消落盘与工作者退出之间，重启仍取消整批封面', async (t) => {
	const { root, store, sub } = await setup(t, 3);
	const ids = store.entries().map((entry) => entry.id);

	store.setImageCache(ids, { status: 'queued', attempts: 0, nextAttemptAt: 0, reason: '' });
	store.setImageCache([ids[0]!], { status: 'loading', attempts: 1, nextAttemptAt: 0, reason: '' });
	store.saveTask({
		id: '11111111-1111-4111-8111-111111111111',
		kind: 'covers',
		provider: sub.provider,
		subscriptionId: sub.id,
		imageIds: ids,
		status: 'cancelling',
		startedAt: new Date().toISOString(),
		finishedAt: '',
		requests: 1,
		phase: '',
		candidates: [],
		added: 0,
		reason: '',
		cancelRequestedAt: new Date().toISOString(),
	});
	store.close();
	const restored = new SubscriptionStore(root, cipher);
	const service = new SubscriptionsService(
		restored,
		{
			run: async () => {
				throw new Error('Cancelled batch resumed');
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await service.tick();
	assert.equal(restored.tasks()[0]?.status, 'cancelled');
	assert.ok(restored.entries().every((entry) => entry.imageCache?.status === 'cancelled'));
	assert.equal(restored.subscription(sub.id)?.autoPaused, false);
	await service.stop();
	restored.close();
});

test('缓存按真实文件哈希计量，容量淘汰不会触发自动反复获取', async (t) => {
	const { store, sub } = await setup(t, 0);
	let requests = 0;
	const service = new SubscriptionsService(
		store,
		{
			run: async (...args) => {
				requests++;
				return runImage(...args);
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await service.tick();
	// Pre-existing indexed images simulate capacity pressure without allocating 80 MiB.
	const old = { ...image(99), thumbnailUrl: 'https://pixiv.pximg.net/old.jpg' };
	store.upsertEntry(sub, old);
	const large = { ...asset, bytes: 8 * 1024 * 1024 };
	store.saveImage(store.entries()[0]!, { ...large, sha256: 'a'.repeat(64) });
	for (let index = 0; index < 9; index++) {
		store.cacheImage(`https://pixiv.pximg.net/extra${index}.jpg`, { ...large, sha256: String(index).repeat(64) });
	}
	store.upsertEntry(sub, image(1));
	await service.tick();
	await idle(service);
	assert.equal(requests, 1);
	assert.ok(store.entries().find((entry) => entry.externalId === '99')?.imageAsset, 'Visible image should outlive unreferenced cache');
	// All indexed rows now refer to visible entries, forcing terminal eviction.
	for (let index = 2; index <= 11; index++) {
		store.upsertEntry(sub, image(index));
		store.saveImage(
			store.entries().find((entry) => entry.externalId === String(index))!,
			{ ...large, sha256: String(index - 2).repeat(64) },
		);
	}
	store.upsertEntry(sub, image(12));
	await service.tick();
	await idle(service);
	assert.equal(requests, 2);
	assert.ok(store.entries().some((entry) => entry.imageCache?.status === 'evicted'));
	const cached = store.images().length;
	await service.tick();
	await idle(service);
	assert.equal(requests, 2);
	assert.equal(store.images().length, cached);
	await service.stop();
	store.close();
});

test('本机写入失败停止其余图片，保留正文并报告失败，避免继续无效下载', async (t) => {
	const { store } = await setup(t, 4);
	let requests = 0;
	const service = new SubscriptionsService(
		store,
		{
			run: async () => {
				requests++;
				return { ...success, asset };
			},
		},
		async () => '',
		async () => {},
		0,
	);
	await service.tick();
	await idle(service);
	assert.equal(requests, 1);
	assert.ok(store.entries().every((entry) => entry.imageCache?.status === 'failed' && entry.summary));
	assert.ok(service.getState().notice.includes('缓存'));
	await service.tick();
	assert.equal(requests, 1);
	await service.stop();
	store.close();
});

test('订阅暂停中断图片，明确恢复订阅后继续；不会将暂停当作用户取消整批', async (t) => {
	const { store, sub } = await setup(t, 3);
	let began!: () => void;
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	let first = true;

	const run: Run = async (...args) => {
		if (first) {
			first = false;
			began();
			await new Promise<void>((_resolve, reject) => args[2]?.signal?.addEventListener('abort', () => reject(new TaskCancelledError()), { once: true }));
		}
		return runImage(...args);
	};

	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
	);
	await service.tick();
	await started;
	await service.command({ action: 'update', id: sub.id, enabled: false });
	assert.ok(store.entries().every((entry) => entry.imageCache?.status === 'queued'));
	assert.equal(store.tasks()[0]?.reason, 'subscription_paused');
	await service.tick();
	assert.equal(store.tasks().length, 1);
	await service.command({ action: 'update', id: sub.id, enabled: true });
	await idle(service);
	assert.ok(store.entries().every((entry) => entry.imageAsset));
	await service.stop();
	store.close();
});

test('图片解析代理期间取消，取消意图先落盘且不再创建图片工作者', async (t) => {
	const { store } = await setup(t, 2);
	let release!: () => void;
	let entered!: () => void;
	const proxyReady = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const proxyWait = new Promise<void>((resolve) => {
		release = resolve;
	});
	let workers = 0;
	const service = new SubscriptionsService(
		store,
		{
			run: async (...args) => {
				workers++;
				return runImage(...args);
			},
		},
		async () => {
			entered();
			await proxyWait;
			return '';
		},
		async () => {},
		0,
	);
	try {
		await service.tick();
		await proxyReady;
		const id = store.tasks()[0]!.id;
		const persisted = new Promise<void>((resolve) => {
			service.on('state', (state: SubscriptionsState) => {
				if (state.tasks.some((task) => task.id === id && task.status === 'cancelling')) {
					resolve();
				}
			});
		});
		const cancellation = service.command({ action: 'cancel', id });
		await persisted;
		assert.ok(store.tasks()[0]!.cancelRequestedAt);
		release();
		assert.equal((await cancellation).ok, true);
		assert.equal(workers, 0);
		assert.equal(store.tasks()[0]!.status, 'cancelled');
		assert.ok(store.entries().every((entry) => entry.imageCache?.status === 'cancelled' && !entry.imageAsset));
	} finally {
		release();
		await service.stop();
		store.close();
	}
});

test('查询头像与动态封面共用已验证图片，后续补齐不重复创建工作者', async (t) => {
	const { store } = await setup(t);
	const methods: string[] = [];
	const service = new SubscriptionsService(
		store,
		{
			run: async (...args) => {
				methods.push(args[0]);
				if (args[0] === 'follow.lookup') {
					return { ...success, candidates: [{ ...candidate, url: 'https://testcreator.fanbox.cc/', avatarUrl: image(1).thumbnailUrl }] };
				}
				return runImage(...args);
			},
		},
		async () => '',
		async () => {},
		0,
	);
	try {
		const reply = await service.command({ action: 'lookup', provider: 'fanbox', query: 'testcreator' });
		assert.equal(reply.ok, true);
		await idle(service);
		assert.deepEqual(methods, ['follow.lookup', 'follow.image']);
		assert.equal(store.tasks().find((task) => task.id === reply.id)?.candidates[0]?.avatarAsset?.sha256, asset.sha256);
		assert.equal(store.entries()[0]?.imageAsset?.sha256, asset.sha256);
		assert.equal(store.tasks().find((task) => task.kind === 'covers')?.requests, 0);
	} finally {
		await service.stop();
		store.close();
	}
});

test('到期订阅检查优先于旧封面，检查完成后串行补齐且仅有一个工作者', async (t) => {
	const { store, sub } = await setup(t);
	store.saveSubscription({ ...sub, nextCheckAt: new Date(0).toISOString() });
	store.savePreferences({ ...store.preferences(), automatic: true });
	const methods: string[] = [];
	let active = 0;
	let peak = 0;
	const service = new SubscriptionsService(
		store,
		{
			run: async (...args) => {
				methods.push(args[0]);
				peak = Math.max(peak, ++active);
				try {
					if (args[0] === 'follow.check') {
						await args[2]?.onRequest?.({ source: 'fanbox', host: 'api.fanbox.cc', sequence: 1 });
						return { ...success, coverage: '已覆盖到上次记录', gap: false };
					}
					return await runImage(...args);
				} finally {
					active--;
				}
			},
		},
		async () => '',
		async () => {},
		0,
	);
	try {
		await service.tick();
		await idle(service);
		assert.deepEqual(methods, ['follow.check', 'follow.image']);
		assert.equal(peak, 1);
		assert.equal(store.entries()[0]?.imageAsset?.sha256, asset.sha256);
		assert.ok(store.subscription(sub.id)?.lastCheckedAt);
	} finally {
		await service.stop();
		store.close();
	}
});

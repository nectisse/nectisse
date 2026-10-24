import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_PREFERENCES, type SubscriptionsState } from '@shared/subscriptions';
import { SUBSCRIPTION_READ } from '@shared/subscription-read';
import { SubscriptionStateReader } from '../src/renderer/src/state/subscription-reader';
import { readSubscriptionState, recordSubscriptionReadFailure } from '../src/main/subscription-read';
import { SubscriptionStore } from '../src/main/subscription-store';
import { SubscriptionsService } from '../src/main/subscriptions-service';

const state = (revision = 1): SubscriptionsState => ({
	revision,
	preferences: structuredClone(DEFAULT_PREFERENCES),
	subscriptions: [],
	entries: [],
	tasks: [],
	sources: [],
	encryptionAvailable: false,
	notice: '',
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness(getState: () => Promise<SubscriptionsState>, timeoutMs = 100) {
	let push: (state: SubscriptionsState) => void = () => {};

	let unsubscribed = false;
	const data: SubscriptionsState[] = [];
	const errors: string[] = [];
	const reading: boolean[] = [];
	const reader = new SubscriptionStateReader(
		{
			getState,

			onState: (callback) => {
				push = callback;
				return () => {
					unsubscribed = true;
				};
			},
		},
		{
			state: (value) => data.push(value),

			error: (value) => errors.push(value),

			reading: (value) => reading.push(value),
		},
		{ delays: [0, 0], timeoutMs },
	);
	return {
		reader,
		data,
		errors,
		reading,
		push: (value: SubscriptionsState) => push(value),

		unsubscribed: () => unsubscribed,
	};
}

test('首次读取临时失败自动重试成功，不残留存储错误，不重置既有资料', async () => {
	let calls = 0;
	const h = harness(async () => {
		if (++calls === 1) {
			throw new Error(SUBSCRIPTION_READ.unavailable);
		}
		return state();
	});

	await h.reader.refresh();
	assert.equal(calls, 2);
	assert.equal(h.data.length, 1);
	assert.equal(h.errors.at(-1), '');
	assert.ok(h.errors.every((value) => !value));
	assert.deepEqual(h.reading, [true, false]);
	h.reader.dispose();
});

test('连续失败有重试上限，明确重新读取后恢复', async () => {
	let fail = true;
	let calls = 0;
	const h = harness(async () => {
		calls++;
		if (fail) {
			throw new Error(SUBSCRIPTION_READ.storage);
		}
		return state();
	});

	await h.reader.refresh();
	assert.equal(calls, 3);
	assert.ok(h.errors.at(-1)?.includes('权限'));
	assert.equal(h.reading.at(-1), false);
	fail = false;
	await h.reader.refresh();
	assert.equal(calls, 4);
	assert.equal(h.errors.at(-1), '');
	assert.equal(h.data.length, 1);
	h.reader.dispose();
});

test('新的推送成功先到，较早读取的迟到失败不能覆盖成功状态或继续重试', async () => {
	let reject!: (error: Error) => void;
	let calls = 0;
	const h = harness(() => {
		calls++;
		return new Promise((_resolve, rejectRead) => {
			reject = rejectRead;
		});
	});
	const loading = h.reader.refresh();
	await tick();
	h.push(state(9));
	reject(new Error(SUBSCRIPTION_READ.unavailable));
	await loading;
	await tick();
	assert.equal(calls, 1);
	assert.equal(h.data.at(-1)?.revision, 9);
	assert.equal(h.errors.at(-1), '');
	assert.equal(h.reading.at(-1), false);
	h.reader.dispose();
});

test('并行重新读取丢弃旧响应，较旧推送不会覆盖当前资料', async () => {
	let resolve!: (value: SubscriptionsState) => void;
	let calls = 0;
	const h = harness(() =>
		++calls === 1
			? new Promise((done) => {
					resolve = done;
				})
			: Promise.resolve(state(10)),
	);
	const old = h.reader.refresh();
	await tick();
	await h.reader.refresh();
	resolve(state(1));
	await old;
	h.push(state(2));
	assert.equal(h.data.length, 1);
	assert.equal(h.data[0]?.revision, 10);
	h.reader.dispose();
});

test('关闭页面取消等待和重试，清理监听器，不向已卸载页面提交错误', async () => {
	let calls = 0;
	const h = harness(() => {
		calls++;
		return new Promise(() => {});
	});
	const loading = h.reader.refresh();
	await tick();
	h.reader.dispose();
	await loading;
	h.push(state());
	assert.equal(calls, 1);
	assert.equal(h.unsubscribed(), true);
	assert.equal(h.data.length, 0);
	assert.ok(h.errors.every((value) => !value));
});

test('立即卸载不会继续派发尚未发出的读取', async () => {
	let calls = 0;
	const h = harness(async () => {
		calls++;
		return state();
	});
	const loading = h.reader.refresh();
	h.reader.dispose();
	await loading;
	assert.equal(calls, 0);
});

test('手动重新检查走服务恢复接口，常规读取与后续尝试保持有限预算', async () => {
	let reads = 0;
	let recoveries = 0;
	let healthy = false;
	const reader = new SubscriptionStateReader(
		{
			getState: async () => {
				reads++;
				if (!healthy) {
					throw new Error(SUBSCRIPTION_READ.unavailable);
				}
				return state();
			},

			retry: async () => {
				recoveries++;
				healthy = true;
				return state();
			},

			onState: () => () => {},
		},
		{
			state: () => {},

			error: () => {},

			reading: () => {},
		},
		{ delays: [0, 0], timeoutMs: 100 },
	);
	await reader.refresh();
	assert.equal(reads, 3);
	assert.equal(recoveries, 0);
	await reader.refresh(true);
	assert.equal(recoveries, 1);
	assert.equal(reads, 3);
	await reader.refresh();
	assert.equal(reads, 4);
	assert.equal(recoveries, 1);
	reader.dispose();
});

test('挂起的读取有超时和预算，超时后可再次读取', async () => {
	let hang = true;
	const h = harness(() => (hang ? new Promise(() => {}) : Promise.resolve(state())), 10);

	await h.reader.refresh();
	assert.ok(h.errors.at(-1)?.includes('超时'));
	assert.equal(h.reading.at(-1), false);
	hang = false;
	await h.reader.refresh();
	assert.equal(h.data.length, 1);
	assert.equal(h.errors.at(-1), '');
	h.reader.dispose();
});

test('状态格式、存储权限及通信错误分别归类；原始数据与敏感值不进入错误或诊断', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-read-diagnostics-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const secret = 'session=private-fixture-do-not-log';

	const report = (code: Parameters<typeof recordSubscriptionReadFailure>[1]): void => recordSubscriptionReadFailure(root, code);

	assert.throws(() => readSubscriptionState(() => ({ ...state(), preferences: { proxyUrl: secret } }), report), { message: SUBSCRIPTION_READ.invalid });
	assert.throws(
		() =>
			readSubscriptionState(() => {
				throw Object.assign(new Error(secret), { code: 'EACCES' });
			}, report),
		{ message: SUBSCRIPTION_READ.storage },
	);
	assert.throws(
		() =>
			readSubscriptionState(() => {
				throw new Error(secret);
			}, report),
		{ message: SUBSCRIPTION_READ.unavailable },
	);
	assert.deepEqual(
		readSubscriptionState(() => state(), report),
		state(),
	);
	const path = join(root, 'diagnostics/subscription-read.jsonl');
	assert.equal((await readFile(path, 'utf8')).includes(secret), false);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	for (let index = 0; index < 40; index++) {
		report(SUBSCRIPTION_READ.unavailable);
	}
	assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 32);
});

test('服务快照失败保留具体读取阶段，未知异常不能只留下笼统的未响应', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-read-stage-'));
	const store = new SubscriptionStore(root, {
		available: () => false,

		encrypt: () => Buffer.alloc(0),

		decrypt: () => '',
	});
	const service = new SubscriptionsService(
		store,
		{
			run: async () => {
				throw new Error('Unexpected worker');
			},
		},
		async () => '',
		async () => {},
	);
	t.after(async () => {
		await service.stop();
		store.close();
		await rm(root, { recursive: true, force: true });
	});
	const original = store.source.bind(store);
	let reported: unknown;
	store.source = () => {
		throw new TypeError('cookie=sensitive-fixture; do not log');
	};
	assert.throws(
		() =>
			readSubscriptionState(
				() => service.getState(),
				(...failure) => {
					reported = failure;
				},
			),
		{ message: SUBSCRIPTION_READ.unavailable },
	);
	assert.deepEqual(reported, [SUBSCRIPTION_READ.unavailable, { stage: 'sources', kind: 'type_error' }]);
	store.source = original;
	let warning: unknown;
	service.on('secure-storage-error', (context) => {
		warning = context;
	});
	store.cipher.available = () => {
		throw new Error('sensitive-system-error');
	};

	const readable = readSubscriptionState(
		() => service.getState(),
		() => {
			assert.fail('安全存储探测不能阻断本地资料读取');
		},
	);

	assert.equal(readable.encryptionAvailable, false);
	assert.ok(readable.notice.includes('系统安全存储'));
	assert.deepEqual(warning, { stage: 'secure_storage', kind: 'service_error' });
	assert.throws(() => store.saveCredential('fanbox', 'synthetic-private-cookie'), { message: '系统安全存储暂不可用，未保存 Cookie' });
	assert.equal(store.credentialPresent('fanbox'), false);
	store.cipher.available = () => false;
	assert.equal(
		readSubscriptionState(
			() => service.getState(),
			() => {},
		).subscriptions.length,
		0,
	);
});

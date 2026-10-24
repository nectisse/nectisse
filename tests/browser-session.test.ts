import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { PythonTaskHost, PythonWorkerError, TaskCancelledError } from '../src/main/python-host';
import { pythonLayout } from '../src/main/python-layout';
import { preferencesSchema, DEFAULT_PREFERENCES } from '@shared/subscriptions';
import { sourceTransport } from '../src/main/source-policy';
import { planQuery } from '../src/main/metadata-input';

const root = fileURLToPath(new URL('..', import.meta.url));
const params = { source: 'fc2ppvdb', transport: 'browser', code: 'FC2-PPV-4898837', proxy: 'invalid://proxy' };

test('FC2PPV-DB 默认使用浏览器会话，只有此来源可保存 browser 设置', () => {
	assert.equal(sourceTransport('fc2ppvdb', DEFAULT_PREFERENCES), 'browser');
	assert.equal(sourceTransport('fc2ppvdb', { ...DEFAULT_PREFERENCES, sourceTransports: { fc2ppvdb: 'httpx' } }), 'httpx');
	assert.ok(preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, sourceTransports: { fc2ppvdb: 'browser' } }).success);
	assert.equal(preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, sourceTransports: { javdb: 'browser' } }).success, false);
});

test('FC2PPV-DB 原站链接规范化为精确商品号，仅派发到对应来源', () => {
	const plan = planQuery({ query: 'https://fc2ppv-db.com/ja/videos/4898837?tracking=discard', sources: ['fc2', 'fc2ppvdb'], force: true });
	assert.equal(plan.code, 'FC2-PPV-4898837');
	assert.equal(plan.query, plan.code);
	assert.deepEqual(plan.sources, ['fc2ppvdb']);
	assert.throws(() => planQuery({ query: 'https://fc2ppv-db.com/ja/actresses/somebody', sources: ['fc2ppvdb'], force: true }));
});

test('串行请求复用一个会话工作者；失败不破坏后续调用；退出回收进程', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'nectisse-session-test-'));
	const host = new PythonTaskHost(pythonLayout(root, false), { browserProfile: directory });
	const pids: number[] = [];
	try {
		const options = { onReady: (pid: number) => pids.push(pid) };
		const outcomes = await Promise.all([host.run('metadata.query', params, options), host.run('metadata.query', params, options)]);
		assert.ok(outcomes.every((outcome: any) => outcome.reason === 'network' && outcome.requests === 0));
		assert.equal(pids.length, 2);
		assert.equal(pids[0], pids[1]);
		assert.deepEqual(host.activePids, [pids[0]]);
		await host.shutdown();
		assert.throws(() => process.kill(pids[0]!, 0), { code: 'ESRCH' });
		assert.deepEqual(host.activePids, []);
		await assert.rejects(host.run('metadata.query', params), TaskCancelledError);
	} finally {
		await host.shutdown();
		await rm(directory, { recursive: true, force: true });
	}
});

test('会话取消和超时真正终止工作者；取消后的新查询能够重启', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'nectisse-session-cancel-'));
	const host = new PythonTaskHost(pythonLayout(root, false), { browserProfile: directory, diagnostics: true });
	let oldPid = 0;
	try {
		const controller = new AbortController();
		await assert.rejects(
			host.run(
				'metadata.query',
				{ ...params, diagnosticWait: 60 },
				{
					signal: controller.signal,
					onReady: (pid) => {
						oldPid = pid;
						controller.abort();
					},
				},
			),
			TaskCancelledError,
		);
		assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
		await assert.rejects(
			host.run('metadata.query', { ...params, diagnosticWait: 60 }, { timeoutMs: 300 }),
			(error: unknown) => error instanceof PythonWorkerError && error.code === 'WORKER_TIMEOUT',
		);
		const outcome: any = await host.run('metadata.query', params, { onReady: (pid) => assert.notEqual(pid, oldPid) });
		assert.equal(outcome.reason, 'network');
	} finally {
		await host.shutdown();
		await rm(directory, { recursive: true, force: true });
	}
});

test('Electron 宿主意外退出时，会话工作者自行回收', { skip: process.platform === 'win32' }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'nectisse-session-parent-'));
	const parent = fork(join(root, 'tests/fixtures/browser-parent.mjs'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
	let worker = 0;
	try {
		worker = await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Session fixture did not start')), 10_000);
			parent.once('error', reject);
			parent.once('message', (message: any) => {
				clearTimeout(timer);
				resolve(message.worker);
			});
		});
		parent.kill('SIGKILL');
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				process.kill(worker, 0);
			} catch {
				break;
			}
			await delay(50);
		}
		assert.throws(() => process.kill(worker, 0), { code: 'ESRCH' });
	} finally {
		parent.kill('SIGKILL');
		if (worker) {
			try {
				process.kill(-worker, 'SIGKILL');
			} catch {
				/* Already gone. */
			}
		}
		await rm(directory, { recursive: true, force: true });
	}
});

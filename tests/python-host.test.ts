import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PythonTaskHost, PythonWorkerError, TaskCancelledError } from '../src/main/platform/python/python-host';
import { pythonLayout } from '../src/main/platform/python/python-layout';
import { RuntimeService } from '../src/main/platform/python/runtime';
import { healthSchema } from '@shared/protocol';

const root = fileURLToPath(new URL('..', import.meta.url));
const layout = pythonLayout(root, false);

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function assertGone(pids: number[]): Promise<void> {
	assert.ok(pids.length > 0 && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0), 'Expected actual positive process IDs');
	for (let attempt = 0; attempt < 100; attempt++) {
		if (pids.every((pid) => !alive(pid))) {
			return;
		}
		await delay(50);
	}
	assert.fail(`Owned processes still exist: ${pids.filter(alive).join(', ')}`);
}

test('随包 Python 在无宿主环境变量下加载 Peach 和原生依赖', async () => {
	const host = new PythonTaskHost(layout);
	try {
		const health = healthSchema.parse(await host.run('health'));
		assert.equal(health.pythonVersion, '3.14.9');
		assert.equal(health.identityProbe, 'FC2-PPV-1234567');
		assert.ok(health.executable.startsWith(join(root, '.build/python/')));
		const source = await readFile(join(root, 'python/vendor/peach_core/http.py'));
		assert.equal(health.transportSha256, createHash('sha256').update(source).digest('hex'));
		assert.equal(host.activePids.length, 0);
		await assertGone([health.pid]);
	} finally {
		await host.shutdown();
	}
});

test('真正取消：等待任务结束进程；已取消的 signal 不创建进程', async () => {
	const host = new PythonTaskHost(layout, { diagnostics: true });
	const controller = new AbortController();
	let pid = 0;
	try {
		const task = host.run(
			'diagnostics.wait',
			{ seconds: 60 },
			{
				signal: controller.signal,

				onReady: (processId) => {
					pid = processId;
					controller.abort();
				},
			},
		);
		await assert.rejects(task, TaskCancelledError);
		await assertGone([pid]);
		await assert.rejects(host.run('health', {}, { signal: controller.signal }), TaskCancelledError);
		assert.deepEqual(host.activePids, []);
	} finally {
		await host.shutdown();
	}
});

test('阻塞操作取消时清理工作者及其子进程', async () => {
	const host = new PythonTaskHost(layout, { diagnostics: true, graceMs: 50 });
	const controller = new AbortController();
	let worker = 0;
	let child = 0;
	try {
		await assert.rejects(
			host.run(
				'diagnostics.block',
				{},
				{
					signal: controller.signal,

					onReady: (pid) => {
						worker = pid;
					},

					onProgress: (payload) => {
						child = Number(payload.childPid);
						controller.abort();
					},
				},
			),
			TaskCancelledError,
		);
		assert.ok(worker > 0 && child > 0);
		await assertGone([worker, child]);
	} finally {
		await host.shutdown();
	}
});

test('握手前超时也会结束实际创建的 Python 进程', async (t) => {
	const temporary = await mkdtemp(join(tmpdir(), 'nectisse-before-ready-test-'));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const bootstrap = join(temporary, 'before-ready.py');
	await writeFile(bootstrap, 'import time\ntime.sleep(60)\n');
	const host = new PythonTaskHost({ ...layout, bootstrap }, { graceMs: 50 });
	let ready = false;
	try {
		const task = host.run(
			'health',
			{},
			{
				timeoutMs: 50,

				onReady: () => {
					ready = true;
				},
			},
		);
		const pids = host.activePids;
		await assert.rejects(task, (error) => error instanceof PythonWorkerError && error.code === 'WORKER_TIMEOUT');
		assert.equal(ready, false);
		await assertGone(pids);
		assert.deepEqual(host.activePids, []);
	} finally {
		await host.shutdown();
	}
});

test('超时结束实际创建的 Python 进程', async () => {
	const host = new PythonTaskHost(layout, { diagnostics: true, graceMs: 50 });
	try {
		const task = host.run('diagnostics.wait', { seconds: 60 }, { timeoutMs: 300 });
		const pids = host.activePids;
		await assert.rejects(task, (error) => error instanceof PythonWorkerError && error.code === 'WORKER_TIMEOUT');
		await assertGone(pids);
		assert.deepEqual(host.activePids, []);
	} finally {
		await host.shutdown();
	}
});

test('握手后 shutdown 取消活动任务、结束进程并禁止新请求', async () => {
	const host = new PythonTaskHost(layout, { diagnostics: true, graceMs: 50 });
	try {
		let shutdown: Promise<void> | undefined;
		const task = host.run(
			'diagnostics.wait',
			{ seconds: 60 },
			{
				onReady: () => {
					shutdown = host.shutdown();
				},
			},
		);
		const pids = host.activePids;
		await assert.rejects(task, TaskCancelledError);
		assert.ok(shutdown, 'Expected shutdown after the worker handshake');
		await shutdown;
		await assertGone(pids);
		await assert.rejects(host.run('health'), TaskCancelledError);
		assert.deepEqual(host.activePids, []);
	} finally {
		await host.shutdown();
	}
});

test('未授权诊断方法及缺失运行时返回结构化错误', async () => {
	const host = new PythonTaskHost(layout);
	const missing = new PythonTaskHost({ ...layout, executable: '/nonexistent/nectisse/python3' });
	try {
		await assert.rejects(host.run('diagnostics.block'), (error) => error instanceof PythonWorkerError && error.code === 'UNSUPPORTED_METHOD');
		await assert.rejects(missing.run('health'), (error) => error instanceof PythonWorkerError && error.code === 'START_FAILED');
	} finally {
		await host.shutdown();
		await missing.shutdown();
	}
});

test('环境检查去重；缺失环境可报告错误，退出后不再启动', async () => {
	const runtime = new RuntimeService(layout);
	const temporary = await mkdtemp(join(tmpdir(), 'nectisse-runtime-test-'));
	const missing = new RuntimeService(pythonLayout(temporary, false));
	try {
		const first = runtime.start();
		assert.equal(first, runtime.start());
		assert.equal((await first).phase, 'ready');
		assert.equal((await missing.start()).phase, 'error');
		await runtime.stop();
		assert.equal((await runtime.start()).phase, 'stopped');
	} finally {
		await runtime.stop();
		await missing.stop();
		await rm(temporary, { recursive: true });
	}
});

test('宿主被强制终止后，Python 自行清理进程组', { skip: process.platform === 'win32' }, async () => {
	const parent = fork(join(root, 'tests/fixtures/worker-parent.mjs'), [], {
		execArgv: ['--import', 'tsx'],
		stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
	});
	let worker = 0;
	try {
		const owned = await new Promise<{ worker: number; child: number }>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Fixture did not start')), 10_000);

			parent.once('error', reject);
			parent.once('message', (message) => {
				clearTimeout(timer);
				resolve(message as { worker: number; child: number });
			});
		});
		worker = owned.worker;
		parent.kill('SIGKILL');
		await assertGone([owned.worker, owned.child]);
	} finally {
		parent.kill('SIGKILL');
		if (worker && alive(worker)) {
			try {
				process.kill(-worker, 'SIGKILL');
			} catch {
				/* already gone */
			}
		}
	}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { InitializationStep } from '../src/main/initialization-step';

test('初始化失败不会毒化显式恢复；并发重试只重新初始化一次，健康服务不重建', async () => {
	let calls = 0;
	const step = new InitializationStep(() => {
		if (++calls === 1) {
			throw new Error('temporary-startup-failure');
		}
	});
	await assert.rejects(step.run());
	await assert.rejects(step.run());
	assert.equal(calls, 1);
	await Promise.all([step.retry(), step.retry(), step.run()]);
	assert.equal(calls, 2);
	await step.retry();
	assert.equal(calls, 2);
	await step.close();
	await assert.rejects(step.retry(), { message: 'APP_STOPPING' });
	assert.equal(calls, 2);
});

test('退出等待在途初始化完成，不再派发新的初始化，也不会有未处理拒绝', async () => {
	let finish!: () => void;
	let calls = 0;
	const step = new InitializationStep(() => {
		calls++;
		return new Promise<void>((resolve) => {
			finish = resolve;
		});
	});
	const pending = step.run();
	await Promise.resolve();
	let closed = false;
	const closing = step.close().then(() => {
		closed = true;
	});

	await assert.rejects(step.run(), { message: 'APP_STOPPING' });
	assert.equal(closed, false);
	finish();
	await pending;
	await closing;
	assert.equal(closed, true);
	assert.equal(calls, 1);
});

test('窗口尚未发出初始化时退出，不会在之后创建资源', async () => {
	let calls = 0;
	const step = new InitializationStep(() => {
		calls++;
	});
	const pending = step.run();
	const closing = step.close();
	await assert.rejects(pending, { message: 'APP_STOPPING' });
	await closing;
	assert.equal(calls, 0);
});

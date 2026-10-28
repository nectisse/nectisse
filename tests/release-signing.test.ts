import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseCommand } from '../scripts/release-signing.mjs';

test('签名只重试 Apple 时间戳暂时不可用的错误，保留签名参数', async () => {
	const args = ['--sign', 'fixture', '--timestamp', 'fixture.app'];
	const delays: number[] = [];
	let attempts = 0;
	const result = await releaseCommand(
		'/usr/bin/codesign',
		args,
		{},
		{
			run: async (tool: string, actual: string[]) => {
				assert.equal(tool, '/usr/bin/codesign');
				assert.deepEqual(actual, args);
				attempts++;
				if (attempts < 3) {
					throw Object.assign(new Error('private output'), { code: 1, stderr: 'The timestamp service is not available.' });
				}
				return { stdout: 'signed', stderr: '' };
			},
			wait: async (milliseconds: number) => {
				delays.push(milliseconds);
			},
		},
	);
	assert.equal(result.stdout, 'signed');
	assert.equal(attempts, 3);
	assert.deepEqual(delays, [3000, 6000]);
});

test('签名重试次数有限，其他失败立即终止且不泄露原始输出', async () => {
	for (const [tool, args, stderr, expectedAttempts] of [
		['/usr/bin/codesign', ['--timestamp'], 'The timestamp service is not available.', 5],
		['/usr/bin/codesign', ['--timestamp'], 'private key is unavailable', 1],
		['/usr/bin/codesign', [], 'The timestamp service is not available.', 1],
		['/usr/bin/xcrun', ['--timestamp'], 'The timestamp service is not available.', 1],
	] as const) {
		let attempts = 0;
		await assert.rejects(
			releaseCommand(
				tool,
				[...args],
				{},
				{
					run: async () => {
						attempts++;
						throw Object.assign(new Error('secret'), { code: 1, stderr: `${stderr}\nsecret` });
					},
					wait: async () => {},
				},
			),
			(error: Error & { exitCode?: number }) => {
				assert.equal(error.exitCode, 1);
				assert.ok(!error.message.includes('secret'));
				return true;
			},
		);
		assert.equal(attempts, expectedAttempts);
	}
});

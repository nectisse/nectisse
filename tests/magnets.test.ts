import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MagnetService } from '../src/main/magnet-service';
import type { PythonTaskHost } from '../src/main/python-host';
import { TaskCancelledError } from '../src/main/python-host';
import { DEFAULT_MAGNET_SETTINGS, magnetResultSchema, type MagnetSettings } from '@shared/magnets';
import { DEFAULT_PREFERENCES, preferencesSchema } from '@shared/subscriptions';

const row = {
	id: 'a'.repeat(40),
	title: 'TIKB-220 示例',
	magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
	url: 'https://sukebei.nyaa.si/view/1',
	size: '3.0 GiB',
	uploadedAt: null,
	seeders: 0,
	leechers: 0,
	completed: 0,
};
const ready = { status: 'ready', items: [row], message: '', requests: 1 };
const runner = (run: PythonTaskHost['run']): Pick<PythonTaskHost, 'run'> => ({ run });

test('旧设置自动补齐磁链默认配置，配置限制在已支持的选项内', () => {
	const { magnetSearch: _old, ...legacy } = DEFAULT_PREFERENCES;
	assert.deepEqual(preferencesSchema.parse(legacy).magnetSearch, DEFAULT_MAGNET_SETTINGS);
	for (const invalid of [
		{ ...DEFAULT_MAGNET_SETTINGS, maxResults: 100 },
		{ ...DEFAULT_MAGNET_SETTINGS, transport: 'browser' },
	]) {
		assert.equal(preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, magnetSearch: invalid }).success, false);
	}
});

test('关闭磁链搜索不读缓存、不解析代理也不启动工作者；重新启用可正常查询', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnets-disabled-'));
	let settings = { ...DEFAULT_MAGNET_SETTINGS, enabled: false };
	let calls = 0;
	let routes = 0;
	const service = new MagnetService(
		root,
		runner(async () => {
			calls++;
			return ready;
		}),
		async () => {
			routes++;
			return '';
		},
		0,
		() => settings,
	);
	try {
		assert.equal((await service.search('disabled', 'TIKB-220', true)).reason, 'disabled');
		assert.equal(calls, 0);
		assert.equal(routes, 0);
		settings = { ...settings, enabled: true };
		assert.equal((await service.search('enabled', 'TIKB-220')).status, 'ready');
		settings.enabled = false;
		assert.equal(await service.row('TIKB-220', row.id), undefined);
	} finally {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('条数与传输传给工作者；缩小上限复用完整缓存，扩大不足的缓存重新查询', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnets-settings-'));
	let settings: MagnetSettings = { ...DEFAULT_MAGNET_SETTINGS };
	let calls = 0;
	const service = new MagnetService(
		root,
		runner(async (_method, params) => {
			calls++;
			assert.equal(params?.maxResults, settings.maxResults);
			assert.equal(params?.transport, settings.transport);
			const items = Array.from({ length: settings.maxResults }, (_, index) => {
				const id = index.toString(16).padStart(40, '0');
				return { ...row, id, magnet: `magnet:?xt=urn:btih:${id}` };
			});
			return { ...ready, items };
		}),
		async () => '',
		0,
		() => settings,
	);
	try {
		assert.equal((await service.search('all', 'TIKB-220')).items.length, 20);
		settings = { ...settings, maxResults: 5 };
		const small = await service.search('small', 'TIKB-220');
		assert.equal(small.items.length, 5);
		assert.equal(small.limit, 5);
		small.items[0]!.title = 'must not mutate cache';
		assert.notEqual((await service.search('safe-copy', 'TIKB-220')).items[0]!.title, small.items[0]!.title);
		assert.equal(calls, 1);
		assert.equal((await service.search('limited', 'TIKB-221')).items.length, 5);
		settings = { ...settings, maxResults: 20, transport: 'fingerprint' };
		assert.equal((await service.search('expanded', 'TIKB-221')).items.length, 20);
		assert.equal(calls, 3);
	} finally {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('修改磁链配置终止在途请求；取消终态在恢复设置和重启后均不自动派发', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnets-settings-cancel-'));
	let settings = { ...DEFAULT_MAGNET_SETTINGS };
	let started!: () => void;
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	let calls = 0;
	const host = runner(async (_method, _params, options) => {
		calls++;
		started();
		await new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new TaskCancelledError()), { once: true }));
		return ready;
	});
	const service = new MagnetService(
		root,
		host,
		async () => '',
		0,
		() => settings,
	);
	try {
		const pending = service.search('running', 'TIKB-220');
		await running;
		settings = { ...settings, enabled: false };
		await service.settingsChanged();
		assert.equal((await pending).status, 'cancelled');
		await service.stop();
		settings = { ...settings, enabled: true };
		const reopened = new MagnetService(
			root,
			host,
			async () => '',
			0,
			() => settings,
		);
		assert.equal((await reopened.search('again', 'TIKB-220')).status, 'cancelled');
		assert.equal(calls, 1);
		await reopened.stop();
	} finally {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('编号结果缓存重开可读；强制刷新保留站点调度和代理', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnets-'));
	let calls = 0;
	const host = runner(async (method, params, options) => {
		calls++;
		assert.equal(method, 'magnet.search');
		assert.deepEqual(params, { code: 'TIKB-220', proxy: 'http://127.0.0.1:7890', maxResults: 20, transport: 'httpx' });
		await options?.onRequest?.({ source: 'sukebei', host: 'sukebei.nyaa.si', sequence: 1 });
		return ready;
	});
	const service = new MagnetService(root, host, async () => 'http://127.0.0.1:7890', 0);
	try {
		assert.equal((await service.search('first', 'TIKB-220')).items.length, 1);
		await service.search('cached', 'TIKB-220');
		assert.equal(calls, 1);
		await service.stop();
		const reopened = new MagnetService(root, host, async () => 'http://127.0.0.1:7890', 0);
		assert.equal((await reopened.search('reopened', 'TIKB-220')).status, 'ready');
		assert.equal(calls, 1);
		await reopened.search('refresh', 'TIKB-220', true);
		assert.equal(calls, 2);
		assert.equal((await reopened.row('TIKB-220', row.id))?.magnet, row.magnet);
		assert.equal(await reopened.row('TIKB-221', row.id), undefined);
		await reopened.stop();
	} finally {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('取消在途请求并持久化；重启和迟到任务都不自动重发', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnets-cancel-'));
	let started!: () => void;
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	let calls = 0;
	const service = new MagnetService(
		root,
		runner(async (_method, _params, options) => {
			calls++;
			started();
			await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new TaskCancelledError()), { once: true }));
			return ready;
		}),
		async () => '',
		0,
	);
	try {
		const pending = service.search('cancel', 'TIKB-220');
		await running;
		await service.cancel('cancel');
		assert.equal((await pending).status, 'cancelled');
		await service.stop();
		const reopened = new MagnetService(
			root,
			runner(async () => {
				calls++;
				return ready;
			}),
			async () => '',
			0,
		);
		assert.equal((await reopened.search('again', 'TIKB-220')).status, 'cancelled');
		assert.equal(calls, 1);
		await reopened.cancel('late');
		assert.equal((await reopened.search('late', 'TIKB-221')).status, 'cancelled');
		assert.equal(calls, 1);
		assert.equal((await reopened.search('explicit', 'TIKB-220', true)).status, 'ready');
		await reopened.stop();
	} finally {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('站点限流跨重启生效', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnets-limit-'));
	let calls = 0;
	const host = runner(async () => {
		calls++;
		return { status: 'failed', items: [], message: '来源正在限流', reason: 'rate_limited', retryAfter: 120, requests: 1 };
	});
	const service = new MagnetService(root, host, async () => '', 0);
	try {
		assert.equal((await service.search('limited', 'TIKB-220')).reason, 'rate_limited');
		await service.stop();
		const reopened = new MagnetService(root, host, async () => '', 0);
		assert.equal((await reopened.search('another', 'TIKB-221', true)).reason, 'cooldown');
		assert.equal(calls, 1);
		await reopened.stop();
	} finally {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('异常记录不覆盖；中断记录仅在明确刷新时重发', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnets-state-'));
	const service = new MagnetService(
		root,
		runner(async () => ready),
		async () => '',
		0,
	);
	try {
		await service.search('seed', 'TIKB-220');
		await service.stop();
		const path = join(root, 'magnet-search/state.json');
		const stored = JSON.parse(await readFile(path, 'utf8'));
		stored.results[0].status = 'running';
		await writeFile(path, JSON.stringify(stored));
		let calls = 0;
		const reopened = new MagnetService(
			root,
			runner(async () => {
				calls++;
				return { ...ready, items: [] };
			}),
			async () => '',
			0,
		);
		assert.equal((await reopened.search('read', 'TIKB-220')).status, 'interrupted');
		assert.equal(calls, 0);
		const empty = await reopened.search('refresh', 'TIKB-220', true);
		assert.equal(empty.status, 'ready');
		assert.equal(empty.items.length, 0);
		await reopened.stop();
		await writeFile(path, '{bad');
		const invalid = new MagnetService(
			root,
			runner(async () => ready),
			async () => '',
			0,
		);
		assert.equal((await invalid.search('invalid', 'TIKB-220')).reason, 'storage');
		assert.equal(await readFile(path, 'utf8'), '{bad');
		await invalid.stop();
	} finally {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('结果校验拒绝外域链接、不同 hash 和超过 20 条', () => {
	const result = { ...ready, code: 'TIKB-220', checkedAt: new Date().toISOString() };
	assert.equal(magnetResultSchema.safeParse(result).success, true);
	for (const invalid of [
		{ ...row, url: 'https://example.invalid/view/1' },
		{ ...row, id: 'b'.repeat(40) },
	]) {
		assert.equal(magnetResultSchema.safeParse({ ...result, items: [invalid] }).success, false);
	}
	assert.equal(magnetResultSchema.safeParse({ ...result, items: Array(21).fill(row) }).success, false);
});

test('代理解析未返回时仍可取消；迟到响应不创建工作者', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnets-route-'));
	let begin!: () => void;
	let finish!: (value: string) => void;
	const routing = new Promise<void>((resolve) => {
		begin = resolve;
	});
	let calls = 0;
	const service = new MagnetService(
		root,
		runner(async () => {
			calls++;
			return ready;
		}),
		async () => {
			begin();
			return new Promise<string>((resolve) => {
				finish = resolve;
			});
		},
		0,
	);
	try {
		const pending = service.search('route', 'TIKB-220');
		await routing;
		await service.cancel('route');
		assert.equal((await pending).status, 'cancelled');
		finish('http://127.0.0.1:7890');
		await service.stop();
		assert.equal(calls, 0);
	} finally {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('请求域名与次数受限，超出范围停止派发并退避', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnets-gate-'));
	let requests = 0;
	const service = new MagnetService(
		root,
		runner(async (_method, _params, options) => {
			for (let index = 1; index <= 4; index++) {
				await options!.onRequest!({ source: 'sukebei', host: 'sukebei.nyaa.si', sequence: index });
				requests++;
			}
			return ready;
		}),
		async () => '',
		0,
	);
	try {
		assert.equal((await service.search('bounded', 'TIKB-220')).status, 'failed');
		assert.equal(requests, 3);
		assert.equal((await service.search('retry', 'TIKB-220', true)).reason, 'cooldown');
		await service.stop();
		const other = new MagnetService(
			root + '-domain',
			runner(async (_method, _params, options) => {
				await options!.onRequest!({ source: 'sukebei', host: 'example.invalid', sequence: 1 });
				assert.fail('A request to an unapproved host was permitted');
			}),
			async () => '',
			0,
		);
		assert.equal((await other.search('domain', 'TIKB-220')).status, 'failed');
		await other.stop();
	} finally {
		await service.stop();
		await rm(root, { recursive: true, force: true });
		await rm(root + '-domain', { recursive: true, force: true });
	}
});

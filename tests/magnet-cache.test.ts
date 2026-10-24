import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MagnetService } from '../src/main/features/magnets/magnet-service';
import { TaskCancelledError, type PythonTaskHost } from '../src/main/platform/python/python-host';
import { DEFAULT_MAGNET_SETTINGS, type MagnetSettings, type MagnetSource } from '@shared/magnets';

const hour = 60 * 60_000;

function ready(title = '缓存样本', source: MagnetSource = 'sukebei') {
	return {
		status: 'ready',
		items: [
			{
				id: 'a'.repeat(40),
				title,
				magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
				url: source === 'sukebei' ? 'https://sukebei.nyaa.si/view/1' : 'https://javtao.com/cache-001',
				size: '1 GiB',
				uploadedAt: null,
				seeders: 0,
				leechers: 0,
				completed: 0,
			},
		],
		message: '',
	};
}

test('普通磁链结果缓存 24 小时，空结果缓存 1 小时；到期后的首次访问才查询', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnet-ttl-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	let calls = 0;
	const host = {
		run: async () => {
			calls++;
			return calls < 3 ? ready() : { ...ready(), items: [] };
		},
	} as Pick<PythonTaskHost, 'run'>;
	const service = new MagnetService(root, host, async () => '', 0);
	t.after(() => service.stop());
	const found = await service.search('first', 'CACHE-001');
	let now = Date.parse(found.checkedAt) + 24 * hour - 1;
	t.mock.method(Date, 'now', () => now);
	assert.equal((await service.search('fresh', 'CACHE-001')).checkedAt, found.checkedAt);
	assert.equal(calls, 1);
	now++;
	await service.search('expired', 'CACHE-001');
	assert.equal(calls, 2);
	const empty = await service.search('empty', 'CACHE-002');
	now = Date.parse(empty.checkedAt) + hour - 1;
	assert.equal((await service.search('empty-fresh', 'CACHE-002')).items.length, 0);
	assert.equal(calls, 3);
	now++;
	await service.search('empty-expired', 'CACHE-002');
	assert.equal(calls, 4);
});

test('收藏复用过期结果，不因上限变化、最近查询淘汰或重启更新；只有手动刷新替换快照', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnet-saved-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	let calls = 0;
	let settings: MagnetSettings = { ...DEFAULT_MAGNET_SETTINGS, maxResults: 5 };
	const host = { run: async () => ready(`第 ${++calls} 次查询`) } as Pick<PythonTaskHost, 'run'>;
	const service = new MagnetService(
		root,
		host,
		async () => '',
		0,
		() => settings,
	);
	t.after(() => service.stop());
	const initial = await service.search('initial', 'CACHE-001');
	t.mock.method(Date, 'now', () => Date.parse(initial.checkedAt) + 30 * 24 * hour);
	assert.equal((await service.search('pin', 'CACHE-001', false, 'sukebei', 'saved')).checkedAt, initial.checkedAt);
	assert.equal(calls, 1);
	for (let index = 0; index < 51; index++) {
		await service.search(`other-${index}`, `OTHER-${index}`);
	}
	const stored = JSON.parse(await readFile(join(root, 'magnet-search/state.json'), 'utf8'));
	assert.equal(
		stored.results.some((result: { code: string }) => result.code === 'CACHE-001'),
		false,
	);
	await service.stop();
	settings = { ...settings, maxResults: 20 };
	const reopened = new MagnetService(
		root,
		host,
		async () => '',
		0,
		() => settings,
	);
	t.after(() => reopened.stop());
	const saved = await reopened.search('reopen', 'CACHE-001', false, 'sukebei', 'saved');
	assert.equal(saved.items[0]?.title, initial.items[0]?.title);
	assert.equal(saved.checkedAt, initial.checkedAt);
	assert.equal(saved.limit, 20);
	assert.equal(calls, 52);
	assert.equal((await reopened.row('CACHE-001', saved.items[0]!.id))?.magnet, saved.items[0]?.magnet);
	await reopened.search('regular', 'CACHE-001');
	assert.equal(calls, 53);
	assert.equal((await reopened.search('unchanged', 'CACHE-001', false, 'sukebei', 'saved')).items[0]?.title, initial.items[0]?.title);
	const refreshed = await reopened.search('refresh', 'CACHE-001', true, 'sukebei', 'saved');
	assert.equal(calls, 54);
	assert.notEqual(refreshed.items[0]?.title, initial.items[0]?.title);
	assert.deepEqual(await reopened.search('updated', 'CACHE-001', false, 'sukebei', 'saved'), refreshed);
});

test('收藏的空结果同样保留，两个来源独立保存；取消收藏会清理快照', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnet-sources-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	let calls = 0;
	const host = {
		run: async (_method, params) => {
			calls++;
			return params?.source === 'javtao' ? ready('JavTao 缓存', 'javtao') : { ...ready(), items: [] };
		},
	} as Pick<PythonTaskHost, 'run'>;
	const service = new MagnetService(root, host, async () => '', 0);
	t.after(() => service.stop());
	const empty = await service.search('empty', 'CACHE-001', false, 'sukebei', 'saved');
	await service.search('other-source', 'CACHE-001', false, 'javtao', 'saved');
	t.mock.method(Date, 'now', () => Date.parse(empty.checkedAt) + 90 * 24 * hour);
	assert.equal((await service.search('old-empty', 'CACHE-001', false, 'sukebei', 'saved')).items.length, 0);
	assert.equal((await service.search('old-other', 'CACHE-001', false, 'javtao', 'saved')).items[0]?.title, 'JavTao 缓存');
	assert.equal(calls, 2);
	assert.equal((await readdir(join(root, 'magnet-search/saved'))).length, 2);
	await service.forgetSaved('CACHE-001');
	assert.deepEqual(await readdir(join(root, 'magnet-search/saved')), []);
});

test('刷新失败或取消保留收藏上一次成功结果，重开不会自动重试', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnet-refresh-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	let mode: 'ready' | 'pending' | 'failed' = 'ready';
	let calls = 0;
	let started!: () => void;
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	const host: Pick<PythonTaskHost, 'run'> = {
		run: async (_method, _params, options) => {
			calls++;
			if (mode === 'pending') {
				started();
				await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new TaskCancelledError()), { once: true }));
			}
			return mode === 'failed' ? { status: 'failed', items: [], message: '查询失败', reason: 'parse_error' } : ready();
		},
	};
	const service = new MagnetService(root, host, async () => '', 0);
	t.after(() => service.stop());
	const initial = await service.search('initial', 'CACHE-001', false, 'sukebei', 'saved');
	mode = 'pending';
	const pending = service.search('cancel', 'CACHE-001', true, 'sukebei', 'saved');
	await running;
	await service.cancel('cancel');
	assert.equal((await pending).status, 'cancelled');
	assert.deepEqual(await service.search('after-cancel', 'CACHE-001', false, 'sukebei', 'saved'), initial);
	mode = 'failed';
	assert.equal((await service.search('fail', 'CACHE-001', true, 'sukebei', 'saved')).status, 'failed');
	await service.stop();
	const reopened = new MagnetService(root, host, async () => '', 0);
	t.after(() => reopened.stop());
	assert.deepEqual(await reopened.search('reopened', 'CACHE-001', false, 'sukebei', 'saved'), initial);
	assert.equal((await reopened.row('CACHE-001', initial.items[0]!.id))?.magnet, initial.items[0]?.magnet);
	assert.equal(calls, 3);
});

test('损坏的收藏快照不触发自动查询；手动刷新可修复', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-magnet-corrupt-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	let calls = 0;
	const service = new MagnetService(
		root,
		{
			run: async () => {
				calls++;
				return ready();
			},
		} as Pick<PythonTaskHost, 'run'>,
		async () => '',
		0,
	);
	t.after(() => service.stop());
	await service.search('initial', 'CACHE-001', false, 'sukebei', 'saved');
	const folder = join(root, 'magnet-search/saved');
	const path = join(folder, (await readdir(folder))[0]!);
	await writeFile(path, '{broken');
	assert.equal((await service.search('broken', 'CACHE-001', false, 'sukebei', 'saved')).reason, 'storage');
	assert.equal(await readFile(path, 'utf8'), '{broken');
	assert.equal(calls, 1);
	assert.equal((await service.search('repair', 'CACHE-001', true, 'sukebei', 'saved')).status, 'ready');
	assert.equal(calls, 2);
	assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 'ready');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MetadataService } from '../src/main/features/metadata/metadata-service';
import { planQuery, codeFromCid } from '../src/main/features/metadata/metadata-input';
import { proxyFromRules } from '../src/main/platform/network/network-route';
import { PythonTaskHost, TaskCancelledError } from '../src/main/platform/python/python-host';
import type { MetadataRecord, QueryTask, SourceId } from '@shared/metadata';

type Run = PythonTaskHost['run'];
const success = { status: 'success', reason: '', message: '完成', retryAfter: 0, requests: 1, warnings: [] };
const request = { query: 'SSIS-057', sources: ['dmm'] as SourceId[], force: false };

function record(source: SourceId = 'dmm'): MetadataRecord {
	return {
		id: (source === 'dmm' ? 'a' : 'b').repeat(64),
		source,
		parser: 'fixture',
		parserVersion: 'fixture',
		code: 'SSIS-057',
		contentId: 'ssis00057',
		sourceUrl: source === 'dmm' ? 'https://video.dmm.co.jp/av/content/?id=ssis00057' : 'https://r18.dev/videos/vod/movies/detail/-/dvd_id=SSIS-057/json',
		fetchedAt: new Date().toISOString(),
		title: '来源实际标题',
		titleLanguage: 'ja',
		people: [],
		studio: '',
		label: '',
		series: '',
		releaseDate: '2021-05-07',
		deliveryDate: '',
		seller: '',
		sellerUrl: '',
		description: '',
		tags: [],
		covers: [],
		warnings: [],
	};
}

async function directory(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'nectisse-metadata-'));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

async function finished(service: MetadataService): Promise<QueryTask> {
	for (let i = 0; i < 200; i++) {
		const state = service.getState();
		if (!state.activeId && state.tasks[0]) {
			return state.tasks[0];
		}
		await delay(10);
	}
	throw new Error('Metadata task did not finish');
}

test('输入分流、编号与链接身份：FC2 不访问 JAV 来源，标题不扩展其他站点', () => {
	assert.deepEqual(planQuery({ ...request, query: 'fc2 ppv 1234567', sources: ['r18dev', 'fc2', 'dmm'] }).sources, ['fc2']);
	assert.deepEqual(planQuery({ ...request, query: '作品タイトル', sources: ['r18dev', 'dmm'] }).sources, ['dmm']);
	const plan = planQuery({ ...request, query: 'https://video.dmm.co.jp/av/content/?id=ssis00057&token=private' });
	assert.equal(plan.query, 'SSIS-057');
	assert.equal(plan.contentId, 'ssis00057');
	assert.equal(codeFromCid('h_1721fkos00006'), 'FKOS-006');
	assert.equal(codeFromCid('300mium01239'), '300MIUM-1239');
	for (const query of [
		'FC2-PPV-1234567-1',
		'https://evil.example/?id=ssis00057',
		'https://user:secret@video.dmm.co.jp/?id=ssis00057',
		'http://r18.dev/videos/vod/movies/detail/-/dvd_id=SSIS-057/json',
	]) {
		assert.throws(() => planQuery({ ...request, query }));
	}
});

test('系统代理解析支持 HTTP、HTTPS 与 SOCKS；不把带密码或无法识别的代理静默改为直连', () => {
	assert.equal(proxyFromRules('DIRECT'), '');
	assert.equal(proxyFromRules('PROXY 127.0.0.1:6152; DIRECT'), 'http://127.0.0.1:6152');
	assert.equal(proxyFromRules('HTTPS proxy.example:443'), 'https://proxy.example:443');
	assert.equal(proxyFromRules('socks5 [::1]:6153'), 'socks5h://[::1]:6153');
	assert.throws(() => proxyFromRules('PROXY user:password@proxy.example:80'));
	assert.throws(() => proxyFromRules('PROXY proxy.example:99999'));
});

test('正式来源设置约束资料查询，关闭来源不能由查询请求重新启用', async (t) => {
	const { DEFAULT_PREFERENCES } = await import('@shared/subscriptions');
	let calls = 0;
	const root = await directory(t);
	const service = new MetadataService(
		root,
		{
			run: async () => {
				calls++;
				return {};
			},
		},
		undefined,
		0,
		() => ({ ...DEFAULT_PREFERENCES, enabledSources: ['fanbox'] }),
	);
	t.after(() => service.stop());
	await service.initialize();
	const reply = await service.query(request);
	assert.equal(reply.ok, false);
	assert.equal(calls, 0);
	assert.equal(service.getState().tasks.length, 0);
});

test('查询持久化、来源隔离与缓存命中：同一小时不重复派发，强制刷新才重新请求', async (t) => {
	let calls = 0;

	const run: Run = async (_method, _params, options) => {
		calls++;
		await options?.onRequest?.({ source: 'dmm', host: 'api.video.dmm.co.jp', sequence: 1 });
		options?.onProgress?.({ event: 'record', record: record() });
		return success;
	};

	const root = await directory(t);
	const service = new MetadataService(root, { run }, undefined, 0);
	t.after(() => service.stop());
	await service.initialize();
	const first = await service.query(request);
	assert.equal(first.ok, true);
	const result = await finished(service);
	assert.equal(result.status, 'succeeded');
	assert.equal(result.requests, 1);
	assert.equal(service.sourceUrl(result.id, result.records[0]!.id), result.records[0]!.sourceUrl);
	assert.equal(service.sourceUrl(result.id, 'c'.repeat(64)), undefined);
	const cached = await service.query(request);
	assert.equal(cached.cached, true);
	assert.equal(calls, 1);
	await service.query({ ...request, force: true });
	await finished(service);
	assert.equal(calls, 2);
	await service.stop();
	const restored = new MetadataService(root, { run });
	await restored.initialize();
	t.after(() => restored.stop());
	assert.equal(restored.getState().tasks.length, 2);
	assert.equal(restored.getState().activeId, undefined);
	assert.equal(calls, 2);
});

test('来源失败保留先到资料，不伪装成完整成功', async (t) => {
	const root = await directory(t);

	const run: Run = async (_method, params, options) => {
		const source = params!.source as SourceId;
		await options?.onRequest?.({ source, host: 'source.example', sequence: 1 });
		if (source === 'dmm') {
			options?.onProgress?.({ event: 'record', record: record() });
			return success;
		}
		return { ...success, status: 'error', reason: 'challenge', message: '来源要求浏览器验证' };
	};

	const service = new MetadataService(root, { run }, undefined, 0);
	t.after(() => service.stop());
	await service.initialize();
	await service.query({ ...request, sources: ['dmm', 'r18dev'] });
	const result = await finished(service);
	assert.equal(result.status, 'partial');
	assert.equal(result.records.length, 1);
	assert.equal(result.outcomes[1]!.reason, 'challenge');
});

test('扩展资料来源可从查询记录打开原文，来源外主机与非标准端口仍被拒绝', async (t) => {
	const urls = ['https://www.avbase.net/works/SSIS-057', 'https://avbase.net.evil.invalid/works/SSIS-057', 'https://www.avbase.net:444/works/SSIS-057'];

	const run: Run = async (_method, _params, options) => {
		for (const [index, sourceUrl] of urls.entries()) {
			options?.onProgress?.({ event: 'record', record: { ...record('avbase'), id: String(index).repeat(64), sourceUrl } });
		}
		return success;
	};

	const service = new MetadataService(await directory(t), { run }, undefined, 0);
	t.after(() => service.stop());
	await service.initialize();
	await service.query({ ...request, sources: ['avbase'] });
	const result = await finished(service);
	assert.equal(result.records.length, 3);
	assert.equal(service.sourceUrl(result.id, result.records[0]!.id), urls[0]);
	for (const item of result.records.slice(1)) {
		assert.equal(service.sourceUrl(result.id, item.id), undefined);
	}
});

test('取消先落盘，拒绝后续请求与迟到结果；重启不会复活取消任务', async (t) => {
	const root = await directory(t);
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let runCalls = 0;
	let durableStatus = '';

	const run: Run = async (_method, _params, options) => {
		runCalls++;
		await options?.onRequest?.({ source: 'dmm', host: 'api.video.dmm.co.jp', sequence: 1 });
		started();
		await new Promise<void>((_resolve, reject) =>
			options!.signal!.addEventListener(
				'abort',
				() => {
					void (async () => {
						durableStatus = JSON.parse(await readFile(join(root, 'metadata/state.json'), 'utf8')).tasks[0].status;
						options?.onProgress?.({ event: 'record', record: record() });
						await assert.rejects(options!.onRequest!({ source: 'dmm', host: 'api.video.dmm.co.jp', sequence: 2 }));
						reject(new TaskCancelledError());
					})();
				},
				{ once: true },
			),
		);
		return success;
	};

	const service = new MetadataService(root, { run }, undefined, 0);
	await service.initialize();
	t.after(() => service.stop());
	const reply = await service.query(request);
	await ready;
	await service.cancel(reply.taskId!);
	const result = await finished(service);
	assert.equal(durableStatus, 'cancelling');
	assert.equal(result.status, 'cancelled');
	assert.equal(result.requests, 1);
	assert.equal(result.records.length, 0);
	await service.stop();
	const restored = new MetadataService(root, { run });
	await restored.initialize();
	t.after(() => restored.stop());
	assert.equal(restored.getState().tasks[0]!.status, 'cancelled');
	assert.equal(runCalls, 1);
});

test('429 冷却跨重启保留；冷却期间手动刷新也不发请求', async (t) => {
	const root = await directory(t);
	let calls = 0;

	const run: Run = async () => {
		calls++;
		return { ...success, status: 'error', reason: 'rate_limited', message: '来源限流', retryAfter: 120 };
	};

	const first = new MetadataService(root, { run }, undefined, 0);
	await first.initialize();
	await first.query(request);
	await finished(first);
	await first.stop();
	const second = new MetadataService(root, { run }, undefined, 0);
	t.after(() => second.stop());
	await second.initialize();
	await second.query({ ...request, force: true });
	assert.equal((await finished(second)).outcomes[0]!.reason, 'cooldown');
	assert.equal(calls, 1);
});

test('恢复边界：运行中记为中断，已请求取消记为取消，均不自动派发', async (t) => {
	const root = await directory(t);

	const run: Run = async () => {
		throw new Error('Must not run on startup');
	};

	const service = new MetadataService(root, { run });
	await service.initialize();
	await service.stop();
	const path = join(root, 'metadata/state.json');
	const journal = JSON.parse(await readFile(path, 'utf8'));
	const task = {
		id: '11111111-1111-4111-8111-111111111111',
		status: 'running',
		phase: '旧任务',
		plan: planQuery(request),
		startedAt: new Date().toISOString(),
		records: [],
		outcomes: [],
		requests: 0,
	};
	journal.tasks = [task, { ...task, id: '22222222-2222-4222-8222-222222222222', status: 'cancelling', cancelRequestedAt: new Date().toISOString() }];
	journal.activeId = task.id;
	await writeFile(path, JSON.stringify(journal));
	const restored = new MetadataService(root, { run });
	t.after(() => restored.stop());
	await restored.initialize();
	assert.deepEqual(
		restored.getState().tasks.map((task) => task.status),
		['interrupted', 'cancelled'],
	);
	assert.equal(restored.getState().activeId, undefined);
});

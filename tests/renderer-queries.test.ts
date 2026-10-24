import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MutationObserver, QueryObserver, focusManager, onlineManager } from '@tanstack/react-query';
import type { DesktopBridge } from '@shared/protocol';
import { savedWorkSchema, summarizeWork, type LibraryState, type SavedWork } from '@shared/library';
import { metadataRecordSchema } from '@shared/metadata';
import type { DiagnosticReport } from '@shared/diagnostics';
import { createDesktopQueries, queryKeys } from '../src/renderer/shared/desktop/queries';
import { readLocal } from '../src/renderer/shared/desktop/local-read';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function saved(id = 'a', title = '本机收藏'): SavedWork {
	return savedWorkSchema.parse({
		id: id.repeat(64),
		code: `NECT-02${id === 'a' ? 4 : 5}`,
		savedAt: '2026-10-24T00:00:00.000Z',
		updatedAt: '2026-10-24T00:00:00.000Z',
		coverId: null,
		records: [
			metadataRecordSchema.parse({
				id: 'c'.repeat(64),
				source: 'dmm',
				parser: 'fixture',
				parserVersion: '1',
				code: 'NECT-024',
				contentId: 'fixture',
				sourceUrl: 'https://video.dmm.co.jp/av/content/?id=fixture',
				fetchedAt: '2026-10-24T00:00:00.000Z',
				title,
				titleLanguage: 'ja',
				people: [],
				studio: '',
				label: '',
				seller: '',
				sellerUrl: '',
				series: '',
				releaseDate: '',
				description: '',
				tags: [],
				covers: [],
				warnings: [],
			}),
		],
	});
}

function harness(t: { after: (cleanup: () => void) => void }) {
	const cleanups: Array<() => void> = [];
	const works = new Map<string, SavedWork>();
	const reads: string[] = [];
	let readWork = async (id: string): Promise<SavedWork | undefined> => works.get(id);
	let diagnosticReads = 0;
	let magnetSearches = 0;
	let saves = 0;
	let removes = 0;
	const report = (): DiagnosticReport => ({
		generatedAt: new Date(1_000_000 + diagnosticReads).toISOString(),
		entries: [],
		logStatus: 'ready',
		ignoredLines: 0,
		environment: { appVersion: '1', system: 'darwin', architecture: 'arm64', electronVersion: '45', pythonVersion: '3.14', runtimePhase: 'ready' },
	});
	let readReport = async (): Promise<DiagnosticReport> => report();
	let copyReport: DesktopBridge['diagnostics']['copyReport'] = async () => ({ copied: true, report: report() });
	let saveWork: DesktopBridge['library']['save'] = async () => ({ ok: false, message: '保存未完成' });
	const bridge = {
		library: {
			getWork: async (id: string) => {
				reads.push(id);
				return readWork(id);
			},
			save: async (...args: Parameters<DesktopBridge['library']['save']>) => {
				saves++;
				return saveWork(...args);
			},
			remove: async () => {
				removes++;
				throw new Error('unavailable');
			},
		},
		diagnostics: {
			getReport: async () => {
				diagnosticReads++;
				return readReport();
			},
			copyReport: async () => {
				diagnosticReads++;
				return copyReport();
			},
		},
		magnets: {
			search: async () => {
				magnetSearches++;
				return {
					code: 'NECT-024',
					status: 'cancelled',
					items: [],
					limit: 20,
					checkedAt: new Date().toISOString(),
					message: '已取消',
					reason: '',
					requests: 0,
					retryAfter: 0,
				};
			},
		},
	} as unknown as DesktopBridge;
	const queries = createDesktopQueries(() => bridge);
	t.after(() => {
		for (const cleanup of cleanups.reverse()) {
			cleanup();
		}
		queries.client.clear();
	});
	return {
		own: (cleanup: () => void) => {
			cleanups.push(cleanup);
		},
		queries,
		works,
		reads,
		readWith: (read: typeof readWork) => {
			readWork = read;
		},
		readReportWith: (read: typeof readReport) => {
			readReport = read;
		},
		copyReportWith: (copy: typeof copyReport) => {
			copyReport = copy;
		},
		saveWith: (save: typeof saveWork) => {
			saveWork = save;
		},
		counts: () => ({ diagnosticReads, magnetSearches, saves, removes }),
	};
}

test('按需读取去重与复用缓存；离线也能读取本机收藏，不触发任何采集', async (t) => {
	const h = harness(t);
	const work = saved();
	const pending = deferred<SavedWork>();
	h.readWith(() => pending.promise);
	assert.deepEqual(h.reads, []);
	onlineManager.setOnline(false);
	try {
		const first = h.queries.client.fetchQuery(h.queries.work(work.id));
		const second = h.queries.client.fetchQuery(h.queries.work(work.id));
		await tick();
		assert.deepEqual(h.reads, [work.id]);
		pending.resolve(work);
		assert.deepEqual(await first, work);
		assert.deepEqual(await second, work);
		await h.queries.client.fetchQuery(h.queries.work(work.id));
		assert.equal(h.reads.length, 1);
		assert.equal(h.counts().magnetSearches, 0);
	} finally {
		onlineManager.setOnline(true);
	}
});

test('收藏摘要推送只更新变化作品的详情；同一毫秒更新也能失效，旧内容不覆盖新内容', async (t) => {
	const h = harness(t);
	const a = saved();
	const b = saved('b');
	h.works.set(a.id, a);
	h.works.set(b.id, b);
	await Promise.all([h.queries.client.fetchQuery(h.queries.work(a.id)), h.queries.client.fetchQuery(h.queries.work(b.id))]);
	const observer = new QueryObserver(h.queries.client, h.queries.work(a.id));
	const unsubscribe = observer.subscribe(() => {});
	h.own(unsubscribe);
	const before: LibraryState = { revision: 1, works: [summarizeWork(a), summarizeWork(b)] };
	await h.queries.syncLibrary(before, { ...before, revision: 2 });
	await h.queries.syncLibrary(before, { revision: 2, works: [structuredClone(before.works[1]!), structuredClone(before.works[0]!)] });
	await h.queries.syncLibrary({ ...before, works: [before.works[1]!, before.works[0]!] }, { revision: 2, works: [structuredClone(before.works[0]!)] });
	assert.equal(h.reads.length, 2);
	const newer = saved('a', '明确更新的收藏');
	h.works.set(a.id, newer);
	await h.queries.syncLibrary(before, { revision: 3, works: [summarizeWork(newer), before.works[1]!] });
	assert.equal(h.reads.length, 3);
	assert.equal(h.queries.client.getQueryData(h.queries.work(a.id).queryKey)?.records[0]?.title, '明确更新的收藏');
	assert.equal(h.reads.filter((id) => id === b.id).length, 1);
});

test('不在详情页时收到更新，下次进入会读取新快照；不会永久停在旧缓存', async (t) => {
	const h = harness(t);
	const before = saved();
	h.works.set(before.id, before);
	await h.queries.client.fetchQuery(h.queries.work(before.id));
	const after = saved('a', '离开页面后更新');
	h.works.set(after.id, after);
	await h.queries.syncLibrary({ revision: 1, works: [summarizeWork(before)] }, { revision: 2, works: [summarizeWork(after)] });
	assert.equal(h.reads.length, 1);
	const observer = new QueryObserver(h.queries.client, h.queries.work(after.id));
	const unsubscribe = observer.subscribe(() => {});
	h.own(unsubscribe);
	await tick();
	assert.equal(h.reads.length, 2);
	assert.equal(observer.getCurrentResult().data?.records[0]?.title, '离开页面后更新');
});

test('删除收藏中断旧详情读取，迟到结果不能复活已删除记录；重新收藏可以重新读取', async (t) => {
	const h = harness(t);
	const work = saved();
	const pending = deferred<SavedWork>();
	h.readWith(() => pending.promise);
	const reading = h.queries.client.fetchQuery(h.queries.work(work.id));
	const rejected = assert.rejects(reading);
	await tick();
	await h.queries.syncLibrary({ revision: 1, works: [summarizeWork(work)] }, { revision: 2, works: [] });
	await rejected;
	pending.resolve(work);
	await tick();
	assert.equal(h.queries.client.getQueryData(queryKeys.work(work.id)), null);
	h.readWith(async () => saved('a', '重新收藏'));
	await h.queries.syncLibrary({ revision: 2, works: [] }, { revision: 3, works: [summarizeWork(work)] });
	assert.equal((await h.queries.client.fetchQuery(h.queries.work(work.id)))?.records[0]?.title, '重新收藏');
});

test('本机读取失败不自动重试；空记录使用 null；等待超时和取消不接受迟到值', async (t) => {
	const h = harness(t);
	const work = saved();
	h.readWith(async () => {
		throw new Error('failed');
	});
	await assert.rejects(h.queries.client.fetchQuery(h.queries.work(work.id)), /LOCAL_READ_FAILED/);
	assert.equal(h.reads.length, 1);
	h.readWith(async () => undefined);
	assert.equal(await h.queries.client.fetchQuery(h.queries.work(work.id)), null);
	await assert.rejects(
		readLocal(() => new Promise(() => {}), undefined, 5),
		/LOCAL_READ_TIMEOUT/,
	);
	const pending = deferred<SavedWork>();
	h.readWith(() => pending.promise);
	const reading = h.queries.client.fetchQuery({ ...h.queries.work(work.id), staleTime: 0 });
	await tick();
	h.queries.cancelReads();
	assert.equal(await reading, null);
	pending.resolve(work);
	await tick();
	assert.equal(h.queries.client.getQueryData(queryKeys.work(work.id)), null);
});

test('诊断报告按需读取与去重，刷新和复制使用同一缓存', async (t) => {
	const h = harness(t);
	const observer = new QueryObserver(h.queries.client, h.queries.diagnostics(false));
	const unsubscribe = observer.subscribe(() => {});
	h.own(unsubscribe);
	await tick();
	assert.equal(h.counts().diagnosticReads, 0);
	observer.setOptions(h.queries.diagnostics(true));
	await observer.refetch();
	assert.equal(h.counts().diagnosticReads, 1);
	const first = observer.getCurrentResult().data;
	await observer.refetch();
	assert.equal(h.counts().diagnosticReads, 2);
	assert.notEqual(observer.getCurrentResult().data?.generatedAt, first?.generatedAt);
	const copy = new MutationObserver(h.queries.client, h.queries.copyDiagnostics());
	const reply = await copy.mutate();
	assert.equal(reply.copied, true);
	if (reply.copied) {
		assert.deepEqual(observer.getCurrentResult().data, reply.report);
	}
	copy.reset();
});

test('诊断复制与刷新交错时保留较新报告；取消读取后旧结果不能覆盖重新打开取得的报告', async (t) => {
	const h = harness(t);
	const observer = new QueryObserver(h.queries.client, h.queries.diagnostics(true));
	h.own(observer.subscribe(() => {}));
	const first = await h.queries.client.fetchQuery(h.queries.diagnostics(true));
	const pendingCopy = deferred<Awaited<ReturnType<DesktopBridge['diagnostics']['copyReport']>>>();
	h.copyReportWith(() => pendingCopy.promise);
	const copy = new MutationObserver(h.queries.client, h.queries.copyDiagnostics());
	const copying = copy.mutate();
	await tick();
	const newer = await h.queries.client.fetchQuery(h.queries.diagnostics(true));
	pendingCopy.resolve({ copied: true, report: { ...first, generatedAt: newer.generatedAt, ignoredLines: 1 } });
	await copying;
	assert.deepEqual(h.queries.client.getQueryData(queryKeys.diagnostics), newer);
	const pendingRead = deferred<DiagnosticReport>();
	h.readReportWith(() => pendingRead.promise);
	const reading = h.queries.client.fetchQuery(h.queries.diagnostics(true));
	await tick();
	h.queries.cancelReads();
	assert.deepEqual(await reading, newer);
	h.readReportWith(async () => ({ ...newer, generatedAt: new Date(Date.parse(newer.generatedAt) + 100).toISOString() }));
	const reopened = await h.queries.client.fetchQuery(h.queries.diagnostics(true));
	pendingRead.resolve(first);
	await tick();
	assert.deepEqual(h.queries.client.getQueryData(queryKeys.diagnostics), reopened);
	copy.reset();
});

test('明确更新收藏使详情失效，即使摘要没有可观察变化，也从主进程读取完整新资料', async (t) => {
	const h = harness(t);
	const before = saved();
	h.works.set(before.id, before);
	await h.queries.client.fetchQuery(h.queries.work(before.id));
	const changed = structuredClone(before);
	changed.records[0]!.description = '仅完整详情改变，时间戳和摘要保持相同';
	h.saveWith(async () => {
		h.works.set(changed.id, changed);
		return { ok: true, id: changed.id };
	});
	const save = new MutationObserver(h.queries.client, h.queries.saveWork());
	await save.mutate({ taskId: crypto.randomUUID(), code: before.code, replace: true });
	assert.deepEqual(summarizeWork(before), summarizeWork(changed));
	assert.equal((await h.queries.client.fetchQuery(h.queries.work(before.id)))?.records[0]?.description, changed.records[0]?.description);
	save.reset();
});

test('窗口聚焦和网络恢复不重读本机数据，不重派已取消磁链任务；保存删除失败不伪造成功', async (t) => {
	const h = harness(t);
	const work = saved();
	h.works.set(work.id, work);
	h.queries.client.mount();
	h.own(() => h.queries.client.unmount());
	const observer = new QueryObserver(h.queries.client, { ...h.queries.work(work.id), staleTime: 0 });
	const unsubscribe = observer.subscribe(() => {});
	h.own(unsubscribe);
	await observer.refetch();
	const search = new MutationObserver(h.queries.client, h.queries.searchMagnets());
	const reply = await search.mutate({ id: crypto.randomUUID(), origin: { kind: 'query', taskId: crypto.randomUUID(), code: work.code }, force: false });
	assert.equal(reply.status, 'cancelled');
	const save = new MutationObserver(h.queries.client, h.queries.saveWork());
	assert.equal((await save.mutate({ taskId: crypto.randomUUID(), code: work.code, replace: true })).ok, false);
	const remove = new MutationObserver(h.queries.client, h.queries.removeWork());
	await assert.rejects(remove.mutate(work.id));
	focusManager.setFocused(false);
	onlineManager.setOnline(false);
	focusManager.setFocused(true);
	onlineManager.setOnline(true);
	await tick();
	assert.equal(h.reads.length, 1);
	assert.deepEqual(h.counts(), { diagnosticReads: 0, magnetSearches: 1, saves: 1, removes: 1 });
	assert.deepEqual(h.queries.client.getQueryData(queryKeys.work(work.id)), work);
	assert.equal(h.queries.client.getQueryCache().getAll().length, 1);
	search.reset();
	save.reset();
	remove.reset();
	focusManager.setFocused(undefined);
});

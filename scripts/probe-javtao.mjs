// 显式在线验收；所有设置、订阅和图片仅写入临时目录。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { PythonTaskHost, pythonLayout } from '../src/main/platform/python/index.ts';
import { MetadataService } from '../src/main/features/metadata/index.ts';
import { MagnetService } from '../src/main/features/magnets/index.ts';
import { SubscriptionStore, SubscriptionsService } from '../src/main/features/subscriptions/index.ts';
import { SiteGate } from '../src/main/platform/network/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'nectisse-javtao-live-'));
const output = join(root, '.test-output/javtao/live-integration.json');
const host = new PythonTaskHost(pythonLayout(root, false));
const cipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
const store = new SubscriptionStore(temporary, cipher);
store.savePreferences({ ...store.preferences(), enabledSources: ['dmm', 'javtao'], querySources: ['javtao'], proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7890' });
const gate = new SiteGate(store);
const proxy = async () => 'http://127.0.0.1:7890';
const metadata = new MetadataService(
	temporary,
	host,
	proxy,
	2000,
	() => store.preferences(),
	() => '',
	(source, signal) => gate.permit(source, signal),
);
const subscriptions = new SubscriptionsService(
	store,
	host,
	proxy,
	async () => {},
	2000,
	(source, signal) => gate.permit(source, signal),
);
const magnets = new MagnetService(temporary, host, proxy, 2000, () => store.preferences().magnetSearch, {
	permit: async (source, signal) => {
		if (source === 'javtao') await gate.permit('javtao', signal);
	},
	cooldown: (source, seconds) => {
		if (source === 'javtao') store.saveSource('javtao', { ...store.source('javtao'), cooldownUntil: Date.now() + seconds * 1000 });
	},
});
const report = { checkedAt: new Date().toISOString(), status: 'running', anonymous: true, transport: 'fingerprint', checks: [] };

async function waitFor(test, message, timeout = 90_000) {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		if (test()) return;
		await delay(30);
	}
	throw new Error(message);
}

const done = (id) => subscriptions.getState().tasks.find((task) => task.id === id && !['running', 'cancelling'].includes(task.status));

async function cancelImages() {
	const task = subscriptions.getState().tasks.find((task) => task.kind === 'covers' && task.status === 'running');
	if (task) assert.equal((await subscriptions.command({ action: 'cancel', id: task.id })).ok, true);
}

try {
	await metadata.initialize();
	await subscriptions.initialize();
	console.log('JavTao: 查询资料与缓存封面');
	const queried = await metadata.query({ query: 'FSDSS-853', sources: ['javtao'], force: true });
	assert.equal(queried.ok, true);
	await waitFor(() => !metadata.getState().activeId, 'JavTao metadata timed out');
	const task = metadata.getState().tasks.find((task) => task.id === queried.taskId);
	report.metadata = {
		status: task.status,
		requests: task.requests,
		outcomes: task.outcomes,
		problems: task.records.map((record) => ({ warnings: record.warnings, covers: record.covers.map((cover) => ({ error: cover.error, probe: cover.probe })) })),
	};
	assert.equal(task.status, 'succeeded', 'JavTao metadata did not succeed');
	const record = task.records.find((record) => record.source === 'javtao');
	assert.equal(record.code, 'FSDSS-853');
	const cached = task.records.flatMap((record) => record.covers).filter((cover) => cover.asset);
	assert.equal(cached.length, 1);
	assert.ok(await metadata.image(cached[0].asset.sha256));
	report.metadata = {
		code: record.code,
		titlePresent: !!record.title,
		people: record.people.length,
		tags: record.tags.length,
		requests: task.requests,
		covers: cached.map((cover) => ({ width: cover.asset.width, height: cover.asset.height, format: cover.asset.format })),
	};
	report.checks.push('real-metadata-and-one-cached-cover');

	console.log('JavTao: 姓名查询、确认关注与收录当前演员页');
	const lookup = await subscriptions.command({ action: 'lookup', provider: 'javtao', query: '山下紗和' });
	assert.equal(lookup.ok, true);
	await waitFor(() => !!done(lookup.id), 'JavTao actor lookup timed out');
	report.actorLookup = {
		status: done(lookup.id).status,
		reason: done(lookup.id).reason,
		phase: done(lookup.id).phase,
		candidates: done(lookup.id).candidates.map((candidate) => ({ ref: candidate.ref, name: candidate.name })),
	};
	const candidate = done(lookup.id).candidates.find((candidate) => candidate.ref === 'shan-xia-sha-he');
	assert.ok(candidate, 'Actor name must resolve to the actual directory href');
	const followed = await subscriptions.command({ action: 'follow', taskId: lookup.id, ref: candidate.ref });
	assert.equal(followed.ok, true);
	await waitFor(() => subscriptions.getState().subscriptions.some((sub) => sub.id === followed.id && sub.initialized), 'JavTao actor check timed out');
	await waitFor(() => subscriptions.getState().entries.some((entry) => entry.imageAsset), 'JavTao update image was not cached', 30_000);
	await cancelImages();
	const sub = subscriptions.getState().subscriptions.find((sub) => sub.id === followed.id);
	assert.equal(sub.kind, 'performer_releases');
	const entries = subscriptions.getState().entries.filter((entry) => entry.subscriptionId === sub.id);
	assert.ok(entries.length > 0);
	const first = entries[0];
	await subscriptions.command({ action: 'read', ids: [first.id], read: true });
	const refreshed = await subscriptions.command({ action: 'check', id: sub.id });
	assert.equal(refreshed.ok, true);
	await waitFor(() => !!done(refreshed.id), 'JavTao repeat check timed out');
	assert.equal(done(refreshed.id).added, 0);
	assert.equal(subscriptions.getState().entries.length, entries.length);
	assert.equal(subscriptions.getState().entries.find((entry) => entry.id === first.id).read, true);
	const nativeLookup = await subscriptions.command({ action: 'lookup', provider: 'javtao', query: candidate.url });
	await waitFor(() => !!done(nativeLookup.id), 'JavTao homepage lookup timed out');
	assert.equal(done(nativeLookup.id).candidates[0].ref, candidate.ref);
	report.actor = {
		ref: sub.ref,
		kind: sub.kind,
		entries: entries.length,
		cachedImages: entries.filter((entry) => entry.imageAsset).length,
		deduplicated: true,
		readPreserved: true,
		hasAvatar: !!candidate.avatarUrl,
		coverage: sub.coverage,
	};
	report.checks.push(
		'real-name-and-native-profile-lookup',
		'follow-persisted-as-performer',
		'one-update-image-cached',
		'explicit-cover-cancel',
		'repeat-check-deduplicates-and-keeps-read',
	);

	console.log('JavTao: 作品详情磁链与缓存读取');
	const result = await magnets.search(randomUUID(), 'FSDSS-853', true, 'javtao');
	assert.equal(result.status, 'ready', 'JavTao magnet query failed');
	assert.ok(result.items.length > 0 && result.items.length <= 20);
	assert.ok(result.items.every((item) => item.url === 'https://javtao.com/fsdss-853' && item.seeders === null && item.leechers === null && item.completed === null));
	assert.ok(await magnets.row('FSDSS-853', result.items[0].id, 'javtao'));
	const reused = await magnets.search(randomUUID(), 'FSDSS-853', false, 'javtao');
	assert.equal(reused.checkedAt, result.checkedAt);
	report.magnets = { source: result.source, count: result.items.length, requests: result.requests, cacheReused: true, statisticsAbsent: true };
	report.checks.push('real-detail-magnets-and-cache', 'missing-statistics-not-zero');
	await subscriptions.stop();
	store.close();
	const restored = new SubscriptionStore(temporary, cipher);
	try {
		assert.equal(restored.subscriptions()[0].kind, 'performer_releases');
		assert.equal(restored.entries().find((entry) => entry.id === first.id).read, true);
		assert.ok(restored.tasks().some((task) => task.kind === 'covers' && task.status === 'cancelled' && task.cancelRequestedAt));
		report.checks.push('subscription-read-and-cancel-record-survive-reopen');
	} finally {
		restored.close();
	}
	report.status = 'passed';
} catch (error) {
	report.status = 'failed';
	report.failure = error.message;
	process.exitCode = 1;
} finally {
	await metadata.stop();
	await subscriptions.stop();
	await magnets.stop();
	await host.shutdown();
	if (store.db.isOpen) store.close();
	await mkdir(join(root, '.test-output/javtao'), { recursive: true });
	await writeFile(output, JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 2));
	await rm(temporary, { recursive: true, force: true });
}

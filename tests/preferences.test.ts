import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PREFERENCES, mergePreferences, preferencesPatchSchema } from '@shared/preferences';
import { SubscriptionStore } from '../src/main/subscription-store';
import { SubscriptionsService } from '../src/main/subscriptions-service';

test('局部设置只包含明确提交的字段，默认值和未知字段不会混入更新', () => {
	assert.deepEqual(preferencesPatchSchema.parse({ theme: 'night' }), { theme: 'night' });
	assert.deepEqual(preferencesPatchSchema.parse({}), {});
	assert.deepEqual(preferencesPatchSchema.parse({ querySources: [] }), { querySources: [] });
	assert.equal(preferencesPatchSchema.safeParse({ typo: true }).success, false);
	assert.equal(preferencesPatchSchema.safeParse({ theme: undefined }).success, false);
	assert.equal(preferencesPatchSchema.safeParse({ sourceTransports: { javdb: 'browser' } }).success, false);
	assert.equal(preferencesPatchSchema.safeParse({ magnetSearch: { maxResults: 50 } }).success, false);
});

test('设置合并保留嵌套字段和空选择，并校验合并后的代理配置', () => {
	const previous = {
		...structuredClone(DEFAULT_PREFERENCES),
		querySources: [],
		sourceTransports: { javdb: 'fingerprint' as const },
		magnetSearch: { enabled: false, maxResults: 5 as const, transport: 'fingerprint' as const },
	};
	const next = mergePreferences(previous, { theme: 'night', sourceTransports: { dmm: 'httpx' }, magnetSearch: { maxResults: 10 } });
	assert.equal(next.theme, 'night');
	assert.deepEqual(next.querySources, []);
	assert.deepEqual(next.sourceTransports, { javdb: 'fingerprint', dmm: 'httpx' });
	assert.deepEqual(next.magnetSearch, { enabled: false, maxResults: 10, transport: 'fingerprint' });
	assert.deepEqual(previous.magnetSearch, { enabled: false, maxResults: 5, transport: 'fingerprint' });
	assert.throws(() => mergePreferences(previous, { proxyMode: 'custom', proxyUrl: 'http://user:secret@localhost:7890' }));
});

test('并发设置与来源开关在主进程合并最新值，退出重开后保留且不启动采集', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-preferences-'));
	const cipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
	const store = new SubscriptionStore(root, cipher);
	let network = 0;
	const service = new SubscriptionsService(
		store,
		{
			run: async () => {
				network++;
				throw new Error('No network expected');
			},
		},
		async () => '',
		async () => {},
		0,
	);
	try {
		await service.initialize();
		const replies = await Promise.all([
			service.command({ action: 'preferences-patch', patch: { theme: 'night' } }),
			service.command({ action: 'query-sources', sources: [] }),
			service.command({ action: 'preferences-patch', patch: { magnetSearch: { maxResults: 5 } } }),
			service.command({ action: 'preferences-patch', patch: { magnetSearch: { transport: 'fingerprint' } } }),
			service.command({ action: 'preferences-patch', patch: { sourceTransports: { fc2ppvdb: 'browser' } } }),
			service.command({ action: 'preferences-patch', patch: { sourceTransports: { javdb: 'fingerprint' } } }),
			service.command({ action: 'source-enabled', source: 'fanbox', enabled: true }),
			service.command({ action: 'source-enabled', source: 'javdb', enabled: true }),
			service.command({ action: 'source-enabled', source: 'dmm', enabled: false }),
		]);
		assert.ok(replies.every((reply) => reply.ok));
		const saved = store.preferences();
		assert.equal(saved.theme, 'night');
		assert.deepEqual(saved.querySources, []);
		assert.deepEqual(saved.magnetSearch, { enabled: true, maxResults: 5, transport: 'fingerprint' });
		assert.equal(saved.sourceTransports.fc2ppvdb, 'browser');
		assert.equal(saved.sourceTransports.javdb, 'fingerprint');
		assert.ok(saved.enabledSources.includes('fanbox'));
		assert.ok(saved.enabledSources.includes('javdb'));
		assert.ok(!saved.enabledSources.includes('dmm'));
		const replacement = { ...saved, sourceTransports: {} };
		assert.equal((await service.command({ action: 'preferences', value: replacement })).ok, true);
		assert.deepEqual(store.preferences().sourceTransports, {});
		await service.stop();
		store.close();
		const reopened = new SubscriptionStore(root, cipher);
		assert.deepEqual(reopened.preferences(), replacement);
		reopened.close();
		assert.equal(network, 0);
	} finally {
		await service.stop();
		try {
			store.close();
		} catch {
			/* Already closed. */
		}
		await rm(root, { recursive: true, force: true });
	}
});

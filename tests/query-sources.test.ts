import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_PREFERENCES, preferencesSchema, querySourcesSchema } from '@shared/subscriptions';
import { DEFAULT_QUERY_SOURCES } from '@shared/sources';
import { SubscriptionStore } from '../src/main/features/subscriptions/subscription-store';
import { SubscriptionsService } from '../src/main/features/subscriptions/subscriptions-service';

test('旧设置补齐默认查询来源，空选择保留且只接受已登记的资料来源', () => {
	const { querySources: _old, ...legacy } = DEFAULT_PREFERENCES;
	assert.deepEqual(preferencesSchema.parse(legacy).querySources, DEFAULT_QUERY_SOURCES);
	assert.deepEqual(preferencesSchema.parse({ ...legacy, querySources: [] }).querySources, []);
	assert.equal(querySourcesSchema.safeParse(['fanbox']).success, false);
	assert.equal(querySourcesSchema.safeParse(['dmm', 'dmm']).success, false);
	assert.equal(querySourcesSchema.safeParse(['unknown']).success, false);
});

test('来源选择独立更新并在重启后保留，不覆盖来源开关、采用顺序或其他设置', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-query-sources-'));
	const cipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
	const store = new SubscriptionStore(root, cipher);
	let calls = 0;
	const service = new SubscriptionsService(
		store,
		{
			run: async () => {
				calls++;
				throw new Error('No network expected');
			},
		},
		async () => '',
		async () => {},
		0,
	);
	try {
		const baseline = { ...store.preferences(), theme: 'night' as const };
		store.savePreferences(baseline);
		assert.equal((await service.command({ action: 'query-sources', sources: ['javdb', 'fc2'] })).ok, true);
		assert.deepEqual(store.preferences(), { ...baseline, querySources: ['javdb', 'fc2'] });
		assert.deepEqual(service.getState().preferences.querySources, ['javdb', 'fc2']);
		assert.equal((await service.command({ action: 'preferences', value: { ...store.preferences(), enabledSources: ['fc2'] } })).ok, true);
		assert.deepEqual(store.preferences().querySources, ['javdb', 'fc2']);
		assert.equal((await service.command({ action: 'query-sources', sources: [] })).ok, true);
		await service.stop();
		store.close();
		const reopened = new SubscriptionStore(root, cipher);
		assert.deepEqual(reopened.preferences().querySources, []);
		assert.deepEqual(reopened.preferences().enabledSources, ['fc2']);
		assert.deepEqual(reopened.preferences().metadataPriority, baseline.metadataPriority);
		assert.equal(reopened.preferences().theme, 'night');
		reopened.close();
		assert.equal(calls, 0);
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

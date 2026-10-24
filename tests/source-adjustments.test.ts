import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, storedPreferencesSchema } from '@shared/preferences';
import { METADATA_IDS, SOURCES } from '@shared/sources';
import { COVER_SOURCE_IDS } from '@shared/cover-sources';
import { queryRequestSchema } from '@shared/metadata';
import { allowedSourceUrl } from '@shared/source-identity';

test('FC2CMADB 退出新查询与封面配置，旧设置剔除此来源而保留其他选择', () => {
	assert.equal(
		SOURCES.some((source) => String(source.id) === 'fc2cmadb'),
		false,
	);
	assert.equal((METADATA_IDS as readonly string[]).includes('fc2cmadb'), false);
	assert.equal((COVER_SOURCE_IDS as readonly string[]).includes('fc2cmadb'), false);
	assert.equal(queryRequestSchema.safeParse({ query: 'FC2-PPV-1234567', sources: ['fc2cmadb'] }).success, false);
	assert.equal(allowedSourceUrl('fc2cmadb', 'https://fc2cmadb.com/article/1234567'), 'https://fc2cmadb.com/article/1234567');
	assert.equal(allowedSourceUrl('fc2cmadb', 'https://fc2cmadb.com/cover.jpg', 'image'), undefined);
	const saved = storedPreferencesSchema.parse({
		...DEFAULT_PREFERENCES,
		enabledSources: ['fc2cmadb', 'javten'],
		querySources: ['fc2cmadb', 'javten'],
		metadataPriority: ['fc2cmadb', 'dmm', 'javten'],
		coverPriority: ['fc2cmadb', 'dmm'],
		sourceTransports: { fc2cmadb: 'fingerprint', javten: 'httpx' },
	});
	assert.deepEqual(saved.enabledSources, ['javten']);
	assert.deepEqual(saved.querySources, ['javten']);
	assert.deepEqual(saved.metadataPriority.slice(0, 2), ['dmm', 'javten']);
	assert.deepEqual(saved.coverPriority, ['dmm']);
	assert.deepEqual(saved.sourceTransports, { javten: 'httpx' });
});

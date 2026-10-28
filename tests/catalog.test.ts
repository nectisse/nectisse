import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_PREFERENCES } from '../src/shared/preferences';
import { SOURCES, METADATA_IDS, FOLLOW_IDS, DEFAULT_METADATA_ORDER, LEGACY_METADATA_IDS } from '../src/shared/sources';

test('Rust 与 React 使用相同的来源、默认设置和优先级', async () => {
	const bundled = JSON.parse(await readFile(new URL('../src-tauri/resources/catalog.json', import.meta.url), 'utf8'));
	const expected = {
		preferences: DEFAULT_PREFERENCES,
		sources: SOURCES,
		metadataIds: METADATA_IDS,
		followIds: FOLLOW_IDS,
		metadataOrder: DEFAULT_METADATA_ORDER,
		legacyIds: LEGACY_METADATA_IDS,
	};
	assert.deepEqual(bundled, JSON.parse(JSON.stringify(expected)));
});

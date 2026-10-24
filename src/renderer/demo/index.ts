import type { Preferences } from '@shared/preferences';
import type { ImageUrl } from '@/shared/desktop';
import { createDemoBridge } from './bridge';
import { createDemoFixtures } from './fixtures';
import portrait1 from './assets/portrait-1.jpg';
import portrait2 from './assets/portrait-2.jpg';
import portrait3 from './assets/portrait-3.jpg';
import portrait4 from './assets/portrait-4.jpg';
import portrait5 from './assets/portrait-5.jpg';
import portrait6 from './assets/portrait-6.jpg';

export function createDemoSession(theme: Preferences['theme']) {
	const portraits = [portrait1, portrait2, portrait3, portrait4, portrait5, portrait6];
	const fixture = createDemoFixtures(theme);
	const aliases = new Map<string, string>();
	for (const cover of fixture.metadata.tasks.flatMap((task) => task.records).flatMap((record) => record.covers)) {
		if (cover.asset) {
			aliases.set(cover.id, cover.asset.sha256);
		}
	}
	for (const entry of fixture.subscriptions.entries) {
		if (entry.imageAsset) {
			aliases.set(entry.id, entry.imageAsset.sha256);
		}
	}
	const imageUrl: ImageUrl = (_scope, hash) => portraits[Number.parseInt(aliases.get(hash) ?? hash, 16) - 1] ?? '';
	return { bridge: createDemoBridge(theme), imageUrl };
}

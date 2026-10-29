import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useQuery } from '@tanstack/react-query';
import type { EntryDetailReply, FeedEntry, SubscriptionsState } from '@shared/subscriptions';
import type { Preferences } from '@shared/preferences';
import type { LibraryState } from '@shared/library';
import type { MetadataState } from '@shared/metadata';
import type { DesktopState } from './desktop';
import { useDesktop } from './context';

export function useDesktopActions(): DesktopState['actions'] {
	return useDesktop().actions;
}

export function useEntryDetail(entry?: FeedEntry) {
	const { getEntry } = useDesktopActions();
	return useQuery({
		queryKey: ['entry-detail', entry?.id],
		enabled: !!entry,
		queryFn: async () => (await getEntry(entry!.id)) ?? { entry: entry! },
		select: (reply: EntryDetailReply) => (entry?.images ? { ...reply, entry: { ...reply.entry, images: entry.images }, warning: undefined } : reply),
		staleTime: 5 * 60 * 1000,
		retry: false,
	});
}

export function useSubscriptions<T>(selector: (state: SubscriptionsState) => T): T {
	return useStore(
		useDesktop().subscriptions,
		useShallow((state) => selector(state.snapshot)),
	);
}

export function usePreferences<T>(selector: (state: Preferences) => T): T {
	return useSubscriptions((state) => selector(state.preferences));
}

export function useSubscriptionStatus() {
	return useStore(
		useDesktop().subscriptions,
		useShallow(({ error, reading }) => ({ error, reading })),
	);
}

export function useLibrary<T>(selector: (state: LibraryState) => T): T {
	return useStore(
		useDesktop().library,
		useShallow((state) => selector(state.snapshot)),
	);
}

export function useLibraryStatus() {
	return useStore(
		useDesktop().library,
		useShallow(({ error, reading }) => ({ error, loading: reading })),
	);
}

export function useMetadata<T>(selector: (state: MetadataState) => T): T {
	return useStore(
		useDesktop().metadata,
		useShallow((state) => selector(state.snapshot)),
	);
}

export function useMetadataStatus() {
	return useStore(
		useDesktop().metadata,
		useShallow(({ error, reading }) => ({ error, reading })),
	);
}

export function useRuntime() {
	return useStore(
		useDesktop().runtime,
		useShallow(({ snapshot, error }) => ({ runtime: snapshot, bridgeError: !!error })),
	);
}

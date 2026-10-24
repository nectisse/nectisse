import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { DesktopBridge } from '@shared/protocol';
import type { SubscriptionsState } from '@shared/subscriptions';
import type { Preferences } from '@shared/preferences';
import type { LibraryState } from '@shared/library';
import type { MetadataState } from '@shared/metadata';
import { createDesktopState, type DesktopState } from './desktop';

const Context = createContext<DesktopState | null>(null);

export function DesktopProvider({ bridge, children }: { bridge: DesktopBridge | undefined; children: ReactNode }): React.JSX.Element {
	const [desktop] = useState(() => createDesktopState(bridge));
	useEffect(() => desktop.connect(), [desktop]);
	return <Context.Provider value={desktop}>{children}</Context.Provider>;
}

function useDesktop(): DesktopState {
	const desktop = useContext(Context);
	if (!desktop) {
		throw new Error('DesktopProvider missing');
	}
	return desktop;
}

export function useDesktopActions(): DesktopState['actions'] {
	return useDesktop().actions;
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

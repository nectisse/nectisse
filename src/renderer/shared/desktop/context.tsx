import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { DesktopBridge } from '@shared/protocol';
import { createDesktopState, type DesktopState } from './desktop';

const Context = createContext<DesktopState | null>(null);

export function DesktopProvider({ bridge, children }: { bridge: DesktopBridge | undefined; children: ReactNode }): React.JSX.Element {
	const [desktop] = useState(() => createDesktopState(bridge));
	useEffect(() => desktop.connect(), [desktop]);
	return (
		<Context.Provider value={desktop}>
			<QueryClientProvider client={desktop.queries.client}>{children}</QueryClientProvider>
		</Context.Provider>
	);
}

export function useDesktop(): DesktopState {
	const desktop = useContext(Context);
	if (!desktop) {
		throw new Error('DesktopProvider missing');
	}
	return desktop;
}

import { useEffect, useState } from 'react';
import type { RuntimeState } from '../../shared/protocol';
import { Workspace } from './subscriptions/Workspace';
import { SubscriptionsProvider, useSubscriptions } from './subscriptions/context';
import { LibraryProvider } from './library/context';
import { Toaster } from '@/components/ui/sonner';

function AppToaster(): React.JSX.Element {
	const { state } = useSubscriptions();
	return <Toaster theme={state.preferences.theme === 'night' ? 'dark' : 'light'} />;
}

export default function App(): React.JSX.Element {
	const [runtime, setRuntime] = useState<RuntimeState>({ phase: 'starting', revision: 0, message: '正在准备采集环境' });
	const [bridgeError, setBridgeError] = useState(false);

	useEffect(() => {
		let mounted = true;

		const apply = (state: RuntimeState): void => {
			if (mounted) {
				setRuntime((previous) => (state.revision >= previous.revision ? state : previous));
				setBridgeError(false);
			}
		};

		if (!window.nectisse) {
			setBridgeError(true);
			return;
		}
		const unsubscribe = window.nectisse.runtime.onState(apply);
		void window.nectisse.runtime
			.getState()
			.then(apply)
			.catch(() => {
				if (mounted) {
					setBridgeError(true);
				}
			});
		return () => {
			mounted = false;
			unsubscribe();
		};
	}, []);

	const retry = (): void => {
		const bridge = window.nectisse?.runtime;
		if (!bridge) {
			setBridgeError(true);
			return;
		}
		void bridge
			.retry()
			.then(setRuntime)
			.catch(() => setBridgeError(true));
	};

	return (
		<SubscriptionsProvider>
			<LibraryProvider>
				<Workspace runtime={runtime} bridgeError={bridgeError} onRetry={retry} />
				<AppToaster />
			</LibraryProvider>
		</SubscriptionsProvider>
	);
}

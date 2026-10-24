import { DesktopProvider, useDesktopActions, usePreferences, useRuntime } from '@/shared/desktop';
import { Workspace } from './ui/Workspace';
import { Toaster } from '@/shared/ui/sonner';

function DesktopWorkspace(): React.JSX.Element {
	const { runtime, bridgeError } = useRuntime();
	const actions = useDesktopActions();
	return (
		<Workspace
			runtime={runtime}
			bridgeError={bridgeError}
			onRetry={() => {
				void actions.reloadRuntime();
			}}
		/>
	);
}

function AppToaster(): React.JSX.Element {
	const theme = usePreferences((state) => state.theme);
	return <Toaster theme={theme === 'night' ? 'dark' : 'light'} />;
}

export default function App(): React.JSX.Element {
	return (
		<DesktopProvider bridge={window.nectisse}>
			<DesktopWorkspace />
			<AppToaster />
		</DesktopProvider>
	);
}

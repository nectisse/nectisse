import { useCallback, useEffect, useState } from 'react';
import { DesktopProvider, useDesktopActions, usePreferences, useRuntime } from '@/shared/desktop';
import { createDemoSession } from '@/demo';
import { Workspace } from './ui/Workspace';
import { createWorkspaceNavigation, type WorkspaceNavigation } from './ui/workspace-navigation';
import { Toaster } from '@/shared/ui/sonner';

function DesktopWorkspace(props: Omit<Parameters<typeof Workspace>[0], 'runtime' | 'bridgeError' | 'onRetry'>): React.JSX.Element {
	const { runtime, bridgeError } = useRuntime();
	const actions = useDesktopActions();
	return (
		<Workspace
			{...props}
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

function WorkspaceSession(): React.JSX.Element {
	const theme = usePreferences((state) => state.theme);
	const actions = useDesktopActions();
	const [demo, setDemo] = useState<ReturnType<typeof createDemoSession> & { id: string }>();
	const [liveNavigation, setLiveNavigation] = useState(createWorkspaceNavigation);
	const [demoNavigation, setDemoNavigation] = useState(createWorkspaceNavigation);

	const navigateLive = useCallback((patch: Partial<WorkspaceNavigation>): void => {
		setLiveNavigation((previous) => ({ ...previous, ...patch }));
	}, []);

	const navigateDemo = useCallback((patch: Partial<WorkspaceNavigation>): void => {
		setDemoNavigation((previous) => ({ ...previous, ...patch }));
	}, []);

	const exitDemo = useCallback((): void => {
		setDemo(undefined);
		requestAnimationFrame(() => document.getElementById('open-visual-demo')?.focus({ preventScroll: true }));
	}, []);

	const startDemo = (): void => {
		setDemoNavigation(createWorkspaceNavigation());
		setDemo({ ...createDemoSession(theme), id: crypto.randomUUID() });
	};

	useEffect(
		() =>
			actions.onSettings(() => {
				setDemo(undefined);
				navigateLive({ page: 'settings', scrollTop: 0 });
			}),
		[actions, navigateLive],
	);

	// 真实数据上下文持续连接；示例数据及查询缓存归独立的内存会话。
	return demo ? (
		<DesktopProvider key={demo.id} bridge={demo.bridge} imageUrl={demo.imageUrl}>
			<DesktopWorkspace navigation={demoNavigation} onNavigate={navigateDemo} onDemo={startDemo} onExitDemo={exitDemo} />
			<AppToaster />
		</DesktopProvider>
	) : (
		<>
			<DesktopWorkspace navigation={liveNavigation} onNavigate={navigateLive} onDemo={startDemo} />
			<AppToaster />
		</>
	);
}

export default function App(): React.JSX.Element {
	return (
		<DesktopProvider bridge={window.nectisse}>
			<WorkspaceSession />
		</DesktopProvider>
	);
}

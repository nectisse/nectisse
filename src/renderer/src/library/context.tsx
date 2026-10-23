import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LibraryState } from '../../../shared/library';

const Context = createContext<{ state: LibraryState; loading: boolean; error: string; reload: () => Promise<void> } | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }): React.JSX.Element {
	const [state, setState] = useState<LibraryState>({ revision: 0, works: [] });
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const epoch = useRef(0);

	const load = useCallback(async (retry = false): Promise<void> => {
		const token = ++epoch.current;
		const bridge = window.nectisse?.library;
		if (!bridge) {
			setError('收藏通信未就绪，请重新打开应用');
			setLoading(false);
			return;
		}
		setLoading(true);
		setError('');
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const next = await Promise.race([
				retry ? bridge.retry() : bridge.getState(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('timeout')), 5000);
				}),
			]);
			if (epoch.current === token) {
				setState((previous) => (next.revision >= previous.revision ? next : previous));
			}
		} catch {
			if (epoch.current === token) {
				setError('作品收藏暂未就绪，原有收藏已保留。请重新检查本机收藏库。');
			}
		} finally {
			clearTimeout(timer);
			if (epoch.current === token) {
				setLoading(false);
			}
		}
	}, []);

	useEffect(() => {
		const bridge = window.nectisse?.library;
		if (!bridge) {
			void load();
			return;
		}

		const unsubscribe = bridge.onState((next) => {
			// 新推送使此前读取失效，防止迟到的失败覆盖已恢复的收藏状态。
			epoch.current++;
			setState((previous) => (next.revision >= previous.revision ? next : previous));
			setError('');
			setLoading(false);
		});

		void load();
		return () => {
			epoch.current++;
			unsubscribe();
		};
	}, [load]);

	return <Context.Provider value={{ state, loading, error, reload: () => load(true) }}>{children}</Context.Provider>;
}

export function useLibrary(): NonNullable<React.ContextType<typeof Context>> {
	const context = useContext(Context);
	if (!context) {
		throw new Error('LibraryProvider missing');
	}
	return context;
}

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_PREFERENCES, type SubscriptionsState, type FollowCommand, type CommandReply } from '../../../shared/subscriptions';
import { SubscriptionStateReader } from './state-reader';
const initial: SubscriptionsState = {
	revision: 0,
	preferences: DEFAULT_PREFERENCES,
	subscriptions: [],
	entries: [],
	tasks: [],
	sources: [],
	encryptionAvailable: false,
	notice: '',
};
const Context = createContext<{
	state: SubscriptionsState;
	invoke: (command: FollowCommand) => Promise<CommandReply>;
	error: string;
	reading: boolean;
	reload: () => Promise<void>;
}>({ state: initial, invoke: async () => ({ ok: false, message: '应用通信未就绪' }), error: '', reading: true, reload: async () => {} });

export function SubscriptionsProvider({ children }: { children: ReactNode }): React.JSX.Element {
	const [state, setState] = useState(initial);
	const [error, setError] = useState('');
	const [reading, setReading] = useState(true);
	const reader = useRef<SubscriptionStateReader | null>(null);

	const reload = useCallback(async (): Promise<void> => {
		await reader.current?.refresh(true);
	}, []);

	useEffect(() => {
		if (!window.nectisse?.subscriptions) {
			setError('订阅通信未就绪，请重新打开应用');
			setReading(false);
			return;
		}
		const current = new SubscriptionStateReader(window.nectisse.subscriptions, {
			state: (value) => setState((previous) => (value.revision >= previous.revision ? value : previous)),

			error: setError,
			reading: setReading,

			failure: (code) => {
				void window.nectisse.diagnostics?.recordReadFailure(code).catch(() => {});
			},
		});
		reader.current = current;
		void current.refresh();
		return () => {
			current.dispose();
			if (reader.current === current) {
				reader.current = null;
			}
		};
	}, []);

	const invoke = async (command: FollowCommand): Promise<CommandReply> => {
		try {
			return await window.nectisse.subscriptions.command(command);
		} catch {
			return { ok: false, message: '应用通信或存储操作未完成，请重试' };
		}
	};

	return <Context.Provider value={{ state, invoke, error, reading, reload }}>{children}</Context.Provider>;
}

export const useSubscriptions = () => useContext(Context);

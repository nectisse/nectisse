import { createStore } from 'zustand/vanilla';

export interface SnapshotState<T> {
	snapshot: T;
	reading: boolean;
	error: string;
}

// IPC 传输的是 JSON 快照；复用未变化的分支，避免无关推送触发 selector。
export function reconcile<T>(previous: T, next: T): T {
	if (Object.is(previous, next)) {
		return previous;
	}
	if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object' || Array.isArray(previous) !== Array.isArray(next)) {
		return next;
	}
	const before = previous as Record<string, unknown>;
	const after = next as Record<string, unknown>;
	const keys = Object.keys(after);
	let changed = Object.keys(before).length !== keys.length;
	const result: Record<string, unknown> = Array.isArray(next) ? ([] as unknown as Record<string, unknown>) : {};
	for (const key of keys) {
		result[key] = reconcile(before[key], after[key]);
		changed ||= !Object.hasOwn(before, key) || result[key] !== before[key];
	}
	return changed ? (result as T) : previous;
}

export function createSnapshot<T extends { revision: number }>(initial: T) {
	const store = createStore<SnapshotState<T>>(() => ({ snapshot: initial, reading: true, error: '' }));

	const accept = (snapshot: T): boolean => {
		if (snapshot.revision < store.getState().snapshot.revision) {
			return false;
		}
		store.setState((state) => ({ snapshot: reconcile(state.snapshot, snapshot), error: '', reading: false }));
		return true;
	};

	return { store, accept };
}

interface SnapshotBridge<T> {
	getState: () => Promise<T>;
	retry?: () => Promise<T>;
	onState: (callback: (snapshot: T) => void) => () => void;
}

export function connectSnapshot<T extends { revision: number }>(
	model: ReturnType<typeof createSnapshot<T>>,
	bridge: SnapshotBridge<T> | undefined,
	message: string,
	timeoutMs = 5000,
) {
	let epoch = 0;
	let disposed = false;
	let abort: (() => void) | undefined;

	const refresh = async (recover = false): Promise<void> => {
		const token = ++epoch;
		abort?.();
		if (disposed) {
			return;
		}
		model.store.setState({ reading: true, error: '' });
		try {
			if (!bridge) {
				throw new Error('BRIDGE_UNAVAILABLE');
			}
			const next = await new Promise<T>((resolve, reject) => {
				let settled = false;
				const finish = (value?: T, error?: Error): void => {
					if (settled) {
						return;
					}
					settled = true;
					clearTimeout(timer);
					if (error) {
						reject(error);
					} else {
						resolve(value!);
					}
				};

				const timer = setTimeout(() => finish(undefined, new Error('READ_TIMEOUT')), timeoutMs);
				abort = () => finish(undefined, new Error('READ_SUPERSEDED'));
				void Promise.resolve()
					.then(() => {
						if (disposed || token !== epoch) {
							throw new Error('READ_SUPERSEDED');
						}
						return recover && bridge.retry ? bridge.retry() : bridge.getState();
					})
					.then(
						(value) => finish(value),
						() => finish(undefined, new Error('READ_FAILED')),
					);
			});
			if (!disposed && token === epoch) {
				model.accept(next);
			}
		} catch {
			if (!disposed && token === epoch) {
				model.store.setState({ error: message });
			}
		} finally {
			if (!disposed && token === epoch) {
				abort = undefined;
				model.store.setState({ reading: false });
			}
		}
	};

	const unsubscribe = bridge?.onState((snapshot) => {
		if (!disposed && model.accept(snapshot)) {
			epoch++;
			abort?.();
			abort = undefined;
		}
	});
	void refresh();
	return {
		refresh,
		dispose: (): void => {
			disposed = true;
			epoch++;
			abort?.();
			unsubscribe?.();
		},
	};
}

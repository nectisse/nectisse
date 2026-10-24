import type { DesktopBridge, RuntimeState } from '@shared/protocol';
import type { MetadataState } from '@shared/metadata';
import type { LibraryState } from '@shared/library';
import type { FollowCommand, CommandReply, SubscriptionsState } from '@shared/subscriptions';
import { DEFAULT_PREFERENCES, type PreferencesPatch } from '@shared/preferences';
import { createSnapshot, connectSnapshot } from './snapshot';
import { SubscriptionStateReader } from './subscription-reader';

export function createDesktopState(bridge: DesktopBridge | undefined) {
	const subscriptions = createSnapshot<SubscriptionsState>({
		revision: 0,
		preferences: structuredClone(DEFAULT_PREFERENCES),
		subscriptions: [],
		entries: [],
		tasks: [],
		sources: [],
		encryptionAvailable: false,
		notice: '',
	});
	const metadata = createSnapshot<MetadataState>({ revision: 0, tasks: [] });
	const library = createSnapshot<LibraryState>({ revision: 0, works: [] });
	const runtime = createSnapshot<RuntimeState>({ revision: 0, phase: 'starting', message: '正在准备采集环境' });
	let users = 0;
	let reader: SubscriptionStateReader | undefined;
	let connections: Partial<Record<'library' | 'metadata' | 'runtime', ReturnType<typeof connectSnapshot>>> = {};

	const required = (): DesktopBridge => {
		if (!bridge) {
			throw new Error('应用通信未就绪');
		}
		return bridge;
	};

	const invoke = async (command: FollowCommand): Promise<CommandReply> => {
		try {
			return await required().subscriptions.command(command);
		} catch {
			return { ok: false, message: '应用通信或存储操作未完成，请重试' };
		}
	};

	const refresh = async (domain: 'library' | 'metadata' | 'runtime'): Promise<void> => {
		await connections[domain]?.refresh(true);
	};

	const actions = {
		invoke,
		updatePreferences: (patch: PreferencesPatch) => invoke({ action: 'preferences-patch', patch }),

		reloadSubscriptions: async (): Promise<void> => {
			await reader?.refresh(true);
		},
		reloadLibrary: () => refresh('library'),

		reloadMetadata: () => refresh('metadata'),
		reloadRuntime: () => refresh('runtime'),

		onSettings: (callback: () => void) => bridge?.subscriptions.onSettings(callback) ?? (() => {}),
		metadata: {
			query: async (...args: Parameters<DesktopBridge['metadata']['query']>) => required().metadata.query(...args),

			cancel: async (id: string) => required().metadata.cancel(id),
			openSource: async (taskId: string, recordId: string) => required().metadata.openSource(taskId, recordId),
		},
		library: {
			getWork: async (id: string) => required().library.getWork(id),

			save: async (...args: Parameters<DesktopBridge['library']['save']>) => required().library.save(...args),
			remove: async (id: string) => required().library.remove(id),

			openSource: async (id: string, recordId: string) => required().library.openSource(id, recordId),
		},
		magnets: {
			search: async (...args: Parameters<DesktopBridge['magnets']['search']>) => required().magnets.search(...args),

			cancel: async (id: string) => required().magnets.cancel(id),
			action: async (...args: Parameters<DesktopBridge['magnets']['action']>) => required().magnets.action(...args),
		},
		diagnostics: {
			getReport: async () => required().diagnostics.getReport(),

			copyReport: async () => required().diagnostics.copyReport(),
		},
	};

	const connect = (): (() => void) => {
		if (users++ === 0) {
			connections = {
				library: connectSnapshot(library, bridge?.library, '作品收藏暂未就绪，原有收藏已保留。请重新检查本机收藏库。'),
				metadata: connectSnapshot(metadata, bridge?.metadata, '资料查询服务暂未就绪，请重新检查。'),
				runtime: connectSnapshot(runtime, bridge?.runtime, '采集环境通信暂未就绪，请重新检查。'),
			};
			if (bridge?.subscriptions) {
				reader = new SubscriptionStateReader(bridge.subscriptions, {
					state: (value) => {
						subscriptions.accept(value);
					},
					error: (error) => subscriptions.store.setState({ error }),

					reading: (reading) => subscriptions.store.setState({ reading }),
					failure: (code) => {
						void bridge.diagnostics.recordReadFailure(code).catch(() => {});
					},
				});
				void reader.refresh();
			} else {
				subscriptions.store.setState({ error: '订阅通信未就绪，请重新打开应用', reading: false });
			}
		}
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			if (--users === 0) {
				reader?.dispose();
				reader = undefined;
				for (const connection of Object.values(connections)) {
					connection.dispose();
				}
				connections = {};
			}
		};
	};

	return { subscriptions: subscriptions.store, metadata: metadata.store, library: library.store, runtime: runtime.store, actions, connect };
}

export type DesktopState = ReturnType<typeof createDesktopState>;

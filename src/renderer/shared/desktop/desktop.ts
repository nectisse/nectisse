import type { DesktopBridge, RuntimeState } from '@shared/protocol';
import type { MetadataState } from '@shared/metadata';
import type { LibraryState } from '@shared/library';
import type { FollowCommand, CommandReply, SubscriptionsState } from '@shared/subscriptions';
import { DEFAULT_PREFERENCES, type PreferencesPatch } from '@shared/preferences';
import { createSnapshot, connectSnapshot } from './snapshot';
import { SubscriptionStateReader } from './subscription-reader';
import { createDesktopQueries } from './queries';

export type ImageScope = 'image' | 'library' | 'updates' | 'avatars';
export type ImageUrl = (scope: ImageScope, hash: string, variant?: 'thumbnail' | 'original') => string;

export function createDesktopState(
	bridge: DesktopBridge | undefined,
	imageUrl: ImageUrl = (scope, hash, variant = 'thumbnail') => `nectisse-cover://${scope}/${hash}?variant=${variant}`,
) {
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
	let unsubscribeQueries: (() => void) | undefined;

	const required = (): DesktopBridge => {
		if (!bridge) {
			throw new Error('应用通信未就绪');
		}
		return bridge;
	};
	const queries = createDesktopQueries(required);

	const invoke = async (command: FollowCommand): Promise<CommandReply> => {
		try {
			const reply = await required().subscriptions.command(command);
			if (reply.ok && command.action === 'retry-images') {
				const id = command.subscriptionId;
				void queries.client.invalidateQueries({ queryKey: ['subscriptions'], predicate: (query) => !id || query.queryKey[2] === id });
			}
			return reply;
		} catch {
			return { ok: false, message: '应用通信或存储操作未完成，请重试' };
		}
	};

	const refresh = async (domain: 'library' | 'metadata' | 'runtime'): Promise<void> => {
		await connections[domain]?.refresh(true);
	};

	const actions = {
		invoke,
		markRead: async (ids: string[], read: boolean) => {
			let processed = 0;
			for (let start = 0; start < ids.length; start += 500) {
				const reply = await invoke({ action: 'read', ids: ids.slice(start, start + 500), read });
				if (!reply.ok) {
					return { ...reply, processed };
				}
				processed += Math.min(500, ids.length - start);
			}
			return { ok: true, processed };
		},
		imageUrl,
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

			clearHistory: async () => required().metadata.clearHistory(),

			cancel: async (id: string) => required().metadata.cancel(id),
			openSource: async (taskId: string, recordId: string) => required().metadata.openSource(taskId, recordId),
		},
		library: {
			openSource: async (id: string, recordId: string) => required().library.openSource(id, recordId),
		},
		magnets: {
			cancel: async (id: string) => required().magnets.cancel(id),
			action: async (...args: Parameters<DesktopBridge['magnets']['action']>) => required().magnets.action(...args),

			openSite: async (...args: Parameters<DesktopBridge['magnets']['openSite']>) => required().magnets.openSite(...args),
		},
	};

	const connect = (): (() => void) => {
		if (users++ === 0) {
			const unsubscribeLibrary = library.store.subscribe((next, previous) => {
				if (next.snapshot !== previous.snapshot) {
					void queries.syncLibrary(previous.snapshot, next.snapshot);
				}
			});
			const unsubscribeSubscriptions = subscriptions.store.subscribe((next, previous) => {
				if (next.snapshot !== previous.snapshot) {
					void queries.syncSubscriptions(previous.snapshot, next.snapshot);
				}
			});
			unsubscribeQueries = () => {
				unsubscribeLibrary();
				unsubscribeSubscriptions();
			};
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
				unsubscribeQueries?.();
				unsubscribeQueries = undefined;
				queries.cancelReads();
				reader?.dispose();
				reader = undefined;
				for (const connection of Object.values(connections)) {
					connection.dispose();
				}
				connections = {};
			}
		};
	};

	return { subscriptions: subscriptions.store, metadata: metadata.store, library: library.store, runtime: runtime.store, actions, queries, connect };
}

export type DesktopState = ReturnType<typeof createDesktopState>;

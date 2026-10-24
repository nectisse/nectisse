import { QueryClient, infiniteQueryOptions, mutationOptions, queryOptions, type InfiniteData } from '@tanstack/react-query';
import type { EntryPage, EntryPageRequest, SubscriptionsState } from '@shared/subscriptions';
import type { DesktopBridge } from '@shared/protocol';
import type { LibrarySave, LibraryState, SavedWork } from '@shared/library';
import type { MagnetBridge } from '@shared/magnets';
import type { DiagnosticReport } from '@shared/diagnostics';
import { readLocal } from './local-read';
import { reconcile } from './snapshot';

export const queryKeys = {
	work: (id: string) => ['library', 'work', id] as const,
	diagnostics: ['diagnostics', 'report'] as const,
	storage: ['storage', 'usage'] as const,
	entries: (id: string, unread: boolean, page: number) => ['subscriptions', 'entries', id, unread, page] as const,
	stream: (id: string, unread: boolean) => ['subscriptions', 'stream', id, unread] as const,
};

function latestReport(previous: DiagnosticReport | undefined, next: DiagnosticReport): DiagnosticReport {
	return previous && Date.parse(previous.generatedAt) > Date.parse(next.generatedAt) ? previous : next;
}

export function createDesktopQueries(required: () => DesktopBridge) {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: Infinity,
				gcTime: 5 * 60_000,
				retry: false,
				networkMode: 'always',
				refetchOnWindowFocus: false,
				refetchOnReconnect: false,
			},
			mutations: { retry: false, networkMode: 'always', gcTime: 0 },
		},
	});
	const changes = new Map<string, symbol>();
	const subscriptionChanges = new Map<string, symbol>();
	let reportSequence = 0;

	const entryPage = (request: EntryPageRequest, signal: AbortSignal): Promise<EntryPage> =>
		readLocal(async () => {
			const bridge = required().subscriptions;
			if (!bridge.getEntries) {
				throw new Error('人物记录读取接口未就绪，请退出后重新打开应用');
			}
			return bridge.getEntries(request);
		}, signal);

	const syncSubscriptions = async (before: SubscriptionsState, after: SubscriptionsState): Promise<void> => {
		const entries = new Map(after.entries.map((entry) => [entry.id, entry]));
		client.setQueriesData<EntryPage | InfiniteData<EntryPage, number>>({ queryKey: ['subscriptions'] }, (previous) => {
			if (!previous) {
				return previous;
			}
			const patch = (page: EntryPage): EntryPage => ({ ...page, entries: page.entries.map((entry) => entries.get(entry.id) ?? entry) });
			return 'pages' in previous ? { ...previous, pages: previous.pages.map(patch) } : patch(previous);
		});
		const previous = new Map(before.subscriptions.map((sub) => [sub.id, sub]));
		const oldTasks = new Map(before.tasks.map((task) => [task.id, task]));
		const finished = new Set(
			after.tasks
				.filter((task) => task.subscriptionId && !['running', 'cancelling'].includes(task.status) && oldTasks.get(task.id)?.status !== task.status)
				.map((task) => task.subscriptionId),
		);
		await Promise.all(
			after.subscriptions
				.filter((sub) => {
					const old = previous.get(sub.id);
					return (
						!old ||
						finished.has(sub.id) ||
						old.collected !== sub.collected ||
						old.unread !== sub.unread ||
						old.lastCheckedAt !== sub.lastCheckedAt ||
						old.lastError !== sub.lastError ||
						old.following !== sub.following ||
						old.enabled !== sub.enabled ||
						old.autoPaused !== sub.autoPaused
					);
				})
				.map(async (sub) => {
					const change = Symbol();
					subscriptionChanges.set(sub.id, change);
					const filters = { queryKey: ['subscriptions'], predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[2] === sub.id };
					await client.cancelQueries(filters);
					if (subscriptionChanges.get(sub.id) !== change) {
						return;
					}
					await client.invalidateQueries(filters);
					if (subscriptionChanges.get(sub.id) === change) {
						subscriptionChanges.delete(sub.id);
					}
				}),
		);
	};

	const work = (id: string) =>
		queryOptions({
			queryKey: queryKeys.work(id),
			enabled: !!id,
			queryFn: ({ signal }) => readLocal(async () => (await required().library.getWork(id)) ?? null, signal),
		});

	const diagnostics = (open: boolean) =>
		queryOptions({
			queryKey: queryKeys.diagnostics,
			enabled: open,
			staleTime: 0,
			gcTime: 0,
			queryFn: async ({ signal }) => {
				const request = ++reportSequence;
				const report = await readLocal(() => required().diagnostics.getReport(), signal);
				const cached = client.getQueryData<DiagnosticReport>(queryKeys.diagnostics);
				return request === reportSequence ? latestReport(cached, report) : (cached ?? report);
			},
		});

	// 按作品身份对照已核验的摘要；排序变化不使未修改的详情失效。
	const syncLibrary = async (before: LibraryState, after: LibraryState): Promise<void> => {
		const previous = new Map(before.works.map((item) => [item.id, item]));
		const next = new Map(after.works.map((item) => [item.id, item]));
		const ids = new Set([...previous.keys(), ...next.keys()]);
		await Promise.all(
			[...ids].map(async (id) => {
				const queryKey = queryKeys.work(id);
				if (reconcile(previous.get(id), next.get(id)) === previous.get(id) || !client.getQueryState(queryKey)) {
					return;
				}
				const change = Symbol();
				changes.set(id, change);
				await client.cancelQueries({ queryKey, exact: true });
				if (changes.get(id) !== change) {
					return;
				}
				if (next.has(id)) {
					await client.invalidateQueries({ queryKey, exact: true });
				} else {
					client.setQueryData<SavedWork | null>(queryKey, null);
				}
				if (changes.get(id) === change) {
					changes.delete(id);
				}
			}),
		);
	};

	const cancelReads = (): void => {
		changes.clear();
		subscriptionChanges.clear();
		reportSequence++;
		void client.cancelQueries();
	};

	const invalidateWork = async (id: string): Promise<void> => {
		const queryKey = queryKeys.work(id);
		const cached = client.getQueryState(queryKey);
		if (!cached || cached.isInvalidated) {
			return;
		}
		await client.cancelQueries({ queryKey, exact: true });
		await client.invalidateQueries({ queryKey, exact: true });
	};

	return {
		client,
		work,
		diagnostics,
		syncLibrary,
		cancelReads,
		syncSubscriptions,
		entries: (id: string, unread: boolean, page: number, enabled: boolean) =>
			queryOptions({
				queryKey: queryKeys.entries(id, unread, page),
				enabled: !!id && enabled,
				staleTime: 0,
				queryFn: ({ signal }) => entryPage({ subscriptionId: id, unread, page, pageSize: 20 }, signal),
			}),
		entryStream: (id: string, unread: boolean, enabled: boolean) =>
			infiniteQueryOptions({
				queryKey: queryKeys.stream(id, unread),
				enabled: !!id && enabled,
				staleTime: 0,
				gcTime: 0,
				initialPageParam: 1,
				queryFn: ({ signal, pageParam }) => entryPage({ subscriptionId: id, unread, page: pageParam, pageSize: 20 }, signal),
				getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
			}),
		storage: () =>
			queryOptions({
				queryKey: queryKeys.storage,
				staleTime: 0,
				queryFn: ({ signal }) =>
					readLocal(() => {
						const storage = required().storage;
						if (!storage) {
							throw new Error('STORAGE_UNAVAILABLE');
						}
						return storage.usage();
					}, signal),
			}),
		clearImageCache: () =>
			mutationOptions({
				onMutate: () => client.cancelQueries({ queryKey: queryKeys.storage, exact: true }),
				mutationFn: () => {
					const storage = required().storage;
					if (!storage) {
						throw new Error('STORAGE_UNAVAILABLE');
					}
					return storage.clear();
				},
				onSuccess: (reply) => {
					client.setQueryData(queryKeys.storage, reply.usage);
				},
			}),
		saveWork: () =>
			mutationOptions({
				mutationFn: (input: LibrarySave) => required().library.save(input),
				onSuccess: async (reply) => {
					if (reply.ok && reply.id) {
						await invalidateWork(reply.id);
					}
				},
			}),
		removeWork: () =>
			mutationOptions({
				mutationFn: (id: string) => required().library.remove(id),
				onSuccess: async (reply, id) => {
					if (reply.ok) {
						await client.cancelQueries({ queryKey: queryKeys.work(id), exact: true });
						client.setQueryData<SavedWork | null>(queryKeys.work(id), null);
					}
				},
			}),
		searchMagnets: () => mutationOptions({ mutationFn: (input: Parameters<MagnetBridge['search']>[0]) => required().magnets.search(input) }),
		copyDiagnostics: () =>
			mutationOptions({
				mutationFn: () => readLocal(() => required().diagnostics.copyReport()),
				onMutate: () => ++reportSequence,
				onSuccess: (reply, _variables, request) => {
					if (reply.copied && request === reportSequence && client.getQueryState(queryKeys.diagnostics)) {
						client.setQueryData<DiagnosticReport>(queryKeys.diagnostics, (previous) => latestReport(previous, reply.report));
					}
				},
			}),
	};
}

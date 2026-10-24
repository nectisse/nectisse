import { QueryClient, mutationOptions, queryOptions } from '@tanstack/react-query';
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
	let reportSequence = 0;

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

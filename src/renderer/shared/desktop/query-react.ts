import { useEffect } from 'react';
import { useInfiniteQuery, useMutation, useQuery, type InfiniteData } from '@tanstack/react-query';
import type { EntryPage } from '@shared/subscriptions';
import { useDesktop } from './context';
import { queryKeys } from './queries';

export function useCollectedEntries(id: string, unread: boolean, page: number, stream: boolean) {
	const { queries } = useDesktop();
	const paged = useQuery(queries.entries(id, unread, page, !stream));
	const feed = useInfiniteQuery(queries.entryStream(id, unread, stream));
	return {
		entries: stream ? (feed.data?.pages.flatMap((page) => page.entries) ?? []) : (paged.data?.entries ?? []),
		total: stream ? (feed.data?.pages[0]?.total ?? 0) : (paged.data?.total ?? 0),
		retryable: stream ? feed.data?.pages[0]?.retryable : paged.data?.retryable,
		loading: stream ? feed.isPending : paged.isPending,
		error: stream ? feed.isError : paged.isError,
		hasMore: stream && !!feed.hasNextPage,
		loadingMore: feed.isFetchingNextPage,
		loadMore: feed.fetchNextPage,
		resetStream: async (unread: boolean) => {
			const queryKey = queryKeys.stream(id, unread);
			await queries.client.cancelQueries({ queryKey, exact: true });
			queries.client.setQueryData<InfiniteData<EntryPage, number>>(queryKey, (data) =>
				data ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } : data,
			);
		},
		refetch: () => (stream ? feed.refetch() : paged.refetch()),
	};
}

export function useStorageUsage() {
	return useQuery(useDesktop().queries.storage());
}

export function useClearImageCache() {
	return useMutation(useDesktop().queries.clearImageCache());
}

export function useSavedWork(id: string) {
	return useQuery(useDesktop().queries.work(id));
}

export function useSaveWork() {
	return useMutation(useDesktop().queries.saveWork());
}

export function useRemoveWork() {
	return useMutation(useDesktop().queries.removeWork());
}

export function useDiagnosticsReport(open: boolean) {
	const { queries } = useDesktop();
	const report = useQuery(queries.diagnostics(open));
	useEffect(() => {
		if (!open) {
			void queries.client.cancelQueries({ queryKey: queryKeys.diagnostics, exact: true });
		}
	}, [open, queries]);
	return report;
}

export function useCopyDiagnostics() {
	return useMutation(useDesktop().queries.copyDiagnostics());
}

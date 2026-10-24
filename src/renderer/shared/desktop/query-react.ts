import { useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useDesktop } from './context';
import { queryKeys } from './queries';

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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { MagnetOrigin } from '@shared/magnets';
import { useDesktop } from './context';

export function useMagnetSearch(origin: MagnetOrigin) {
	const { queries, actions } = useDesktop();
	const mutation = useMutation(queries.searchMagnets());
	const { mutateAsync } = mutation;
	const [cancelling, setCancelling] = useState(false);
	const current = useRef('');
	const originRef = useRef(origin);
	originRef.current = origin;

	const search = useCallback(
		async (force = false): Promise<void> => {
			if (current.current) {
				return;
			}
			const id = crypto.randomUUID();
			current.current = id;
			setCancelling(false);
			try {
				await mutateAsync({ id, origin: originRef.current, force });
			} catch {
				// 读取错误由 mutation 提供；不自动重试采集任务。
			} finally {
				if (current.current === id) {
					current.current = '';
					setCancelling(false);
				}
			}
		},
		[mutateAsync],
	);

	useEffect(() => {
		let mounted = true;
		queueMicrotask(() => {
			if (mounted) {
				void search();
			}
		});
		return () => {
			mounted = false;
			const id = current.current;
			current.current = '';
			if (id) {
				void actions.magnets.cancel(id).catch(() => {});
			}
		};
	}, [actions, search]);

	const cancel = async (): Promise<boolean> => {
		const id = current.current;
		if (!id) {
			return true;
		}
		setCancelling(true);
		try {
			await actions.magnets.cancel(id);
			return true;
		} catch {
			if (current.current === id) {
				setCancelling(false);
			}
			return false;
		}
	};

	return { result: mutation.data, loading: mutation.isPending, error: mutation.isError, cancelling, search, cancel };
}

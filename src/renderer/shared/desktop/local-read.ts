// 本机只读 IPC 无法中断 SQLite 调用；中止等待并忽略迟到结果。
export function readLocal<T>(read: () => Promise<T>, signal?: AbortSignal, timeoutMs = 5000): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;

		const finish = (value?: T, error?: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			if (error) {
				reject(error);
			} else {
				resolve(value!);
			}
		};

		const abort = (): void => finish(undefined, new Error('LOCAL_READ_CANCELLED'));
		const timer = setTimeout(() => finish(undefined, new Error('LOCAL_READ_TIMEOUT')), timeoutMs);
		signal?.addEventListener('abort', abort, { once: true });
		void Promise.resolve()
			.then(() => {
				if (signal?.aborted) {
					throw new Error('LOCAL_READ_CANCELLED');
				}
				return read();
			})
			.then(
				(value) => finish(value),
				() => finish(undefined, new Error('LOCAL_READ_FAILED')),
			);
	});
}

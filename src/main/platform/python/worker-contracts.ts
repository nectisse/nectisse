export interface RunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	onReady?: (pid: number) => void;
	onProgress?: (payload: Record<string, unknown>) => void;
	onRequest?: (request: { source: string; host: string; sequence: number }) => Promise<void>;
}

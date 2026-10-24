import type { RunOptions } from './worker-contracts';
export type { RunOptions } from './worker-contracts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { MAX_PROTOCOL_BYTES, PROTOCOL_VERSION, workerEventSchema } from '@shared/protocol';
import type { PythonLayout } from './python-layout';
import { BrowserSessionHost } from './browser-session-host';
import { PythonWorkerError, TaskCancelledError } from './python-errors';
export { PythonWorkerError, TaskCancelledError } from './python-errors';

interface ActiveWorker {
	child: ChildProcessWithoutNullStreams;
	completion: Promise<unknown>;
	cancel: () => void;
}

export class PythonTaskHost {
	private active = new Map<string, ActiveWorker>();
	private stopping = false;
	private browser?: BrowserSessionHost;

	constructor(
		private layout: PythonLayout,
		private options: { diagnostics?: boolean; graceMs?: number; browserProfile?: string } = {},
	) {}

	get activePids(): number[] {
		return [...this.active.values()].flatMap(({ child }) => (child.pid ? [child.pid] : [])).concat(this.browser?.activePids ?? []);
	}

	run(
		method:
			| 'health'
			| 'metadata.query'
			| 'metadata.cover'
			| 'metadata.coverProbe'
			| 'follow.lookup'
			| 'follow.check'
			| 'follow.image'
			| 'magnet.search'
			| 'diagnostics.wait'
			| 'diagnostics.block',
		params: Record<string, unknown> = {},
		options: RunOptions = {},
	): Promise<unknown> {
		if (this.stopping || options.signal?.aborted) {
			return Promise.reject(new TaskCancelledError());
		}
		if (method === 'metadata.query' && params.source === 'fc2ppvdb' && params.transport === 'browser') {
			if (!this.options.browserProfile) {
				return Promise.reject(new PythonWorkerError('BROWSER_PROFILE_MISSING', '浏览器会话目录未配置'));
			}
			this.browser ??= new BrowserSessionHost(this.layout, this.options.browserProfile, this.options.diagnostics);
			return this.browser.run(params, options);
		}
		const id = randomUUID();
		const args = ['-I', '-S', '-B', '-u', this.layout.bootstrap, '--dependencies', this.layout.dependencies];
		if (this.options.diagnostics) {
			args.push('--diagnostics');
		}
		// Use an explicit executable and inherited pipes; never invoke a shell or a host Python.
		const child = spawn(this.layout.executable, args, {
			detached: process.platform !== 'win32',
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {},
			windowsHide: true,
		});
		let cancelled = false;
		let timedOut = false;
		let failure: Error | undefined;
		let result: unknown;
		let gotResult = false;
		let ready = false;
		const timers: ReturnType<typeof setTimeout>[] = [];

		const terminate = (signal: NodeJS.Signals): void => {
			if (!child.pid) {
				return;
			}
			try {
				if (process.platform === 'win32') {
					child.kill(signal);
				} else {
					process.kill(-child.pid, signal);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
					failure ??= new PythonWorkerError('CLEANUP_FAILED', '无法结束采集进程');
				}
			}
		};

		const stop = (): void => {
			try {
				child.stdin.write(JSON.stringify({ protocol: PROTOCOL_VERSION, id, method: 'cancel' }) + '\n');
			} catch {
				/* exit may already be underway */
			}
			timers.push(setTimeout(() => terminate('SIGTERM'), this.options.graceMs ?? 300));
			timers.push(setTimeout(() => terminate('SIGKILL'), (this.options.graceMs ?? 300) + 1500));
		};

		const cancel = (): void => {
			if (cancelled) {
				return;
			}
			cancelled = true;
			stop();
		};

		const fail = (error: Error): void => {
			if (failure) {
				return;
			}
			failure = error;
			stop();
		};

		const completion = new Promise<unknown>((resolve, reject) => {
			let buffer = '';
			const decoder = new StringDecoder('utf8');
			child.stdout.on('data', (chunk: Buffer) => {
				if (failure || cancelled || timedOut) {
					return;
				}
				buffer += decoder.write(chunk);
				let end: number;
				while ((end = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					if (Buffer.byteLength(line) > MAX_PROTOCOL_BYTES) {
						fail(new PythonWorkerError('PROTOCOL_LIMIT', '工作者响应超出大小限制'));
						return;
					}
					try {
						const event = workerEventSchema.parse(JSON.parse(line));
						if (event.id !== id) {
							throw new Error('request id mismatch');
						}
						if (event.kind === 'ready') {
							if (ready) {
								throw new Error('duplicate handshake');
							}
							ready = true;
							options.onReady?.(child.pid!);
						} else if (event.kind === 'result') {
							if (!ready || gotResult) {
								throw new Error('invalid result ordering');
							}
							gotResult = true;
							result = event.payload;
						} else if (event.kind === 'progress') {
							options.onProgress?.(event.payload);
							if (event.payload.event === 'request') {
								const { source, host, sequence } = event.payload;
								if (
									!options.onRequest ||
									typeof source !== 'string' ||
									typeof host !== 'string' ||
									!Number.isSafeInteger(sequence) ||
									Number(sequence) < 1 ||
									Number(sequence) > 8
								) {
									throw new Error('Invalid request permit');
								}
								void options
									.onRequest({ source, host, sequence: Number(sequence) })
									.then(() => {
										if (!cancelled && !timedOut && !failure && !child.killed) {
											child.stdin.write(JSON.stringify({ protocol: PROTOCOL_VERSION, id, method: 'permit', sequence }) + '\n');
										}
									})
									.catch(() => {
										if (!cancelled && !timedOut) {
											fail(new PythonWorkerError('REQUEST_BUDGET', '请求调度已停止或达到预算'));
										}
									});
							}
						} else if (event.kind === 'error') {
							fail(new PythonWorkerError(event.code, event.message));
						} else {
							cancelled = true;
						}
					} catch {
						fail(new PythonWorkerError('INVALID_PROTOCOL', '工作者通信格式不正确'));
						return;
					}
				}
				if (Buffer.byteLength(buffer) > MAX_PROTOCOL_BYTES) {
					fail(new PythonWorkerError('PROTOCOL_LIMIT', '工作者响应超出大小限制'));
				}
			});
			// Drain stderr without forwarding arbitrary native-library output into UI or ordinary logs.
			child.stderr.on('data', () => {});
			child.stdin.on('error', () => {});
			child.once('error', () => {
				failure = new PythonWorkerError('START_FAILED', '无法启动随包采集环境，请重新构建或安装应用');
			});
			// A connector may have started a child which does not inherit our pipes.
			// Clean the owned group even if its leader exits before the grace timer.
			child.once('exit', () => terminate('SIGKILL'));
			child.once('close', (code) => {
				this.active.delete(id);
				timers.forEach(clearTimeout);
				options.signal?.removeEventListener('abort', cancel);
				if (timedOut) {
					reject(new PythonWorkerError('WORKER_TIMEOUT', '采集环境响应超时，请重试'));
				} else if (cancelled) {
					reject(new TaskCancelledError());
				} else if (failure) {
					reject(failure);
				} else if (code !== 0 || !gotResult || buffer.trim()) {
					reject(new PythonWorkerError('UNEXPECTED_EXIT', '采集进程意外退出'));
				} else {
					resolve(result);
				}
			});
		});

		this.active.set(id, { child, completion, cancel });
		options.signal?.addEventListener('abort', cancel, { once: true });
		if (options.signal?.aborted) {
			cancel();
		}
		timers.push(
			setTimeout(() => {
				timedOut = true;
				stop();
			}, options.timeoutMs ?? 15_000),
		);
		child.stdin.write(JSON.stringify({ protocol: PROTOCOL_VERSION, id, method, params }) + '\n');
		return completion;
	}

	async shutdown(): Promise<void> {
		this.stopping = true;
		const workers = [...this.active.values()];
		workers.forEach((worker) => worker.cancel());
		await Promise.allSettled(workers.map((worker) => worker.completion));
		await this.browser?.shutdown();
	}
}

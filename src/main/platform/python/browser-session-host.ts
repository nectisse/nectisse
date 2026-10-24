import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { MAX_PROTOCOL_BYTES, PROTOCOL_VERSION, workerEventSchema } from '@shared/protocol';
import { PythonWorkerError, TaskCancelledError } from './python-errors';
import type { RunOptions } from './worker-contracts';
import type { PythonLayout } from './python-layout';

interface SessionProcess {
	child: ChildProcessWithoutNullStreams;
	closed: Promise<void>;
	stop: (graceMs?: number) => Promise<void>;
}

interface Pending {
	id: string;
	ready: boolean;
	options: RunOptions;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/** 单站串行会话；取消时回收整个拥有的进程组，下次从独立 profile 恢复。 */
export class BrowserSessionHost {
	private process?: SessionProcess;
	private pending?: Pending;
	private queue: Promise<unknown> = Promise.resolve();
	private stopping = false;

	constructor(
		private layout: PythonLayout,
		private profile: string,
		private diagnostics = false,
	) {}

	get activePids(): number[] {
		return this.process?.child.pid ? [this.process.child.pid] : [];
	}

	run(params: Record<string, unknown>, options: RunOptions): Promise<unknown> {
		const result = this.queue.catch(() => {}).then(() => this.execute(params, options));
		this.queue = result;
		return result;
	}

	async shutdown(): Promise<void> {
		this.stopping = true;
		this.pending?.reject(new TaskCancelledError());
		await this.process?.stop(5000);
		await this.queue.catch(() => {});
	}

	private async execute(params: Record<string, unknown>, options: RunOptions): Promise<unknown> {
		if (this.stopping || options.signal?.aborted) {
			throw new TaskCancelledError();
		}
		const process = this.process ?? this.start();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const abort = (): void => {
			this.pending?.reject(new TaskCancelledError());
			void process.stop();
		};
		try {
			return await new Promise((resolve, reject) => {
				const id = randomUUID();
				this.pending = { id, ready: false, options, resolve, reject };
				options.signal?.addEventListener('abort', abort, { once: true });
				timer = setTimeout(() => {
					reject(new PythonWorkerError('WORKER_TIMEOUT', 'FC2PPV-DB 浏览器验证或页面读取超时，可重新查询'));
					void process.stop();
				}, options.timeoutMs ?? 240_000);
				process.child.stdin.write(JSON.stringify({ protocol: PROTOCOL_VERSION, id, method: 'metadata.query', params }) + '\n');
				if (options.signal?.aborted) {
					abort();
				}
			});
		} catch (error) {
			await process.stop();
			throw error;
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', abort);
			this.pending = undefined;
		}
	}

	private start(): SessionProcess {
		const args = ['-I', '-S', '-B', '-u', this.layout.bootstrap, '--dependencies', this.layout.dependencies, '--browser-session', this.profile];
		if (this.diagnostics) {
			args.push('--diagnostics');
		}
		const child = spawn(this.layout.executable, args, { detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: {}, windowsHide: true });
		let stopping: Promise<void> | undefined;
		let buffer = '';
		const decoder = new StringDecoder('utf8');
		const kill = (signal: NodeJS.Signals): void => {
			try {
				if (child.pid) {
					if (process.platform === 'win32') {
						child.kill(signal);
					} else {
						process.kill(-child.pid, signal);
					}
				}
			} catch {
				/* Already exited. */
			}
		};
		const closed = new Promise<void>((resolve) => {
			child.once('exit', () => kill('SIGKILL'));
			child.once('close', () => {
				if (this.process?.child === child) {
					this.process = undefined;
					this.pending?.reject(new PythonWorkerError('UNEXPECTED_EXIT', '资料验证会话已断开，可重新查询'));
				}
				resolve();
			});
		});
		const session: SessionProcess = {
			child,
			closed,
			stop: (graceMs = 500) => {
				stopping ??= (async () => {
					child.stdin.end();
					const term = setTimeout(() => kill('SIGTERM'), graceMs);
					const force = setTimeout(() => kill('SIGKILL'), graceMs + 1500);
					await closed;
					clearTimeout(term);
					clearTimeout(force);
				})();
				return stopping;
			},
		};
		child.stdin.on('error', () => {});
		child.stderr.on('data', () => {});
		child.once('error', () => this.pending?.reject(new PythonWorkerError('START_FAILED', '无法启动随包浏览器会话服务')));
		child.stdout.on('data', (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			try {
				let end: number;
				while ((end = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					if (Buffer.byteLength(line) > MAX_PROTOCOL_BYTES) {
						throw new Error('message limit');
					}
					this.receive(workerEventSchema.parse(JSON.parse(line)), child);
				}
				if (Buffer.byteLength(buffer) > MAX_PROTOCOL_BYTES) {
					throw new Error('message limit');
				}
			} catch {
				this.pending?.reject(new PythonWorkerError('INVALID_PROTOCOL', '浏览器会话通信格式不正确'));
				void session.stop();
			}
		});
		this.process = session;
		return session;
	}

	private receive(event: ReturnType<typeof workerEventSchema.parse>, child: ChildProcessWithoutNullStreams): void {
		const pending = this.pending;
		if (!pending || event.id !== pending.id) {
			throw new Error('request id mismatch');
		}
		if (event.kind === 'ready' && !pending.ready) {
			pending.ready = true;
			pending.options.onReady?.(child.pid!);
		} else if (!pending.ready) {
			throw new Error('missing handshake');
		} else if (event.kind === 'result') {
			pending.resolve(event.payload);
		} else if (event.kind === 'error') {
			pending.reject(new PythonWorkerError(event.code, event.message));
		} else if (event.kind === 'progress') {
			pending.options.onProgress?.(event.payload);
			if (event.payload.event === 'request') {
				const { source, host, sequence } = event.payload;
				if (
					source !== 'fc2ppvdb' ||
					typeof host !== 'string' ||
					!Number.isSafeInteger(sequence) ||
					Number(sequence) < 1 ||
					Number(sequence) > 16 ||
					!pending.options.onRequest
				) {
					throw new Error('invalid permit');
				}
				void pending.options
					.onRequest({ source, host, sequence: Number(sequence) })
					.then(() => {
						if (this.pending === pending && !pending.options.signal?.aborted && !this.stopping) {
							child.stdin.write(JSON.stringify({ protocol: PROTOCOL_VERSION, id: pending.id, method: 'permit', sequence }) + '\n');
						}
					})
					.catch(() => {
						pending.reject(new PythonWorkerError('REQUEST_BUDGET', '浏览器页面请求调度已停止或达到预算'));
						void this.process?.stop();
					});
			}
		} else {
			throw new Error('unexpected event');
		}
	}
}

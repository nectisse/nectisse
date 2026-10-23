import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { healthSchema, type RuntimeState } from '../shared/protocol';
import { PythonTaskHost, PythonWorkerError, TaskCancelledError } from './python-host';
import type { PythonLayout } from './python-layout';
import { runtimeDiagnosticCode } from '../shared/diagnostics';

export class RuntimeService extends EventEmitter {
	private state: RuntimeState = { phase: 'starting', revision: 0, message: '正在准备采集环境' };
	private checking: Promise<RuntimeState> | undefined;
	private disposed = false;
	readonly host: PythonTaskHost;

	constructor(private layout: PythonLayout) {
		super();
		this.host = new PythonTaskHost(layout);
	}

	getState(): RuntimeState {
		return structuredClone(this.state);
	}

	start(): Promise<RuntimeState> {
		if (this.checking) {
			return this.checking;
		}
		if (this.disposed) {
			return Promise.resolve(this.getState());
		}
		this.publish({ phase: 'starting', message: '正在准备采集环境' });
		this.checking = (async () => {
			try {
				const manifest = JSON.parse(await readFile(this.layout.manifest, 'utf8'));
				if (manifest.target !== `${process.platform}-${process.arch}`) {
					throw new PythonWorkerError('WRONG_ARCH', '采集环境与应用架构不匹配');
				}
				const health = healthSchema.parse(await this.host.run('health'));
				if (health.pythonVersion !== manifest.pythonVersion) {
					throw new PythonWorkerError('WRONG_RUNTIME', '采集环境版本与随包清单不一致');
				}
				if (this.disposed) {
					return this.getState();
				}
				return this.publish({ phase: 'ready', message: '采集环境已就绪', health });
			} catch (error) {
				if (this.disposed || error instanceof TaskCancelledError) {
					return this.getState();
				}
				return this.publish({
					phase: 'error',
					errorCode: runtimeDiagnosticCode(error instanceof PythonWorkerError ? error.code : ''),
					message: error instanceof PythonWorkerError ? error.message : '采集环境未准备完成，请重新构建或安装应用',
				});
			} finally {
				this.checking = undefined;
			}
		})();
		return this.checking;
	}

	async stop(): Promise<void> {
		this.disposed = true;
		await this.host.shutdown();
		await this.checking;
		this.publish({ phase: 'stopped', message: '采集环境已停止' });
	}

	private publish(next: Omit<RuntimeState, 'revision'>): RuntimeState {
		this.state = { ...next, revision: this.state.revision + 1 };
		this.emit('state', this.getState());
		return this.getState();
	}
}

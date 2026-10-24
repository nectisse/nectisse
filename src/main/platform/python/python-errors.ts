export class TaskCancelledError extends Error {
	constructor() {
		super('任务已取消');
		this.name = 'TaskCancelledError';
	}
}

export class PythonWorkerError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'PythonWorkerError';
	}
}

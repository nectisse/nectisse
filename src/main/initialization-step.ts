/** One initialization attempt is shared. Only an explicit retry replaces a failure. */
export class InitializationStep {
	private pending?: Promise<void>;
	private failed = false;
	private closed = false;

	constructor(private initialize: () => void | Promise<void>) {}

	run(): Promise<void> {
		if (this.closed) {
			return Promise.reject(new Error('APP_STOPPING'));
		}
		if (!this.pending) {
			this.pending = Promise.resolve()
				.then(() => {
					if (this.closed) {
						throw new Error('APP_STOPPING');
					}
					return this.initialize();
				})
				.catch((error) => {
					this.failed = true;
					throw error;
				});
		}
		return this.pending;
	}

	retry(): Promise<void> {
		if (this.failed) {
			this.pending = undefined;
			this.failed = false;
		}
		return this.run();
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.pending?.catch(() => {});
	}
}

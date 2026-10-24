import { mkdirSync, readFileSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
	diagnosticEntrySchema,
	diagnosticCodeSchema,
	diagnosticReportSchema,
	type DiagnosticCode,
	type DiagnosticEntry,
	type DiagnosticEnvironment,
	type DiagnosticReport,
} from '@shared/diagnostics';
import type { SubscriptionFailureContext } from '@shared/subscription-failure';

const MAX_FILE_BYTES = 8192;

/** Reads only this application's bounded diagnostic file, never general logs. */
export class DiagnosticLog {
	private session: DiagnosticEntry[] = [];
	private writeFailed = false;
	readonly path: string;

	constructor(private root: string) {
		this.path = join(root, 'diagnostics', 'subscription-read.jsonl');
	}

	record(code: DiagnosticCode, context?: SubscriptionFailureContext): void {
		const entry = diagnosticEntrySchema.parse({ at: new Date().toISOString(), code: diagnosticCodeSchema.parse(code), ...(context ? { context } : {}) });
		this.session.push(entry);
		this.session = this.session.slice(-32);
		try {
			const previous = this.read().entries;
			mkdirSync(join(this.root, 'diagnostics'), { recursive: true, mode: 0o700 });
			writeFileSync(
				this.path,
				[...previous, entry]
					.slice(-32)
					.map((row) => JSON.stringify(row))
					.join('\n') + '\n',
				{ mode: 0o600 },
			);
			chmodSync(this.path, 0o600);
			this.writeFailed = false;
		} catch {
			this.writeFailed = true; /* Keep the current session available even if storage cannot be written. */
		}
	}

	recordFromRenderer(code: DiagnosticCode, context?: SubscriptionFailureContext): void {
		const latest = this.session.at(-1);
		// The same failed read is also observed by the main process. Keep one record.
		if (latest?.code === code && Date.now() - Date.parse(latest.at) < 100) {
			return;
		}
		this.record(code, context ?? { stage: 'renderer', kind: code === 'SUBSCRIPTIONS_READ_TIMEOUT' ? 'timeout' : 'unknown' });
	}

	snapshot(environment: DiagnosticEnvironment): DiagnosticReport {
		const stored = this.read();
		const memory = this.session.filter((entry) => !stored.entries.some((row) => row.at === entry.at && row.code === entry.code));

		return diagnosticReportSchema.parse({
			generatedAt: new Date().toISOString(),
			environment,
			...stored,
			logStatus: this.writeFailed ? 'unreadable' : stored.logStatus,
			entries: [...stored.entries, ...memory].sort((a, b) => a.at.localeCompare(b.at)).slice(-32),
		});
	}

	private read(): { entries: DiagnosticEntry[]; logStatus: 'ready' | 'unreadable'; ignoredLines: number } {
		try {
			if (statSync(this.path).size > MAX_FILE_BYTES) {
				return { entries: [], logStatus: 'unreadable', ignoredLines: 0 };
			}

			const lines = readFileSync(this.path, 'utf8')
				.split('\n')
				.filter((line) => line.trim());
			const entries: DiagnosticEntry[] = [];
			let ignoredLines = 0;
			for (const line of lines) {
				try {
					const entry = diagnosticEntrySchema.safeParse(JSON.parse(line));
					if (entry.success) {
						entries.push(entry.data);
					} else {
						ignoredLines++;
					}
				} catch {
					ignoredLines++;
				}
			}
			return { entries: entries.slice(-32), logStatus: 'ready', ignoredLines };
		} catch (error) {
			return { entries: [], logStatus: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ready' : 'unreadable', ignoredLines: 0 };
		}
	}
}

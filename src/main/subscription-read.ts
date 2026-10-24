import { z } from 'zod';
import { subscriptionsStateSchema, type SubscriptionsState } from '@shared/subscriptions';
import { SUBSCRIPTION_READ, type SubscriptionReadCode } from '@shared/subscription-read';
import { DiagnosticLog } from './diagnostics';
import { subscriptionFailureContext, type SubscriptionFailureContext, type SubscriptionStage } from '@shared/subscription-failure';

class SnapshotPartError extends Error {
	constructor(
		readonly stage: SubscriptionStage,
		cause: unknown,
	) {
		super('SUBSCRIPTION_SNAPSHOT_PART_FAILED', { cause });
	}
}

export function readSubscriptionPart<T>(stage: SubscriptionStage, read: () => T): T {
	try {
		return read();
	} catch (error) {
		throw new SnapshotPartError(stage, error);
	}
}

export function readSubscriptionState(read: () => unknown, report: (code: SubscriptionReadCode, context: SubscriptionFailureContext) => void): SubscriptionsState {
	let stage: SubscriptionStage = 'snapshot';
	try {
		const value = read();
		stage = 'validation';
		return subscriptionsStateSchema.parse(value);
	} catch (error) {
		if (error instanceof SnapshotPartError) {
			stage = error.stage;
		}
		const cause = error instanceof SnapshotPartError ? error.cause : error;
		const code =
			cause instanceof z.ZodError || cause instanceof SyntaxError
				? SUBSCRIPTION_READ.invalid
				: /^(ERR_SQLITE|SQLITE_|EACCES$|EPERM$|EIO$|ENOENT$|ENOSPC$|EROFS$)/.test(String((cause as NodeJS.ErrnoException)?.code))
					? SUBSCRIPTION_READ.storage
					: SUBSCRIPTION_READ.unavailable;
		try {
			report(code, subscriptionFailureContext(cause, stage));
		} catch {
			/* A diagnostic write failure must not replace the read error. */
		}
		throw new Error(code);
	}
}

/** A bounded, private diagnostic log contains only fixed codes and timestamps. */
export function recordSubscriptionReadFailure(root: string, code: SubscriptionReadCode, context?: SubscriptionFailureContext): void {
	new DiagnosticLog(root).record(code, context);
}

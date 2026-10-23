import { z } from 'zod';
import type { MetadataBridge } from './metadata';
import { runtimeDiagnosticCodeSchema } from './diagnostics';

export const PROTOCOL_VERSION = 1 as const;
export const MAX_PROTOCOL_BYTES = 64 * 1024;

export const healthSchema = z.object({
	pythonVersion: z.string(),
	architecture: z.string(),
	pid: z.number().int().positive(),
	executable: z.string(),
	httpxVersion: z.string(),
	curlCffiVersion: z.string(),
	peachVersion: z.string(),
	transportSha256: z.string().regex(/^[a-f0-9]{64}$/),
	identityProbe: z.string(),
});
export type WorkerHealth = z.infer<typeof healthSchema>;

const identity = { protocol: z.literal(PROTOCOL_VERSION), id: z.string().max(100) };
export const workerEventSchema = z.discriminatedUnion('kind', [
	z.object({ ...identity, kind: z.literal('ready') }),
	z.object({ ...identity, kind: z.literal('result'), payload: z.unknown() }),
	z.object({ ...identity, kind: z.literal('progress'), payload: z.record(z.string(), z.unknown()) }),
	z.object({ ...identity, kind: z.literal('cancelled') }),
	z.object({ ...identity, kind: z.literal('error'), code: z.string(), message: z.string().max(500) }),
]);

export const runtimeStateSchema = z.object({
	phase: z.enum(['starting', 'ready', 'error', 'stopped']),
	revision: z.number().int().nonnegative(),
	message: z.string(),
	health: healthSchema.optional(),
	errorCode: runtimeDiagnosticCodeSchema.optional(),
});
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export interface DesktopBridge {
	library: import('./library').LibraryBridge;
	diagnostics: import('./diagnostics').DiagnosticsBridge;
	subscriptions: import('./subscriptions').SubscriptionsBridge;
	metadata: MetadataBridge;
	runtime: {
		getState: () => Promise<RuntimeState>;
		retry: () => Promise<RuntimeState>;
		onState: (callback: (state: RuntimeState) => void) => () => void;
	};
}

export const IPC = {
	runtimeState: 'nectisse:runtime-state',
	runtimeGet: 'nectisse:runtime-get',
	runtimeRetry: 'nectisse:runtime-retry',
} as const;

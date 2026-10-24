import { z } from 'zod';

export const MAGNET_ROOT = 'https://sukebei.nyaa.si';
export const magnetSettingsSchema = z.object({
	enabled: z.boolean(),
	maxResults: z.union([z.literal(5), z.literal(10), z.literal(20)]),
	transport: z.enum(['httpx', 'fingerprint']),
});
export type MagnetSettings = z.infer<typeof magnetSettingsSchema>;
export const DEFAULT_MAGNET_SETTINGS: MagnetSettings = { enabled: true, maxResults: 20, transport: 'httpx' };
export const magnetCodeSchema = z
	.string()
	.trim()
	.toUpperCase()
	.min(3)
	.max(64)
	.regex(/^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$/);
export const magnetOriginSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('query'), taskId: z.string().uuid(), code: magnetCodeSchema }),
	z.object({ kind: z.literal('library'), id: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export type MagnetOrigin = z.infer<typeof magnetOriginSchema>;

export const magnetRequestSchema = z.object({ id: z.string().uuid(), origin: magnetOriginSchema, force: z.boolean().default(false) });
export const magnetRowSchema = z
	.object({
		id: z.string().regex(/^[a-f0-9]{40}$/),
		title: z.string().min(1).max(300),
		magnet: z.string().max(2400).startsWith('magnet:?'),
		url: z.string().regex(/^https:\/\/sukebei\.nyaa\.si\/view\/\d+$/),
		size: z.string().max(40),
		uploadedAt: z.string().datetime().nullable(),
		seeders: z.number().int().nonnegative().nullable(),
		leechers: z.number().int().nonnegative().nullable(),
		completed: z.number().int().nonnegative().nullable(),
	})
	.refine((row) => new URLSearchParams(row.magnet.slice('magnet:?'.length)).get('xt')?.toLowerCase() === `urn:btih:${row.id}`, '磁链身份不匹配');
export const magnetResultSchema = z.object({
	code: magnetCodeSchema,
	status: z.enum(['running', 'ready', 'failed', 'cancelled', 'interrupted']),
	items: z.array(magnetRowSchema).max(20),
	limit: z.union([z.literal(5), z.literal(10), z.literal(20)]).default(20),
	checkedAt: z.string().datetime(),
	message: z.string().max(300),
	reason: z.string().max(64).default(''),
	requests: z.number().int().nonnegative().max(8).default(0),
	retryAfter: z.number().int().nonnegative().max(86400).default(0),
});
export type MagnetResult = z.infer<typeof magnetResultSchema>;
export type MagnetRow = z.infer<typeof magnetRowSchema>;
export const magnetActionSchema = z.object({ code: magnetCodeSchema, id: z.string().regex(/^[a-f0-9]{40}$/), action: z.enum(['copy', 'open']) });
export interface MagnetBridge {
	search: (request: z.input<typeof magnetRequestSchema>) => Promise<MagnetResult>;
	cancel: (id: string) => Promise<void>;
	action: (input: z.input<typeof magnetActionSchema>) => Promise<boolean>;
}
export const MAGNET_IPC = { search: 'nectisse:magnet-search', cancel: 'nectisse:magnet-cancel', action: 'nectisse:magnet-action' } as const;

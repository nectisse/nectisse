import { z } from 'zod';

export const MAGNET_ROOT = 'https://sukebei.nyaa.si';
export const magnetSourceSchema = z.enum(['sukebei', 'javtao']);
export type MagnetSource = z.infer<typeof magnetSourceSchema>;
export const MAGNET_SOURCES: Record<MagnetSource, { name: string; root: string }> = {
	sukebei: { name: 'Sukebei', root: MAGNET_ROOT },
	javtao: { name: 'JavTao', root: 'https://javtao.com' },
};
export const externalMagnetSiteSchema = z.enum(['heimacili']);
export type ExternalMagnetSite = z.infer<typeof externalMagnetSiteSchema>;
export const EXTERNAL_MAGNET_SITES: Record<ExternalMagnetSite, { name: string; url: string }> = {
	heimacili: { name: '黑马磁力', url: 'https://heimacili.org/' },
};
export const magnetSettingsSchema = z.object({
	enabled: z.boolean(),
	source: magnetSourceSchema.default('sukebei'),
	maxResults: z.union([z.literal(5), z.literal(10), z.literal(20)]),
	transport: z.enum(['httpx', 'fingerprint']),
});
export type MagnetSettings = z.infer<typeof magnetSettingsSchema>;
export const DEFAULT_MAGNET_SETTINGS: MagnetSettings = { enabled: true, source: 'sukebei', maxResults: 20, transport: 'httpx' };
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

export const magnetRequestSchema = z.object({
	id: z.string().uuid(),
	origin: magnetOriginSchema,
	source: magnetSourceSchema.default('sukebei'),
	force: z.boolean().default(false),
});
export const magnetRowSchema = z
	.object({
		id: z.string().regex(/^[a-f0-9]{40}$/),
		title: z.string().min(1).max(300),
		magnet: z.string().max(2400).startsWith('magnet:?'),
		url: z.string().regex(/^https:\/\/(?:sukebei\.nyaa\.si\/view\/\d+|javtao\.com\/[a-z0-9][a-z0-9_-]{1,95})$/),
		size: z.string().max(40),
		uploadedAt: z.string().datetime().nullable(),
		sharedAt: z
			.string()
			.regex(/^(?:\d{4}-\d{2}-\d{2})?$/)
			.optional(),
		seeders: z.number().int().nonnegative().nullable(),
		leechers: z.number().int().nonnegative().nullable(),
		completed: z.number().int().nonnegative().nullable(),
	})
	.refine((row) => new URLSearchParams(row.magnet.slice('magnet:?'.length)).get('xt')?.toLowerCase() === `urn:btih:${row.id}`, '磁链身份不匹配');
export const magnetResultSchema = z
	.object({
		code: magnetCodeSchema,
		source: magnetSourceSchema.default('sukebei'),
		status: z.enum(['running', 'ready', 'failed', 'cancelled', 'interrupted']),
		items: z.array(magnetRowSchema).max(20),
		limit: z.union([z.literal(5), z.literal(10), z.literal(20)]).default(20),
		checkedAt: z.string().datetime(),
		message: z.string().max(300),
		reason: z.string().max(64).default(''),
		requests: z.number().int().nonnegative().max(8).default(0),
		retryAfter: z.number().int().nonnegative().max(86400).default(0),
	})
	.refine((result) => result.items.every((item) => new URL(item.url).origin === MAGNET_SOURCES[result.source].root), '磁链结果与来源不一致');
export type MagnetResult = z.infer<typeof magnetResultSchema>;
export type MagnetRow = z.infer<typeof magnetRowSchema>;
export const magnetActionSchema = z.object({
	code: magnetCodeSchema,
	source: magnetSourceSchema.default('sukebei'),
	id: z.string().regex(/^[a-f0-9]{40}$/),
	action: z.enum(['copy', 'open']),
});
export interface MagnetBridge {
	search: (request: z.input<typeof magnetRequestSchema>) => Promise<MagnetResult>;
	cancel: (id: string) => Promise<void>;
	action: (input: z.input<typeof magnetActionSchema>) => Promise<boolean>;
	openSite: (site: ExternalMagnetSite) => Promise<boolean>;
}
export const MAGNET_IPC = { search: 'nectisse:magnet-search', cancel: 'nectisse:magnet-cancel', action: 'nectisse:magnet-action', openSite: 'nectisse:magnet-open-site' } as const;

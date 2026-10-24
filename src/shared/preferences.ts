import { z } from 'zod';
import { ALL_IDS, DEFAULT_ENABLED, DEFAULT_METADATA_ORDER, DEFAULT_QUERY_SOURCES, METADATA_IDS, RETIRED_SOURCE_IDS, withoutRetiredSources } from '@shared/sources';
import { COVER_SOURCE_IDS, DEFAULT_COVER_PRIORITY } from '@shared/cover-sources';
import { DEFAULT_MAGNET_SETTINGS, magnetSettingsSchema, magnetSourceSchema, type MagnetSettings } from '@shared/magnets';

const allSourceSchema = z.enum(ALL_IDS);
export const querySourcesSchema = z
	.array(z.enum(METADATA_IDS))
	.max(METADATA_IDS.length)
	.refine((items) => new Set(items).size === items.length);
export const preferencesSchema = z.object({
	querySources: querySourcesSchema.default(DEFAULT_QUERY_SOURCES),
	enabledSources: z
		.array(allSourceSchema)
		.max(ALL_IDS.length)
		.refine((items) => new Set(items).size === items.length),

	metadataPriority: z
		.array(z.enum(METADATA_IDS))
		.min(3)
		.max(METADATA_IDS.length)
		.refine((items) => new Set(items).size === items.length)
		.transform((items) => [...items, ...DEFAULT_METADATA_ORDER.filter((id) => !items.includes(id))]),

	coverPriority: z
		.array(z.enum(COVER_SOURCE_IDS))
		.max(COVER_SOURCE_IDS.length)
		.refine((items) => new Set(items).size === items.length)
		.default(DEFAULT_COVER_PRIORITY),
	automatic: z.boolean(),
	creatorMinutes: z.number().int().min(15).max(10080),
	performerMinutes: z.number().int().min(360).max(10080),
	proxyMode: z.enum(['system', 'direct', 'custom']),
	proxyUrl: z.string().max(500),
	fanboxTransport: z.enum(['httpx', 'fingerprint']),
	javdbTransport: z.enum(['httpx', 'fingerprint']),
	sourceTransports: z
		.partialRecord(allSourceSchema, z.enum(['httpx', 'fingerprint', 'browser']))
		.default({})
		.refine((items) => Object.entries(items).every(([id, transport]) => transport !== 'browser' || id === 'fc2ppvdb'), '此来源尚未接入浏览器会话'),
	theme: z.enum(['cream', 'night']),
	magnetSearch: magnetSettingsSchema.default(DEFAULT_MAGNET_SETTINGS),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const storedPreferencesSchema = z.preprocess((input) => {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return input;
	}
	const saved = { ...input } as Record<string, unknown>;
	for (const key of ['querySources', 'enabledSources', 'metadataPriority', 'coverPriority']) {
		const previous = saved[key];
		const current = withoutRetiredSources(previous);
		saved[key] = current;
		if (key === 'metadataPriority' && Array.isArray(previous) && Array.isArray(current) && current.length < previous.length) {
			saved[key] = [...current, ...DEFAULT_METADATA_ORDER.filter((id) => !current.includes(id))];
		}
	}
	if (saved.sourceTransports && typeof saved.sourceTransports === 'object' && !Array.isArray(saved.sourceTransports)) {
		saved.sourceTransports = Object.fromEntries(Object.entries(saved.sourceTransports).filter(([id]) => !(RETIRED_SOURCE_IDS as readonly string[]).includes(id)));
	}
	return saved;
}, preferencesSchema);

export const DEFAULT_PREFERENCES: Preferences = {
	querySources: [...DEFAULT_QUERY_SOURCES],
	enabledSources: [...DEFAULT_ENABLED],
	metadataPriority: [...DEFAULT_METADATA_ORDER],
	coverPriority: [...DEFAULT_COVER_PRIORITY],
	automatic: false,
	creatorMinutes: 60,
	performerMinutes: 360,
	proxyMode: 'system',
	proxyUrl: '',
	fanboxTransport: 'httpx',
	javdbTransport: 'httpx',
	sourceTransports: {},
	theme: 'cream',
	magnetSearch: { ...DEFAULT_MAGNET_SETTINGS },
};

export type PreferencesPatch = Omit<Partial<Preferences>, 'magnetSearch'> & { magnetSearch?: Partial<MagnetSettings> };
const patchFields = preferencesSchema
	.extend({ magnetSearch: magnetSettingsSchema.partial().extend({ source: magnetSourceSchema.optional() }).strict() })
	.partial()
	.strict();

export const preferencesPatchSchema = z.unknown().transform((input, context): PreferencesPatch => {
	const parsed = patchFields.safeParse(input);
	if (!parsed.success || Object.values(input as object).some((value) => value === undefined)) {
		context.addIssue({ code: 'custom', message: '设置更新格式不正确' });
		return z.NEVER;
	}
	// 仅返回调用方明确提交的字段，避免字段默认值进入局部更新。
	return Object.fromEntries(Object.keys(input as object).map((key) => [key, parsed.data[key as keyof Preferences]])) as PreferencesPatch;
});

export function mergePreferences(previous: Preferences, input: PreferencesPatch): Preferences {
	const patch = preferencesPatchSchema.parse(input);
	const next = preferencesSchema.parse({
		...previous,
		...patch,
		sourceTransports: { ...previous.sourceTransports, ...patch.sourceTransports },
		magnetSearch: { ...previous.magnetSearch, ...patch.magnetSearch },
	});
	if (next.proxyMode === 'custom') {
		const url = new URL(next.proxyUrl);
		if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
			throw new Error('请输入不含账号密码的 HTTP / HTTPS / SOCKS 代理地址');
		}
	}
	return next;
}

import { z } from 'zod';
import { LEGACY_METADATA_IDS, METADATA_IDS, withoutRetiredSources } from '@shared/sources';
import { COVER_SOURCE_IDS } from '@shared/cover-sources';
export { SOURCE_LABELS } from '@shared/sources';

export const sourceIdSchema = z.enum(METADATA_IDS);
export type SourceId = z.infer<typeof sourceIdSchema>;
const recordSourceSchema = z.enum([...METADATA_IDS, ...LEGACY_METADATA_IDS]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const imageAssetSchema = z.object({
	sha256: hash,
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	format: z.enum(['JPEG', 'PNG', 'WEBP']),
	bytes: z
		.number()
		.int()
		.min(1)
		.max(12 * 1024 * 1024),
	quality: z.enum(['standard', 'small']),
});
export type ImageAsset = z.infer<typeof imageAssetSchema>;
export const imageProbeSchema = imageAssetSchema.pick({ width: true, height: true, format: true });
export const coverSchema = z.object({
	id: hash,
	url: z.string().url().max(2000),
	source: recordSourceSchema,
	identity: z.literal('source-matched'),
	asset: imageAssetSchema.optional(),
	probe: imageProbeSchema.optional(),
	error: z.string().max(500).optional(),
});
export const metadataRecordSchema = z.object({
	id: hash,
	source: recordSourceSchema,
	parser: z.string().max(100),
	parserVersion: z.string().max(100),
	code: z.string().max(100),
	contentId: z.string().max(100),
	sourceUrl: z.string().url().max(2000),
	fetchedAt: z.string().max(100),
	title: z.string().max(1000),
	titleLanguage: z.enum(['ja', 'en', 'ko', 'unknown']),
	people: z.array(z.object({ name: z.string().max(200), role: z.enum(['performer', 'director', 'seller']), sourceIdentity: z.string().max(1000) })).max(42),
	studio: z.string().max(500),
	label: z.string().max(500),
	seller: z.string().max(200),
	sellerUrl: z.string().max(1000),
	series: z.string().max(500),
	releaseDate: z.string().max(32),
	deliveryDate: z.string().max(32).default(''),
	description: z.string().max(4000),
	tags: z.array(z.string().max(100)).max(60),
	covers: z.array(coverSchema).max(3),
	warnings: z.array(z.string().max(500)).max(20),
});
export type MetadataRecord = z.infer<typeof metadataRecordSchema>;
export type CoverCandidate = z.infer<typeof coverSchema>;
export const queryRequestSchema = z.object({
	query: z.string().trim().min(2).max(500),
	sources: z.array(sourceIdSchema).min(1).max(METADATA_IDS.length),
	force: z.boolean().default(false),
});
export type QueryRequest = z.infer<typeof queryRequestSchema>;
export const queryPlanSchema = z.object({
	kind: z.enum(['code', 'title', 'url']),
	query: z.string().max(500),
	code: z.string().max(100),
	contentId: z.string().max(100),
	sourceUrl: z.string().max(2000).optional(),
	sources: z.preprocess(withoutRetiredSources, z.array(sourceIdSchema).max(METADATA_IDS.length)),
});
export type QueryPlan = z.infer<typeof queryPlanSchema>;
export const sourceOutcomeSchema = z.object({
	source: recordSourceSchema,
	status: z.enum(['success', 'partial', 'error', 'cached']),
	reason: z.string().max(100),
	message: z.string().max(500),
	retryAfter: z.number().int().nonnegative().max(86400),
	requests: z.number().int().nonnegative().max(24),
	warnings: z.array(z.string().max(500)).max(20),
});
export type SourceOutcome = z.infer<typeof sourceOutcomeSchema>;
export const workerOutcomeSchema = sourceOutcomeSchema.omit({ source: true }).extend({ asset: imageAssetSchema.optional(), probe: imageProbeSchema.optional() });
export const queryTaskSchema = z.object({
	id: z.string().uuid(),
	status: z.enum(['running', 'cancelling', 'cancelled', 'succeeded', 'partial', 'failed', 'interrupted']),
	phase: z.string().max(500),
	plan: queryPlanSchema,
	coverPriority: z.preprocess(withoutRetiredSources, z.array(z.enum(COVER_SOURCE_IDS)).max(COVER_SOURCE_IDS.length).optional()),
	startedAt: z.string(),
	finishedAt: z.string().optional(),
	cancelRequestedAt: z.string().optional(),
	records: z.array(metadataRecordSchema).max(30),
	outcomes: z.array(sourceOutcomeSchema).max(METADATA_IDS.length + LEGACY_METADATA_IDS.length),
	requests: z.number().int().min(0).max(24),
});
export type QueryTask = z.infer<typeof queryTaskSchema>;
export const metadataStateSchema = z.object({
	revision: z.number().int().nonnegative(),
	activeId: z.string().uuid().optional(),
	tasks: z.array(queryTaskSchema).max(20),
	notice: z.string().max(500).optional(),
});
export type MetadataState = z.infer<typeof metadataStateSchema>;
export const queryReplySchema = z.object({ ok: z.boolean(), taskId: z.string().uuid().optional(), cached: z.boolean().optional(), message: z.string().max(500).optional() });
export type QueryReply = z.infer<typeof queryReplySchema>;

export interface MetadataBridge {
	getState: () => Promise<MetadataState>;
	retry: () => Promise<MetadataState>;
	query: (request: QueryRequest) => Promise<QueryReply>;
	clearHistory: () => Promise<QueryReply>;
	cancel: (id: string) => Promise<void>;
	openSource: (taskId: string, recordId: string) => Promise<void>;
	onState: (callback: (state: MetadataState) => void) => () => void;
}

export const METADATA_IPC = {
	get: 'nectisse:metadata-get',
	retry: 'nectisse:metadata-retry',
	query: 'nectisse:metadata-query',
	clearHistory: 'nectisse:metadata-clear-history',
	cancel: 'nectisse:metadata-cancel',
	openSource: 'nectisse:metadata-open-source',
	state: 'nectisse:metadata-state',
} as const;

export const isActiveTask = (task: QueryTask): boolean => task.status === 'running' || task.status === 'cancelling';

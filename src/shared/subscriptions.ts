import { z } from 'zod';
import { imageAssetSchema } from '@shared/metadata';
import { ALL_IDS, FOLLOW_IDS } from '@shared/sources';
import { preferencesSchema, preferencesPatchSchema, querySourcesSchema } from '@shared/preferences';
export { DEFAULT_PREFERENCES, preferencesSchema, querySourcesSchema, type Preferences } from '@shared/preferences';
export { SOURCES } from '@shared/sources';
export const providerSchema = z.enum(FOLLOW_IDS);
export type FollowProvider = z.infer<typeof providerSchema>;
export const allSourceSchema = z.enum(ALL_IDS);
export type AllSource = z.infer<typeof allSourceSchema>;
export const candidateSchema = z.object({
	provider: providerSchema,
	ref: z.string().min(1).max(256),
	handle: z
		.string()
		.regex(/^[A-Za-z0-9_]{1,15}$/)
		.optional(),
	name: z.string().min(1).max(200),
	url: z.string().url().max(1000),
	aliases: z.array(z.string().max(200)).max(12),
	recordType: z.string().max(100),
	bio: z.string().max(1000),
	evidence: z.string().max(500),
	avatarUrl: z.string().max(2000).optional(),
	avatarAsset: imageAssetSchema.optional(),
});
export type FollowCandidate = z.infer<typeof candidateSchema>;
export const postImageSchema = z.object({
	url: z.string().url().max(2000),
	width: z.number().int().positive().max(40000).optional(),
	height: z.number().int().positive().max(40000).optional(),
	alt: z.string().max(1000).optional(),
});
export type PostImage = z.infer<typeof postImageSchema>;
export const xSyncStateSchema = z.object({
	windowIds: z.array(z.string().regex(/^[1-9]\d{0,24}$/)).max(100),
	checkedAt: z.string().datetime(),
	gapSince: z.string().datetime().optional(),
});
export const entryInputSchema = z.object({
	externalId: z.string().min(1).max(100),
	title: z.string().max(1000),
	summary: z.string().max(3000),
	author: z.string().max(200),
	authorRef: z
		.string()
		.regex(/^[1-9]\d{0,24}$/)
		.optional(),
	authorHandle: z
		.string()
		.regex(/^[A-Za-z0-9_]{1,15}$/)
		.optional(),
	postKind: z.literal('original').optional(),
	publishedAt: z.string().max(100),
	publishedPrecision: z.enum(['exact', 'date', 'approximate', 'unknown']).default('unknown'),
	url: z.string().url().max(2000),
	thumbnailUrl: z.string().max(2000),
	images: z.array(postImageSchema).max(20).optional(),
	code: z.string().max(100),
	restricted: z.boolean(),
	partial: z.boolean(),
});
export type EntryInput = z.infer<typeof entryInputSchema>;
export const subscriptionSchema = candidateSchema.extend({
	id: z.string().uuid(),
	manualAvatarAsset: imageAssetSchema.optional(),
	kind: z.enum(['creator_posts', 'performer_releases']),
	following: z.boolean(),
	enabled: z.boolean(),
	autoPaused: z.boolean(),
	intervalMinutes: z.number().int().min(15).max(10080).nullable(),
	createdAt: z.string(),
	initialized: z.boolean(),
	lastCheckedAt: z.string(),
	nextCheckAt: z.string(),
	lastError: z.string(),
	coverage: z.string(),
	failureCount: z.number(),
	unread: z.number().int(),
	collected: z.number().int().nonnegative().optional(),
	latestEntry: z.lazy(() => entrySchema).optional(),
	xSyncState: xSyncStateSchema.optional(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;
export const imageCacheSchema = z.object({
	status: z.enum(['queued', 'loading', 'retry', 'failed', 'cancelled', 'evicted']),
	attempts: z.number().int().min(0),
	nextAttemptAt: z.number(),
	reason: z.string(),
});
export type ImageCache = z.infer<typeof imageCacheSchema>;
export const entrySchema = entryInputSchema.extend({
	id: z.string(),
	subscriptionId: z.string().uuid(),
	provider: providerSchema,
	name: z.string(),
	firstSeenAt: z.string(),
	read: z.boolean(),
	initial: z.boolean(),
	imageAsset: imageAssetSchema.optional(),
	imageCache: imageCacheSchema.optional(),
});
export type FeedEntry = z.infer<typeof entrySchema>;
export const entryDetailReplySchema = z.object({ entry: entrySchema, warning: z.string().optional() });
export type EntryDetailReply = z.infer<typeof entryDetailReplySchema>;
export const followTaskSchema = z.object({
	id: z.string().uuid(),
	kind: z.enum(['lookup', 'check', 'covers']),
	provider: providerSchema,
	subscriptionId: z.string().optional(),
	imageIds: z.array(z.string()).max(500).optional(),
	completed: z.number().int().optional(),
	total: z.number().int().optional(),
	status: z.enum(['running', 'cancelling', 'cancelled', 'succeeded', 'partial', 'failed', 'interrupted']),
	phase: z.string(),
	startedAt: z.string(),
	finishedAt: z.string(),
	requests: z.number().int(),
	candidates: z.array(candidateSchema).max(8),
	added: z.number().int(),
	reason: z.string(),
	cancelRequestedAt: z.string(),
});
export type FollowTask = z.infer<typeof followTaskSchema>;
export const sourceStatusSchema = z.object({
	id: allSourceSchema,
	credentialPresent: z.boolean(),
	checkedAt: z.string(),
	state: z.string(),
	message: z.string(),
	cooldownUntil: z.number(),
});
export const subscriptionsStateSchema = z.object({
	revision: z.number().int(),
	preferences: preferencesSchema,
	subscriptions: z.array(subscriptionSchema),
	entries: z.array(entrySchema),
	tasks: z.array(followTaskSchema),
	sources: z.array(sourceStatusSchema),
	encryptionAvailable: z.boolean(),
	notice: z.string(),
});
export type SubscriptionsState = z.infer<typeof subscriptionsStateSchema>;
export const entryPageRequestSchema = z.object({
	subscriptionId: z.string().uuid(),
	page: z.number().int().min(1).max(1_000_000),
	pageSize: z.number().int().min(1).max(100),
	unread: z.boolean(),
});
export type EntryPageRequest = z.infer<typeof entryPageRequestSchema>;
export const entryPageSchema = z.object({
	entries: z.array(entrySchema).max(100),
	total: z.number().int().nonnegative(),
	page: z.number().int().positive(),
	pageSize: z.number().int().positive(),
	retryable: z.boolean().optional(),
});
export type EntryPage = z.infer<typeof entryPageSchema>;
export const followCommandSchema = z.discriminatedUnion('action', [
	z.object({ action: z.literal('query-sources'), sources: querySourcesSchema }),
	z.object({ action: z.literal('preferences'), value: preferencesSchema }),
	z.object({ action: z.literal('preferences-patch'), patch: preferencesPatchSchema }),
	z.object({ action: z.literal('source-enabled'), source: allSourceSchema, enabled: z.boolean() }),
	z.object({ action: z.literal('credential'), provider: allSourceSchema, cookie: z.string().max(12000) }),
	z.object({ action: z.literal('lookup'), provider: providerSchema, query: z.string().trim().min(1).max(500) }),
	z.object({ action: z.literal('follow'), taskId: z.string().uuid(), ref: z.string().max(256) }),
	z.object({
		action: z.literal('update'),
		id: z.string().uuid(),
		enabled: z.boolean().optional(),
		following: z.boolean().optional(),
		intervalMinutes: z.number().int().min(15).max(10080).nullable().optional(),
	}),
	z.object({ action: z.literal('check'), id: z.string().uuid() }),
	z.object({ action: z.literal('restore-avatar'), id: z.string().uuid() }),
	z.object({ action: z.literal('cancel'), id: z.string().uuid() }),
	z.object({ action: z.literal('retry-images'), subscriptionId: z.string().uuid().optional() }),
	z.object({ action: z.literal('read'), ids: z.array(z.string().max(200)).max(500), read: z.boolean() }),
	z.object({ action: z.literal('open'), kind: z.enum(['entry', 'subscription', 'source']), id: z.string().max(200) }),
]);
export type FollowCommand = z.infer<typeof followCommandSchema>;
export const commandReplySchema = z.object({ ok: z.boolean(), message: z.string().optional(), id: z.string().optional() });
export type CommandReply = z.infer<typeof commandReplySchema>;
export interface SubscriptionsBridge {
	getEntry?: (id: string) => Promise<EntryDetailReply>;
	uploadAvatar?: (id: string) => Promise<AvatarReply>;
	getEntries?: (request: EntryPageRequest) => Promise<EntryPage>;
	getState: () => Promise<SubscriptionsState>;
	retry: () => Promise<SubscriptionsState>;
	command: (command: FollowCommand) => Promise<CommandReply>;
	onState: (callback: (state: SubscriptionsState) => void) => () => void;
	onSettings: (callback: () => void) => () => void;
}
export const SUBS_IPC = {
	entry: 'nectisse:subscription-entry',
	uploadAvatar: 'nectisse:subscription-avatar-upload',
	entries: 'nectisse:subscription-entries',
	get: 'nectisse:subscriptions-get',
	retry: 'nectisse:subscriptions-retry',
	command: 'nectisse:subscriptions-command',
	state: 'nectisse:subscriptions-state',
	settings: 'nectisse:settings-open',
} as const;

export const avatarReplySchema = commandReplySchema.extend({ cancelled: z.boolean().optional() });
export type AvatarReply = z.infer<typeof avatarReplySchema>;

export function personAvatar(identity: Pick<FollowCandidate, 'avatarAsset'> & { manualAvatarAsset?: Subscription['manualAvatarAsset'] }) {
	return identity.manualAvatarAsset ?? identity.avatarAsset;
}

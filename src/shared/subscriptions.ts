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
export const entryInputSchema = z.object({
	externalId: z.string().min(1).max(100),
	title: z.string().max(1000),
	summary: z.string().max(3000),
	author: z.string().max(200),
	publishedAt: z.string().max(100),
	publishedPrecision: z.enum(['exact', 'date', 'approximate', 'unknown']).default('unknown'),
	url: z.string().url().max(2000),
	thumbnailUrl: z.string().max(2000),
	code: z.string().max(100),
	restricted: z.boolean(),
	partial: z.boolean(),
});
export type EntryInput = z.infer<typeof entryInputSchema>;
export const subscriptionSchema = candidateSchema.extend({
	id: z.string().uuid(),
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
	z.object({ action: z.literal('cancel'), id: z.string().uuid() }),
	z.object({ action: z.literal('retry-images'), subscriptionId: z.string().uuid().optional() }),
	z.object({ action: z.literal('read'), ids: z.array(z.string().max(200)).max(500), read: z.boolean() }),
	z.object({ action: z.literal('open'), kind: z.enum(['entry', 'subscription', 'source']), id: z.string().max(200) }),
]);
export type FollowCommand = z.infer<typeof followCommandSchema>;
export const commandReplySchema = z.object({ ok: z.boolean(), message: z.string().optional(), id: z.string().optional() });
export type CommandReply = z.infer<typeof commandReplySchema>;
export interface SubscriptionsBridge {
	getState: () => Promise<SubscriptionsState>;
	retry: () => Promise<SubscriptionsState>;
	command: (command: FollowCommand) => Promise<CommandReply>;
	onState: (callback: (state: SubscriptionsState) => void) => () => void;
	onSettings: (callback: () => void) => () => void;
}
export const SUBS_IPC = {
	get: 'nectisse:subscriptions-get',
	retry: 'nectisse:subscriptions-retry',
	command: 'nectisse:subscriptions-command',
	state: 'nectisse:subscriptions-state',
	settings: 'nectisse:settings-open',
} as const;

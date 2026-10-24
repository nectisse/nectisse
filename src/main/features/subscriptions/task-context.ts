import { z } from 'zod';
import { imageAssetSchema } from '@shared/metadata';
import { candidateSchema, type FollowTask } from '@shared/subscriptions';

export const outcomeSchema = z.object({
	status: z.enum(['success', 'partial', 'error']),
	reason: z.string().max(100),
	message: z.string().max(500),
	requests: z.number().int().max(24),
	retryAfter: z.number().int().max(86400),
	candidates: z.array(candidateSchema).max(8).optional(),
	coverage: z.string().max(500).optional(),
	gap: z.boolean().optional(),
	warnings: z.array(z.string()).optional(),
	asset: imageAssetSchema.optional(),
	avatarUrl: z.string().max(2000).optional(),
});

/** 执行模块共享进度与许可；活动任务和取消意图归调度模块。 */
export interface TaskContext {
	readonly task: FollowTask;
	readonly signal: AbortSignal;
	running(): boolean;
	save(): void;
	permit(source: string): Promise<void>;
	notice(message: string): void;
}

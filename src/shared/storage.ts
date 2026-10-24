import { z } from 'zod';

export type ImageVariant = 'thumbnail' | 'original';
export const storageUsageSchema = z.object({
	collectionBytes: z.number().nonnegative(),
	protectedBytes: z.number().nonnegative(),
	cacheBytes: z.number().nonnegative(),
	originalBytes: z.number().nonnegative(),
	thumbnailBytes: z.number().nonnegative(),
	limitBytes: z.number().nonnegative(),
	files: z.number().int().nonnegative(),
});
export type StorageUsage = z.infer<typeof storageUsageSchema>;
export const storageClearSchema = z.object({ freedBytes: z.number().nonnegative(), removedFiles: z.number().int().nonnegative(), usage: storageUsageSchema });
export interface StorageBridge {
	usage(): Promise<StorageUsage>;
	clear(): Promise<z.infer<typeof storageClearSchema>>;
}
export const STORAGE_IPC = { usage: 'nectisse:storage-usage', clear: 'nectisse:storage-clear' } as const;

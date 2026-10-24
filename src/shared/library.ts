import { z } from 'zod';
import { coverSchema, metadataRecordSchema, type MetadataRecord } from '@shared/metadata';

export const libraryIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const savedWorkSchema = z.object({
	id: libraryIdSchema,
	code: z.string().min(1).max(100),
	savedAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	records: z.array(metadataRecordSchema).min(1).max(30),
	coverId: libraryIdSchema.nullable(),
});
export type SavedWork = z.infer<typeof savedWorkSchema>;
export const workSummarySchema = savedWorkSchema.omit({ records: true, coverId: true }).extend({
	title: z.string().max(1000),
	people: z.array(z.string().max(200)).max(42),
	studio: z.string().max(500),
	releaseDate: z.string().max(32),
	tags: z.array(z.string().max(100)).max(60),
	cover: coverSchema.optional(),
});
export type WorkSummary = z.infer<typeof workSummarySchema>;
export const libraryStateSchema = z.object({ revision: z.number().int().nonnegative(), works: z.array(workSummarySchema).max(5000) });
export type LibraryState = z.infer<typeof libraryStateSchema>;
export const librarySaveSchema = z.object({
	taskId: z.string().uuid(),
	code: z.string().min(1).max(100),
	coverId: libraryIdSchema.optional(),
	replace: z.boolean().default(false),
});
export type LibrarySave = z.infer<typeof librarySaveSchema>;
export const libraryReplySchema = z.object({ ok: z.boolean(), id: libraryIdSchema.optional(), message: z.string().max(500).optional() });
export type LibraryReply = z.infer<typeof libraryReplySchema>;
export const LIBRARY_IPC = {
	get: 'nectisse:library-get',
	retry: 'nectisse:library-retry',
	work: 'nectisse:library-work',
	save: 'nectisse:library-save',
	remove: 'nectisse:library-remove',
	openSource: 'nectisse:library-open-source',
	state: 'nectisse:library-state',
} as const;
export interface LibraryBridge {
	getState(): Promise<LibraryState>;

	retry(): Promise<LibraryState>;

	getWork(id: string): Promise<SavedWork | undefined>;

	save(input: LibrarySave): Promise<LibraryReply>;

	remove(id: string): Promise<LibraryReply>;

	openSource(id: string, recordId: string): Promise<void>;

	onState(callback: (state: LibraryState) => void): () => void;
}

export function summarizeWork(work: SavedWork): WorkSummary {
	const first = <K extends 'title' | 'people' | 'studio' | 'releaseDate' | 'tags'>(key: K): MetadataRecord[K] =>
		(work.records.find((record) => record[key].length > 0) ?? work.records[0]!)[key];

	const cover = work.records.flatMap((record) => record.covers).find((cover) => cover.id === work.coverId);

	return {
		id: work.id,
		code: work.code,
		savedAt: work.savedAt,
		updatedAt: work.updatedAt,
		title: first('title') || work.code,

		people: first('people')
			.filter((person) => person.role === 'performer')
			.map((person) => person.name),

		studio: first('studio'),
		releaseDate: first('releaseDate'),
		tags: first('tags'),
		...(cover ? { cover } : {}),
	};
}

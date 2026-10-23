import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { metadataRecordSchema, type ImageAsset, type MetadataRecord } from '../shared/metadata';
import { savedWorkSchema, summarizeWork, workSummarySchema, type LibraryState, type SavedWork } from '../shared/library';
import { allowedSourceUrl } from '../shared/source-identity';
import { preferredCover } from '../shared/cover-selection';

type ReadImage = (hash: string) => Promise<{ bytes: Buffer; asset: ImageAsset } | undefined>;
export class LibraryService extends EventEmitter {
	private db: DatabaseSync | undefined;
	private pending: Promise<unknown> = Promise.resolve();
	private disposed = false;
	private revision = 0;
	private directory: string;
	private covers: string;
	constructor(root: string) {
		super();
		this.directory = join(root, 'library');
		this.covers = join(this.directory, 'covers');
	}
	async initialize(): Promise<void> {
		await mkdir(this.covers, { recursive: true, mode: 0o700 });
		const path = join(this.directory, 'library.sqlite');
		const db = new DatabaseSync(path);
		try {
			db.exec(
				'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, cover_sha TEXT, value TEXT NOT NULL, summary TEXT NOT NULL); CREATE INDEX IF NOT EXISTS works_cover ON works(cover_sha)',
			);
			if (
				!db
					.prepare('PRAGMA table_info(works)')
					.all()
					.some((column) => column.name === 'summary')
			) {
				db.exec('BEGIN IMMEDIATE');
				try {
					db.exec('ALTER TABLE works ADD COLUMN summary TEXT');
					const update = db.prepare('UPDATE works SET summary=? WHERE id=?');
					for (const row of db.prepare('SELECT id,value FROM works').all())
						update.run(JSON.stringify(summarizeWork(savedWorkSchema.parse(JSON.parse(String(row.value))))), String(row.id));
					db.exec('COMMIT');
				} catch (error) {
					db.exec('ROLLBACK');
					throw error;
				}
			}
			await chmod(path, 0o600);
			this.db = db;
			this.getState(); // Validate records before exposing the service; never reset a damaged database.
		} catch (error) {
			this.db = undefined;
			db.close();
			throw error;
		}
	}
	getWork(id: string): SavedWork | undefined {
		const row = this.db!.prepare('SELECT value FROM works WHERE id=?').get(id);
		return row ? savedWorkSchema.parse(JSON.parse(String(row.value))) : undefined;
	}
	getState(): LibraryState {
		// List and image requests read compact projections; full snapshots load only on demand.
		const works = this.db!.prepare('SELECT summary FROM works')
			.all()
			.map((row) => workSummarySchema.parse(JSON.parse(String(row.summary))));
		return { revision: this.revision, works: works.sort((a, b) => b.savedAt.localeCompare(a.savedAt)) };
	}
	private changed(): void {
		this.revision++;
		this.emit('state', this.getState());
	}
	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.disposed) return Promise.reject(new Error('LIBRARY_STOPPING'));
		// 图片落盘和数据库更新共用队列，删除引用检查不能与另一次收藏交错。
		const result = this.pending.catch(() => {}).then(operation);
		this.pending = result;
		return result;
	}
	private async discardUnreferenced(hash?: string | null): Promise<void> {
		if (hash && !this.db!.prepare('SELECT 1 FROM works WHERE cover_sha=? LIMIT 1').get(hash)) await rm(join(this.covers, `${hash}.image`), { force: true }).catch(() => {});
	}
	save(input: MetadataRecord[], coverId: string | undefined, replace: boolean, readImage: ReadImage): Promise<SavedWork> {
		// Snapshot before any await: network results can continue updating their query.
		const records = input.map((record) => metadataRecordSchema.parse(structuredClone(record)));
		return this.enqueue(async () => {
			const code = records[0]?.code;
			if (!code || records.some((record) => record.code !== code)) throw new Error('LIBRARY_IDENTITY_INVALID');
			const id = createHash('sha256').update(`work:${code}`).digest('hex');
			const previous = this.getWork(id);
			if (previous && !replace) return previous;
			if (!previous && Number(this.db!.prepare('SELECT count(*) AS count FROM works').get()!.count) >= 5000) throw new Error('LIBRARY_FULL');
			const candidates = records.flatMap((record) => record.covers);
			const selected = coverId
				? (candidates.find((cover) => cover.id === coverId && cover.asset) ?? candidates.find((cover) => cover.id === coverId))
				: preferredCover(candidates);
			if (coverId && !selected) throw new Error('LIBRARY_COVER_UNAVAILABLE');
			if (previous && summarizeWork(previous).cover?.asset && !selected?.asset) throw new Error('LIBRARY_COVER_UNAVAILABLE');
			let pinned: ImageAsset | undefined;
			if (selected?.asset) {
				const found = await readImage(selected.asset.sha256);
				if (!found || found.bytes.length !== selected.asset.bytes || createHash('sha256').update(found.bytes).digest('hex') !== selected.asset.sha256)
					throw new Error('LIBRARY_COVER_UNAVAILABLE');
				pinned = selected.asset;
				const temporary = join(this.covers, `.save-${randomUUID()}.tmp`);
				try {
					await writeFile(temporary, found.bytes, { mode: 0o600 });
					await rename(temporary, join(this.covers, `${pinned.sha256}.image`));
				} finally {
					await rm(temporary, { force: true });
				}
			}
			for (const record of records)
				for (const cover of record.covers) {
					if (pinned && cover.asset?.sha256 === pinned.sha256) {
						cover.asset = pinned;
						delete cover.error;
					} else if (cover.asset) {
						delete cover.asset;
						cover.error = '此候选原图未保存到收藏';
					}
				}
			const now = new Date().toISOString();
			const work = savedWorkSchema.parse({ id, code, records, coverId: selected?.id ?? null, savedAt: previous?.savedAt ?? now, updatedAt: now });
			try {
				this.db!.prepare(
					'INSERT INTO works(id,cover_sha,value,summary) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET cover_sha=excluded.cover_sha,value=excluded.value,summary=excluded.summary',
				).run(id, pinned?.sha256 ?? null, JSON.stringify(work), JSON.stringify(summarizeWork(work)));
			} catch (error) {
				await this.discardUnreferenced(pinned?.sha256);
				throw error;
			}
			await this.discardUnreferenced(previous ? summarizeWork(previous).cover?.asset?.sha256 : null);
			this.changed();
			return work;
		});
	}
	remove(id: string): Promise<void> {
		return this.enqueue(async () => {
			const work = this.getWork(id);
			if (!work) return;
			this.db!.prepare('DELETE FROM works WHERE id=?').run(id);
			await this.discardUnreferenced(summarizeWork(work).cover?.asset?.sha256);
			this.changed();
		});
	}
	async image(hash: string): ReturnType<ReadImage> {
		if (!/^[a-f0-9]{64}$/.test(hash)) return;
		const row = this.db!.prepare('SELECT summary FROM works WHERE cover_sha=? LIMIT 1').get(hash);
		if (!row) return;
		const asset = workSummarySchema.parse(JSON.parse(String(row.summary))).cover?.asset;
		if (!asset || asset.sha256 !== hash) return;
		try {
			const path = join(this.covers, `${hash}.image`);
			if ((await stat(path)).size !== asset.bytes) return;
			const bytes = await readFile(path);
			if (createHash('sha256').update(bytes).digest('hex') === hash) return { bytes, asset };
		} catch {
			/* Missing local images remain an explicit fallback. */
		}
	}
	sourceUrl(id: string, recordId: string): string | undefined {
		const record = this.getWork(id)?.records.find((record) => record.id === recordId);
		return record ? allowedSourceUrl(record.source, record.sourceUrl) : undefined;
	}
	async stop(): Promise<void> {
		this.disposed = true;
		await this.pending.catch(() => {});
		this.db?.close();
		this.db = undefined;
	}
}

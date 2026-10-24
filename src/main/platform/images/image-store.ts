import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { imageAssetSchema, type ImageAsset } from '@shared/metadata';
import type { ImageVariant, StorageUsage } from '@shared/storage';

export interface ImageBytes {
	bytes: Buffer;
	asset: ImageAsset;
}
export type Thumbnailer = (image: ImageBytes) => ImageBytes;
type Link = { original: string | null; thumbnail: string | null; fetched: number; accessed: number; unread: number; seen: number };
type Flight = { controller: AbortController; promise: Promise<void>; users: number; original: boolean };
type StoredObject = { sha: string; bytes: number; kind: string; accessed: number; hits: number; pinned: number; collection: number; unread: number; seen: number };
const hashOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const REFRESH_MS = 30 * 86400_000;

export function isImageCorruption(error: unknown): boolean {
	return error instanceof Error && (['Image mismatch', 'IMAGE_DECODE_FAILED'].includes(error.message) || error.name === 'ZodError');
}

/** 图片按内容共享；刷新不删除旧副本，只有容量淘汰可以回收未固定文件。 */
export class ImageStore {
	private db?: DatabaseSync;
	private pending: Promise<unknown> = Promise.resolve();
	private flights = new Map<string, Flight>();
	private failed = new Map<string, number>();
	private generation = 0;
	private stopped = false;
	private clearing = false;
	private dirty = true;
	private limit = 512 * 1024 * 1024;
	private directory: string;

	constructor(
		private root: string,
		private thumbnailer: Thumbnailer,
		private clock = Date.now,
	) {
		this.directory = join(root, 'images');
	}

	async initialize(): Promise<void> {
		if (this.db) {
			return;
		}
		await mkdir(join(this.directory, 'objects'), { recursive: true, mode: 0o700 });
		await rm(join(this.directory, 'requests'), { recursive: true, force: true });
		const db = new DatabaseSync(join(this.directory, 'images.sqlite'));
		try {
			db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
				CREATE TABLE IF NOT EXISTS objects (sha TEXT PRIMARY KEY, asset TEXT NOT NULL, kind TEXT NOT NULL, accessed REAL NOT NULL, hits INTEGER NOT NULL DEFAULT 0);
				CREATE TABLE IF NOT EXISTS refs (key TEXT PRIMARY KEY, original TEXT, thumbnail TEXT, fetched REAL NOT NULL, accessed REAL NOT NULL, unread INTEGER NOT NULL DEFAULT 0, seen REAL NOT NULL DEFAULT 0);
				CREATE TABLE IF NOT EXISTS pins (owner TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY(owner,sha));
				CREATE INDEX IF NOT EXISTS refs_original ON refs(original);
				CREATE INDEX IF NOT EXISTS refs_thumbnail ON refs(thumbnail);
				CREATE INDEX IF NOT EXISTS pins_sha ON pins(sha);`);
			if (
				!db
					.prepare('PRAGMA table_info(objects)')
					.all()
					.some((column) => column.name === 'hits')
			) {
				db.exec('ALTER TABLE objects ADD COLUMN hits INTEGER NOT NULL DEFAULT 0');
			}
			this.db = db;
			await chmod(join(this.directory, 'images.sqlite'), 0o600);
			for (const name of await readdir(join(this.directory, 'objects'))) {
				if (name.startsWith('.temporary-') || (/^[a-f0-9]{64}\.image$/.test(name) && !db.prepare('SELECT 1 FROM objects WHERE sha=?').get(name.slice(0, 64)))) {
					await rm(join(this.directory, 'objects', name), { force: true });
				}
			}
		} catch (error) {
			this.db = undefined;
			db.close();
			throw error;
		}
	}

	put(
		key: string,
		image: ImageBytes,
		options: { thumbnailOnly?: boolean; unread?: boolean; seen?: number; generation?: number; refresh?: boolean; owner?: string } = {},
	): Promise<{ original?: ImageAsset; thumbnail: ImageAsset }> {
		const generation = options.generation ?? this.generation;
		return this.enqueue(async () => {
			if (generation !== this.generation) {
				throw new Error('IMAGE_CANCELLED');
			}
			this.verify(image);
			const thumbnail = this.thumbnailer(image);
			this.verify(thumbnail);
			this.dirty = true;
			const old = this.link(key);
			const retained = !options.thumbnailOnly || old?.original === image.asset.sha256;
			if (retained) {
				await this.install(image, 'original');
			}
			await this.install(thumbnail, 'thumbnail');
			const now = this.clock();
			this.db!.prepare(
				'INSERT INTO refs VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET original=excluded.original,thumbnail=excluded.thumbnail,fetched=excluded.fetched,unread=excluded.unread,seen=excluded.seen',
			).run(
				key,
				retained ? image.asset.sha256 : null,
				thumbnail.asset.sha256,
				options.refresh === false && old ? old.fetched : now,
				old?.accessed ?? 0,
				options.unread === undefined ? (old?.unread ?? 0) : Number(options.unread),
				options.seen ?? old?.seen ?? now,
			);
			if (options.owner) {
				this.pin(options.owner, key);
			}
			return { ...(retained ? { original: image.asset } : {}), thumbnail: thumbnail.asset };
		});
	}

	async read(key: string, variant: ImageVariant, load?: (signal: AbortSignal) => Promise<ImageBytes>, signal?: AbortSignal): Promise<ImageBytes | undefined> {
		const generation = this.generation;
		await this.pending;
		signal?.throwIfAborted();
		const link = this.link(key);
		let cached = link?.[variant] ? await this.readHash(link[variant]!, true) : undefined;
		if (!cached && variant === 'thumbnail' && link?.original && !this.stopped && !this.clearing) {
			const original = await this.readHash(link.original, false);
			if (original) {
				const owner = this.db!.prepare('SELECT 1 FROM pins WHERE owner=?').get(key) ? key : undefined;
				const saved = await this.put(key, original, { generation, owner, refresh: false });
				cached = await this.readHash(saved.thumbnail.sha256);
			}
		}
		if (!load || this.stopped || this.clearing || (cached && this.clock() - link!.fetched < REFRESH_MS) || (this.failed.get(key) ?? 0) > this.clock()) {
			return cached ?? (variant === 'original' && link?.thumbnail ? this.readHash(link.thumbnail) : undefined);
		}
		if (cached) {
			void this.acquire(key, variant, load).catch(() => {});
			return cached;
		}
		try {
			await this.acquire(key, variant, load, signal);
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
		}
		const next = this.link(key);
		const fetched = next?.[variant] ? await this.readHash(next[variant]!) : undefined;
		return fetched ?? (next?.thumbnail ? this.readHash(next.thumbnail) : undefined);
	}

	async readHash(sha: string, touch = true): Promise<ImageBytes | undefined> {
		if (!/^[a-f0-9]{64}$/.test(sha) || !this.db) {
			return;
		}
		const row = this.db.prepare('SELECT asset FROM objects WHERE sha=?').get(sha);
		if (!row) {
			return;
		}
		try {
			const image = { bytes: await readFile(this.path(sha)), asset: imageAssetSchema.parse(JSON.parse(String(row.asset))) };
			this.verify(image);
			if (touch) {
				this.db?.prepare('UPDATE objects SET accessed=?,hits=hits+1 WHERE sha=?').run(this.clock(), sha);
				this.db?.prepare('UPDATE refs SET accessed=? WHERE original=? OR thumbnail=?').run(this.clock(), sha, sha);
			}
			return image;
		} catch {
			return;
		}
	}

	protect(owner: string, key: string): Promise<void> {
		return this.enqueue(async () => {
			this.pin(owner, key);
		});
	}

	isOriginal(key: string, sha: string): boolean {
		return this.link(key)?.original === sha;
	}

	unprotect(owner: string): Promise<void> {
		return this.enqueue(async () => {
			this.db!.prepare('DELETE FROM pins WHERE owner=?').run(owner);
			this.db!.prepare('DELETE FROM refs WHERE key=?').run(owner);
			this.dirty = true;
		});
	}

	retainPins(prefix: string, owners: Set<string>): Promise<void> {
		return this.enqueue(async () => {
			for (const row of this.db!.prepare('SELECT DISTINCT owner FROM pins').all()) {
				const owner = String(row.owner);
				if (owner.startsWith(prefix) && !owners.has(owner)) {
					this.db!.prepare('DELETE FROM pins WHERE owner=?').run(owner);
					this.db!.prepare('DELETE FROM refs WHERE key=?').run(owner);
					this.dirty = true;
				}
			}
		});
	}

	async setLimit(mebibytes: number): Promise<void> {
		this.limit = mebibytes * 1024 * 1024;
		this.dirty = true;
		await this.prune();
	}

	priority(key: string, unread: boolean, seen: number): void {
		this.db!.prepare('UPDATE refs SET unread=?,seen=? WHERE key=?').run(Number(unread), Number.isFinite(seen) ? seen : 0, key);
	}

	prune(): Promise<void> {
		return this.enqueue(async () => {
			if (!this.dirty) {
				return;
			}
			await this.evict(this.limit);
			this.dirty = false;
		});
	}

	async usage(): Promise<StorageUsage> {
		await this.pending;
		const rows = this.rows();
		let collectionBytes = 0;
		let protectedBytes = 0;
		let originalBytes = 0;
		let thumbnailBytes = 0;
		for (const row of rows) {
			const bytes = (await stat(this.path(row.sha)).catch(() => undefined))?.size ?? 0;
			if (row.collection) {
				collectionBytes += bytes;
			} else if (row.pinned) {
				protectedBytes += bytes;
			} else if (row.kind === 'original') {
				originalBytes += bytes;
			} else {
				thumbnailBytes += bytes;
			}
		}
		for (const name of ['library.sqlite', 'library.sqlite-wal']) {
			collectionBytes += (await stat(join(this.root, 'library', name)).catch(() => undefined))?.size ?? 0;
		}
		return { collectionBytes, protectedBytes, cacheBytes: originalBytes + thumbnailBytes, originalBytes, thumbnailBytes, limitBytes: this.limit, files: rows.length };
	}

	async clear(): Promise<{ freedBytes: number; removedFiles: number; usage: StorageUsage }> {
		this.clearing = true;
		try {
			this.generation++;
			for (const flight of this.flights.values()) {
				flight.controller.abort();
			}
			await Promise.allSettled([...this.flights.values()].map((flight) => flight.promise));
			const result = await this.enqueue(() => this.evict(0));
			this.failed.clear();
			return { ...result, usage: await this.usage() };
		} finally {
			this.clearing = false;
		}
	}

	async close(): Promise<void> {
		this.stopped = true;
		this.generation++;
		for (const flight of this.flights.values()) {
			flight.controller.abort();
		}
		await Promise.allSettled([...this.flights.values()].map((flight) => flight.promise));
		await this.pending;
		this.db?.close();
		this.db = undefined;
	}

	private link(key: string): Link | undefined {
		return this.db?.prepare('SELECT * FROM refs WHERE key=?').get(key) as Link | undefined;
	}

	private pin(owner: string, key: string): void {
		const link = this.link(key);
		if (!link?.original) {
			throw new Error('PINNED_IMAGE_MISSING');
		}
		this.db!.exec('BEGIN IMMEDIATE');
		try {
			this.db!.prepare('DELETE FROM pins WHERE owner=?').run(owner);
			for (const sha of new Set([link.original, link.thumbnail].filter(Boolean) as string[])) {
				this.db!.prepare('INSERT INTO pins VALUES(?,?)').run(owner, sha);
			}
			this.db!.prepare('INSERT OR REPLACE INTO refs VALUES(?,?,?,?,?,?,?)').run(owner, link.original, link.thumbnail, link.fetched, link.accessed, 0, link.seen);
			this.db!.exec('COMMIT');
		} catch (error) {
			this.db!.exec('ROLLBACK');
			throw error;
		}
	}

	private async acquire(key: string, variant: ImageVariant, load: (signal: AbortSignal) => Promise<ImageBytes>, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		let flight = this.flights.get(key);
		if (flight?.controller.signal.aborted) {
			flight = undefined;
		}
		if (!flight) {
			const controller = new AbortController();
			const generation = this.generation;
			flight = { controller, users: 0, original: variant === 'original', promise: Promise.resolve() };
			const current = flight;
			flight.promise = (async () => {
				try {
					const image = await load(controller.signal);
					controller.signal.throwIfAborted();
					await this.put(key, image, { thumbnailOnly: !current.original, generation });
					await this.prune();
					this.failed.delete(key);
				} catch (error) {
					if (!controller.signal.aborted) {
						this.failed.set(key, this.clock() + 60_000);
					}
					throw error;
				} finally {
					if (this.flights.get(key) === current) {
						this.flights.delete(key);
					}
				}
			})();
			this.flights.set(key, flight);
		}
		flight.original ||= variant === 'original';
		flight.users++;
		const active = flight;
		let abort: () => void = () => {};
		try {
			await Promise.race([
				active.promise,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(new Error('IMAGE_CANCELLED'));
					signal?.addEventListener('abort', abort, { once: true });
					if (signal?.aborted) {
						abort();
					}
				}),
			]);
		} finally {
			signal?.removeEventListener('abort', abort);
			if (--active.users === 0 && this.flights.get(key) === active) {
				active.controller.abort();
			}
		}
	}

	private async install(image: ImageBytes, kind: ImageVariant): Promise<void> {
		if (!(await this.readHash(image.asset.sha256, false))) {
			const temporary = join(this.directory, 'objects', `.temporary-${randomUUID()}`);
			try {
				await writeFile(temporary, image.bytes, { mode: 0o600 });
				await rename(temporary, this.path(image.asset.sha256));
			} finally {
				await rm(temporary, { force: true });
			}
		}
		this.db!.prepare('INSERT INTO objects(sha,asset,kind,accessed) VALUES(?,?,?,?) ON CONFLICT(sha) DO NOTHING').run(
			image.asset.sha256,
			JSON.stringify(image.asset),
			kind,
			this.clock(),
		);
	}

	private rows(): StoredObject[] {
		return this.db!.prepare(
			`SELECT o.sha,json_extract(o.asset,'$.bytes') AS bytes,
			CASE WHEN EXISTS(SELECT 1 FROM refs r WHERE r.thumbnail=o.sha) THEN 'thumbnail' ELSE o.kind END AS kind,o.accessed,o.hits,
			EXISTS(SELECT 1 FROM pins p WHERE p.sha=o.sha) AS pinned,
			EXISTS(SELECT 1 FROM pins p WHERE p.sha=o.sha AND p.owner LIKE 'collection:%') AS collection,
			COALESCE((SELECT MAX(unread) FROM refs r WHERE r.thumbnail=o.sha),0) AS unread,
			COALESCE((SELECT MAX(seen) FROM refs r WHERE r.thumbnail=o.sha),0) AS seen FROM objects o`,
		).all() as StoredObject[];
	}

	private async evict(limit: number): Promise<{ freedBytes: number; removedFiles: number }> {
		const rows = this.rows().filter((row) => !row.pinned);
		let remaining = rows.reduce((sum, row) => sum + row.bytes, 0);
		let freedBytes = 0;
		let removedFiles = 0;
		rows.sort(
			(a, b) =>
				Number(a.kind !== 'original') - Number(b.kind !== 'original') ||
				(a.kind === 'original'
					? a.accessed - b.accessed
					: a.unread - b.unread ||
						Number(a.seen > this.clock() - 7 * 86400_000) - Number(b.seen > this.clock() - 7 * 86400_000) ||
						a.hits - b.hits ||
						a.accessed - b.accessed ||
						a.seen - b.seen),
		);
		for (const row of rows) {
			if (remaining <= limit) {
				break;
			}
			const bytes = (await stat(this.path(row.sha)).catch(() => undefined))?.size ?? 0;
			await rm(this.path(row.sha), { force: true });
			this.db!.prepare('DELETE FROM objects WHERE sha=?').run(row.sha);
			this.db!.prepare('UPDATE refs SET original=NULL WHERE original=?').run(row.sha);
			this.db!.prepare('UPDATE refs SET thumbnail=NULL WHERE thumbnail=?').run(row.sha);
			remaining -= row.bytes;
			freedBytes += bytes;
			removedFiles += Number(bytes > 0);
		}
		this.db!.exec('DELETE FROM refs WHERE original IS NULL AND thumbnail IS NULL AND NOT EXISTS(SELECT 1 FROM pins WHERE pins.owner=refs.key)');
		return { freedBytes, removedFiles };
	}

	private path(sha: string): string {
		return join(this.directory, 'objects', `${sha}.image`);
	}

	private verify(image: ImageBytes): void {
		imageAssetSchema.parse(image.asset);
		if (image.bytes.length !== image.asset.bytes || hashOf(image.bytes) !== image.asset.sha256) {
			throw new Error('Image mismatch');
		}
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.stopped || !this.db) {
			return Promise.reject(new Error('IMAGE_STORE_UNAVAILABLE'));
		}
		const task = this.pending.catch(() => {}).then(operation);
		this.pending = task.catch(() => {});
		return task;
	}
}

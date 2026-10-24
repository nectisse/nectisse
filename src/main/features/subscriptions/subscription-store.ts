import { DEFAULT_PREFERENCES, preferencesSchema, type Preferences } from '@shared/preferences';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageAsset } from '@shared/metadata';
import {
	subscriptionSchema,
	followTaskSchema,
	type FollowCandidate,
	type Subscription,
	type FeedEntry,
	type EntryInput,
	type FollowTask,
	type AllSource,
	type ImageCache,
} from '@shared/subscriptions';

export interface Cipher {
	available: () => boolean;
	encrypt: (value: string) => Buffer;
	decrypt: (value: Buffer) => string;
}

const now = (): string => new Date().toISOString();

export class SubscriptionStore {
	readonly db: DatabaseSync;

	constructor(
		readonly root: string,
		readonly cipher: Cipher,
	) {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const path = join(root, 'nectisse.sqlite');
		this.db = new DatabaseSync(path);
		try {
			chmodSync(path, 0o600);
			this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
				CREATE TABLE IF NOT EXISTS preferences (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, ciphertext BLOB NOT NULL);
				CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, provider TEXT NOT NULL, ref TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(provider,ref));
				CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, external_id TEXT NOT NULL, value TEXT NOT NULL, first_seen TEXT NOT NULL, UNIQUE(subscription_id,external_id));
				CREATE INDEX IF NOT EXISTS entries_subscription ON entries(subscription_id);
				CREATE TABLE IF NOT EXISTS follow_tasks (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, value TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS source_status (id TEXT PRIMARY KEY, value TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS follow_images (url TEXT PRIMARY KEY, value TEXT NOT NULL, saved_at INTEGER NOT NULL);
				PRAGMA user_version=1;`);
			for (const task of this.tasks()) {
				if (task.status === 'running' || task.status === 'cancelling') {
					task.status = task.cancelRequestedAt ? 'cancelled' : 'interrupted';
					task.finishedAt = now();
					task.phase = '上次任务已停止，不会自动恢复';
					this.saveTask(task);
					if (task.kind === 'covers') {
						for (const id of task.imageIds ?? []) {
							const entry = this.entry(id);
							if (entry && !entry.imageAsset && entry.imageCache?.status !== 'failed') {
								this.setImageCache([id], {
									status: task.cancelRequestedAt ? 'cancelled' : 'queued',
									attempts: entry.imageCache?.attempts ?? 0,
									nextAttemptAt: 0,
									reason: task.cancelRequestedAt ? 'cancelled' : '',
								});
							}
						}
					} else if (task.subscriptionId) {
						const sub = this.subscription(task.subscriptionId);
						if (sub) {
							sub.autoPaused = true;
							sub.lastError = '上次任务已停止；请手动检查或恢复自动检查';
							this.saveSubscription(sub);
						}
					}
				}
			}
		} catch (error) {
			try {
				this.db.close();
			} catch {
				/* Preserve the initialization error. */
			}
			throw error;
		}
	}

	preferences(): Preferences {
		const row = this.db.prepare('SELECT value FROM preferences WHERE id=1').get();
		return row ? preferencesSchema.parse(JSON.parse(String(row.value))) : structuredClone(DEFAULT_PREFERENCES);
	}

	savePreferences(value: Preferences): void {
		this.db.prepare('INSERT INTO preferences VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(preferencesSchema.parse(value)));
	}

	credentialPresent(provider: AllSource): boolean {
		return !!this.db.prepare('SELECT provider FROM credentials WHERE provider=?').get(provider);
	}

	credential(provider: AllSource): string {
		const row = this.db.prepare('SELECT ciphertext FROM credentials WHERE provider=?').get(provider);
		return row ? this.cipher.decrypt(Buffer.from(row.ciphertext as Uint8Array)) : '';
	}

	saveCredential(provider: AllSource, value: string): void {
		if (!value) {
			this.db.prepare('DELETE FROM credentials WHERE provider=?').run(provider);
			return;
		}
		let available = false;
		try {
			available = this.cipher.available();
		} catch {
			/* Never fall back to plaintext credentials. */
		}
		if (!available) {
			throw new Error('系统安全存储暂不可用，未保存 Cookie');
		}
		if (/[\r\n]/.test(value)) {
			throw new Error('Cookie 不能包含换行');
		}
		this.db.prepare('INSERT INTO credentials VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET ciphertext=excluded.ciphertext').run(provider, this.cipher.encrypt(value));
	}

	subscriptions(): Subscription[] {
		return this.db
			.prepare('SELECT value FROM subscriptions ORDER BY rowid DESC')
			.all()
			.map((row) => {
				const value = subscriptionSchema.parse(JSON.parse(String(row.value)));
				value.unread = Number(this.db.prepare("SELECT count(*) AS n FROM entries WHERE subscription_id=? AND json_extract(value,'$.read')=0").get(value.id)?.n ?? 0);
				return value;
			});
	}

	subscription(id: string): Subscription | undefined {
		const row = this.db.prepare('SELECT value FROM subscriptions WHERE id=?').get(id);
		return row ? subscriptionSchema.parse(JSON.parse(String(row.value))) : undefined;
	}

	saveSubscription(value: Subscription): void {
		this.db
			.prepare('INSERT INTO subscriptions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
			.run(value.id, value.provider, value.ref, JSON.stringify(value));
	}

	follow(candidate: FollowCandidate): Subscription {
		const previous = this.db.prepare('SELECT value FROM subscriptions WHERE provider=? AND ref=?').get(candidate.provider, candidate.ref);
		const value: Subscription = previous
			? { ...subscriptionSchema.parse(JSON.parse(String(previous.value))), following: true, enabled: true, autoPaused: false }
			: {
					...candidate,
					id: randomUUID(),
					kind: candidate.provider === 'javdb' ? 'performer_releases' : 'creator_posts',
					following: true,
					enabled: true,
					autoPaused: false,
					intervalMinutes: null,
					createdAt: now(),
					initialized: false,
					lastCheckedAt: '',
					nextCheckAt: '',
					lastError: '',
					coverage: '等待首次检查',
					failureCount: 0,
					unread: 0,
				};
		if (candidate.avatarUrl) {
			if (value.avatarUrl !== candidate.avatarUrl) {
				delete value.avatarAsset;
			}
			value.avatarUrl = candidate.avatarUrl;
			if (candidate.avatarAsset) {
				value.avatarAsset = candidate.avatarAsset;
			}
		}
		this.saveSubscription(value);
		return value;
	}

	entries(subscriptionId?: string): FeedEntry[] {
		const rows = subscriptionId
			? this.db.prepare('SELECT value FROM entries WHERE subscription_id=? ORDER BY first_seen DESC,rowid ASC LIMIT 500').all(subscriptionId)
			: this.db.prepare('SELECT value FROM entries ORDER BY first_seen DESC,rowid ASC LIMIT 500').all();
		return rows.map((row) => JSON.parse(String(row.value)) as FeedEntry);
	}

	entry(id: string): FeedEntry | undefined {
		const row = this.db.prepare('SELECT value FROM entries WHERE id=?').get(id);
		return row ? (JSON.parse(String(row.value)) as FeedEntry) : undefined;
	}

	upsertEntry(subscription: Subscription, input: EntryInput, discoveredAt = now()): boolean {
		const id = createHash('sha256').update(`${subscription.id}:${input.externalId}`).digest('hex');
		const previous = this.entry(id);
		const thumbnailUrl = input.thumbnailUrl || previous?.thumbnailUrl || '';
		const sameImage = thumbnailUrl === previous?.thumbnailUrl;
		const value: FeedEntry = {
			...input,
			...(previous && !previous.partial && input.partial ? { summary: previous.summary, partial: false } : {}),
			...(sameImage && previous?.imageAsset ? { imageAsset: previous.imageAsset } : {}),
			...(sameImage && previous?.imageCache ? { imageCache: previous.imageCache } : {}),
			thumbnailUrl,
			id,
			subscriptionId: subscription.id,
			provider: subscription.provider,
			name: subscription.name,
			firstSeenAt: previous?.firstSeenAt ?? discoveredAt,
			read: previous?.read ?? false,
			initial: previous?.initial ?? !subscription.initialized,
		};
		this.db
			.prepare('INSERT INTO entries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
			.run(id, subscription.id, input.externalId, JSON.stringify(value), value.firstSeenAt);
		return !previous;
	}

	markRead(ids: string[], read: boolean): void {
		this.db.exec('BEGIN');
		try {
			const write = this.db.prepare('UPDATE entries SET value=? WHERE id=?');
			for (const id of ids) {
				const item = this.entry(id);
				if (item) {
					write.run(JSON.stringify({ ...item, read }), id);
				}
			}
			this.db.exec('COMMIT');
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	seen(subscriptionId: string): string[] {
		return this.entries(subscriptionId)
			.slice(0, 200)
			.map((item) => item.externalId);
	}

	image(url: string): ImageAsset | undefined {
		const row = this.db.prepare('SELECT value FROM follow_images WHERE url=?').get(url);
		return row ? JSON.parse(String(row.value)) : undefined;
	}

	images(): { url: string; asset: ImageAsset }[] {
		return this.db
			.prepare('SELECT url,value FROM follow_images ORDER BY saved_at')
			.all()
			.map((row) => ({ url: String(row.url), asset: JSON.parse(String(row.value)) }));
	}

	cacheImage(url: string, asset: ImageAsset): void {
		this.db
			.prepare('INSERT INTO follow_images VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET value=excluded.value,saved_at=excluded.saved_at')
			.run(url, JSON.stringify(asset), Date.now());
	}

	setImageCache(ids: string[], value: ImageCache): void {
		const write = this.db.prepare('UPDATE entries SET value=? WHERE id=?');
		for (const id of ids) {
			const entry = this.entry(id);
			if (entry && !entry.imageAsset) {
				write.run(JSON.stringify({ ...entry, imageCache: value }), id);
			}
		}
	}

	saveImage(entry: FeedEntry, asset: ImageAsset): void {
		this.cacheImage(entry.thumbnailUrl, asset);
		const write = this.db.prepare('UPDATE entries SET value=? WHERE id=?');
		for (const item of this.imageEntries(entry.thumbnailUrl)) {
			delete item.imageCache;
			write.run(JSON.stringify({ ...item, imageAsset: asset }), item.id);
		}
	}

	dropImage(url: string, evicted = false): void {
		this.db.prepare('DELETE FROM follow_images WHERE url=?').run(url);
		for (const entry of this.imageEntries(url)) {
			if (entry.imageAsset) {
				delete entry.imageAsset;
				entry.imageCache = { status: evicted ? 'evicted' : 'queued', attempts: 0, nextAttemptAt: 0, reason: evicted ? 'cache_limit' : '' };
				this.db.prepare('UPDATE entries SET value=? WHERE id=?').run(JSON.stringify(entry), entry.id);
			}
		}
		for (const sub of this.subscriptions()) {
			if (sub.avatarUrl === url && sub.avatarAsset) {
				delete sub.avatarAsset;
				this.saveSubscription(sub);
			}
		}
	}

	tasks(): FollowTask[] {
		return this.db
			.prepare('SELECT value FROM follow_tasks ORDER BY started_at DESC,rowid DESC LIMIT 20')
			.all()
			.map((row) => followTaskSchema.parse(JSON.parse(String(row.value))));
	}

	saveTask(task: FollowTask): void {
		this.db.prepare('INSERT INTO follow_tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(task.id, task.startedAt, JSON.stringify(task));
		this.db.exec('DELETE FROM follow_tasks WHERE id NOT IN (SELECT id FROM follow_tasks ORDER BY started_at DESC,rowid DESC LIMIT 20)');
	}

	source(id: AllSource): { checkedAt: string; state: string; message: string; cooldownUntil: number; nextRequestAt: number } {
		const row = this.db.prepare('SELECT value FROM source_status WHERE id=?').get(id);
		return row ? JSON.parse(String(row.value)) : { checkedAt: '', state: '未检查', message: '', cooldownUntil: 0, nextRequestAt: 0 };
	}

	saveSource(id: AllSource, value: ReturnType<SubscriptionStore['source']>): void {
		this.db.prepare('INSERT INTO source_status VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value));
	}

	close(): void {
		this.db.close();
	}

	private imageEntries(url: string): FeedEntry[] {
		return this.db
			.prepare("SELECT value FROM entries WHERE json_extract(value,'$.thumbnailUrl')=?")
			.all(url)
			.map((row) => JSON.parse(String(row.value)) as FeedEntry);
	}
}

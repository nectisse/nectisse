import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { openUpdates } from './people.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-creator-images-'));
const output = join(root, '.test-output', appPath ? 'packaged-creator-images' : 'development-creator-images');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
env.PATH = '/usr/bin:/bin';
let app;
const reports = [];
const errors = [];

try {
	await mkdir(output, { recursive: true });
	await rm(join(output, 'image-change-diagnostic.json'), { force: true });
	execFileSync(process.execPath, ['--import', 'tsx', 'scripts/seed-workspace-fixtures.ts', profile], { cwd: root, stdio: 'pipe' });
	app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`], cwd: profile, env });
	await app.evaluate(({ session }) => {
		globalThis.__creatorImageRequests = [];
		session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
			globalThis.__creatorImageRequests.push(details.url);
			callback({ cancel: true });
		});
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(15000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	// Neutral local bitmaps exercise the real image store and protocol, without site requests.
	const fixtures = await app.evaluate(({ nativeImage }, profile) => {
		const require = process.getBuiltinModule('module').createRequire(process.execPath);
		const fs = require('node:fs');
		const path = require('node:path');
		const hash = require('node:crypto').createHash;
		const definitions = [
			['landscape', 800, 450, '横向照片'], ['square', 640, 640, '正方形照片'], ['portrait', 600, 900, '竖向照片'],
			['story', 450, 800, '9:16 竖图'], ['long', 400, 2400, '超长图片'], ['wide', 1200, 300, '全景图片'],
			['unknown', 640, 800, '缓存尺寸尚未写入'], ['stale', 600, 900, '图片加载后修正比例'],
		];
		fs.mkdirSync(path.join(profile, 'fixture-images'));
		return definitions.map(([key, width, height, title], index) => {
			const pixels = Buffer.alloc(width * height * 4);
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const offset = (y * width + x) * 4;
					const band = Math.floor(y / Math.max(1, height / 6)) % 2;
					pixels[offset] = 115 + index * 9 + band * 12;
					pixels[offset + 1] = 85 + index * 10 + band * 12;
					pixels[offset + 2] = 135 + index * 8 + band * 12;
					pixels[offset + 3] = 255;
				}
			}
			const bytes = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 }).toPNG();
			const file = path.join(profile, 'fixture-images', `${key}.png`);
			fs.writeFileSync(file, bytes);
			return { key, title, file, url: `https://downloads.fanbox.cc/images/fixture-${key}.png`, asset: { sha256: hash('sha256').update(bytes).digest('hex'), width, height, bytes: bytes.length, format: 'PNG', quality: 'standard' } };
		});
	}, profile);
	await writeFile(join(profile, 'fixture-images.json'), JSON.stringify(fixtures));
	const seed = String.raw`
		import { readFile } from 'node:fs/promises';
		import { join } from 'node:path';
		import { SubscriptionStore } from './src/main/features/subscriptions/subscription-store.ts';
		import { ImageStore } from './src/main/platform/images/index.ts';
		const root = process.argv[1];
		const fixtures = JSON.parse(await readFile(join(root, 'fixture-images.json'), 'utf8'));
		const store = new SubscriptionStore(root, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' });
		const images = new ImageStore(root, (image) => image);
		await images.initialize();
		try {
			for (const fixture of fixtures) await images.put(fixture.url, { bytes: await readFile(fixture.file), asset: fixture.asset });
			const sub = store.subscriptions().find((sub) => sub.provider === 'fanbox');
			const now = Date.now();
			for (let index = 0; index < 84; index++) {
				const fixture = fixtures[index];
				const key = fixture?.key ?? (index === 8 ? 'broken' : 'text-' + index);
				const input = { externalId: 'aspect-' + key, title: fixture?.title ?? (index === 8 ? '图片暂不可用' : '创作手记 ' + index), summary: '本地布局检查 · 复用图片缓存。'.repeat(index % 3 + 1), author: sub.name, publishedAt: '2026-10-25', publishedPrecision: 'date', url: sub.url + 'posts/' + (10000 + index), thumbnailUrl: fixture?.url ?? (index === 8 ? 'https://downloads.fanbox.cc/images/missing.jpg' : ''), code: '', restricted: false, partial: false };
				store.upsertEntry(sub, input, new Date(now - index * 1000).toISOString());
				const entry = store.entries(sub.id).find((entry) => entry.externalId === input.externalId);
				if (fixture && key !== 'unknown') entry.imageAsset = key === 'stale' ? { ...fixture.asset, width: 1600, height: 900 } : fixture.asset;
				if (key === 'broken') entry.imageAsset = { ...fixtures[2].asset, sha256: 'f'.repeat(64) };
				entry.imageCache = { status: 'cancelled', attempts: 0, nextAttemptAt: 0, reason: 'isolated_fixture' };
				store.db.prepare('UPDATE entries SET value=? WHERE id=?').run(JSON.stringify(entry), entry.id);
			}
		} finally { await images.close(); store.close(); }
	`;
	execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', seed, profile], { cwd: root, stdio: 'pipe' });
	await page.reload();
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	const initial = await page.evaluate(() => window.nectisse.subscriptions.getState());
	const entries = initial.entries.filter((entry) => entry.externalId.startsWith('aspect-'));
	const byKey = (key) => entries.find((entry) => entry.externalId === `aspect-${key}`);
	const item = (key) => page.locator(`[data-post-id="${byKey(key).id}"]`);
	const frame = (key) => item(key).locator('.feed-item-thumbnail');
	const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	const objects = () => readdir(join(profile, 'images/objects'));
	const originalFiles = (await objects()).sort();
	await openUpdates(page, 'creators');
	await page.waitForFunction(() => document.querySelectorAll('.real-feed-entry').length >= 20);
	assert.equal(await item('text-9').locator('.feed-item-thumbnail').count(), 0);
	for (const fixture of fixtures) {
		await frame(fixture.key).scrollIntoViewIfNeeded();
		await frame(fixture.key).locator('img').waitFor();
		await page.waitForFunction((id) => {
			const image = document.querySelector(`[data-post-id="${id}"] .feed-item-thumbnail img`);
			return image?.complete && image.naturalWidth > 0;
		}, byKey(fixture.key).id);
		await settle();
		const box = await frame(fixture.key).boundingBox();
		const ratio = fixture.asset.width / fixture.asset.height;
		assert.ok(Math.abs(box.height - box.width / Math.max(ratio, 0.5)) <= 2, JSON.stringify({ fixture: fixture.key, box, ratio }));
		assert.equal(await frame(fixture.key).getByText('长图', { exact: true }).count(), ratio < 0.5 ? 1 : 0);
	}
	await frame('broken').scrollIntoViewIfNeeded();
	await frame('broken').getByRole('img', { name: '封面不可用', exact: true }).waitFor();
	const broken = await frame('broken').boundingBox();
	assert.ok(Math.abs(broken.height - broken.width * 1.5) <= 2);
	await frame('long').click();
	const dialog = page.getByRole('dialog');
	await dialog.waitFor();
	await page.waitForFunction(() => {
		const image = document.querySelector('.entry-detail-image img');
		return image?.complete && image.naturalHeight > image.naturalWidth * 5;
	});
	assert.equal(await dialog.locator('.feed-item-long-image').count(), 0);
	await page.keyboard.press('Escape');
	const positions = () => page.locator('.real-feed-list').evaluate((list) => [...list.children].map((entry) => {
		const box = entry.getBoundingClientRect();
		return { id: entry.dataset.postId, x: box.x, y: box.y + document.querySelector('.page-scroll').scrollTop, width: box.width, height: box.height };
	}));
	await settle();
	const beforeAppend = await positions();
	await page.locator('.creator-load-more').scrollIntoViewIfNeeded();
	await page.waitForFunction((count) => document.querySelectorAll('.real-feed-entry').length > count, beforeAppend.length);
	await settle();
	assert.deepEqual((await positions()).slice(0, 20), beforeAppend, '追加动态不改变已有卡片的位置和高度');
	const changed = await page.evaluate(() => window.nectisse.subscriptions.getState());
	const changedEntry = changed.entries.find((entry) => entry.id === byKey('square').id);
	changedEntry.thumbnailUrl = fixtures[0].url;
	changedEntry.imageAsset = fixtures[0].asset;
	changedEntry.title = '图片更新后的横图';
	changed.revision++;
	await frame('square').focus();
	await app.evaluate(({ BrowserWindow }, { profile, entry, snapshot }) => {
		const require = process.getBuiltinModule('module').createRequire(process.execPath);
		const db = new (require('node:sqlite').DatabaseSync)(require('node:path').join(profile, 'nectisse.sqlite'));
		try {
			db.prepare('UPDATE entries SET value=? WHERE id=?').run(JSON.stringify(entry), entry.id);
		} finally {
			db.close();
		}
		BrowserWindow.getAllWindows()[0].webContents.send('nectisse:subscriptions-state', snapshot);
	}, { profile, entry: changedEntry, snapshot: changed });
	try {
		await page.waitForFunction((id) => {
			const image = document.querySelector(`[data-post-id="${id}"] .feed-item-thumbnail img`);
			return image?.complete && image.naturalWidth === 800 && image.naturalHeight === 450;
		}, byKey('square').id, { timeout: 4000 });
	} catch (error) {
		const diagnostic = await page.evaluate(async (id) => {
			const state = await window.nectisse.subscriptions.getState();
			const frame = document.querySelector(`[data-post-id="${id}"] .feed-item-thumbnail`);
			const image = frame.querySelector('img');
			return { entry: state.entries.find((entry) => entry.id === id), ratio: frame.style.aspectRatio, image: image?.outerHTML, naturalWidth: image?.naturalWidth, naturalHeight: image?.naturalHeight };
		}, byKey('square').id);
		await writeFile(join(output, 'image-change-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
		throw error;
	}
	await settle();
	const changedFrame = await frame('square').boundingBox();
	assert.ok(Math.abs(changedFrame.width / changedFrame.height - 16 / 9) < 0.02, '新图片不沿用上一张图片的比例');
	assert.equal(await frame('square').evaluate((element) => document.activeElement === element), true, '图片更新保留按钮和键盘焦点');
	for (const width of [1000, 1600]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 900), width);
		await page.waitForFunction((width) => innerWidth === width, width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate((theme) => window.nectisse.subscriptions.command({ action: 'preferences-patch', patch: { theme } }), theme);
			await page.locator('#collected-entry-heading').scrollIntoViewIfNeeded();
			await settle();
			const layout = await positions();
			const columns = new Map();
			for (const item of layout) {
				const previous = columns.get(Math.round(item.x));
				if (previous) assert.ok(item.y >= previous.y + previous.height + 17 && item.y < previous.y + previous.height + 20, JSON.stringify({ item, previous }));
				columns.set(Math.round(item.x), item);
			}
			assert.equal(columns.size, width === 1000 ? 2 : 4);
			reports.push({ width, theme, columns: columns.size, heights: new Set(layout.map((item) => Math.round(item.height))).size });
			await page.screenshot({ path: join(output, `${width}-${theme}.png`), animations: 'disabled' });
		}
	}
	await openUpdates(page, 'actors');
	const actorFrame = page.locator('.feed-item-thumbnail').first();
	const actorSize = await actorFrame.boundingBox();
	assert.ok(Math.abs(actorSize.width / actorSize.height - 4 / 3) < 0.02);
	assert.deepEqual((await objects()).sort(), originalFiles, '改变展示比例和打开详情不新增缓存文件');
	assert.deepEqual(await app.evaluate(() => globalThis.__creatorImageRequests), []);
	assert.deepEqual(errors, []);
	await writeFile(join(output, 'result.json'), JSON.stringify({ ok: true, reports, checks: ['cached image dimensions', 'natural image ratio', 'unknown dimensions', 'stale dimensions corrected', 'long-image cap and full detail', 'image failure', 'text-only post', 'append stability', 'changed image ratio and preserved focus', 'no overlaps', 'unchanged actor rows', 'no additional cache files', 'no site requests'] }, null, 2));
	console.log(JSON.stringify({ ok: true, app: appPath ?? 'development', output }));
} finally {
	await app?.close();
	await rm(profile, { recursive: true, force: true });
}

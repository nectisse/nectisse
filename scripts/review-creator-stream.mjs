import { openPeople, openUpdates } from './people.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-stream-'));
const output = join(root, '.test-output', appPath ? 'packaged-creator-stream' : 'development-creator-stream');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
env.PATH = '/usr/bin:/bin';
let app;
const reports = [];
const errors = [];

try {
	await mkdir(output, { recursive: true });
	execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), profile], { cwd: root, stdio: 'pipe' });
	const seed = `import { SubscriptionStore } from './src/main/features/subscriptions/subscription-store.ts';
	const store = new SubscriptionStore(process.argv[1], {available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});
	const sub = store.subscriptions().find(sub=>sub.provider==='fanbox');
	for(let index=0;index<213;index++) store.upsertEntry(sub,{externalId:'stream-'+index,title:'创作手记 '+(index+1),summary:('记录作品与日常，让不同长度的文字保留自己的节奏。\\n').repeat(index%7+1),author:sub.name,publishedAt:'2026-10-24',publishedPrecision:'date',url:'https://example.invalid/stream/'+index,thumbnailUrl:'',code:'',restricted:false,partial:false},new Date(Date.UTC(2026,9,24,0,0,index)).toISOString());
	store.close();`;
	execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', seed, profile], { cwd: root, stdio: 'pipe' });
	app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`], cwd: profile, env });
	await app.evaluate(({ session }) => {
		globalThis.__streamRequests = [];
		session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
			globalThis.__streamRequests.push(details.url);
			callback({ cancel: true });
		});
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(15_000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	const state = () => page.evaluate(() => window.nectisse.subscriptions.getState());
	const ids = () => page.locator('.real-feed-entry').evaluateAll((items) => items.map((item) => item.dataset.postId));
	const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	const pager = page.getByRole('navigation', { name: '已收录内容分页', exact: true });
	const scroller = page.locator('.page-scroll');
	const bulk = page.getByRole('button', { name: '标记已加载为已读', exact: true });

	const layout = () => page.locator('.real-feed-list').evaluate((list) => {
		const origin = list.getBoundingClientRect();
		return [...list.children].map((item) => {
			const box = item.getBoundingClientRect();
			return { id: item.dataset.postId, x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height, bottom: box.bottom - origin.y, fits: item.scrollWidth <= item.clientWidth + 1 };
		});
	});

	const verifyLayout = async () => {
		await settle();
		const items = await layout();
		const columns = new Map();
		for (const item of items) {
			assert.ok(item.fits && item.height > 80, JSON.stringify(item));
			const key = Math.round(item.x);
			const previous = columns.get(key);
			if (previous) {
				assert.ok(item.y >= previous.bottom + 17 && item.y < previous.bottom + 20, JSON.stringify({ previous, item }));
			}
			columns.set(key, item);
		}
		const bounds = await scroller.evaluate((element) => ({ fits: element.scrollWidth <= element.clientWidth + 1, y: scrollY, height: document.scrollingElement.scrollHeight, viewport: innerHeight }));
		assert.ok(bounds.fits && bounds.y === 0 && bounds.height <= bounds.viewport + 1, JSON.stringify(bounds));
		reports.push({ count: items.length, columns: columns.size, heightKinds: new Set(items.map((item) => Math.round(item.height))).size });
		return items;
	};

	await openPeople(page, 'creators');
	assert.equal(await page.locator('.real-feed-entry').count(), 0);
	await openUpdates(page);
	const initial = await state();
	const all = initial.entries.filter((entry) => entry.provider === 'fanbox');
	const actorEntries = initial.entries.filter((entry) => entry.provider === 'javdb');
	assert.equal(all.length, 216);
	assert.equal(await pager.count(), 0);
	assert.equal(await page.getByRole('button', { name: '本页全部已读', exact: true }).count(), 0);
	assert.deepEqual(await ids(), all.slice(0, 20).map((entry) => entry.id));
	const before = await verifyLayout();
	assert.ok(new Set(before.map((item) => item.height)).size >= 3);
	const scrollBeforeAppend = await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; return element.scrollTop; });
	await page.waitForFunction(() => document.querySelectorAll('.real-feed-entry').length === 40);
	const after = await verifyLayout();
	assert.deepEqual(after.slice(0, 20), before, 'Appending must keep previous cards in place');
	assert.ok(Math.abs(await scroller.evaluate((element) => element.scrollTop) - scrollBeforeAppend) <= 2, 'Appending must preserve the reading position');
	assert.deepEqual(await ids(), all.slice(0, 40).map((entry) => entry.id));

	const snapshot = await state();
	const changing = snapshot.entries.find((entry) => entry.id === all[3].id);
	const image = snapshot.entries.find((entry) => entry.imageAsset)?.imageAsset;
	changing.summary = '较长的正文与迟到的封面都会重新计算卡片高度。\n'.repeat(18);
	changing.imageAsset = image;
	changing.thumbnailUrl = 'https://example.invalid/local-cover.jpg';
	snapshot.revision++;
	await app.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send('nectisse:subscriptions-state', snapshot), snapshot);
	await page.waitForFunction(({ id, height }) => document.querySelector(`[data-post-id="${id}"]`).getBoundingClientRect().height > height + 50, { id: changing.id, height: before[3].height });
	await verifyLayout();

	const readIds = await ids();
	await bulk.click();
	await page.waitForFunction(() => document.querySelectorAll('.real-feed-entry[data-read="true"]').length === 40);
	assert.deepEqual((await state()).entries.filter((entry) => entry.read).map((entry) => entry.id), readIds);
	await verifyLayout();
	await page.getByRole('tab', { name: '未读', exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll('.real-feed-entry').length === 20);
	const unread = all.filter((entry) => !readIds.includes(entry.id));
	assert.deepEqual(await ids(), unread.slice(0, 20).map((entry) => entry.id));
	const title = await page.locator('.feed-item-title').first().getAttribute('aria-label');
	await page.locator('.feed-item-title').first().click();
	await page.getByRole('dialog').getByRole('heading', { name: title, exact: true }).waitFor();
	await page.waitForFunction((id) => !document.querySelector(`[data-post-id="${id}"]`), unread[0].id);
	await page.keyboard.press('Escape');
	await verifyLayout();
	await page.getByRole('tab', { name: '全部', exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll('.real-feed-entry').length === 20);
	assert.deepEqual(await ids(), all.slice(0, 20).map((entry) => entry.id));
	while ((await ids()).length < all.length) {
		const previous = (await ids()).length;
		await page.locator('.creator-load-more').scrollIntoViewIfNeeded();
		await page.waitForFunction((count) => document.querySelectorAll('.real-feed-entry').length > count, previous);
		assert.deepEqual(await ids(), all.slice(0, Math.min(previous + 20, all.length)).map((entry) => entry.id));
	}
	await page.getByText('已显示全部 216 条动态', { exact: true }).waitFor();
	assert.equal(await page.getByRole('button', { name: '加载更多', exact: true }).count(), 0);
	assert.equal(new Set(await ids()).size, 216);
	await verifyLayout();
	await page.screenshot({ path: join(output, 'all-loaded.png') });

	await page.evaluate((ids) => window.nectisse.subscriptions.command({ action: 'read', ids, read: true }), actorEntries.map((entry) => entry.id));
	await openUpdates(page, 'actors', false);
	await page.getByRole('heading', { name: '还没有可显示的内容', exact: true }).waitFor();
	assert.equal(await page.locator('.creator-load-more').count(), 0);
	await page.getByRole('tab', { name: '全部', exact: true }).click();
	await page.waitForFunction((count) => document.querySelectorAll('.real-feed-entry').length === count, actorEntries.length);
	assert.equal(await pager.count(), 1);
	assert.deepEqual(await ids(), actorEntries.map((entry) => entry.id));

	for (const width of [1000, 1600]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 900), width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate((theme) => window.nectisse.subscriptions.command({ action: 'preferences-patch', patch: { theme } }), theme);
			await openUpdates(page);
			await verifyLayout();
			assert.equal(await page.locator('.real-feed-list').evaluate((list) => getComputedStyle(list).gridTemplateColumns.split(' ').length), width === 1000 ? 2 : 4);
			await page.locator('#collected-entry-heading').scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `${width}-${theme}.png`), animations: 'disabled' });
		}
	}
	const beforeReload = (await state()).entries.filter((entry) => entry.read).map((entry) => entry.id);
	assert.equal(beforeReload.length, 42);
	await page.reload();
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	assert.deepEqual((await state()).entries.filter((entry) => entry.read).map((entry) => entry.id), beforeReload);
	assert.deepEqual(await app.evaluate(() => globalThis.__streamRequests), []);
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ checks: ['216-post-masonry-without-pagination', 'twenty-at-a-time-without-duplicates', 'append-preserves-cards-and-scroll', 'long-text-and-late-image-reflow', 'bulk-read-only-loaded-posts', 'filter-resets-loaded-count', 'unread-dialog-survives-removal', 'all-loaded-end-state', 'actor-pagination-retained', 'two-and-four-columns-both-themes', 'read-state-persists', 'zero-site-requests'], reports, screenshots: output }, null, 2));
} finally {
	await writeFile(join(output, 'verification.json'), JSON.stringify({ reports, errors }, null, 2));
	await app?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}

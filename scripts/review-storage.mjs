import assert from 'node:assert/strict';
import { selectQueryRecord } from './query.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { chooseOption } from './select.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-storage-'));
const output = join(root, '.test-output', appPath ? 'packaged-storage' : 'image-storage');
let app;
let page;
const errors = [];
async function launch() {
	app = await _electron.launch({
		executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron,
		args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`],
		cwd: root,
	});
	page = await app.firstWindow();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor({ timeout: 20000 });
}

async function quit() {
	const exited = new Promise((resolve) => app.process().once('exit', resolve));
	await app.evaluate(({ app }) => {
		app.quit();
	});
	await exited;
}

async function settings() {
	await page.getByRole('button', { name: '设置', exact: true }).click();
	await page.getByRole('tab', { name: '网络与存储', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="cache-usage"]')?.textContent !== '—');
}

async function measure(name) {
	const bounds = await page.locator('[aria-labelledby="storage-heading"]').evaluate((section) => {
		const box = section.getBoundingClientRect();
		const card = section.querySelector('.settings-card').getBoundingClientRect();
		return {
			width: box.width,
			cardWidth: card.width,
			overflow: section.scrollWidth - section.clientWidth,
			buttons: [...section.querySelectorAll('button')].map((button) => ({ label: button.textContent, height: button.getBoundingClientRect().height })),
			outerScroll: document.scrollingElement.scrollHeight - innerHeight,
		};
	});
	assert.equal(bounds.width, bounds.cardWidth);
	assert.ok(bounds.overflow <= 1 && bounds.outerScroll <= 1, JSON.stringify(bounds));
	await page.locator('[aria-labelledby="storage-heading"]').scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(output, `${name}.png`) });
	return bounds;
}

try {
	await mkdir(output, { recursive: true });
	execFileSync(process.execPath, ['--import', 'tsx', 'scripts/seed-workspace-fixtures.ts', profile], { cwd: root, stdio: 'pipe' });
	await launch();
	await selectQueryRecord(page, 'NECT-024');
	await page.locator('.live-result-grid').waitFor();
	await page.waitForFunction(() => [...document.querySelectorAll('.live-result-grid img')].every((image) => image.complete && image.naturalWidth > 0));
	const task = (await page.evaluate(() => window.nectisse.metadata.getState())).tasks[0];
	const cover = task.records[0].covers[0];
	const selected = await page.evaluate(
		async ({ task, cover }) => window.nectisse.library.save({ taskId: task.id, code: task.records[0].code, coverId: cover.id, replace: false }),
		{ task, cover },
	);
	assert.equal(selected.ok, true);
	const collection = await page.evaluate((id) => window.nectisse.library.getWork(id), selected.id);
	const entriesBefore = (await page.evaluate(() => window.nectisse.subscriptions.getState())).entries;
	const pinned = await app.evaluate(async ({ net }, cover) => {
		const response = await net.fetch(`nectisse-cover://library/${cover.id}?variant=original`);
		return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
	}, cover);
	assert.equal(pinned.status, 200);
	assert.equal(pinned.bytes, cover.asset.bytes);
	const dimensions = await page.evaluate(
		(cover) =>
			new Promise((resolve, reject) => {
				const image = new Image();
				image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
				image.onerror = reject;
				image.src = `nectisse-cover://image/${cover.id}?variant=thumbnail`;
			}),
		cover,
	);
	const thumb = {
		...dimensions,
		bytes: await app.evaluate(async ({ net }, cover) => (await (await net.fetch(`nectisse-cover://image/${cover.id}?variant=thumbnail`)).arrayBuffer()).byteLength, cover),
	};
	assert.ok(Math.max(thumb.width, thumb.height) <= 800);
	assert.ok(thumb.bytes < pinned.bytes);
	// 普通缓存单独加入一张不同图片，避免它与收藏共享后全部受保护。
	await quit();
	const ordinary = await readFile(join(root, 'src/renderer/demo/assets/portrait-1.jpg'));
	const ordinaryHash = createHash('sha256').update(ordinary).digest('hex');
	const statePath = join(profile, 'metadata', 'state.json');
	const state = JSON.parse(await readFile(statePath, 'utf8'));
	const record = structuredClone(state.tasks[0].records[0]);
	record.code = 'NECT-025';
	record.id = 'e'.repeat(64);
	record.covers = [
		{
			...record.covers[0],
			id: 'f'.repeat(64),
			url: 'https://example.invalid/ordinary.jpg',
			asset: { ...record.covers[0].asset, sha256: ordinaryHash, bytes: ordinary.length, width: 512, height: 512, format: 'JPEG' },
		},
	];
	state.tasks[0].records.push(record);
	state.assets[record.covers[0].id] = { ...record.covers[0].asset, cachedAt: Date.now() };
	await mkdir(join(profile, 'cache/covers'), { recursive: true });
	await writeFile(join(profile, 'cache/covers', `${ordinaryHash}.image`), ordinary);
	await writeFile(statePath, JSON.stringify(state));
	await launch();
	await settings();
	let usage = await page.evaluate(() => window.nectisse.storage.usage());
	assert.equal(usage.limitBytes, 512 * 1024 * 1024);
	assert.ok(usage.collectionBytes >= pinned.bytes);
	assert.ok(usage.cacheBytes > 0);
	assert.ok(usage.thumbnailBytes > 0);
	await chooseOption(page, '图片缓存上限', '1 GiB');
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.imageCacheMiB === 1024);
	const layouts = [];
	for (const width of [1280, 1000]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 840), width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate(async (theme) => window.nectisse.subscriptions.command({ action: 'preferences-patch', patch: { theme } }), theme);
			await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
			layouts.push(await measure(`${width}-${theme}`));
		}
	}
	await page.getByRole('button', { name: '清理缓存', exact: true }).click();
	await page.locator('[data-sonner-toast]').filter({ hasText: '已释放' }).waitFor();
	await page.waitForFunction(() => document.querySelector('[data-testid="cache-usage"]')?.textContent === '0 B');
	usage = await page.evaluate(() => window.nectisse.storage.usage());
	assert.equal(usage.cacheBytes, 0);
	assert.ok(usage.collectionBytes >= pinned.bytes);
	const after = await page.evaluate(() => window.nectisse.subscriptions.getState());
	assert.deepEqual(
		after.entries.map(({ id, summary, read }) => ({ id, summary, read })),
		entriesBefore.map(({ id, summary, read }) => ({ id, summary, read })),
	);
	assert.deepEqual(await page.evaluate((id) => window.nectisse.library.getWork(id), selected.id), collection);
	await quit();
	await launch();
	await settings();
	assert.equal((await page.evaluate(() => window.nectisse.subscriptions.getState())).preferences.imageCacheMiB, 1024);
	const originalRead = await app.evaluate(async ({ net }, cover) => {
		const response = await net.fetch(`nectisse-cover://library/${cover.id}?variant=original`);
		return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
	}, cover);
	assert.deepEqual(originalRead, pinned);
	usage = await page.evaluate(() => window.nectisse.storage.usage());
	assert.equal(usage.cacheBytes, 0);
	const files = await readdir(join(profile, 'images', 'objects'));
	const diskBytes = (await Promise.all(files.map(async (file) => (await stat(join(profile, 'images', 'objects', file))).size))).reduce((a, b) => a + b, 0);
	assert.equal(files.length, 2);
	assert.equal(diskBytes, pinned.bytes + thumb.bytes);
	await page.screenshot({ path: join(output, 'after-clear-and-restart.png') });
	assert.deepEqual(errors, []);
	await quit();
	console.log(
		JSON.stringify(
			{
				passed: true,
				thumb,
				original: pinned,
				usage,
				layouts,
				checks: [
					'migration',
					'thumbnail-800',
					'shared-files',
					'pin-survives-cleanup',
					'summary-and-read-preserved',
					'actual-cleanup-result',
					'no-background-refill',
					'capacity-survives-restart',
					'both-themes-and-window-widths',
				],
				output,
			},
			null,
			2,
		),
	);
} catch (error) {
	await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
	throw error;
} finally {
	await app?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-wall-'));
const output = join(root, '.test-output', appPath ? 'packaged-collection-wall' : 'development-collection-wall');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
env.PATH = '/usr/bin:/bin';
let app;

try {
	await mkdir(output, { recursive: true });
	execFileSync(process.execPath, ['--import', 'tsx', 'scripts/seed-workspace-fixtures.ts', profile], { cwd: root, stdio: 'pipe' });
	execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
		import { readFile } from 'node:fs/promises';
		import { join } from 'node:path';
		import { createHash } from 'node:crypto';
		import { LibraryService } from './src/main/features/library/library-service.ts';
		const root = process.argv[1];
		const state = JSON.parse(await readFile(join(root, 'metadata/state.json'), 'utf8'));
		const template = state.tasks[0].records[0];
		const asset = template.covers[0].asset;
		const bytes = await readFile(join(root, 'cache/covers', asset.sha256 + '.image'));
		const library = new LibraryService(root);
		await library.initialize();
		for (let index = 0; index < 72; index++) {
			const record = structuredClone(template);
			record.code = 'WALL-' + String(index + 1).padStart(3, '0');
			record.id = createHash('sha256').update(record.code).digest('hex');
			record.title = '本机收藏拼贴检查作品 ' + record.code;
			await library.save([record], undefined, false, async () => ({ bytes, asset }));
		}
		await library.stop();
	`, profile], { cwd: root, stdio: 'pipe' });
	app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`], cwd: profile, env });
	await app.evaluate(({ session }) => {
		globalThis.__wallRequests = [];
		session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { globalThis.__wallRequests.push(details.url); callback({ cancel: true }); });
	});
	const page = await app.firstWindow();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '作品收藏', exact: true }).click();
	await page.getByRole('tab', { name: '照片墙', exact: true }).click();
	const wall = page.getByRole('dialog', { name: '作品照片墙', exact: true });
	await wall.waitFor();
	await page.waitForFunction(() => [...document.querySelectorAll('.collection-wall-tile img')].every((image) => image.complete && image.naturalWidth > 0));
	const transform = () => page.locator('.collection-wall-world').evaluate((node) => node.style.transform);
	await page.waitForFunction(() => document.querySelector('.collection-wall-world').style.transform.includes('translate3d'));
	assert.ok(await page.locator('.collection-wall-tile').count() < 72);
	const bounds = await wall.boundingBox();
	assert.equal(bounds.x, 0);
	assert.equal(bounds.y, 0);
	const initial = await transform();
	await page.mouse.move(950, 440);
	await page.mouse.down();
	await page.mouse.move(550, 300, { steps: 12 });
	await page.mouse.up();
	await page.waitForFunction((previous) => document.querySelector('.collection-wall-world').style.transform !== previous, initial);
	assert.equal(await page.locator('.collection-wall-preview').count(), 0, '拖动经过封面不能误开预览');
	const zoom = await page.getByRole('status', { name: '照片墙缩放' }).textContent();
	await page.getByRole('button', { name: '放大照片墙', exact: true }).click();
	await page.waitForFunction((previous) => document.querySelector('.collection-wall-tools output').textContent !== previous, zoom);
	const beforeDetails = await transform();
	const name = await page.locator('.collection-wall-tile').evaluateAll((nodes) => nodes.find((node) => {
		const box = node.getBoundingClientRect();
		return box.x >= 0 && box.y > 70 && box.right < innerWidth && box.bottom < innerHeight - 70;
	})?.getAttribute('aria-label'));
	assert.ok(name);
	await page.getByRole('button', { name, exact: true }).click();
	await page.locator('.collection-wall-preview').waitFor();
	await page.waitForFunction(() => { const image = document.querySelector('.collection-wall-preview img'); return image?.complete && image.naturalWidth > 0; });
	await page.getByRole('button', { name: '查看作品资料', exact: true }).click();
	await page.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
	await page.getByRole('button', { name: '返回照片墙', exact: true }).click();
	await wall.waitFor();
	await page.waitForFunction((expected) => document.querySelector('.collection-wall-world').style.transform === expected, beforeDetails);
	await page.getByRole('button', { name: '搜索照片墙', exact: true }).click();
	await page.getByRole('textbox', { name: '搜索照片墙', exact: true }).fill('不存在的收藏');
	await page.getByRole('heading', { name: '没有匹配的收藏', exact: true }).waitFor();
	await page.getByRole('button', { name: '清除筛选', exact: true }).click();
	await page.locator('.collection-wall-tile').first().waitFor();
	await page.getByRole('button', { name: '重置照片墙位置', exact: true }).click();
	for (const width of [1000, 1600]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 900), width);
		await page.waitForFunction((width) => innerWidth === width, width);
		assert.equal(await wall.evaluate((node) => node.clientWidth), width);
		await page.screenshot({ path: join(output, `${width}-wall.png`) });
	}
	await page.keyboard.press('Escape');
	assert.equal(await wall.count(), 1, '第一次 Escape 收起搜索工具');
	await page.keyboard.press('Escape');
	await page.getByRole('tab', { name: '资料卡片', exact: true }).waitFor();
	assert.equal(await page.locator('.collection-wall').count(), 0);
	assert.equal((await page.evaluate(() => window.nectisse.library.getState())).works.length, 72);
	assert.deepEqual(errors, []);
	assert.deepEqual(await app.evaluate(() => globalThis.__wallRequests), []);
	console.log(JSON.stringify({ application: appPath ? 'packaged' : 'development', checks: ['fullscreen-collage', 'visible-tiles-only', 'drag-without-click', 'zoom', 'original-cover-preview', 'details-return-keeps-camera', 'search-empty-and-clear', 'responsive-window', 'escape-and-data-preserved', 'no-site-requests'], screenshots: output }, null, 2));
} finally {
	await app?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}

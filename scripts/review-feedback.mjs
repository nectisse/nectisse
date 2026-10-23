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
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-feedback-'));
const output = join(root, '.test-output', appPath ? 'packaged-feedback' : 'development-feedback');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
env.PATH = '/usr/bin:/bin';
let app;
const measurements = [], errors = [];
try {
	await mkdir(output, { recursive: true });
	execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), profile], { cwd: root, stdio: 'pipe' });
	app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`], cwd: profile, env });
	await app.evaluate(({ session }) => { globalThis.__requests = []; session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { globalThis.__requests.push(details.url); callback({ cancel: true }); }); });
	const page = await app.firstWindow();
	page.on('pageerror', error => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	await page.getByRole('button', { name: '查看真实作品 NECT-024', exact: true }).click();
	const feedback = page.locator('[data-sonner-toast]');
	const aligned = async name => {
		const layout = await page.evaluate(() => ({
			buttons: [...document.querySelectorAll('.page-heading-actions button')].map(button => { const box = button.getBoundingClientRect(); return { name: button.textContent, y: box.y, height: box.height }; }),
			inlineMessages: document.querySelectorAll('.work-save-action > p').length,
			toasters: document.querySelectorAll('section[aria-label="操作反馈"]').length,
			outer: document.scrollingElement.scrollHeight - innerHeight,
			horizontal: document.querySelector('.page-scroll').scrollWidth - document.querySelector('.page-scroll').clientWidth,
		}));
		measurements.push({ name, ...layout });
		assert.ok(layout.buttons.every(button => button.height === 32 && Math.abs(button.y - layout.buttons[0].y) <= 1), JSON.stringify(layout));
		assert.equal(layout.inlineMessages, 0); assert.equal(layout.toasters, 1);
		assert.ok(layout.outer <= 1 && layout.horizontal <= 1);
		await page.screenshot({ path: join(output, `${name}.png`), animations: 'disabled' });
	};
	for (const width of [1280, 1000, 1600]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 840), width);
		await page.waitForFunction(width => innerWidth === width, width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate(async theme => { const state = await window.nectisse.subscriptions.getState(); await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, theme } }); }, theme);
			await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
			const saved = await page.evaluate(async () => (await window.nectisse.library.getState()).works.length > 0);
			await page.getByRole('button', { name: saved ? '更新收藏' : '收藏作品', exact: true }).click();
			await feedback.filter({ hasText: saved ? '收藏资料已更新' : '作品资料已收藏' }).waitFor();
			assert.equal(await feedback.count(), 1, 'Repeated saves update one toast');
			assert.equal(await page.locator('[data-sonner-toaster]').getAttribute('data-sonner-theme'), theme === 'night' ? 'dark' : 'light');
			await aligned(`${width}-${theme}-success`);
			await feedback.getByRole('button', { name: '关闭提示', exact: true }).click();
			await feedback.waitFor({ state: 'hidden' });
		}
	}
	// Replace only this isolated app's IPC handlers to verify recoverable errors.
	await app.evaluate(({ ipcMain }) => { const channel = 'nectisse:library-save'; globalThis.__save = ipcMain._invokeHandlers.get(channel); ipcMain.removeHandler(channel); ipcMain.handle(channel, () => ({ ok: false, message: '收藏保存失败（隔离验证）' })); });
	await page.getByRole('button', { name: '更新收藏', exact: true }).click();
	await feedback.filter({ hasText: '收藏保存失败（隔离验证）' }).waitFor();
	assert.equal(await feedback.getAttribute('data-type'), 'error');
	await aligned('save-error');
	await feedback.getByRole('button', { name: '关闭提示', exact: true }).click(); await feedback.waitFor({ state: 'hidden' });
	await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('nectisse:library-save'); ipcMain.handle('nectisse:library-save', globalThis.__save); });
	await page.getByRole('button', { name: '已收藏 · 查看', exact: true }).click();
	await page.getByRole('button', { name: '取消收藏', exact: true }).click();
	await app.evaluate(({ ipcMain }) => { const channel = 'nectisse:library-remove'; globalThis.__remove = ipcMain._invokeHandlers.get(channel); ipcMain.removeHandler(channel); ipcMain.handle(channel, () => ({ ok: false, message: '取消收藏失败（隔离验证）' })); });
	await page.getByRole('button', { name: '确认取消收藏', exact: true }).click();
	await feedback.filter({ hasText: '取消收藏失败（隔离验证）' }).waitFor();
	assert.equal(await page.getByRole('dialog').count(), 1);
	assert.equal(await feedback.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), true, 'Error toast is above the modal');
	await page.screenshot({ path: join(output, 'error-above-confirmation.png'), animations: 'disabled' });
	await feedback.getByRole('button', { name: '关闭提示', exact: true }).click(); await feedback.waitFor({ state: 'hidden' });
	await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('nectisse:library-remove'); ipcMain.handle('nectisse:library-remove', globalThis.__remove); });
	await page.getByRole('button', { name: '保留收藏', exact: true }).click();
	assert.deepEqual(errors, []); assert.deepEqual(await app.evaluate(() => globalThis.__requests), []);
	const report = { application: appPath ? 'packaged' : 'development', checks: ['save-and-update-toast', 'three-widths-and-two-themes', 'aligned-32px-actions-after-feedback', 'single-root-toaster', 'deduplicated-action-id', 'theme-follows-app', 'dismiss-without-navigation', 'save-error-toast', 'error-above-modal-and-dismissible', 'confirmation-remains-on-failure', 'zero-site-requests'], measurements };
	await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2));
	console.log(JSON.stringify({ ...report, measurements: undefined, screenshots: output }, null, 2));
} finally { await app?.close().catch(() => {}); await rm(profile, { recursive: true, force: true }); }

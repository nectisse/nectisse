import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-history-'));
const output = join(root, '.test-output', appPath ? 'packaged-query-history' : 'development-query-history');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
env.PATH = '/usr/bin:/bin';
let app;
const errors = [], layouts = [];
try {
	await mkdir(output, { recursive: true });
	execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), profile], { cwd: root, stdio: 'pipe' });
	const stateFile = join(profile, 'metadata/state.json');
	const seed = JSON.parse(await readFile(stateFile, 'utf8'));
	const template = seed.tasks[0];
	const statuses = ['succeeded', 'partial', 'failed', 'cancelled', 'interrupted'];
	seed.tasks = Array.from({ length: 20 }, (_, index) => {
		const status = statuses[index % statuses.length];
		const code = `NECT-${String(24 + index).padStart(3, '0')}`;
		return { ...template, id: randomUUID(), status, startedAt: new Date(Date.UTC(2026, 9, 23, 10, 0, -index)).toISOString(),
			plan: { ...template.plan, kind: index === 1 ? 'title' : 'code', code, query: index === 1 ? '超长查询标题／LongUnbrokenName'.repeat(18) : code },
			records: ['succeeded', 'partial'].includes(status) ? template.records.map(record => ({ ...record, code })) : [] };
	});
	await writeFile(stateFile, JSON.stringify(seed));
	app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`], cwd: profile, env });
	await app.evaluate(({ session, ipcMain }) => {
		globalThis.__requests = []; globalThis.__queryCount = 0;
		session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { globalThis.__requests.push(details.url); callback({ cancel: true }); });
		ipcMain.removeHandler('nectisse:metadata-query');
		ipcMain.handle('nectisse:metadata-query', () => { globalThis.__queryCount++; return { ok: false, message: '历史查询不应发起网络任务' }; });
	});
	const page = await app.firstWindow();
	page.on('pageerror', error => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '资料查询', exact: true }).click();
	const trigger = page.getByRole('button', { name: '查询记录', exact: true });
	const dialog = page.getByRole('dialog', { name: '查询记录', exact: true });
	const open = async () => { await trigger.click(); await dialog.waitFor(); };
	const close = async () => { await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '查询记录'); };
	const background = await page.locator('.query-box').boundingBox();
	await open();
	assert.equal(await dialog.locator('.query-history-row').count(), 20);
	await page.waitForFunction(() => document.activeElement?.matches('.query-history-header h2'));
	assert.deepEqual(await dialog.getByRole('columnheader').allTextContents(), ['查询内容', '查询时间', '状态', '当前记录']);
	assert.deepEqual(await page.locator('.query-box').boundingBox(), background);
	assert.equal(await page.locator('.live-history').count(), 0);
	for (const label of ['已完成', '部分取得', '未取得', '已取消', '已中断']) assert.ok(await dialog.getByText(label, { exact: true }).count() > 0);
	await close();
	for (const width of [1000, 1600]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 1200), width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate(async theme => { const state = await window.nectisse.subscriptions.getState(); await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, theme } }); }, theme);
			await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
			await open();
			const layout = await dialog.evaluate(element => {
				const body = element.querySelector('.query-history-scroll');
				const footer = element.querySelector('.query-history-footer');
				return { rect: element.getBoundingClientRect().toJSON(), footer: footer.getBoundingClientRect().bottom, viewport: innerHeight, overflow: element.scrollWidth - element.clientWidth, listScrolls: body.scrollHeight > body.clientHeight, windowY: scrollY, pageY: document.querySelector('.page-scroll').scrollTop, rowHeights: [...element.querySelectorAll('.query-history-row')].map(row => row.getBoundingClientRect().height), controlHeights: [...element.querySelectorAll('[data-size="sm"], [data-size="icon-sm"]')].map(control => control.getBoundingClientRect().height) };
			});
			assert.ok(layout.rect.y >= 30 && layout.rect.bottom <= layout.viewport - 30 && layout.footer <= layout.rect.bottom);
			assert.ok(layout.listScrolls && layout.overflow <= 1 && layout.windowY === 0 && layout.pageY === 0, JSON.stringify(layout));
			assert.ok(layout.rect.width <= 520 && layout.rect.height <= 480 && layout.rowHeights.every(height => height >= 52 && height <= 54), JSON.stringify(layout));
			assert.ok(layout.controlHeights.every(height => height === 32));
			const rowStyle = await dialog.locator('.query-history-row[data-current="true"]').evaluate(element => {
				const style = getComputedStyle(element);
				const list = element.closest('.query-history-table').getBoundingClientRect();
				const row = element.getBoundingClientRect();
				return { radius: style.borderRadius, background: style.backgroundColor, leftInset: row.left - list.left, rightInset: list.right - row.right };
			});
			assert.equal(rowStyle.radius, '0px');
			assert.equal(rowStyle.background, 'rgba(0, 0, 0, 0)');
			assert.ok(rowStyle.leftInset <= 1 && rowStyle.rightInset <= 1, JSON.stringify(rowStyle));
			const headerTop = await dialog.locator('thead').evaluate(element => element.getBoundingClientRect().top);
			await dialog.locator('.query-history-scroll').evaluate(element => element.scrollTop = element.scrollHeight);
			assert.ok(Math.abs(await dialog.locator('thead').evaluate(element => element.getBoundingClientRect().top) - headerTop) <= 1);
			assert.equal(await page.locator('.page-scroll').evaluate(element => element.scrollTop), 0);
			await dialog.locator('.query-history-scroll').evaluate(element => element.scrollTop = 0);
			layouts.push({ width, theme, ...layout });
			await page.screenshot({ path: join(output, `${width}-${theme}.png`), animations: 'disabled' });
			await close();
		}
	}
	// Select saved results and terminal failures through the real renderer/preload bridge.
	await open(); await dialog.locator('.query-history-row').nth(1).click(); await dialog.waitFor({ state: 'hidden' });
	assert.equal(await page.locator('#work-query').inputValue(), seed.tasks[1].plan.query);
	await page.getByRole('button', { name: '查看真实作品 NECT-025', exact: true }).waitFor();
	await open();
	assert.equal(await dialog.locator('.query-history-open[aria-current="true"] .query-history-query').innerText(), seed.tasks[1].plan.query);
	await dialog.getByRole('button', { name: '关闭查询记录', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
	await open();
	await dialog.locator('.query-history-open').first().focus();
	await page.keyboard.press('Enter');
	await dialog.waitFor({ state: 'hidden' });
	assert.equal(await page.locator('#work-query').inputValue(), 'NECT-024');
	await open(); await dialog.locator('.query-history-row').nth(18).click(); await dialog.waitFor({ state: 'hidden' });
	await page.getByRole('heading', { name: '这次查询已取消', exact: true }).waitFor();
	assert.equal(await page.locator('#work-query').inputValue(), 'NECT-042');
	await open(); await page.waitForFunction(() => document.activeElement?.matches('.query-history-header h2'));
	await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
	// Exercise the empty initial state without touching any user storage.
	await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('nectisse:metadata-get'); ipcMain.handle('nectisse:metadata-get', () => ({ revision: 999, tasks: [] })); });
	await page.reload(); await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	await open(); await dialog.getByRole('heading', { name: '还没有查询记录', exact: true }).waitFor();
	assert.equal(await dialog.locator('.query-history-row').count(), 0);
	await page.waitForFunction(() => document.activeElement?.matches('.query-history-header h2'));
	await page.screenshot({ path: join(output, 'empty.png') }); await close();
	assert.deepEqual(errors, []);
	assert.equal(await app.evaluate(() => globalThis.__queryCount), 0);
	assert.deepEqual(await app.evaluate(() => globalThis.__requests), []);
	console.log(JSON.stringify({ checks: ['20-local-records-in-shadcn-table', 'sticky-column-headers', 'no-rounded-row-fill', 'no-inline-layout-shift', 'status-and-current-selection', 'focus-heading-and-return-on-close', 'two-themes-two-sizes-internal-scroll', '32px-close-controls', 'long-query-ellipsis-with-full-label', 'select-row-or-enter-without-requery', 'cancelled-query-stays-cancelled', 'empty-state', 'zero-site-requests'], layouts, screenshots: output }, null, 2));
} finally {
	await mkdir(output, { recursive: true }); await writeFile(join(output, 'verification.json'), JSON.stringify({ layouts, errors }, null, 2));
	await app?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}

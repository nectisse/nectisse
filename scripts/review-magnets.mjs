import { openPeople, openUpdates } from './people.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { chooseOption } from './select.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const temporary = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-magnets-'));
const output = join(root, '.test-output', appPath ? 'packaged-magnets' : 'development-magnets');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
env.PATH = '/usr/bin:/bin';
let app;
try {
	execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), temporary], { cwd: root, stdio: 'pipe' });
	app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${temporary}`], cwd: temporary, env });
	const page = await app.firstWindow();
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	await mkdir(output, { recursive: true });
	await app.evaluate(({ session }) => { globalThis.__network = []; session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { globalThis.__network.push(details.url); callback({ cancel: true }); }); });
	const nav = page.getByRole('navigation', { name: '主导航' });
	assert.equal(await page.getByRole('tab', { name: '磁链搜索', exact: true }).count(), 0);
	const unauthorized = await page.evaluate(async () => {
		try {
			await window.nectisse.magnets.search({ id: crypto.randomUUID(), origin: { kind: 'query', taskId: crypto.randomUUID(), code: 'NECT-024' } });
			return false;
		} catch { return true; }
	});
	assert.equal(unauthorized, true, 'Only an existing work record can initiate the query');
	assert.equal(await page.evaluate(() => window.nectisse.magnets.action({ code: 'NECT-024', id: 'a'.repeat(40), action: 'open' })), false);
	await app.evaluate(({ ipcMain, shell }) => {
		globalThis.__magnetCalls = [];
		globalThis.__magnetActions = [];
		globalThis.__magnetCancels = [];
		globalThis.__externalMagnetSites = [];
		shell.openExternal = async (url) => { globalThis.__externalMagnetSites.push(url); };
		globalThis.__magnetMode = 'ready';
		globalThis.__magnetPending = new Map();
		ipcMain.removeHandler('nectisse:magnet-search');
		ipcMain.removeHandler('nectisse:magnet-cancel');
		ipcMain.removeHandler('nectisse:magnet-action');
		ipcMain.handle('nectisse:magnet-search', async (_event, request) => {
			globalThis.__magnetCalls.push(request);
			const result = { code: 'NECT-024', source: request.source, status: 'ready', items: [], checkedAt: '2026-10-24T04:00:00Z', message: '', reason: '', requests: 1, retryAfter: 0 };
			if (globalThis.__magnetMode === 'pending') {
				return new Promise(resolvePending => globalThis.__magnetPending.set(request.id, () => resolvePending({ ...result, status: 'cancelled', message: '查询已取消，可手动重新查询' })));
			}
			if (globalThis.__magnetMode === 'failed') {
				return { ...result, status: 'failed', reason: 'parse_error', message: '来源页面结构已变化，请稍后重试' };
			}
			if (globalThis.__magnetMode !== 'empty') {
				result.items = Array.from({ length: 20 }, (_, i) => ({ id: (i + 1).toString(16).padStart(40, '0'), title: `NECT-024 ${i === 0 ? '用于检查中日文长标题和窄窗口对齐的记录。'.repeat(7) : `示例记录 ${i + 1}`}`, magnet: `magnet:?xt=urn:btih:${(i + 1).toString(16).padStart(40, '0')}`, url: `https://sukebei.nyaa.si/view/${i + 1}`, size: '4.7 GiB', uploadedAt: i ? null : '2026-10-23T04:00:00Z', seeders: i, leechers: 2, completed: 1234 }));
				if (request.source === 'javtao') {
					result.items = result.items.map(row => ({ ...row, url: 'https://javtao.com/nect-024', uploadedAt: null, sharedAt: '2026-01-03', seeders: null, leechers: null, completed: null }));
				}
			}
			return result;
		});
		ipcMain.handle('nectisse:magnet-cancel', (_event, id) => { globalThis.__magnetCancels.push(id); globalThis.__magnetPending.get(id)?.(); globalThis.__magnetPending.delete(id); });
		ipcMain.handle('nectisse:magnet-action', (_event, input) => { globalThis.__magnetActions.push(input); return true; });
	});
	await nav.getByRole('button', { name: '资料查询', exact: true }).click();
	await page.getByRole('button', { name: '查看真实作品 NECT-024', exact: true }).click();
	assert.equal(await app.evaluate(() => globalThis.__magnetCalls.length), 0);
	assert.deepEqual(await page.getByRole('tablist', { name: '真实作品详情' }).getByRole('tab').allTextContents(), ['作品资料', '来源与差异', '磁链搜索']);
	await page.getByRole('tab', { name: '磁链搜索', exact: true }).click();
	await page.getByRole('table', { name: 'Sukebei 磁链结果' }).waitFor();
	assert.equal(await page.locator('.magnet-table tbody tr').count(), 20);
	assert.deepEqual(await page.locator('.magnet-table thead th').allTextContents(), ['名称', '大小', '做种', '操作']);
	assert.deepEqual(await page.locator('.magnet-table tbody tr').first().locator('.magnet-meta > *').allTextContents(), ['2026/10/23', '下载中 2', '完成 1,234']);
	assert.equal(await page.locator('.magnet-table tbody tr').nth(1).locator('.magnet-meta time').innerText(), '上传时间未提供');
	assert.equal(await app.evaluate(() => globalThis.__magnetCalls.length), 1, 'StrictMode must not dispatch a duplicate query');
	await page.getByRole('button', { name: '打开黑马磁力', exact: true }).click();
	assert.deepEqual(await app.evaluate(() => globalThis.__externalMagnetSites), ['https://heimacili.org/']);
	assert.equal(await app.evaluate(() => globalThis.__magnetCalls.length), 1, 'External site must not dispatch another query');
	await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(await app.evaluate(() => globalThis.__magnetCalls.length), 1, 'Focus and reconnect must not repeat the query');
	assert.equal(await page.locator('.magnet-seeds').nth(1).innerText(), '0');
	await page.getByRole('button', { name: /^复制磁链：/ }).first().click();
	await page.getByText('磁链已复制', { exact: true }).waitFor();
	await page.getByRole('button', { name: /^查看来源：/ }).first().click();
	assert.deepEqual((await app.evaluate(() => globalThis.__magnetActions)).map(action => action.action), ['copy', 'open']);
	const measurements = [];
	for (const width of [1000, 1600]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 900), width);
		await page.waitForFunction(width => innerWidth === width, width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate(async theme => { const state = await window.nectisse.subscriptions.getState(); await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, theme } }); }, theme);
			await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
			await page.waitForFunction(() => getComputedStyle(document.querySelector('.magnet-title')).color === getComputedStyle(document.body).color);
			await page.locator('.magnet-table-frame').evaluate(element => { element.scrollLeft = 0; });
			const measure = await page.locator('.magnet-search').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, titleHeights: [...element.querySelectorAll('.magnet-title')].map(title => title.getBoundingClientRect().height), rowHeights: [...element.querySelectorAll('tbody tr')].map(row => row.getBoundingClientRect().height), cells: [...element.querySelectorAll('tbody tr')].map(row => row.querySelectorAll('td').length), controls: [...element.querySelectorAll('.magnet-actions button')].map(button => button.getBoundingClientRect().height), toolbarControls: [...element.querySelectorAll('.magnet-search-actions button')].map(button => button.getBoundingClientRect().height), appScroll: scrollY, pageOverflow: document.querySelector('.page-scroll').scrollWidth > document.querySelector('.page-scroll').clientWidth }));
			assert.ok(measure.scrollWidth <= measure.width + 1, JSON.stringify(measure));
			assert.equal(measure.pageOverflow, false);
			assert.equal(measure.appScroll, 0);
			assert.ok(measure.titleHeights.every(height => height <= 19));
			assert.ok(measure.rowHeights.every(height => height >= 51 && height <= 54), JSON.stringify(measure));
			assert.ok(measure.cells.every(cells => cells === 4));
			const rows = await page.locator('.magnet-table tbody tr').evaluateAll(rows => rows.map(row => {
				const cell = row.querySelector('td');
				const title = cell.querySelector('.magnet-title').getBoundingClientRect();
				const meta = cell.querySelector('.magnet-meta').getBoundingClientRect();
				return { gap: meta.y - title.bottom, metaHeight: meta.height, borders: [...row.querySelectorAll('td')].map(cell => parseFloat(getComputedStyle(cell).borderLeftWidth)) };
			}));
			assert.ok(rows.every(row => Math.abs(row.gap - 4) <= 1 && row.metaHeight <= 17 && row.borders.every(width => width === 0)), JSON.stringify(rows));
			assert.equal(measure.toolbarControls.length, 2);
			assert.ok(measure.toolbarControls.every(height => height === 32));
			assert.ok(measure.controls.every(height => height === 28));
			measurements.push({ width, theme, ...measure });
			await page.screenshot({ path: join(output, `${width}-${theme}-magnet-table.png`) });
			const frame = page.getByRole('region', { name: '磁链结果表格，可横向滚动', exact: true });
			assert.deepEqual(await frame.evaluate(element => { const style = getComputedStyle(element); return [style.borderLeftWidth, style.borderRightWidth, style.borderRadius]; }), ['1px', '1px', '9px']);
			if (width === 1600) {
				assert.equal(await frame.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'All four columns fit at the larger desktop size');
			}
			await frame.evaluate(element => { element.scrollLeft = element.scrollWidth; });
			const actions = await page.locator('.magnet-table tbody tr').first().locator('.magnet-actions').boundingBox();
			const frameBounds = await frame.boundingBox();
			assert.ok(actions.x + actions.width <= frameBounds.x + frameBounds.width + 1);
			assert.equal(await page.evaluate(() => scrollX), 0);
			await frame.evaluate(element => { element.scrollLeft = 0; });
		}
	}
	await chooseOption(page, '磁链搜索来源', 'JavTao');
	await page.getByRole('table', { name: 'JavTao 磁链结果', exact: true }).waitFor();
	assert.equal(await page.locator('.magnet-seeds').nth(1).innerText(), '—');
	assert.deepEqual(await page.locator('.magnet-table tbody tr').first().locator('.magnet-meta > *').allTextContents(), ['分享 2026/01/03']);
	await page.getByRole('button', { name: /^复制磁链：/ }).first().click();
	assert.equal((await app.evaluate(() => globalThis.__magnetActions)).at(-1).source, 'javtao');
	await page.screenshot({ path: join(output, 'javtao-magnet-table.png') });
	await chooseOption(page, '磁链搜索来源', 'Sukebei');
	await page.getByRole('table', { name: 'Sukebei 磁链结果', exact: true }).waitFor();
	const mode = async value => { await app.evaluate((_electron, value) => { globalThis.__magnetMode = value; }, value); };
	await mode('empty');
	await page.getByRole('button', { name: '刷新', exact: true }).click();
	await page.getByText('没有找到编号匹配的磁链', { exact: true }).waitFor();
	await mode('failed');
	await page.getByRole('button', { name: '刷新', exact: true }).click();
	await page.getByRole('alert').filter({ hasText: '来源页面结构已变化' }).waitFor();
	await mode('pending');
	await page.getByRole('button', { name: '重新查询', exact: true }).click();
	await page.getByRole('button', { name: '取消', exact: true }).click();
	await page.getByText('查询已取消，可手动重新查询', { exact: true }).waitFor();
	const cancelledCalls = await app.evaluate(() => globalThis.__magnetCalls.length);
	await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(await app.evaluate(() => globalThis.__magnetCalls.length), cancelledCalls, 'Cancelled mutations must not resume');
	await page.getByRole('button', { name: '重新查询', exact: true }).click();
	await page.getByRole('button', { name: '取消', exact: true }).waitFor();
	await page.getByRole('tab', { name: '作品资料', exact: true }).click();
	await page.waitForFunction(() => !document.querySelector('.magnet-search'));
	assert.ok((await app.evaluate(() => globalThis.__magnetCancels)).length >= 2);
	await mode('ready');
	const state = await page.evaluate(() => window.nectisse.metadata.getState());
	const task = state.tasks.find(task => task.records.some(record => record.code === 'NECT-024'));
	assert.equal((await page.evaluate(taskId => window.nectisse.library.save({ taskId, code: 'NECT-024' }), task.id)).ok, true);
	await nav.getByRole('button', { name: '作品收藏', exact: true }).click();
	await page.locator('.library-work-open').first().click();
	await page.getByRole('tab', { name: '磁链搜索', exact: true }).click();
	await page.getByRole('table', { name: 'Sukebei 磁链结果' }).waitFor();
	assert.equal((await app.evaluate(() => globalThis.__magnetCalls)).at(-1).origin.kind, 'library');
	await openPeople(page, 'actors', 'manage');
	assert.equal(await page.getByRole('tab', { name: '磁链搜索', exact: true }).count(), 0);
	assert.deepEqual(errors, []);
	assert.deepEqual(await app.evaluate(() => globalThis.__network), []);
	await writeFile(join(output, 'verification.json'), JSON.stringify({ measurements, checks: ['detail-only-tab', 'existing-work-authorization', 'no-auto-query-before-tab', 'one-query-in-strict-mode', 'twenty-rows', 'four-columns-with-two-lines-in-name-cell', 'horizontal-row-separators-without-vertical-borders', 'horizontal-scroll-contained-in-table', 'zero-counts-and-missing-time', 'copy-toast-and-source-action', 'empty-failure-cancel-and-leave-tab', 'query-and-library-origins', 'both-themes-and-window-sizes', 'no-site-requests'] }, null, 2));
	console.log(JSON.stringify({ application: appPath ? 'packaged' : 'development', output, checks: 'passed' }));
} finally {
	await app?.close().catch(() => {});
	await rm(temporary, { recursive: true, force: true });
}

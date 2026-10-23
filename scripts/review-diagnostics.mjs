import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-diagnostics-review-'));
const output = join(root, '.test-output', appPath ? 'packaged-diagnostics' : 'development-diagnostics');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])); env.PATH = '/usr/bin:/bin';
let app;
const launch = async () => {
	const application = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`], cwd: profile, env });
	app = application;
	// Test the real copy IPC without changing the person's system clipboard.
	await application.evaluate(({ clipboard }) => { globalThis.__diagnosticCopy = ''; clipboard.writeText = text => { globalThis.__diagnosticCopy = text; }; });
	const page = await application.firstWindow(); await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor(); return { application, page };
};
try {
	await mkdir(output, { recursive: true });
	let launched = await launch(); app = launched.application; let page = launched.page;
	const open = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('tab', { name: '外观与应用', exact: true }).click(); await page.getByRole('button', { name: '查看诊断日志', exact: true }).click(); await page.getByRole('dialog').waitFor(); await page.waitForFunction(() => document.querySelector('.diagnostics-records')?.getAttribute('aria-busy') === 'false'); };
	const copy = async () => { await page.getByRole('button', { name: '复制诊断信息', exact: true }).click(); await page.getByText('诊断信息已复制', { exact: true }).waitFor(); return app.evaluate(() => globalThis.__diagnosticCopy); };
	await open(); await page.getByRole('heading', { name: '暂无异常记录', exact: true }).waitFor();
	assert.ok((await copy()).includes('Nectisse 诊断信息')); await page.getByRole('dialog').screenshot({ path: join(output, 'empty.png') });
	await page.evaluate(() => window.nectisse.diagnostics.recordReadFailure('SUBSCRIPTIONS_READ_TIMEOUT'));
	await page.getByRole('button', { name: '刷新日志', exact: true }).click(); await page.getByText('SUBSCRIPTIONS_READ_TIMEOUT', { exact: true }).waitFor();
	const report = await page.evaluate(() => window.nectisse.diagnostics.getReport());
	assert.equal(report.entries.length, 1); assert.ok((await copy()).includes('SUBSCRIPTIONS_READ_TIMEOUT'));
	assert.deepEqual(report.entries[0].context, { stage: 'renderer', kind: 'timeout' });
	await page.evaluate(() => window.nectisse.diagnostics.recordReadFailure('SUBSCRIPTIONS_STORAGE_READ', { stage: 'tasks', kind: 'storage_error', systemCode: 'ERR_SQLITE_ERROR', sqliteCode: 5 }));
	await page.getByRole('button', { name: '刷新日志', exact: true }).click();
	await page.locator('.diagnostics-context').filter({ hasText: 'ERR_SQLITE_ERROR' }).waitFor(); assert.ok((await copy()).includes('读取订阅任务'));
	const secret = 'session=synthetic-private; proxy=http://private.invalid:7890';
	await appendFile(join(profile, 'diagnostics/subscription-read.jsonl'), JSON.stringify({ at: new Date().toISOString(), code: secret, cookie: secret }) + '\n');
	await page.getByRole('button', { name: '刷新日志', exact: true }).click(); await page.getByText('已忽略 1 条无法识别的旧日志。', { exact: true }).waitFor(); assert.equal((await copy()).includes(secret), false);
	assert.equal(await page.evaluate(async () => { try { await window.nectisse.diagnostics.recordReadFailure('RUNTIME_CHECK_FAILED'); return false; } catch { return true; } }), true);
	assert.equal(await page.evaluate(async () => { try { await window.nectisse.diagnostics.recordReadFailure('SUBSCRIPTIONS_UNAVAILABLE', { stage: 'session=private', kind: 'service_error' }); return false; } catch { return true; } }), true);
	for (let index = 0; index < 40; index++) await page.evaluate(code => window.nectisse.diagnostics.recordReadFailure(code), index % 2 ? 'SUBSCRIPTIONS_STORAGE_READ' : 'SUBSCRIPTIONS_INVALID_DATA');
	await page.getByRole('button', { name: '刷新日志', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.diagnostics-records li').length === 32);
	for (const width of [1280, 1000]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 840), width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate(async theme => { const state = await window.nectisse.subscriptions.getState(); await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, theme } }); }, theme);
			await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
			const dialog = page.getByRole('dialog');
			const rect = await dialog.boundingBox(); assert.ok(rect.x >= 30 && rect.y >= 30 && rect.height <= (width === 1000 ? 700 : 840) - 60);
			const footer = await page.locator('.diagnostics-footer').boundingBox(); await page.locator('.diagnostics-records').evaluate(element => element.scrollTop = element.scrollHeight);
			assert.deepEqual(await page.locator('.diagnostics-footer').boundingBox(), footer);
			assert.equal(await page.evaluate(() => scrollY), 0); assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
			await dialog.screenshot({ path: join(output, `${width}-${theme}.png`) });
		}
	}
	await page.keyboard.press('Escape'); await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '查看诊断日志');
	await app.close(); app = undefined;
	launched = await launch(); app = launched.application; page = launched.page;
	assert.equal((await page.evaluate(() => window.nectisse.diagnostics.getReport())).entries.length, 32);
	// Exercise the real snapshot/IPC path with one failing OS dependency. This
	// must not block reading all of the person's unrelated local data.
	await app.evaluate(({ safeStorage }) => {
		globalThis.__originalEncryptionProbe = safeStorage.isEncryptionAvailable;
		safeStorage.isEncryptionAvailable = () => { throw new Error('session=private-os-probe-fixture'); };
	});
	try {
		await page.reload(); await page.getByRole('alert').filter({ hasText: '系统安全存储暂未就绪' }).waitFor();
		await open(); const serviceReport = await page.evaluate(() => window.nectisse.diagnostics.getReport());
		assert.ok(serviceReport.entries.some(entry => entry.code === 'SECURE_STORAGE_CHECK_FAILED' && entry.context?.stage === 'secure_storage' && entry.context.kind === 'service_error'));
		assert.equal((await page.evaluate(() => window.nectisse.subscriptions.getState())).encryptionAvailable, false);
		const text = await copy(); assert.ok(text.includes('检查系统安全存储')); assert.equal(text.includes('private-os-probe-fixture'), false);
		await page.getByRole('dialog').screenshot({ path: join(output, 'specific-service-failure.png') });
	} finally { await app.evaluate(({ safeStorage }) => { safeStorage.isEncryptionAvailable = globalThis.__originalEncryptionProbe; delete globalThis.__originalEncryptionProbe; }); }
	await page.keyboard.press('Escape'); await page.getByRole('button', { name: '重新检查', exact: true }).click();
	await page.getByRole('alert').filter({ hasText: '系统安全存储暂未就绪' }).waitFor({ state: 'hidden' });
	// Diagnostics stays reachable when the subscription read endpoint is unavailable.
	await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('nectisse:subscriptions-get'); ipcMain.handle('nectisse:subscriptions-get', () => { throw new Error('SUBSCRIPTIONS_UNAVAILABLE'); }); });
	await page.reload(); await page.getByRole('alert').filter({ hasText: '服务暂时未能响应' }).waitFor();
	await open(); await page.getByRole('heading', { name: '诊断日志', exact: true }).waitFor();
	assert.ok((await copy()).includes('SUBSCRIPTIONS_UNAVAILABLE')); await page.getByRole('dialog').screenshot({ path: join(output, 'subscription-read-unavailable.png') });
	// A missing handler is an IPC failure, not an unidentified store exception.
	await page.keyboard.press('Escape'); await app.evaluate(({ ipcMain }) => ipcMain.removeHandler('nectisse:subscriptions-get'));
	await page.reload(); await page.getByRole('alert').filter({ hasText: '服务暂时未能响应' }).waitFor();
	await open(); const transportReport = await page.evaluate(() => window.nectisse.diagnostics.getReport());
	assert.ok(transportReport.entries.some(entry => entry.context?.stage === 'ipc' && entry.context.kind === 'ipc_handler_missing'));
	assert.ok((await copy()).includes('接口尚未注册'));
	console.log(JSON.stringify({ checks: ['settings-entry', 'empty-report', 'refresh-and-copy-ipc', 'diagnostics-survives-restart', 'unavailable-subscription-service', 'fixed-footer-and-local-scroll', 'both-themes-and-sizes', 'no-sensitive-log-values', 'restricted-renderer-reporting', 'focus-return', 'precise-failure-stage-and-native-code', 'real-snapshot-os-failure-stage', 'missing-ipc-handler-classification'], screenshots: output }, null, 2));
} finally { await app?.close().catch(() => {}); await rm(profile, { recursive: true, force: true }); }

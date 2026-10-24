import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-history-'));
const output = join(root, '.test-output', appPath ? 'packaged-query-clear' : 'development-query-clear');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
env.PATH = '/usr/bin:/bin';
let app;

try {
	execFileSync(process.execPath, ['--import', 'tsx', 'scripts/seed-workspace-fixtures.ts', profile], { cwd: root, stdio: 'pipe' });
	await mkdir(output, { recursive: true });
	app = await _electron.launch({
		executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron,
		args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`],
		cwd: profile,
		env,
	});
	await app.evaluate(({ ipcMain, session }) => {
		globalThis.__historyProbe = { requests: [], queries: [], fail: false };
		session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
			globalThis.__historyProbe.requests.push(details.url);
			callback({ cancel: true });
		});
		const original = ipcMain._invokeHandlers.get('nectisse:metadata-clear-history');
		ipcMain.removeHandler('nectisse:metadata-clear-history');
		ipcMain.handle('nectisse:metadata-clear-history', (event) =>
			globalThis.__historyProbe.fail ? { ok: false, message: '本地存储暂时不可写（隔离测试）' } : original(event),
		);
	});
	const page = await app.firstWindow();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	const nav = page.getByRole('navigation', { name: '主导航', exact: true });
	const input = page.getByRole('textbox', { name: '作品编号、标题或原站链接', exact: true });
	const current = () => page.evaluate(() => window.nectisse.metadata.getState());
	const before = await current();
	assert.ok(before.tasks.length > 0, '启动前已有本地查询记录');
	await page.getByRole('heading', { name: '从一部值得留下的作品开始。', exact: true }).waitFor();
	assert.equal(await input.inputValue(), '');
	assert.equal(await page.locator('.live-result-grid').count(), 0, '启动时不自动选择最近记录');
	await app.evaluate(({ ipcMain }, taskId) => {
		ipcMain.removeHandler('nectisse:metadata-query');
		ipcMain.handle('nectisse:metadata-query', (_event, request) => {
			globalThis.__historyProbe.queries.push(request.query);
			return { ok: true, taskId, cached: true };
		});
	}, before.tasks[0].id);
	await input.fill('NECT-024');
	await page.getByRole('button', { name: '查询资料', exact: true }).click();
	await page.getByRole('button', { name: '查看真实作品 NECT-024', exact: true }).waitFor();
	assert.deepEqual(await app.evaluate(() => globalThis.__historyProbe.queries), ['NECT-024'], '主动查询仍能显示返回的资料');
	await nav.getByRole('button', { name: '演员', exact: true }).click();
	await nav.getByRole('button', { name: '资料查询', exact: true }).click();
	await page.getByRole('button', { name: '查看真实作品 NECT-024', exact: true }).waitFor();
	assert.equal(await input.inputValue(), 'NECT-024', '当前会话内切换页面保留主动查询');
	await page.evaluate(async (taskId) => window.nectisse.library.save({ taskId, code: 'NECT-024' }), before.tasks[0].id);
	const saved = await page.evaluate(() => window.nectisse.library.getState());
	const subscriptions = await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).subscriptions);
	await input.fill('TEST-123');
	await page.getByRole('button', { name: '清空查询', exact: true }).click();
	assert.equal(await input.inputValue(), '');
	assert.equal(await input.evaluate((element) => document.activeElement === element), true);
	assert.equal(await page.locator('.live-result-grid').count(), 0);
	assert.deepEqual((await current()).tasks, before.tasks);
	await nav.getByRole('button', { name: '演员', exact: true }).click();
	await nav.getByRole('button', { name: '资料查询', exact: true }).click();
	await page.getByRole('heading', { name: '从一部值得留下的作品开始。', exact: true }).waitFor();
	assert.equal(await page.locator('.live-result-grid').count(), 0, '切换页面不能把已清空的结果重新选中');
	await page.getByRole('button', { name: '查询记录', exact: true }).click();
	await page.getByRole('button', { name: '查看查询记录 NECT-024', exact: true }).click();
	await page.getByRole('button', { name: '查看真实作品 NECT-024', exact: true }).waitFor();
	assert.equal(await input.inputValue(), 'NECT-024');
	await page.screenshot({ path: join(output, '01-query-actions.png') });
	await page.reload();
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	await page.getByRole('heading', { name: '从一部值得留下的作品开始。', exact: true }).waitFor();
	assert.equal(await input.inputValue(), '');
	assert.equal(await page.locator('.live-result-grid').count(), 0, '重新打开界面后不恢复已选择的历史');
	assert.deepEqual((await current()).tasks, before.tasks, '空白起始页不删除历史记录');
	await page.getByRole('button', { name: '查询记录', exact: true }).click();
	const history = page.getByRole('dialog', { name: '查询记录', exact: true });
	await history.getByRole('button', { name: '清空记录', exact: true }).click();
	const confirm = page.getByRole('dialog', { name: '清空全部查询记录？', exact: true });
	await confirm.waitFor();
	await page.screenshot({ path: join(output, '02-clear-confirmation.png') });
	await confirm.getByRole('button', { name: '取消', exact: true }).click();
	await confirm.waitFor({ state: 'detached' });
	assert.deepEqual((await current()).tasks, before.tasks, '取消确认应保留全部历史');
	await history.getByRole('button', { name: '清空记录', exact: true }).click();
	await app.evaluate(() => { globalThis.__historyProbe.fail = true; });
	await confirm.getByRole('button', { name: '确认清空记录', exact: true }).click();
	await page.getByText('本地存储暂时不可写（隔离测试）', { exact: true }).waitFor();
	assert.deepEqual((await current()).tasks, before.tasks);
	await app.evaluate(() => { globalThis.__historyProbe.fail = false; });
	await confirm.getByRole('button', { name: '确认清空记录', exact: true }).click();
	await confirm.waitFor({ state: 'detached' });
	await history.getByRole('heading', { name: '还没有查询记录', exact: true }).waitFor();
	assert.equal(await history.getByRole('button', { name: '清空记录', exact: true }).isDisabled(), true);
	assert.equal(await page.evaluate(() => document.activeElement?.textContent), '查询记录');
	assert.deepEqual((await current()).tasks, []);
	assert.deepEqual(JSON.parse(await readFile(join(profile, 'metadata/state.json'), 'utf8')).tasks, []);
	assert.deepEqual(await page.evaluate(() => window.nectisse.library.getState()), saved);
	assert.deepEqual(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).subscriptions), subscriptions);
	await page.screenshot({ path: join(output, '03-empty-history.png') });
	await history.getByRole('button', { name: '关闭', exact: true }).click();
	await page.getByRole('heading', { name: '从一部值得留下的作品开始。', exact: true }).waitFor();
	assert.equal(await input.inputValue(), '');
	await page.reload();
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	await page.getByRole('heading', { name: '从一部值得留下的作品开始。', exact: true }).waitFor();
	assert.deepEqual((await current()).tasks, []);
	assert.equal(await page.locator('.live-result-grid').count(), 0);
	assert.deepEqual(errors, []);
	assert.deepEqual(await app.evaluate(() => globalThis.__historyProbe.requests), []);
	console.log(JSON.stringify({ application: appPath ? 'packaged' : 'development', checks: ['startup-blank-with-existing-history', 'clear-current-keeps-history', 'empty-view-survives-navigation', 'history-selection-restores-results', 'reload-does-not-restore-history', 'cancel-confirmation-keeps-records', 'failed-clear-can-retry', 'clear-history-persists', 'collection-and-subscriptions-unchanged', 'empty-view-after-reload', 'no-site-requests'], screenshots: output }, null, 2));
} finally {
	await app?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}

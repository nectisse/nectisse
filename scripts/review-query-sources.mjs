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
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-query-sources-'));
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
env.PATH = '/usr/bin:/bin';
const output = join(root, '.test-output', appPath ? 'packaged-query-sources' : 'development-query-sources');
let app;
const launch = () =>
	_electron.launch({
		executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron,
		args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`],
		cwd: profile,
		env,
	});
try {
	execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), profile], { cwd: root, stdio: 'pipe' });
	app = await launch();
	let page = await app.firstWindow();
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	let nav = page.getByRole('navigation', { name: '主导航' });
	const selected = () => page.locator('.query-source-row button[aria-pressed="true"]').allTextContents();
	await page.getByRole('button', { name: '调整资料来源', exact: true }).click();
	await page.getByRole('button', { name: '查询使用 JavDB', exact: true }).click();
	await page.getByRole('button', { name: '查询使用 r18.dev', exact: true }).click();
	const before = await selected();
	await nav.getByRole('button', { name: '作品收藏', exact: true }).click();
	await nav.getByRole('button', { name: '资料查询', exact: true }).click();
	await page.getByRole('button', { name: '调整资料来源', exact: true }).click();
	const after = await selected();
	console.log(JSON.stringify({ before, after }));
	assert.deepEqual(after, before, '资料来源在切换页面后被重置');
	await page.reload();
	await page.getByRole('button', { name: '调整资料来源', exact: true }).click();
	await page.getByRole('button', { name: '查询使用 JavDB', exact: true }).waitFor();
	await page.waitForFunction(() => document.querySelector('button[aria-label="查询使用 JavDB"]')?.getAttribute('aria-pressed') === 'true');
	assert.deepEqual(await selected(), before, '刷新页面必须恢复选择');
	await app.close();
	app = await launch();
	page = await app.firstWindow();
	nav = page.getByRole('navigation', { name: '主导航' });
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	await page.getByRole('button', { name: '调整资料来源', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('button[aria-label="查询使用 JavDB"]')?.getAttribute('aria-pressed') === 'true');
	assert.deepEqual(await selected(), before, '退出再打开必须恢复选择');
	await page.evaluate(async () => {
		const state = await window.nectisse.subscriptions.getState();
		await window.nectisse.subscriptions.command({
			action: 'preferences',
			value: { ...state.preferences, enabledSources: state.preferences.enabledSources.filter((id) => id !== 'javdb') },
		});
	});
	await page.waitForFunction(() => document.querySelector('button[aria-label="查询使用 JavDB"]')?.disabled);
	assert.deepEqual(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).preferences.querySources), ['dmm', 'fc2', 'javdb']);
	await app.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('nectisse:metadata-query');
		ipcMain.handle('nectisse:metadata-query', (_event, input) => {
			globalThis.__querySourceInput = input;
			return { ok: false, message: '隔离测试未派发网络请求' };
		});
	});
	await page.locator('#work-query').fill('TEST-001');
	await page.getByRole('button', { name: '查询资料', exact: true }).click();
	assert.deepEqual(await app.evaluate(() => globalThis.__querySourceInput.sources), ['dmm', 'fc2']);
	await page.evaluate(async () => {
		const state = await window.nectisse.subscriptions.getState();
		await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, enabledSources: [...state.preferences.enabledSources, 'javdb'] } });
	});
	await page.waitForFunction(() => document.querySelector('button[aria-label="查询使用 JavDB"]')?.getAttribute('aria-pressed') === 'true');
	assert.deepEqual(await selected(), before, '重新启用来源保留原勾选');
	for (const name of [...before]) {
		await page.getByRole('button', { name: `查询使用 ${name}`, exact: true }).click();
	}
	assert.deepEqual(await selected(), []);
	assert.equal(await page.getByRole('button', { name: '查询资料', exact: true }).isDisabled(), true);
	await nav.getByRole('button', { name: '作品收藏', exact: true }).click();
	await nav.getByRole('button', { name: '资料查询', exact: true }).click();
	await page.getByRole('button', { name: '调整资料来源', exact: true }).click();
	assert.deepEqual(await selected(), [], '全不选不能恢复成默认值');
	await page.getByRole('button', { name: '选择全部已启用来源', exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll('.query-source-row button[aria-pressed="true"]').length === 4);
	const all = await selected();
	assert.equal(all.length, 4);
	await page.reload();
	await page.getByRole('button', { name: '调整资料来源', exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll('.query-source-row button[aria-pressed="true"]').length === 4);
	assert.deepEqual(await selected(), all);
	await app.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('nectisse:subscriptions-command');
		ipcMain.handle('nectisse:subscriptions-command', () => ({ ok: false, message: '来源保存测试失败' }));
	});
	await page.getByRole('button', { name: '查询使用 JavDB', exact: true }).click();
	await page.getByText('来源保存测试失败', { exact: true }).waitFor();
	assert.deepEqual(await selected(), all, '保存失败不能伪装成已保存');
	await mkdir(output, { recursive: true });
	await writeFile(
		join(output, 'result.json'),
		JSON.stringify(
			{
				before,
				after,
				reload: true,
				coldReopen: true,
				disabledRetained: true,
				queryFiltersDisabled: true,
				emptyRetained: true,
				selectAllRetained: true,
				failedSaveDoesNotChangeSelection: true,
				noNetworkRequests: true,
			},
			null,
			2,
		),
	);
	console.log(JSON.stringify({ checks: 'passed', output }));
} finally {
	await app?.close();
	await rm(profile, { recursive: true, force: true });
}

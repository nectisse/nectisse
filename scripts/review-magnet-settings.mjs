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
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-magnet-settings-'));
const output = join(root, '.test-output', appPath ? 'packaged-magnet-settings' : 'development-magnet-settings');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
env.PATH = '/usr/bin:/bin';
let app;
const layouts = [];
try {
	execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), profile], { cwd: root, stdio: 'pipe' });
	app = await _electron.launch({
		executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron,
		args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`],
		cwd: profile,
		env,
	});
	const page = await app.firstWindow();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	await app.evaluate(({ shell }) => {
		globalThis.__externalMagnetSites = [];
		globalThis.__externalMagnetSiteFails = false;
		shell.openExternal = async (url) => {
			if (globalThis.__externalMagnetSiteFails) {
				throw new Error('Simulated browser failure');
			}
			globalThis.__externalMagnetSites.push(url);
		};
	});
	await mkdir(output, { recursive: true });
	const open = async () => {
		await page.getByRole('button', { name: '设置', exact: true }).click();
		await page.getByRole('tab', { name: '磁链搜索', exact: true }).click();
	};
	await open();
	await page.getByRole('button', { name: '打开黑马磁力', exact: true }).click();
	assert.deepEqual(await app.evaluate(() => globalThis.__externalMagnetSites), ['https://heimacili.org/']);
	assert.equal(
		await page.evaluate(async () => {
			try {
				await window.nectisse.magnets.openSite('https://example.com/');
				return false;
			} catch {
				return true;
			}
		}),
		true,
	);
	await app.evaluate(() => { globalThis.__externalMagnetSiteFails = true; });
	await page.getByRole('button', { name: '打开黑马磁力', exact: true }).click();
	await page.getByText('黑马磁力未能打开，请稍后重试。', { exact: true }).waitFor();
	await app.evaluate(() => { globalThis.__externalMagnetSiteFails = false; });
	assert.equal(await page.getByRole('tablist', { name: '设置分区' }).getByRole('tab').count(), 5);
	for (const width of [1000, 1280]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 840), width);
		await page.waitForFunction((width) => innerWidth === width, width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate(async (theme) => {
				const state = await window.nectisse.subscriptions.getState();
				await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, theme } });
			}, theme);
			await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
			const layout = await page.getByRole('tabpanel', { name: '磁链搜索', exact: true }).evaluate((element) => {
				const bounds = element.getBoundingClientRect();
				const rows = [...element.querySelectorAll('.settings-row')];
				return {
					width: bounds.width,
					cards: [...element.querySelectorAll('.settings-card')].map((card) => card.getBoundingClientRect().width),
					rowHeights: rows.map((row) => row.getBoundingClientRect().height),
					controls: rows.map((row) => row.querySelector('.settings-value').getBoundingClientRect().x),
					selects: [...element.querySelectorAll('[role="combobox"]')].map((select) => select.getBoundingClientRect().height),
					overflow: document.querySelector('.page-scroll').scrollWidth - document.querySelector('.page-scroll').clientWidth,
					outerScroll: scrollY,
				};
			});
			assert.ok(
				layout.cards.every((width) => Math.abs(width - layout.width) <= 1),
				JSON.stringify(layout),
			);
			assert.ok(
				layout.controls.every((x) => Math.abs(x - layout.controls[0]) <= 1),
				JSON.stringify(layout),
			);
			assert.ok(
				layout.rowHeights.every((height) => height >= 59 && height <= 85),
				JSON.stringify(layout),
			);
			assert.ok(
				layout.selects.every((height) => height === 36),
				JSON.stringify(layout),
			);
			assert.equal(layout.overflow, 0);
			assert.equal(layout.outerScroll, 0);
			layouts.push({ windowWidth: width, theme, ...layout });
			await page.screenshot({ path: join(output, `${width}-${theme}.png`) });
		}
	}
	await chooseOption(page, '磁链结果上限', '5 条');
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.magnetSearch.maxResults === 5);
	await chooseOption(page, '磁链连接方式', '浏览器指纹');
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.magnetSearch.transport === 'fingerprint');
	await chooseOption(page, '默认磁链来源', 'JavTao');
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.magnetSearch.source === 'javtao');
	assert.equal(await page.getByRole('combobox', { name: '磁链连接方式', exact: true }).isDisabled(), true);
	await page.reload();
	await open();
	assert.match(await page.getByRole('combobox', { name: '磁链结果上限', exact: true }).innerText(), /5 条/);
	assert.match(await page.getByRole('combobox', { name: '磁链连接方式', exact: true }).innerText(), /浏览器指纹/);
	assert.match(await page.getByRole('combobox', { name: '默认磁链来源', exact: true }).innerText(), /JavTao/);
	await page.getByRole('switch', { name: '启用磁链搜索', exact: true }).click();
	await page.waitForFunction(async () => !(await window.nectisse.subscriptions.getState()).preferences.magnetSearch.enabled);
	assert.equal(await page.getByRole('combobox', { name: '磁链结果上限', exact: true }).isDisabled(), true);
	const disabled = await page.evaluate(async () => {
		const state = await window.nectisse.metadata.getState();
		const task = state.tasks.find((task) => task.records.some((record) => record.code === 'NECT-024'));
		return window.nectisse.magnets.search({ id: crypto.randomUUID(), origin: { kind: 'query', taskId: task.id, code: 'NECT-024' }, force: true });
	});
	assert.equal(disabled.reason, 'disabled');
	assert.equal(disabled.requests, 0);
	await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '资料查询', exact: true }).click();
	await page.getByRole('button', { name: '查看真实作品 NECT-024', exact: true }).click();
	assert.equal(await page.getByRole('tab', { name: '磁链搜索', exact: true }).count(), 0);
	await open();
	await page.getByRole('switch', { name: '启用磁链搜索', exact: true }).click();
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.magnetSearch.enabled);
	await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '资料查询', exact: true }).click();
	await page.getByRole('button', { name: '查看真实作品 NECT-024', exact: true }).click();
	assert.equal(await page.getByRole('tab', { name: '磁链搜索', exact: true }).count(), 1);
	assert.deepEqual(errors, []);
	await writeFile(
		join(output, 'result.json'),
		JSON.stringify({ layouts, persisted: true, disabledRejectsIpc: true, detailEntryFollowsSwitch: true, externalSiteOpensHomepageOnly: true, externalSiteRejectsUnknownUrls: true, browserFailureToast: true, noRealNetworkRequests: true }, null, 2),
	);
	console.log(JSON.stringify({ passed: true, output }));
} finally {
	await app?.close();
	await rm(profile, { recursive: true, force: true });
}

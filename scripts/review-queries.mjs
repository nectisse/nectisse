import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-queries-'));
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
env.PATH = '/usr/bin:/bin';
let app;

try {
	execFileSync(process.execPath, ['--import', 'tsx', 'scripts/seed-workspace-fixtures.ts', profile], { cwd: root, stdio: 'pipe' });
	const path = join(profile, 'metadata', 'state.json');
	const fixture = JSON.parse(await readFile(path, 'utf8'));
	const extra = structuredClone(fixture.tasks[0].records[0]);
	extra.id = createHash('sha256').update('NECT-025').digest('hex');
	extra.code = 'NECT-025';
	extra.title = '另一个本机作品';
	fixture.tasks[0].records.push(extra);
	await writeFile(path, JSON.stringify(fixture));
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
	await app.evaluate(({ ipcMain, session, clipboard }) => {
		const probe = (globalThis.__queryProbe = { reads: [], reports: 0, workMode: 'normal', reportMode: 'normal', pending: [], requests: [] });
		session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
			probe.requests.push(details.url);
			callback({ cancel: true });
		});
		clipboard.writeText = () => {};
		for (const channel of ['nectisse:library-work', 'nectisse:diagnostics-get']) {
			const original = ipcMain._invokeHandlers.get(channel);
			ipcMain.removeHandler(channel);
			ipcMain.handle(channel, async (event, id) => {
				const work = channel === 'nectisse:library-work';
				if (work) {
					probe.reads.push(id);
				} else {
					probe.reports++;
				}
				const mode = work ? probe.workMode : probe.reportMode;
				if (mode === 'failed') {
					throw new Error('query-read-fixture');
				}
				const value = await original(event, id);
				if (mode === 'pending') {
					return new Promise((resolve) => probe.pending.push(() => resolve(value)));
				}
				return value;
			});
		}
	});
	const ids = await page.evaluate(async (taskId) => {
		const ids = [];
		for (const code of ['NECT-024', 'NECT-025']) {
			ids.push((await window.nectisse.library.save({ taskId, code })).id);
		}
		return ids;
	}, fixture.tasks[0].id);
	const nav = page.getByRole('navigation', { name: '主导航', exact: true });
	const browse = () => nav.getByRole('button', { name: '作品收藏', exact: true }).click();
	const detail = async (code) => {
		await page.getByRole('button', { name: `查看收藏作品 ${code}`, exact: true }).click();
		await page.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
	};
	const counts = () => app.evaluate(() => ({ reads: globalThis.__queryProbe.reads, reports: globalThis.__queryProbe.reports }));
	const mode = (domain, value) =>
		app.evaluate(
			(_electron, { domain, value }) => {
				globalThis.__queryProbe[`${domain}Mode`] = value;
			},
			{ domain, value },
		);
	const settleEvents = async () => {
		await page.evaluate(() => {
			window.dispatchEvent(new Event('offline'));
			window.dispatchEvent(new Event('online'));
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
	};
	await browse();
	await detail('NECT-024');
	assert.deepEqual((await counts()).reads, [ids[0]]);
	await page.getByRole('button', { name: '返回作品收藏', exact: true }).click();
	await detail('NECT-024');
	assert.deepEqual((await counts()).reads, [ids[0]], 'Returning to an unchanged detail uses its memory cache');
	await page.evaluate(async (id) => window.nectisse.library.remove(id), ids[1]);
	await settleEvents();
	assert.deepEqual((await counts()).reads, [ids[0]], 'An unrelated summary change must not re-read this detail');
	await page.getByRole('button', { name: '取消收藏', exact: true }).click();
	await page.getByRole('button', { name: '确认取消收藏', exact: true }).click();
	await page.getByRole('heading', { name: '把值得留下的作品，放在一起。', exact: true }).waitFor();
	await page.evaluate(async (taskId) => window.nectisse.library.save({ taskId, code: 'NECT-024' }), fixture.tasks[0].id);
	await detail('NECT-024');
	assert.deepEqual((await counts()).reads, [ids[0], ids[0]], 'Re-saving the same identity cannot reuse its deleted snapshot');
	await page.evaluate(async (taskId) => window.nectisse.library.save({ taskId, code: 'NECT-025' }), fixture.tasks[0].id);
	await page.getByRole('button', { name: '返回作品收藏', exact: true }).click();
	await mode('work', 'failed');
	await page.getByRole('button', { name: '查看收藏作品 NECT-025', exact: true }).click();
	await page.getByText('这部作品的收藏暂时无法读取，请重新检查收藏库。', { exact: true }).waitFor();
	await mode('work', 'normal');
	await page.getByRole('button', { name: '重新检查收藏库', exact: true }).click();
	await page.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
	assert.equal((await counts()).reads.filter((id) => id === ids[1]).length, 2);
	// Reload empties only the renderer cache; actual saved data remains in the isolated database.
	await page.reload();
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	await browse();
	await mode('work', 'pending');
	await page.getByRole('button', { name: '查看收藏作品 NECT-024', exact: true }).click();
	await page.getByText('正在读取收藏资料…', { exact: true }).waitFor();
	await page.getByRole('button', { name: '返回作品收藏', exact: true }).click();
	await mode('work', 'normal');
	await detail('NECT-025');
	await app.evaluate(() => {
		globalThis.__queryProbe.pending.splice(0).forEach((complete) => complete());
	});
	assert.equal(await page.locator('.detail-code').innerText(), 'NECT-025');
	await page.getByRole('button', { name: '设置', exact: true }).click();
	await page.getByRole('tab', { name: '外观与应用', exact: true }).click();
	assert.equal((await counts()).reports, 0, 'Diagnostics is not read merely by visiting settings');
	const open = async () => {
		await page.getByRole('button', { name: '查看诊断日志', exact: true }).click();
		await page.getByRole('heading', { name: '诊断日志', exact: true }).waitFor();
	};
	const loaded = () => page.waitForFunction(() => document.querySelector('.diagnostics-records')?.getAttribute('aria-busy') === 'false');
	const close = () => page.getByRole('button', { name: '关闭诊断日志', exact: true }).click();
	await open();
	await loaded();
	assert.equal((await counts()).reports, 1);
	await settleEvents();
	assert.equal((await counts()).reports, 1);
	await close();
	await mode('report', 'pending');
	await open();
	await page.waitForFunction(() => document.querySelector('.diagnostics-records')?.getAttribute('aria-busy') === 'true');
	await close();
	await mode('report', 'normal');
	await open();
	await loaded();
	const reports = (await counts()).reports;
	await app.evaluate(() => {
		globalThis.__queryProbe.pending.splice(0).forEach((complete) => complete());
	});
	await settleEvents();
	assert.equal((await counts()).reports, reports);
	await page.getByRole('button', { name: '刷新日志', exact: true }).click();
	await loaded();
	assert.equal((await counts()).reports, reports + 1);
	await page.getByRole('button', { name: '复制诊断信息', exact: true }).click();
	await page.getByText('诊断信息已复制', { exact: true }).waitFor();
	assert.deepEqual(errors, []);
	assert.deepEqual(await app.evaluate(() => globalThis.__queryProbe.requests), []);
	console.log(
		JSON.stringify(
			{
				application: appPath ? 'packaged' : 'development',
				checks: [
					'detail-cache-reuse',
					'unrelated-summary-does-not-refetch',
					'delete-and-resave-same-identity',
					'read-failure-and-explicit-recovery',
					'late-detail-cannot-replace-selected-work',
					'diagnostics-only-when-open',
					'close-and-reopen-ignores-late-report',
					'refresh-and-copy',
					'no-focus-or-reconnect-reads',
					'no-site-requests',
				],
				counts: await counts(),
			},
			null,
			2,
		),
	);
} finally {
	await app
		?.evaluate(() => {
			globalThis.__queryProbe?.pending.splice(0).forEach((complete) => complete());
		})
		.catch(() => {});
	await app?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}

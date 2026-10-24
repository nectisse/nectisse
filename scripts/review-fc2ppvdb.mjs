// 真实 IPC→主进程→随包 Python→独立浏览器；测试配置与正式资料库隔离。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-fc2ppvdb-app-'));
const output = join(root, '.test-output', appPath ? 'packaged-fc2ppvdb' : 'development-fc2ppvdb');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
env.PATH = '/usr/bin:/bin';
let app;
const report = [];
let cancelledId;
const owned = () =>
	execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8' })
		.split('\n')
		.filter((line) => line.includes(profile))
		.map((line) => Number(line.trim().split(/\s+/)[0]));
const gone = async (pids) => {
	for (let attempt = 0; attempt < 120; attempt++) {
		const alive = pids.filter((pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		});
		if (!alive.length) return;
		await delay(50);
	}
	for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
};
try {
	await mkdir(output, { recursive: true });
	for (let launch = 1; launch <= 3; launch++) {
		app = await _electron.launch({
			executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron,
			args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`],
			cwd: profile,
			env,
		});
		const page = await app.firstWindow();
		await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor({ timeout: 20_000 });
		const settings = await page.evaluate(() => window.nectisse.subscriptions.getState());
		if (launch === 3) {
			const restored = await page.evaluate(() => window.nectisse.metadata.getState());
			assert.equal(restored.tasks.find((task) => task.id === cancelledId).status, 'cancelled');
			assert.equal(restored.activeId, undefined);
			assert.equal(
				owned().filter((pid) => {
					const args = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
					return args.includes('--browser-session');
				}).length,
				0,
			);
			const pids = owned();
			await app.close();
			app = undefined;
			await gone(pids);
			break;
		}
		if (launch === 1) {
			const reply = await page.evaluate(
				(preferences) =>
					window.nectisse.subscriptions.command({
						action: 'preferences',
						value: { ...preferences, enabledSources: ['fc2ppvdb'], proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7890' },
					}),
				settings.preferences,
			);
			assert.equal(reply.ok, true);
		}
		await page.getByRole('button', { name: '设置', exact: true }).click();
		await page.getByRole('button', { name: '配置 FC2PPV-DB', exact: true }).click();
		const select = page.getByRole('combobox', { name: 'fc2ppvdb 传输', exact: true });
		await select.waitFor();
		assert.match(await select.innerText(), /浏览器会话/);
		assert.equal(await page.getByRole('textbox', { name: 'fc2ppvdb Cookie' }).count(), 0);
		const phases = [];
		for (let query = 1; query <= (launch === 1 ? 2 : 1); query++) {
			const started = Date.now();
			const reply = await page.evaluate(() => window.nectisse.metadata.query({ query: 'FC2-PPV-4898837', sources: ['fc2ppvdb'], force: true }));
			assert.equal(reply.ok, true);
			let state;
			while (Date.now() - started < 250_000) {
				state = await page.evaluate(() => window.nectisse.metadata.getState());
				const task = state.tasks.find((item) => item.id === reply.taskId);
				if (task && !phases.includes(task.phase)) phases.push(task.phase);
				if (!state.activeId) break;
				await delay(200);
			}
			const task = state.tasks.find((item) => item.id === reply.taskId) ?? state.tasks[0];
			const result = {
				launch,
				query,
				durationMs: Date.now() - started,
				status: task.status,
				requests: task.requests,
				outcomes: task.outcomes,
				records: task.records.map((record) => ({
					code: record.code,
					titlePresent: !!record.title,
					tags: record.tags.length,
					sellerPresent: !!record.seller,
					releaseDate: record.releaseDate,
				})),
				phases,
			};
			report.push(result);
			console.log(JSON.stringify(result));
			assert.equal(task.status, 'succeeded');
			assert.equal(task.records.length, 1);
			assert.equal(task.records[0].code, 'FC2-PPV-4898837');
		}
		if (launch === 2) {
			const query = await page.evaluate(() => window.nectisse.metadata.query({ query: 'FC2-PPV-4898837', sources: ['fc2ppvdb'], force: true }));
			assert.equal(query.ok, true);
			cancelledId = query.taskId;
			for (let attempt = 0; attempt < 100; attempt++) {
				const state = await page.evaluate(() => window.nectisse.metadata.getState());
				if (state.tasks.find((task) => task.id === query.taskId)?.requests) break;
				await delay(20);
			}
			await page.evaluate((id) => window.nectisse.metadata.cancel(id), cancelledId);
			const state = await page.evaluate(() => window.nectisse.metadata.getState());
			assert.equal(state.tasks.find((task) => task.id === cancelledId).status, 'cancelled');
		}
		assert.equal(owned().filter((pid) => pid !== app.process().pid).length > 0, true);
		const pids = owned();
		await app.close();
		app = undefined;
		await gone(pids);
	}
	await writeFile(
		join(output, 'result.json'),
		JSON.stringify({ checkedAt: new Date().toISOString(), report, cancelledPersisted: true, noAutomaticResume: true, ownedProcessesReaped: true }, null, 2),
	);
} finally {
	await app?.close();
	await rm(profile, { recursive: true, force: true });
}

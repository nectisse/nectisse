import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import { reviewMetadata } from './review-metadata.mjs';
import { reviewSubscriptions } from './review-subscriptions.mjs';
import { reviewSourcesLive } from './review-sources.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] && !process.argv[2].startsWith('--') ? resolve(process.argv[2]) : undefined;
const simulateFailure = process.argv.includes('--failure');
const live = process.argv.includes('--live');
const followLive = process.argv.includes('--follow-live');
const sourcesLive = process.argv.includes('--sources-live');
if (simulateFailure && !appPath?.startsWith(join(root, '.test-output/'))) {
	throw new Error('故障注入仅允许用于 .test-output 中的应用副本');
}
const userData = await mkdtemp(join(tmpdir(), 'nectisse-desktop-smoke-'));
const executablePath = appPath ? join(appPath, 'Contents/MacOS/Nectisse') : (await import('electron')).default;
const args = [...(appPath ? [] : [root]), `--user-data-dir=${userData}`];
// No developer PATH or Python-related environment is inherited.
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
env.PATH = '/usr/bin:/bin';
const bootstrap = appPath ? join(appPath, 'Contents/Resources/python/app/bootstrap.py') : undefined;
let moved = false;
let application;
const failures = [];

async function observeNetwork(application) {
	await application.evaluate(({ session }) => {
		globalThis.__smokeNetworkRequests = [];
		session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
			globalThis.__smokeNetworkRequests.push(details.url);
			callback({ cancel: true });
		});
	});
}

try {
	if (simulateFailure) {
		await rename(bootstrap, `${bootstrap}.smoke-disabled`);
		moved = true;
	}
	application = await _electron.launch({ executablePath, args, cwd: userData, env, timeout: 30_000 });
	await observeNetwork(application);
	let page = await application.firstWindow();
	page.on('pageerror', (error) => failures.push(error.message));
	if (simulateFailure) {
		await page.locator('[data-testid="runtime-status"][data-phase="error"]').waitFor({ timeout: 20_000 });
		await page.getByRole('alert').waitFor();
		const diagnostics = await page.evaluate(() => window.nectisse.diagnostics.getReport());
		assert.equal(diagnostics.environment.runtimePhase, 'error');
		assert.ok(diagnostics.entries.some(entry => entry.code.startsWith('RUNTIME_')));
		await rename(`${bootstrap}.smoke-disabled`, bootstrap);
		moved = false;
		await page.getByRole('button', { name: '重新检查' }).click();
	}
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor({ timeout: 20_000 });
	const inspection = await page.evaluate(async () => ({
		state: await window.nectisse.runtime.getState(),
		hasNode: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
	}));
	assert.equal(inspection.state.phase, 'ready');
	assert.equal(inspection.hasNode, false);
	await page.evaluate(() => Promise.all([window.nectisse.subscriptions.getState(), window.nectisse.library.getState(), window.nectisse.metadata.getState()]));
	const expectedRuntime = appPath ? join(appPath, 'Contents/Resources/python/runtime/') : join(root, '.build/python/');
	assert.ok(inspection.state.health.executable.startsWith(expectedRuntime));
	const sandbox = await application.evaluate(({ BrowserWindow }) => {
		const settings = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
		return { sandbox: settings.sandbox, contextIsolation: settings.contextIsolation, nodeIntegration: settings.nodeIntegration };
	});
	assert.deepEqual(sandbox, { sandbox: true, contextIsolation: true, nodeIntegration: false });
	assert.deepEqual(await application.evaluate(() => globalThis.__smokeNetworkRequests), []);
	const cancelledId = live ? await reviewMetadata(page, application, join(root, '.test-output', appPath ? 'packaged-metadata' : 'development-metadata')) : undefined;
	const followReport = followLive ? await reviewSubscriptions(page, join(root, '.test-output', appPath ? 'packaged-settings' : 'development-settings')) : undefined;
	const sourcesReport = sourcesLive ? await reviewSourcesLive(page, join(root, '.test-output', appPath ? 'packaged-sources' : 'development-sources'), process.env.NECTISSE_TEST_PROXY || '') : undefined;
	const secondExit = await new Promise((resolveExit, reject) => {
		const second = spawn(executablePath, args, { cwd: userData, env, stdio: 'ignore' });
		const timeout = setTimeout(() => {
			second.kill('SIGKILL');
			reject(new Error('Second instance did not exit'));
		}, 15_000);
		second.once('error', reject);
		second.once('exit', (code) => {
			clearTimeout(timeout);
			resolveExit(code);
		});
	});
	assert.equal(secondExit, 0);
	assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
	const pid = application.process().pid;
	await page.close();
	assert.equal(application.process().exitCode, null);
	const reopened = application.waitForEvent('window');
	await application.evaluate(({ app }) => {
		app.emit('activate');
	});
	page = await reopened;
	page.on('pageerror', (error) => failures.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	assert.equal(application.process().pid, pid);
	if (cancelledId) {
		const restored = await page.evaluate(() => window.nectisse.metadata.getState());
		assert.equal(restored.activeId, undefined);
		assert.equal(restored.tasks.find(task => task.id === cancelledId).status, 'cancelled');
	}
	if (followReport && !sourcesReport) { const state = await page.evaluate(() => window.nectisse.subscriptions.getState()); assert.equal(state.subscriptions[0].id, followReport.id); assert.equal(state.entries.length, followReport.entries); assert.equal(state.subscriptions[0].autoPaused, true); }
	if (followReport || sourcesReport) {
		await application.close(); application = undefined;
		application = await _electron.launch({ executablePath, args, cwd: userData, env, timeout: 30_000 });
		await observeNetwork(application);
		page = await application.firstWindow(); page.on('pageerror', error => failures.push(error.message));
		await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor({ timeout: 20_000 });
		const state = await page.evaluate(() => window.nectisse.subscriptions.getState());
		if (followReport && !sourcesReport) { assert.equal(state.subscriptions[0].id, followReport.id); assert.equal(state.entries.length, followReport.entries); assert.equal(state.entries.filter(entry => entry.read).length, followReport.read); assert.equal(state.subscriptions[0].autoPaused, true); }
		if (sourcesReport) { assert.equal(state.entries.length, sourcesReport.entries); assert.equal(state.entries.filter(entry => entry.read).length, sourcesReport.read); for (const sub of sourcesReport.subscriptions) assert.ok(state.subscriptions.some(row => row.id === sub.id)); }
		assert.equal(state.tasks.some(task => ['running', 'cancelling'].includes(task.status)), false);
	}
	assert.deepEqual(await application.evaluate(() => globalThis.__smokeNetworkRequests), []);
	assert.deepEqual(failures, []);
	await application.close();
	application = undefined;
	console.log(
		JSON.stringify(
			{
				application: appPath ? basename(appPath) : 'development build',
				python: inspection.state.health.pythonVersion,
				bundledExecutable: inspection.state.health.executable,
				checks: [
					'ready',
					'sandbox',
					'local-data-readable',
					'zero-site-requests',
					'single-instance',
					'close-and-reopen',
					'quit',
					...(live ? ['real-metadata-and-covers', 'source-link-identity', 'cancel-and-persist'] : []),
					...(followReport ? [`fanbox-real-follow-${followReport.entries}-entries`, 'follow-dedup-and-read-persist', `javdb-${followReport.javdb}`] : []),
					...(sourcesReport ? ['real-avbase-amane-onepondo-and-covers', 'real-kemono-follow-and-update-flow', 'expanded-follow-persistence-after-relaunch'] : []),
					...(simulateFailure ? ['startup-failure-and-retry'] : []),
				],
			},
			null,
			2,
		),
	);
} finally {
	await application?.close().catch(() => {});
	if (moved) await rename(`${bootstrap}.smoke-disabled`, bootstrap);
	await rm(userData, { recursive: true, force: true });
}

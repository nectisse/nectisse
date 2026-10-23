import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(root, 'dist/mac-arm64/Nectisse.app'));
const nativeOnly = process.argv.includes('--native-only');
const nativeDock = process.argv.includes('--native-dock') || nativeOnly;
const coldRounds = nativeOnly ? 1 : 10;
const activationRounds = nativeOnly ? 0 : 2;
const output = join(root, '.test-output', nativeOnly ? 'lifecycle-dock' : 'lifecycle');
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(root, '.test-output', 'lifecycle-app-'));
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-lifecycle-'));
const clone = join(scratch, 'Nectisse.app');
const auditPath = join(output, 'python-audit.jsonl');
const progressPath = join(output, 'progress.json');
const controlPath = join(output, 'control.json');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
env.PATH = '/usr/bin:/bin';
const report = { status: 'running', coldStarts: [], activateReopens: [], nativeDockReopens: [], singleInstanceChecks: [], errors: [] };
const allPython = new Set();
let running;
const run = promisify(execFile);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const within = async (promise, ms, label) => {
 let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); } finally { clearTimeout(timer); }
};
const waitUntil = async (test, ms, label) => { const start = Date.now(); while (Date.now() - start < ms) { if (await test()) return; await delay(40); } throw new Error(label); };
const audit = async () => (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const saveReport = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
const mark = async value => {
 report.progress = value;
 await saveReport();
 await writeFile(progressPath, JSON.stringify(value)); console.log(JSON.stringify(value));
};
const skippedNative = async () => { try { return !!JSON.parse(await readFile(controlPath, 'utf8')).skipNativeDock; } catch { return false; } };

async function inspector(url) {
 const socket = new WebSocket(url); await within(new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', fail, { once: true }); }), 5000, 'Node inspector did not connect');
 let id = 0; const pending = new Map();
 socket.addEventListener('message', event => { const reply = JSON.parse(String(event.data)); const callback = pending.get(reply.id); if (callback) { pending.delete(reply.id); callback(reply); } });
 const evaluate = async expression => {
  const requestId = ++id;
  const reply = await within(new Promise(resolveReply => { pending.set(requestId, resolveReply); socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }), 5000, 'Main-process API did not respond');
  assert.equal(reply.error, undefined); assert.equal(reply.result?.exceptionDetails, undefined); return reply.result.result.value;
 };
 return { evaluate, close: () => socket.close() };
}
const main = (app, body) => app.inspector.evaluate(`(async () => { const {app, BrowserWindow} = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); ${body} })()`);
async function launch() {
 const since = performance.now();
 // Native startup: no Playwright Electron loader, mocked ready event, or mock keychain.
 const child = spawn(join(clone, 'Contents/MacOS/Nectisse'), ['--inspect=127.0.0.1:0', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`], { cwd: profile, env, stdio: ['ignore', 'pipe', 'pipe'] });
 const exits = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
 let stderr = ''; let devtools, debug;
 child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-16000); devtools ||= stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1]; debug ||= stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1]; });
 const instance = { child, exits }; running = instance;
 await waitUntil(() => devtools && debug, 15000, 'Native app debugger endpoints were not ready');
 instance.inspector = await inspector(debug);
 instance.browser = await chromium.connectOverCDP(devtools, { timeout: 10000 });
 instance.context = instance.browser.contexts()[0];
 await waitUntil(() => instance.context.pages().length === 1, 10000, 'Expected one native main window');
 instance.page = instance.context.pages()[0];
 instance.page.on('pageerror', error => report.errors.push(error.message));
 await ready(instance);
 instance.startupMs = Math.round(performance.now() - since);
 return instance;
}
async function ready(app) {
 const page = app.page;
 await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor({ timeout: 20000 });
 await page.waitForFunction(() => document.querySelectorAll('.sidebar-author').length === 2, {}, { timeout: 6000 });
 const state = await page.evaluate(async () => ({ runtime: await window.nectisse.runtime.getState(), subscriptions: await window.nectisse.subscriptions.getState(), metadata: await window.nectisse.metadata.getState(), diagnostics: await window.nectisse.diagnostics.getReport() }));
 assert.equal(state.subscriptions.subscriptions.length, 2); assert.equal(state.metadata.tasks.length, 1);
 assert.equal(state.subscriptions.notice, ''); assert.deepEqual(state.diagnostics.entries, []);
 assert.equal(await page.getByRole('alert').count(), 0);
 assert.equal(await main(app, 'return BrowserWindow.getAllWindows().length'), 1);
 assert.equal(state.runtime.phase, 'ready'); assert.equal(alive(state.runtime.health.pid), false, 'Health worker must have exited before ready');
 const starts = (await audit()).filter(row => row.event === 'start' && row.parent === app.child.pid);
 assert.equal(starts.length, 1, 'Only one Python self-check per cold start'); assert.equal(starts[0].pid, state.runtime.health.pid);
 for (const row of starts) allPython.add(row.pid);
 app.healthPid ??= state.runtime.health.pid; app.runtimeRevision ??= state.runtime.revision;
 assert.equal(state.runtime.health.pid, app.healthPid, 'Window activation must reuse self-check result');
 assert.equal(state.runtime.revision, app.runtimeRevision, 'Window activation must not restart self-check');
 app.state = state; return state;
}
async function closeWindow(app) {
 await app.page.close(); await waitUntil(async () => await main(app, 'return BrowserWindow.getAllWindows().length') === 0, 5000, 'Window did not close');
 assert.equal(app.child.exitCode, null); assert.equal(app.child.signalCode, null);
 assert.equal((await audit()).filter(row => row.event === 'start' && row.parent === app.child.pid).length, 1);
}
async function reopen(app, manual, index) {
 const since = performance.now(); const before = (await audit()).filter(row => row.event === 'start').length;
 await closeWindow(app);
 if (manual) {
  await mark({ phase: 'awaiting-native-dock', round: index, mainPid: app.child.pid });
  await waitUntil(async () => app.context.pages().length > 0 || await skippedNative(), 600000, 'Native Dock action did not arrive');
  if (await skippedNative()) { report.nativeDockBlocked = 'Native Dock automation could not obtain an accessible target'; return false; }
 } else { await main(app, "app.emit('activate'); return true"); }
 await waitUntil(() => app.context.pages().length === 1, 5000, 'Activation did not recreate one window');
 app.page = app.context.pages()[0]; app.page.on('pageerror', error => report.errors.push(error.message));
 await ready(app);
 assert.equal((await audit()).filter(row => row.event === 'start').length, before, 'Reopen must create zero Python workers');
 // Manual timing includes the human wait and must not be presented as Dock latency.
 const timing = { [manual ? 'waitAndReopenMs' : 'reopenMs']: Math.round(performance.now() - since) };
 const result = { round: index, mainPid: app.child.pid, healthPid: app.healthPid, pythonStarts: 0, ...timing };
 (manual ? report.nativeDockReopens : report.activateReopens).push(result);
 await mark({ phase: manual ? 'native-dock-passed' : 'activate-passed', ...result }); return true;
}
async function quit(app) {
 // The same app.quit() path as the native Quit menu; disconnect before exit.
 await main(app, 'setTimeout(() => app.quit(), 80); return true'); app.inspector.close();
 const exit = await within(app.exits, 10000, 'App did not quit cleanly'); assert.deepEqual(exit, { code: 0, signal: null });
 await app.browser.close().catch(() => {});
 assert.equal(alive(app.child.pid), false); assert.ok([...allPython].every(pid => !alive(pid)), 'Owned Python processes must not remain after quit');
 running = undefined;
}
try {
 await rm(controlPath, { force: true }); await writeFile(auditPath, '');
 await run('/bin/cp', ['-cR', appPath, clone]);
 const sourceAsar = await readFile(join(appPath, 'Contents/Resources/app.asar'));
 const cloneAsar = await readFile(join(clone, 'Contents/Resources/app.asar'));
 report.applicationSha256 = createHash('sha256').update(sourceAsar).digest('hex'); assert.deepEqual(cloneAsar, sourceAsar);
 const bootstrapPath = join(clone, 'Contents/Resources/python/app/bootstrap.py');
 const originalBootstrap = await readFile(bootstrapPath, 'utf8');
 // The isolated copy only: audit every worker from entry through atexit. No polling gap.
 const probe = `import atexit as _lifecycle_atexit\nimport json as _lifecycle_json\nimport os as _lifecycle_os\ndef _lifecycle_record(event):\n    with open(${JSON.stringify(auditPath)}, 'a', encoding='utf-8') as stream:\n        stream.write(_lifecycle_json.dumps({'event': event, 'pid': _lifecycle_os.getpid(), 'parent': _lifecycle_os.getppid()}) + '\\n')\n_lifecycle_record('start')\n_lifecycle_atexit.register(_lifecycle_record, 'exit')\n\n`;
 await writeFile(bootstrapPath, originalBootstrap.replace('import argparse\n', probe + 'import argparse\n'));
 execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), profile], { cwd: root, stdio: 'pipe' });
 const db = new DatabaseSync(join(profile, 'nectisse.sqlite')); const preferences = JSON.parse(db.prepare('SELECT value FROM preferences WHERE id=1').get().value);
 preferences.automatic = false; preferences.enabledSources = []; db.prepare('UPDATE preferences SET value=? WHERE id=1').run(JSON.stringify(preferences));
 for (const row of db.prepare('SELECT id,value FROM subscriptions').all()) { const value = JSON.parse(row.value); value.autoPaused = true; db.prepare('UPDATE subscriptions SET value=? WHERE id=?').run(JSON.stringify(value), row.id); } db.close();
 let expectedRead = 0;
 for (let cycle = 1; cycle <= coldRounds; cycle++) {
  const app = await launch(); assert.equal(app.state.subscriptions.entries.filter(entry => entry.read).length, expectedRead);
  report.coldStarts.push({ round: cycle, mainPid: app.child.pid, healthPid: app.healthPid, startupMs: app.startupMs, pythonStarts: 1, diagnostics: 0 });
  await mark({ phase: 'cold-start-passed', ...report.coldStarts.at(-1) });
  const second = spawn(join(clone, 'Contents/MacOS/Nectisse'), [`--user-data-dir=${profile}`], { cwd: profile, env, stdio: 'ignore' });
  const secondExit = await within(new Promise(resolveExit => second.once('exit', code => resolveExit(code))), 10000, 'Second instance did not exit');
  assert.equal(secondExit, 0); await ready(app); report.singleInstanceChecks.push({ round: cycle, duplicateExited: true, pythonStarts: 0 });
  await mark({ phase: 'single-instance-passed', ...report.singleInstanceChecks.at(-1) });
  for (let reopenIndex = 1; reopenIndex <= activationRounds; reopenIndex++) await reopen(app, false, (cycle - 1) * activationRounds + reopenIndex);
  if (cycle === coldRounds && nativeDock) for (let dockIndex = 1; dockIndex <= 5; dockIndex++) { if (!await reopen(app, true, dockIndex)) break; }
  if (cycle === 1) { await app.page.evaluate(async () => { const state = await window.nectisse.subscriptions.getState(); await window.nectisse.subscriptions.command({ action: 'read', ids: [state.entries[0].id], read: true }); }); expectedRead = 1; }
  await quit(app);
 }
 const records = await audit(); const starts = records.filter(row => row.event === 'start'), exits = records.filter(row => row.event === 'exit');
 assert.equal(starts.length, coldRounds); assert.equal(exits.length, coldRounds); assert.equal(new Set(starts.map(row => row.pid)).size, coldRounds);
 let maxConcurrent = 0; const active = new Set(); for (const row of records) { if (row.event === 'start') active.add(row.pid); else active.delete(row.pid); maxConcurrent = Math.max(maxConcurrent, active.size); }
 assert.equal(maxConcurrent, 1); assert.equal(active.size, 0); assert.deepEqual(report.errors, []);
 report.python = { totalStarts: starts.length, totalExits: exits.length, maxConcurrent, remaining: [...allPython].filter(alive).length };
 report.summary = { coldStarts: report.coldStarts.length, activateReopens: report.activateReopens.length, nativeDockReopens: report.nativeDockReopens.length, singleInstanceChecks: report.singleInstanceChecks.length, maxColdStartMs: Math.max(...report.coldStarts.map(row => row.startupMs)), maxActivateMs: Math.max(0, ...report.activateReopens.map(row => row.reopenMs)) };
 report.status = 'passed';
 await mark({ phase: 'complete', ...report.summary, python: report.python });
} catch (error) {
 report.status = 'failed';
 report.failure = error instanceof Error ? error.message : String(error);
 await saveReport();
 throw error;
} finally {
 if (running) {
  try { await quit(running); } catch { running.inspector?.close(); running.child.kill('SIGKILL'); await running.exits; }
  await running?.browser?.close().catch(() => {});
 }
 await rm(profile, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(root, 'dist/mac-arm64/Nectisse.app'));
const output = join(root, '.test-output/native-quit');
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(root, '.test-output/quit-app-'));
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-quit-'));
const clone = join(scratch, 'Nectisse.app');
const run = promisify(execFile);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const within = async (promise, ms, label) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); } finally { clearTimeout(timer); } };
const wait = async (test, ms, label) => { const start = Date.now(); while (Date.now() - start < ms) { if (await test()) return; await delay(30); } throw new Error(label); };
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])); env.PATH = '/usr/bin:/bin';
const report = { status: 'running', rounds: [] };
const keyboard = process.argv.includes('--keyboard-cua');
// CUA sends a real Cmd+Q to the exact isolated app path in pending-quit.json,
// then acknowledges its PID in shortcut-sent.json; no user data or OS permissions change.
let child, browser, socket;
async function connectInspector(url) {
	socket = new WebSocket(url); await within(new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }), 5000, 'Inspector did not open');
	let nextId = 0; const pending = new Map();
	socket.addEventListener('message', event => { const reply = JSON.parse(String(event.data)); const accept = pending.get(reply.id); if (accept) { pending.delete(reply.id); accept(reply); } });
	return async expression => { const id = ++nextId; const reply = await within(new Promise(resolve => { pending.set(id, resolve); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }), 5000, 'Main inspector did not respond'); assert.equal(reply.error, undefined); assert.equal(reply.result?.exceptionDetails, undefined); return reply.result.result.value; };
}
try {
	await run('/bin/cp', ['-cR', appPath, clone]);
	const bundle = `app.nectisse.quit-review.${process.pid}`;
	await run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${bundle}`, join(clone, 'Contents/Info.plist')]);
	for (const mode of ['app-api', ...(keyboard ? ['native-keyboard-1', 'native-keyboard-2', 'native-keyboard-3'] : ['native-action', 'native-action-after-close'])]) {
		let stderr = '', debug, devtools;
		child = spawn(join(clone, 'Contents/MacOS/Nectisse'), ['--inspect=127.0.0.1:0', '--remote-debugging-port=0', `--user-data-dir=${profile}`], { cwd: profile, env, stdio: ['ignore', 'pipe', 'pipe'] });
		const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
		child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); debug ||= stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1]; devtools ||= stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1]; });
		await wait(() => debug && devtools, 15000, 'Debug endpoints unavailable');
		const evaluate = await connectInspector(debug);
		browser = await chromium.connectOverCDP(devtools);
		const context = browser.contexts()[0]; await wait(() => context.pages().length === 1, 10000, 'Window unavailable');
		const page = context.pages()[0]; await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor({ timeout: 15000 });
		const eventFile = join(output, `${mode}.jsonl`); await writeFile(eventFile, '');
		await evaluate(`(() => { const require = process.getBuiltinModule('module').createRequire(process.execPath); const {app,BrowserWindow}=require('electron'); const fs=require('node:fs'); for(const event of ['before-quit','will-quit','quit','window-all-closed','activate']) app.on(event,()=>fs.appendFileSync(${JSON.stringify(eventFile)},JSON.stringify({event,at:Date.now(),windows:BrowserWindow.getAllWindows().length})+'\\n')); return true; })()`);
		if (mode.endsWith('after-close')) { await page.close(); await wait(() => context.pages().length === 0, 5000, 'Close did not remove window'); }
		const started = performance.now();
		if (mode === 'app-api') await evaluate(`(() => { const {app}=process.getBuiltinModule('module').createRequire(process.execPath)('electron'); setTimeout(()=>app.quit(),50); return true; })()`);
		else if (mode.startsWith('native-action')) await evaluate(`(() => { const {Menu}=process.getBuiltinModule('module').createRequire(process.execPath)('electron'); setTimeout(()=>Menu.sendActionToFirstResponder('terminate:'),50); return true; })()`);
		else {
			await writeFile(join(output, 'shortcut-sent.json'), JSON.stringify({ pid: child.pid, sent: false }));
			await writeFile(join(output, 'pending-quit.json'), JSON.stringify({ mode, bundle, clone, pid: child.pid }));
			console.log(JSON.stringify({ phase: 'awaiting-native-shortcut', mode, bundle, clone, pid: child.pid }));
			await wait(async () => { try { const ack = JSON.parse(await readFile(join(output, 'shortcut-sent.json'), 'utf8')); return ack.pid === child.pid && ack.sent; } catch { return false; } }, 60000, 'Native shortcut was not sent');
		}
		socket.close(); socket = undefined;
		let outcome;
		try { outcome = await within(exit, 7000, `${mode}: main process stayed alive after Quit`); }
		catch (error) {
			const events = (await readFile(eventFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
			const remainingWindows = context.pages().length;
			report.rounds.push({ mode, pid: child.pid, exited: false, remainingWindows, events });
			throw error;
		}
		assert.deepEqual(outcome, { code: 0, signal: null }); assert.equal(alive(child.pid), false);
		const events = (await readFile(eventFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
		report.rounds.push({ mode, pid: child.pid, exited: true, [mode.startsWith('native-keyboard') ? 'waitAndExitMs' : 'exitMs']: Math.round(performance.now() - started), events });
		await browser.close().catch(() => {}); browser = undefined; child = undefined;
	}
	report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.message; throw error; }
finally {
	await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
	socket?.close(); if (child && alive(child.pid)) { child.kill('SIGKILL'); await delay(50); } await browser?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true });
}

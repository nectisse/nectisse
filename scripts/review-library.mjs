import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] && !process.argv[2].startsWith('--') ? resolve(process.argv[2]) : undefined;
const navigationOnly = process.argv.includes('--navigation-only');
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-library-'));
const output = join(root, '.test-output', appPath ? 'packaged-library' : 'development-library');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])); env.PATH = '/usr/bin:/bin';
const errors = [], measurements = [];
let app, page;
async function launch() {
 app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`], cwd: profile, env });
 await app.evaluate(({ session }) => { globalThis.__libraryRequests = []; session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { globalThis.__libraryRequests.push(details.url); callback({ cancel: true }); }); });
 page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
 await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
}
const nav = () => page.getByRole('navigation', { name: '主导航', exact: true });
async function quit() { assert.deepEqual(await app.evaluate(() => globalThis.__libraryRequests), []); await app.close(); app = undefined; }
async function library() { await nav().getByRole('button', { name: '作品收藏', exact: true }).click(); }
async function count(value) { await page.waitForFunction(count => document.querySelectorAll('.library-work').length === count, value, { timeout: 5000 }); }
async function check(name) {
 const bounds = await page.evaluate(() => ({ scroll: scrollY, outer: document.scrollingElement.scrollHeight, viewport: innerHeight, horizontal: document.querySelector('.page-scroll').scrollWidth - document.querySelector('.page-scroll').clientWidth }));
 assert.equal(bounds.scroll, 0); assert.ok(bounds.outer <= bounds.viewport + 1 && bounds.horizontal <= 1, JSON.stringify({ name, bounds }));
 const frames = await page.locator('.library-work .live-cover').evaluateAll(frames => frames.map(frame => { const r = frame.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
 assert.ok(frames.every(frame => Math.abs(frame.width / frame.height - 2184 / 1468) < .01));
 measurements.push({ name, frames }); await page.screenshot({ path: join(output, `${name}.png`) });
}
try {
 await mkdir(output, { recursive: true });
 execFileSync(process.execPath, ['--import', 'tsx', 'scripts/seed-workspace-fixtures.ts', profile], { cwd: root, stdio: 'pipe' });
 const path = join(profile, 'metadata', 'state.json');
 const metadata = JSON.parse(await readFile(path, 'utf8'));
 const base = metadata.tasks[0].records[0];
 for (const code of ['NECT-025', 'NECT-026']) {
  const record = structuredClone(base); record.code = code; record.id = createHash('sha256').update(code).digest('hex');
  record.title = code === 'NECT-025' ? '用于检查长标题与收藏卡片边界的作品资料。'.repeat(14) : '来源没有提供封面的作品';
  if (code === 'NECT-026') record.covers = [];
  metadata.tasks[0].records.push(record);
 }
 await writeFile(path, JSON.stringify(metadata));
 await launch();
 await page.locator('.live-result-grid').waitFor();
 assert.equal(await page.getByRole('button', { name: '收藏作品', exact: true }).count(), 3);
 await page.getByRole('button', { name: '收藏作品', exact: true }).first().click();
 await page.waitForFunction(async () => (await window.nectisse.library.getState()).works.length === 1);
 const first = (await page.evaluate(() => window.nectisse.library.getState())).works[0];
 await page.getByRole('button', { name: '查看真实作品 NECT-024', exact: true }).click();
 assert.equal(await page.locator('.live-detail .live-cover').count(), 1);
 assert.equal(await page.getByRole('tab', { name: '封面', exact: true }).count(), 0);
 await page.getByRole('button', { name: '更新收藏', exact: true }).click();
 await page.locator('[data-sonner-toast]').filter({ hasText: '收藏资料已更新' }).waitFor();
 const actionBounds = await page.locator('.page-heading-actions button').evaluateAll(buttons => buttons.map(button => { const rect = button.getBoundingClientRect(); return { text: button.textContent, y: rect.y, height: rect.height }; }));
 await page.screenshot({ path: join(output, 'detail-after-collection-feedback.png') });
 assert.ok(actionBounds.every(button => Math.abs(button.y - actionBounds[0].y) <= 1 && button.height === 32), `Collection feedback misaligned header actions: ${JSON.stringify(actionBounds)}`);
 const selected = await page.evaluate(id => window.nectisse.library.getWork(id), first.id);
 assert.equal(selected.coverId, metadata.tasks[0].records[0].covers[0].id); assert.equal(selected.savedAt, first.savedAt);
 await page.getByRole('button', { name: '返回查询结果', exact: true }).click();
 for (let i = 0; i < 2; i++) { await page.getByRole('button', { name: '收藏作品', exact: true }).first().click(); await page.waitForFunction(n => window.nectisse.library.getState().then(state => state.works.length === n), i + 2); }
 await library(); await count(3);
 if (navigationOnly) {
  for (let cycle = 0; cycle < 8; cycle++) { await nav().getByRole('button', { name: '资料查询', exact: true }).click(); await page.locator('.live-result-grid').waitFor(); await library(); await count(3); }
  await quit(); console.log(JSON.stringify({ check: 'save-three-and-repeated-navigation', passed: true }));
 } else {
 const search = page.getByRole('textbox', { name: '搜索收藏作品', exact: true });
 await search.fill('NECT-025'); await count(1);
 await search.fill('没有匹配的编号'); await page.getByRole('heading', { name: '没有匹配的收藏', exact: true }).waitFor();
 await search.fill(''); await count(3);
 for (const width of [1280, 1000]) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 840), width);
  await page.waitForFunction(width => innerWidth === width, width);
  for (const theme of ['cream', 'night']) {
   await page.evaluate(async theme => { const state = await window.nectisse.subscriptions.getState(); await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, theme } }); }, theme);
   await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
   await page.getByRole('tab', { name: '资料卡片', exact: true }).click(); await check(`${width}-${theme}-cards`);
   await page.getByRole('tab', { name: '照片墙', exact: true }).click();
   await page.waitForFunction(() => [...document.querySelectorAll('.library-wall img')].every(img => img.complete && img.naturalWidth > 0));
   assert.equal(await page.locator('.library-wall img').count(), 2); assert.equal(await page.locator('.library-wall .live-cover-placeholder').count(), 1);
   await check(`${width}-${theme}-wall`);
   await page.getByRole('button', { name: '查看收藏作品 NECT-024', exact: true }).click();
   await page.getByRole('button', { name: '取消收藏', exact: true }).waitFor(); await check(`${width}-${theme}-detail`);
   await page.getByRole('tab', { name: '来源与差异', exact: true }).click();
   assert.equal(await page.getByRole('table', { name: '来源字段差异对照', exact: true }).count(), 1);
   await page.getByRole('button', { name: '返回作品收藏', exact: true }).click();
  }
 }
 await page.getByRole('button', { name: '查看收藏作品 NECT-024', exact: true }).click();
 await page.getByRole('button', { name: '取消收藏', exact: true }).click();
 await page.getByRole('button', { name: '保留收藏', exact: true }).click();
 assert.equal((await page.evaluate(() => window.nectisse.library.getState())).works.length, 3);
 await page.getByRole('button', { name: '取消收藏', exact: true }).click();
 await page.getByRole('button', { name: '确认取消收藏', exact: true }).click(); await count(2);
 assert.ok(await stat(join(profile, 'library', 'covers', `${first.cover.asset.sha256}.image`)));
 await quit();
 metadata.tasks = []; metadata.assets = {}; await writeFile(path, JSON.stringify(metadata));
 await rm(join(profile, 'cache', 'covers'), { recursive: true, force: true });
 await launch(); await library(); await count(2);
 assert.equal((await page.evaluate(() => window.nectisse.metadata.getState())).tasks.length, 0);
 await page.getByRole('tab', { name: '照片墙', exact: true }).click();
 await page.waitForFunction(() => { const img = document.querySelector('.library-wall img'); return img?.complete && img.naturalWidth > 0; });
 await check('offline-after-query-history-and-cache-removed');
 await quit();
 await rename(join(profile, 'library'), join(profile, 'library-preserved'));
 await writeFile(join(profile, 'library'), 'temporary initialization obstruction');
 await launch(); await library();
 await page.getByRole('alert').filter({ hasText: '收藏库需要处理' }).waitFor();
 const pid = app.process().pid, healthPid = await page.evaluate(async () => (await window.nectisse.runtime.getState()).health.pid);
 await rm(join(profile, 'library')); await rename(join(profile, 'library-preserved'), join(profile, 'library'));
 await page.getByRole('button', { name: '重新检查收藏库', exact: true }).click(); await count(2);
 assert.equal(app.process().pid, pid); assert.equal(await page.evaluate(async () => (await window.nectisse.runtime.getState()).health.pid), healthPid);
 assert.equal((await page.evaluate(() => window.nectisse.diagnostics.getReport())).entries.some(entry => entry.code === 'LIBRARY_INITIALIZATION_FAILED'), true);
 await quit(); assert.deepEqual(errors, []);
 const report = { application: appPath ? 'packaged' : 'development', checks: ['query-save-and-explicit-update', 'single-preferred-cover-and-original-save-time', 'local-search', 'cards-and-photo-wall', 'both-themes-and-window-sizes', 'long-title-and-no-cover', 'source-provenance', 'remove-confirmation-and-shared-image', 'offline-after-history-and-cache-cleared', 'same-process-initialization-recovery', 'no-new-health-worker-on-recovery', 'diagnostics', 'zero-site-requests'], measurements };
 await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, measurements: undefined, screenshots: output }, null, 2));
 }
} catch (error) {
 if (page && !page.isClosed()) {
  await page.screenshot({ path: join(output, 'failure.png') });
  const signal = await page.evaluate(async () => ({ heading: document.querySelector('#page-heading')?.textContent, cards: document.querySelectorAll('.library-work').length, detail: document.querySelector('.live-detail') !== null, error: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent), library: await window.nectisse.library.getState() }));
  await writeFile(join(output, 'failure-state.json'), JSON.stringify({ ...signal, library: { revision: signal.library.revision, works: signal.library.works.map(work => work.code) }, errors }, null, 2));
 }
 throw error;
} finally { await app?.close().catch(() => {}); await rm(profile, { recursive: true, force: true }); }

import { openPeople, openUpdates, openProfile } from './people.mjs';
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
const userData = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-'));
const output = join(root, '.test-output', appPath ? 'packaged-workspace' : 'development-workspace');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
env.PATH = '/usr/bin:/bin';
let app;
const layouts = [];
try {
 execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), userData], { cwd: root, stdio: 'pipe' });
 app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${userData}`], cwd: userData, env });
 await app.evaluate(({ session }) => { globalThis.__requests = []; session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { globalThis.__requests.push(details.url); callback({ cancel: true }); }); });
 const page = await app.firstWindow();
 const errors = []; page.on('pageerror', error => errors.push(error.message));
 await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
 await mkdir(output, { recursive: true });
 const nav = page.getByRole('navigation', { name: '主导航', exact: true });
 const check = async name => {
	await page.locator('.page-scroll').evaluate(element => { element.scrollTop = 0; });
	await page.waitForFunction(() => [...document.querySelectorAll('.live-detail .live-cover img')].every(image => image.complete && image.naturalWidth > 0));
	await page.locator('.live-detail .live-cover img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  const windowScroll = await page.evaluate(() => ({ y: scrollY, height: document.scrollingElement.scrollHeight, viewport: innerHeight }));
  assert.ok(windowScroll.y === 0 && windowScroll.height <= windowScroll.viewport + 1, `${name}: whole-window overflow ${JSON.stringify(windowScroll)}`);
  const fit = await page.locator('.page-scroll').evaluate(element => element.scrollWidth <= element.clientWidth + 1);
  assert.equal(fit, true, `${name}: horizontal overflow`);
  const controlSizes = await page.locator('main button[data-slot="button"][data-size="sm"]').evaluateAll(buttons => buttons.filter(button => button.getBoundingClientRect().height > 0).map(button => ({ text: button.textContent, height: button.getBoundingClientRect().height })));
  assert.ok(controlSizes.every(button => Math.abs(button.height - 32) <= 1), JSON.stringify({ name, controlSizes }));
  const layout = await page.evaluate(() => {
   const rect = selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, width: box.width, height: box.height }; };
   const controls = [...document.querySelectorAll('.page-toolbar [data-slot="select-trigger"], .page-toolbar [data-slot="input"], .page-toolbar [data-slot="tabs-list"]')].map(node => ({ slot: node.dataset.slot, height: node.getBoundingClientRect().height }));
   const creator = !!document.querySelector('.real-creator-page');
   const people = !!document.querySelector('.people-page');
   return { viewport: innerWidth, gutter: parseFloat(getComputedStyle(document.querySelector('.workspace-shell')).getPropertyValue('--page-gutter')), top: parseFloat(getComputedStyle(document.querySelector('.workspace-shell')).getPropertyValue('--page-top')), scroll: rect('.page-scroll'), page: rect('.page'), heading: rect(creator ? '.creator-profile-navigation' : people ? '.people-heading' : '.workspace-page-heading'), title: rect('#page-heading'), toolbar: rect('.workspace-toolbar'), controls, creator, people };
  });
  layouts.push({ name, ...layout });
  const near = (a, b) => Math.abs(a - b) <= 1;
  assert.ok(near(layout.page.x, layout.scroll.x) && near(layout.page.width, layout.scroll.width), `${name}: page must fill the available width`);
  assert.ok(near(layout.heading.x, layout.scroll.x + layout.gutter) && near(layout.heading.right, layout.scroll.right - layout.gutter), `${name}: shared side gutters`);
  if (layout.creator) {
   const overview = await page.locator('.person-overview').boundingBox();
   assert.ok(near(overview.x, layout.heading.x) && near(overview.width, layout.heading.width), `${name}: person overview shares side gutters`);
   assert.ok(layout.title.y >= overview.y && layout.title.y < overview.y + overview.height, `${name}: identity stays inside the overview`);
  } else if (layout.people) {
   assert.ok(layout.title.x >= layout.heading.x + 20 && layout.title.y >= layout.heading.y + 20, `${name}: people title stays inside the illustrated header`);
  } else {
   assert.ok(near(layout.title.x, layout.heading.x) && near(layout.title.y, layout.scroll.y + layout.top), `${name}: shared title origin`);
  }
  assert.ok(layout.controls.every(control => near(control.height, 32)), `${name}: toolbar control heights ${JSON.stringify(layout.controls)}`);
  await page.screenshot({ path: join(output, `${name}.png`) });
 };
 const query = async () => {
  await nav.getByRole('button', { name: '资料查询', exact: true }).click();
  await page.locator('[data-testid="live-query"], .live-detail').first().waitFor();
  if (await page.locator('.live-detail').count()) {
   await page.getByRole('button', { name: '返回查询结果', exact: true }).click();
  }
  if (!await page.locator('.live-result-grid').count()) {
   await page.getByRole('button', { name: '查询记录', exact: true }).click();
   await page.getByRole('button', { name: '查看查询记录 NECT-024', exact: true }).click();
  }
  await page.locator('.live-result-grid').waitFor();
 };
 const detail = async () => { await query(); await page.getByRole('button', { name: '查看真实作品 NECT-024', exact: true }).click(); await page.locator('.live-detail').waitFor(); await page.waitForFunction(() => document.querySelector('.page-scroll').scrollTop === 0); };
 const creator = () => openProfile(page, '白石 澪', 'creators');
 const updates = (scope = 'creators') => openUpdates(page, scope);
 await query();
 const inputRect = await page.getByRole('textbox', { name: '作品编号、标题或原站链接' }).boundingBox();
 const submitRect = await page.getByRole('button', { name: '查询资料', exact: true }).boundingBox();
 assert.ok(Math.abs(inputRect.height - submitRect.height) <= 1);
 assert.ok(Math.abs(inputRect.y - submitRect.y) <= 1);
 await page.getByRole('button', { name: '调整资料来源', exact: true }).click();
 assert.equal(await page.locator('.metadata-source-picker button[aria-pressed]').count(), 22);
 await check('00-source-picker');
 await page.getByRole('button', { name: '调整资料来源', exact: true }).click();
 await openPeople(page, 'actors', 'manage');
 const archived = page.getByRole('checkbox', { name: '显示已取消关注的订阅', exact: true });
 await archived.check(); assert.equal(await archived.isChecked(), true);
 await archived.uncheck();
 await creator();
 const frequencyName = '白石 澪 · 私人作品与创作手记（布局检查样本） 检查频率';
 await page.getByRole('button', { name: '返回关注列表', exact: true }).click();
 await openPeople(page, 'creators', 'manage');
 await chooseOption(page, frequencyName, '每 3 小时');
 assert.equal(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).subscriptions.find(sub => sub.provider === 'fanbox').intervalMinutes), 180);
 await chooseOption(page, frequencyName, '使用默认频率');
 assert.equal(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).subscriptions.find(sub => sub.provider === 'fanbox').intervalMinutes), null);
 await creator();
 await updates();
 assert.equal(await page.locator('.real-feed-entry').count(), 3);
 assert.equal(await page.locator('.real-feed-entry .feed-image-placeholder').count(), 2);
 assert.equal(await page.locator('.real-feed-entry .feed-item-thumbnail').count(), 3);
 assert.equal(await page.locator('.real-feed-entry .feed-item-thumbnail img').count(), 1);
 const title = page.getByRole('button', { name: '十月的拍摄手记：让光再停留一会儿（布局检查样本）', exact: true });
 await title.click();
 await page.getByRole('dialog').waitFor();
 await page.waitForFunction(() => {
  const image = document.querySelector('.entry-detail-image img');
  return image?.complete && image.naturalWidth > 0;
 });
 await page.keyboard.press('Escape');
 await page.waitForFunction(() => document.activeElement?.textContent?.includes('十月的拍摄手记'));
 assert.equal(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).entries.filter(entry => entry.read).length), 1);
 for (const width of [1280, 1000, 1600]) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 840), width);
  await page.waitForFunction(width => innerWidth === width, width);
  for (const theme of ['cream', 'night']) {
   await page.evaluate(async theme => { const state = await window.nectisse.subscriptions.getState(); await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, theme } }); }, theme);
   await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
   await query(); await check(`${width}-${theme}-query`);
   await detail(); await check(`${width}-${theme}-detail`);
   assert.equal(await page.getByRole('tab', { name: '封面', exact: true }).count(), 0);
   assert.equal(await page.locator('.live-detail .live-cover').count(), 1);
   await check(`${width}-${theme}-covers`);
   await page.getByRole('tab', { name: '来源与差异', exact: true }).click(); await check(`${width}-${theme}-sources`);
   await page.getByRole('button', { name: '快速查询作品', exact: true }).click();
   await page.locator('[data-testid="live-query"]').waitFor();
   await page.waitForFunction(() => document.activeElement?.id === 'work-query');
   await nav.getByRole('button', { name: '作品收藏', exact: true }).click(); await check(`${width}-${theme}-library`);
   await openPeople(page, 'actors', 'manage'); await check(`${width}-${theme}-following`);
   await creator(); await check(`${width}-${theme}-creator`);
   await openPeople(page, 'creators');
   await page.getByRole('button', { name: '添加关注', exact: true }).first().click();
   const lookup = page.getByRole('textbox', { name: '主页、账号或演员名', exact: true });
   const lookupRect = await lookup.boundingBox();
   const lookupButton = await page.getByRole('button', { name: '查询身份', exact: true }).boundingBox();
   assert.ok(Math.abs(lookupRect.height - lookupButton.height) <= 1);
   assert.ok(Math.abs(lookupRect.y - lookupButton.y) <= 1);
   await check(`${width}-${theme}-creator-lookup`);
   await page.getByRole('button', { name: '关闭添加关注', exact: true }).click();
   await updates();
   const itemLayout = await page.locator('.real-feed-entry').evaluateAll(items => items.map(item => {
    const image = item.querySelector('.feed-item-thumbnail')?.getBoundingClientRect();
    const title = item.querySelector('.feed-item-title > span').getBoundingClientRect();
    const summary = item.querySelector('.feed-item-summary').getBoundingClientRect();
    return { height: item.getBoundingClientRect().height, x: image?.x, imageWidth: image?.width, imageHeight: image?.height, width: item.getBoundingClientRect().width, titleHeight: title.height, summaryHeight: summary.height };
   }));
   assert.ok(itemLayout.every(item => item.height > 0 && (!item.imageHeight || item.imageHeight <= item.imageWidth * 2 + 1) && item.titleHeight <= 49 && item.summaryHeight <= 92), JSON.stringify(itemLayout));
   assert.ok(itemLayout.every(item => Math.abs(item.width - itemLayout[0].width) <= 1 && item.width < 500), 'Creator updates use equally sized columns');
   await updates('actors');
   const actorEntry = page.locator('.real-feed-entry').filter({ has: page.getByRole('button', { name: '查询 NECT-024 资料', exact: true }) });
   assert.equal(await actorEntry.locator('.feed-item-dates > span').first().innerText(), '发行 2026/10/23');
   await check(`${width}-${theme}-updates`);
   await updates();
   await title.click();
   const dialog = page.getByRole('dialog');
   await page.waitForFunction(() => { const image = document.querySelector('.entry-detail-image img'); return image?.complete && image.naturalWidth > 0; });
   const preview = await dialog.locator('.entry-detail-image').boundingBox();
   const dialogBounds = await dialog.boundingBox();
   assert.ok(Math.abs(preview.width - (dialogBounds.width - 42)) <= 1 && preview.height >= 300, JSON.stringify({ preview, dialogBounds }));
   const headingBounds = await dialog.locator('.entry-dialog-title').boundingBox();
   assert.ok(headingBounds.y >= preview.y + preview.height + 16, 'The large cover appears above the title');
   assert.equal(await dialog.locator('.entry-detail-image img').evaluate(image => getComputedStyle(image).objectFit), 'contain');
   assert.deepEqual(await dialog.locator('.entry-dialog-facts dt').allTextContents(), ['发布时间', '来源页面', '发现时间']);
   await dialog.getByRole('heading', { name: '来源摘要', exact: true }).waitFor();
   assert.equal(await dialog.getByRole('button', { name: '放大封面', exact: true }).count(), 0);
   assert.equal(await dialog.getByText('收录方式', { exact: true }).count(), 0);
   await dialog.screenshot({ path: join(output, `${width}-${theme}-update-dialog.png`) });
   await page.keyboard.press('Escape');
   await page.waitForFunction(() => document.activeElement?.textContent?.includes('十月的拍摄手记'));
   await updates('actors');
   await actorEntry.locator('.feed-item-title').click();
   await dialog.waitFor();
   assert.deepEqual(await dialog.locator('.entry-dialog-facts dt').allTextContents(), ['发行日期', '来源页面', '发现时间']);
   assert.equal(await dialog.locator('.entry-dialog-facts dd').first().innerText(), '2026/10/23');
   assert.equal(await dialog.locator('.entry-dialog-facts dd').nth(1).innerText(), 'example.invalid');
   assert.equal(await dialog.locator('.entry-dialog-facts dd').nth(1).locator('span').getAttribute('title'), 'https://example.invalid/work');
   assert.equal(await dialog.locator('.entry-dialog-summary').count(), 0);
   assert.equal(await dialog.getByText('收录方式', { exact: true }).count(), 0);
   assert.equal(await dialog.getByRole('heading', { name: '收录说明', exact: true }).count(), 0);
   assert.equal(await dialog.getByRole('button', { name: '放大封面', exact: true }).count(), 0);
   const pendingPreview = await dialog.locator('.entry-detail-image').boundingBox();
   assert.ok(pendingPreview.width >= 700 && Math.abs(pendingPreview.height - 132) <= 1, JSON.stringify(pendingPreview));
   const bounds = await dialog.boundingBox();
   assert.ok(bounds.y >= 30 && bounds.height <= (width === 1000 ? 700 : 840) - 63, JSON.stringify(bounds));
   const footer = await dialog.locator('.entry-dialog-footer').boundingBox();
   assert.ok(footer.y + footer.height <= (width === 1000 ? 700 : 840) - 30);
   const bar = await dialog.locator('.entry-dialog-bar').boundingBox();
   await dialog.locator('.entry-dialog-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
   assert.deepEqual(await dialog.locator('.entry-dialog-footer').boundingBox(), footer);
   assert.deepEqual(await dialog.locator('.entry-dialog-bar').boundingBox(), bar);
   assert.equal(await page.evaluate(() => scrollY), 0);
   await dialog.locator('.entry-dialog-scroll').evaluate(element => { element.scrollTop = 0; });
   await dialog.screenshot({ path: join(output, `${width}-${theme}-update-dialog-long-title.png`) });
   await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
   await actorEntry.getByRole('button', { name: '标为未读', exact: true }).click();
   await page.getByRole('button', { name: '设置', exact: true }).click(); await check(`${width}-${theme}-settings`);
  }
 }
 await writeFile(join(output, 'layout-measurements.json'), JSON.stringify(layouts, null, 2));
 await page.reload();
 await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
 const restored = await page.evaluate(() => window.nectisse.subscriptions.getState());
 assert.equal(restored.entries.filter(entry => entry.read).length, 1);
 assert.equal(restored.subscriptions.find(sub => sub.provider === 'fanbox').intervalMinutes, null);
 // Simulate successive background IPC snapshots in this isolated fixture profile.
 // The already open dialog must follow the live entry rather than its old snapshot.
 await updates('actors');
 const evolving = page.locator('.real-feed-entry').filter({ has: page.getByRole('button', { name: '查询 NECT-024 资料', exact: true }) });
 await evolving.locator('.feed-item-title').click();
 await page.evaluate(() => window.nectisse.subscriptions.command({ action: 'source-enabled', source: 'javdb', enabled: false }));
 const live = await page.evaluate(() => window.nectisse.subscriptions.getState());
 const changing = live.entries.find(entry => entry.provider === 'javdb');
 const localImage = live.entries.find(entry => entry.imageAsset);
 const localAsset = localImage.imageAsset;
 changing.thumbnailUrl = 'https://c0.jdbstatic.com/fixture.jpg';
 delete changing.imageAsset;
 const coverTask = { id: crypto.randomUUID(), kind: 'covers', provider: changing.provider, subscriptionId: changing.subscriptionId, status: 'running', phase: '本地封面状态验证', startedAt: new Date().toISOString(), finishedAt: '', requests: 0, candidates: [], added: 0, reason: '', cancelRequestedAt: '' };
 live.tasks.unshift(coverTask);
 const publishImageState = async () => {
  await app.evaluate(({ BrowserWindow }, { root, entry, snapshot }) => {
   const require = process.getBuiltinModule('module').createRequire(process.execPath);
   const db = new (require('node:sqlite').DatabaseSync)(require('node:path').join(root, 'nectisse.sqlite'));
   try {
    db.prepare('UPDATE entries SET value=? WHERE id=?').run(JSON.stringify(entry), entry.id);
   } finally {
    db.close();
   }
   BrowserWindow.getAllWindows()[0].webContents.send('nectisse:subscriptions-state', snapshot);
  }, { root: userData, entry: changing, snapshot: live });
 };
 const emitImageState = async status => {
  live.revision++;
  changing.imageCache = { status, attempts: 1, nextAttemptAt: 0, reason: status === 'failed' ? 'not_found' : '' };
  coverTask.status = status === 'failed' ? 'failed' : 'running';
  await publishImageState();
 };
 await emitImageState('queued');
 await page.getByRole('dialog').getByRole('img', { name: '封面不可用', exact: true }).waitFor();
 await emitImageState('failed');
 await page.getByRole('dialog').getByRole('img', { name: '封面不可用', exact: true }).waitFor();
 assert.equal(await page.getByRole('button', { name: '重试未缓存封面', exact: true, includeHidden: true }).isEnabled(), true);
 await emitImageState('loading');
 await page.getByRole('dialog').getByRole('img', { name: '封面不可用', exact: true }).waitFor();
 changing.thumbnailUrl = localImage.thumbnailUrl;
 changing.imageAsset = localAsset; delete changing.imageCache; live.revision++;
 coverTask.status = 'succeeded';
 await publishImageState();
 await page.waitForFunction(() => { const image = document.querySelector('.entry-detail-image img'); return image?.complete && image.naturalWidth > 0; });
 assert.equal(await page.getByRole('dialog').getByRole('button', { name: '放大封面', exact: true }).count(), 0);
 const updatedCover = await page.getByRole('dialog').locator('.entry-detail-image').boundingBox();
 assert.ok(updatedCover.width >= 700 && updatedCover.height >= 300, JSON.stringify(updatedCover));
 await page.getByRole('dialog').screenshot({ path: join(output, 'background-cover-arrives-in-open-dialog.png') });
 assert.equal(await page.locator(`[data-post-id="${changing.id}"] .feed-item-thumbnail img`).count(), 1);
 await page.keyboard.press('Escape');
 assert.deepEqual(errors, []);
 assert.deepEqual(await app.evaluate(() => globalThis.__requests), []);
 console.log(JSON.stringify({ application: appPath ? 'packaged' : 'development', checks: ['four-real-pages-with-isolated-fixtures', 'both-themes-and-window-sizes', 'source-picker', 'uniform-control-sizes', 'responsive-creator-cards-and-text-only-items', 'compact-actor-rows-and-two-line-title', 'date-only-release-without-fabricated-time', 'default-frequency-and-read-persistence', 'dialog-escape-and-focus-return', 'large-cover-before-title-without-zoom', 'three-facts-without-collection-explanation', 'creator-source-summary-retained', 'long-title-and-fixed-actions', 'live-cover-states-and-retry-control', 'background-cover-arrives-in-open-dialog', 'no-site-requests'], screenshots: output }, null, 2));
} finally { await app?.close().catch(() => {}); await rm(userData, { recursive: true, force: true }); }

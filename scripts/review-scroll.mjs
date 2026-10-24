import { openPeople, openUpdates } from './people.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-'));
const output = join(root, '.test-output', appPath ? 'packaged-scroll' : 'development-scroll');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
env.PATH = '/usr/bin:/bin';
let app;
const reports = [];
try {
 execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), profile], { cwd: root, stdio: 'pipe' });
 const seed = `import { SubscriptionStore } from './src/main/features/subscriptions/subscription-store.ts'; const store = new SubscriptionStore(process.argv[1], {available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''}); const sub = store.subscriptions().find(sub=>sub.provider==='fanbox'); for(let index=100;index<180;index++) store.upsertEntry(sub,{externalId:String(index),title:'长列表滚动测试 '+index,summary:'这是保存在独立测试配置中的纯文字条目，不连接原站。',author:sub.name,publishedAt:'2026-10-23',publishedPrecision:'date',url:'https://example.invalid/posts/'+index,thumbnailUrl:'',code:'',restricted:false,partial:false}); store.close();`;
 execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', seed, profile], { cwd: root, stdio: 'pipe' });
 app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`], cwd: profile, env });
 const page = await app.firstWindow();
 await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
 await mkdir(output, { recursive: true });
 const nav = page.getByRole('navigation', { name: '主导航', exact: true });
 const measure = () => page.evaluate(() => {
  const bounds = selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; };
  return { windowY: scrollY, documentY: document.scrollingElement.scrollTop, documentHeight: document.scrollingElement.scrollHeight, viewportHeight: innerHeight, visualY: visualViewport.offsetTop,
   shell: bounds('.app-shell'), sidebar: bounds('.sidebar'), toolbar: bounds('.toolbar'), footer: bounds('.preview-footer'), page: bounds('.page-scroll'),
   innerY: document.querySelector('.page-scroll').scrollTop, shellY: document.querySelector('.app-shell').scrollTop,
   root: Object.fromEntries(['html','body','#root'].map(selector=>[selector,{overflowY:getComputedStyle(document.querySelector(selector)).overflowY,overscrollY:getComputedStyle(document.querySelector(selector)).overscrollBehaviorY}])) };
 });
 const stable = (before, after, context) => {
  reports.push({context,before,after});
  assert.equal(after.windowY, 0, `${context}: document moved`); assert.equal(after.documentY, 0, `${context}: root scrolled`); assert.equal(after.shellY, 0, `${context}: shell scrolled`);
  assert.ok(after.documentHeight <= after.viewportHeight + 1, `${context}: document taller than window`);
  for (const name of ['shell','sidebar','toolbar','footer']) assert.deepEqual(after[name], before[name], `${context}: ${name} moved`);
  assert.ok(after.footer.bottom <= after.viewportHeight + 1 && after.sidebar.top === 0, `${context}: chrome outside window`);
 };
 for (const width of [1280,1000]) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width===1000?700:840), width);
  for (const theme of ['cream','night']) {
   await page.evaluate(async theme=>{const state=await window.nectisse.subscriptions.getState();await window.nectisse.subscriptions.command({action:'preferences',value:{...state.preferences,theme}});},theme);
   await openUpdates(page);
   await page.waitForFunction(()=>document.querySelectorAll('.real-feed-entry').length===20);
   const before = await measure(); const rect = await page.locator('.page-scroll').boundingBox(); await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2); await page.mouse.wheel(0,1300);
   await page.waitForFunction(()=>document.querySelector('.page-scroll').scrollTop>0);
   stable(before,await measure(),`${width}-${theme}-middle`);
   // A wheel event over navigation must not find a scrollable document behind it.
   await page.mouse.move(90,200); await page.mouse.wheel(0,900);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   stable(before,await measure(),`${width}-${theme}-sidebar-wheel`);
   await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);
   await page.locator('.page-scroll').evaluate(element=>element.scrollTop=element.scrollHeight);
   await page.mouse.wheel(0,4000);
   // Waiting for animation frames lets a compositor scroll commit before measuring.
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const bottom=await measure(); stable(before,bottom,`${width}-${theme}-bottom-boundary`);
   await page.screenshot({path:join(output,`${width}-${theme}-bottom.png`)});
   await page.locator('.real-feed-entry .feed-item-title').last().focus(); await page.keyboard.press('Enter'); await page.getByRole('dialog').waitFor();
   await page.keyboard.press('Escape'); stable(before,await measure(),`${width}-${theme}-dialog-focus-return`);
   await page.locator('.page-scroll').evaluate(element=>element.scrollTop=0); await page.mouse.wheel(0,-4000);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const top=await measure(); stable(before,top,`${width}-${theme}-top-boundary`);
   await page.getByRole('button',{name:'设置',exact:true}).click();
   const settings = await measure();
   await page.locator('.page-scroll').evaluate(element=>element.scrollTop=element.scrollHeight);
   await page.mouse.wheel(0,4000);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   stable(settings,await measure(),`${width}-${theme}-settings-bottom-boundary`);
   await openPeople(page, 'creators');
   await page.waitForFunction(()=>document.querySelector('.page-scroll').scrollTop===0);
  }
 }
 console.log(JSON.stringify({checks:['84-entry-feed-paginated-by-20','wheel-and-boundary-scroll','sidebar-wheel-does-not-scroll-window','fixed-sidebar-toolbar-and-status','dialog-focus-return','settings-scroll-and-page-reset','both-themes-and-window-sizes'],screenshots:output},null,2));
} finally { await mkdir(output,{recursive:true}); await writeFile(join(output,'measurements.json'),JSON.stringify(reports,null,2)); await app?.close().catch(()=>{}); await rm(profile,{recursive:true,force:true}); }

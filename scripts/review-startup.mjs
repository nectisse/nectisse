import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-'));
const output = join(root, '.test-output', appPath ? 'packaged-startup' : 'development-startup');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])); env.PATH = '/usr/bin:/bin';
let app;
try {
 execFileSync(process.execPath,['--import','tsx',join(root,'scripts/seed-workspace-fixtures.ts'),profile],{cwd:root,stdio:'pipe'});
 app=await _electron.launch({executablePath:appPath?join(appPath,'Contents/MacOS/Nectisse'):electron,args:[...(appPath?[]:[root]),`--user-data-dir=${profile}`],cwd:profile,env});
 const page=await app.firstWindow(); await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
 await mkdir(output,{recursive:true});
 const snapshot=await page.evaluate(()=>window.nectisse.subscriptions.getState()); assert.equal(snapshot.subscriptions.length,2);
 await app.evaluate(({ipcMain},snapshot)=>{
  globalThis.__startupSnapshot=snapshot;globalThis.__startupAttempts=0;globalThis.__startupFailures=1;
  ipcMain.removeHandler('nectisse:subscriptions-get');
  ipcMain.handle('nectisse:subscriptions-get',()=>{globalThis.__startupAttempts++;if(globalThis.__startupAttempts<=globalThis.__startupFailures) throw new Error('SUBSCRIPTIONS_UNAVAILABLE'); return globalThis.__startupSnapshot;});
  ipcMain.removeHandler('nectisse:subscriptions-retry');
  ipcMain.handle('nectisse:subscriptions-retry',()=>{globalThis.__startupAttempts++;return globalThis.__startupSnapshot;});
 },snapshot);
 await page.reload();
 await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
 // One transient local-read failure must recover without a user action.
 await page.waitForFunction(()=>document.querySelectorAll('.sidebar-author').length===2,{},{timeout:5000});
 assert.equal(await app.evaluate(()=>globalThis.__startupAttempts),2);
 assert.equal(await page.getByRole('alert').count(),0);
 await page.screenshot({path:join(output,'transient-read-recovered.png')});
 await app.evaluate(()=>{globalThis.__startupAttempts=0;globalThis.__startupFailures=100;});
 await page.reload();
 await page.getByRole('alert').filter({hasText:'服务暂时未能响应'}).waitFor();
 assert.equal(await app.evaluate(()=>globalThis.__startupAttempts),3);
 await page.getByRole('alert').screenshot({path:join(output,'read-error-after-bounded-retries.png')});
 await app.evaluate(()=>{globalThis.__startupFailures=0;});
 await page.getByRole('button',{name:'重新检查',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.sidebar-author').length===2);
 assert.equal(await page.getByRole('alert').count(),0);assert.equal(await app.evaluate(()=>globalThis.__startupAttempts),4);
 await app.evaluate(({ipcMain})=>{
  globalThis.__startupAttempts=0;ipcMain.removeHandler('nectisse:subscriptions-get');
  ipcMain.handle('nectisse:subscriptions-get',()=>{globalThis.__startupAttempts++;return {...globalThis.__startupSnapshot,preferences:{...globalThis.__startupSnapshot.preferences,automatic:'invalid-fixture'}};});
 });
 await page.reload();
 await page.getByRole('alert').filter({hasText:'格式与当前版本不兼容'}).waitFor();
 assert.equal(await app.evaluate(()=>globalThis.__startupAttempts),3);
 // A successful push arriving before an older read rejection wins permanently.
 await app.evaluate(({ipcMain})=>{
  globalThis.__startupAttempts=0;ipcMain.removeHandler('nectisse:subscriptions-get');
  ipcMain.handle('nectisse:subscriptions-get',()=>{globalThis.__startupAttempts++;return new Promise((_resolve,reject)=>{globalThis.__rejectStartupRead=reject;});});
 });
 await page.reload();
 for(let count=0;count<100;count++){if(await app.evaluate(()=>!!globalThis.__rejectStartupRead))break;await new Promise(resolve=>setTimeout(resolve,10));}
 await app.evaluate(({BrowserWindow})=>{const state={...globalThis.__startupSnapshot,revision:globalThis.__startupSnapshot.revision+100};BrowserWindow.getAllWindows()[0].webContents.send('nectisse:subscriptions-state',state);globalThis.__rejectStartupRead(new Error('SUBSCRIPTIONS_UNAVAILABLE'));});
 await page.waitForFunction(()=>document.querySelectorAll('.sidebar-author').length===2);
 await new Promise(resolve=>setTimeout(resolve,350));
 assert.equal(await page.getByRole('alert').count(),0);assert.equal(await app.evaluate(()=>globalThis.__startupAttempts),1);
 const runtime=await page.evaluate(()=>window.nectisse.runtime.getState());
 await app.evaluate(({ipcMain,BrowserWindow},runtime)=>{
  ipcMain.removeHandler('nectisse:subscriptions-get');ipcMain.handle('nectisse:subscriptions-get',()=>globalThis.__startupSnapshot);
  globalThis.__runtimeRetryCount=0;ipcMain.removeHandler('nectisse:runtime-retry');ipcMain.handle('nectisse:runtime-retry',()=>{globalThis.__runtimeRetryCount++;return {...runtime,revision:runtime.revision+201};});
  BrowserWindow.getAllWindows()[0].webContents.send('nectisse:runtime-state',{phase:'error',revision:runtime.revision+200,message:'独立配置中的环境重试测试'});
 },runtime);
 await page.getByRole('alert').filter({hasText:'环境重试测试'}).waitFor();
 await page.getByRole('button',{name:'重新检查',exact:true}).click();
 await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();assert.equal(await page.getByRole('alert').count(),0);assert.equal(await app.evaluate(()=>globalThis.__runtimeRetryCount),1);
 console.log(JSON.stringify({checks:['first-subscription-read-failure-recovers','bounded-read-retries','retry-button-reloads-subscriptions','invalid-records-have-specific-message','late-read-rejection-does-not-override-pushed-success','runtime-error-retry-button-wiring','saved-subscriptions-visible','no-stuck-storage-alert'],screenshots:output},null,2));
} finally { await app?.close().catch(()=>{}); await rm(profile,{recursive:true,force:true}); }

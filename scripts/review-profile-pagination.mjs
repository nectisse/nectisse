import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-'));
const output = join(root, '.test-output', appPath ? 'packaged-profile-pagination' : 'development-profile-pagination');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
env.PATH = '/usr/bin:/bin';
let app;
const errors = [], reports = [];
try {
	execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), profile], { cwd: root, stdio: 'pipe' });
	const seed = `import { SubscriptionStore } from './src/main/subscription-store.ts';
	const store = new SubscriptionStore(process.argv[1], {available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});
	const actor = store.subscriptions().find(sub=>sub.provider==='javdb');
	const other = store.follow({provider:'javdb',ref:'second-actor',name:'另一位演员（分页样本）',url:'https://example.invalid/actors/second',aliases:[],recordType:'演员',bio:'',evidence:'本地测试'});
	const empty = store.follow({provider:'javdb',ref:'empty-actor',name:'无作品演员（分页样本）',url:'https://example.invalid/actors/empty',aliases:[],recordType:'演员',bio:'',evidence:'本地测试'});
	for (const sub of [other,empty]) {sub.initialized=true;store.saveSubscription(sub);}
	for(const [sub,count] of [[actor,44],[other,21]]) for(let index=0;index<count;index++) store.upsertEntry(sub,{externalId:'profile-'+index,title:'已收录作品分页样本 '+(index+1),summary:'独立本地样本，不请求原站。',author:sub.name,publishedAt:'2026-10-24',publishedPrecision:'date',url:'https://example.invalid/work/'+index,thumbnailUrl:'',code:'',restricted:false,partial:false},new Date(Date.UTC(2026,9,24,0,0,index)).toISOString());
	store.close();`;
	execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', seed, profile], { cwd: root, stdio: 'pipe' });
	app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`], cwd: profile, env });
	await app.evaluate(({ session }) => { globalThis.__requests = []; session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { globalThis.__requests.push(details.url); callback({ cancel: true }); }); });
	const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	await mkdir(output, { recursive: true });
	const nav = page.getByRole('navigation', { name: '主导航', exact: true });
	const state = () => page.evaluate(() => window.nectisse.subscriptions.getState());
	const initial = await state();
	const actor = initial.subscriptions.find(sub => sub.ref === 'nectisse-actor-fixture');
	const entries = initial.entries.filter(entry => entry.subscriptionId === actor.id);
	assert.equal(entries.length, 45);
	await nav.getByRole('button', { name: '演员与创作者', exact: true }).click();
	const openActor = async name => { await page.locator('.subscription-name').filter({ hasText: name }).click(); await page.getByRole('heading', { name: '演员主页', exact: true }).waitFor(); };
	await openActor('三宫 椿');
	const pager = page.getByRole('navigation', { name: '已收录内容分页', exact: true });
	const ids = () => page.locator('.collected-entries .real-feed-entry').evaluateAll(items => items.map(item => item.dataset.postId));
	const verify = async (number, expected) => {
		await pager.getByRole('button', { name: `第 ${number} 页`, exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
		assert.deepEqual(await ids(), expected);
		assert.equal(await pager.getByRole('button', { name: '上一页', exact: true }).isDisabled(), number === 1);
		const bounds = await page.evaluate(() => ({ rootY: scrollY, height: document.scrollingElement.scrollHeight, viewport: innerHeight, contentWidth: document.querySelector('.page-scroll').scrollWidth, available: document.querySelector('.page-scroll').clientWidth }));
		assert.ok(bounds.rootY === 0 && bounds.height <= bounds.viewport + 1 && bounds.contentWidth <= bounds.available + 1, JSON.stringify(bounds));
		reports.push({ number, count: expected.length, range: await page.locator('.collected-pagination > p').innerText() });
	};
	const seen = [];
	for (let number = 1; number <= 3; number++) {
		await verify(number, entries.slice((number - 1) * 20, number * 20).map(entry => entry.id)); seen.push(...await ids());
		assert.equal(await pager.getByRole('button', { name: '下一页', exact: true }).isDisabled(), number === 3);
		if (number < 3) { await pager.getByRole('button', { name: '下一页', exact: true }).click(); await page.waitForFunction(() => document.activeElement?.id === 'collected-entry-heading'); }
	}
	assert.deepEqual(seen, entries.map(entry => entry.id));
	await page.locator('.collected-entries .feed-item-title').first().click(); await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
	await verify(3, entries.slice(40).map(entry => entry.id));
	assert.equal((await state()).entries.filter(entry => entry.read).length, 1);
	await pager.getByRole('button', { name: '第 1 页', exact: true }).click();
	await verify(1, entries.slice(0, 20).map(entry => entry.id));
	await page.getByRole('button', { name: '返回关注列表', exact: true }).click(); await openActor('另一位演员');
	const other = initial.subscriptions.find(sub => sub.ref === 'second-actor');
	await verify(1, initial.entries.filter(entry => entry.subscriptionId === other.id).slice(0, 20).map(entry => entry.id));
	await pager.getByRole('button', { name: '下一页', exact: true }).click(); assert.equal(await ids().then(items => items.length), 1);
	await page.getByRole('button', { name: '返回关注列表', exact: true }).click(); await openActor('无作品演员');
	await page.getByRole('heading', { name: '还没有可显示的内容', exact: true }).waitFor(); assert.equal(await pager.count(), 0);
	await page.getByRole('button', { name: '返回关注列表', exact: true }).click();
	await page.getByRole('tab', { name: '创作者动态', exact: true }).click(); await page.locator('.subscription-name').filter({ hasText: '白石 澪' }).click();
	assert.equal(await page.locator('.real-feed-entry').count(), 3); assert.equal(await pager.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
	await nav.getByRole('button', { name: '资料查询', exact: true }).click(); await nav.getByRole('button', { name: '演员与创作者', exact: true }).click(); await openActor('三宫 椿');
	for (const width of [1000, 1600]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 840), width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate(async theme => { const state = await window.nectisse.subscriptions.getState(); await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, theme } }); }, theme);
			await pager.getByRole('button', { name: '第 3 页', exact: true }).click(); await verify(3, entries.slice(40).map(entry => entry.id));
			await pager.scrollIntoViewIfNeeded(); await page.mouse.move(10, 10);
			assert.ok((await pager.locator('[data-slot="button"]').evaluateAll(items => items.map(item => item.getBoundingClientRect().height))).every(height => height === 32));
			await page.screenshot({ path: join(output, `${width}-${theme}.png`) });
		}
	}
	assert.equal((await app.evaluate(() => globalThis.__requests)).length, 0); assert.deepEqual(errors, []);
	console.log(JSON.stringify({ checks: ['45-actor-entries-in-three-pages', 'no-duplicates-or-cross-actor-entries', '20-20-5-page-sizes', 'page-boundaries', 'dialog-and-read-preserve-page', 'switch-actor-resets-page', 'empty-and-creator-single-page', '32px-controls-both-themes-1000-and-1600', 'fixed-shell', 'zero-site-requests'], reports, screenshots: output }, null, 2));
} finally {
	await mkdir(output, { recursive: true }); await writeFile(join(output, 'verification.json'), JSON.stringify({ reports, errors }, null, 2));
	await app?.close().catch(() => {}); await rm(profile, { recursive: true, force: true });
}

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
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-'));
const output = join(root, '.test-output', appPath ? 'packaged-pagination' : 'development-pagination');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
env.PATH = '/usr/bin:/bin';
let app;
const reports = [];
const errors = [];
try {
	execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), profile], { cwd: root, stdio: 'pipe' });
	const seed = `import { SubscriptionStore } from './src/main/features/subscriptions/subscription-store.ts';
	const store = new SubscriptionStore(process.argv[1], {available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});
	const sub = store.subscriptions().find(sub=>sub.provider==='fanbox');
	for(let index=0;index<213;index++) store.upsertEntry(sub,{externalId:'pagination-'+index,title:'本地更新分页样本 '+(index+1),summary:'分页检查使用的本地条目，不连接原站。',author:sub.name,publishedAt:'2026-10-24',publishedPrecision:'date',url:'https://example.invalid/pagination/'+index,thumbnailUrl:'',code:'',restricted:false,partial:false},new Date(Date.UTC(2026,9,24,0,0,index)).toISOString());
	store.close();`;
	execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', seed, profile], { cwd: root, stdio: 'pipe' });
	app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`], cwd: profile, env });
	await app.evaluate(({ session }) => { globalThis.__requests = []; session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { globalThis.__requests.push(details.url); callback({ cancel: true }); }); });
	const page = await app.firstWindow();
	page.on('pageerror', error => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	await mkdir(output, { recursive: true });
	const nav = page.getByRole('navigation', { name: '主导航', exact: true });
	const state = () => page.evaluate(() => window.nectisse.subscriptions.getState());
	const ids = () => page.locator('.real-feed-entry').evaluateAll(items => items.map(item => item.dataset.postId));
	const pagination = page.getByRole('navigation', { name: '更新分页', exact: true });
	const assertPage = async (number, expected) => {
		await pagination.getByRole('button', { name: `第 ${number} 页`, exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
		assert.deepEqual(await ids(), expected);
		const bounds = await page.evaluate(() => ({ windowY: scrollY, height: document.scrollingElement.scrollHeight, viewport: innerHeight, overflow: document.querySelector('.page-scroll').scrollWidth > document.querySelector('.page-scroll').clientWidth + 1 }));
		assert.ok(bounds.windowY === 0 && bounds.height <= bounds.viewport + 1 && !bounds.overflow, JSON.stringify(bounds));
		reports.push({ page: number, count: expected.length, range: await page.locator('.updates-pagination > p').innerText() });
	};
	await nav.getByRole('button', { name: '演员与创作者', exact: true }).click();
	assert.equal(await page.locator('#page-heading').innerText(), '演员与创作者');
	const tabs = page.getByRole('tablist', { name: '订阅类型', exact: true });
	assert.deepEqual(await tabs.getByRole('tab').allTextContents(), ['演员新作', '创作者动态']);
	assert.equal(await tabs.getByRole('tab', { name: '演员新作', exact: true }).getAttribute('aria-selected'), 'true');
	await page.locator('.page-heading-actions').getByRole('button', { name: '添加关注', exact: true }).click();
	assert.match(await page.getByRole('combobox', { name: '关注来源', exact: true }).innerText(), /JavDB/);
	await page.getByRole('button', { name: '关闭添加关注', exact: true }).click();
	await tabs.getByRole('tab', { name: '创作者动态', exact: true }).click();
	await page.locator('.page-heading-actions').getByRole('button', { name: '添加关注', exact: true }).click();
	assert.equal(await page.getByRole('combobox', { name: '关注来源', exact: true }).innerText(), 'FANBOX');
	await page.getByRole('button', { name: '关闭添加关注', exact: true }).click();
	await nav.getByRole('button', { name: '更新', exact: true }).click();
	await page.getByRole('tab', { name: '全部', exact: true }).click();
	const all = (await state()).entries;
	assert.equal(all.length, 217);
	const seen = [];
	for (let number = 1; number <= 11; number++) {
		await assertPage(number, all.slice((number - 1) * 20, number * 20).map(entry => entry.id));
		seen.push(...await ids());
		assert.equal(await pagination.getByRole('button', { name: '上一页', exact: true }).isDisabled(), number === 1);
		assert.equal(await pagination.getByRole('button', { name: '下一页', exact: true }).isDisabled(), number === 11);
		if ([1, 6, 11].includes(number)) { await pagination.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, `page-${number}.png`) }); }
		if (number < 11) {
			await pagination.getByRole('button', { name: '下一页', exact: true }).click();
			await page.waitForFunction(() => document.querySelector('.page-scroll').scrollTop === 0 && document.activeElement?.id === 'page-heading');
		}
	}
	assert.deepEqual(seen, all.map(entry => entry.id));
	await pagination.getByRole('button', { name: '第 1 页', exact: true }).click();
	await pagination.getByRole('button', { name: '下一页', exact: true }).click();
	const readIds = await ids();
	await page.getByRole('button', { name: '本页全部已读', exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll('.real-feed-entry[data-read="true"]').length === 20);
	assert.deepEqual((await state()).entries.filter(entry => entry.read).map(entry => entry.id), readIds);
	await page.getByRole('tab', { name: '未读', exact: true }).click();
	const unread = all.filter(entry => !readIds.includes(entry.id));
	await assertPage(1, unread.slice(0, 20).map(entry => entry.id));
	await pagination.getByRole('button', { name: '第 10 页', exact: true }).click();
	await assertPage(10, unread.slice(180).map(entry => entry.id));
	const detailTitle = await page.locator('.real-feed-entry .feed-item-title').first().getAttribute('aria-label');
	await page.locator('.real-feed-entry .feed-item-title').first().click();
	await page.getByRole('dialog').waitFor();
	await page.getByRole('dialog').getByRole('heading', { name: detailTitle, exact: true }).waitFor();
	await page.waitForFunction(() => document.querySelectorAll('.real-feed-entry').length === 16);
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: '本页全部已读', exact: true }).click();
	const remaining = unread.slice(0, 180);
	await assertPage(9, remaining.slice(160).map(entry => entry.id));
	// Changing the source/category resets to page 1. A read-only actor filter is empty.
	await chooseOption(page, '更新类型', '演员新作');
	await page.getByRole('heading', { name: '还没有可显示的内容', exact: true }).waitFor();
	assert.equal(await pagination.count(), 0);
	await page.getByRole('tab', { name: '全部', exact: true }).click();
	await assertPage(1, all.filter(entry => entry.provider === 'javdb').map(entry => entry.id));
	assert.equal(await pagination.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true);
	assert.equal(await pagination.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
	await chooseOption(page, '更新类型', '所有类型');
	await assertPage(1, all.slice(0, 20).map(entry => entry.id));
	for (const width of [1000, 1600]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 840), width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate(async theme => { const state = await window.nectisse.subscriptions.getState(); await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, theme } }); }, theme);
			// Exercise numbered navigation in the middle, including both ellipses.
			await pagination.getByRole('button', { name: '第 1 页', exact: true }).click();
			for (let index = 0; index < 5; index++) await pagination.getByRole('button', { name: '下一页', exact: true }).click();
			await assertPage(6, all.slice(100, 120).map(entry => entry.id));
			await pagination.scrollIntoViewIfNeeded();
			const controls = await pagination.locator('[data-slot="button"]').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
			assert.ok(controls.every(height => height === 32));
			await page.screenshot({ path: join(output, `${width}-${theme}.png`) });
		}
	}
	const beforeReload = (await state()).entries.filter(entry => entry.read).map(entry => entry.id);
	assert.equal(beforeReload.length, 37);
	await page.reload();
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	assert.deepEqual((await state()).entries.filter(entry => entry.read).map(entry => entry.id), beforeReload);
	assert.equal((await app.evaluate(() => globalThis.__requests)).length, 0);
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ checks: ['actor-first-labels-and-add-source', '217-entries-11-pages-no-duplicates', '20-per-page-17-on-last', 'previous-next-numbered-navigation', 'filter-resets-page', 'bulk-read-only-current-page', 'last-page-read-clamps-page', 'unread-dialog-survives-list-change', 'empty-and-single-page', 'read-state-persists', '32px-controls-both-themes-1000-and-1600', 'no-window-overflow', 'zero-network-requests'], reports, screenshots: output }, null, 2));
} finally {
	await mkdir(output, { recursive: true });
	await writeFile(join(output, 'verification.json'), JSON.stringify({ reports, errors }, null, 2));
	await app?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}

import { openPeople, openUpdates } from './people.mjs';
import assert from 'node:assert/strict';
import { selectQueryRecord } from './query.mjs';
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
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-follow-'));
const output = join(root, '.test-output', appPath ? 'packaged-follow-dialog' : 'development-follow-dialog');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])); env.PATH = '/usr/bin:/bin';
let app;
const errors = [], layouts = [];
try {
	await mkdir(output, { recursive: true });
	execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), profile], { cwd: root, stdio: 'pipe' });
	app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`], cwd: profile, env });
	await app.evaluate(({ session }) => { globalThis.__requests = []; session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { globalThis.__requests.push(details.url); callback({ cancel: true }); }); });
	const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	// Stub only external lookup/follow outcomes in this isolated process. Keep the real
	// preload bridge, renderer state reader, local preferences, and subscription storage.
	await app.evaluate(({ ipcMain }, profile) => {
		const require = process.getBuiltinModule('module').createRequire(process.execPath);
		const { randomUUID } = require('node:crypto'); const { DatabaseSync } = require('node:sqlite'); const { join } = require('node:path');
		const getChannel = 'nectisse:subscriptions-get', commandChannel = 'nectisse:subscriptions-command';
		const get = ipcMain._invokeHandlers.get(getChannel), command = ipcMain._invokeHandlers.get(commandChannel);
		const data = globalThis.__followDialogTest = { mode: 'success', failFollow: false, revision: 100, tasks: [], cancelled: [], confirmed: [], queries: [], timers: [], db: new DatabaseSync(join(profile, 'nectisse.sqlite')) };
		const snapshot = async event => { const state = await get(event); data.revision = Math.max(state.revision, data.revision) + 1; return { ...state, revision: data.revision, tasks: [...data.tasks, ...state.tasks].slice(0, 20) }; };
		const publish = async event => { if (!event.sender.isDestroyed()) event.sender.send('nectisse:subscriptions-state', await snapshot(event)); };
		ipcMain.removeHandler(getChannel); ipcMain.handle(getChannel, snapshot);
		ipcMain.removeHandler(commandChannel); ipcMain.handle(commandChannel, async (event, value) => {
			if (value.action === 'lookup') {
				data.queries.push({ provider: value.provider, query: value.query });
				if (data.mode === 'start-failure') return { ok: false, message: '查询未开始（隔离验证）' };
				const state = await get(event), known = state.subscriptions.find(sub => sub.provider === value.provider);
				const mode = data.mode, now = new Date().toISOString();
				const candidates = Array.from({ length: 8 }, (_, index) => index === 0 && known ? { provider: known.provider, ref: known.ref, name: known.name, url: known.url, aliases: known.aliases, recordType: known.recordType, bio: known.bio, evidence: '本地候选' } : { provider: value.provider, ref: value.provider === 'javtao' ? `actor-${index}` : `Actor${index}`, name: index === 2 ? '長い名前／超长别名（布局检查）'.repeat(10) : `候选人物 ${index}`, url: value.provider === 'javtao' ? `https://javtao.com/actress/actor-${index}` : `https://example.invalid/${value.provider}/Actor${index}`, aliases: ['别名一', 'Another identity name'], recordType: ['javdb', 'javtao'].includes(value.provider) ? '演员记录' : '创作者主页', bio: index === 2 ? '用于检查多行文字的简介。'.repeat(20) : '', evidence: '本地候选' });
				const task = { id: randomUUID(), kind: 'lookup', provider: value.provider, status: 'running', phase: '正在查询身份（隔离验证）', startedAt: now, finishedAt: '', requests: 0, candidates: [], added: 0, reason: '', cancelRequestedAt: '' };
				data.tasks.unshift(task); await publish(event);
				if (mode !== 'slow' && mode !== 'late') data.timers.push(setTimeout(async () => { task.status = mode === 'failure' ? 'failed' : 'succeeded'; task.phase = mode === 'failure' ? '来源暂未响应（隔离验证）' : '已取得候选'; task.finishedAt = new Date().toISOString(); task.candidates = ['failure', 'empty'].includes(mode) ? [] : candidates; await publish(event); }, 60));
				if (mode === 'late') await new Promise(resolve => data.timers.push(setTimeout(resolve, 500)));
				return { ok: true, id: task.id };
			}
			if (value.action === 'cancel' && data.tasks.some(task => task.id === value.id)) { data.cancelled.push(value.id); const task = data.tasks.find(task => task.id === value.id); task.status = 'cancelled'; task.cancelRequestedAt = new Date().toISOString(); task.finishedAt = task.cancelRequestedAt; await publish(event); return { ok: true }; }
			if (value.action === 'follow' && data.tasks.some(task => task.id === value.taskId)) {
				if (data.failFollow) return { ok: false, message: '关注未保存（隔离验证）' };
				const candidate = data.tasks.find(task => task.id === value.taskId).candidates.find(candidate => candidate.ref === value.ref);
				const sub = { ...candidate, id: randomUUID(), kind: ['javdb', 'javtao'].includes(candidate.provider) ? 'performer_releases' : 'creator_posts', following: true, enabled: true, autoPaused: false, intervalMinutes: null, createdAt: new Date().toISOString(), initialized: true, lastCheckedAt: '', nextCheckAt: '', lastError: '', coverage: '本地确认验证', failureCount: 0, unread: 0 };
				data.db.prepare('INSERT INTO subscriptions VALUES(?,?,?,?)').run(sub.id, sub.provider, sub.ref, JSON.stringify(sub));
				if (sub.provider === 'javtao') {
					const previous = JSON.parse(data.db.prepare("SELECT value FROM entries WHERE json_extract(value,'$.provider')='javdb' LIMIT 1").get().value);
					const entry = { ...previous, id: randomUUID(), subscriptionId: sub.id, provider: sub.provider, name: sub.name, author: sub.name, externalId: '/nect-025', code: 'NECT-025', title: 'NECT-025 JavTao 隔离查询样本', summary: '', url: 'https://javtao.com/nect-025', read: false, firstSeenAt: sub.createdAt };
					data.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?)').run(entry.id, sub.id, entry.externalId, JSON.stringify(entry), entry.firstSeenAt);
				}
				data.confirmed.push(sub.id); await publish(event); return { ok: true, id: sub.id };
			}
			const reply = await command(event, value); await publish(event); return reply;
		});
	}, profile);
	const nav = page.getByRole('navigation', { name: '主导航', exact: true });
	const dialog = page.getByRole('dialog', { name: '添加关注', exact: true });
	const input = page.getByRole('textbox', { name: '主页、账号或演员名', exact: true });
	const mode = value => app.evaluate((_electron, value) => { globalThis.__followDialogTest.mode = value; }, value);
	const open = async () => { if (await page.locator('.person-profile').count()) { await page.getByRole('button', { name: '返回关注列表', exact: true }).click(); } await page.locator('main').getByRole('button', { name: '添加关注', exact: true }).click(); await dialog.waitFor(); await page.waitForFunction(() => document.activeElement?.id === 'follow-query'); };
	const lookup = async (text = '布局样本') => { await input.fill(text); await dialog.getByRole('button', { name: '查询身份', exact: true }).click(); };
	const close = async () => { await dialog.getByRole('button', { name: '关闭添加关注', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); };
	await openPeople(page, 'actors', 'manage');
	assert.equal(await page.locator('.sidebar').getByRole('button', { name: '添加关注', exact: true }).count(), 0);
	assert.equal(await page.locator('.sidebar').getByText('关闭窗口后仍在后台运行', { exact: true }).count(), 0);
	const origin = await page.locator('.subscription-cards').boundingBox();
	await open(); assert.equal(await page.locator('main .add-subscription').count(), 0);
	await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
	assert.equal(await page.locator('.page-heading-actions').getByRole('button', { name: '添加关注', exact: true }).evaluate(button => document.activeElement === button), true);
	assert.deepEqual(await page.locator('.subscription-cards').boundingBox(), origin);
	await open(); await lookup(); await dialog.locator('.follow-dialog-candidate').nth(7).waitFor();
	assert.equal(await dialog.getByRole('button', { name: '已关注', exact: true }).count(), 1);
	assert.equal(await dialog.getByRole('button', { name: '已关注', exact: true }).isDisabled(), true);
	assert.equal(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).subscriptions.length), 2, 'Lookup must not follow automatically');
	for (const width of [1000, 1600]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 840), width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate(async theme => { const state = await window.nectisse.subscriptions.getState(); await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, theme } }); }, theme);
			const layout = await dialog.evaluate(element => { const rect = element.getBoundingClientRect(), body = element.querySelector('.follow-dialog-scroll'), footer = element.querySelector('.follow-dialog-footer').getBoundingClientRect(), controls = [...element.querySelectorAll('.follow-dialog-form input[data-slot="input"], .follow-dialog-form [data-slot="select-trigger"], .follow-dialog-form > button')].map(node => node.getBoundingClientRect()); return { rect: { x: rect.x, y: rect.y, width: rect.width, bottom: rect.bottom }, footer: footer.bottom, overflow: element.scrollWidth - element.clientWidth, bodyScrolls: body.scrollHeight > body.clientHeight, windowY: scrollY, heights: controls.map(rect => rect.height), bottoms: controls.map(rect => rect.bottom), viewport: innerHeight }; });
			assert.ok(layout.rect.y >= 30 && layout.rect.bottom <= layout.viewport - 30 && layout.footer <= layout.viewport - 30, JSON.stringify(layout));
			assert.ok(layout.overflow <= 1 && layout.windowY === 0 && layout.bodyScrolls);
			assert.ok(layout.heights.every(height => height === 36) && layout.bottoms.every(bottom => Math.abs(bottom - layout.bottoms[0]) <= 1), JSON.stringify(layout));
			layouts.push({ width, theme, ...layout }); await page.screenshot({ path: join(output, `${width}-${theme}.png`) });
		}
	}
	await app.evaluate(() => { globalThis.__followDialogTest.failFollow = true; });
	await dialog.locator('[data-follow-ref="Actor1"]').getByRole('button', { name: '确认关注', exact: true }).click();
	await page.locator('[data-sonner-toast]').filter({ hasText: '关注未保存（隔离验证）' }).waitFor(); assert.equal(await dialog.count(), 1);
	await app.evaluate(() => { globalThis.__followDialogTest.failFollow = false; });
	await dialog.locator('[data-follow-ref="Actor1"]').getByRole('button', { name: '确认关注', exact: true }).click();
	await dialog.waitFor({ state: 'hidden' }); await page.locator('.person-profile[data-kind="actors"]').waitFor();
	assert.equal(await page.locator('#page-heading').innerText(), '候选人物 1');
	assert.equal(await app.evaluate(() => globalThis.__followDialogTest.confirmed.length), 1);
	await open(); await mode('slow'); await lookup('慢查询'); await dialog.getByText('正在查询身份', { exact: true }).waitFor(); await close();
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).tasks.some(task => task.kind === 'lookup' && task.status === 'cancelled'));
	const cancelled = await app.evaluate(() => globalThis.__followDialogTest.cancelled.length);
	await mode('late'); await open(); await lookup('迟到响应'); await close();
	await page.waitForFunction(async expected => (await window.nectisse.subscriptions.getState()).tasks.filter(task => task.status === 'cancelled').length >= expected, cancelled + 1);
	assert.equal(await dialog.count(), 0);
	await mode('empty'); await open(); await lookup('无结果'); await dialog.getByRole('heading', { name: '没有找到匹配身份', exact: true }).waitFor();
	await input.fill('修改查询'); assert.equal(await dialog.locator('.follow-dialog-candidate').count(), 0); await close();
	await mode('failure'); await open(); await lookup('失败查询'); await dialog.getByText('来源暂未响应（隔离验证）', { exact: true }).waitFor(); await close();
	await mode('start-failure'); await open(); await lookup('未开始'); await page.locator('[data-sonner-toast]').filter({ hasText: '查询未开始（隔离验证）' }).waitFor(); await close();
	// A source-settings entry stays on Settings until confirmation. An actor chip stays on the work.
	await page.getByRole('button', { name: '设置', exact: true }).click();
	await page.getByRole('switch', { name: '启用 FANBOX', exact: true }).waitFor();
	await page.getByRole('button', { name: '配置 FANBOX', exact: true }).click();
	await page.getByRole('button', { name: '查询并添加关注', exact: true }).click(); await dialog.waitFor();
	assert.equal(await page.locator('#page-heading').innerText(), '设置'); assert.equal(await page.getByRole('combobox', { name: '关注来源', exact: true }).innerText(), 'FANBOX');
	await mode('success'); await lookup('FANBOX 创作者'); await dialog.locator('.follow-dialog-candidate').nth(7).waitFor();
	assert.equal(await page.locator('#page-heading').innerText(), '设置');
	await dialog.locator('[data-follow-ref="Actor1"]').getByRole('button', { name: '确认关注', exact: true }).click();
	await dialog.waitFor({ state: 'hidden' }); await page.locator('.real-creator-page').getByRole('heading', { name: '候选人物 1', exact: true }).waitFor();
	await open(); await chooseOption(page, '关注来源', 'Coomer');
	assert.equal(await dialog.getByRole('button', { name: '查询身份', exact: true }).isDisabled(), true);
	await dialog.getByRole('button', { name: '来源设置', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
	assert.equal(await page.locator('#page-heading').innerText(), '设置');
	await nav.getByRole('button', { name: '资料查询', exact: true }).click(); await selectQueryRecord(page, 'NECT-024'); await page.getByRole('button', { name: '查看真实作品 NECT-024', exact: true }).click();
	await page.getByRole('button', { name: /订阅.*新作/ }).click(); await dialog.waitFor();
	assert.equal(await page.locator('#page-heading').innerText(), '作品详情'); assert.match(await input.inputValue(), /白石/); await close();
	await page.evaluate(() => window.nectisse.subscriptions.command({ action: 'source-enabled', source: 'javtao', enabled: true }));
	await openPeople(page, 'actors', 'manage');
	await open(); await chooseOption(page, '关注来源', 'JavTao 演员');
	assert.equal(await input.getAttribute('placeholder'), '输入演员名或 JavTao 演员主页');
	await lookup('演员甲'); await dialog.locator('[data-follow-ref="actor-1"]').waitFor();
	await dialog.locator('[data-follow-ref="actor-1"]').getByRole('button', { name: '确认关注', exact: true }).click();
	await dialog.waitFor({ state: 'hidden' }); await page.locator('.person-profile[data-kind="actors"]').waitFor();
	await page.getByRole('button', { name: '返回关注列表', exact: true }).click();
	await openPeople(page, 'actors', 'manage');
	await page.locator('.subscription-card').filter({ hasText: 'JavTao' }).getByRole('combobox', { name: '候选人物 1 检查频率', exact: true }).click();
	await page.getByRole('option').first().waitFor();
	assert.deepEqual(await page.getByRole('option').allTextContents(), ['使用默认频率', '每 6 小时', '每 12 小时', '每 1 天', '每 7 天']);
	await page.keyboard.press('Escape');
	await page.reload(); await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	const persisted = await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).subscriptions);
	assert.equal(persisted.length, 5);
	assert.equal(persisted.find(sub => sub.provider === 'javtao').kind, 'performer_releases');
	assert.equal((await page.locator('.sidebar-author small').allTextContents()).filter(text => text === '演员新作').length, 3);
	await openPeople(page, 'actors');
	assert.equal(await page.locator('.real-feed-entry').count(), 0);
	await openPeople(page, 'actors', 'manage');
	await page.locator('.subscription-card').filter({ hasText: 'JavTao' }).locator('.subscription-name').click();
	const javtaoEntry = page.locator('.real-feed-entry').filter({ hasText: 'JavTao 隔离查询样本' });
	await javtaoEntry.waitFor();
	assert.equal(await page.locator('.real-feed-entry').count(), 1);
	await openUpdates(page, 'creators');
	await page.waitForFunction(() => document.querySelectorAll('.real-feed-entry').length === 3);
	assert.equal(await javtaoEntry.count(), 0);
	await openPeople(page, 'actors', 'manage');
	await page.locator('.subscription-card').filter({ hasText: 'JavTao' }).locator('.subscription-name').click();
	await javtaoEntry.waitFor();
	assert.equal(await page.locator('.real-feed-entry').count(), 1);
	assert.deepEqual(errors, []); assert.deepEqual(await app.evaluate(() => globalThis.__requests), []);
	console.log(JSON.stringify({ checks: ['no-sidebar-add-or-quit-note', 'no-inline-form-or-background-layout-shift', 'dialog-initial-focus-escape-return', 'query-and-confirm-contained-in-modal', 'lookup-does-not-follow', 'known-identity-disabled', 'long-names-eight-candidates-scroll-in-dialog', 'both-themes-two-sizes-36px-form-controls', 'follow-failure-keeps-modal', 'success-opens-profile-and-persists', 'close-cancels-query-and-late-reply', 'empty-and-failure-states', 'settings-and-work-origin-preserved', 'zero-site-requests'], layouts, screenshots: output }, null, 2));
} finally {
	await mkdir(output, { recursive: true }); await writeFile(join(output, 'verification.json'), JSON.stringify({ layouts, errors }, null, 2));
	await app?.evaluate(() => { globalThis.__followDialogTest?.timers.forEach(clearTimeout); globalThis.__followDialogTest?.db.close(); }).catch(() => {});
	await app?.close().catch(() => {}); await rm(profile, { recursive: true, force: true });
}

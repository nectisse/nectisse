import { openPeople } from './people.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { chooseOption } from './select.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-creator-'));
const output = join(root, '.test-output', 'development-creator-profile');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
env.PATH = '/usr/bin:/bin';
let app;
const errors = [];
const layouts = [];

try {
	await mkdir(output, { recursive: true });
	execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/seed-workspace-fixtures.ts'), profile], { cwd: root, stdio: 'pipe' });
	const seed = String.raw`import { SubscriptionStore } from './src/main/features/subscriptions/subscription-store.ts';
	const store = new SubscriptionStore(process.argv[1], {available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});
	store.savePreferences({...store.preferences(), automatic:false, enabledSources:['fanbox','x']});
	const asset = store.entries().find(entry=>entry.provider==='fanbox' && entry.externalId==='1').imageAsset;
	const sub = store.follow({provider:'x',ref:'1722511982610538496',handle:'_yu_8_8',name:'X 创作者（本地样本）',url:'https://x.com/_yu_8_8',aliases:[],recordType:'公开账号',bio:'记录创作与日常。\n仅使用隔离的本地样本检查个人主页，不访问 X。',evidence:'本地测试',avatarUrl:'https://pbs.twimg.com/profile_images/fixture.png',avatarAsset:asset});
	sub.initialized=true;sub.lastCheckedAt='2026-10-24T08:00:00.000Z';sub.coverage='公开账号本人原创帖，不收录回复、引用与转发';store.saveSubscription(sub);
	for(let index=0;index<23;index++) {
	store.upsertEntry(sub,{externalId:String(1900000000000000000n+BigInt(index)),title:'今天的创作手记。',summary:'今天的创作手记。\n保留换行与正文摘要，文字动态不占用空白图片区域。',author:sub.name,authorRef:sub.ref,authorHandle:sub.handle,postKind:'original',publishedAt:'2026-10-24T08:00:00.000Z',publishedPrecision:'exact',url:'https://x.com/_yu_8_8/status/'+(1900000000000000000n+BigInt(index)),thumbnailUrl:index===22?'https://pbs.twimg.com/media/fixture.png':'',code:'',restricted:false,partial:false},new Date(Date.UTC(2026,9,24,0,0,index)).toISOString());
	if(index===22)store.saveImage(store.entries(sub.id).find(entry=>entry.externalId===String(1900000000000000000n+BigInt(index))),asset);
	}
	store.follow({provider:'fanbox',ref:'emptycreator',name:'还没有动态的创作者',url:'https://emptycreator.fanbox.cc',aliases:[],recordType:'创作者',bio:'',evidence:'本地测试'});
	store.close();`;
	execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', seed, profile], { cwd: root, stdio: 'pipe' });
	app = await _electron.launch({ executablePath: electron, args: [root, `--user-data-dir=${profile}`], cwd: profile, env });
	await app.evaluate(({ ipcMain, session, shell }) => {
		globalThis.__creatorProfileTest = { requests: [], opened: [], checks: [], retries: [] };
		session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
			globalThis.__creatorProfileTest.requests.push(details.url);
			callback({ cancel: true });
		});
		shell.openExternal = async (url) => {
			globalThis.__creatorProfileTest.opened.push(url);
		};
		const channel = 'nectisse:subscriptions-command';
		const command = ipcMain._invokeHandlers.get(channel);
		ipcMain.removeHandler(channel);
		ipcMain.handle(channel, async (event, value) => {
			if (value.action === 'check') {
				globalThis.__creatorProfileTest.checks.push(value.id);
				return { ok: true };
			}
			if (value.action === 'retry-images') {
				globalThis.__creatorProfileTest.retries.push(value.subscriptionId);
				return { ok: true };
			}
			return command(event, value);
		});
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(10_000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	const nav = page.getByRole('navigation', { name: '主导航', exact: true });
	const state = () => page.evaluate(() => window.nectisse.subscriptions.getState());
	const initial = await state();
	const creator = initial.subscriptions.find((sub) => sub.provider === 'x');
	const expected = initial.entries.filter((entry) => entry.subscriptionId === creator.id);
	const openCreator = async (name) => {
		await openPeople(page, 'creators', 'manage');
		await page.locator('.subscription-name').filter({ hasText: name }).click();
		await page.locator('.real-creator-page').waitFor();
	};
	await openPeople(page, 'actors', 'manage');
	await page.locator('.subscription-name').filter({ hasText: '三宫 椿' }).click();
	await page.locator('.person-profile[data-kind="actors"]').waitFor();
	assert.equal(await page.locator('.real-feed-list').getAttribute('data-presentation'), 'list');
	await page.getByRole('button', { name: '返回关注列表', exact: true }).click();
	await openCreator(creator.name);
	await page.getByRole('heading', { name: creator.name, exact: true }).waitFor();
	try {
		await page.waitForFunction(
			() =>
				document.querySelectorAll('.creator-profile-avatar img').length === 1 &&
				[...document.querySelectorAll('.creator-profile-avatar img')].every((image) => image.complete && image.naturalWidth > 0),
		);
	} catch (error) {
		await page.screenshot({ path: join(output, 'failed-images.png') });
		console.log(
			await page.evaluate(async () => ({
				images: [...document.querySelectorAll('.real-creator-page img')].map((image) => ({ src: image.src, width: image.naturalWidth })),
				creator: (await window.nectisse.subscriptions.getState()).subscriptions.find((sub) => sub.provider === 'x'),
			})),
		);
		throw error;
	}
	assert.match(await page.locator('.person-account').innerText(), /@_yu_8_8/);
	assert.match(await page.locator('.creator-bio').innerText(), /记录创作与日常。\n/);
	assert.equal(await page.locator('.real-feed-list').getAttribute('data-presentation'), 'cards');
	assert.equal(await page.locator('.real-feed-entry').count(), 20);
	assert.equal(await page.locator('.real-feed-entry .feed-item-thumbnail').count(), 1);
	assert.deepEqual(
		await page.locator('.real-feed-entry').evaluateAll((items) => items.map((item) => item.dataset.postId)),
		expected.slice(0, 20).map((entry) => entry.id),
	);
	const first = page.locator('.real-feed-entry').first();
	assert.equal((await first.innerText()).split('今天的创作手记。').length - 1, 1, 'X cards show the post text only once');
	assert.equal(await page.locator('.real-feed-entry .feed-item-heading').count(), 0, 'X posts have no visible title');
	await first.getByRole('button', { name: '标为已读', exact: true }).click();
	await first.getByRole('button', { name: '标为未读', exact: true }).waitFor();
	assert.equal((await state()).entries.find((entry) => entry.id === expected[0].id).read, true);
	await first.locator('button.feed-item-summary').click();
	const dialog = page.getByRole('dialog', { name: `${creator.name}的动态`, exact: true });
	await dialog.waitFor();
	assert.equal(await dialog.locator('.entry-dialog-title').count(), 0, 'X details have no visible title');
	assert.equal((await dialog.innerText()).split('今天的创作手记。').length - 1, 1, 'X details show the post text only once');
	await page.keyboard.press('Escape');
	await page.waitForFunction(() => document.activeElement?.classList.contains('feed-item-summary'));
	const pager = page.getByRole('navigation', { name: '已收录内容分页', exact: true });
	assert.equal(await pager.count(), 0);
	await page.locator('.creator-load-more').scrollIntoViewIfNeeded();
	await page.waitForFunction(() => document.querySelectorAll('.real-feed-entry').length === 23);
	assert.deepEqual(
		await page.locator('.real-feed-entry').evaluateAll((items) => items.map((item) => item.dataset.postId)),
		expected.map((entry) => entry.id),
	);
	await page.locator('.creator-load-more').getByText('已显示全部 23 条动态', { exact: true }).waitFor();
	await page.locator('.real-feed-entry button.feed-item-summary').nth(20).focus();
	await page.keyboard.press('Enter');
	await dialog.waitFor();
	await page.keyboard.press('Escape');
	assert.equal(await page.locator('.real-feed-entry').count(), 23);
	const coverSnapshot = await state();
	const missing = coverSnapshot.entries.find((entry) => entry.id === expected[1].id);
	missing.thumbnailUrl = 'https://example.invalid/missing-cover.jpg';
	missing.imageCache = { status: 'failed', attempts: 1, nextAttemptAt: 0, reason: 'not_found' };
	coverSnapshot.revision++;
	await app.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send('nectisse:subscriptions-state', snapshot), coverSnapshot);
	const updateToolbar = page.getByRole('region', { name: '更新工具栏', exact: true });
	await updateToolbar.getByRole('button', { name: '重试未缓存封面', exact: true }).click();
	assert.deepEqual(await app.evaluate(() => globalThis.__creatorProfileTest.retries), [creator.id]);
	await page.getByRole('button', { name: '关注设置', exact: true }).click();
	await chooseOption(page, `${creator.name} 检查频率`, '每 3 小时');
	assert.equal((await state()).subscriptions.find((sub) => sub.id === creator.id).intervalMinutes, 180);
	await page.getByRole('button', { name: '暂停', exact: true }).click();
	await page.getByRole('button', { name: '恢复', exact: true }).waitFor();
	assert.equal(await page.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), true);
	await page.getByRole('button', { name: '恢复', exact: true }).click();
	await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
	await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
	await page.getByRole('button', { name: '检查更新', exact: true }).click();
	assert.deepEqual(await app.evaluate(() => globalThis.__creatorProfileTest.checks), [creator.id]);
	await page.getByRole('button', { name: 'X 原主页', exact: true }).click();
	assert.deepEqual(await app.evaluate(() => globalThis.__creatorProfileTest.opened), [creator.url]);
	await page.getByRole('button', { name: '关注设置', exact: true }).click();
	await page.getByRole('button', { name: '取消关注', exact: true }).click();
	await page.getByRole('button', { name: '重新关注', exact: true }).waitFor();
	assert.equal((await state()).subscriptions.find((sub) => sub.id === creator.id).following, false);
	assert.equal(await page.locator('.real-feed-entry').count(), 23);
	await page.getByRole('button', { name: '重新关注', exact: true }).click();
	await page.getByRole('button', { name: '取消关注', exact: true }).waitFor();
	await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
	await page.evaluate(() => window.nectisse.subscriptions.command({ action: 'source-enabled', source: 'x', enabled: false }));
	await page.waitForFunction(() => document.querySelector('.person-updates-toolbar .page-toolbar-actions button').disabled);
	assert.equal(await page.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), true);
	await page.evaluate(() => window.nectisse.subscriptions.command({ action: 'source-enabled', source: 'x', enabled: true }));
	await page.waitForFunction(() => !document.querySelector('.person-updates-toolbar .page-toolbar-actions button').disabled);
	for (const width of [1000, 1280, 1600]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 900), width);
		await page.waitForFunction((width) => innerWidth === width, width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate((theme) => window.nectisse.subscriptions.command({ action: 'preferences-patch', patch: { theme } }), theme);
			await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
			await page.locator('.page-scroll').evaluate((element) => {
				element.scrollTop = 0;
			});
			const layout = await page.evaluate(() => {
				const scroller = document.querySelector('.page-scroll');
				const rect = (selector) => {
					const box = document.querySelector(selector).getBoundingClientRect();
					return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom };
				};
				return {
					width: innerWidth,
					rootScroll: scrollY,
					documentHeight: document.scrollingElement.scrollHeight,
					viewport: innerHeight,
					fits: scroller.scrollWidth <= scroller.clientWidth + 1,
					overview: rect('.person-overview'),
					cover: rect('.person-cover'),
					columns: getComputedStyle(document.querySelector('.real-feed-list')).gridTemplateColumns.split(' ').length,
					items: [...document.querySelectorAll('.real-feed-entry')].slice(0, 4).map((item) => ({ x: item.getBoundingClientRect().x, y: item.getBoundingClientRect().y, width: item.getBoundingClientRect().width, fits: item.scrollWidth <= item.clientWidth + 1 })),
					avatar: rect('.creator-profile-avatar'),
					heading: rect('#page-heading'),
					content: rect('.creator-content'),
					toolbar: rect('.person-updates-toolbar'),
					cards: rect('.collected-entries'),
					controls: [...document.querySelectorAll('.creator-profile-navigation button, .person-updates-toolbar .page-toolbar-actions button')].map(
						(button) => button.getBoundingClientRect().height,
					),
				};
			});
			assert.ok(layout.fits && layout.rootScroll === 0 && layout.documentHeight <= layout.viewport + 1, JSON.stringify(layout));
			assert.ok(layout.avatar.y >= layout.overview.y && layout.avatar.y + layout.avatar.height <= layout.overview.bottom);
			assert.ok(layout.avatar.y < layout.cover.bottom && layout.avatar.y + layout.avatar.height > layout.cover.bottom);
			assert.ok(layout.heading.y > layout.cover.bottom && layout.heading.y < layout.overview.bottom);
			assert.equal(layout.columns, { 1000: 2, 1280: 3, 1600: 4 }[width]);
			assert.ok(layout.items.every((item) => item.fits && item.width >= 300 && item.width < 500));
			assert.ok(layout.items[0].y === layout.items[1].y && layout.items[0].x < layout.items[1].x);
			assert.ok(Math.abs(layout.content.width - layout.cards.width) <= 1 && Math.abs(layout.cards.width - layout.toolbar.width) <= 1);
			assert.ok(layout.controls.every((height) => height === 32));
			layouts.push({ theme, ...layout });
			await page.screenshot({ path: join(output, `${width}-${theme}-x.png`), animations: 'disabled', style: '[data-sonner-toaster] { visibility: hidden; }' });
		}
	}
	assert.equal(await page.getByRole('button', { name: '来源与订阅设置', exact: true }).count(), 0);
	assert.equal(await page.locator('.person-overview').getByText('已关注', { exact: true }).count(), 0);
	await page.getByRole('button', { name: '设置', exact: true }).click();
	await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
	await page.locator('.sidebar-author').filter({ hasText: creator.name }).click();
	await page.locator('.real-creator-page').waitFor();
	await page.getByRole('button', { name: '返回关注列表', exact: true }).click();
	await page.locator('.subscription-name').filter({ hasText: '还没有动态的创作者' }).click();
	await page.getByRole('heading', { name: '还没有可显示的内容', exact: true }).waitFor();
	assert.equal(await page.locator('.person-cover .people-artwork').count(), 1);
	assert.equal(await pager.count(), 0);
	await page.screenshot({ path: join(output, 'empty-creator.png'), animations: 'disabled', style: '[data-sonner-toaster] { visibility: hidden; }' });
	await page.reload();
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
	const restored = (await state()).subscriptions.find((sub) => sub.id === creator.id);
	assert.equal(restored.intervalMinutes, 180);
	assert.equal(restored.following, true);
	assert.equal(restored.enabled, true);
	assert.equal((await state()).entries.filter((entry) => entry.subscriptionId === creator.id && entry.read).length, 2);
	await openCreator('白石 澪');
	assert.equal(await page.locator('.real-feed-entry').count(), 3);
	assert.equal(await page.locator('.real-feed-entry .feed-item-heading').count(), 3, 'Sources with real titles retain their headings');
	assert.match(await page.locator('.creator-bio').innerText(), /较长的简介/);
	await page.screenshot({ path: join(output, 'fanbox-long-name.png'), animations: 'disabled', style: '[data-sonner-toaster] { visibility: hidden; }' });
	assert.deepEqual(await app.evaluate(() => globalThis.__creatorProfileTest.requests), []);
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify(
			{
				checks: [
					'real-creator-profile-from-list-and-sidebar',
					'actor-and-creator-profiles',
					'local-avatar-and-svg-cover-overlap',
					'text-only-cards-without-empty-images',
					'x-text-without-duplicate-title-in-cards-and-dialogs',
					'twenty-then-twenty-three-with-infinite-scroll',
					'read-dialog-and-focus-return',
					'frequency-pause-follow-and-persistence',
					'manual-check-and-original-page',
					'scoped-update-toolbar-and-no-duplicate-settings',
					'empty-creator',
					'two-three-four-column-cards-in-both-themes',
					'zero-site-requests',
				],
				screenshots: output,
			},
			null,
			2,
		),
	);
} finally {
	await writeFile(join(output, 'verification.json'), JSON.stringify({ layouts, errors }, null, 2));
	await app?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}

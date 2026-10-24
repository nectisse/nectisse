import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseOption } from './select.mjs';
import { openPeople } from './people.mjs';

// 同一组正式页面在独立示例数据上下文中运行；真实 bridge 始终保持原样。
export async function reviewVisual(page, application, output) {
	await mkdir(output, { recursive: true });
	const nav = page.getByRole('navigation', { name: '主导航', exact: true });
	const screenshot = (name) => page.screenshot({ path: join(output, name), animations: 'disabled', style: '[data-sonner-toaster] { visibility: hidden; }' });

	const localState = () => page.evaluate(async () => {
		const subscriptions = await window.nectisse.subscriptions.getState();
		const library = await window.nectisse.library.getState();
		return { preferences: subscriptions.preferences, subscriptions: subscriptions.subscriptions, entries: subscriptions.entries, works: library.works };
	});

	const fits = async () => {
		const bounds = await page.locator('.page-scroll').evaluate((element) => ({ fits: element.scrollWidth <= element.clientWidth + 1, rootY: scrollY, height: document.scrollingElement.scrollHeight, viewport: innerHeight }));
		assert.ok(bounds.fits && bounds.rootY === 0 && bounds.height <= bounds.viewport + 1, JSON.stringify(bounds));
	};

	const before = await localState();
	const originalSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	assert.deepEqual(await nav.getByRole('button').allTextContents().then((items) => items.map((item) => item.replace(/\d+|⌘ K/g, '').trim())), ['资料查询', '作品收藏', '演员', '创作者']);
	await page.getByRole('button', { name: '设置', exact: true }).click();
	await page.getByRole('tab', { name: '外观与应用', exact: true }).click();
	await page.getByRole('button', { name: '打开演示', exact: true }).scrollIntoViewIfNeeded();
	const originalScroll = await page.locator('.page-scroll').evaluate((element) => element.scrollTop);
	await page.getByRole('button', { name: '打开演示', exact: true }).click();
	const exit = page.getByRole('button', { name: '返回真实工作区', exact: true });
	await exit.waitFor();
	assert.equal(await exit.evaluate((button) => getComputedStyle(button).webkitAppRegion), 'no-drag');
	assert.equal(await page.locator('.workspace-shell').count(), 1);
	assert.equal(await page.locator('[data-testid="live-query"]').count(), 1);
	await page.waitForFunction(() => document.querySelectorAll('.live-result-grid .live-result-card').length > 0 || document.querySelectorAll('.live-result-grid button').length > 0);
	await screenshot('01-shared-query.png');
	await openPeople(page, 'actors');
	assert.equal(await page.locator('.person-card').count(), 2);
	assert.equal(await page.locator('.real-feed-entry, .updates-toolbar').count(), 0);
	await page.getByRole('button', { name: '查看白石 澪的主页', exact: true }).click();
	await page.locator('.person-profile').getByRole('heading', { name: '白石 澪', exact: true }).waitFor();
	assert.equal(await page.locator('.person-profile').getAttribute('data-kind'), 'actors');
	await page.getByRole('heading', { name: '最近新作', exact: true }).waitFor();
	await page.getByRole('tab', { name: '未读', exact: true }).click();
	assert.equal(await page.locator('.collected-entries .real-feed-entry').count(), 2);
	assert.equal(await page.getByRole('region', { name: '更新工具栏', exact: true }).getByRole('button', { name: '检查更新', exact: true }).count(), 1);
	assert.equal(await page.locator('.creator-aside, .creator-banner').count(), 0);
	await screenshot('02-actor-profile.png');
	await openPeople(page, 'creators');
	assert.equal(await page.locator('.person-card').count(), 3);
	assert.equal(await page.locator('.real-feed-entry, .updates-toolbar').count(), 0);
	assert.equal(await page.getByRole('heading', { name: '最新动态', exact: true }).count(), 0);
	await page.getByRole('textbox', { name: '搜索创作者', exact: true }).fill('灯里');
	await page.getByRole('button', { name: '查看灯里工作室的主页', exact: true }).click();
	await page.getByRole('button', { name: '关注设置', exact: true }).click();
	const settings = page.getByRole('dialog');
	await settings.getByRole('button', { name: '暂停', exact: true }).click();
	await settings.getByRole('button', { name: '恢复', exact: true }).waitFor();
	await chooseOption(page, '灯里工作室 检查频率', '每 3 小时');
	await settings.getByRole('button', { name: '完成', exact: true }).click();
	await page.getByRole('tab', { name: '未读', exact: true }).click();
	assert.equal(await page.locator('.real-feed-entry').count(), 2);
	await page.locator('.real-feed-entry').first().getByRole('button', { name: '标为已读', exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll('.real-feed-entry').length === 1);
	assert.equal(await page.locator('.person-stats [data-unread] dd').innerText(), '1');
	await page.getByRole('button', { name: '返回关注列表', exact: true }).click();
	assert.equal(await page.getByRole('textbox', { name: '搜索创作者', exact: true }).inputValue(), '灯里');
	assert.equal(await page.locator('.person-card-unread').innerText(), '1 条未读');
	await page.getByRole('tab', { name: '管理', exact: true }).click();
	const row = page.locator('.subscription-card').filter({ hasText: '灯里工作室' });
	assert.equal(await row.getByRole('combobox').innerText(), '每 3 小时');
	assert.equal(await row.getByRole('button', { name: '恢复', exact: true }).count(), 1);
	await page.getByRole('textbox', { name: '搜索创作者', exact: true }).fill('');
	await nav.getByRole('button', { name: '资料查询', exact: true }).click();
	await page.getByRole('textbox', { name: '作品编号、标题或原站链接', exact: true }).fill('NECT-018');
	await page.getByRole('button', { name: '查询资料', exact: true }).click();
	await page.getByRole('button', { name: '查看真实作品 NECT-018', exact: true }).click();
	await page.getByRole('button', { name: '收藏作品', exact: true }).click();
	await page.getByRole('button', { name: '已收藏 · 查看', exact: true }).waitFor();
	await nav.getByRole('button', { name: '作品收藏', exact: true }).click();
	assert.equal(await page.locator('.library-work').count(), 2);
	for (const width of [1000, 1280]) {
		await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1000 ? 700 : 840), width);
		for (const theme of ['cream', 'night']) {
			const toggle = page.getByRole('button', { name: theme === 'cream' ? '切换到奶油档案' : '切换到黑莓夜间', exact: true });
			if (await toggle.count()) {
				await toggle.click();
			}
			for (const scope of ['actors', 'creators']) {
				await openPeople(page, scope);
				assert.equal(await page.locator('.real-feed-entry, .updates-toolbar').count(), 0);
				assert.equal(await page.locator('.people-heading .people-artwork').getAttribute('data-scope'), scope);
				await fits();
				await screenshot(`${width}-${theme}-${scope}.png`);
				await page.locator('.person-card').first().click();
				assert.equal(await page.locator('.person-cover .people-artwork').getAttribute('data-scope'), scope);
				await fits();
				if (scope === 'creators') {
					assert.ok(await page.locator('.real-feed-list').evaluate((list) => getComputedStyle(list).gridTemplateColumns.split(' ').length >= 2));
				}
				await screenshot(`${width}-${theme}-${scope}-profile.png`);
			}
		}
	}
	assert.deepEqual(await localState(), before);
	await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), originalSize);
	await exit.click();
	await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
	assert.equal(await page.getByRole('tab', { name: '外观与应用', exact: true }).getAttribute('aria-selected'), 'true');
	await page.waitForFunction(() => document.activeElement?.id === 'open-visual-demo');
	assert.ok(Math.abs(await page.locator('.page-scroll').evaluate((element) => element.scrollTop) - originalScroll) <= 2, '退出示例数据恢复真实页面的滚动位置');
	assert.deepEqual(await localState(), before);
	await page.getByRole('button', { name: '打开演示', exact: true }).click();
	await exit.waitFor();
	await openPeople(page, 'creators');
	assert.deepEqual(await page.locator('.person-card-unread').allTextContents(), ['2 条未读', '2 条未读', '2 条未读']);
	await page.keyboard.press('Meta+,');
	await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
	assert.equal(await exit.count(), 0);
	assert.deepEqual(await localState(), before);
	await nav.getByRole('button', { name: '资料查询', exact: true }).click();
}

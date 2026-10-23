import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseOption } from './select.mjs';

// Exercise the review experience in the real Electron window, then capture it.
// This is an extension of the existing desktop smoke, not source integration.
export async function reviewVisual(page, application, output) {
	await mkdir(output, { recursive: true });
	await page.waitForLoadState('load');
	const nav = page.getByRole('navigation', { name: '主导航', exact: true });
	const main = page.getByRole('main');
	const screenshot = (name) => page.screenshot({ path: join(output, name), animations: 'disabled', style: '.preview-toast { visibility: hidden; }' });
	const noOverflow = async () => {
		const layout = await page.evaluate(() => {
			const content = document.querySelector('.page-scroll');
			return { window: document.documentElement.scrollWidth <= innerWidth, content: content.scrollWidth <= content.clientWidth + 1 };
		});
		assert.deepEqual(layout, { window: true, content: true });
	};
	await page.getByTestId('live-query').waitFor();
	assert.equal(await page.locator('.live-welcome').count(), 1);
	await noOverflow();
	await screenshot('00-live-query.png');
	await page.getByRole('button', { name: '视觉演示', exact: true }).click();
	if (await page.getByRole('button', { name: '返回真实工作区', exact: true }).count()) await page.getByRole('button', { name: '视觉演示', exact: true }).click();
	assert.equal(await page.locator('.result-grid .work-card').count(), 3);
	await screenshot('01-query.png');

	// A second fixture must lead to its own work and creator, not the first demo.
	await page.getByRole('button', { name: '查看 午後の余白 作品详情', exact: true }).click();
	assert.equal(await main.getByRole('heading', { level: 1 }).innerText(), '午後の余白');
	assert.equal(await page.locator('.work-credit .credit-name').innerText(), '青木 凛');
	await page.getByRole('button', { name: '返回查询结果', exact: true }).click();
	await page.getByRole('textbox', { name: '作品编号、标题或原站链接' }).fill('NECT-024');
	await page.getByRole('textbox', { name: '作品编号、标题或原站链接' }).press('Enter');
	assert.equal(await page.locator('.result-grid .work-card').count(), 1);
	await page.getByRole('button', { name: '查看 午後、窓辺にて 作品详情', exact: true }).click();
	await screenshot('02-work-detail.png');
	await page.getByRole('button', { name: '保存到作品档案', exact: true }).click();
	await page.getByRole('button', { name: '已保存 · 演示', exact: true }).waitFor();

	await page.getByRole('tab', { name: /^封面/ }).click();
	await page.getByRole('button', { name: '查看封面候选 2', exact: true }).click();
	assert.ok(await page.locator('.cover-main .art-photo').evaluate((element) => element.classList.contains('art-3')));
	await page.getByRole('button', { name: '并排比较', exact: true }).click();
	let dialog = page.getByRole('dialog');
	await dialog.getByRole('button', { name: '选择此封面', exact: true }).first().click();
	assert.ok(await page.locator('.cover-main .art-photo').evaluate((element) => element.classList.contains('art-0')));
	await screenshot('07-cover-comparison.png');
	await page.keyboard.press('Escape');
	await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '并排比较');
	assert.equal(await page.getByRole('button', { name: '并排比较', exact: true }).evaluate((element) => element === document.activeElement), true);

	await page.getByRole('tab', { name: /^来源/ }).click();
	await page.getByRole('button', { name: '查看字段差异', exact: true }).click();
	dialog = page.getByRole('dialog');
	await dialog.getByRole('radio', { name: /手动修正/ }).check();
	await dialog.getByLabel('手动发行日期', { exact: true }).fill('2026-10-20');
	await screenshot('08-field-source.png');
	await dialog.getByRole('button', { name: '采用此日期', exact: true }).click();
	await page.getByRole('tab', { name: '作品资料', exact: true }).click();
	await page.getByRole('button', { name: '2026.10.20', exact: true }).waitFor();
	await page.getByRole('button', { name: '切换到黑莓夜间', exact: true }).click();
	assert.equal(await page.locator('html').getAttribute('data-theme'), 'night');
	await screenshot('05-night-detail.png');
	await page.getByRole('button', { name: '切换到奶油档案', exact: true }).click();

	await page.locator('.work-credit').getByRole('button', { name: '创作者主页', exact: true }).click();
	assert.match(await main.getByRole('heading', { level: 1 }).innerText(), /白石 澪/);
	await screenshot('03-creator.png');
	await chooseOption(page, '检查频率', '每天');
	await page.getByRole('button', { name: '已关注', exact: true }).click();
	await page.getByRole('button', { name: '关注创作者', exact: true }).click();
	await page.getByRole('button', { name: '十月的拍摄手记：让光再停留一会儿', exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: '完成阅读', exact: true }).click();
	await nav.getByRole('button', { name: '更新', exact: true }).click();
	assert.equal(await page.locator('[data-post-id="mio-october"]').count(), 0);
	assert.equal(await page.locator('[data-post-id="mio-progress"]').count(), 1);
	assert.equal(await page.locator('[data-post-id="akari-schedule"]').count(), 1);
	await page.locator('.updates-aside .creator-filter').filter({ hasText: '白石 澪' }).click();
	await page.getByRole('button', { name: '当前列表全部已读', exact: true }).click();
	assert.match(await main.locator('.page-heading').innerText(), /2 条未读动态/);
	await page.getByRole('button', { name: '清除筛选', exact: true }).click();
	assert.equal(await page.locator('[data-post-id="rin-room"]').count(), 1);
	assert.equal(await page.locator('[data-post-id="akari-schedule"]').count(), 1);
	await page.getByRole('button', { name: '当前列表全部已读', exact: true }).click();
	await screenshot('09-unread-empty.png');
	await page.getByRole('tab', { name: '全部动态', exact: true }).click();
	assert.equal(await page.locator('.update-item').count(), 5);

	// Reset creates a clean review starting point and verifies no persistence.
	await page.getByRole('button', { name: '预览设置', exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: '重置演示', exact: true }).click();
	await nav.getByRole('button', { name: '更新', exact: true }).click();
	assert.equal(await page.locator('.update-item').count(), 4);
	await screenshot('04-updates.png');
	await page.getByRole('button', { name: '切换到黑莓夜间', exact: true }).click();
	await screenshot('10-night-updates.png');
	await page.getByRole('button', { name: '切换到奶油档案', exact: true }).click();
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
	await page.waitForFunction(() => innerWidth === 1000);
	for (const title of ['资料查询', '作品档案', '创作者', '更新']) {
		await nav.getByRole('button', { name: title, exact: true }).click();
		await noOverflow();
	}
	await screenshot('06-compact-updates.png');
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 840));
	await page.waitForFunction(() => innerWidth === 1280);
	await nav.getByRole('button', { name: '资料查询', exact: true }).click();
	await page.keyboard.press('Meta+k');
	await page.waitForFunction(() => document.activeElement?.id === 'work-query');
	assert.equal(await page.getByRole('textbox', { name: '作品编号、标题或原站链接' }).evaluate((element) => element === document.activeElement), true);
	await noOverflow();
	if (await page.getByRole('button', { name: '返回真实工作区', exact: true }).count()) await page.getByRole('button', { name: '返回真实工作区', exact: true }).click();
}

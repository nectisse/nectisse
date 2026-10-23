import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chooseOption } from './select.mjs';

export async function reviewSettings(page, application, output) {
	await mkdir(output, { recursive: true });
	await page.getByRole('button', { name: '设置', exact: true }).click();
	await page.getByRole('heading', { level: 1, name: '设置', exact: true }).waitFor();
	const tabsRect = await page.locator('.settings-tabs > [data-slot="tabs-list"]').boundingBox();
	const catalogRect = await page.locator('.source-catalog').boundingBox();
	assert.ok(Math.abs(tabsRect.x - catalogRect.x) <= 1);
	assert.ok(catalogRect.width >= tabsRect.width - 1);
	assert.ok(catalogRect.y >= tabsRect.y + tabsRect.height);
	const metadataPriority = await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).preferences.metadataPriority);
	const coverTrigger = page.getByRole('button', { name: '封面选择', exact: true });
	const metadataTrigger = page.getByRole('button', { name: '资料采用顺序', exact: true });
	const coverDialog = page.getByRole('dialog', { name: '封面选择', exact: true });
	const metadataDialog = page.getByRole('dialog', { name: '资料采用顺序', exact: true });
	assert.equal(await page.getByRole('textbox', { name: '搜索来源', exact: true }).count(), 0);
	assert.equal(await page.locator('.settings-tabs > [data-slot="tabs-list"] > [data-slot="tabs-trigger"] > svg').count(), 4);
	for (const trigger of [coverTrigger, metadataTrigger]) {
		assert.equal(await trigger.locator('svg[aria-hidden="true"]').count(), 1);
		assert.equal((await trigger.boundingBox()).height, 32);
	}
	const tableBounds = await page.locator('.source-table-card').boundingBox();
	await coverTrigger.click();
	await coverDialog.waitFor();
	await page.waitForFunction(() => document.activeElement?.matches('.source-priority-heading h2'));
	assert.deepEqual(await page.locator('.source-table-card').boundingBox(), tableBounds);
	await chooseOption(page, '添加封面优先图源', 'MGStage');
	await page.getByRole('button', { name: '上移 MGStage 封面优先级', exact: true }).click();
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.coverPriority.join(',') === 'mgstage,dmm');
	await page.screenshot({ path: join(output, '00-cover-priority.png') });
	await coverDialog.getByRole('button', { name: '完成', exact: true }).click();
	await metadataTrigger.click();
	await metadataDialog.getByRole('button', { name: '下移 DMM / FANZA 资料优先级', exact: true }).focus();
	await page.keyboard.press('Enter');
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.metadataPriority[0] === 'r18dev');
	assert.deepEqual(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).preferences.coverPriority), ['mgstage', 'dmm']);
	await page.keyboard.press('Escape');
	await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '资料采用顺序');
	const modalLayouts = [];
	for (const width of [1280, 1000]) {
		await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, width === 1280 ? 840 : 700), width);
		await page.waitForFunction(width => innerWidth === width, width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate(async theme => { const state = await window.nectisse.subscriptions.getState(); await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, theme } }); }, theme);
			await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
			await page.screenshot({ path: join(output, `00-source-toolbar-${width}-${theme}.png`), animations: 'disabled' });
			const toolbar = await page.locator('.source-catalog-controls').evaluate(element => {
				const controls = [...element.querySelectorAll('[data-slot="select-trigger"], [data-slot="button"]')].map(control => control.getBoundingClientRect());
				return { heights: controls.map(box => box.height), tops: controls.map(box => box.top), overflow: element.scrollWidth - element.clientWidth };
			});
			assert.ok(toolbar.heights.every(height => height === 32) && toolbar.tops.every(top => Math.abs(top - toolbar.tops[0]) <= 1) && toolbar.overflow <= 1, JSON.stringify(toolbar));
			for (const [kind, trigger, dialog] of [['cover', coverTrigger, coverDialog], ['metadata', metadataTrigger, metadataDialog], ['cover-many', coverTrigger, coverDialog]]) {
				if (kind === 'cover-many') {
					await page.evaluate(async () => {
						const state = await window.nectisse.subscriptions.getState();
						await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, coverPriority: ['mgstage', 'dmm', 'prestige', 'faleno', 'dahlia', '1pondo', 'fc2', 'javbus', 'avbase', 'airav'] } });
					});
					await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.coverPriority.length === 10);
				}
				await trigger.click();
				await dialog.waitFor();
				assert.deepEqual(await dialog.getByRole('columnheader').allTextContents(), ['顺序', kind === 'metadata' ? '来源' : '图源', '调整']);
				const layout = await dialog.evaluate(element => {
					const panel = element.getBoundingClientRect();
					const body = element.querySelector('.source-priority-scroll');
					const rank = element.querySelector('td.source-priority-rank');
					return { top: panel.top, bottom: panel.bottom, width: panel.width, height: panel.height, viewport: innerHeight, footer: element.querySelector('.source-priority-footer').getBoundingClientRect().bottom, overflow: element.scrollWidth - element.clientWidth, outer: document.scrollingElement.scrollHeight - innerHeight, scrolls: body.scrollHeight > body.clientHeight, heights: [...element.querySelectorAll('[data-slot="button"]')].map(control => control.getBoundingClientRect().height), rowHeights: [...element.querySelectorAll('.source-priority-item')].map(row => row.getBoundingClientRect().height), rankRadius: getComputedStyle(rank).borderRadius, rankBackground: getComputedStyle(rank).backgroundColor, titleFont: getComputedStyle(element.querySelector('h2')).fontSize, headerFont: getComputedStyle(element.querySelector('th')).fontSize };
				});
				assert.ok(layout.top >= 30 && layout.bottom <= layout.viewport - 30 && layout.footer <= layout.bottom && layout.overflow <= 1 && layout.outer <= 1 && layout.heights.every(height => height === 32), JSON.stringify(layout));
				assert.ok(layout.width <= 520 && layout.height <= 480 && layout.rowHeights.every(height => height >= 40 && height <= 42), JSON.stringify(layout));
				assert.equal(layout.rankRadius, '0px');
				assert.equal(layout.rankBackground, 'rgba(0, 0, 0, 0)');
				assert.equal(layout.titleFont, '16px');
				assert.equal(layout.headerFont, '10px');
				if (kind !== 'cover') {
					assert.ok(layout.scrolls);
					const headerTop = await dialog.locator('thead').evaluate(element => element.getBoundingClientRect().top);
					const footerTop = await dialog.locator('.source-priority-footer').evaluate(element => element.getBoundingClientRect().top);
					const addTop = kind === 'cover-many' ? await dialog.locator('.source-priority-add').evaluate(element => element.getBoundingClientRect().top) : null;
					await dialog.locator('.source-priority-scroll').evaluate(element => element.scrollTop = element.scrollHeight);
					assert.ok(Math.abs(await dialog.locator('thead').evaluate(element => element.getBoundingClientRect().top) - headerTop) <= 1);
					assert.equal(await dialog.locator('.source-priority-footer').evaluate(element => element.getBoundingClientRect().top), footerTop);
					if (addTop !== null) {
						assert.equal(await dialog.locator('.source-priority-add').evaluate(element => element.getBoundingClientRect().top), addTop);
					}
					await dialog.locator('.source-priority-scroll').evaluate(element => element.scrollTop = 0);
				}
				modalLayouts.push({ width, theme, kind, ...layout });
				await page.screenshot({ path: join(output, `00-${kind}-priority-${width}-${theme}.png`), animations: 'disabled' });
				await page.keyboard.press('Escape');
				await dialog.waitFor({ state: 'hidden' });
				await page.waitForFunction(label => document.activeElement?.textContent?.trim() === label, kind === 'metadata' ? '资料采用顺序' : '封面选择');
				if (kind === 'cover-many') {
					await page.evaluate(async () => {
						const state = await window.nectisse.subscriptions.getState();
						await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, coverPriority: ['mgstage', 'dmm'] } });
					});
					await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.coverPriority.length === 2);
				}
			}
		}
	}
	await writeFile(join(output, 'source-preferences-verification.json'), JSON.stringify({ modalLayouts, icons: 4, noSearch: true, independentPriorities: true }, null, 2));
	await page.getByRole('button', { name: '切换到奶油档案', exact: true }).click();
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 840));
	await page.reload();
	await page.getByRole('button', { name: '设置', exact: true }).click();
	await coverTrigger.click();
	assert.deepEqual(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).preferences.coverPriority), ['mgstage', 'dmm']);
	assert.deepEqual(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).preferences.metadataPriority), [metadataPriority[1], metadataPriority[0], ...metadataPriority.slice(2)]);
	await page.getByRole('button', { name: '移除 MGStage 封面优先级', exact: true }).click();
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.coverPriority.join(',') === 'dmm');
	await page.getByRole('button', { name: '移除 DMM / FANZA 封面优先级', exact: true }).click();
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.coverPriority.length === 0);
	await coverDialog.getByText('未指定优先图源，所有合格候选按分辨率选择。', { exact: true }).waitFor();
	await coverDialog.getByRole('button', { name: '恢复默认', exact: true }).click();
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.coverPriority.join(',') === 'dmm');
	await coverDialog.getByRole('button', { name: '关闭封面选择', exact: true }).click();
	await metadataTrigger.click();
	await metadataDialog.getByRole('button', { name: '上移 DMM / FANZA 资料优先级', exact: true }).click();
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.metadataPriority[0] === 'dmm');
	await metadataDialog.getByRole('button', { name: '下移 DMM / FANZA 资料优先级', exact: true }).click();
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.metadataPriority[0] === 'r18dev');
	await metadataDialog.getByRole('button', { name: '恢复默认', exact: true }).click();
	await page.waitForFunction(async expected => (await window.nectisse.subscriptions.getState()).preferences.metadataPriority.join(',') === expected, metadataPriority.join(','));
	await metadataDialog.getByRole('button', { name: '完成', exact: true }).click();
	const source = page.getByRole('switch', { name: '启用 DMM / FANZA', exact: true });
	await source.click();
	const blocked = await page.evaluate(() => window.nectisse.metadata.query({ query: 'SSIS-057', sources: ['dmm'], force: true }));
	assert.equal(blocked.ok, false); assert.match(blocked.message, /关闭/);
	await source.click();
	await page.getByRole('button', { name: '配置 DMM / FANZA', exact: true }).click();
	await chooseOption(page, 'dmm 传输', '浏览器指纹');
	assert.equal(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).preferences.sourceTransports.dmm), 'fingerprint');
	await chooseOption(page, 'dmm 传输', '标准连接');
	await page.screenshot({ path: join(output, '01-sources.png') });
	await page.getByRole('button', { name: '配置 DMM / FANZA', exact: true }).click();
	await chooseOption(page, '来源用途', '演员／创作者订阅');
	assert.equal(await page.locator('.settings-source').count(), 8);
	await page.getByRole('button', { name: '配置 FANBOX', exact: true }).click();
	const accountSecure = await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).encryptionAvailable);
	if (accountSecure) {
		await page.getByLabel('fanbox Cookie', { exact: true }).fill('nectisse-ui=synthetic-fixture');
		await page.getByRole('button', { name: '安全保存', exact: true }).click();
		await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).sources.find(row => row.id === 'fanbox').credentialPresent);
		assert.equal(await page.getByLabel('fanbox Cookie', { exact: true }).inputValue(), '');
		assert.equal(await page.evaluate(async () => JSON.stringify(await window.nectisse.subscriptions.getState()).includes('synthetic-fixture')), false);
		await page.getByRole('button', { name: '清除 Cookie', exact: true }).click();
		await page.waitForFunction(async () => !(await window.nectisse.subscriptions.getState()).sources.find(row => row.id === 'fanbox').credentialPresent);
	}
	await page.screenshot({ path: join(output, '01b-source-account.png') });
	await page.getByRole('button', { name: '配置 FANBOX', exact: true }).click();
	await chooseOption(page, '来源用途', '全部来源 · 36');
	await page.screenshot({ path: join(output, '01a-source-overview.png') });
	await page.getByRole('tab', { name: '订阅管理', exact: true }).click();
	await page.getByRole('switch', { name: '自动检查订阅', exact: true }).click();
	assert.equal(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).preferences.automatic), true);
	await page.getByRole('switch', { name: '自动检查订阅', exact: true }).click();
	const creatorFrequency = page.getByRole('combobox', { name: '创作者默认检查频率', exact: true });
	await creatorFrequency.click();
	const popup = page.locator('[data-slot="select-content"]');
	await page.getByRole('option', { name: '每小时', exact: true }).waitFor();
	assert.equal(await page.getByRole('option', { name: '每小时', exact: true }).getAttribute('aria-selected'), 'true');
	assert.equal(await popup.locator('input').count(), 0);
	const triggerRect = await creatorFrequency.boundingBox();
	const popupRect = await popup.boundingBox();
	assert.ok(Math.abs(triggerRect.width - popupRect.width) <= 1);
	await page.screenshot({ path: join(output, '02a-frequency-options.png') });
	await page.screenshot({ path: join(output, 'select-detail.png'), clip: { x: triggerRect.x - 12, y: triggerRect.y - 12, width: triggerRect.width + 24, height: popupRect.y + popupRect.height - triggerRect.y + 24 } });
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Escape');
	await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '创作者默认检查频率');
	assert.equal(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).preferences.creatorMinutes), 60);
	const focus = await creatorFrequency.evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, shadow: getComputedStyle(element).boxShadow }));
	assert.equal(focus.outline, 'none', JSON.stringify(focus));
	assert.ok(focus.shadow.includes('2px'), focus.shadow);
	await page.screenshot({ path: join(output, '02b-frequency-keyboard-focus.png') });
	await creatorFrequency.press('Enter');
	await page.getByRole('option').first().waitFor();
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.creatorMinutes === 1440);
	await chooseOption(page, '演员默认检查频率', '每 12 小时');
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.performerMinutes === 720);
	await page.reload();
	await page.getByRole('button', { name: '设置', exact: true }).click();
	await page.getByRole('tab', { name: '订阅管理', exact: true }).click();
	assert.equal(await creatorFrequency.innerText(), '每天');
	assert.equal(await page.getByRole('combobox', { name: '演员默认检查频率', exact: true }).innerText(), '每 12 小时');
	await chooseOption(page, '创作者默认检查频率', '每小时');
	await chooseOption(page, '演员默认检查频率', '每 6 小时');
	await page.screenshot({ path: join(output, '02-subscription-policy.png') });
	await page.getByRole('tab', { name: '网络与存储', exact: true }).click();
	await chooseOption(page, '网络代理', '直接连接');
	assert.equal(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).preferences.proxyMode), 'direct');
	await chooseOption(page, '网络代理', '使用系统代理');
	const proxyAddress = page.getByRole('textbox', { name: '独立代理地址', exact: true });
	await proxyAddress.fill('http://127.0.0.1:7890');
	await page.getByRole('button', { name: '保存并使用', exact: true }).click();
	await page.waitForFunction(async () => (await window.nectisse.subscriptions.getState()).preferences.proxyMode === 'custom');
	const addressRect = await proxyAddress.boundingBox();
	const saveRect = await page.getByRole('button', { name: '保存并使用', exact: true }).boundingBox();
	assert.ok(Math.abs(addressRect.y - saveRect.y) <= 1);
	assert.ok(Math.abs(addressRect.height - saveRect.height) <= 1, JSON.stringify({ addressRect, saveRect }));
	const notePadding = await page.locator('.settings-card-note').first().evaluate(element => parseFloat(getComputedStyle(element).paddingLeft));
	assert.ok(notePadding >= 16);
	await page.screenshot({ path: join(output, '03-network.png') });
	await page.getByRole('tab', { name: '外观与应用', exact: true }).click();
	await chooseOption(page, '界面主题', '黑莓夜间');
	await page.waitForFunction(() => document.documentElement.dataset.theme === 'night');
	await page.getByRole('tab', { name: '订阅管理', exact: true }).click();
	await page.getByRole('combobox', { name: '演员默认检查频率', exact: true }).click();
	await page.screenshot({ path: join(output, '02c-frequency-night.png') });
	await page.keyboard.press('Escape');
	await page.reload();
	await page.waitForFunction(() => document.documentElement.dataset.theme === 'night');
	await page.getByRole('button', { name: '切换到奶油档案', exact: true }).click();
	await page.keyboard.press('Meta+,');
	await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
	await page.waitForFunction(() => innerWidth === 1000);
	const size = await page.locator('.page-scroll').evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth })); assert.ok(size.scroll <= size.width + 1);
	assert.equal(await page.locator('.settings-source').count(), 36);
	const sourceRowHeights = await page.locator('.settings-source').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
	assert.ok(sourceRowHeights.every(height => height >= 50 && height <= 72), JSON.stringify(sourceRowHeights));
	await page.getByRole('button', { name: '配置 DMM / FANZA', exact: true }).click();
	await page.screenshot({ path: join(output, '04-compact-settings.png') });
	await page.getByRole('tab', { name: '订阅管理', exact: true }).click();
	await creatorFrequency.click();
	await page.getByRole('option').first().waitFor();
	const popupInWindow = await page.locator('[data-slot="select-content"]').evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; });
	assert.equal(popupInWindow, true);
	await page.screenshot({ path: join(output, '04a-compact-select.png') });
	await page.keyboard.press('Escape');
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 840));
	await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '资料查询', exact: true }).click();
}

export async function reviewSubscriptions(page, output) {
	await mkdir(output, { recursive: true });
	const idle = async (previousId) => {
		const until = Date.now() + 180_000;
		while (Date.now() < until) {
			const state = await page.evaluate(() => window.nectisse.subscriptions.getState());
			if (state.tasks[0]?.id !== previousId && state.tasks.length && !state.tasks.some(task => ['running', 'cancelling'].includes(task.status))) return state;
			await delay(100);
		} throw new Error('Follow task exceeded deadline');
	};
	await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '演员与创作者', exact: true }).click();
	await page.getByRole('button', { name: '添加关注', exact: true }).first().click();
	await chooseOption(page, '关注来源', 'FANBOX');
	await page.getByRole('textbox', { name: '主页、账号或演员名', exact: true }).fill('https://ffxivinitiala.fanbox.cc/');
	await page.getByRole('button', { name: '查询身份', exact: true }).click();
	let state = await idle(undefined); assert.ok(state.tasks[0].candidates.length); const lookupId = state.tasks[0].id;
	await page.getByRole('button', { name: '确认关注', exact: true }).click();
	state = await idle(lookupId);
	assert.equal(state.subscriptions.length, 1); assert.equal(state.subscriptions[0].following, true); assert.ok(state.entries.length > 0); assert.ok(state.entries.some(entry => entry.summary));
	await page.screenshot({ path: join(output, '05-real-creator.png') });
	const count = state.entries.length; const images = state.entries.filter(entry => entry.imageAsset).length; const subId = state.subscriptions[0].id; const oldTask = state.tasks[0].id;
	await page.getByRole('button', { name: '检查更新', exact: true }).click();
	state = await idle(oldTask); assert.equal(state.entries.length, count);
	await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '更新', exact: true }).click();
	await page.getByRole('button', { name: '标为已读', exact: true }).first().click();
	await page.screenshot({ path: join(output, '06-real-updates.png') });
	state = await page.evaluate(() => window.nectisse.subscriptions.getState()); assert.equal(state.entries.filter(entry => entry.read).length, 1);
	await page.reload(); state = await page.evaluate(() => window.nectisse.subscriptions.getState()); assert.equal(state.entries.filter(entry => entry.read).length, 1); assert.equal(state.subscriptions[0].id, subId);
	const reply = await page.evaluate(id => window.nectisse.subscriptions.command({ action: 'check', id }), subId);
	await page.evaluate(id => window.nectisse.subscriptions.command({ action: 'cancel', id }), reply.id);
	state = await page.evaluate(() => window.nectisse.subscriptions.getState()); assert.equal(state.tasks[0].status, 'cancelled'); assert.equal(state.subscriptions[0].autoPaused, true);
	const regionLookup = await page.evaluate(() => window.nectisse.subscriptions.command({ action: 'lookup', provider: 'javdb', query: '三宮つばき' }));
	assert.equal(regionLookup.ok, true); state = await idle(reply.id);
	assert.ok(state.tasks[0].status === 'succeeded' || ['region_restricted', 'auth_required', 'challenge', 'access_denied'].includes(state.tasks[0].reason), JSON.stringify(state.tasks[0]));
	const report = { id: subId, entries: count, images, read: 1, javdb: state.tasks[0].reason || 'success' };
	await writeFile(join(output, 'verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...report }, null, 2));
	return report;
}

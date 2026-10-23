import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// 显式 --live 才执行；默认桌面冒烟与视觉预览不发起任何 Python 站点请求。
export async function reviewMetadata(page, application, output) {
	const idle = async () => {
		const deadline = Date.now() + 150_000;
		while (Date.now() < deadline) {
			const state = await page.evaluate(() => window.nectisse.metadata.getState());
			if (state.tasks.length && !state.tasks.some(task => ['running', 'cancelling'].includes(task.status))) return state;
			await delay(100);
		}
		throw new Error('Metadata UI query exceeded deadline');
	};
	await mkdir(output, { recursive: true });
	await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '资料查询', exact: true }).click();
	const input = page.getByRole('textbox', { name: '作品编号、标题或原站链接', exact: true });
	await input.fill('https://video.dmm.co.jp/av/content/?id=ssis00057');
	await page.getByRole('button', { name: '查询资料', exact: true }).click();
	const state = await idle();
	const task = state.tasks[0];
	assert.equal(task.plan.query, 'SSIS-057');
	assert.ok(['succeeded', 'partial'].includes(task.status), JSON.stringify({ status: task.status, outcomes: task.outcomes }));
	assert.deepEqual(task.records.map(record => record.source), ['dmm', 'r18dev']);
	assert.ok(task.records.every(record => record.code === 'SSIS-057' && record.title && record.fetchedAt && record.sourceUrl));
	assert.ok(task.records.some(record => record.covers.some(cover => cover.asset)));
	await page.locator('.live-result-grid img').first().waitFor();
	assert.equal(await page.locator('.live-result-grid img').first().evaluate(image => image.complete && image.naturalWidth > 0), true);
	await page.getByRole('button', { name: '查看真实作品 SSIS-057', exact: true }).click();
	await page.locator('.live-detail').waitFor();
	await page.screenshot({ path: join(output, '01-real-detail.png') });
	await page.getByRole('tab', { name: '来源与差异', exact: true }).click();
	assert.equal(await page.locator('.provenance-record').count(), 2);
	await page.getByRole('button', { name: 'DMM / FANZA 原始资料', exact: true }).click();
	await page.getByRole('table', { name: 'DMM / FANZA 来源字段', exact: true }).waitFor();
	await page.getByRole('tab', { name: '作品资料', exact: true }).click();
	assert.equal(await page.getByRole('tab', { name: '封面', exact: true }).count(), 0);
	assert.equal(await page.locator('.live-detail .live-cover').count(), 1);
	assert.equal(task.records.flatMap(record => record.covers).filter(cover => cover.asset).length, 1);
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
	const layout = await page.locator('.page-scroll').evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth }));
	assert.ok(layout.scroll <= layout.width + 1);
	await page.getByRole('button', { name: '切换到黑莓夜间', exact: true }).click();
	await page.screenshot({ path: join(output, '02-real-covers-night.png') });
	await page.getByRole('button', { name: '切换到奶油档案', exact: true }).click();
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 840));
	await page.getByRole('button', { name: '返回查询结果', exact: true }).click();
	await input.fill('MIDV-012');
	await page.getByRole('button', { name: '查询资料', exact: true }).click();
	await page.getByRole('button', { name: '取消查询', exact: true }).click();
	await idle();
	const cancelled = await page.evaluate(async () => (await window.nectisse.metadata.getState()).tasks[0]);
	assert.equal(cancelled.status, 'cancelled');
	const report = { checkedAt: new Date().toISOString(), status: task.status, requests: task.requests, sources: task.records.map(record => ({ source: record.source, code: record.code, covers: record.covers.filter(cover => cover.asset).map(cover => ({ width: cover.asset.width, height: cover.asset.height })) })), checks: ['real-query-ui', 'source-fields', 'local-cover-protocol', 'minimum-window', 'both-themes', 'cancel-ui'] };
	await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
	return cancelled.id;
}

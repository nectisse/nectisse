import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chooseOption } from './select.mjs';

export async function reviewSources(page, output) {
	await mkdir(output, { recursive: true });
	await page.getByRole('button', { name: '设置', exact: true }).click();
	await page.getByRole('heading', { level: 1, name: '设置', exact: true }).waitFor();
	await page.getByRole('tab', { name: '来源与账号', exact: true }).click();
	assert.equal(await page.locator('.settings-source').count(), 36);
	await chooseOption(page, '来源用途', '作品资料与封面');
	assert.equal(await page.locator('.settings-source').count(), 24);
	const avbase = page.getByRole('switch', { name: '启用 AVBase', exact: true });
	await avbase.click();
	assert.equal(await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).preferences.enabledSources.includes('avbase')), true);
	await page.screenshot({ path: join(output, '01-expanded-metadata.png') });
	await chooseOption(page, '来源用途', '需要额外适配');
	assert.equal(await page.locator('.settings-source').count(), 5);
	for (const label of ['Rule34.xxx', 'Rule34 Paheal', 'F95zone', 'SimpCity', 'DUGA']) assert.equal(await page.getByRole('switch', { name: `启用 ${label}`, exact: true }).isDisabled(), true);
	await page.screenshot({ path: join(output, '02-explicit-boundaries.png') });
	await chooseOption(page, '来源用途', '演员／创作者订阅');
	assert.equal(await page.locator('.settings-source').count(), 8);
	await page.screenshot({ path: join(output, '03-expanded-follow.png') });
	await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '演员与创作者', exact: true }).click();
	await page.getByRole('button', { name: '添加关注', exact: true }).first().click();
	const provider = page.getByRole('combobox', { name: '关注来源', exact: true });
	await provider.waitFor();
	await provider.click();
	await page.getByRole('option').first().waitFor();
	assert.equal(await page.getByRole('option').count(), 8);
	assert.equal(await page.locator('[data-slot="select-content"] input').count(), 0);
	await page.keyboard.press('Escape');
	await chooseOption(page, '关注来源', 'SubscribeStar');
	await page.getByRole('textbox', { name: '主页、账号或演员名', exact: true }).fill('https://subscribestar.adult/creator');
	assert.equal(await page.getByRole('button', { name: '查询身份', exact: true }).isDisabled(), true);
	await page.getByRole('button', { name: '关闭添加关注', exact: true }).click();
	await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '资料查询', exact: true }).click();
	await page.getByRole('button', { name: '调整资料来源', exact: true }).click();
	await page.getByRole('button', { name: '查询使用 AVBase', exact: true }).click();
	assert.equal(await page.getByRole('button', { name: '查询使用 AVBase', exact: true }).getAttribute('aria-pressed'), 'true');
	await page.screenshot({ path: join(output, '04-source-selection.png') });
	await page.getByRole('button', { name: '查询使用 AVBase', exact: true }).click();
	await page.evaluate(async () => { const state = await window.nectisse.subscriptions.getState(); await window.nectisse.subscriptions.command({ action: 'preferences', value: { ...state.preferences, enabledSources: state.preferences.enabledSources.filter(id => id !== 'avbase') } }); });
	await page.getByRole('button', { name: '调整资料来源', exact: true }).click();
}

export async function reviewSourcesLive(page, output, proxy = '') {
	await mkdir(output, { recursive: true });
	const original = await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).preferences);
	const enabled = [...new Set([...original.enabledSources, 'avbase', 'makers', '1pondo', 'subscribestar', 'kemono'])];
	const reply = await page.evaluate(({ value, proxy }) => window.nectisse.subscriptions.command({ action: 'preferences', value: { ...value, ...(proxy ? { proxyMode: 'custom', proxyUrl: proxy } : {}) } }), { value: { ...original, enabledSources: enabled }, proxy });
	assert.equal(reply.ok, true);
	async function metadata(query, sources) {
		const reply = await page.evaluate(value => window.nectisse.metadata.query(value), { query, sources, force: true });
		assert.equal(reply.ok, true, reply.message);
		const until = Date.now() + 150000;
		while (Date.now() < until) {
			const state = await page.evaluate(() => window.nectisse.metadata.getState());
			const task = state.tasks.find(row => row.id === reply.taskId);
			if (task && !['running', 'cancelling'].includes(task.status)) return task;
			await delay(100);
		}
		throw new Error('扩展资料桌面验证超时');
	}
	async function idle(id) {
		const until = Date.now() + 180000;
		while (Date.now() < until) {
			const state = await page.evaluate(() => window.nectisse.subscriptions.getState());
			const task = state.tasks.find(row => row.id === id);
			if (task && !['running', 'cancelling'].includes(task.status)) return state;
			await delay(100);
		}
		throw new Error('扩展订阅桌面验证超时');
	}
	const work = await metadata('SSIS-057', ['avbase', 'makers']);
	assert.ok(['partial', 'succeeded'].includes(work.status), JSON.stringify(work.outcomes));
	assert.equal(new Set(work.records.map(row => row.code)).size, 1);
	assert.equal(work.records.length, 2);
	assert.ok(work.records.find(row => row.source === 'avbase')?.covers.some(row => row.asset));
	const dated = await metadata('https://www.1pondo.tv/movies/092415_001/', ['1pondo']);
	assert.equal(dated.records[0]?.code, '092415_001', JSON.stringify(dated.outcomes));
	assert.ok(dated.records[0]?.covers.some(row => row.asset), JSON.stringify(dated.outcomes));
	const subscriptions = [];
	for (const [provider, query] of [['subscribestar', 'https://subscribestar.adult/initiala'], ['kemono', 'https://kemono.cr/fanbox/user/30917150']]) {
		const lookup = await page.evaluate(({ provider, query }) => window.nectisse.subscriptions.command({ action: 'lookup', provider, query }), { provider, query });
		assert.equal(lookup.ok, true, lookup.message);
		let state = await idle(lookup.id);
		const task = state.tasks.find(row => row.id === lookup.id);
		assert.ok(task.candidates[0], JSON.stringify(task));
		const follow = await page.evaluate(({ taskId, ref }) => window.nectisse.subscriptions.command({ action: 'follow', taskId, ref }), { taskId: lookup.id, ref: task.candidates[0].ref });
		assert.equal(follow.ok, true, follow.message);
		const check = (await page.evaluate(() => window.nectisse.subscriptions.getState())).tasks.find(row => row.subscriptionId === follow.id);
		state = await idle(check.id);
		const count = state.entries.filter(row => row.subscriptionId === follow.id).length;
		assert.ok(count > 0, JSON.stringify(state.tasks[0]));
		assert.equal(state.subscriptions.find(row => row.id === follow.id).kind, 'creator_posts');
		subscriptions.push({ id: follow.id, provider, entries: count, images: state.entries.filter(row => row.subscriptionId === follow.id && row.imageAsset).length });
	}
	let state = await page.evaluate(() => window.nectisse.subscriptions.getState());
	const entries = state.entries.length;
	const refresh = await page.evaluate(id => window.nectisse.subscriptions.command({ action: 'check', id }), subscriptions[0].id);
	state = await idle(refresh.id); assert.equal(state.entries.length, entries);
	await page.evaluate(id => window.nectisse.subscriptions.command({ action: 'read', ids: [id], read: true }), state.entries[0].id);
	await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '更新', exact: true }).click();
	await page.screenshot({ path: join(output, '05-real-expanded-updates.png') });
	const read = await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).entries.filter(row => row.read).length);
	const report = { checkedAt: new Date().toISOString(), metadata: work.records.map(row => ({ source: row.source, code: row.code, covers: row.covers.filter(row => row.asset).length })), dated: { code: dated.records[0].code, cover: !!dated.records[0].covers[0].asset }, subscriptions, entries, read };
	await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2));
	return report;
}

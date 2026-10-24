import { openUpdates } from './people.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export async function reviewSourcesLive(page, output, proxy = '') {
	await mkdir(output, { recursive: true });
	const original = await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).preferences);
	const enabled = [...new Set([...original.enabledSources, 'avbase', 'makers', '1pondo', 'kemono'])];
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
	for (const [provider, query] of [['kemono', 'https://kemono.cr/fanbox/user/30917150']]) {
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
	await openUpdates(page);
	await page.screenshot({ path: join(output, '05-real-expanded-updates.png') });
	const read = await page.evaluate(async () => (await window.nectisse.subscriptions.getState()).entries.filter(row => row.read).length);
	const report = { checkedAt: new Date().toISOString(), metadata: work.records.map(row => ({ source: row.source, code: row.code, covers: row.covers.filter(row => row.asset).length })), dated: { code: dated.records[0].code, cover: !!dated.records[0].covers[0].asset }, subscriptions, entries, read };
	await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2));
	return report;
}

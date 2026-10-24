import { openPeople, openUpdates } from './people.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chooseOption } from './select.mjs';

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
	await openPeople(page, 'actors', 'manage');
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
	await openUpdates(page);
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

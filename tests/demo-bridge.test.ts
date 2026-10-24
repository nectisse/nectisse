import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoBridge } from '../src/renderer/demo/bridge';
import { subscriptionsStateSchema } from '../src/shared/subscriptions';
import { metadataStateSchema } from '../src/shared/metadata';
import { libraryStateSchema, savedWorkSchema } from '../src/shared/library';
import { canonicalFollow, validFollowEntry } from '../src/shared/source-identity';

test('示例接口返回正式页面使用的数据结构，独立会话互不影响', async () => {
	const first = createDemoBridge();
	const second = createDemoBridge();
	const state = subscriptionsStateSchema.parse(await first.subscriptions.getState());
	metadataStateSchema.parse(await first.metadata.getState());
	const library = libraryStateSchema.parse(await first.library.getState());
	savedWorkSchema.parse(await first.library.getWork(library.works[0]!.id));
	const entry = state.entries[0]!;
	for (const sub of state.subscriptions) {
		assert.equal(sub.url, canonicalFollow(sub.provider, sub.ref, sub.handle));
		assert.ok(state.entries.filter((entry) => entry.subscriptionId === sub.id).every((entry) => validFollowEntry(sub.provider, sub.ref, entry)));
	}
	await first.subscriptions.command({ action: 'read', ids: [entry.id], read: true });
	await first.subscriptions.command({ action: 'preferences-patch', patch: { theme: 'night', automatic: true } });
	assert.equal((await first.subscriptions.getState()).entries.find((item) => item.id === entry.id)?.read, true);
	assert.equal((await first.subscriptions.getState()).preferences.theme, 'night');
	assert.equal((await second.subscriptions.getState()).preferences.theme, 'cream');
	assert.equal((await second.subscriptions.getState()).entries[0]!.read, false);
	state.entries[0]!.summary = '外部修改';
	assert.notEqual((await first.subscriptions.getState()).entries[0]!.summary, '外部修改');
});

test('示例查询、收藏、取消关注与恢复都经同一接口完成', async () => {
	const bridge = createDemoBridge();
	const reply = await bridge.metadata.query({ query: 'NECT-018', sources: ['dmm', 'r18dev'], force: false });
	const task = (await bridge.metadata.getState()).tasks.find((item) => item.id === reply.taskId)!;
	assert.equal(task.records.length, 2);
	assert.ok(task.records.every((record) => record.code === 'NECT-018'));
	const saved = await bridge.library.save({ taskId: task.id, code: 'NECT-018', replace: false });
	assert.equal(saved.ok, true);
	assert.equal((await bridge.library.getState()).works.length, 2);
	await bridge.library.remove(saved.id!);
	assert.equal((await bridge.library.getState()).works.length, 1);
	const sub = (await bridge.subscriptions.getState()).subscriptions[0]!;
	await bridge.subscriptions.command({ action: 'update', id: sub.id, following: false });
	assert.equal((await bridge.subscriptions.command({ action: 'check', id: sub.id })).ok, false);
	await bridge.subscriptions.command({ action: 'update', id: sub.id, following: true });
	assert.equal((await bridge.subscriptions.command({ action: 'check', id: sub.id })).ok, true);
	const lookup = await bridge.subscriptions.command({ action: 'lookup', provider: 'fanbox', query: '示例新人' });
	const candidate = (await bridge.subscriptions.getState()).tasks.find((item) => item.id === lookup.id)!.candidates.at(-1)!;
	const follow = await bridge.subscriptions.command({ action: 'follow', taskId: lookup.id!, ref: candidate.ref });
	assert.equal(follow.ok, true);
	subscriptionsStateSchema.parse(await bridge.subscriptions.getState());
});

test('示例接口不执行原站、凭据、剪贴板或诊断文件操作', async () => {
	const bridge = createDemoBridge();
	const state = await bridge.subscriptions.getState();
	assert.equal((await bridge.subscriptions.command({ action: 'open', kind: 'subscription', id: state.subscriptions[0]!.id })).ok, false);
	assert.equal((await bridge.subscriptions.command({ action: 'credential', provider: 'fanbox', cookie: 'demo' })).ok, false);
	assert.equal(await bridge.magnets.openSite('heimacili'), false);
	assert.deepEqual(await bridge.diagnostics.copyReport(), { copied: false });
	await assert.rejects(bridge.metadata.openSource('demo', 'demo'));
	await assert.rejects(bridge.library.openSource('demo', 'demo'));
});

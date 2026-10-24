import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DesktopBridge } from '@shared/protocol';
import { DEFAULT_PREFERENCES } from '@shared/preferences';
import type { SubscriptionsState } from '@shared/subscriptions';
import type { LibraryState } from '@shared/library';
import type { MetadataState } from '@shared/metadata';
import { createDesktopState } from '../src/renderer/shared/desktop/desktop';
import { connectSnapshot, createSnapshot } from '../src/renderer/shared/desktop/snapshot';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function stream<T>(initial: T) {
	const listeners = new Set<(value: T) => void>();
	let reads = 0;
	let retries = 0;
	return {
		get listeners() {
			return listeners.size;
		},
		get reads() {
			return reads;
		},
		get retries() {
			return retries;
		},
		getState: async () => {
			reads++;
			return structuredClone(initial);
		},
		retry: async () => {
			retries++;
			return structuredClone(initial);
		},
		onState: (listener: (value: T) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		push: (value: T) => {
			for (const listener of listeners) {
				listener(structuredClone(value));
			}
		},
	};
}

function harness() {
	const snapshot: SubscriptionsState = {
		revision: 1,
		preferences: structuredClone(DEFAULT_PREFERENCES),
		subscriptions: [],
		entries: [],
		tasks: [],
		sources: [],
		encryptionAvailable: false,
		notice: '',
	};
	const subscriptions = stream(snapshot);
	const metadata = stream<MetadataState>({ revision: 1, tasks: [] });
	const library = stream<LibraryState>({ revision: 1, works: [] });
	const runtime = stream({ revision: 1, phase: 'ready' as const, message: 'ready' });
	const commands: unknown[] = [];
	const bridge = {
		subscriptions: {
			...subscriptions,
			command: async (command: unknown) => {
				commands.push(command);
				return { ok: true };
			},
			onSettings: () => () => {},
		},
		metadata,
		library,
		runtime,
		diagnostics: { recordReadFailure: async () => {} },
	} as unknown as DesktopBridge;
	return { state: createDesktopState(bridge), snapshot, subscriptions, metadata, library, runtime, commands };
}

test('IPC 每个领域仅连接一次，重复挂载及 StrictMode 清理后可重新连接', async () => {
	const h = harness();
	const release = h.state.connect();
	const releaseOther = h.state.connect();
	await tick();
	for (const channel of [h.subscriptions, h.metadata, h.library, h.runtime]) {
		assert.equal(channel.listeners, 1);
		assert.equal(channel.reads, 1);
	}
	release();
	assert.equal(h.metadata.listeners, 1);
	releaseOther();
	releaseOther();
	assert.equal(h.metadata.listeners, 0);
	const reconnect = h.state.connect();
	await tick();
	assert.equal(h.metadata.listeners, 1);
	assert.equal(h.metadata.reads, 2);
	reconnect();
	for (const channel of [h.subscriptions, h.metadata, h.library, h.runtime]) {
		assert.equal(channel.listeners, 0);
	}
});

test('任务推送保留未变化的设置与列表引用，旧版本和释放后的事件不会覆盖状态', async () => {
	const h = harness();
	const release = h.state.connect();
	await tick();
	const before = h.state.subscriptions.getState().snapshot;
	h.subscriptions.push({ ...h.snapshot, revision: 2, notice: 'progress' });
	const after = h.state.subscriptions.getState().snapshot;
	assert.equal(after.preferences, before.preferences);
	assert.equal(after.entries, before.entries);
	assert.equal(after.subscriptions, before.subscriptions);
	assert.equal(after.notice, 'progress');
	h.subscriptions.push({ ...h.snapshot, revision: 0, notice: 'stale' });
	assert.equal(h.state.subscriptions.getState().snapshot.notice, 'progress');
	release();
	h.subscriptions.push({ ...h.snapshot, revision: 3, notice: 'disposed' });
	assert.equal(h.state.subscriptions.getState().snapshot.notice, 'progress');
});

test('重新检查调用恢复入口，设置操作只提交 patch，不另存持久化副本', async () => {
	const h = harness();
	const release = h.state.connect();
	try {
		await h.state.actions.reloadSubscriptions();
		await h.state.actions.reloadMetadata();
		await h.state.actions.reloadLibrary();
		await h.state.actions.reloadRuntime();
		assert.equal(h.subscriptions.retries, 1);
		assert.equal(h.metadata.retries, 1);
		assert.equal(h.library.retries, 1);
		assert.equal(h.runtime.retries, 1);
		assert.deepEqual(await h.state.actions.updatePreferences({ theme: 'night' }), { ok: true });
		assert.deepEqual(h.commands, [{ action: 'preferences-patch', patch: { theme: 'night' } }]);
	} finally {
		release();
	}
});

test('较新的推送取代悬挂读取，迟到失败不覆盖恢复状态；清理后异步结果无效', async () => {
	let rejectRead: (reason: Error) => void = () => {};
	const channel = stream({ revision: 0, works: [] as string[] });
	const model = createSnapshot({ revision: 0, works: [] as string[] });
	const connection = connectSnapshot(
		model,
		{
			...channel,
			getState: () =>
				new Promise((_, reject) => {
					rejectRead = reject;
				}),
		},
		'failed',
		25,
	);
	await tick();
	channel.push({ revision: 2, works: ['restored'] });
	rejectRead(new Error('late'));
	await tick();
	assert.equal(model.store.getState().error, '');
	assert.equal(model.store.getState().reading, false);
	assert.deepEqual(model.store.getState().snapshot.works, ['restored']);
	connection.dispose();
	channel.push({ revision: 3, works: ['after-dispose'] });
	assert.equal(model.store.getState().snapshot.revision, 2);
});

test('超时后可通过重新检查恢复，缺失通信也给出可见错误', async () => {
	const model = createSnapshot({ revision: 0 });
	const connection = connectSnapshot(model, { getState: () => new Promise(() => {}), retry: async () => ({ revision: 2 }), onState: () => () => {} }, 'failed', 5);
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(model.store.getState().error, 'failed');
	await connection.refresh(true);
	assert.equal(model.store.getState().error, '');
	assert.equal(model.store.getState().snapshot.revision, 2);
	connection.dispose();
	const missing = createDesktopState(undefined);
	const release = missing.connect();
	await tick();
	assert.equal(missing.runtime.getState().reading, false);
	assert.ok(missing.runtime.getState().error);
	assert.ok(missing.subscriptions.getState().error);
	assert.equal((await missing.actions.updatePreferences({ theme: 'night' })).ok, false);
	release();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { personAvatar, subscriptionSchema } from '@shared/subscriptions';
import { ImageStore, type ImageBytes } from '../src/main/platform/images';
import { SubscriptionStore, SubscriptionsService } from '../src/main/features/subscriptions';
import { ManualAvatars } from '../src/main/features/subscriptions/manual-avatars';
import type { PythonTaskHost } from '../src/main/platform/python';

function image(name: string): ImageBytes {
	const bytes = Buffer.from(name);
	return { bytes, asset: { sha256: createHash('sha256').update(bytes).digest('hex'), width: 32, height: 32, bytes: bytes.length, format: 'JPEG', quality: 'standard' } };
}

const cipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };

async function setup(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-manual-avatars-'));
	const store = new SubscriptionStore(root, cipher);
	const images = new ImageStore(root, (value) => value);
	await images.initialize();
	const avatars = new ManualAvatars(store, images);
	const actor = store.follow({ provider: 'javdb', ref: 'A123', name: '演员样本', aliases: [], recordType: '演员', bio: '', evidence: '', url: 'https://javdb.com/actors/A123' });
	const creator = store.follow({
		provider: 'fanbox',
		ref: 'artist',
		name: '创作者样本',
		aliases: [],
		recordType: '创作者',
		bio: '',
		evidence: '',
		url: 'https://artist.fanbox.cc/',
	});
	t.after(async () => {
		await images.close();
		store.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, store, images, avatars, actor, creator };
}

test('演员与创作者可独立上传；手动头像重启后优先，清理普通缓存和取消关注不丢失', async (t) => {
	const { root, store, images, avatars, actor, creator } = await setup(t);
	const automatic = image('site-avatar');
	actor.avatarAsset = automatic.asset;
	store.saveSubscription(actor);
	const manual = image('local-avatar');
	await avatars.replace(actor.id, manual);
	await avatars.replace(creator.id, manual);
	assert.equal(personAvatar(store.subscription(actor.id)!)?.sha256, manual.asset.sha256);
	assert.equal(store.subscription(actor.id)?.avatarAsset?.sha256, automatic.asset.sha256);
	assert.equal((await images.usage()).files, 1, '同图共用文件');
	const current = store.subscription(actor.id)!;
	current.following = false;
	store.saveSubscription(current);
	await avatars.prepare();
	await images.clear();
	assert.deepEqual((await images.readHash(manual.asset.sha256))?.bytes, manual.bytes);
	const reopened = new SubscriptionStore(root, cipher);
	try {
		assert.equal(personAvatar(reopened.subscription(actor.id)!)?.sha256, manual.asset.sha256);
		assert.equal(personAvatar(reopened.subscription(creator.id)!)?.sha256, manual.asset.sha256);
	} finally {
		reopened.close();
	}
	await avatars.restore(actor.id);
	await images.clear();
	assert.ok(await images.readHash(manual.asset.sha256), '另一位人物仍引用同图');
	assert.equal(personAvatar(store.subscription(actor.id)!)?.sha256, automatic.asset.sha256);
	await avatars.restore(creator.id);
	await images.clear();
	assert.equal(await images.readHash(manual.asset.sha256), undefined);
});

test('站点刷新取得新头像也不覆盖手动头像；恢复时使用最新站点头像', async (t) => {
	const { store, images, actor } = await setup(t);
	const source = image('new-site-avatar');
	const run: PythonTaskHost['run'] = async (method, params) => {
		if (method === 'follow.image') {
			await writeFile(String(params!.destination), source.bytes);
			return { status: 'success', requests: 1, retryAfter: 0, reason: '', message: '', asset: source.asset };
		}
		return { status: 'success', requests: 1, retryAfter: 0, reason: '', message: '', avatarUrl: 'https://c0.jdbstatic.com/avatars/a/A123.jpg' };
	};
	const service = new SubscriptionsService(
		store,
		{ run },
		async () => '',
		async () => {},
		0,
		undefined,
		images,
	);
	t.after(() => service.stop());
	await service.initialize();
	store.savePreferences({ ...store.preferences(), enabledSources: ['javdb'], automatic: false });
	const manual = image('manual-avatar');
	assert.equal((await service.uploadAvatar(actor.id, manual)).ok, true);
	assert.equal((await service.command({ action: 'check', id: actor.id })).ok, true);
	for (let n = 0; n < 200 && service.getState().tasks.some((task) => task.status === 'running'); n++) {
		await delay(5);
	}
	assert.equal(service.getState().tasks[0]?.status, 'succeeded');
	assert.equal(store.subscription(actor.id)?.avatarAsset?.sha256, source.asset.sha256);
	assert.equal(personAvatar(store.subscription(actor.id)!)?.sha256, manual.asset.sha256);
	assert.equal((await service.command({ action: 'restore-avatar', id: actor.id })).ok, true);
	assert.equal(personAvatar(store.subscription(actor.id)!)?.sha256, source.asset.sha256);
	assert.ok(await images.readHash(source.asset.sha256));
});

test('上传保存失败保留旧图；连续更换回收旧引用，恢复与上传按操作顺序生效', async (t) => {
	const { store, images, avatars, actor } = await setup(t);
	const first = image('first');
	const second = image('second');
	await avatars.replace(actor.id, first);
	const save = store.saveSubscription.bind(store);
	store.saveSubscription = () => {
		throw new Error('SQLITE_FULL');
	};
	await assert.rejects(avatars.replace(actor.id, second), /SQLITE_FULL/);
	store.saveSubscription = save;
	await images.clear();
	assert.equal(personAvatar(store.subscription(actor.id)!)?.sha256, first.asset.sha256);
	assert.ok(await images.readHash(first.asset.sha256));
	assert.equal(await images.readHash(second.asset.sha256), undefined);
	await avatars.replace(actor.id, second);
	await images.clear();
	assert.equal(await images.readHash(first.asset.sha256), undefined);
	assert.ok(await images.readHash(second.asset.sha256));
	await Promise.all([avatars.replace(actor.id, first), avatars.restore(actor.id)]);
	assert.equal(store.subscription(actor.id)?.manualAvatarAsset, undefined);
	await assert.rejects(avatars.replace(crypto.randomUUID(), first), /该订阅不存在/);
});

test('旧订阅数据保持兼容，无站点头像时恢复为默认占位', async (t) => {
	const { actor, store, avatars } = await setup(t);
	assert.equal(subscriptionSchema.parse(actor).manualAvatarAsset, undefined);
	await avatars.replace(actor.id, image('local-only'));
	await avatars.restore(actor.id);
	assert.equal(personAvatar(store.subscription(actor.id)!), undefined);
});

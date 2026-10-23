import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES } from '../src/shared/sources';
import { allowedSourceUrl } from '../src/shared/source-identity';
import { DEFAULT_PREFERENCES } from '../src/shared/subscriptions';
import { sourceCooldownSeconds, sourceTransport } from '../src/main/source-policy';

test('来源页面覆盖完整登记目录，独立图床按图片域名清单校验', () => {
	for (const source of SOURCES) {
		assert.equal(allowedSourceUrl(source.id, source.root), new URL(source.root).href, source.id);
		for (const domain of source.images) {
			const image = `https://${domain}/cover.jpg`;
			assert.equal(allowedSourceUrl(source.id, image, 'image'), image, source.id);
		}
	}
	for (const value of [
		'http://video.dmm.co.jp/work',
		'https://video.dmm.co.jp.evil.invalid/work',
		'https://evildmm.co.jp/work',
		'https://user:secret@video.dmm.co.jp/work',
		'https://video.dmm.co.jp:444/work',
		'javascript:alert(1)',
		'not a URL',
	]) assert.equal(allowedSourceUrl('dmm', value), undefined, value);
	assert.equal(allowedSourceUrl('dmm', 'https://pics.dmm.co.jp/cover.jpg', 'image'), 'https://pics.dmm.co.jp/cover.jpg');
	assert.equal(allowedSourceUrl('r18dev', 'https://pics.dmm.co.jp/cover.jpg', 'image'), 'https://pics.dmm.co.jp/cover.jpg');
	assert.equal(allowedSourceUrl('r18dev', 'https://pics.dmm.co.jp/cover.jpg'), undefined);
});

test('传输策略兼容旧版设置，逐来源配置在查询、头像和封面中优先生效', () => {
	const preferences = { ...DEFAULT_PREFERENCES, fanboxTransport: 'fingerprint' as const, javdbTransport: 'httpx' as const };
	assert.equal(sourceTransport('fanbox', preferences), 'fingerprint');
	assert.equal(sourceTransport('javdb', preferences), 'httpx');
	assert.equal(sourceTransport('javdb', { ...preferences, sourceTransports: { javdb: 'fingerprint' } }), 'fingerprint');
	assert.equal(sourceTransport('prestige', { ...preferences, sourceTransports: { prestige: 'httpx' } }), 'httpx');
	assert.equal(sourceTransport('dmm'), 'httpx');
	assert.equal(sourceTransport('prestige'), 'fingerprint');
});

test('来源冷却区分解析错误、临时故障和访问限制，并限制站点等待时间', () => {
	assert.equal(sourceCooldownSeconds('parse_error', 120), 0);
	assert.equal(sourceCooldownSeconds('timeout'), 30);
	assert.equal(sourceCooldownSeconds('challenge'), 300);
	assert.equal(sourceCooldownSeconds('rate_limited', 1), 60);
	assert.equal(sourceCooldownSeconds('rate_limited', 120), 120);
	assert.equal(sourceCooldownSeconds('rate_limited', 999999), 86400);
});

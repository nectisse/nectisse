import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { openPeople, openProfile } from './people.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const profile = await mkdtemp(join(tmpdir(), 'nectisse-workspace-review-avatars-'));
const output = join(root, '.test-output', appPath ? 'packaged-manual-avatars' : 'development-manual-avatars');
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
env.PATH = '/usr/bin:/bin';
const source = join(profile, 'selected-avatar.png');
const invalid = join(profile, 'invalid.png');
let app;
let page;
const errors = [];

async function launch() {
	app = await _electron.launch({ executablePath: appPath ? join(appPath, 'Contents/MacOS/Nectisse') : electron, args: [...(appPath ? [] : [root]), `--user-data-dir=${profile}`], cwd: profile, env });
	await app.evaluate(({ dialog, session }) => {
		globalThis.__avatarTest = { selections: [], options: [], requests: [] };
		dialog.showOpenDialog = async (_parent, options) => {
			globalThis.__avatarTest.options.push(options);
			return globalThis.__avatarTest.selections.shift() ?? { canceled: true, filePaths: [] };
		};
		session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
			globalThis.__avatarTest.requests.push(details.url);
			callback({ cancel: true });
		});
	});
	page = await app.firstWindow();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.locator('[data-testid="runtime-status"][data-phase="ready"]').waitFor();
}

async function select(path) {
	await app.evaluate((_electron, path) => {
		globalThis.__avatarTest.selections.push(path ? { canceled: false, filePaths: [path] } : { canceled: true, filePaths: [] });
	}, path);
	await page.locator('.person-avatar-actions').getByRole('button', { name: /^(上传|更换)头像$/ }).click();
	await page.waitForFunction(() => document.querySelector('.person-avatar-actions')?.getAttribute('aria-busy') === 'false');
}

async function avatarReady(hash) {
	await page.waitForFunction((hash) => {
		const image = document.querySelector('.creator-profile-avatar img');
		return image?.src.includes(hash) && image.complete && image.naturalWidth > 0;
	}, hash);
}

try {
	await mkdir(output, { recursive: true });
	execFileSync(process.execPath, ['--import', 'tsx', 'scripts/seed-workspace-fixtures.ts', profile], { cwd: root, stdio: 'pipe' });
	await writeFile(invalid, 'not an image');
	await launch();
	await app.evaluate(({ nativeImage }, source) => {
		const require = process.getBuiltinModule('module').createRequire(process.execPath);
		const bytes = Buffer.alloc(1600 * 800 * 4);
		for (let y = 0; y < 800; y++) {
			for (let x = 0; x < 1600; x++) {
				const offset = (y * 1600 + x) * 4;
				bytes[offset] = x >= 400 && x < 1200 ? 170 : 40;
				bytes[offset + 1] = 110;
				bytes[offset + 2] = 70;
				bytes[offset + 3] = 255;
			}
		}
		require('node:fs').writeFileSync(source, nativeImage.createFromBitmap(bytes, { width: 1600, height: 800, scaleFactor: 1 }).toPNG());
	}, source);
	const original = await page.evaluate(() => window.nectisse.subscriptions.getState());
	const actor = original.subscriptions.find((sub) => sub.provider === 'javdb');
	const creator = original.subscriptions.find((sub) => sub.provider === 'fanbox');
	await openProfile(page, actor.name);
	assert.equal(await page.getByRole('button', { name: '关注设置', exact: true }).count(), 0);
	assert.equal(await page.getByRole('button', { name: '检查更新', exact: true }).count(), 1);
	assert.equal(await page.getByRole('dialog').count(), 0);
	await select(source);
	const uploaded = await page.evaluate(() => window.nectisse.subscriptions.getState());
	const manual = uploaded.subscriptions.find((sub) => sub.id === actor.id).manualAvatarAsset;
	assert.ok(manual);
	assert.equal(manual.width, 512);
	assert.equal(manual.height, 512);
	assert.deepEqual(uploaded.subscriptions.find((sub) => sub.id === actor.id).avatarAsset, actor.avatarAsset);
	await avatarReady(manual.sha256);
	await page.getByRole('button', { name: '恢复站点头像', exact: true }).waitFor();
	const crop = await app.evaluate(({ nativeImage }, { profile, hash }) => {
		const require = process.getBuiltinModule('module').createRequire(process.execPath);
		const image = nativeImage.createFromPath(require('node:path').join(profile, 'images/objects', `${hash}.image`));
		const bytes = image.toBitmap();
		return { size: image.getSize(), first: [...bytes.subarray(0, 3)], last: [...bytes.subarray(bytes.length - 4, bytes.length - 1)] };
	}, { profile, hash: manual.sha256 });
	assert.deepEqual(crop.size, { width: 512, height: 512 });
	assert.ok(Math.abs(crop.first[0] - 170) < 8 && Math.abs(crop.last[0] - 170) < 8, '按中心裁切，保留中间区域');
	const picker = await app.evaluate(() => globalThis.__avatarTest.options[0]);
	assert.deepEqual(picker.properties, ['openFile']);
	assert.deepEqual(picker.filters[0].extensions, ['png', 'jpg', 'jpeg', 'webp']);
	await select(undefined);
	await select(invalid);
	await page.getByText('请选择 PNG、JPEG 或 WebP 图片', { exact: true }).waitFor();
	assert.equal((await page.evaluate(() => window.nectisse.subscriptions.getState())).subscriptions.find((sub) => sub.id === actor.id).manualAvatarAsset.sha256, manual.sha256);
	await openPeople(page, 'actors', 'browse');
	const actorCard = page.getByRole('button', { name: `查看${actor.name}的主页`, exact: true });
	assert.ok((await actorCard.locator('img').getAttribute('src')).includes(manual.sha256));
	await openProfile(page, creator.name, 'creators');
	await select(source);
	await avatarReady(manual.sha256);
	const both = await page.evaluate(() => window.nectisse.subscriptions.getState());
	assert.equal(both.subscriptions.find((sub) => sub.id === creator.id).manualAvatarAsset.sha256, manual.sha256, '同图共用');
	await rm(source);
	await page.evaluate(() => window.nectisse.storage.clear());
	await avatarReady(manual.sha256);
	await app.close();
	app = undefined;
	await launch();
	await openProfile(page, actor.name);
	await avatarReady(manual.sha256);
	await openProfile(page, creator.name, 'creators');
	await avatarReady(manual.sha256);
	for (const width of [1000, 1600]) {
		await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 840), width);
		await page.waitForFunction((width) => innerWidth === width, width);
		for (const theme of ['cream', 'night']) {
			await page.evaluate((theme) => window.nectisse.subscriptions.command({ action: 'preferences-patch', patch: { theme } }), theme);
			await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
			await page.locator('[data-sonner-toast] [data-close-button]').evaluateAll((buttons) => buttons.forEach((button) => button.click()));
			const layout = await page.locator('.creator-profile-navigation').evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return { left: rect.left, right: rect.right, actions: element.lastElementChild.getBoundingClientRect().toJSON(), bodyWidth: document.documentElement.scrollWidth };
			});
			assert.ok(layout.actions.right <= layout.right + 1 && layout.actions.left >= layout.left);
			assert.equal(layout.bodyWidth, width);
			await page.screenshot({ path: join(output, `${theme}-${width}.png`) });
		}
	}
	await page.getByRole('button', { name: '恢复站点头像', exact: true }).click();
	await page.getByRole('button', { name: '上传头像', exact: true }).waitFor();
	const restored = await page.evaluate(() => window.nectisse.subscriptions.getState());
	assert.equal(restored.subscriptions.find((sub) => sub.id === creator.id).manualAvatarAsset, undefined);
	assert.deepEqual(restored.subscriptions.find((sub) => sub.id === creator.id).avatarAsset, creator.avatarAsset);
	assert.equal(restored.subscriptions.find((sub) => sub.id === actor.id).manualAvatarAsset.sha256, manual.sha256);
	assert.equal(await page.getByRole('dialog').count(), 0);
	assert.equal(await page.getByRole('button', { name: '检查更新', exact: true }).count(), 1);
	assert.deepEqual(errors, []);
	assert.deepEqual(await app.evaluate(() => globalThis.__avatarTest.requests), []);
	await writeFile(join(output, 'result.json'), JSON.stringify({ ok: true, manual, crop, checks: ['native picker bridge', 'center crop', 'cancel and invalid file', 'actor and creator', 'shared file', 'cache clear', 'restart', 'restore source avatar', 'no duplicate settings', 'two widths and themes'] }, null, 2));
	console.log(JSON.stringify({ ok: true, app: appPath ?? 'development', output }));
} finally {
	await app?.close();
	await rm(profile, { recursive: true, force: true });
}

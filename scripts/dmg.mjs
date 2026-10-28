import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readlink, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { releaseCommand } from './release-signing.mjs';

export async function verifyDmgLayout(mount, metadata) {
	const config = metadata.config.bundle.macOS.dmg;
	const background = resolve('src-tauri', config.background);
	assert.ok((await readFile(join(mount, '.background/background.png'))).equals(await readFile(background)), 'DMG background differs from the configured artwork.');
	assert.equal(await readlink(join(mount, 'Applications')), '/Applications');
	const settings = await readFile(join(mount, '.DS_Store'));
	for (const marker of ['icvp', 'bwsp', 'Iloc']) {
		assert.ok(settings.includes(Buffer.from(marker)), `Missing Finder layout record: ${marker}`);
	}
}

export async function createDmg(app, destination, metadata, staging, env) {
	const config = metadata.config.bundle.macOS.dmg;
	const { windowSize: size, windowPosition: origin, appPosition: appIcon, applicationFolderPosition: folderIcon } = config;
	for (const value of [size.width, size.height, origin.x, origin.y, appIcon.x, appIcon.y, folderIcon.x, folderIcon.y]) {
		assert.ok(Number.isInteger(value) && value >= 0 && value <= 4096, 'Invalid DMG window geometry.');
	}
	const installerRoot = join(staging, 'installer');
	const mount = join(staging, 'mounted');
	const writable = join(staging, 'installer-rw.dmg');
	await mkdir(join(installerRoot, '.background'), { recursive: true });
	await mkdir(mount);
	await releaseCommand('/usr/bin/ditto', [app, join(installerRoot, 'Nectisse.app')], env);
	await copyFile(resolve('src-tauri', config.background), join(installerRoot, '.background/background.png'));
	await symlink('/Applications', join(installerRoot, 'Applications'));
	await releaseCommand('/usr/bin/hdiutil', ['create', '-volname', 'Nectisse', '-srcfolder', installerRoot, '-fs', 'HFS+', '-format', 'UDRW', '-ov', writable], env);
	let mounted = false;
	try {
		await releaseCommand('/usr/bin/hdiutil', ['attach', '-readwrite', '-noautoopen', '-nobrowse', '-mountpoint', mount, writable], env);
		mounted = true;
		const { stdout } = await releaseCommand(
			'/usr/bin/osascript',
			[
				resolve('scripts/dmg-layout.applescript'),
				mount,
				join(mount, '.background/background.png'),
				...[origin.x, origin.y, size.width, size.height, appIcon.x, appIcon.y, folderIcon.x, folderIcon.y].map(String),
			],
			env,
		);
		assert.deepEqual(
			stdout.trim().split(', ').map(Number),
			[origin.x, origin.y, origin.x + size.width, origin.y + size.height, appIcon.x, appIcon.y, folderIcon.x, folderIcon.y],
			'Finder did not save the configured installer layout.',
		);
		await verifyDmgLayout(mount, metadata);
	} finally {
		if (mounted) {
			await releaseCommand('/usr/bin/hdiutil', ['detach', mount], env);
		}
	}
	await releaseCommand('/usr/bin/hdiutil', ['convert', writable, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', '-o', destination], env);
}

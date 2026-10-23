import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('macOS 开发包需在 Mac 上构建');
const root = fileURLToPath(new URL('..', import.meta.url));
const packaging = join(root, '.build/packaging');
await mkdir(packaging, { recursive: true });
const staging = await mkdtemp(join(packaging, 'mac-'));
const outputName = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
const destination = join(root, 'dist', outputName);
const target = join(destination, 'Nectisse.app');
const backup = join(staging, 'previous.app');
let backedUp = false;
let installed = false;
try {
	// Build outside the Finder-visible output directory: its .DS_Store may be
	// recreated while electron-builder recursively cleans an earlier build.
	execFileSync(
		process.execPath,
		[
			join(root, 'node_modules/electron-builder/cli.js'),
			'--config',
			'electron-builder.config.mjs',
			`--config.directories.output=${staging}`,
			'--mac',
			'dir',
			'--publish',
			'never',
		],
		{ cwd: root, stdio: 'inherit' },
	);
	const completed = join(staging, outputName, 'Nectisse.app');
	await access(join(completed, 'Contents/MacOS/Nectisse'));
	await mkdir(destination, { recursive: true });
	try {
		await access(target);
		backedUp = true;
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	if (backedUp) await rename(target, backup);
	try {
		await rename(completed, target);
		installed = true;
	} catch (error) {
		if (backedUp) {
			await rename(backup, target);
			backedUp = false;
		}
		throw error;
	}
	console.log(`开发包已更新：${target}\n若旧版仍在运行，请先 ⌘Q 退出再打开新版。`);
} finally {
	// On a failed replacement retain the only recoverable prior application.
	if (installed || !backedUp) await rm(staging, { recursive: true, force: true });
}

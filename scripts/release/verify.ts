import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { command, unsignedMode } from './command';
import { archiveNames, readReleaseMetadata, verifyReleaseFiles } from './metadata';
import { verifyMacApp, verifyNotarizedApp } from './app';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
	throw new Error('安装包验收需要 macOS arm64');
}
const root = process.cwd();
const unsigned = unsignedMode();
const metadata = await readReleaseMetadata(root, process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined, unsigned);
const team = unsigned ? undefined : process.env.APPLE_TEAM_ID;
if (!unsigned && (!team || !/^[A-Z\d]{10}$/.test(team))) {
	throw new Error('正式安装包验收需要 APPLE_TEAM_ID');
}
await verifyReleaseFiles(metadata);
const [dmg, zip] = archiveNames(metadata.version).map((name) => join(metadata.directory, name)) as [string, string];
await command('hdiutil', ['verify', dmg]);
if (!unsigned) {
	await command('codesign', ['--verify', '--strict', dmg]);
	await command('xcrun', ['stapler', 'validate', dmg]);
	await command('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', dmg]);
}
const acceptance = join(root, '.build/release-acceptance');
await mkdir(acceptance, { recursive: true });
const temporary = await mkdtemp(join(acceptance, 'mac-'));
try {
	const extracted = join(temporary, 'extracted');
	await command('ditto', ['-x', '-k', zip, extracted]);
	const app = join(extracted, 'Nectisse.app');
	if (!unsigned) {
		await command('xattr', ['-w', 'com.apple.quarantine', `0081;${Math.floor(Date.now() / 1000).toString(16)};GitHubActions;${randomUUID()}`, app]);
	}
	await verifyMacApp(app, root, metadata.version, team);
	if (!unsigned) {
		await verifyNotarizedApp(app);
	}
	const env = { ...process.env };
	for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'BUILD_CERTIFICATE_BASE64', 'P12_PASSWORD', 'CSC_KEYCHAIN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
		delete env[name];
	}
	console.log('验收应用启动、本地数据、单实例、窗口唤回与退出');
	const { stdout } = await command(process.execPath, ['scripts/smoke-desktop.mjs', app], env, true);
	process.stdout.write(stdout);
	await verifyMacApp(app, root, metadata.version, team);
	const mount = join(temporary, 'mounted');
	await mkdir(mount);
	await command('hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mount]);
	try {
		const installed = join(temporary, 'installed/Nectisse.app');
		await command('ditto', [join(mount, 'Nectisse.app'), installed]);
		await verifyMacApp(installed, root, metadata.version, team);
		if (!unsigned) {
			await verifyNotarizedApp(installed);
		}
	} finally {
		await command('hdiutil', ['detach', mount]);
	}
	console.log('最终 ZIP 与 DMG 中的应用、随包 Python 和桌面回归验收通过');
} finally {
	await rm(temporary, { recursive: true, force: true });
}

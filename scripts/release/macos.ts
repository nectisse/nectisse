import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Arch, build, Platform } from 'electron-builder';
import { command, unsignedMode } from './command';
import { archiveNames, fileChecksum, readReleaseMetadata, verifyReleaseFiles } from './metadata';
import { nativeBinaries, notarize, signingIdentity, stapler, verifyMacApp } from './app';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
	throw new Error('首版安装包构建需要 macOS arm64');
}
const root = process.cwd();
const unsigned = unsignedMode();
const metadata = await readReleaseMetadata(root, process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined, unsigned);
let team: string | undefined;
let identity: string | undefined;
const keychain = process.env.CSC_KEYCHAIN ?? '';
if (!unsigned) {
	for (const name of ['APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'CSC_KEYCHAIN']) {
		if (!process.env[name]?.trim()) {
			throw new Error(`缺少 ${name}，正式构建不会降级为未签名`);
		}
	}
	team = process.env.APPLE_TEAM_ID!;
	if (!/^[A-Z\d]{10}$/.test(team)) {
		throw new Error('APPLE_TEAM_ID 必须是十位大写字母或数字');
	}
	const { stdout } = await command('security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
	identity = signingIdentity(stdout, team);
	if (!identity) {
		throw new Error('临时钥匙串缺少指定团队的 Developer ID Application 证书与私钥');
	}
	await command('xcrun', [
		'notarytool',
		'store-credentials',
		'nectisse-notary',
		'--apple-id',
		process.env.APPLE_ID!,
		'--team-id',
		team,
		'--password',
		process.env.APPLE_APP_SPECIFIC_PASSWORD!,
		'--keychain',
		keychain,
	]);
}
const packaging = join(root, '.build/release-packaging');
await mkdir(packaging, { recursive: true });
const staging = await mkdtemp(join(packaging, 'mac-'));
try {
	const base = (await import(pathToFileURL(join(root, 'electron-builder.config.mjs')).href)).default;
	const python = join(root, '.build/python/darwin-arm64');
	const binaries = (await nativeBinaries(python)).map((file) => join('Contents/Resources/python', relative(python, file)));
	await build({
		targets: Platform.MAC.createTarget('dir', Arch.arm64),
		publish: 'never',
		config: {
			...base,
			directories: { ...base.directories, output: join(staging, 'app') },
			buildVersion: metadata.version,
			forceCodeSigning: !unsigned,
			mac: {
				...base.mac,
				identity: identity ?? null,
				notarize: false,
				hardenedRuntime: !unsigned,
				type: 'distribution',
				preAutoEntitlements: false,
				entitlements: 'resources/entitlements.mac.plist',
				entitlementsInherit: 'resources/entitlements.mac.plist',
				binaries: unsigned ? [] : binaries,
			},
		},
	});
	const app = join(staging, 'app/mac-arm64/Nectisse.app');
	await verifyMacApp(app, root, metadata.version, team);
	if (!unsigned) {
		const submission = join(staging, 'notarization.zip');
		await command('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, submission]);
		await notarize(submission, keychain);
		await stapler('staple', app);
	}
	const [dmgName, zipName] = archiveNames(metadata.version) as [string, string];
	const zip = join(staging, zipName);
	await command('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
	await command('unzip', ['-t', '-qq', zip]);
	const source = join(staging, 'dmg-source');
	await mkdir(source);
	await command('ditto', [app, join(source, 'Nectisse.app')]);
	await symlink('/Applications', join(source, 'Applications'));
	const dmg = join(staging, dmgName);
	await command('hdiutil', ['create', '-volname', 'Nectisse', '-srcfolder', source, '-format', 'UDZO', dmg]);
	if (!unsigned) {
		await command('codesign', ['--sign', identity!, '--keychain', keychain, '--timestamp', dmg]);
		await notarize(dmg, keychain);
		await stapler('staple', dmg);
	}
	await command('hdiutil', ['verify', dmg]);
	await mkdir(metadata.directory, { recursive: true });
	const sums: string[] = [];
	for (const name of [dmgName, zipName]) {
		sums.push(`${await fileChecksum(join(staging, name))}  ${name}`);
		await copyFile(join(staging, name), join(metadata.directory, name));
	}
	await writeFile(join(metadata.directory, 'SHA256SUMS'), sums.join('\n') + '\n');
	await verifyReleaseFiles(metadata);
	console.log(`${unsigned ? '未签名预览' : '签名与公证'}安装包已生成：${relative(root, metadata.directory)}`);
} finally {
	await rm(staging, { recursive: true, force: true });
}

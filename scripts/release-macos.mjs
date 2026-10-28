import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, readFile, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { nativeBinaries } from './native-binaries.mjs';
import { verifyApplication } from './verify-package.mjs';
import { readReleaseMetadata, writeReleaseFiles, verifyReleaseFiles } from './release-metadata.mjs';
import { prepareSigning, releaseCommand, notarize, verifySignature } from './release-signing.mjs';

const exec = promisify(execFile);
const unsigned = process.argv.length === 3 && process.argv[2] === '--unsigned';
const signOnly = process.argv.length === 3 && process.argv[2] === '--sign-only';
assert.ok(process.argv.length === 2 || unsigned || signOnly, 'Use --unsigned for previews or --sign-only for a signed app.');
assert.notEqual(process.env.GITHUB_ACTIONS, 'true', 'Release artifacts are built locally.');
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const metadata = await readReleaseMetadata(resolve('.'), { unsigned });
if (!unsigned) {
	assert.equal((await exec('git', ['status', '--porcelain'])).stdout.trim(), '', 'Commit source changes before preparing a signed release.');
}
const updateKey = signOnly ? '' : process.env.TAURI_SIGNING_PRIVATE_KEY || (await readFile(join(homedir(), '.config/nectisse/updater.key'), 'utf8'));
const revision = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
const frozenFiles = ['package.json', 'package-lock.json', 'src-tauri/Cargo.lock', 'src-tauri/resources/contracts.json'];
const beforeBuild = await Promise.all(frozenFiles.map((file) => readFile(file)));
await mkdir(resolve('.build'), { recursive: true });
const staging = await mkdtemp(resolve('.build/release-'));
let preserveStaging = false;
const buildEnv = { ...process.env };
for (const name of [
	'GH_TOKEN',
	'GITHUB_TOKEN',
	'BUILD_CERTIFICATE_BASE64',
	'P12_PASSWORD',
	'TAURI_SIGNING_PRIVATE_KEY',
	'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
	'APPLE_ID',
	'APPLE_APP_SPECIFIC_PASSWORD',
	'APPLE_PASSWORD',
	'APPLE_API_KEY',
	'APPLE_API_ISSUER',
	'APPLE_API_KEY_PATH',
]) {
	delete buildEnv[name];
}
try {
	const signing = unsigned ? undefined : await prepareSigning({ validateProfile: !signOnly });
	if (signing) {
		buildEnv.APPLE_SIGNING_IDENTITY = signing.identity;
		if (signing.keychain) {
			buildEnv.APPLE_SIGNING_KEYCHAIN = signing.keychain;
		}
	}
	console.log('Preparing the bundled runtime and icons locally.');
	await releaseCommand('npm', ['run', 'icons:build'], buildEnv);
	console.log('Signing nested Python executables and libraries.');
	for (const binary of await nativeBinaries(resolve('.build/python/darwin-arm64'))) {
		await releaseCommand(
			'/usr/bin/codesign',
			[
				'--force',
				'--sign',
				signing?.fingerprint ?? '-',
				...(signing?.keychain ? ['--keychain', signing.keychain] : []),
				...(signing ? ['--timestamp'] : []),
				'--options',
				'runtime',
				...(binary.includes('/bin/') ? ['--entitlements', resolve('src-tauri/Entitlements.plist')] : []),
				binary,
			],
			buildEnv,
		);
	}
	console.log('Building the production application locally.');
	const config = JSON.stringify({ bundle: { createUpdaterArtifacts: false, macOS: { signingIdentity: signing?.identity ?? '-', hardenedRuntime: true } } });
	await releaseCommand(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', 'app', '--config', config], buildEnv);
	for (const [index, file] of frozenFiles.entries()) {
		assert.ok(beforeBuild[index].equals(await readFile(file)), `${file} changed during the build; regenerate and commit it before release.`);
	}
	assert.equal((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), revision, 'Source commit changed during the build.');
	if (!unsigned) {
		assert.equal((await exec('git', ['status', '--porcelain'])).stdout.trim(), '', 'Source changed during the signed build.');
	}
	const bundle = resolve('src-tauri/target/release/bundle');
	const app = join(bundle, 'macos/Nectisse.app');
	if (signing) {
		await verifySignature(app, signing.teamId, true);
		await verifyApplication(app, { teamId: signing.teamId });
	}
	if (signOnly) {
		console.log(`Signed application prepared; notarization has not been performed: ${app}`);
	} else {
		const candidate = join(staging, 'distribution');
		await mkdir(candidate);
		if (signing) {
			console.log('Submitting the signed application to Apple notarization.');
			const zip = join(staging, 'notarization.zip');
			await releaseCommand('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip], buildEnv);
			await notarize(zip, signing, app);
		}
		const installerRoot = join(staging, 'installer');
		await mkdir(installerRoot);
		await releaseCommand('/usr/bin/ditto', [app, join(installerRoot, 'Nectisse.app')], buildEnv);
		await symlink('/Applications', join(installerRoot, 'Applications'));
		const dmg = join(candidate, metadata.archives[0]);
		console.log('Creating the final DMG from the stapled application.');
		await releaseCommand('/usr/bin/hdiutil', ['create', '-volname', 'Nectisse', '-srcfolder', installerRoot, '-format', 'UDZO', '-ov', dmg], buildEnv);
		if (signing) {
			await releaseCommand('/usr/bin/codesign', [
				'--force',
				'--sign',
				signing.fingerprint,
				...(signing.keychain ? ['--keychain', signing.keychain] : []),
				'--timestamp',
				dmg,
			]);
			console.log('Submitting the final signed DMG to Apple notarization.');
			await notarize(dmg, signing);
		}
		await releaseCommand('/usr/bin/tar', ['--format', 'ustar', '-czf', join(candidate, metadata.archives[1]), '-C', join(bundle, 'macos'), 'Nectisse.app'], {
			...buildEnv,
			COPYFILE_DISABLE: '1',
		});
		await releaseCommand(
			process.execPath,
			['node_modules/@tauri-apps/cli/tauri.js', 'signer', 'sign', '--app-version', metadata.version, join(candidate, metadata.archives[1])],
			{ ...buildEnv, TAURI_SIGNING_PRIVATE_KEY: updateKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '' },
		);
		await writeReleaseFiles(metadata, candidate, revision, signing?.teamId);
		await verifyReleaseFiles(metadata, candidate);
		console.log('Verifying the extracted updater and mounted DMG locally.');
		await releaseCommand(process.execPath, ['scripts/verify-release.mjs', ...(unsigned ? ['--unsigned'] : []), '--directory', candidate], {
			...buildEnv,
			...(signing ? { APPLE_TEAM_ID: signing.teamId } : {}),
		});
		await mkdir(resolve(metadata.directory, '..'), { recursive: true });
		const previous = join(staging, 'previous');
		let replaced = false;
		try {
			await rename(metadata.directory, previous);
			replaced = true;
		} catch (error) {
			if (error.code !== 'ENOENT') {
				throw error;
			}
		}
		try {
			await rename(candidate, metadata.directory);
		} catch (error) {
			if (replaced) {
				try {
					await rename(previous, metadata.directory);
				} catch {
					preserveStaging = true;
				}
			}
			throw error;
		}

		console.log(`Verified ${metadata.tag}: ${metadata.directory}`);
	}
} finally {
	if (!preserveStaging) {
		await rm(staging, { recursive: true, force: true });
	} else {
		console.error(`Previous release retained at ${join(staging, 'previous')}`);
	}
}

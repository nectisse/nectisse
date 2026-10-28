import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readReleaseMetadata, verifyReleaseFiles } from './release-metadata.mjs';
import { releaseCommand, verifySignature, verifySignedDmg, signingIdentity } from './release-signing.mjs';
import { verifyApplication } from './verify-package.mjs';

const arguments_ = process.argv.slice(2);
let unsigned = false;
let directory;
for (let index = 0; index < arguments_.length; index++) {
	if (arguments_[index] === '--unsigned' && !unsigned) {
		unsigned = true;
	} else if (arguments_[index] === '--directory' && directory === undefined) {
		directory = arguments_[++index];
		assert.ok(directory, 'Missing distribution directory.');
	} else {
		throw new Error('Use --unsigned and optionally --directory <path>.');
	}
}
const metadata = await readReleaseMetadata(resolve('.'), { unsigned });
if (directory !== undefined) {
	metadata.directory = resolve(directory);
}
const manifest = await verifyReleaseFiles(metadata);
const temporary = await mkdtemp(join(tmpdir(), 'nectisse-verify-'));
const mount = join(temporary, 'mounted');
await mkdir(mount);
let mounted = false;
try {
	const archive = join(metadata.directory, metadata.archives[1]);
	const entries = (await releaseCommand('/usr/bin/tar', ['-tzf', archive])).stdout.trim().split('\n');
	assert.ok(
		entries.length > 5 && entries.every((name) => (name === 'Nectisse.app/' || name.startsWith('Nectisse.app/')) && !name.split('/').includes('..') && !name.includes('/._')),
		'Invalid updater archive structure.',
	);
	await releaseCommand('/usr/bin/tar', ['-xzf', archive, '-C', temporary]);
	const application = join(temporary, 'Nectisse.app');
	const digest = await verifyApplication(application, { teamId: unsigned ? undefined : manifest.teamId });
	if (!unsigned) {
		assert.equal(manifest.teamId, process.env.APPLE_TEAM_ID || (await signingIdentity()).teamId, 'Apple team differs from the configured release team.');
		await verifySignature(application, manifest.teamId, true);
		await releaseCommand('/usr/bin/xcrun', ['stapler', 'validate', application]);
		await releaseCommand('/usr/sbin/spctl', ['--assess', '--type', 'execute', application]);
	}
	const installer = join(metadata.directory, metadata.archives[0]);
	await releaseCommand('/usr/bin/hdiutil', ['verify', installer]);
	if (!unsigned) {
		await verifySignedDmg(installer, manifest.teamId);
	}
	await releaseCommand('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, installer]);
	mounted = true;
	const mountedApp = join(mount, 'Nectisse.app');
	assert.equal(await verifyApplication(mountedApp, { teamId: unsigned ? undefined : manifest.teamId }), digest, 'DMG and updater archive differ.');
	if (!unsigned) {
		await verifySignature(mountedApp, manifest.teamId, true);
		await releaseCommand('/usr/bin/xcrun', ['stapler', 'validate', mountedApp]);
	}
	console.log(
		`PASS: ${metadata.tag}, extracted updater + mounted DMG, native resources, notices, signatures, signed version and checksums${unsigned ? ' (local ad-hoc preview)' : ', Apple notarization and Gatekeeper'}.`,
	);
} finally {
	if (mounted) {
		await releaseCommand('/usr/bin/hdiutil', ['detach', mount]);
	}
	await rm(temporary, { recursive: true, force: true });
}

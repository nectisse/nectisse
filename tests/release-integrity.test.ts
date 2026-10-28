import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { readReleaseMetadata, verifyReleaseFiles, writeReleaseFiles } from '../scripts/release-metadata.mjs';
import { verifyUpdateSignature } from '../scripts/update-signature.mjs';
import { publishRelease } from '../scripts/github-release.mjs';

const execute = promisify(execFile);

test('更新包绑定版本并拒绝篡改，即使重新计算校验清单也不能绕过签名', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-signature-test-'));
	const cli = async (args: string[], env = process.env) => {
		try {
			await execute(process.execPath, [resolve('node_modules/@tauri-apps/cli/tauri.js'), ...args], { env, timeout: 30000 });
		} catch {
			throw new Error('Tauri interoperability fixture failed; private output withheld.');
		}
	};

	try {
		const metadata = await readReleaseMetadata();
		const key = join(root, 'throwaway.key');
		await cli(['signer', 'generate', '--ci', '--password', '', '--write-keys', key]);
		const publicKey = (await readFile(`${key}.pub`, 'utf8')).trim();
		const archive = join(root, 'fixture.app.tar.gz');
		const bytes = Buffer.from('Independent Tauri CLI interoperability fixture.');
		await writeFile(archive, bytes);
		await cli(['signer', 'sign', '--app-version', metadata.version, archive], {
			...process.env,
			TAURI_SIGNING_PRIVATE_KEY: await readFile(key, 'utf8'),
			TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
		});
		const signature = (await readFile(`${archive}.sig`, 'utf8')).trim();
		verifyUpdateSignature(bytes, signature, publicKey, metadata.version);
		assert.throws(() => verifyUpdateSignature(Buffer.from('changed bytes'), signature, publicKey, metadata.version), /signature/);
		assert.throws(() => verifyUpdateSignature(bytes, signature, publicKey, '99.0.0'), /Signed version/);
		const edited = Buffer.from(Buffer.from(signature, 'base64').toString().replace(`version:${metadata.version}`, 'version:99.0.0')).toString('base64');
		assert.throws(() => verifyUpdateSignature(bytes, edited, publicKey, '99.0.0'), /trusted comment/);
		const distribution = join(root, 'distribution');
		await mkdir(distribution);
		metadata.config.plugins.updater.pubkey = publicKey;
		await writeFile(join(distribution, metadata.archives[0]), 'DMG fixture');
		await writeFile(join(distribution, metadata.archives[1]), bytes);
		await writeFile(join(distribution, metadata.archives[2]), signature);
		await writeReleaseFiles(metadata, distribution, 'a'.repeat(40), 'ABCDEFGHIJ');
		assert.equal((await verifyReleaseFiles(metadata, distribution)).version, metadata.version);
		await writeFile(join(distribution, metadata.archives[1]), 'replaced archive');
		await writeReleaseFiles(metadata, distribution, 'a'.repeat(40), 'ABCDEFGHIJ');
		await assert.rejects(verifyReleaseFiles(metadata, distribution), /signature/);
		await assert.rejects(readReleaseMetadata(resolve('.'), { tag: 'v99.0.0' }), /tag/);
		await assert.rejects(
			publishRelease({ unsigned: true }, 'a'.repeat(40), 'nectisse/nectisse', 'unused', () => assert.fail('must not publish')),
			/Unsigned/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

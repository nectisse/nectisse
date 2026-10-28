import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);

export async function localReleaseSettings() {
	try {
		return parseEnv(await readFile(join(homedir(), '.config/nectisse/release.env'), 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') {
			return {};
		}
		throw new Error('Cannot read the local release configuration.');
	}
}

export async function releaseCommand(tool, arguments_, env = process.env, { run = execute, wait = delay } = {}) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await run(tool, arguments_, { env, maxBuffer: 32 * 1024 * 1024, timeout: 45 * 60 * 1000 });
		} catch (cause) {
			const timestampFailure =
				tool === '/usr/bin/codesign' &&
				arguments_.includes('--timestamp') &&
				/timestamp service is not available|A timestamp was expected but was not found/i.test(cause.stderr ?? '');
			// Retry only temporary timestamp failures; never weaken the signature requirements.
			if (timestampFailure && attempt < 4) {
				console.log(`Apple timestamp service unavailable; retrying signature (${attempt + 1}/4).`);
				await wait((attempt + 1) * 3000);
				continue;
			}
			const error = new Error(
				`${tool} failed during release verification${timestampFailure ? ': Apple timestamp service unavailable' : ''}. Arguments and output were withheld to protect credentials.`,
			);
			error.exitCode = typeof cause.code === 'number' ? cause.code : undefined;
			throw error;
		}
	}
}

export async function signingIdentity(env = process.env) {
	const local = await localReleaseSettings();
	const keychain = env.CSC_KEYCHAIN || local.CSC_KEYCHAIN;
	const team = env.APPLE_TEAM_ID || local.APPLE_TEAM_ID;
	const requested = env.APPLE_SIGNING_IDENTITY || local.APPLE_SIGNING_IDENTITY;
	if (team) {
		assert.match(team, /^[A-Z\d]{10}$/);
	}
	const { stdout } = await releaseCommand('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', ...(keychain ? [keychain] : [])]);
	const identities = new Map();
	for (const match of stdout.matchAll(/([A-Fa-f0-9]{40})\s+"(Developer ID Application: [^"\r\n]+ \(([A-Z0-9]{10})\))"/g)) {
		if ((!team || match[3] === team) && (!requested || requested === match[1] || requested === match[2])) {
			identities.set(match[1], { fingerprint: match[1], identity: match[2], teamId: match[3] });
		}
	}
	assert.equal(identities.size, 1, 'Choose one Developer ID certificate with APPLE_SIGNING_IDENTITY / APPLE_TEAM_ID / CSC_KEYCHAIN.');
	return { ...identities.values().next().value, keychain };
}

export async function prepareSigning({ validateProfile = true } = {}, env = process.env) {
	const local = await localReleaseSettings();
	const signing = await signingIdentity(env);
	const profile = env.NECTISSE_NOTARY_PROFILE || local.NECTISSE_NOTARY_PROFILE || 'nectisse-notary';
	const notaryKeychain = env.NECTISSE_NOTARY_KEYCHAIN || local.NECTISSE_NOTARY_KEYCHAIN;
	assert.match(profile, /^[A-Za-z0-9._-]{1,100}$/);
	if (validateProfile) {
		try {
			await releaseCommand('/usr/bin/xcrun', [
				'notarytool',
				'history',
				'--keychain-profile',
				profile,
				...(notaryKeychain ? ['--keychain', notaryKeychain] : []),
				'--output-format',
				'json',
			]);
		} catch {
			throw new Error(`Local notarization profile ${profile} is unavailable. Configure it with xcrun notarytool store-credentials; no new certificate is required.`);
		}
	}
	return { ...signing, profile, notaryKeychain };
}

export async function stapler(operation, path) {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await releaseCommand('/usr/bin/xcrun', ['stapler', operation, path]);
			return;
		} catch (error) {
			if (![68, 69, 75].includes(error.exitCode) || attempt === 2) {
				throw error;
			}
			await delay((attempt + 1) * 10000);
		}
	}
}

export async function notarize(path, signing, staplePath = path) {
	const { stdout } = await releaseCommand('/usr/bin/xcrun', [
		'notarytool',
		'submit',
		path,
		'--keychain-profile',
		signing.profile,
		...(signing.notaryKeychain ? ['--keychain', signing.notaryKeychain] : []),
		'--wait',
		'--output-format',
		'json',
	]);
	assert.equal(JSON.parse(stdout).status, 'Accepted', 'Apple notarization was not accepted.');
	await stapler('staple', staplePath);
	await stapler('validate', staplePath);
}

export async function verifySignature(path, teamId, runtime = false) {
	const { stderr } = await releaseCommand('/usr/bin/codesign', ['--display', '--verbose=4', path]);
	assert.ok(stderr.includes(`TeamIdentifier=${teamId}`) && stderr.includes('Authority=Developer ID Application:'), 'Unexpected Developer ID signature or Apple team.');
	assert.match(stderr, /^Timestamp=.+/m, 'Developer ID signatures require a secure timestamp.');
	assert.ok(!runtime || /flags=.*\(runtime\)/.test(stderr), 'Application must use Hardened Runtime.');
	await releaseCommand('/usr/bin/codesign', ['--verify', '--strict', path]);
}

export async function verifySignedDmg(path, teamId) {
	await verifySignature(path, teamId);
	await stapler('validate', path);
	await releaseCommand('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', path]);
}

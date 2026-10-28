import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readReleaseMetadata, verifyReleaseFiles, updateManifest, repository as distributionRepository } from './release-metadata.mjs';
import { ensureReleaseAbsent, readReleaseTarget, releaseRepository, verifyUploadedDraft } from './github-release-api.mjs';

const execute = promisify(execFile);

export async function publishRelease(metadata, commit, repository, token, run) {
	assert.equal(metadata.unsigned, false, 'Unsigned previews cannot publish a release.');
	const manifest = await verifyReleaseFiles(metadata);
	assert.equal(manifest.sourceRevision, commit, 'Release artifacts do not match the source commit.');
	const files = [...metadata.archives, updateManifest, 'RELEASE-NOTES.md', 'release-manifest.json', 'SHA256SUMS'].map((name) => join(metadata.directory, name));
	await readReleaseTarget(repository, metadata.tag, commit, token);
	await ensureReleaseAbsent(repository, metadata.tag, token);
	await run([
		'release',
		'create',
		metadata.tag,
		'--repo',
		repository,
		'--verify-tag',
		'--draft',
		'--target',
		commit,
		'--title',
		`Nectisse ${metadata.version}`,
		'--notes-file',
		metadata.notes,
		...files,
	]);
	await verifyUploadedDraft(repository, metadata.tag, token, files);
	await readReleaseTarget(repository, metadata.tag, commit, token);
	await run(['release', 'edit', metadata.tag, '--repo', repository, '--draft=false', '--latest']);
}

async function githubToken() {
	if (process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()) {
		return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	}
	try {
		const result = await execute('gh', ['auth', 'token', '--hostname', 'github.com']);
		if (result.stdout.trim()) {
			return result.stdout.trim();
		}
	} catch {}
	const output = await new Promise((done, reject) => {
		const child = execFile('git', ['credential', 'fill'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' }, (error, stdout) =>
			error ? reject(new Error('GitHub authentication unavailable; run gh auth login.')) : done(stdout),
		);
		child.stdin.end('protocol=https\nhost=github.com\n\n');
	});
	const token = output
		.split('\n')
		.find((line) => line.startsWith('password='))
		?.slice(9);
	assert.ok(token, 'GitHub authentication unavailable; run gh auth login.');
	return token;
}

async function main() {
	const mode = process.argv[2];
	assert.ok(['prepare', 'publish'].includes(mode) && process.argv.length === 3, 'Use prepare or publish.');
	assert.notEqual(process.env.GITHUB_ACTIONS, 'true', 'Upload verified local artifacts from the publishing Mac.');
	const metadata = await readReleaseMetadata(resolve('.'));
	assert.equal((await execute('git', ['status', '--porcelain'])).stdout.trim(), '', 'Commit source changes before publishing.');
	const repository = releaseRepository();
	assert.equal(repository, distributionRepository, 'Release repository differs from the updater endpoint.');
	const token = await githubToken();
	const commit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
	await ensureReleaseAbsent(repository, metadata.tag, token);
	if (mode === 'prepare') {
		console.log(`Ready to build ${metadata.tag} locally; no release or draft exists.`);
		return;
	}
	await verifyReleaseFiles(metadata);
	await execute(process.execPath, ['scripts/verify-release.mjs'], {
		env: { ...process.env, APPLE_TEAM_ID: JSON.parse(await readFile(join(metadata.directory, 'release-manifest.json'), 'utf8')).teamId },
		maxBuffer: 4 * 1024 * 1024,
		timeout: 10 * 60 * 1000,
	});
	await publishRelease(metadata, commit, repository, token, async (arguments_) => {
		try {
			await execute('gh', arguments_, { env: { ...process.env, GH_TOKEN: token, GH_DEBUG: '' }, maxBuffer: 4 * 1024 * 1024 });
		} catch {
			throw new Error('GitHub upload failed. Inspect any remaining draft; existing releases are never overwritten.');
		}
	});
	console.log(`Published https://github.com/${repository}/releases/tag/${metadata.tag}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}

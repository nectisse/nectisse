import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { archiveNames, fileChecksum, readReleaseMetadata, verifyReleaseFiles } from '../scripts/release/metadata';
import { GitHubReleases, publishRelease } from '../scripts/release/github';
import { command, unsignedMode } from '../scripts/release/command';
import { signingIdentity } from '../scripts/release/app';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-release-test-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, '.github/release-notes'), { recursive: true });
	await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
	await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' } } }));
	await writeFile(join(root, '.github/release-notes/0.1.0.md'), '# Nectisse 0.1.0\n\n第一个版本。\n');
	const metadata = await readReleaseMetadata(root, 'v0.1.0');
	await mkdir(metadata.directory, { recursive: true });
	const sums: string[] = [];
	for (const name of archiveNames(metadata.version)) {
		const path = join(metadata.directory, name);
		await writeFile(path, `archive ${name}`);
		sums.push(`${await fileChecksum(path)}  ${name}`);
	}
	await writeFile(join(metadata.directory, 'SHA256SUMS'), sums.join('\n') + '\n');
	return { root, metadata };
}

function api(responses: Response[]): GitHubReleases {
	return new GitHubReleases('release-fixture-token', async () => {
		const response = responses.shift();
		assert.ok(response, '不应派发额外请求');
		return response;
	});
}

test('只选择指定团队的 Developer ID Application 证书，拒绝开发与安装器证书', () => {
	const hash = 'A'.repeat(40);
	const other = 'B'.repeat(40);
	const output = `1) ${other} "Developer ID Application: Example (OTHER12345)"\n2) ${hash} "Developer ID Application: Example (TEAM123456)"\n`;
	assert.equal(signingIdentity(output, 'TEAM123456'), hash);
	assert.equal(signingIdentity(output, 'MISSING123'), undefined);
	for (const type of ['Apple Development', 'Developer ID Installer', 'Apple Distribution']) {
		assert.equal(signingIdentity(`1) ${hash} "${type}: Example (TEAM123456)"`, 'TEAM123456'), undefined);
	}
});

test('敏感命令失败不回显参数、环境和子进程输出', async () => {
	const secret = 'release-fixture-private-value';
	await assert.rejects(command(process.execPath, ['-e', 'console.error(process.argv[1]); process.exit(1)', secret]), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.ok(!error.message.includes(secret) && !error.message.includes('console.error'));
		return true;
	});
});

test('发布标签、锁文件和说明必须对应同一版本；预览不能冒充标签发布', async (t) => {
	const { root } = await fixture(t);
	await assert.rejects(readReleaseMetadata(root, 'v0.2.0'), /不一致/);
	await assert.rejects(readReleaseMetadata(root, 'v../../escape'), /不一致/);
	await writeFile(join(root, '.github/release-notes/0.1.0.md'), ' \n');
	await assert.rejects(readReleaseMetadata(root), /不能为空/);
	await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '0.2.0' }));
	await assert.rejects(readReleaseMetadata(root), /版本不一致/);
	assert.equal(unsignedMode(['--unsigned'], {}), true);
	assert.throws(() => unsignedMode(['--unsigned'], { GITHUB_REF_TYPE: 'tag' }), /不能跳过/);
	assert.throws(() => unsignedMode(['--publish'], {}), /仅支持/);
});

test('分发文件只接受本版的完整归档与校验和，拒绝损坏、额外文件和符号链接', async (t) => {
	const { metadata } = await fixture(t);
	assert.equal((await verifyReleaseFiles(metadata)).length, 3);
	const archive = join(metadata.directory, archiveNames(metadata.version)[0]!);
	const bytes = await readFile(archive);
	await writeFile(archive, 'corrupted');
	await assert.rejects(verifyReleaseFiles(metadata), /SHA256/);
	await writeFile(archive, bytes);
	const extra = join(metadata.directory, 'unexpected.env');
	await writeFile(extra, 'fixture');
	await assert.rejects(verifyReleaseFiles(metadata), /只包含/);
	await rm(extra);
	await rm(archive);
	await symlink(join(metadata.directory, 'SHA256SUMS'), archive);
	await assert.rejects(verifyReleaseFiles(metadata), /无效/);
});

test('仓库转为私有时停止；缺少认证、限流和 API 失败不能被当作可发布', async () => {
	await assert.rejects(api([Response.json({ private: true })]).requirePublicRepository(), /仅允许公开/);
	const unauthenticated = new GitHubReleases('', async () => {
		assert.fail('缺少认证不应派发请求');
	});
	await assert.rejects(unauthenticated.requirePublicRepository(), /缺少/);
	for (const status of [403, 429, 500]) {
		await assert.rejects(api([new Response(undefined, { status })]).requireAbsent('v0.1.0'), new RegExp(`HTTP ${status}`));
	}
});

test('分页检查已有草稿，避免覆盖或重复发布', async () => {
	const release = { tag_name: 'v0.1.0', draft: true, prerelease: false, assets: [] };
	const client = api([Response.json(Array.from({ length: 100 }, () => ({ ...release, tag_name: 'v9.9.9' }))), Response.json([release])]);
	await assert.rejects(client.requireAbsent('v0.1.0'), /草稿已存在/);
});

test('只在三个附件名称、大小、状态和 SHA256 全部核对后公开草稿', async (t) => {
	const { metadata } = await fixture(t);
	const files = await verifyReleaseFiles(metadata);
	const assets = await Promise.all(
		files.map(async (file) => ({ name: basename(file), size: (await readFile(file)).length, state: 'uploaded', digest: `sha256:${await fileChecksum(file)}` })),
	);
	const release = { tag_name: metadata.tag, draft: true, prerelease: false, assets };
	for (const invalid of [false, 'incomplete', 'digest'] as const) {
		const uploaded = structuredClone(release);
		if (invalid === 'incomplete') {
			uploaded.assets[0]!.size++;
		} else if (invalid === 'digest') {
			uploaded.assets[0]!.digest = `sha256:${'f'.repeat(64)}`;
		}
		const client = api([Response.json({ private: false }), Response.json([]), Response.json([uploaded])]);
		const commands: string[][] = [];
		const publishing = publishRelease(metadata, client, async (args) => {
			commands.push(args);
		});
		if (invalid) {
			await assert.rejects(publishing, /停止公开/);
			assert.equal(commands.length, 1);
		} else {
			await publishing;
			assert.equal(commands.length, 2);
			assert.ok(commands[0]!.includes('--verify-tag') && commands[0]!.includes('--draft'));
			assert.deepEqual(commands[1], ['release', 'edit', metadata.tag, '--repo', 'nectisse/nectisse', '--draft=false', '--latest']);
		}
	}
});

test('发布工作流仅公开仓库标签或手动触发，使用标准 runner 且不消耗 artifact 与依赖缓存空间', async () => {
	const { load } = createRequire(import.meta.url)('js-yaml');
	const source = await readFile('.github/workflows/release-macos.yml', 'utf8');
	const workflow = load(source);
	assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
	assert.deepEqual(Object.keys(workflow.on.push), ['tags']);
	assert.equal(workflow.jobs.release['runs-on'], 'macos-15');
	assert.equal(workflow.jobs.release['timeout-minutes'], 45);
	assert.match(workflow.jobs.release.if, /github\.event\.repository\.private == false/);
	assert.equal(workflow.concurrency.group, 'nectisse-macos-release');
	assert.equal(workflow.concurrency['cancel-in-progress'], false);
	assert.doesNotMatch(source, /upload-artifact|actions\/cache|cache: npm|schedule:/);
	assert.ok(source.indexOf('Remove signing material') < source.indexOf('Verify extracted applications'));
	const publishing = workflow.jobs.release.steps.find((step: { name?: string }) => step.name === 'Publish verified files directly to GitHub Release');
	assert.equal(publishing.if, "github.event_name == 'push'");
	const config = await readFile('electron-builder.config.mjs', 'utf8');
	assert.doesNotMatch(config, /docs\//, '干净检出后的打包不能依赖本地 docs');
});

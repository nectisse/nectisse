import { appendFile, lstat } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { command } from './command';
import { fileChecksum, readReleaseMetadata, verifyReleaseFiles, type ReleaseMetadata } from './metadata';

const repository = 'nectisse/nectisse';
const releaseSchema = z.object({
	tag_name: z.string(),
	draft: z.boolean(),
	prerelease: z.boolean(),
	assets: z.array(z.object({ name: z.string(), size: z.number(), state: z.string(), digest: z.string().nullable().optional() })),
});

export class GitHubReleases {
	constructor(
		private token: string,
		private request: typeof fetch = fetch,
	) {}

	async requirePublicRepository(): Promise<void> {
		const result = z.object({ private: z.boolean() }).parse(await this.get(''));
		if (result.private) {
			throw new Error('此发布流程仅允许公开仓库，避免消耗私有仓库 Actions 额度');
		}
	}

	async find(tag: string): Promise<z.infer<typeof releaseSchema> | undefined> {
		for (let page = 1; page <= 1000; page++) {
			const releases = z.array(releaseSchema).parse(await this.get(`/releases?per_page=100&page=${page}`));
			const release = releases.find((item) => item.tag_name === tag);
			if (release || releases.length < 100) {
				return release;
			}
		}
		throw new Error('Release 列表过长，无法确认发布状态');
	}

	async requireAbsent(tag: string): Promise<void> {
		if (await this.find(tag)) {
			throw new Error(`${tag} 的 Release 或草稿已存在，不覆盖已有文件`);
		}
	}

	async verifyDraft(metadata: ReleaseMetadata, files: string[]): Promise<void> {
		const release = await this.find(metadata.tag);
		if (
			!release?.draft ||
			release.prerelease ||
			release.assets
				.map((asset) => asset.name)
				.sort()
				.join('\n') !==
				files
					.map((path) => basename(path))
					.sort()
					.join('\n')
		) {
			throw new Error('草稿版本或上传文件列表不一致，停止公开');
		}
		for (const file of files) {
			const asset = release.assets.find((item) => item.name === basename(file));
			if (asset?.state !== 'uploaded' || asset.size !== (await lstat(file)).size) {
				throw new Error(`文件未完整上传，停止公开：${basename(file)}`);
			}
			if (asset.digest && asset.digest !== `sha256:${await fileChecksum(file)}`) {
				throw new Error(`上传文件 SHA256 不一致，停止公开：${basename(file)}`);
			}
		}
	}

	private async get(path: string): Promise<unknown> {
		if (!this.token.trim()) {
			throw new Error('缺少 GitHub 发布凭据');
		}
		const response = await this.request(`https://api.github.com/repos/${repository}${path}`, {
			headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'User-Agent': 'nectisse-release', 'X-GitHub-Api-Version': '2026-03-10' },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`无法读取 GitHub 发布状态：HTTP ${response.status}`);
		}
		return response.json();
	}
}

export async function publishRelease(metadata: ReleaseMetadata, api: GitHubReleases, run: (args: string[]) => Promise<void>): Promise<void> {
	await api.requirePublicRepository();
	await api.requireAbsent(metadata.tag);
	const files = await verifyReleaseFiles(metadata);
	await run([
		'release',
		'create',
		metadata.tag,
		'--repo',
		repository,
		'--verify-tag',
		'--draft',
		'--title',
		`Nectisse ${metadata.version}`,
		'--notes-file',
		metadata.notes,
		...files,
	]);
	await api.verifyDraft(metadata, files);
	await run(['release', 'edit', metadata.tag, '--repo', repository, '--draft=false', '--latest']);
}

async function main(): Promise<void> {
	const mode = process.argv[2];
	const preview = process.env.RELEASE_PREVIEW === 'true';
	if (!['prepare', 'publish'].includes(mode ?? '') || (preview && mode !== 'prepare')) {
		throw new Error('仅支持发布预检 prepare、正式发布 publish；预览不能发布');
	}
	if (process.env.GITHUB_REPOSITORY !== repository || (!preview && (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF_TYPE !== 'tag'))) {
		throw new Error('正式发布仅接受本仓库的版本标签推送');
	}
	const metadata = await readReleaseMetadata(process.cwd(), preview ? undefined : (process.env.GITHUB_REF_NAME ?? ''), preview);
	const api = new GitHubReleases(process.env.GH_TOKEN ?? '');
	if (mode === 'prepare') {
		await api.requirePublicRepository();
		if (!preview) {
			await api.requireAbsent(metadata.tag);
		}
		if (!process.env.GITHUB_OUTPUT) {
			throw new Error('缺少 GitHub Actions 输出路径');
		}
		await appendFile(process.env.GITHUB_OUTPUT, `version=${metadata.version}\ndirectory=${relative(process.cwd(), metadata.directory)}\n`);
		return;
	}
	await publishRelease(metadata, api, async (args) => {
		await command('gh', args);
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}

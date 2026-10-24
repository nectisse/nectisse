import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface ReleaseMetadata {
	version: string;
	tag: string;
	directory: string;
	notes: string;
}

export async function readReleaseMetadata(root: string, tag?: string, preview = false): Promise<ReleaseMetadata> {
	const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
	const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
	const version: unknown = manifest.version;
	if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
		throw new Error('发布需要不带预发布后缀的三段版本号');
	}
	if (lock.version !== version || lock.packages?.['']?.version !== version) {
		throw new Error('package.json 与 package-lock.json 的版本不一致');
	}
	if (tag !== undefined && tag !== `v${version}`) {
		throw new Error(`标签 ${tag} 与应用版本 ${version} 不一致`);
	}
	const notes = join(root, '.github', 'release-notes', `${version}.md`);
	if (!(await readFile(notes, 'utf8')).trim()) {
		throw new Error('发布说明不能为空');
	}
	return { version, tag: `v${version}`, notes, directory: join(root, 'dist', 'releases', ...(preview ? ['preview'] : []), version, 'macos', 'arm64') };
}

export function archiveNames(version: string): string[] {
	return [`Nectisse-${version}-mac-arm64.dmg`, `Nectisse-${version}-mac-arm64.zip`];
}

export async function fileChecksum(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const bytes of createReadStream(path)) {
		hash.update(bytes);
	}
	return hash.digest('hex');
}

export async function verifyReleaseFiles(metadata: ReleaseMetadata): Promise<string[]> {
	const archives = archiveNames(metadata.version);
	const names = (await readdir(metadata.directory)).sort();
	const expected = [...archives, 'SHA256SUMS'].sort();
	if (names.join('\n') !== expected.join('\n')) {
		throw new Error('分发目录必须只包含本版 DMG、ZIP 和 SHA256SUMS');
	}
	for (const name of names) {
		const stat = await lstat(join(metadata.directory, name));
		if (!stat.isFile() || stat.size === 0 || stat.size >= 2 * 1024 ** 3) {
			throw new Error(`分发文件无效或达到 GitHub 单文件上限：${name}`);
		}
	}
	const checksums = (await readFile(join(metadata.directory, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/).sort();
	const actual = await Promise.all(archives.map(async (name) => `${await fileChecksum(join(metadata.directory, name))}  ${name}`));
	if (checksums.join('\n') !== actual.sort().join('\n')) {
		throw new Error('安装包 SHA256 校验失败');
	}
	return expected.map((name) => join(metadata.directory, name));
}

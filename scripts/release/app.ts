import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './command';

const machMagic = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

export function signingIdentity(output: string, team: string): string | undefined {
	for (const line of output.split('\n')) {
		const match = line.match(/([A-Fa-f0-9]{40})\s+"Developer ID Application: ([^"\r\n]+)"/);
		if (match?.[2]?.endsWith(` (${team})`)) {
			return match[1];
		}
	}
}

export async function nativeBinaries(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const name of (await readdir(directory)).sort()) {
		const path = join(directory, name);
		const stat = await lstat(path);
		if (stat.isDirectory()) {
			result.push(...(await nativeBinaries(path)));
		} else if (stat.isFile() && ((stat.mode & 0o111) !== 0 || /\.(?:so|dylib|node)$/.test(name))) {
			const file = await open(path, 'r');
			try {
				const header = Buffer.alloc(4);
				const { bytesRead } = await file.read(header, 0, 4, 0);
				if (bytesRead === 4 && machMagic.has(header.readUInt32BE(0))) {
					result.push(path);
				}
			} finally {
				await file.close();
			}
		}
	}
	return result;
}

export async function verifyMacApp(app: string, root: string, version: string, team?: string): Promise<void> {
	const contents = join(app, 'Contents');
	for (const [key, value] of [
		['CFBundleIdentifier', 'app.nectisse.desktop'],
		['CFBundleShortVersionString', version],
		['CFBundleVersion', version],
		['CFBundleExecutable', 'Nectisse'],
	]) {
		const { stdout } = await command('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, join(contents, 'Info.plist')]);
		if (stdout.trim() !== value) {
			throw new Error(`应用 ${key} 不一致`);
		}
	}
	const main = join(contents, 'MacOS/Nectisse');
	if ((await command('lipo', ['-archs', main])).stdout.trim() !== 'arm64') {
		throw new Error('首版分发只接受 macOS arm64');
	}
	if (!(await readFile(join(contents, 'Resources/icon.icns'))).equals(await readFile(join(root, 'resources/icons/icon.icns')))) {
		throw new Error('应用图标不一致');
	}
	for (const resource of ['third-party/components.json', 'third-party/folia-wall.json', 'python/app/vendor/PEACH-LICENSE', 'python/app/vendor/amane/LICENSE']) {
		if (!(await readFile(join(contents, 'Resources', resource))).length) {
			throw new Error('应用缺少第三方许可或复用声明');
		}
	}
	const python = join(contents, 'Resources/python');
	const binaries = await nativeBinaries(python);
	if (!binaries.some((file) => /\/bin\/python3\.14$/.test(file)) || !binaries.some((file) => file.includes('/curl_cffi/'))) {
		throw new Error('随包 Python 或指纹连接原生依赖不完整');
	}
	for (const binary of binaries) {
		if (!(await command('lipo', ['-archs', binary])).stdout.trim().split(/\s+/).includes('arm64')) {
			throw new Error('随包 Python 中存在不支持 arm64 的原生文件');
		}
		if (team) {
			await command('codesign', ['--verify', '--strict', binary]);
			if (!(await command('codesign', ['--display', '--verbose=4', binary])).stderr.includes(`TeamIdentifier=${team}`)) {
				throw new Error('随包 Python 原生文件未由同一团队签名');
			}
		}
	}
	const probe = 'import sys; sys.path.insert(0, sys.argv[1]); import httpx, curl_cffi, PIL._imaging, lxml.etree, pydantic_core; print(sys.version.split()[0])';
	const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
	const { stdout } = await command(join(python, 'runtime/bin/python3'), ['-I', '-S', '-B', '-c', probe, join(python, 'dependencies')], env);
	if (stdout.trim() !== (await readFile(join(root, '.python-version'), 'utf8')).trim()) {
		throw new Error('随包 Python 版本不一致');
	}
	if (team) {
		const signature = (await command('codesign', ['--display', '--verbose=4', app])).stderr;
		if (!signature.includes(`TeamIdentifier=${team}`) || !signature.includes('Authority=Developer ID Application:') || !/flags=.*\(runtime\)/.test(signature)) {
			throw new Error('应用缺少指定团队的 Hardened Runtime Developer ID 签名');
		}
		await command('codesign', ['--verify', '--deep', '--strict', app]);
	}
	console.log(`应用版本、图标、许可与 ${binaries.length} 个随包 Python 原生文件验证通过`);
}

export async function notarize(path: string, keychain: string): Promise<void> {
	const { stdout } = await command('xcrun', ['notarytool', 'submit', path, '--keychain-profile', 'nectisse-notary', '--keychain', keychain, '--wait', '--output-format', 'json']);
	if (JSON.parse(stdout).status !== 'Accepted') {
		throw new Error('Apple 公证未通过');
	}
}

export async function verifyNotarizedApp(app: string): Promise<void> {
	await command('xcrun', ['stapler', 'validate', app]);
	await command('spctl', ['--assess', '--verbose=2', '--type', 'execute', app]);
}

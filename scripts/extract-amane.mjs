// 固定快照中仅提取八个已被 Peach 开放的爬虫和其纯依赖；不启动上游服务。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const revision = 'cc42cee6ecf290cf05af1caa347d2dc2d5aeffcd';
const cache = join(root, '.cache/amane');
await mkdir(cache, { recursive: true });
const archive = join(cache, 'source.tar.gz');
try { await readFile(archive); } catch {
	execFileSync('/usr/bin/curl', ['--fail', '--location', '--max-time', '60', '--output', archive, `https://codeload.github.com/sqzw-x/amane/tar.gz/${revision}`], { stdio: 'inherit' });
}
const archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
if (archiveSha256 !== '6f34ece2db62f4e22f68c931c8a6862415c9d7cba12bad1fd658ec8c56d9cab2') throw new Error('amane 固定快照哈希不一致');
execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', cache, '--strip-components=1']);
const files = ['enums.py', 'crawlers/base.py', 'crawlers/http.py', 'crawlers/models.py', 'crawlers/parsing.py', 'net/errors.py', 'net/connectivity.py', 'plugins/models.py', 'utils/dates.py', ...['official', 'prestige', 'faleno', 'dahlia', 'mgstage', 'avsox', 'freejavbt', 'airav', 'wp_works'].map(name => `crawlers/sites/${name}.py`)];
const target = join(root, 'python/vendor/amane');
const records = [];
for (const file of files) {
	const body = await readFile(join(cache, 'src/amane', file));
	await mkdir(dirname(join(target, file)), { recursive: true });
	await writeFile(join(target, file), body);
	records.push({ path: file, upstreamSha256: createHash('sha256').update(body).digest('hex') });
}
for (const folder of ['', 'crawlers', 'crawlers/sites', 'net', 'plugins', 'utils']) {
	await writeFile(join(target, folder, '__init__.py'), '"""Nectisse 的 amane 0.20.0 资料爬虫子集；无服务、数据库或全站注册副作用。"""\n');
}
await writeFile(join(target, 'LICENSE'), await readFile(join(cache, 'LICENSE')));
await writeFile(join(root, 'python/vendor/amane-extraction.json'), JSON.stringify({ version: '0.20.0', revision, archiveSha256, license: 'GPL-3.0', records, modifications: ['包 __init__.py 使用无副作用入口，站点与纯模型文件保持原样', '运行时注入 Nectisse 有界客户端，不使用上游下载、重试或网络调度'] }, null, 2) + '\n');
console.log(`已提取 amane ${revision.slice(0, 12)} 的八个来源及 ${files.length} 个文件。`);

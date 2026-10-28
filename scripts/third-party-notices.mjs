import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const check = process.argv.includes('--check');
assert.ok(
	process.argv.slice(2).every((argument) => argument === '--check'),
	'Only --check is supported.',
);
const root = resolve('.');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const expected = new Map();
const rows = [];
const licensePattern = /^(licen[sc]e|copying|notice|copyright)([.\-_]|$)/i;

async function include(path, contents) {
	expected.set(path, contents);
	if (check) {
		assert.deepEqual(await readFile(join(root, path)), contents, `${path} is stale; run npm run licenses:generate.`);
	} else {
		await mkdir(resolve(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), contents);
	}
}

for (const [location, metadata] of Object.entries(lock.packages)) {
	if (!location || metadata.dev || metadata.devOptional) {
		continue;
	}
	const directory = join(root, location);
	const installed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
	assert.equal(installed.version, metadata.version, `${location} differs from the lockfile; run npm ci.`);
	assert.equal(installed.license, metadata.license, `${location} has conflicting license metadata.`);
	const files = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && licensePattern.test(entry.name))
		.sort((a, b) => a.name.localeCompare(b.name, 'en'));
	const notices = await Promise.all(files.map((entry) => readFile(join(directory, entry.name))));
	if (['react-remove-scroll-bar', 'lazy-val'].includes(installed.name) && notices.length === 0) {
		notices.push(await readFile(join(root, `resources/licenses/upstream/${installed.name}-MIT.txt`)));
	}
	assert.ok(notices.length > 0, `${installed.name} has no license text; review the upstream license before regenerating.`);
	assert.ok(metadata.license, `${installed.name} has no declared license.`);
	const links = [];
	for (const contents of notices) {
		const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
		const path = `resources/licenses/npm/${digest}.txt`;
		await include(path, contents);
		links.push(`[${installed.name === 'lucide-react' ? 'ISC + MIT (Feather)' : metadata.license}](${path})`);
	}
	rows.push(`| ${installed.name} | ${installed.version} | ${links.join(' · ')} |`);
}

const metadata = JSON.parse(
	execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'aarch64-apple-darwin', '--manifest-path', 'src-tauri/Cargo.toml'], {
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
	}),
);
const used = new Set(metadata.resolve.nodes.map((node) => node.id));
const rustRows = [];
for (const pkg of metadata.packages.filter((pkg) => pkg.source && used.has(pkg.id)).sort((a, b) => a.name.localeCompare(b.name))) {
	const directory = dirname(pkg.manifest_path);
	const candidates = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && licensePattern.test(entry.name))
		.map((entry) => join(directory, entry.name))
		.sort();
	if (pkg.license_file && !candidates.includes(join(directory, pkg.license_file))) {
		candidates.push(join(directory, pkg.license_file));
	}
	const links = [];
	if (!candidates.length) {
		const license =
			pkg.name === 'alloc-stdlib'
				? 'alloc-stdlib-BSD-3-Clause.txt'
				: pkg.license?.includes('MIT')
					? 'standard-MIT-terms.txt'
					: pkg.license === 'MPL-2.0'
						? 'MPL-2.0.txt'
						: null;
		assert.ok(license, `${pkg.name} ${pkg.version} has no license text; inspect its upstream source.`);
		const headers = [];
		for (const filename of (await readdir(directory, { recursive: true })).sort()) {
			if (filename.endsWith('.rs')) {
				const lines = (await readFile(join(directory, filename), 'utf8')).split('\n').filter((line) => /copyright|SPDX-License-Identifier/i.test(line));
				if (lines.length) {
					headers.push(`${filename}:\n${lines.join('\n')}`);
				}
			}
		}
		const declaration = `Package: ${pkg.name} ${pkg.version}\nRepository: ${pkg.repository}\nLicense declared by upstream: ${pkg.license}\nAuthors (Cargo metadata): ${pkg.authors.join('; ')}\n\nThe published crate omits a standalone license file. Its original Cargo manifest, README and source copyright/license headers are retained below, followed by the declared license's standard terms. No copyright year is inferred.\n\n${await readFile(pkg.manifest_path, 'utf8')}\n\n${pkg.readme ? await readFile(join(directory, pkg.readme), 'utf8') : ''}\n\n${headers.join('\n\n')}\n\n${await readFile(join(root, 'resources/licenses/upstream', license), 'utf8')}`;
		const digest = createHash('sha256').update(declaration).digest('hex').slice(0, 16);
		const path = `resources/licenses/rust/${digest}.txt`;
		await include(path, Buffer.from(declaration));
		links.push(`[declaration, original notices and terms](${path})`);
	}
	for (const file of candidates) {
		const contents = await readFile(file);
		const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
		const path = `resources/licenses/rust/${digest}.txt`;
		await include(path, contents);
		links.push(`[${basename(file)}](${path})`);
	}
	rustRows.push(`| ${pkg.name} | ${pkg.version} | ${pkg.license ?? 'See license file'} | ${links.join(' · ')} |`);
	if (pkg.license === 'MPL-2.0') {
		const archive = join(directory, '..', '..', '..', 'cache', basename(dirname(directory)), `${pkg.name}-${pkg.version}.crate`);
		await include(`resources/licenses/sources/${pkg.name}-${pkg.version}.crate`, await readFile(archive));
	}
}
const contents = `# Third-party notices / 第三方声明

Nectisse retains the original licenses and copyrights of the dependencies below. Upstream license terms continue to apply. Full upstream texts are included at the linked local paths.

Nectisse 保留下列依赖的原始许可与版权。第三方原许可授予的权利继续适用；完整原文附于下列本地链接。

## Frontend dependencies / 前端依赖

All production packages in package-lock.json, including transitive packages, are listed conservatively, even when compilation removes unused code.

| Package / 软件包 | Version / 版本 | License and notices / 许可与声明 |
| --- | --- | --- |
${rows.join('\n')}

## Rust dependencies / Rust 依赖

The locked Cargo dependency graph for macOS Apple Silicon is included conservatively, including its build tools and procedural macros. Cargo.lock pins the exact versions. System frameworks, system WebKit and fonts are supplied by macOS and are not redistributed.

Where upstream crates omit standalone license files, the inventory retains their declared license, authors, original manifest, README and source copyright/license headers alongside the declared license's standard terms. No copyright years are invented. The alloc-stdlib BSD notice comes from its exact upstream [commit](https://github.com/dropbox/rust-alloc-no-stdlib/blob/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE). Unmodified source archives for MPL-2.0 crates are included under resources/licenses/sources/; their original MPL terms continue to apply.

下表覆盖 Cargo.lock 中 macOS Apple Silicon 依赖图，包括构建工具与过程宏。系统框架、WebKit 和字体由 macOS 提供，本项目不附带这些系统组件。

| Crate | Version / 版本 | Declared license / 声明许可 | Full texts / 完整原文 |
| --- | --- | --- | --- |
${rustRows.join('\n')}

# 第三方组件说明

## Folia 拼贴模板

收藏照片墙的四套矩形拼贴模板经 Peach 的 \`frontend/src/react/video-wall/folia/blockTemplates.ts\` 适配，原始项目为 <https://github.com/chthollyphile/folia-major>，固定 revision \`9a01e788ed52d25ea01b1f0d37934e5e371ae82b\`，AGPL-3.0。来源与改动范围随应用保存在 \`Contents/Resources/third-party/folia-wall.json\`，许可证全文位于 \`Contents/Resources/python/app/vendor/PEACH-LICENSE\`。Nectisse 仅采用有限收藏封面的拼贴几何，镜头、预览与收藏数据接到自身界面，不包含上游播放器与队列。

## Peach

本项目包含 Peach 0.46.1 本地快照中的传输、编号规则、直接资料连接器、三个 Seesaa Wiki 解析，资料身份与跨作品封面判断片段，以及 FANBOX 正文、Patreon 公开卡片、JavDB 演员卡与目录解析。归档站列表按照该快照适配，仅收集发布资料及封面。另包含 FC2PPV-DB 浏览器验证与会话复用所需的 Peach 浏览器传输片段，以及 Sukebei 表格查询适配中复用的编号规则。项目：<https://github.com/peach-mitao/peach>。

来源、格式化变化、适配修改与 SHA-256 见 \`python/vendor/UPSTREAM.md\`、\`metadata-extraction.json\`、\`follow-extraction.json\` 和 \`browser-extraction.json\`；AGPL-3.0-or-later 许可证全文见 \`python/vendor/PEACH-LICENSE\`。打包应用中对应文件位于 \`Contents/Resources/python/app/vendor/\`。进程边界不改变上游许可证义务；正式分发前应随交付提供适用许可证要求的对应源码和构建说明。

## Python 和网络依赖

Python 运行时由 uv 获取 python-build-standalone 的 CPython 3.14.9 发行物，随应用携带，不在用户启动时下载。运行时及其捆绑组件的许可证保留在 \`Contents/Resources/python/runtime/\`。

Python 依赖版本与完整性哈希锁定在 \`python/requirements.lock\`；包含 HTTPX、httpcore、curl_cffi、cffi、certifi、socksio、Beautiful Soup、Pillow 等。其 wheel 自带的许可证及元数据保留在 \`Contents/Resources/python/dependencies/\`，不裁剪 \`.dist-info\`。

## amane

包含 amane 0.20.0 固定 revision \`cc42cee6ecf290cf05af1caa347d2dc2d5aeffcd\` 中 Peach 实际开放的八个资料来源爬虫与纯模型依赖。项目：<https://github.com/sqzw-x/amane>，GPL-3.0。完整许可证保留于 \`python/vendor/amane/LICENSE\`；提取清单、快照与逐文件哈希见 \`python/vendor/amane-extraction.json\`。包入口替换为无服务、数据库与全站注册副作用的入口，爬虫文件保持原实现；运行时注入 Nectisse 的有界客户端。构建可通过 \`scripts/extract-amane.mjs\` 重现。

新增 parsel、lxml、pydantic、structlog 及其依赖均由 \`python/requirements.lock\` 固定版本和完整性哈希；各 wheel 的许可证与元数据一同打包。

## Distribution

Release source and build information: [.github/SOURCE.md](.github/SOURCE.md).

macOS WebKit and system frameworks are not redistributed. This package contains no Electron or Node.js runtime. All linked license texts are included in Nectisse.app/Contents/Resources/legal/.
`;
await include('THIRD_PARTY_NOTICES.md', Buffer.from(contents));
for (const group of ['npm', 'rust']) {
	const directory = join(root, 'resources/licenses', group);
	await mkdir(directory, { recursive: true });
	for (const filename of await readdir(directory)) {
		const path = `resources/licenses/${group}/${filename}`;
		if (!expected.has(path)) {
			assert.ok(!check, `${path} is obsolete; run npm run licenses:generate.`);
			await rm(join(root, path));
		}
	}
}
console.log(`${check ? 'Verified' : 'Generated'} notices for ${rows.length} npm packages and ${rustRows.length} Rust crates.`);

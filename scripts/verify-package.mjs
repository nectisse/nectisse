import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { nativeBinaries } from './native-binaries.mjs';

const exec = promisify(execFile);
const bundle = resolve('src-tauri/target/release/bundle');
const application = join(bundle, 'macos/Nectisse.app');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const installer = join(bundle, `dmg/Nectisse_${version}_aarch64.dmg`);
const digest = async (path) =>
	createHash('sha256')
		.update(await readFile(path))
		.digest('hex');

export async function verifyApplication(app, { teamId } = {}) {
	const resources = join(app, 'Contents/Resources');
	const binary = join(app, 'Contents/MacOS/nectisse-app');
	const info = JSON.parse((await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')])).stdout);
	assert.equal(info.CFBundleIdentifier, 'app.nectisse.desktop');
	assert.equal(info.CFBundleShortVersionString, version);
	assert.ok((await exec('/usr/bin/file', [binary])).stdout.includes('arm64'));
	await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
	assert.equal(await digest(join(resources, info.CFBundleIconFile)), await digest('resources/icons/icon.icns'));
	for (const file of ['THIRD_PARTY_NOTICES.md', '.github/SOURCE.md']) {
		assert.equal(await digest(join(resources, 'legal', file)), await digest(file));
	}
	for (const name of await readdir('resources/licenses', { recursive: true })) {
		const source = join('resources/licenses', name);
		if ((await stat(source)).isFile()) {
			assert.equal(await digest(join(resources, 'legal', source)), await digest(source), `Packaged notice differs: ${name}`);
		}
	}
	const strings = (await exec('/usr/bin/strings', [binary], { maxBuffer: 32 * 1024 * 1024 })).stdout;
	for (const marker of ['smoke_report', 'smoke_snapshot', 'NECTISSE_SMOKE_OUTPUT', 'electron-updater']) {
		assert.ok(!strings.includes(marker), `Production binary contains ${marker}`);
	}
	assert.ok(!(await readdir(join(app, 'Contents/Frameworks')).catch(() => [])).some((name) => /electron|chromium/i.test(name)));
	const python = join(resources, 'python');
	const binaries = await nativeBinaries(python);
	assert.ok(binaries.some((file) => file.endsWith('/bin/python3.14')));
	assert.ok(binaries.some((file) => file.includes('/curl_cffi/')));
	for (const file of binaries) {
		assert.ok((await exec('/usr/bin/lipo', ['-archs', file])).stdout.trim().split(/\s+/).includes('arm64'));
		await exec('/usr/bin/codesign', ['--verify', '--strict', file]);
		if (teamId) {
			assert.ok((await exec('/usr/bin/codesign', ['--display', '--verbose=4', file])).stderr.includes(`TeamIdentifier=${teamId}`));
		}
	}
	const probe = 'import sys; sys.path.insert(0,sys.argv[1]); import httpx,curl_cffi,PIL._imaging,lxml.etree,pydantic_core; print(sys.version.split()[0])';
	const health = await exec(join(python, 'runtime/bin/python3'), ['-I', '-S', '-B', '-c', probe, join(python, 'dependencies')], {
		env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
	});
	assert.equal(health.stdout.trim(), (await readFile('.python-version', 'utf8')).trim());
	for (const name of ['third-party/components.json', 'third-party/folia-wall.json', 'python/app/vendor/PEACH-LICENSE', 'python/app/vendor/amane/LICENSE']) {
		assert.ok((await readFile(join(resources, name))).length > 0);
	}
	return digest(binary);
}

async function main() {
	await mkdir('work', { recursive: true });
	const executableHash = await verifyApplication(application);
	await exec('/usr/bin/hdiutil', ['verify', installer]);
	const mount = resolve('work/dmg-mount');
	await mkdir(mount, { recursive: true });
	await exec('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, installer]);
	try {
		assert.equal(await verifyApplication(join(mount, 'Nectisse.app')), executableHash);
	} finally {
		await exec('/usr/bin/hdiutil', ['detach', mount]);
	}
	let appBytes = 0;
	for (const name of await readdir(application, { recursive: true })) {
		const file = await stat(join(application, name));
		if (file.isFile()) {
			appBytes += file.size;
		}
	}
	const report = { version, application, installer, appBytes, dmgBytes: (await stat(installer)).size, sha256: await digest(installer), executableHash };
	await writeFile('work/package-report.json', JSON.stringify(report, null, 2) + '\n');
	console.log(
		`PASS: app + mounted DMG, arm64, code signature, native icon catalog, legal notices, identical executables, and test hooks excluded. App ${(appBytes / 1048576).toFixed(2)} MiB; DMG ${(report.dmgBytes / 1048576).toFixed(2)} MiB.`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}

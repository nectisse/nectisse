import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeBinaries } from './native-binaries.mjs';

const execute = promisify(execFile);
export const runtimeProfile = 'headless-2';

export async function prunePythonRuntime(root, version) {
	const runtime = join(root, 'runtime');
	const pythonVersion = version.split('.').slice(0, 2).join('.');
	const library = join(runtime, 'lib', `python${pythonVersion}`);
	const executable = join(runtime, 'python-interpreter');
	await copyFile(join(runtime, 'bin', `python${pythonVersion}`), executable);
	await rm(join(runtime, 'bin'), { recursive: true, force: true });
	await mkdir(join(runtime, 'bin'));
	// Tauri dereferences resource symlinks. Ship one real interpreter at the worker's stable path.
	await rename(executable, join(runtime, 'bin/python3'));
	for (const name of ['include', 'share']) {
		await rm(join(runtime, name), { recursive: true, force: true });
	}
	for (const name of await readdir(join(runtime, 'lib'))) {
		if (/^(?:libpython.*\.dylib|libtcl.*\.dylib|tcl[\d.]|tk[\d.]|itcl[\d.]|thread[\d.]|pkgconfig$)/.test(name)) {
			await rm(join(runtime, 'lib', name), { recursive: true, force: true });
		}
	}
	for (const name of ['site-packages', 'ensurepip', 'idlelib', 'tkinter', 'turtledemo', 'turtle.py']) {
		await rm(join(library, name), { recursive: true, force: true });
	}
	for (const name of await readdir(library)) {
		if (name.startsWith('config-')) {
			await rm(join(library, name), { recursive: true, force: true });
		}
	}
	for (const name of await readdir(join(library, 'lib-dynload'))) {
		if (name.startsWith('_tkinter.')) {
			await rm(join(library, 'lib-dynload', name));
		}
	}
	await removeDevelopmentFiles(root);
}

async function removeDevelopmentFiles(directory) {
	for (const item of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, item.name);
		if (item.isDirectory()) {
			if (item.name.endsWith('.dist-info')) {
				continue;
			}
			if (['__pycache__', 'tests', 'test'].includes(item.name)) {
				await rm(path, { recursive: true });
			} else {
				await removeDevelopmentFiles(path);
			}
		} else if (item.name === '.DS_Store' || /\.(?:pyc|pyo|pyx|pxd|pxi|h)$/.test(item.name)) {
			await rm(path);
		}
	}
}

export async function verifyPythonRuntime(root) {
	const runtime = join(root, 'runtime');
	const executables = await readdir(join(runtime, 'bin'));
	assert.deepEqual(executables, ['python3'], 'The packaged runtime must contain one interpreter without aliases.');
	assert.ok((await lstat(join(runtime, 'bin/python3'))).isFile());
	for (const binary of await nativeBinaries(root)) {
		const { stdout } = await execute('/usr/bin/otool', ['-L', binary]);
		for (const dependency of stdout.split('\n').slice(1)) {
			assert.ok(!/(?:libpython|libtcl|libtk|libitcl)/i.test(basename(dependency.trim().split(' (')[0])), `Native dependency requires a removed library: ${binary}`);
		}
	}
	const probe = [
		'import sys, ssl, sqlite3, ctypes, asyncio, importlib.metadata, io',
		'sys.path.insert(0, sys.argv[1])',
		'import httpx, curl_cffi, lxml.etree, pydantic_core, parsel, structlog',
		'from PIL import Image, ImageFont, ImageCms',
		'image = Image.new("RGB", (8, 8), "#684252")',
		'encoded = io.BytesIO(); image.save(encoded, format="WEBP"); encoded.seek(0)',
		'assert Image.open(encoded).size == (8, 8)',
		'assert lxml.etree.fromstring(b"<work><title>Nectisse</title></work>").findtext("title") == "Nectisse"',
		'session = curl_cffi.Session(impersonate="chrome150"); session.close()',
		'assert ssl.create_default_context().cert_store_stats()["x509_ca"] > 0',
		'assert importlib.metadata.version("httpx")',
		'print(sys.version.split()[0])',
	].join('; ');
	return execute(join(runtime, 'bin/python3'), ['-I', '-S', '-B', '-c', probe, join(root, 'dependencies')], {
		env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
	});
}

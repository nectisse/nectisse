import { access, cp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prunePythonRuntime, runtimeProfile, verifyPythonRuntime } from './python-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = (await readFile(join(root, '.python-version'), 'utf8')).trim();
const lock = await readFile(join(root, 'python/requirements.lock'));
const lockHash = createHash('sha256').update(lock).digest('hex');
const target = `${process.platform}-${process.arch}`;
const destination = join(root, '.build/python', target);
const relativePython = process.platform === 'win32' ? 'python.exe' : 'bin/python3';
const environment = {
	...process.env,
	UV_CACHE_DIR: resolve(root, '.cache/uv'),
	UV_PYTHON_INSTALL_DIR: resolve(root, '.cache/python'),
};

try {
	const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
	await access(join(destination, 'runtime', relativePython), constants.X_OK);
	if (manifest.pythonVersion === version && manifest.requirementsSha256 === lockHash && manifest.target === target && manifest.runtimeProfile === runtimeProfile) {
		console.log(`随包 Python ${version} 已准备：${target}`);
		process.exit(0);
	}
} catch {
	// Missing or outdated build artifacts are prepared below, never at app startup.
}

const staging = join(root, '.build/python', `.${target}-${process.pid}`);
try {
	await mkdir(staging, { recursive: true });
	execFileSync('uv', ['python', 'install', '--no-bin', '--no-registry', version], {
		cwd: root,
		env: environment,
		stdio: 'inherit',
	});
	const installed = execFileSync('uv', ['python', 'find', '--managed-python', version], {
		cwd: root,
		env: environment,
		encoding: 'utf8',
	}).trim();
	const runtimeRoot = dirname(dirname(await realpath(installed)));
	await cp(runtimeRoot, join(staging, 'runtime'), { recursive: true, verbatimSymlinks: true });
	const python = join(staging, 'runtime', relativePython);
	const dependencies = join(staging, 'dependencies');
	execFileSync(
		'uv',
		['pip', 'install', '--python', python, '--target', dependencies, '--require-hashes', '--no-deps', '--only-binary', ':all:', '-r', join(root, 'python/requirements.lock')],
		{ cwd: root, env: environment, stdio: 'inherit' },
	);
	execFileSync(python, ['-I', '-S', '-B', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import httpx, curl_cffi; print("原生采集依赖已加载")', dependencies], {
		cwd: root,
		stdio: 'inherit',
	});
	if (process.platform === 'darwin') {
		await prunePythonRuntime(staging, version);
		await verifyPythonRuntime(staging);
	}
	await writeFile(
		join(staging, 'manifest.json'),
		JSON.stringify(
			{
				schema: 2,
				runtimeProfile,
				pythonVersion: version,
				target,
				requirementsSha256: lockHash,
				distribution: 'uv-managed python-build-standalone',
			},
			null,
			2,
		) + '\n',
	);
	await rm(destination, { recursive: true, force: true });
	await rename(staging, destination);
	console.log(`随包运行环境已生成：.build/python/${target}`);
} finally {
	await rm(staging, { recursive: true, force: true });
}

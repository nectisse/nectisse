import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const output = resolve(process.env.NECTISSE_SMOKE_OUTPUT ?? 'work/native');
await mkdir(output, { recursive: true });
await rm(join(output, 'report.json'), { force: true });
const data = await mkdtemp(join(tmpdir(), 'nectisse-tauri-native-'));

function run(command, args, options = {}) {
	return new Promise((done, reject) => {
		const child = spawn(command, args, { stdio: 'inherit', ...options });
		child.once('error', reject);
		child.once('exit', (code) => (code === 0 ? done() : reject(new Error(`${command} exited ${code}`))));
	});
}

try {
	const release = process.argv.includes('--release');
	await run('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'native-smoke,tauri/custom-protocol', ...(release ? ['--release'] : [])]);
	try {
		await run(resolve(`src-tauri/target/${release ? 'release' : 'debug'}/nectisse-app`), [], {
			env: { ...process.env, NECTISSE_DATA_DIR: data, NECTISSE_SMOKE_OUTPUT: output },
			timeout: 90000,
		});
	} catch (error) {
		const report = await readFile(join(output, 'report.json'), 'utf8')
			.then(JSON.parse)
			.catch(() => null);
		throw new Error(report?.error ?? 'Native verification exited without a report.', { cause: error });
	}
	const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
	assert.equal(report.success, true, report.error);
	console.log(`PASS: ${report.checks.length} native WebKit / Rust checks. Screenshots: ${output}`);
} finally {
	await rm(data, { recursive: true, force: true });
}

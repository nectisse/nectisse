import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../.dependency-cruiser.cjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pathConfig = JSON.parse(await readFile(new URL('../tsconfig.paths.json', import.meta.url), 'utf8'));
const alias = Object.fromEntries(
	Object.entries(pathConfig.compilerOptions.paths).map(([name, [target]]) => [name.replace(/\/\*$/, ''), resolve(root, target.replace(/\/\*$/, ''))]),
);
process.chdir(root);
const { cruise } = await import('dependency-cruiser');
const { output } = await cruise(
	['src'],
	{ ...config.options, baseDir: root, validate: true, ruleSet: config, outputType: 'json' },
	{
		alias,
	},
);
const report = typeof output === 'string' ? JSON.parse(output) : output;

async function sources(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => (entry.isDirectory() ? sources(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : [])),
	);
	return nested.flat();
}

const scanned = new Set(report.modules.map((module) => resolve(root, module.source)));
const missing = (await sources(join(root, 'src'))).filter((file) => !scanned.has(file));
if (missing.length) {
	console.error('依赖检查未覆盖全部 TS / TSX 文件：', missing);
	process.exitCode = 1;
}
for (const violation of report.summary.violations) {
	console.error(`${violation.rule.severity} ${violation.rule.name}: ${violation.from} → ${violation.to}`);
}
if (report.summary.error || report.summary.warn) {
	process.exitCode = 1;
}
if (!process.exitCode) {
	console.log(`依赖检查通过：${scanned.size} 个模块，${report.summary.totalDependenciesCruised} 条依赖；全部 TS / TSX 文件已覆盖。`);
}

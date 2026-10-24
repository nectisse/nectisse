import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../node_modules/dependency-cruiser/bin/dependency-cruiser.mjs', import.meta.url));
const configPath = fileURLToPath(new URL('../.dependency-cruiser.cjs', import.meta.url));

test('架构规则实际解析 TS / TSX、类型依赖并拒绝越层、页面互引和演示耦合', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-architecture-'));
	const fixtures: Record<string, string> = {
		'src/shared/illegal.ts': "import '../main/worker'; export const shared = true;",
		'src/main/worker.ts': 'export const worker = true;',
		'src/renderer/src/state/illegal.ts': "import type { View } from '../works/view'; export type State = View;",
		'src/renderer/src/works/view.tsx': 'export type View = { name: string };',
		'src/renderer/src/metadata/MetadataWorkspace.tsx':
			"import { demo } from '../prototype/demo'; import '../library/LibraryPage'; import '../../../main/worker'; export const query = demo;",
		'src/renderer/src/library/LibraryPage.tsx': 'export const library = true;',
		'src/renderer/src/prototype/demo.ts': 'export const demo = true;',
		'src/renderer/src/library/node.ts': "import { readFile } from 'node:fs/promises'; export { readFile };",
		'src/renderer/src/state/private.ts': 'export const internal = true;',
		'src/renderer/src/library/private-state.ts': "import { internal } from '../state/private'; export { internal };",
		'src/renderer/src/components/business.tsx': "import '../library/LibraryPage'; export const component = true;",
		'src/renderer/src/works/page.tsx': "import '../metadata/MetadataWorkspace'; export const detail = true;",
	};
	try {
		for (const [file, content] of Object.entries(fixtures)) {
			const path = join(root, file);
			await mkdir(join(path, '..'), { recursive: true });
			await writeFile(path, content);
		}
		const output = execFileSync(process.execPath, [cli, '--config', configPath, '--output-type', 'json', 'src'], {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const report = JSON.parse(output);
		const rules = new Set(report.summary.violations.map((violation: { rule: { name: string } }) => violation.rule.name));
		for (const rule of [
			'shared-is-platform-independent',
			'state-has-no-view-dependencies',
			'production-does-not-import-demo',
			'pages-do-not-import-other-pages',
			'renderer-is-sandboxed',
			'renderer-has-no-node-builtins',
			'state-public-interface',
			'ui-primitives-have-no-business-dependencies',
			'work-presentation-does-not-import-pages',
		]) {
			assert.ok(
				rules.has(rule),
				`missing violation: ${rule}; ${JSON.stringify({ violations: report.summary.violations, sources: report.modules.map((module: { source: string }) => module.source) })}`,
			);
		}
		assert.ok(report.modules.some((module: { source: string }) => module.source.endsWith('MetadataWorkspace.tsx')));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

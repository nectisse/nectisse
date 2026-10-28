import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../node_modules/dependency-cruiser/bin/dependency-cruiser.mjs', import.meta.url));
const configPath = fileURLToPath(new URL('../.dependency-cruiser.cjs', import.meta.url));

async function inspect(fixtures: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-architecture-'));
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
		return JSON.parse(output);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('架构检查允许应用组合、功能内部实现及通过公开入口共享实体和平台能力', async () => {
	const report = await inspect({
		'src/renderer/app/App.tsx': "import './ui/Workspace'; import '../demo';",
		'src/renderer/app/ui/Workspace.tsx': "import '../../features/library';",
		'src/renderer/demo/index.ts': "import '../entities/work'; export const demo = true;",
		'src/renderer/features/library/index.ts': "export { page } from './ui/Page';",
		'src/renderer/features/library/ui/Page.tsx': "import '../../../entities/work'; import '../../../shared/desktop'; export const page = true;",
		'src/renderer/entities/work/index.ts': "export { detail } from './ui/Detail';",
		'src/renderer/entities/work/ui/Detail.tsx': "import '../../../shared/ui/button'; import '../../../shared/desktop'; export const detail = true;",
		'src/renderer/shared/ui/button.tsx': 'export const Button = true;',
		'src/renderer/shared/desktop/index.ts': "export { state } from './private';",
		'src/renderer/shared/desktop/private.ts': 'export const state = true;',
	});
	assert.deepEqual(report.summary.violations, []);
});

test('架构检查拒绝功能互引、私有入口、反向业务依赖及绕过 desktop 使用状态库', async () => {
	const report = await inspect({
		'src/shared/illegal.ts': "import '../main/index';",
		'src/main/index.ts': 'export const main = true;',
		'src/renderer/shared/desktop/private.ts': 'export const state = true;',
		'src/renderer/shared/desktop/illegal.ts': "import type { View } from '../../entities/work/ui/Detail'; export type State = View;",
		'src/renderer/shared/ui/illegal.tsx': "import '../../shared/desktop/private'; import '../../features/library';",
		'src/renderer/entities/work/ui/Detail.tsx': "import '../../../features/library'; export type View = { name: string };",
		'src/renderer/features/library/index.ts': "export { page } from './ui/Page';",
		'src/renderer/features/library/ui/Page.tsx': 'export const page = true;',
		'src/renderer/demo/index.ts': 'export const demo = true;',
		'src/renderer/features/work-query/ui/Page.tsx':
			"import '../../library/ui/Page'; import '../../../demo'; import '../../../../main/index'; import '../../../shared/desktop/private'; import '../../../app/ui/Workspace'; import { QueryClient } from '@tanstack/react-query'; export { QueryClient };",
		'src/renderer/features/work-query/ui/node.ts': "import { readFile } from 'node:fs/promises'; export { readFile };",
		'src/renderer/app/ui/Workspace.tsx': 'export const workspace = true;',
		'node_modules/@tanstack/react-query/package.json': '{"name":"@tanstack/react-query","main":"index.js"}',
		'node_modules/@tanstack/react-query/index.js': 'export const QueryClient = true;',
	});
	const rules = new Set(report.summary.violations.map((violation: { rule: { name: string } }) => violation.rule.name));
	for (const rule of [
		'shared-is-platform-independent',
		'renderer-shared-has-no-business-dependencies',
		'ui-primitives-have-no-desktop-dependencies',
		'production-does-not-import-demo',
		'renderer-is-sandboxed',
		'renderer-has-no-node-builtins',
		'desktop-public-interface',
		'entities-have-no-feature-dependencies',
		'features-have-no-app-dependencies',
		'desktop-owns-renderer-data-libraries',
		'src-renderer-features-work-query-independent',
		'src-renderer-features-library-public-interface',
		'src-renderer-entities-work-public-interface',
	]) {
		assert.ok(rules.has(rule), `missing violation: ${rule}; ${JSON.stringify(report.summary.violations)}`);
	}
	assert.ok(!rules.has('no-unresolved'), JSON.stringify(report.summary.violations));
});

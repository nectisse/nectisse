import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('macOS 图标需在 Mac 上生成');
const root = fileURLToPath(new URL('..', import.meta.url));
const pythonRoot = join(root, '.build/python', `darwin-${process.arch}`);
execFileSync(
	join(pythonRoot, 'runtime/bin/python3'),
	[
		'-I', '-S', '-B', '-c',
		'import runpy, sys; sys.path.insert(0, sys.argv[1]); runpy.run_path(sys.argv[2], run_name="__main__")',
		join(pythonRoot, 'dependencies'),
		join(root, 'scripts/build-icons.py'),
	],
	{ cwd: root, stdio: 'inherit' },
);

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = join(root, '.build/python', `${process.platform}-${process.arch}`);
const python = join(runtime, 'runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
const result = spawnSync(
	python,
	[
		'-I',
		'-S',
		'-B',
		'-c',
		[
			'import sys, unittest',
			'sys.path[:0] = sys.argv[1:4]',
			'suite = unittest.defaultTestLoader.discover(sys.argv[4])',
			'raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())',
		].join('; '),
		join(root, 'python/vendor'),
		join(runtime, 'dependencies'),
		join(root, 'python/src'),
		join(root, 'python/tests'),
	],
	{
		env: {},
		stdio: 'inherit',
	},
);
if (result.error) console.error('无法运行随包 Python；请先执行 npm run python:prepare。');
process.exit(result.status ?? 1);

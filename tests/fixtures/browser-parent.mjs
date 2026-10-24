import { fileURLToPath } from 'node:url';
import { PythonTaskHost } from '../../src/main/platform/python/python-host.ts';
import { pythonLayout } from '../../src/main/platform/python/python-layout.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const host = new PythonTaskHost(pythonLayout(root, false), { browserProfile: process.argv[2], diagnostics: true });
await host.run(
	'metadata.query',
	{ source: 'fc2ppvdb', transport: 'browser', proxy: 'invalid://proxy', diagnosticWait: 60 },
	{
		onReady: (worker) => process.send({ worker }),
	},
);

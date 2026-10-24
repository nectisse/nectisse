import { join } from 'node:path';

export interface PythonLayout {
	executable: string;
	bootstrap: string;
	dependencies: string;
	manifest: string;
}

export function pythonLayout(root: string, packaged: boolean): PythonLayout {
	const runtimeRoot = packaged ? join(root, 'python') : join(root, '.build/python', `${process.platform}-${process.arch}`);
	const appRoot = packaged ? join(runtimeRoot, 'app') : join(root, 'python');
	return {
		executable: join(runtimeRoot, 'runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
		bootstrap: join(appRoot, 'bootstrap.py'),
		dependencies: join(runtimeRoot, 'dependencies'),
		manifest: join(runtimeRoot, 'manifest.json'),
	};
}

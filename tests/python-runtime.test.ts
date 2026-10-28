import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prunePythonRuntime } from '../scripts/python-runtime.mjs';

test('精简运行时保留一个真实解释器、采集模块和许可证，不展开软链接或删除元数据', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-python-prune-'));
	const files: Record<string, string> = {
		'runtime/bin/python3.14': 'interpreter',
		'runtime/bin/pip': 'installer',
		'runtime/include/python3.14/Python.h': 'header',
		'runtime/share/man/python.1': 'manual',
		'runtime/lib/libpython3.14.dylib': 'unused shared interpreter',
		'runtime/lib/libtcl9.0.dylib': 'unused GUI',
		'runtime/lib/tk9.0/pkgIndex.tcl': 'unused GUI data',
		'runtime/lib/python3.14/lib-dynload/_tkinter.so': 'unused GUI extension',
		'runtime/lib/python3.14/lib-dynload/_ssl.so': 'TLS',
		'runtime/lib/python3.14/site-packages/pip/__init__.py': 'installer',
		'runtime/lib/python3.14/ensurepip/__init__.py': 'installer',
		'runtime/lib/python3.14/idlelib/__init__.py': 'IDE',
		'runtime/lib/python3.14/LICENSE.txt': 'Python license',
		'runtime/lib/python3.14/unittest/__init__.py': 'test runner',
		'dependencies/lxml/etree.so': 'parser',
		'dependencies/lxml/etree.pyx': 'development source',
		'dependencies/lxml/tests/test.py': 'upstream test suite',
		'dependencies/certifi/cacert.pem': 'certificates',
		'dependencies/httpx-0.28.1.dist-info/METADATA': 'version metadata',
		'dependencies/httpx-0.28.1.dist-info/licenses/LICENSE': 'dependency license',
		'dependencies/httpx/__pycache__/__init__.pyc': 'bytecode',
	};
	try {
		for (const [path, contents] of Object.entries(files)) {
			const target = join(root, path);
			await mkdir(join(target, '..'), { recursive: true });
			await writeFile(target, contents, { mode: 0o755 });
		}
		await symlink('python3.14', join(root, 'runtime/bin/python3'));
		await symlink('python3.14', join(root, 'runtime/bin/python'));
		await prunePythonRuntime(root, '3.14.9');
		assert.deepEqual(await readdir(join(root, 'runtime/bin')), ['python3']);
		assert.equal(await readFile(join(root, 'runtime/bin/python3'), 'utf8'), 'interpreter');
		assert.ok((await stat(join(root, 'runtime/bin/python3'))).mode & 0o111);
		for (const path of [
			'runtime/lib/python3.14/lib-dynload/_ssl.so',
			'runtime/lib/python3.14/LICENSE.txt',
			'runtime/lib/python3.14/unittest/__init__.py',
			'dependencies/lxml/etree.so',
			'dependencies/certifi/cacert.pem',
			'dependencies/httpx-0.28.1.dist-info/METADATA',
			'dependencies/httpx-0.28.1.dist-info/licenses/LICENSE',
		]) {
			assert.equal(await readFile(join(root, path), 'utf8'), files[path]);
		}
		for (const path of [
			'runtime/include',
			'runtime/share',
			'runtime/lib/libpython3.14.dylib',
			'runtime/lib/libtcl9.0.dylib',
			'runtime/lib/tk9.0',
			'runtime/lib/python3.14/lib-dynload/_tkinter.so',
			'runtime/lib/python3.14/site-packages',
			'runtime/lib/python3.14/ensurepip',
			'runtime/lib/python3.14/idlelib',
			'dependencies/lxml/etree.pyx',
			'dependencies/lxml/tests',
			'dependencies/httpx/__pycache__',
		]) {
			await assert.rejects(stat(join(root, path)), { code: 'ENOENT' });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

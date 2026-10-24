import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiagnosticLog } from '../src/main/diagnostics';
import { formatDiagnosticReport, runtimeDiagnosticCode, diagnosticReportSchema } from '@shared/diagnostics';
import { subscriptionFailureContext } from '@shared/subscription-failure';
const environment = { appVersion: '0.1.0', system: 'darwin 27.0.0', architecture: 'arm64', electronVersion: '45.0.0', pythonVersion: '3.14.9', runtimePhase: 'ready' as const };

async function directory(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'nectisse-diagnostics-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test('诊断沿用既有记录，跨重启保留；复制包含时间、类别、说明和运行环境', async (t) => {
	const root = await directory(t);
	const log = new DiagnosticLog(root);
	assert.equal(log.snapshot(environment).entries.length, 0);
	log.record('SUBSCRIPTIONS_STORAGE_READ');
	log.record('RUNTIME_START_FAILED');
	const report = new DiagnosticLog(root).snapshot(environment);
	assert.equal(report.entries.length, 2);
	assert.equal(report.logStatus, 'ready');
	assert.equal(diagnosticReportSchema.safeParse(report).success, true);
	const text = formatDiagnosticReport(report);
	assert.ok(text.includes('RUNTIME_START_FAILED'));
	assert.ok(text.includes('采集环境无法启动'));
	assert.ok(text.includes('3.14.9'));
	assert.ok(text.includes(report.entries[0]!.at));
	assert.equal((await stat(log.path)).mode & 0o777, 0o600);
	assert.equal((await stat(join(root, 'diagnostics'))).mode & 0o777, 0o700);
});

test('只读取固定文件与白名单字段，忽略损坏记录和任意异常文本，不泄露敏感信息', async (t) => {
	const root = await directory(t);
	const log = new DiagnosticLog(root);
	await mkdir(join(root, 'diagnostics'));
	const secret = 'session=synthetic-private; proxy=http://private.example:7890';
	await writeFile(
		log.path,
		[
			JSON.stringify({ at: new Date().toISOString(), code: 'SUBSCRIPTIONS_INVALID_DATA', message: secret, cookie: secret }),
			JSON.stringify({ at: new Date().toISOString(), code: secret }),
			'not-json',
			JSON.stringify({ at: 'not-a-time', code: 'SUBSCRIPTIONS_UNAVAILABLE' }),
		].join('\n'),
	);
	await writeFile(join(root, 'diagnostics', 'other.log'), secret);
	const report = log.snapshot(environment);
	assert.equal(report.entries.length, 1);
	assert.equal(report.ignoredLines, 3);
	assert.equal(JSON.stringify(report).includes(secret), false);
	assert.equal(formatDiagnosticReport(report).includes(secret), false);
	log.record('RUNTIME_CHECK_FAILED');
	assert.equal((await readFile(log.path, 'utf8')).includes(secret), false);
});

test('日志保持最近 32 条；主进程与界面同一读取失败不重复登记', async (t) => {
	const root = await directory(t);
	const log = new DiagnosticLog(root);
	log.record('SUBSCRIPTIONS_UNAVAILABLE');
	log.recordFromRenderer('SUBSCRIPTIONS_UNAVAILABLE');
	assert.equal(log.snapshot(environment).entries.length, 1);
	for (let index = 0; index < 50; index++) {
		log.record(index % 2 ? 'SUBSCRIPTIONS_READ_TIMEOUT' : 'RUNTIME_CHECK_FAILED');
	}
	assert.equal(log.snapshot(environment).entries.length, 32);
	assert.equal((await readFile(log.path, 'utf8')).trim().split('\n').length, 32);
	assert.ok((await stat(log.path)).size <= 8192);
});

test('日志目录不可写或文件不可读时保留当前会话错误，仍可生成诊断信息', async (t) => {
	const root = await directory(t);
	const log = new DiagnosticLog(root);
	await mkdir(log.path, { recursive: true });
	log.record('APP_INITIALIZATION_FAILED');
	const report = log.snapshot(environment);
	assert.equal(report.logStatus, 'unreadable');
	assert.equal(report.entries[0]?.code, 'APP_INITIALIZATION_FAILED');
	assert.ok(formatDiagnosticReport(report).includes('当前可取得'));
});

test('超出上限的旧日志不读入界面或剪贴板', async (t) => {
	const root = await directory(t);
	const log = new DiagnosticLog(root);
	await mkdir(join(root, 'diagnostics'));
	await writeFile(log.path, 'private '.repeat(2000));
	const report = log.snapshot(environment);
	assert.equal(report.logStatus, 'unreadable');
	assert.equal(report.entries.length, 0);
	assert.equal(formatDiagnosticReport(report).includes('private'), false);
});

test('Python 错误映射为固定诊断类别，未知消息不直接写入日志', () => {
	assert.equal(runtimeDiagnosticCode('START_FAILED'), 'RUNTIME_START_FAILED');
	assert.equal(runtimeDiagnosticCode('WORKER_TIMEOUT'), 'RUNTIME_TIMEOUT');
	assert.equal(runtimeDiagnosticCode('WRONG_ARCH'), 'RUNTIME_WRONG_ARCH');
	assert.equal(runtimeDiagnosticCode('secret=private'), 'RUNTIME_CHECK_FAILED');
});

test('诊断保留白名单失败环节与系统错误码，原始异常内容及任意属性不落盘', async (t) => {
	const root = await directory(t);
	const log = new DiagnosticLog(root);
	const secret = 'cookie=sensitive-fixture; /Users/private/data; proxy=http://private.invalid';
	const context = subscriptionFailureContext(Object.assign(new Error(secret), { code: 'ERR_SQLITE_ERROR', errcode: 5, cookie: secret }), 'tasks');
	assert.deepEqual(context, { stage: 'tasks', kind: 'storage_error', systemCode: 'ERR_SQLITE_ERROR', sqliteCode: 5 });
	log.record('SUBSCRIPTIONS_STORAGE_READ', context);
	const report = new DiagnosticLog(root).snapshot(environment);
	const text = formatDiagnosticReport(report);
	assert.deepEqual(report.entries[0]?.context, context);
	assert.ok(text.includes('读取订阅任务'));
	assert.ok(text.includes('ERR_SQLITE_ERROR'));
	assert.ok(text.includes('SQLite：5'));
	assert.equal(text.includes(secret), false);
	assert.equal((await readFile(log.path, 'utf8')).includes(secret), false);
	assert.deepEqual(subscriptionFailureContext(Object.assign(new TypeError(secret), { code: secret, errcode: secret }), 'sources'), { stage: 'sources', kind: 'type_error' });
	for (let index = 0; index < 40; index++) {
		log.record('SUBSCRIPTIONS_UNAVAILABLE', { stage: 'secure_storage', kind: 'storage_error', systemCode: 'ERR_INVALID_ARG_TYPE', sqliteCode: 65535 });
	}
	assert.equal(log.snapshot(environment).entries.length, 32);
	assert.ok((await stat(log.path)).size <= 8192);
});

test('未注册接口、窗口身份与传输失败分别标记，未知 IPC 消息不复制', () => {
	assert.equal(
		subscriptionFailureContext(new Error("Error invoking remote method 'nectisse:subscriptions-get': No handler registered for 'nectisse:subscriptions-get'"), 'ipc').kind,
		'ipc_handler_missing',
	);
	assert.equal(subscriptionFailureContext(new Error('Untrusted IPC sender'), 'ipc').kind, 'ipc_sender_rejected');
	assert.equal(subscriptionFailureContext(new Error('An object could not be cloned.'), 'ipc').kind, 'ipc_serialization');
	assert.deepEqual(subscriptionFailureContext(new Error('sensitive-fixture'), 'ipc'), { stage: 'ipc', kind: 'ipc_error' });
});

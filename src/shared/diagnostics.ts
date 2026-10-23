import { z } from 'zod';
import { SUBSCRIPTION_READ } from './subscription-read';
import { describeSubscriptionFailure, subscriptionFailureContextSchema, type SubscriptionFailureContext } from './subscription-failure';

export const DIAGNOSTIC_DESCRIPTIONS = {
	[SUBSCRIPTION_READ.unavailable]: { title: '设置与订阅服务未响应', message: '读取本地状态时，应用通信或服务暂时未能响应。' },
	[SUBSCRIPTION_READ.storage]: { title: '本地存储读取失败', message: '读取应用数据目录失败，请检查目录权限与可用空间。' },
	[SUBSCRIPTION_READ.invalid]: { title: '本地记录格式不兼容', message: '设置或订阅记录未通过当前版本的格式校验，原有数据已保留。' },
	[SUBSCRIPTION_READ.timeout]: { title: '设置与订阅读取超时', message: '本次读取未在规定时间内完成。' },
	APP_INITIALIZATION_FAILED: { title: '应用初始化失败', message: '本机服务初始化未完成，原有数据已保留。' },
	METADATA_INITIALIZATION_FAILED: { title: '资料查询初始化失败', message: '本地资料查询记录或缓存未能准备完成。' },
	LIBRARY_INITIALIZATION_FAILED: { title: '作品收藏初始化失败', message: '本地收藏库未能打开，已有收藏已保留，可在作品收藏中重新检查。' },
	SECURE_STORAGE_CHECK_FAILED: { title: '系统安全存储检查失败', message: '本机资料仍可读取，系统安全存储恢复前不保存 Cookie。' },
	RUNTIME_START_FAILED: { title: '采集环境无法启动', message: '未能启动 App 内附的 Python 环境，请重新打开或安装应用。' },
	RUNTIME_WRONG_ARCH: { title: '采集环境架构不匹配', message: '采集环境与当前应用架构不一致。' },
	RUNTIME_WRONG_VERSION: { title: '采集环境版本不匹配', message: 'Python 版本与随包清单不一致。' },
	RUNTIME_TIMEOUT: { title: '采集环境自检超时', message: '采集环境未及时返回自检结果。' },
	RUNTIME_UNEXPECTED_EXIT: { title: '采集环境意外退出', message: '采集环境在完成自检前退出。' },
	RUNTIME_PROTOCOL_ERROR: { title: '采集环境通信异常', message: '采集环境返回的数据未通过通信格式校验。' },
	RUNTIME_CHECK_FAILED: { title: '采集环境自检失败', message: 'App 内附采集环境未通过启动自检。' },
} as const;
export const diagnosticCodeSchema = z.enum(Object.keys(DIAGNOSTIC_DESCRIPTIONS) as [keyof typeof DIAGNOSTIC_DESCRIPTIONS, ...(keyof typeof DIAGNOSTIC_DESCRIPTIONS)[]]);
export type DiagnosticCode = z.infer<typeof diagnosticCodeSchema>;
export const runtimeDiagnosticCodeSchema = diagnosticCodeSchema.extract([
	'RUNTIME_START_FAILED',
	'RUNTIME_WRONG_ARCH',
	'RUNTIME_WRONG_VERSION',
	'RUNTIME_TIMEOUT',
	'RUNTIME_UNEXPECTED_EXIT',
	'RUNTIME_PROTOCOL_ERROR',
	'RUNTIME_CHECK_FAILED',
]);

export function runtimeDiagnosticCode(code: string): z.infer<typeof runtimeDiagnosticCodeSchema> {
	return code === 'START_FAILED'
		? 'RUNTIME_START_FAILED'
		: code === 'WRONG_ARCH'
			? 'RUNTIME_WRONG_ARCH'
			: code === 'WRONG_RUNTIME'
				? 'RUNTIME_WRONG_VERSION'
				: code === 'WORKER_TIMEOUT'
					? 'RUNTIME_TIMEOUT'
					: code === 'UNEXPECTED_EXIT'
						? 'RUNTIME_UNEXPECTED_EXIT'
						: ['INVALID_PROTOCOL', 'PROTOCOL_LIMIT'].includes(code)
							? 'RUNTIME_PROTOCOL_ERROR'
							: 'RUNTIME_CHECK_FAILED';
}

export const diagnosticEntrySchema = z.object({ at: z.string().datetime(), code: diagnosticCodeSchema, context: subscriptionFailureContextSchema.optional() });
export type DiagnosticEntry = z.infer<typeof diagnosticEntrySchema>;
export const diagnosticEnvironmentSchema = z.object({
	appVersion: z.string().max(100),
	system: z.string().max(100),
	architecture: z.string().max(32),
	electronVersion: z.string().max(100),
	pythonVersion: z.string().max(100),
	runtimePhase: z.enum(['starting', 'ready', 'error', 'stopped', 'unavailable']),
});
export type DiagnosticEnvironment = z.infer<typeof diagnosticEnvironmentSchema>;
export const diagnosticReportSchema = z.object({
	generatedAt: z.string().datetime(),
	environment: diagnosticEnvironmentSchema,
	entries: z.array(diagnosticEntrySchema).max(32),
	logStatus: z.enum(['ready', 'unreadable']),
	ignoredLines: z.number().int().nonnegative(),
});
export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;

export function formatDiagnosticReport(report: DiagnosticReport): string {
	const { environment: env } = report;
	const phase = { starting: '正在准备', ready: '已就绪', error: '自检失败', stopped: '已停止', unavailable: '不可用' }[env.runtimePhase];
	return [
		'Nectisse 诊断信息',
		`生成时间：${report.generatedAt}`,
		`应用版本：${env.appVersion}`,
		`系统：${env.system} (${env.architecture})`,
		`Electron：${env.electronVersion}`,
		`Python：${env.pythonVersion || '尚未取得版本'} · ${phase}`,
		'',
		report.logStatus === 'unreadable' ? '本地日志文件暂不可访问；以下为当前可取得的记录。' : '最近异常记录（最多 32 条，时间为 UTC）：',
		...(report.entries.length
			? [...report.entries]
					.reverse()
					.map(
						(entry) =>
							`${entry.at}  ${entry.code}\n${DIAGNOSTIC_DESCRIPTIONS[entry.code].title}：${DIAGNOSTIC_DESCRIPTIONS[entry.code].message}${entry.context ? `\n${describeSubscriptionFailure(entry.context)}` : entry.code.startsWith('SUBSCRIPTIONS_') ? '\n旧记录未包含失败环节。' : ''}`,
					)
			: ['暂无异常记录。']),
		...(report.ignoredLines ? [`已忽略 ${report.ignoredLines} 条无法识别的旧日志。`] : []),
	].join('\n');
}

export const diagnosticCopyReplySchema = z.discriminatedUnion('copied', [
	z.object({ copied: z.literal(true), report: diagnosticReportSchema }),
	z.object({ copied: z.literal(false) }),
]);
export interface DiagnosticsBridge {
	getReport: () => Promise<DiagnosticReport>;
	copyReport: () => Promise<z.infer<typeof diagnosticCopyReplySchema>>;
	recordReadFailure: (code: (typeof SUBSCRIPTION_READ)[keyof typeof SUBSCRIPTION_READ], context?: SubscriptionFailureContext) => Promise<void>;
}
export const DIAGNOSTICS_IPC = { get: 'nectisse:diagnostics-get', copy: 'nectisse:diagnostics-copy', recordRead: 'nectisse:diagnostics-record-read' } as const;

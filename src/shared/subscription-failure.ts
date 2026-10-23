import { z } from 'zod';

export const SUBSCRIPTION_STAGES = {
	snapshot: '组装本地状态',
	preferences: '读取偏好设置',
	subscriptions: '读取关注记录',
	entries: '读取更新条目',
	tasks: '读取订阅任务',
	sources: '读取来源状态',
	secure_storage: '检查系统安全存储',
	validation: '校验本地状态',
	ipc: '调用主进程接口',
	renderer: '界面等待读取',
} as const;
export const SUBSCRIPTION_FAILURE_KINDS = {
	type_error: '类型异常',
	reference_error: '引用异常',
	invalid_data: '数据格式异常',
	storage_error: '存储接口异常',
	service_error: '服务内部异常',
	ipc_handler_missing: '接口尚未注册',
	ipc_sender_rejected: '窗口身份校验失败',
	ipc_serialization: '状态无法通过进程通信传递',
	ipc_error: '进程通信异常',
	timeout: '等待超时',
	unknown: '原因尚未取得',
} as const;
export const subscriptionStageSchema = z.enum(Object.keys(SUBSCRIPTION_STAGES) as [keyof typeof SUBSCRIPTION_STAGES, ...(keyof typeof SUBSCRIPTION_STAGES)[]]);
const kindSchema = z.enum(Object.keys(SUBSCRIPTION_FAILURE_KINDS) as [keyof typeof SUBSCRIPTION_FAILURE_KINDS, ...(keyof typeof SUBSCRIPTION_FAILURE_KINDS)[]]);
const systemCodeSchema = z.enum([
	'ERR_SQLITE_ERROR',
	'ERR_SQLITE_CORRUPT',
	'SQLITE_BUSY',
	'SQLITE_LOCKED',
	'ERR_INVALID_STATE',
	'ERR_INVALID_ARG_TYPE',
	'ERR_FAILED',
	'EACCES',
	'EPERM',
	'EIO',
	'ENOENT',
	'ENOSPC',
	'EROFS',
	'EMFILE',
	'ENFILE',
]);
export const subscriptionFailureContextSchema = z.object({
	stage: subscriptionStageSchema,
	kind: kindSchema,
	systemCode: systemCodeSchema.optional(),
	sqliteCode: z.number().int().min(0).max(65535).optional(),
});
export type SubscriptionFailureContext = z.infer<typeof subscriptionFailureContextSchema>;
export type SubscriptionStage = z.infer<typeof subscriptionStageSchema>;

/** Only fixed labels and numeric SQLite codes cross the diagnostic boundary. */
export function subscriptionFailureContext(error: unknown, stage: SubscriptionStage): SubscriptionFailureContext {
	const native = error && typeof error === 'object' ? (error as { name?: unknown; code?: unknown; errcode?: unknown; message?: unknown }) : {};
	const systemCode = systemCodeSchema.safeParse(native.code);
	const sqliteCode = typeof native.errcode === 'number' && Number.isInteger(native.errcode) && native.errcode >= 0 && native.errcode <= 65535 ? native.errcode : undefined;
	const kind =
		native.name === 'TypeError'
			? 'type_error'
			: native.name === 'ReferenceError'
				? 'reference_error'
				: native.name === 'SyntaxError' || native.name === 'ZodError'
					? 'invalid_data'
					: systemCode.success
						? 'storage_error'
						: stage === 'ipc'
							? ipcFailureKind(native.message)
							: 'service_error';
	return { stage, kind, ...(systemCode.success ? { systemCode: systemCode.data } : {}), ...(sqliteCode !== undefined ? { sqliteCode } : {}) };
}
function ipcFailureKind(message: unknown): SubscriptionFailureContext['kind'] {
	if (typeof message !== 'string') return 'ipc_error';
	return message.includes("No handler registered for 'nectisse:subscriptions-get'")
		? 'ipc_handler_missing'
		: message.includes('Untrusted IPC sender')
			? 'ipc_sender_rejected'
			: /could not be cloned|could not be serialized/.test(message)
				? 'ipc_serialization'
				: 'ipc_error';
}
export function describeSubscriptionFailure(context: SubscriptionFailureContext): string {
	return `环节：${SUBSCRIPTION_STAGES[context.stage]}（${context.stage}）；类型：${SUBSCRIPTION_FAILURE_KINDS[context.kind]}（${context.kind}）${context.systemCode ? `；系统码：${context.systemCode}` : ''}${context.sqliteCode !== undefined ? `；SQLite：${context.sqliteCode}` : ''}`;
}

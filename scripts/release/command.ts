import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export class ReleaseCommandError extends Error {
	readonly exitCode?: number;

	constructor(tool: string, exitCode?: number) {
		super(`${tool} 执行失败${exitCode === undefined ? '' : `（退出码 ${exitCode}）`}，请检查对应构建步骤`);
		this.name = 'ReleaseCommandError';
		this.exitCode = exitCode;
	}
}

export async function command(tool: string, args: string[], env: NodeJS.ProcessEnv = process.env, diagnostics = false): Promise<{ stdout: string; stderr: string }> {
	try {
		return await execute(tool, args, { env, maxBuffer: 16 * 1024 * 1024, timeout: 25 * 60_000 });
	} catch (error) {
		const result = error as { code?: unknown; stdout?: string; stderr?: string };
		if (diagnostics) {
			process.stderr.write(result.stdout ?? '');
			process.stderr.write(result.stderr ?? '');
		}
		// 不回显命令参数；仅票据工具与移除凭据后的桌面验收开启输出。
		throw new ReleaseCommandError(tool, typeof result.code === 'number' ? result.code : undefined);
	}
}

export function unsignedMode(args = process.argv.slice(2), env = process.env): boolean {
	const unsigned = args.length === 1 && args[0] === '--unsigned';
	if (args.length && !unsigned) {
		throw new Error('仅支持可选的 --unsigned 预览参数');
	}
	if (unsigned && env.GITHUB_REF_TYPE === 'tag') {
		throw new Error('版本标签不能跳过签名公证');
	}
	return unsigned;
}

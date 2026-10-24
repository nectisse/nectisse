import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function command(tool: string, args: string[], env: NodeJS.ProcessEnv = process.env, diagnostics = false): Promise<{ stdout: string; stderr: string }> {
	try {
		return await execute(tool, args, { env, maxBuffer: 16 * 1024 * 1024, timeout: 25 * 60_000 });
	} catch (error) {
		if (diagnostics) {
			const result = error as { stdout?: string; stderr?: string };
			process.stderr.write(result.stdout ?? '');
			process.stderr.write(result.stderr ?? '');
		}
		// 公证失败不回显完整命令；桌面回归仅在移除凭据后开启诊断输出。
		throw new Error(`${tool} 执行失败，请检查对应构建步骤`);
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

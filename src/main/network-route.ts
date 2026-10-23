// Electron 解析系统代理；代理地址只在主进程和工作者的私有通道中使用。
export function proxyFromRules(rules: string): string {
	const first = rules.split(';')[0]?.trim() ?? 'DIRECT';
	if (first === 'DIRECT') return '';
	const match = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(first);
	if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) throw new Error('系统代理格式或认证方式暂不支持');
	const type = match[1]!.toUpperCase();
	const scheme = type === 'HTTPS' ? 'https' : type.startsWith('SOCKS') ? 'socks5h' : 'http';
	return `${scheme}://${match[2]}:${match[3]}`;
}

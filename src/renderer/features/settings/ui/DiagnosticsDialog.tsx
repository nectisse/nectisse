import { useDiagnosticsReport, useCopyDiagnostics } from '@/shared/desktop';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Check, Copy, FileCheck2, FileText, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/shared/ui/alert';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { toast } from '@/shared/ui/sonner';
import { EmptyState } from '@/shared/components/empty-state';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/shared/ui/dialog';
import { DIAGNOSTIC_DESCRIPTIONS } from '@shared/diagnostics';
import { describeSubscriptionFailure } from '@shared/subscription-failure';

const localTime = (value: string): string => new Date(value).toLocaleString('zh-CN', { hour12: false });

const phases = { starting: '正在准备', ready: '已就绪', error: '自检失败', stopped: '已停止', unavailable: '暂不可用' };

export function DiagnosticsDialog({ open, onClose, returnFocus }: { open: boolean; onClose: () => void; returnFocus: RefObject<HTMLButtonElement | null> }): React.JSX.Element {
	const query = useDiagnosticsReport(open);
	const report = query.data;
	const loading = query.isFetching;
	const copyingReport = useCopyDiagnostics();
	const copying = copyingReport.isPending;
	const [copied, setCopied] = useState(false);
	const error = query.isError ? '诊断日志暂时无法读取，请重试或重新打开应用。' : '';
	const generation = useRef(0);

	const refresh = async (): Promise<void> => {
		generation.current++;
		setCopied(false);
		await query.refetch();
	};

	useEffect(() => {
		generation.current++;
		setCopied(false);
		return () => {
			generation.current++;
		};
	}, [open]);

	const copy = async (): Promise<void> => {
		const request = generation.current;
		setCopied(false);
		try {
			const reply = await copyingReport.mutateAsync();
			if (generation.current === request) {
				if (reply.copied) {
					setCopied(true);
					toast.success('诊断信息已复制', { id: 'diagnostics-copy' });
				} else {
					toast.error('未能写入剪贴板，请重试。', { id: 'diagnostics-copy', duration: 8000 });
				}
			}
		} catch {
			if (generation.current === request) {
				toast.error('诊断信息暂时无法复制，请重试。', { id: 'diagnostics-copy', duration: 8000 });
			}
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
		>
			<DialogContent className="diagnostics-dialog" finalFocus={() => (returnFocus.current?.isConnected ? returnFocus.current : document.getElementById('page-heading'))}>
				<div className="diagnostics-heading">
					<div>
						<DialogTitle>
							<FileText />
							诊断日志
						</DialogTitle>
						<DialogDescription>查看最近的启动与本地读取异常，复制信息以便排查。</DialogDescription>
					</div>
					<DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭诊断日志" />}>
						<X />
					</DialogClose>
				</div>
				{report && (
					<dl className="diagnostics-environment">
						<div>
							<dt>应用</dt>
							<dd>Nectisse {report.environment.appVersion}</dd>
							<small>Tauri {report.environment.tauriVersion}</small>
						</div>
						<div>
							<dt>系统</dt>
							<dd>{report.environment.system.replace(/^darwin /, 'macOS ')}</dd>
							<small>{report.environment.architecture}</small>
						</div>
						<div>
							<dt>采集环境</dt>
							<dd>{phases[report.environment.runtimePhase]}</dd>
							<small>{report.environment.pythonVersion ? `Python ${report.environment.pythonVersion}` : '版本尚未取得'}</small>
						</div>
					</dl>
				)}
				<div className="diagnostics-list-heading">
					<h3>
						最近异常 <Badge variant="secondary">{report?.entries.length ?? 0} / 32</Badge>
					</h3>
					<span>{report ? `更新于 ${localTime(report.generatedAt)}` : '正在读取本机日志'}</span>
				</div>
				<div className="diagnostics-records" role="region" aria-label="诊断记录" tabIndex={0} aria-busy={loading}>
					{error && (
						<Alert className="diagnostics-alert">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
					{report?.logStatus === 'unreadable' && (
						<Alert className="diagnostics-alert">
							<AlertDescription>日志文件暂不可访问，以下为当前可取得的记录。</AlertDescription>
						</Alert>
					)}
					{loading && !report ? (
						<EmptyState className="diagnostics-empty" compact icon={LoaderCircle} busy description="正在读取诊断日志…" />
					) : report && !report.entries.length ? (
						<EmptyState className="diagnostics-empty" compact headingLevel={3} icon={FileCheck2} title="暂无异常记录" description="后续启动或读取异常会记录在这里。" />
					) : (
						report && (
							<ol>
								{[...report.entries].reverse().map((entry, index) => (
									<li key={`${entry.at}-${entry.code}-${index}`}>
										<time dateTime={entry.at} title={entry.at}>
											{localTime(entry.at)}
										</time>
										<div>
											<h4>{DIAGNOSTIC_DESCRIPTIONS[entry.code].title}</h4>
											<code>{entry.code}</code>
											<p>{DIAGNOSTIC_DESCRIPTIONS[entry.code].message}</p>
											{entry.context ? (
												<p className="diagnostics-context">{describeSubscriptionFailure(entry.context)}</p>
											) : (
												entry.code.startsWith('SUBSCRIPTIONS_') && <p className="diagnostics-context">旧记录未包含失败环节。</p>
											)}
										</div>
									</li>
								))}
							</ol>
						)
					)}
					{!!report?.ignoredLines && <p className="diagnostics-ignored">已忽略 {report.ignoredLines} 条无法识别的旧日志。</p>}
				</div>
				<div className="diagnostics-footer">
					<p role="status">记录错误类别、环节与时间；复制时附带运行环境版本。</p>
					<div>
						<Button
							variant="outline"
							size="sm"
							disabled={loading || copying}
							onClick={() => {
								void refresh();
							}}
						>
							<RefreshCw className={loading ? 'spin' : undefined} />
							刷新日志
						</Button>
						<Button
							size="sm"
							disabled={!report || loading || copying}
							onClick={() => {
								void copy();
							}}
						>
							{copying ? <LoaderCircle className="spin" /> : copied ? <Check /> : <Copy />}复制诊断信息
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

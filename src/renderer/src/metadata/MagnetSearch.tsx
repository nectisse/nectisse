import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, LoaderCircle, Magnet, RefreshCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/sonner';
import type { MagnetOrigin, MagnetResult, MagnetRow } from '../../../shared/magnets';
import './magnets.css';

const count = (value: number | null): string => (value === null ? '—' : value.toLocaleString('zh-CN'));

export function MagnetSearch({ origin, code }: { origin: MagnetOrigin; code: string }): React.JSX.Element {
	const [result, setResult] = useState<MagnetResult>();
	const [loading, setLoading] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	const [error, setError] = useState('');
	const current = useRef('');
	const originRef = useRef(origin);
	originRef.current = origin;

	const search = async (force = false): Promise<void> => {
		const id = crypto.randomUUID();
		current.current = id;
		setLoading(true);
		setCancelling(false);
		setError('');
		try {
			const next = await window.nectisse.magnets.search({ id, origin: originRef.current, force });
			if (current.current === id) {
				setResult(next);
			}
		} catch {
			if (current.current === id) {
				setError('磁链查询暂未响应，请重试；作品记录已失效时需重新查询资料。');
			}
		} finally {
			if (current.current === id) {
				current.current = '';
				setLoading(false);
				setCancelling(false);
			}
		}
	};

	useEffect(() => {
		let mounted = true;
		queueMicrotask(() => {
			if (mounted) {
				void search();
			}
		});
		return () => {
			mounted = false;
			const id = current.current;
			current.current = '';
			if (id) {
				void window.nectisse.magnets.cancel(id).catch(() => {});
			}
		};
	}, []);

	const cancel = async (): Promise<void> => {
		const id = current.current;
		if (!id) {
			return;
		}
		setCancelling(true);
		try {
			await window.nectisse.magnets.cancel(id);
		} catch {
			toast.error('取消请求未能送达，请重试。');
			if (current.current === id) {
				setCancelling(false);
			}
		}
	};

	const action = async (row: MagnetRow, kind: 'copy' | 'open'): Promise<void> => {
		try {
			if (!(await window.nectisse.magnets.action({ code, id: row.id, action: kind }))) {
				throw new Error('UNAVAILABLE');
			}
			if (kind === 'copy') {
				toast.success('磁链已复制');
			}
		} catch {
			toast.error(kind === 'copy' ? '磁链未能复制，请重新查询后重试。' : '来源页面未能打开，请稍后重试。');
		}
	};

	const ready = result?.status === 'ready';
	return (
		<section className="magnet-search" aria-label={`${code} 磁链搜索`}>
			<div className="magnet-search-toolbar">
				<div>
					<Magnet />
					<span>Sukebei</span>
					{ready && <small>{result.items.length} 条结果</small>}
				</div>
				{loading ? (
					<Button
						variant="outline"
						size="sm"
						disabled={cancelling}
						onClick={() => {
							void cancel();
						}}
					>
						<Square />
						{cancelling ? '正在取消' : '取消'}
					</Button>
				) : (
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							void search(true);
						}}
					>
						<RefreshCw />
						{ready ? '刷新' : '重新查询'}
					</Button>
				)}
			</div>
			{loading ? (
				<div className="magnet-search-state" role="status">
					<LoaderCircle className="spin" />
					<span>{cancelling ? '正在停止查询…' : `正在查询 ${code}…`}</span>
				</div>
			) : error || !ready ? (
				<p className="magnet-search-state" role={error || result?.status === 'failed' ? 'alert' : 'status'}>
					{error || result?.message || '尚未取得结果'}
				</p>
			) : result.items.length ? (
				<Table className="magnet-table" aria-label="Sukebei 磁链结果">
					<TableHeader>
						<TableRow>
							<TableHead>名称 / 上传时间</TableHead>
							<TableHead className="magnet-size">大小</TableHead>
							<TableHead className="magnet-seeds">做种</TableHead>
							<TableHead className="magnet-actions">操作</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{result.items.map((row) => (
							<TableRow key={row.id}>
								<TableCell>
									<span className="magnet-title" title={row.title}>
										{row.title}
									</span>
									<div className="magnet-meta">
										<time
											dateTime={row.uploadedAt || undefined}
											title={row.uploadedAt ? new Date(row.uploadedAt).toLocaleString('zh-CN', { hour12: false }) : undefined}
										>
											{row.uploadedAt ? new Date(row.uploadedAt).toLocaleDateString('zh-CN') : '上传时间未提供'}
										</time>
										<span>下载中 {count(row.leechers)}</span>
										<span>完成 {count(row.completed)}</span>
									</div>
								</TableCell>
								<TableCell className="magnet-size">{row.size || '—'}</TableCell>
								<TableCell className="magnet-seeds">{count(row.seeders)}</TableCell>
								<TableCell className="magnet-actions">
									<div>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={`复制磁链：${row.title}`}
											title="复制磁链"
											onClick={() => {
												void action(row, 'copy');
											}}
										>
											<Copy />
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={`查看来源：${row.title}`}
											title="查看来源页面"
											onClick={() => {
												void action(row, 'open');
											}}
										>
											<ExternalLink />
										</Button>
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<p className="magnet-search-state" role="status">
					没有找到编号匹配的磁链
				</p>
			)}
			{!loading && ready && (
				<p className="magnet-search-note">
					按站点默认顺序显示首页，最多 20 条。{result.checkedAt && ` 查询于 ${new Date(result.checkedAt).toLocaleString('zh-CN', { hour12: false })}`}
				</p>
			)}
		</section>
	);
}

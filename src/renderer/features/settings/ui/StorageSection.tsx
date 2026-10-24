import { useState } from 'react';
import { LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { useClearImageCache, useDesktopActions, usePreferences, useStorageUsage } from '@/shared/desktop';
import { Card } from '@/shared/ui/card';
import { Button } from '@/shared/ui/button';
import { OptionSelect } from '@/shared/ui/select';
import { toast } from '@/shared/ui/sonner';

function size(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KiB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
	}
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function StorageSection(): React.JSX.Element {
	const report = useStorageUsage();
	const clear = useClearImageCache();
	const limit = usePreferences((state) => state.imageCacheMiB);
	const { updatePreferences } = useDesktopActions();
	const [saving, setSaving] = useState(false);
	const usage = report.data;
	const busy = saving || clear.isPending;

	const changeLimit = async (value: string): Promise<void> => {
		setSaving(true);
		try {
			const reply = await updatePreferences({ imageCacheMiB: Number(value) });
			if (!reply.ok) {
				throw new Error(reply.message);
			}
			await report.refetch();
			toast.success('图片缓存上限已保存');
		} catch {
			toast.error('缓存上限未能保存，请重试');
		} finally {
			setSaving(false);
		}
	};

	const clearCache = async (): Promise<void> => {
		try {
			const result = await clear.mutateAsync();
			toast.success(result.removedFiles ? `已释放 ${size(result.freedBytes)}，清理 ${result.removedFiles} 个图片文件` : '没有可清理的图片缓存', {
				description: '收藏、资料、帖子摘要与已读状态均已保留。',
				duration: 6000,
			});
		} catch {
			toast.error('图片缓存未能清理，请重试');
		}
	};

	return (
		<section className="settings-section settings-preferences" aria-labelledby="storage-heading">
			<div className="settings-section-heading">
				<h2 id="storage-heading">本机存储</h2>
				<p>资料、帖子摘要与已读状态长期保留。</p>
			</div>
			<Card className="settings-card gap-0 py-0 ring-0">
				<div className="settings-row">
					<div className="settings-row-label">
						<h3>收藏占用</h3>
						<p>收藏资料与选定原图固定保留，不参与缓存清理。</p>
					</div>
					<div className="settings-value storage-value">
						<strong data-testid="collection-usage">{usage ? size(usage.collectionBytes) : '—'}</strong>
					</div>
				</div>
				<div className="settings-row">
					<div className="settings-row-label">
						<h3>可清理缓存</h3>
						<p>清理后，查看时会自动补取缺失图片。</p>
					</div>
					<div className="settings-value storage-value">
						<div>
							<strong data-testid="cache-usage">{usage ? size(usage.cacheBytes) : '—'}</strong>
							<p>{usage ? `原图 ${size(usage.originalBytes)} · 缩略图 ${size(usage.thumbnailBytes)}` : '正在读取存储用量…'}</p>
						</div>
						<Button
							size="sm"
							variant="outline"
							disabled={!usage || !usage.cacheBytes || busy}
							onClick={() => {
								void clearCache();
							}}
						>
							{clear.isPending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}清理缓存
						</Button>
					</div>
				</div>
				<div className="settings-row">
					<div className="settings-row-label">
						<h3>图片缓存上限</h3>
						<p>空间不足时先回收很久没看的原图，再清理旧缩略图。</p>
					</div>
					<div className="settings-value">
						<OptionSelect
							aria-label="图片缓存上限"
							value={String(limit)}
							disabled={busy}
							onValueChange={(value) => {
								void changeLimit(value);
							}}
							options={[64, 128, 256, 512, 1024, 2048, 4096, 8192].map((value) => ({
								value: String(value),
								label: `${value >= 1024 ? `${value / 1024} GiB` : `${value} MiB`}${value === 512 ? '（默认）' : ''}`,
							}))}
						/>
					</div>
				</div>
				<div className="settings-card-note storage-note">
					<p>
						图片过期后在查看时尝试刷新，刷新失败仍保留旧图；只有容量淘汰或手动清理才会回收缓存。
						{usage && usage.protectedBytes > 0 ? `另有头像 ${size(usage.protectedBytes)}，随关注信息保留。` : ''}
					</p>
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label="刷新存储用量"
						disabled={report.isFetching || busy}
						onClick={() => {
							void report.refetch();
						}}
					>
						<RefreshCw className={report.isFetching ? 'animate-spin' : ''} />
					</Button>
				</div>
				{report.isError && (
					<div className="settings-card-note" role="alert">
						存储用量暂时无法读取，请点击刷新重试。
					</div>
				)}
			</Card>
		</section>
	);
}

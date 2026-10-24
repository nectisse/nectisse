import { useSubscriptions, useDesktopActions } from '@/state';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Check, LoaderCircle, Search, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OptionSelect } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { EmptyState } from '@/components/empty-state';
import { StatusBadge } from '@/components/status-badge';
import type { FollowProvider } from '@shared/subscriptions';
import { FOLLOW_IDS, SOURCE_BY_ID, SOURCE_LABELS } from '@shared/sources';
import { IdentityAvatar } from './IdentityAvatar';

export interface FollowDialogSeed {
	provider: FollowProvider;
	query: string;
	token: number;
}

export function AddFollowDialog({
	seed,
	onClose,
	onFollow,
	onSettings,
	returnFocus,
}: {
	seed?: FollowDialogSeed;
	onClose: () => void;
	onFollow: (id: string, provider: FollowProvider) => void;
	onSettings: () => void;
	returnFocus: RefObject<HTMLElement | null>;
}): React.JSX.Element {
	const state = useSubscriptions((state) => ({ preferences: state.preferences, subscriptions: state.subscriptions, tasks: state.tasks }));
	const { invoke } = useDesktopActions();
	const [provider, setProvider] = useState<FollowProvider>('javdb');
	const [query, setQuery] = useState('');
	const [taskId, setTaskId] = useState('');
	const [pending, setPending] = useState(false);
	const [following, setFollowing] = useState('');
	const input = useRef<HTMLInputElement | null>(null);
	const generation = useRef(0);
	const ownedLookup = useRef('');
	const confirming = useRef(false);
	const open = useRef(false);
	open.current = !!seed;

	useEffect(() => {
		generation.current++;
		if (!seed) {
			return;
		}
		setProvider(seed.provider);
		setQuery(seed.query);
		setTaskId('');
		setPending(false);
		setFollowing('');
		ownedLookup.current = '';
		confirming.current = false;
	}, [seed?.token]);

	const task = state.tasks.find((value) => value.id === taskId);
	const querying = pending || (!!taskId && (!task || ['running', 'cancelling'].includes(task.status)));
	const otherBusy = state.tasks.some((value) => value.id !== taskId && value.kind !== 'covers' && ['running', 'cancelling'].includes(value.status));
	const enabled = state.preferences.enabledSources.includes(provider);

	const close = (): void => {
		if (confirming.current) {
			return;
		}
		generation.current++;
		if (ownedLookup.current && (!task || ['running', 'cancelling'].includes(task.status))) {
			void invoke({ action: 'cancel', id: ownedLookup.current });
		}
		ownedLookup.current = '';
		onClose();
	};

	const lookup = async (): Promise<void> => {
		if (pending || querying || otherBusy || confirming.current || !query.trim() || !enabled) {
			return;
		}
		const attempt = ++generation.current;
		setPending(true);
		setTaskId('');
		ownedLookup.current = '';
		const reply = await invoke({ action: 'lookup', provider, query });
		if (!open.current || attempt !== generation.current) {
			if (reply.ok && reply.id) {
				void invoke({ action: 'cancel', id: reply.id });
			}
			return;
		}
		setPending(false);
		if (reply.ok && reply.id) {
			ownedLookup.current = reply.id;
			setTaskId(reply.id);
		} else {
			toast.error(reply.message || '查询未开始', { id: 'follow-lookup', duration: 8000 });
		}
	};

	const follow = async (ref: string): Promise<void> => {
		if (!task || querying || otherBusy || confirming.current) {
			return;
		}
		confirming.current = true;
		setFollowing(ref);
		const reply = await invoke({ action: 'follow', taskId: task.id, ref });
		confirming.current = false;
		setFollowing('');
		if (reply.ok && reply.id) {
			toast.success(reply.message || '已关注', { id: 'follow-confirm' });
			ownedLookup.current = '';
			onFollow(reply.id, provider);
		} else {
			toast.error(reply.message || '关注失败', { id: 'follow-confirm', duration: 8000 });
		}
	};

	return (
		<Dialog
			open={!!seed}
			onOpenChange={(value) => {
				if (!value) {
					close();
				}
			}}
			disablePointerDismissal={!!following}
		>
			<DialogContent
				className="follow-dialog"
				initialFocus={input}
				finalFocus={() => (returnFocus.current?.isConnected ? returnFocus.current : document.getElementById('page-heading'))}
			>
				<header className="follow-dialog-header">
					<div>
						<DialogTitle>添加关注</DialogTitle>
						<DialogDescription>选择来源，查询并核对身份后确认关注。</DialogDescription>
					</div>
					<DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭添加关注" disabled={!!following} />}>
						<X />
					</DialogClose>
				</header>
				<div className="follow-dialog-scroll">
					<form
						className="follow-dialog-form"
						onSubmit={(event) => {
							event.preventDefault();
							void lookup();
						}}
					>
						<div className="follow-dialog-source">
							<Label htmlFor="follow-source">来源</Label>
							<OptionSelect
								id="follow-source"
								aria-label="关注来源"
								value={provider}
								disabled={querying || !!following}
								onValueChange={(value) => {
									setProvider(value);
									setTaskId('');
									generation.current++;
								}}
								options={(['javdb', ...FOLLOW_IDS.filter((id) => id !== 'javdb')] as FollowProvider[]).map((id) => ({
									value: id,
									label: `${SOURCE_LABELS[id]}${id === 'javdb' ? ' 演员' : ''}`,
								}))}
							/>
						</div>
						<div className="follow-dialog-query">
							<Label htmlFor="follow-query">{provider === 'javdb' ? '演员名或主页' : '创作者主页或账号'}</Label>
							<Input
								id="follow-query"
								ref={input}
								aria-label="主页、账号或演员名"
								value={query}
								disabled={querying || !!following}
								onChange={(event) => {
									setQuery(event.target.value);
									setTaskId('');
									generation.current++;
								}}
								placeholder={
									provider === 'javdb' ? '输入演员名或 JavDB 演员主页' : provider === 'fanbox' ? '粘贴 FANBOX 主页或输入账号 id' : '填写本站主页或原生账号'
								}
								autoComplete="off"
							/>
						</div>
						<Button type="submit" disabled={querying || otherBusy || !!following || !query.trim() || !enabled}>
							{querying ? <LoaderCircle className="spin" /> : <Search />}查询身份
						</Button>
					</form>
					<p className="follow-dialog-hint">{SOURCE_BY_ID[provider].note}</p>
					{!enabled ? (
						<div className="follow-dialog-notice">
							<p>此来源尚未启用。</p>
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									close();
									onSettings();
								}}
							>
								来源设置
							</Button>
						</div>
					) : querying ? (
						<div className="follow-dialog-status" role="status">
							<LoaderCircle className="spin" />
							<div>
								<strong>正在查询身份</strong>
								<p>{task?.phase || '正在向来源查询，请稍候。'}</p>
							</div>
						</div>
					) : task ? (
						<section className="follow-dialog-results" aria-label="身份查询结果">
							<div className="follow-dialog-results-heading">
								<h3>查询结果</h3>
								<span>{task.candidates.length} 个匹配</span>
							</div>
							{['failed', 'partial', 'cancelled', 'interrupted'].includes(task.status) && (
								<p className="follow-dialog-error" role="status">
									{task.phase}
								</p>
							)}
							{task.candidates.map((candidate) => {
								const known = state.subscriptions.some((sub) => sub.provider === candidate.provider && sub.ref === candidate.ref && sub.following);
								const aliases = candidate.aliases.filter((name) => name !== candidate.name);
								return (
									<article className="follow-dialog-candidate" key={candidate.ref} data-follow-ref={candidate.ref}>
										<IdentityAvatar identity={candidate} />
										<div className="follow-dialog-identity">
											<h3 title={candidate.name}>{candidate.name}</h3>
											<p className="follow-dialog-record">
												<StatusBadge>{candidate.recordType}</StatusBadge>
												<span>{candidate.ref}</span>
											</p>
											{aliases.length > 0 && (
												<p className="follow-dialog-aliases" title={aliases.join(' · ')}>
													{aliases.join(' · ')}
												</p>
											)}
											<p className="follow-dialog-url" title={candidate.url}>
												{candidate.url}
											</p>
											{candidate.bio && <p className="follow-dialog-bio">{candidate.bio}</p>}
										</div>
										<Button
											size="sm"
											disabled={known || !!following || otherBusy}
											onClick={() => {
												void follow(candidate.ref);
											}}
										>
											{known ? <Check /> : following === candidate.ref ? <LoaderCircle className="spin" /> : null}
											{known ? '已关注' : following === candidate.ref ? '正在关注' : '确认关注'}
										</Button>
									</article>
								);
							})}
							{task.status === 'succeeded' && !task.candidates.length && (
								<EmptyState compact headingLevel={3} icon={Search} title="没有找到匹配身份" description="试试其他名称，或直接填写本站主页链接。" />
							)}
						</section>
					) : (
						<EmptyState
							compact
							headingLevel={3}
							icon={Users}
							title="从一个姓名或主页开始"
							description={
								otherBusy
									? '其他订阅任务正在进行，完成后可以查询。'
									: provider === 'javdb'
										? '输入演员名，核对站点身份后关注新作。'
										: '填写创作者主页或站点账号，确认后收录动态。'
							}
						/>
					)}
				</div>
				<footer className="follow-dialog-footer">
					<p>核对身份后再确认关注。</p>
					<Button variant="outline" size="sm" disabled={!!following} onClick={close}>
						{querying ? '取消查询并关闭' : '关闭'}
					</Button>
				</footer>
			</DialogContent>
		</Dialog>
	);
}

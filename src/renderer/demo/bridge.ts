import type { DesktopBridge } from '@shared/protocol';
import { followCommandSchema, subscriptionSchema, entryPageRequestSchema, type CommandReply, type FollowCandidate, type FollowCommand } from '@shared/subscriptions';
import { mergePreferences, type Preferences } from '@shared/preferences';
import { canonicalFollow } from '@shared/source-identity';
import { isPerformerProvider } from '@shared/sources';
import { summarizeWork } from '@shared/library';
import { queryRequestSchema } from '@shared/metadata';
import { createDemoFixtures, demoHash } from './fixtures';

function channel<T extends { revision: number }>(state: T) {
	const listeners = new Set<(value: T) => void>();

	const get = async (): Promise<T> => structuredClone(state);

	const publish = (): void => {
		state.revision++;
		for (const listener of listeners) {
			listener(structuredClone(state));
		}
	};

	const subscribe = (listener: (value: T) => void): (() => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};

	return { get, publish, subscribe };
}

/** 示例会话实现同一桌面接口，不持有真实 bridge，也不访问本机存储。 */
export function createDemoBridge(theme: Preferences['theme'] = 'cream'): DesktopBridge {
	const fixture = createDemoFixtures(theme);
	const state = fixture.subscriptions;
	const metadata = fixture.metadata;
	const library = fixture.library;
	const allRecords = structuredClone(metadata.tasks[0]!.records);
	for (const sub of state.subscriptions) {
		sub.collected = state.entries.filter((entry) => entry.subscriptionId === sub.id).length;
		sub.latestEntry = state.entries.find((entry) => entry.subscriptionId === sub.id);
	}
	const subsChannel = channel(state);
	const metadataChannel = channel(metadata);
	const libraryChannel = channel(library);
	let nextSavedId = 401;
	const blocked = '示例数据不会连接原站或操作本机文件。';

	const publishSubscriptions = (): void => {
		for (const sub of state.subscriptions) {
			sub.unread = state.entries.filter((entry) => entry.subscriptionId === sub.id && !entry.read).length;
			sub.collected = state.entries.filter((entry) => entry.subscriptionId === sub.id).length;
			sub.latestEntry = state.entries.find((entry) => entry.subscriptionId === sub.id);
		}
		subsChannel.publish();
	};

	const command = async (input: FollowCommand): Promise<CommandReply> => {
		const command = followCommandSchema.parse(input);
		if (command.action === 'preferences') {
			state.preferences = structuredClone(command.value);
		} else if (command.action === 'preferences-patch') {
			state.preferences = mergePreferences(state.preferences, command.patch);
		} else if (command.action === 'query-sources') {
			state.preferences.querySources = command.sources;
		} else if (command.action === 'source-enabled') {
			state.preferences.enabledSources = command.enabled
				? [...new Set([...state.preferences.enabledSources, command.source])]
				: state.preferences.enabledSources.filter((source) => source !== command.source);
		} else if (command.action === 'read') {
			for (const entry of state.entries) {
				if (command.ids.includes(entry.id)) {
					entry.read = command.read;
				}
			}
		} else if (command.action === 'update') {
			const sub = state.subscriptions.find((sub) => sub.id === command.id);
			if (!sub) {
				return { ok: false, message: '示例人物不存在' };
			}
			if (command.intervalMinutes != null && isPerformerProvider(sub.provider) && command.intervalMinutes < 360) {
				return { ok: false, message: '演员新作检查间隔至少 360 分钟' };
			}
			if (command.following !== undefined) {
				sub.following = command.following;
				sub.enabled = command.following;
				sub.autoPaused = false;
			}
			if (command.enabled !== undefined) {
				sub.enabled = command.enabled;
				sub.autoPaused = false;
			}
			if (command.intervalMinutes !== undefined) {
				sub.intervalMinutes = command.intervalMinutes;
			}
		} else if (command.action === 'lookup') {
			if (!state.preferences.enabledSources.includes(command.provider)) {
				return { ok: false, message: '请先启用此来源' };
			}
			const known = state.subscriptions.filter((sub) => sub.provider === command.provider);
			const handle =
				command.query
					.replace(/^@/, '')
					.replace(/[^A-Za-z0-9_]/g, '')
					.slice(0, 15) || 'demo_creator';
			const ref =
				command.provider === 'x'
					? String(1900000000000000000n + BigInt(state.subscriptions.length + 10))
					: command.provider === 'patreon'
						? '100002'
						: ['kemono', 'pawchive', 'coomer'].includes(command.provider)
							? 'patreon/100002'
							: 'demoperson';
			const candidate: FollowCandidate = {
				provider: command.provider,
				ref,
				...(command.provider === 'x' ? { handle } : {}),
				name: command.query,
				url: canonicalFollow(command.provider, ref, handle),
				aliases: [],
				recordType: isPerformerProvider(command.provider) ? '演员' : '创作者',
				bio: '仅用于本次演示的虚构人物。',
				evidence: '内置示例，不连接原站。',
			};
			const id = crypto.randomUUID();
			state.tasks.unshift({
				id,
				kind: 'lookup',
				provider: command.provider,
				status: 'succeeded',
				phase: '示例候选已取得',
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				requests: 0,
				candidates: [...known.slice(0, 7), candidate],
				added: 0,
				reason: '',
				cancelRequestedAt: '',
			});
			state.tasks = state.tasks.slice(0, 20);
			publishSubscriptions();
			return { ok: true, id };
		} else if (command.action === 'follow') {
			const candidate = state.tasks.find((task) => task.id === command.taskId)?.candidates.find((candidate) => candidate.ref === command.ref);
			if (!candidate) {
				return { ok: false, message: '请先查询示例候选' };
			}
			let sub = state.subscriptions.find((sub) => sub.provider === candidate.provider && sub.ref === candidate.ref);
			if (!sub) {
				sub = subscriptionSchema.parse({
					...candidate,
					id: crypto.randomUUID(),
					kind: isPerformerProvider(candidate.provider) ? 'performer_releases' : 'creator_posts',
					following: true,
					enabled: true,
					autoPaused: false,
					intervalMinutes: null,
					createdAt: new Date().toISOString(),
					initialized: true,
					lastCheckedAt: '',
					nextCheckAt: '',
					lastError: '',
					coverage: '内置示例内容',
					failureCount: 0,
					unread: 0,
				});
				state.subscriptions.unshift(sub);
			}
			sub.following = true;
			sub.enabled = true;
			publishSubscriptions();
			return { ok: true, id: sub.id };
		} else if (command.action === 'check') {
			const sub = state.subscriptions.find((sub) => sub.id === command.id);
			if (!sub || !sub.following || !sub.enabled || !state.preferences.enabledSources.includes(sub.provider)) {
				return { ok: false, message: '此人物的检查已暂停或来源未启用' };
			}
			sub.lastCheckedAt = new Date().toISOString();
			sub.coverage = '示例检查完成，未连接原站';
		} else if (command.action === 'open' || command.action === 'credential') {
			return { ok: false, message: blocked };
		}
		publishSubscriptions();
		return { ok: true };
	};

	return {
		storage: {
			usage: async () => ({
				collectionBytes: 100000,
				protectedBytes: 0,
				cacheBytes: 0,
				originalBytes: 0,
				thumbnailBytes: 0,
				limitBytes: state.preferences.imageCacheMiB * 1024 * 1024,
				files: 1,
			}),
			clear: async () => ({
				freedBytes: 0,
				removedFiles: 0,
				usage: {
					collectionBytes: 100000,
					protectedBytes: 0,
					cacheBytes: 0,
					originalBytes: 0,
					thumbnailBytes: 0,
					limitBytes: state.preferences.imageCacheMiB * 1024 * 1024,
					files: 1,
				},
			}),
		},
		subscriptions: {
			getState: subsChannel.get,
			retry: subsChannel.get,
			command,
			onState: subsChannel.subscribe,
			onSettings: () => () => {},
			getEntries: async (input) => {
				const request = entryPageRequestSchema.parse(input);
				const entries = state.entries.filter((entry) => entry.subscriptionId === request.subscriptionId && (!request.unread || !entry.read));
				const start = (request.page - 1) * request.pageSize;
				return structuredClone({ entries: entries.slice(start, start + request.pageSize), total: entries.length, page: request.page, pageSize: request.pageSize });
			},
		},
		metadata: {
			getState: metadataChannel.get,
			retry: metadataChannel.get,
			onState: metadataChannel.subscribe,
			clearHistory: async () => {
				metadata.tasks = [];
				metadataChannel.publish();
				return { ok: true };
			},
			query: async (input) => {
				if (!queryRequestSchema.safeParse(input).success) {
					return { ok: false, message: '请输入至少两个字符并选择资料来源' };
				}
				const query = input.query.toLowerCase();
				const records = allRecords.filter(
					(record) =>
						input.sources.includes(record.source as 'dmm' | 'r18dev') &&
						`${record.code} ${record.title} ${record.people.map((person) => person.name).join(' ')}`.toLowerCase().includes(query),
				);
				const id = crypto.randomUUID();
				metadata.tasks.unshift({
					id,
					status: 'succeeded',
					phase: '示例查询完成',
					plan: { kind: 'title', query: input.query, code: '', contentId: '', sources: input.sources },
					startedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					records: structuredClone(records),
					outcomes: input.sources.map((source) => ({ source, status: 'success', reason: '', message: '', retryAfter: 0, requests: 0, warnings: [] })),
					requests: 0,
				});
				metadata.tasks = metadata.tasks.slice(0, 20);
				metadataChannel.publish();
				return { ok: true, taskId: id };
			},
			cancel: async () => {},
			openSource: async () => {
				throw new Error(blocked);
			},
		},
		library: {
			getState: libraryChannel.get,
			retry: libraryChannel.get,
			onState: libraryChannel.subscribe,
			getWork: async (id) => structuredClone(fixture.saved.find((work) => work.id === id)),
			save: async (input) => {
				const records = metadata.tasks.find((task) => task.id === input.taskId)?.records.filter((record) => record.code === input.code);
				if (!records?.length) {
					return { ok: false, message: '请先查询示例作品' };
				}
				if (input.coverId && !records.some((record) => record.covers.some((cover) => cover.id === input.coverId))) {
					return { ok: false, message: '请选择此作品的封面' };
				}
				const previous = fixture.saved.find((work) => work.code === input.code);
				const saved = {
					id: previous?.id ?? demoHash(nextSavedId++),
					code: input.code,
					savedAt: previous?.savedAt ?? new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					records: structuredClone(records),
					coverId: input.coverId ?? records[0]!.covers[0]?.id ?? null,
				};
				fixture.saved = [...fixture.saved.filter((work) => work.id !== saved.id), saved];
				library.works = fixture.saved.map(summarizeWork);
				libraryChannel.publish();
				return { ok: true, id: saved.id };
			},
			remove: async (id) => {
				fixture.saved = fixture.saved.filter((work) => work.id !== id);
				library.works = fixture.saved.map(summarizeWork);
				libraryChannel.publish();
				return { ok: true };
			},
			openSource: async () => {
				throw new Error(blocked);
			},
		},
		magnets: {
			search: async (input) => ({
				code: 'NECT-024',
				source: input.source ?? 'sukebei',
				status: 'failed',
				items: [],
				limit: 20,
				checkedAt: new Date().toISOString(),
				message: blocked,
				reason: 'unsupported',
				requests: 0,
				retryAfter: 0,
			}),
			cancel: async () => {},
			action: async () => false,
			openSite: async () => false,
		},
		diagnostics: {
			getReport: async () => ({
				generatedAt: new Date().toISOString(),
				environment: { appVersion: '0.1.0', system: '示例环境', architecture: '', tauriVersion: '', pythonVersion: '', runtimePhase: 'ready' },
				entries: [],
				logStatus: 'ready',
				ignoredLines: 0,
			}),
			copyReport: async () => ({ copied: false }),
			recordReadFailure: async () => {},
		},
		runtime: {
			getState: async () => ({ revision: 1, phase: 'ready', message: '示例数据就绪' }),
			retry: async () => ({ revision: 1, phase: 'ready', message: '示例数据就绪' }),
			onState: () => () => {},
		},
	};
}

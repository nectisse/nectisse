import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, session, shell, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IPC } from '../shared/protocol';
import { pythonLayout } from './python-layout';
import { RuntimeService } from './runtime';
import { MetadataService } from './metadata-service';
import { proxyFromRules } from './network-route';
import { METADATA_IPC, queryRequestSchema } from '../shared/metadata';
import { z } from 'zod';
import { SubscriptionStore } from './subscription-store';
import { SubscriptionsService } from './subscriptions-service';
import { SUBS_IPC, followCommandSchema } from '../shared/subscriptions';
import { SiteGate } from './site-gate';
import { readSubscriptionState } from './subscription-read';
import { DiagnosticLog } from './diagnostics';
import { DIAGNOSTICS_IPC, diagnosticCodeSchema, formatDiagnosticReport } from '../shared/diagnostics';
import { SUBSCRIPTION_READ } from '../shared/subscription-read';
import { subscriptionFailureContextSchema, type SubscriptionFailureContext } from '../shared/subscription-failure';
import { InitializationStep } from './initialization-step';
import { LibraryService } from './library-service';
import { LIBRARY_IPC, libraryIdSchema, librarySaveSchema } from '../shared/library';
import { sourceCooldownSeconds } from './source-policy';

const here = dirname(fileURLToPath(import.meta.url));
const iconPath = app.isPackaged ? join(process.resourcesPath, 'icons/icon-macos.png') : join(app.getAppPath(), 'resources/icons/icon-macos.png');
app.setName('Nectisse');
protocol.registerSchemesAsPrivileged([{ scheme: 'nectisse-cover', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const userDataOverride = app.commandLine.getSwitchValue('user-data-dir');
if (userDataOverride) app.setPath('userData', resolve(userDataOverride));
let window: BrowserWindow | null = null;
let runtime: RuntimeService | undefined;
let metadata: MetadataService | undefined;
let localReady: InitializationStep | undefined;
let metadataReady: InitializationStep | undefined;
let libraryReady: InitializationStep | undefined;
let library: LibraryService | undefined;
let subscriptions: SubscriptionsService | undefined;
let subscriptionStore: SubscriptionStore | undefined;
let quitting = false;
let diagnostics: DiagnosticLog | undefined;

function createWindow(): void {
	if (quitting) return;
	if (window && !window.isDestroyed()) {
		window.show();
		window.focus();
		return;
	}
	window = new BrowserWindow({
		title: 'Nectisse',
		icon: iconPath,
		width: 1280,
		height: 840,
		minWidth: 1000,
		minHeight: 700,
		backgroundColor: '#faf9f6',
		show: false,
		titleBarStyle: 'hiddenInset',
		webPreferences: {
			preload: join(here, '../preload/index.cjs'),
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});
	const web = window.webContents;
	const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
	const entry = pathToFileURL(join(here, '../renderer/index.html')).href;
	const allowedDocument = (url: string): boolean => {
		if (devUrl) return new URL(url).origin === new URL(devUrl).origin;
		return url === entry || url.startsWith(`${entry}#`);
	};
	web.setWindowOpenHandler(() => ({ action: 'deny' }));
	web.on('will-navigate', (event, url) => {
		if (!allowedDocument(url)) event.preventDefault();
	});
	web.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	window.once('ready-to-show', () => window?.show());
	window.on('closed', () => {
		window = null;
	});
	if (devUrl) void window.loadURL(devUrl);
	else void window.loadFile(join(here, '../renderer/index.html'));
}

function trusted(event: IpcMainInvokeEvent): void {
	if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender');
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (window?.isMinimized()) window.restore();
		if (app.isReady()) createWindow();
	});
	app.on('activate', () => {
		if (app.isReady()) createWindow();
	});
	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') app.quit();
	});
	app.on('before-quit', (event) => {
		if (quitting) return;
		event.preventDefault();
		quitting = true;
		void (async () => {
			try {
				await Promise.all([localReady?.close(), metadataReady?.close(), libraryReady?.close()]);
				await library?.stop();
				await subscriptions?.stop();
				await metadata?.stop();
				await runtime?.stop();
				subscriptionStore?.close();
			} finally {
				// Let the cancelled native Cmd+Q event unwind before starting the final quit.
				setImmediate(() => app.quit());
			}
		})();
	});
	void app
		.whenReady()
		.then(() => {
			if (quitting) return;
			if (process.platform === 'darwin') app.dock?.setIcon(iconPath);
			diagnostics = new DiagnosticLog(app.getPath('userData'));
			const diagnosticReport = () => {
				const environment = runtime?.getState();
				return diagnostics!.snapshot({
					appVersion: app.getVersion(),
					system: `${process.platform} ${process.getSystemVersion()}`,
					architecture: process.arch,
					electronVersion: process.versions.electron,
					pythonVersion: environment?.health?.pythonVersion ?? '',
					runtimePhase: environment?.phase ?? 'unavailable',
				});
			};
			ipcMain.handle(DIAGNOSTICS_IPC.get, (event) => {
				trusted(event);
				return diagnosticReport();
			});
			ipcMain.handle(DIAGNOSTICS_IPC.copy, (event) => {
				trusted(event);
				try {
					const report = diagnosticReport();
					clipboard.writeText(formatDiagnosticReport(report));
					return { copied: true, report };
				} catch {
					return { copied: false };
				}
			});
			ipcMain.handle(DIAGNOSTICS_IPC.recordRead, (event, code: unknown, context: unknown) => {
				trusted(event);
				const parsed = diagnosticCodeSchema.extract(Object.values(SUBSCRIPTION_READ)).parse(code);
				diagnostics!.recordFromRenderer(parsed, subscriptionFailureContextSchema.optional().parse(context));
			});
			runtime = new RuntimeService(pythonLayout(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged));
			const resolveProxy = async (url: string): Promise<string> => {
				const preferences = subscriptionStore!.preferences();
				return preferences.proxyMode === 'direct'
					? ''
					: preferences.proxyMode === 'custom'
						? preferences.proxyUrl
						: proxyFromRules(await session.defaultSession.resolveProxy(url));
			};
			let gate: SiteGate | undefined;
			localReady = new InitializationStep(async () => {
				subscriptionStore ??= new SubscriptionStore(app.getPath('userData'), {
					available: () => safeStorage.isEncryptionAvailable(),
					encrypt: (value) => safeStorage.encryptString(value),
					decrypt: (value) => safeStorage.decryptString(value),
				});
				gate ??= new SiteGate(subscriptionStore);
				if (!subscriptions) {
					subscriptions = new SubscriptionsService(
						subscriptionStore,
						runtime!.host,
						resolveProxy,
						(url) => shell.openExternal(url),
						2000,
						(source, signal) => gate!.permit(source, signal),
					);
					subscriptions.on('state', (state) => {
						if (window && !window.isDestroyed()) window.webContents.send(SUBS_IPC.state, state);
					});
					subscriptions.on('secure-storage-error', (context: SubscriptionFailureContext) => {
						diagnostics?.record('SECURE_STORAGE_CHECK_FAILED', context);
					});
				}
				await subscriptions.initialize();
				if (!quitting) subscriptions.start();
			});
			const waitLocal = async (retry = false): Promise<void> => {
				try {
					await (retry ? localReady!.retry() : localReady!.run());
				} catch (error) {
					readSubscriptionState(
						() => {
							throw error;
						},
						(code, context) => diagnostics!.record(code, context),
					);
				}
			};
			const readLocal = () =>
				readSubscriptionState(
					() => subscriptions!.getState(),
					(code, context) => diagnostics!.record(code, context),
				);
			// Register recovery IPC before opening any database or cache directory.
			ipcMain.handle(SUBS_IPC.get, async (event) => {
				trusted(event);
				await waitLocal();
				return readLocal();
			});
			ipcMain.handle(SUBS_IPC.retry, async (event) => {
				trusted(event);
				const pending = waitLocal(true);
				void metadataReady!.retry().catch(() => {
					if (!quitting) diagnostics?.record('METADATA_INITIALIZATION_FAILED');
				});
				await pending;
				return readLocal();
			});
			ipcMain.handle(SUBS_IPC.command, async (event, command: unknown) => {
				trusted(event);
				await waitLocal();
				return subscriptions!.command(followCommandSchema.parse(command));
			});
			const observedOutcomes = new Set<string>();
			metadataReady = new InitializationStep(async () => {
				await localReady!.run();
				if (quitting) throw new Error('APP_STOPPING');
				const candidate = new MetadataService(
					app.getPath('userData'),
					runtime!.host,
					resolveProxy,
					2000,
					() => subscriptionStore!.preferences(),
					(source) => subscriptionStore!.credential(source),
					(source, signal) => gate!.permit(source, signal),
				);
				metadata = candidate;
				metadata.on('state', (state: ReturnType<MetadataService['getState']>) => {
					if (window && !window.isDestroyed()) window.webContents.send(METADATA_IPC.state, state);
					for (const task of state.tasks)
						if (!['cancelled', 'interrupted'].includes(task.status))
							for (const outcome of task.outcomes) {
								const key = `${task.id}:${outcome.source}:${outcome.reason}`;
								if (observedOutcomes.has(key) || outcome.reason === 'cooldown' || outcome.reason === 'budget_exceeded') continue;
								observedOutcomes.add(key);
								const checkedAt = task.finishedAt ?? new Date().toISOString();
								const previous = subscriptionStore!.source(outcome.source);
								if (previous.checkedAt && previous.checkedAt >= checkedAt) continue;
								const cooldown = sourceCooldownSeconds(outcome.reason, outcome.retryAfter);
								subscriptionStore!.saveSource(outcome.source, {
									...previous,
									checkedAt,
									state: outcome.status === 'success' ? '最近访问成功' : '需要处理',
									message: outcome.status === 'success' ? '' : outcome.message,
									cooldownUntil: cooldown ? Date.parse(checkedAt) + cooldown * 1000 : 0,
								});
							}
					subscriptions!.refresh();
				});
				try {
					await candidate.initialize();
				} catch (error) {
					candidate.removeAllListeners();
					await candidate.stop();
					metadata = undefined;
					throw error;
				}
			});
			const waitMetadata = async (retry = false): Promise<void> => {
				try {
					if (retry) await waitLocal(true);
					await (retry ? metadataReady!.retry() : metadataReady!.run());
				} catch {
					throw new Error('METADATA_UNAVAILABLE');
				}
			};
			ipcMain.handle(METADATA_IPC.get, async (event) => {
				trusted(event);
				await waitMetadata();
				return metadata!.getState();
			});
			ipcMain.handle(METADATA_IPC.retry, async (event) => {
				trusted(event);
				await waitMetadata(true);
				return metadata!.getState();
			});
			ipcMain.handle(METADATA_IPC.query, async (event, request: unknown) => {
				trusted(event);
				await waitMetadata();
				return metadata!.query(queryRequestSchema.parse(request));
			});
			ipcMain.handle(METADATA_IPC.cancel, async (event, id: unknown) => {
				trusted(event);
				await waitMetadata();
				await metadata!.cancel(z.string().uuid().parse(id));
			});
			ipcMain.handle(METADATA_IPC.openSource, async (event, input: unknown) => {
				trusted(event);
				await waitMetadata();
				const { taskId, recordId } = z.object({ taskId: z.string().uuid(), recordId: z.string().regex(/^[a-f0-9]{64}$/) }).parse(input);
				const url = metadata!.sourceUrl(taskId, recordId);
				if (url) await shell.openExternal(url);
			});
			libraryReady = new InitializationStep(async () => {
				if (quitting) throw new Error('APP_STOPPING');
				const candidate = new LibraryService(app.getPath('userData'));
				try {
					await candidate.initialize();
				} catch (error) {
					await candidate.stop();
					throw error;
				}
				library = candidate;
				candidate.on('state', (state) => {
					if (window && !window.isDestroyed()) window.webContents.send(LIBRARY_IPC.state, state);
				});
			});
			const waitLibrary = async (retry = false): Promise<void> => {
				try {
					await (retry ? libraryReady!.retry() : libraryReady!.run());
				} catch {
					diagnostics?.record('LIBRARY_INITIALIZATION_FAILED');
					throw new Error('LIBRARY_UNAVAILABLE');
				}
			};
			ipcMain.handle(LIBRARY_IPC.get, async (event) => {
				trusted(event);
				await waitLibrary();
				return library!.getState();
			});
			ipcMain.handle(LIBRARY_IPC.retry, async (event) => {
				trusted(event);
				await waitLibrary(true);
				return library!.getState();
			});
			ipcMain.handle(LIBRARY_IPC.work, async (event, id: unknown) => {
				trusted(event);
				await waitLibrary();
				return library!.getWork(libraryIdSchema.parse(id));
			});
			ipcMain.handle(LIBRARY_IPC.save, async (event, value: unknown) => {
				trusted(event);
				const input = librarySaveSchema.parse(value);
				await waitLibrary();
				await waitMetadata();
				const task = metadata!.getState().tasks.find((task) => task.id === input.taskId);
				const order = subscriptionStore!.preferences().metadataPriority;
				const records = task?.records.filter((record) => record.code === input.code).sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
				if (!records?.length) return { ok: false, message: '查询记录已不在最近列表中，请重新查询后收藏。' };
				try {
					const work = await library!.save(records, input.coverId, input.replace, (hash) => metadata!.image(hash));
					return { ok: true, id: work.id };
				} catch (error) {
					return {
						ok: false,
						message:
							error instanceof Error && error.message === 'LIBRARY_COVER_UNAVAILABLE'
								? '选定封面的本地缓存不可用，请重新查询或选择其他封面。'
								: error instanceof Error && error.message === 'LIBRARY_FULL'
									? '当前最多收藏 5000 部作品，请先整理收藏。'
									: '收藏未能保存，请检查本机可用空间后重试。',
					};
				}
			});
			ipcMain.handle(LIBRARY_IPC.remove, async (event, id: unknown) => {
				trusted(event);
				await waitLibrary();
				try {
					await library!.remove(libraryIdSchema.parse(id));
					return { ok: true };
				} catch {
					return { ok: false, message: '取消收藏未完成，请重新检查收藏库后重试。' };
				}
			});
			ipcMain.handle(LIBRARY_IPC.openSource, async (event, input: unknown) => {
				trusted(event);
				await waitLibrary();
				const { id, recordId } = z.object({ id: libraryIdSchema, recordId: libraryIdSchema }).parse(input);
				const url = library!.sourceUrl(id, recordId);
				if (url) await shell.openExternal(url);
			});
			protocol.handle('nectisse-cover', async (request) => {
				const url = new URL(request.url);
				if (request.method !== 'GET' || !['image', 'updates', 'avatars', 'library'].includes(url.hostname) || !/^\/[a-f0-9]{64}$/.test(url.pathname))
					return new Response(null, { status: 400 });
				if (url.hostname === 'image') await waitMetadata();
				else if (url.hostname === 'library') await waitLibrary();
				else await waitLocal();
				const found =
					url.hostname === 'image'
						? await metadata!.image(url.pathname.slice(1))
						: url.hostname === 'library'
							? await library!.image(url.pathname.slice(1))
							: await subscriptions!.image(url.pathname.slice(1));
				if (!found) return new Response(null, { status: 404 });
				const type = found.asset.format === 'JPEG' ? 'image/jpeg' : found.asset.format === 'PNG' ? 'image/png' : 'image/webp';
				return new Response(new Uint8Array(found.bytes), {
					headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' },
				});
			});
			ipcMain.handle(IPC.runtimeGet, (event) => {
				trusted(event);
				return runtime!.getState();
			});
			ipcMain.handle(IPC.runtimeRetry, (event) => {
				trusted(event);
				return runtime!.start();
			});
			runtime.on('state', (state) => {
				if (state.phase === 'error') diagnostics?.record(state.errorCode ?? 'RUNTIME_CHECK_FAILED');
				if (window && !window.isDestroyed()) window.webContents.send(IPC.runtimeState, state);
			});
			Menu.setApplicationMenu(
				Menu.buildFromTemplate([
					{
						label: 'Nectisse',
						submenu: [
							{ role: 'about' },
							{
								label: '设置…',
								accelerator: 'CommandOrControl+,',
								click: () => {
									createWindow();
									window?.webContents.send(SUBS_IPC.settings);
								},
							},
							{ type: 'separator' },
							{ role: 'hide' },
							{ role: 'hideOthers' },
							{ role: 'unhide' },
							{ type: 'separator' },
							{ role: 'quit', label: '退出 Nectisse' },
						],
					},
					{
						label: '编辑',
						submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
					},
					{ label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
					{
						label: '帮助',
						submenu: [
							{
								label: '运行环境信息',
								click: () => {
									const state = runtime!.getState();
									void dialog.showMessageBox({
										type: 'info',
										title: 'Nectisse 运行环境',
										message: state.message,
										detail: state.health
											? `Python ${state.health.pythonVersion}\nHTTPX ${state.health.httpxVersion}\ncurl_cffi ${state.health.curlCffiVersion}\nPeach ${state.health.peachVersion} 传输模块\n\n${state.health.executable}`
											: '可在主窗口重试环境检查。',
									});
								},
							},
						],
					},
				]),
			);
			createWindow();
			void runtime.start();
			void localReady.run().catch(() => {
				if (!quitting) diagnostics?.record('APP_INITIALIZATION_FAILED');
			});
			void metadataReady.run().catch(() => {
				if (!quitting) diagnostics?.record('METADATA_INITIALIZATION_FAILED');
			});
			void libraryReady.run().catch(() => {
				if (!quitting) diagnostics?.record('LIBRARY_INITIALIZATION_FAILED');
			});
		})
		.catch(() => {
			if (quitting) return;
			diagnostics?.record('APP_INITIALIZATION_FAILED');
			createWindow();
			dialog.showErrorBox('Nectisse 本机数据未能打开', '应用未开始采集。请检查应用数据目录的可用空间与权限；原有数据库已保留。');
		});
}

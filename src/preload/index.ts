import { contextBridge, ipcRenderer } from 'electron';
import { IPC, runtimeStateSchema, type DesktopBridge, type RuntimeState } from '../shared/protocol';
import { METADATA_IPC, metadataStateSchema, queryReplySchema, queryRequestSchema } from '../shared/metadata';
import { SUBS_IPC, subscriptionsStateSchema, followCommandSchema, commandReplySchema } from '../shared/subscriptions';
import { SUBSCRIPTION_READ, subscriptionReadCode } from '../shared/subscription-read';
import { DIAGNOSTICS_IPC, diagnosticCopyReplySchema, diagnosticReportSchema, diagnosticCodeSchema } from '../shared/diagnostics';
import { subscriptionFailureContext, subscriptionFailureContextSchema } from '../shared/subscription-failure';
import { LIBRARY_IPC, libraryStateSchema, savedWorkSchema, libraryIdSchema, librarySaveSchema, libraryReplySchema } from '../shared/library';

const bridge: DesktopBridge = {
	library: {
		getState: async () => libraryStateSchema.parse(await ipcRenderer.invoke(LIBRARY_IPC.get)),

		retry: async () => libraryStateSchema.parse(await ipcRenderer.invoke(LIBRARY_IPC.retry)),

		getWork: async (id) => savedWorkSchema.optional().parse(await ipcRenderer.invoke(LIBRARY_IPC.work, libraryIdSchema.parse(id))),

		save: async (input) => libraryReplySchema.parse(await ipcRenderer.invoke(LIBRARY_IPC.save, librarySaveSchema.parse(input))),

		remove: async (id) => libraryReplySchema.parse(await ipcRenderer.invoke(LIBRARY_IPC.remove, libraryIdSchema.parse(id))),

		openSource: async (id, recordId) => {
			await ipcRenderer.invoke(LIBRARY_IPC.openSource, { id: libraryIdSchema.parse(id), recordId: libraryIdSchema.parse(recordId) });
		},

		onState: (callback) => {
			const listener = (_event: Electron.IpcRendererEvent, input: unknown): void => {
				const parsed = libraryStateSchema.safeParse(input);
				if (parsed.success) {
					callback(parsed.data);
				}
			};

			ipcRenderer.on(LIBRARY_IPC.state, listener);
			return () => ipcRenderer.removeListener(LIBRARY_IPC.state, listener);
		},
	},
	diagnostics: {
		getReport: async () => diagnosticReportSchema.parse(await ipcRenderer.invoke(DIAGNOSTICS_IPC.get)),

		copyReport: async () => diagnosticCopyReplySchema.parse(await ipcRenderer.invoke(DIAGNOSTICS_IPC.copy)),

		recordReadFailure: async (code, context) => {
			await ipcRenderer.invoke(
				DIAGNOSTICS_IPC.recordRead,
				diagnosticCodeSchema.extract(Object.values(SUBSCRIPTION_READ)).parse(code),
				subscriptionFailureContextSchema.optional().parse(context),
			);
		},
	},
	subscriptions: {
		retry: async () => {
			try {
				return subscriptionsStateSchema.parse(await ipcRenderer.invoke(SUBS_IPC.retry));
			} catch (error) {
				throw new Error(subscriptionReadCode(error));
			}
		},

		getState: async () => {
			let value: unknown;
			try {
				value = await ipcRenderer.invoke(SUBS_IPC.get);
			} catch (error) {
				const code = subscriptionReadCode(error);
				// Main-process read failures already have the precise snapshot stage.
				if (!(error instanceof Error) || !Object.values(SUBSCRIPTION_READ).some((value) => error.message.includes(value))) {
					void ipcRenderer.invoke(DIAGNOSTICS_IPC.recordRead, code, subscriptionFailureContext(error, 'ipc')).catch(() => {});
				}
				throw new Error(code);
			}
			const result = subscriptionsStateSchema.safeParse(value);
			if (!result.success) {
				throw new Error(SUBSCRIPTION_READ.invalid);
			}
			return result.data;
		},

		command: async (command) => commandReplySchema.parse(await ipcRenderer.invoke(SUBS_IPC.command, followCommandSchema.parse(command))),

		onState: (callback) => {
			const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
				const result = subscriptionsStateSchema.safeParse(value);
				if (result.success) {
					callback(result.data);
				}
			};

			ipcRenderer.on(SUBS_IPC.state, listener);
			return () => ipcRenderer.removeListener(SUBS_IPC.state, listener);
		},

		onSettings: (callback) => {
			const listener = (): void => callback();

			ipcRenderer.on(SUBS_IPC.settings, listener);
			return () => ipcRenderer.removeListener(SUBS_IPC.settings, listener);
		},
	},
	metadata: {
		getState: async () => metadataStateSchema.parse(await ipcRenderer.invoke(METADATA_IPC.get)),

		retry: async () => metadataStateSchema.parse(await ipcRenderer.invoke(METADATA_IPC.retry)),

		query: async (request) => queryReplySchema.parse(await ipcRenderer.invoke(METADATA_IPC.query, queryRequestSchema.parse(request))),

		cancel: async (id) => {
			await ipcRenderer.invoke(METADATA_IPC.cancel, id);
		},

		openSource: async (taskId, recordId) => {
			await ipcRenderer.invoke(METADATA_IPC.openSource, { taskId, recordId });
		},

		onState: (callback) => {
			const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
				const parsed = metadataStateSchema.safeParse(value);
				if (parsed.success) {
					callback(parsed.data);
				}
			};

			ipcRenderer.on(METADATA_IPC.state, listener);
			return () => ipcRenderer.removeListener(METADATA_IPC.state, listener);
		},
	},
	runtime: {
		getState: async () => runtimeStateSchema.parse(await ipcRenderer.invoke(IPC.runtimeGet)),

		retry: async () => runtimeStateSchema.parse(await ipcRenderer.invoke(IPC.runtimeRetry)),

		onState: (callback) => {
			const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
				const parsed = runtimeStateSchema.safeParse(value);
				if (parsed.success) {
					callback(parsed.data as RuntimeState);
				}
			};

			ipcRenderer.on(IPC.runtimeState, listener);
			return () => ipcRenderer.removeListener(IPC.runtimeState, listener);
		},
	},
};

contextBridge.exposeInMainWorld('nectisse', bridge);

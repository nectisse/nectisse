import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { IPC, runtimeStateSchema, type DesktopBridge, type RuntimeState } from '@shared/protocol';
import { METADATA_IPC, metadataStateSchema, queryReplySchema, queryRequestSchema } from '@shared/metadata';
import {
	SUBS_IPC,
	subscriptionsStateSchema,
	followCommandSchema,
	commandReplySchema,
	entryPageRequestSchema,
	entryPageSchema,
	avatarReplySchema,
	entryDetailReplySchema,
	entryImageSaveSchema,
	imageSaveReplySchema,
} from '@shared/subscriptions';
import { SUBSCRIPTION_READ, subscriptionReadCode } from '@shared/subscription-read';
import { DIAGNOSTICS_IPC, diagnosticCopyReplySchema, diagnosticReportSchema, diagnosticCodeSchema } from '@shared/diagnostics';
import { subscriptionFailureContext, subscriptionFailureContextSchema } from '@shared/subscription-failure';
import { LIBRARY_IPC, libraryStateSchema, savedWorkSchema, libraryIdSchema, librarySaveSchema, libraryReplySchema } from '@shared/library';
import { MAGNET_IPC, magnetRequestSchema, magnetResultSchema, magnetActionSchema, externalMagnetSiteSchema } from '@shared/magnets';
import { z } from 'zod';
import { STORAGE_IPC, storageUsageSchema, storageClearSchema } from '@shared/storage';

type DesktopListener = (event: unknown, value: unknown) => void;

const listeners = new Map<DesktopListener, Promise<UnlistenFn>>();
const ipcRenderer = {
	invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
		await Promise.all(listeners.values());
		return invoke('desktop', { channel, args });
	},

	on: (channel: string, callback: DesktopListener): void => {
		const subscription = listen(channel, (event) => callback(undefined, event.payload));
		listeners.set(callback, subscription);
		void subscription.catch(() => listeners.delete(callback));
	},

	removeListener: (_channel: string, callback: DesktopListener): void => {
		const subscription = listeners.get(callback);
		listeners.delete(callback);
		void subscription?.then((unsubscribe) => unsubscribe()).catch(() => {});
	},
};

const bridge: DesktopBridge = {
	storage: {
		usage: async () => storageUsageSchema.parse(await ipcRenderer.invoke(STORAGE_IPC.usage)),

		clear: async () => storageClearSchema.parse(await ipcRenderer.invoke(STORAGE_IPC.clear)),
	},
	magnets: {
		search: async (request) => magnetResultSchema.parse(await ipcRenderer.invoke(MAGNET_IPC.search, magnetRequestSchema.parse(request))),

		cancel: async (id) => {
			await ipcRenderer.invoke(MAGNET_IPC.cancel, z.string().uuid().parse(id));
		},

		action: async (input) => z.boolean().parse(await ipcRenderer.invoke(MAGNET_IPC.action, magnetActionSchema.parse(input))),

		openSite: async (site) => z.boolean().parse(await ipcRenderer.invoke(MAGNET_IPC.openSite, externalMagnetSiteSchema.parse(site))),
	},
	library: {
		getState: async () => libraryStateSchema.parse(await ipcRenderer.invoke(LIBRARY_IPC.get)),

		retry: async () => libraryStateSchema.parse(await ipcRenderer.invoke(LIBRARY_IPC.retry)),

		getWork: async (id) =>
			savedWorkSchema
				.nullish()
				.transform((value) => value ?? undefined)
				.parse(await ipcRenderer.invoke(LIBRARY_IPC.work, libraryIdSchema.parse(id))),

		save: async (input) => libraryReplySchema.parse(await ipcRenderer.invoke(LIBRARY_IPC.save, librarySaveSchema.parse(input))),

		remove: async (id) => libraryReplySchema.parse(await ipcRenderer.invoke(LIBRARY_IPC.remove, libraryIdSchema.parse(id))),

		openSource: async (id, recordId) => {
			await ipcRenderer.invoke(LIBRARY_IPC.openSource, { id: libraryIdSchema.parse(id), recordId: libraryIdSchema.parse(recordId) });
		},

		onState: (callback) => {
			const listener = (_event: unknown, input: unknown): void => {
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
		saveImage: async (request) => imageSaveReplySchema.parse(await ipcRenderer.invoke(SUBS_IPC.saveImage, entryImageSaveSchema.parse(request))),

		getEntry: async (id) =>
			entryDetailReplySchema.parse(
				await ipcRenderer.invoke(
					SUBS_IPC.entry,
					z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.parse(id),
				),
			),

		uploadAvatar: async (id) => avatarReplySchema.parse(await ipcRenderer.invoke(SUBS_IPC.uploadAvatar, z.string().uuid().parse(id))),

		getEntries: async (request) => entryPageSchema.parse(await ipcRenderer.invoke(SUBS_IPC.entries, entryPageRequestSchema.parse(request))),

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
				// 本机服务的读取失败已包含具体环节。
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
			const listener = (_event: unknown, value: unknown): void => {
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

		clearHistory: async () => queryReplySchema.parse(await ipcRenderer.invoke(METADATA_IPC.clearHistory)),

		cancel: async (id) => {
			await ipcRenderer.invoke(METADATA_IPC.cancel, id);
		},

		openSource: async (taskId, recordId) => {
			await ipcRenderer.invoke(METADATA_IPC.openSource, { taskId, recordId });
		},

		onState: (callback) => {
			const listener = (_event: unknown, value: unknown): void => {
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
			const listener = (_event: unknown, value: unknown): void => {
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

if (window.__TAURI_INTERNALS__) {
	window.nectisse = bridge;
}

if (window.__TAURI_INTERNALS__) {
	document.addEventListener('mousedown', (event) => {
		const target = event.target;
		if (event.button !== 0 || !(target instanceof Element) || !target.closest('.window-drag') || target.closest('button, input, select, textarea, a, [role="button"]')) {
			return;
		}
		if (event.detail === 2) {
			void getCurrentWindow().toggleMaximize();
		} else {
			void getCurrentWindow().startDragging();
		}
	});
}

/// <reference types="vite/client" />

import type { DesktopBridge } from '@shared/protocol';

declare global {
	interface Window {
		nectisse: DesktopBridge;
	}
}

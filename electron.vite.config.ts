import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
	main: {},
	preload: {
		build: {
			externalizeDeps: false,
			rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
		},
	},
	renderer: {
		resolve: { alias: { '@': resolve(root, 'src/renderer/src') } },
		plugins: [react(), tailwindcss()],
	},
});

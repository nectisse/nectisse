import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	root: 'src/renderer',
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: { '@': fileURLToPath(new URL('./src/renderer', import.meta.url)), '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
	},
	server: { host: '127.0.0.1', port: 1420, strictPort: true },
	build: { outDir: '../../dist', emptyOutDir: true, target: 'safari16' },
});

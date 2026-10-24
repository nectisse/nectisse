import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pathConfig from './tsconfig.paths.json';

const root = fileURLToPath(new URL('.', import.meta.url));
const alias = Object.fromEntries(
	Object.entries(pathConfig.compilerOptions.paths).map(([name, [target]]) => [name.replace(/\/\*$/, ''), resolve(root, target!.replace(/\/\*$/, ''))]),
);

export default defineConfig({
	main: { resolve: { alias } },
	preload: {
		resolve: { alias },
		build: {
			externalizeDeps: false,
			rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
		},
	},
	renderer: {
		resolve: { alias },
		plugins: [react(), tailwindcss()],
	},
});

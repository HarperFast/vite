import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
	build: {
		// Match the plugin's `output` option (the plugin sets this when it builds; this keeps a standalone
		// `vite build` consistent).
		outDir: 'dist',
		emptyOutDir: true,
	},
});

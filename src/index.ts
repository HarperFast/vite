import { join } from 'node:path';
import type { Scope } from './types.ts';
import * as vite from 'vite';

export async function handleApplication(scope: Scope) {
	const componentPath = scope.directory;

	const viteInstance = await vite.createServer({
		root: componentPath,
		configFile: join(componentPath, 'vite.config.js'),
		server: { middlewareMode: true },
	});

	scope.server.http(async (request) => {
		return await viteInstance.middlewares(request._nodeRequest, request._nodeResponse);
	});

	scope.on('close', () => viteInstance.close());
}

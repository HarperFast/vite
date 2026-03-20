import type { Scope } from 'harperdb';
import { join } from 'node:path';
import * as vite from 'vite';
import { parentPort } from 'node:worker_threads';

export const viteWrapper = {
	createServer: vite.createServer,
};

export async function handleApplication(scope: Scope) {
	const componentPath = scope.directory;

	const viteInstance = await viteWrapper.createServer({
		root: componentPath,
		configFile: join(componentPath, 'vite.config.js'),
		server: { middlewareMode: true },
	});

	if (scope?.server?.http) {
		scope.server.http(async (request: any) => viteInstance.middlewares(request._nodeRequest, request._nodeResponse));
	}

	scope.on('close', () => viteInstance.close());

	// TODO: Once `scope.close` is emitting properly, we won't need this. Hopefully.
	//       To you who read this in 2 years and shake your head: I salute you, sir or madam.
	parentPort?.on('message', (msg) => {
		if (msg.type === 'shutdown') {
			viteInstance.close();
		}
	});
}

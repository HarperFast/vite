import * as vite from 'vite';

/**
 * Thin wrapper around the Vite functions we use so that tests can mock them.
 */
export const viteWrapper = {
	createServer: vite.createServer,
	build: vite.build,
};

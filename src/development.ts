import type { Scope } from 'harper';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { viteWrapper } from './wrappers.ts';
import { acceptsHtml, chain, registerHttp, registerShutdown, type Middleware } from './http.ts';
import { superUserAuth } from './auth.ts';
import { log } from './log.ts';

/**
 * Development mode: a Vite dev server in middleware mode with HMR.
 * - SPA: Vite serves `index.html` and assets; everything else falls through to Harper.
 * - SSR: Vite serves assets; HTML navigations are rendered on the fly via `ssrLoadModule`.
 */
export async function setupDevelopment(scope: Scope, ssrEntry?: string) {
	const root = scope.directory;

	const server = await viteWrapper.createServer({
		root,
		// Omit `configFile` so Vite auto-resolves vite.config.{js,ts,mjs,...} from the root.
		server: { middlewareMode: true, hmr: true },
		appType: ssrEntry ? 'custom' : 'spa',
	});

	// The Vite dev server exposes powerful endpoints (on-the-fly module transforms, arbitrary file reads
	// via `/@fs/`). Run a super_user Basic-auth check ahead of it in the middleware chain so HMR can't be
	// reached by unauthenticated clients if the dev server is ever exposed beyond localhost. Local dev is
	// unaffected: Harper auto-authorizes loopback requests as super_user under `authorizeLocal`.
	const authenticate = superUserAuth(scope, 'Harper Vite dev server (HMR)');

	const vite: Middleware = ssrEntry
		? renderSsr(server, root, ssrEntry.startsWith('/') ? ssrEntry : `/${ssrEntry}`)
		: (req, res, next) => server.middlewares(req, res, next);

	registerHttp(scope, chain(authenticate, vite));

	registerShutdown(scope, () => server.close());
	log(scope, 'info', `dev server started with HMR (${ssrEntry ? 'SSR' : 'SPA'}); super_user auth required`);
}

/**
 * SSR middleware: Vite serves assets; for HTML navigations it transforms `index.html`, loads the server
 * entry via `ssrLoadModule` (so edits are reflected immediately) and injects the render into the outlet.
 */
function renderSsr(server: any, root: string, ssrUrl: string): Middleware {
	return (req, res, next) => {
		server.middlewares(req, res, async (err?: unknown) => {
			if (err) return next(err);
			if (!acceptsHtml(req)) return next();
			try {
				const raw = readFileSync(join(root, 'index.html'), 'utf-8');
				const template = await server.transformIndexHtml(req.url, raw);
				const { render } = await server.ssrLoadModule(ssrUrl);
				const appHtml = await render(req.url);
				res.statusCode = 200;
				res.setHeader('Content-Type', 'text/html');
				// Function replacer: a literal string would let `$&`/`$\``/`$'`/`$$` sequences in the
				// rendered markup be interpreted as replacement patterns and corrupt the document.
				res.end(template.replace('<!--ssr-outlet-->', () => appHtml));
			} catch (e) {
				server.ssrFixStacktrace(e as Error);
				next(e);
			}
		});
	};
}

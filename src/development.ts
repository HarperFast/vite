import type { Scope } from 'harper';
import type { Server as HttpServer } from 'node:http';
import { createServer as createBridgeServer } from 'node:http';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { viteWrapper } from './wrappers.ts';
import { acceptsHtml, chain, registerHttp, registerShutdown, type Middleware } from './http.ts';
import { superUserAuth, isUpgradeAuthorized } from './auth.ts';
import { log } from './log.ts';

// The HMR WebSocket is served on this path on Harper's own port (not Vite's default standalone port 24678),
// so the whole dev surface — assets, module transforms, AND the HMR socket — sits on one origin behind one
// super_user gate. Both our upgrade gate and Vite key off this path; any other upgrade falls through to
// Harper untouched. The `@`-prefix mirrors Vite's own internal route convention (`/@fs`, `/@vite`).
export const HMR_PATH = '/@harper-vite-hmr';

/**
 * Development mode: a Vite dev server in middleware mode with HMR.
 * - SPA: Vite serves assets; HTML navigations get the transformed `index.html` shell (see `renderSpa`).
 * - SSR: Vite serves assets; HTML navigations are rendered on the fly via `ssrLoadModule`.
 *
 * Either way, anything the dev server does not serve falls through to Harper.
 */
export async function setupDevelopment(scope: Scope, ssrEntry?: string) {
	const root = scope.directory;

	// Prefer routing HMR through Harper's port so the WebSocket is gated like everything else (below). That
	// needs Harper's `upgrade` hook (Harper >= 5). If the host is older, fall back to Vite's own WebSocket on
	// a separate port — still functional, but ungated, so it must be kept on localhost.
	const canGateWebSocket = typeof scope.server?.upgrade === 'function';
	// A never-listening HTTP server used purely as the target Vite attaches its WebSocket upgrade handler to
	// (`hmr.server`). Our gate forwards authenticated upgrades to it; it opens no port of its own.
	const hmrBridge: HttpServer | undefined = canGateWebSocket ? createBridgeServer() : undefined;

	const server = await viteWrapper.createServer({
		root,
		// Omit `configFile` so Vite auto-resolves vite.config.{js,ts,mjs,...} from the root.
		server: {
			middlewareMode: true,
			hmr: hmrBridge ? { server: hmrBridge, path: HMR_PATH } : true,
			// Every request to the dev server — HTTP and the HMR upgrade — is gated as super_user, so Vite's
			// Host-header allowlist (a DNS-rebinding defense) is redundant here. Allowing all hosts is what lets
			// HMR be enabled against a deployed instance (e.g. a cloud IDE) where Host isn't localhost; local
			// dev is unchanged.
			allowedHosts: true,
		},
		// Always 'custom' — never 'spa'. Vite's own SPA handling is wrong for an app embedded in Harper on a
		// shared URL space; `renderSpa` below replaces it. See that function for why.
		appType: 'custom',
	});

	// The Vite dev server exposes powerful endpoints (on-the-fly module transforms, arbitrary file reads
	// via `/@fs/`). Run a super_user Basic-auth check ahead of it in the middleware chain so HMR can't be
	// reached by unauthenticated clients if the dev server is ever exposed beyond localhost. Local dev is
	// unaffected: Harper auto-authorizes loopback requests as super_user under `authorizeLocal`.
	const authenticate = superUserAuth(scope, 'Harper Vite dev server (HMR)');

	const vite: Middleware = ssrEntry
		? renderSsr(server, root, ssrEntry.startsWith('/') ? ssrEntry : `/${ssrEntry}`)
		: renderSpa(server, root);

	registerHttp(scope, chain(authenticate, vite));

	if (hmrBridge) {
		gateHmrWebSocket(scope, hmrBridge);
	} else {
		log(
			scope,
			'warn',
			'host Harper exposes no WebSocket upgrade hook; HMR uses a separate, ungated port — keep it bound to localhost'
		);
	}

	registerShutdown(scope, () => server.close());
	log(
		scope,
		'info',
		`dev server started with HMR (${ssrEntry ? 'SSR' : 'SPA'}); super_user auth required${hmrBridge ? ' for HTTP + WebSocket' : ''}`
	);
}

/**
 * Gate the HMR WebSocket behind the same super_user check as the HTTP surface.
 *
 * Registered as a run-first Harper `upgrade` handler, it claims only upgrades on `HMR_PATH` and lets every
 * other upgrade fall through to Harper. Harper does not run its auth layer on the upgrade chain, so we
 * authenticate the raw request ourselves (see `authenticateUpgrade`); an authenticated super_user's upgrade
 * is handed to Vite via the bridge, and anyone else gets a `401` and the socket closed.
 *
 * Harper only wires its upgrade chain to the socket once some WebSocket consumer is registered, so we also
 * register a pass-through `ws` handler to guarantee the chain is active even when the app has no other one
 * (e.g. no `rest`). It forwards every (non-HMR) connection on to the real handlers untouched.
 */
function gateHmrWebSocket(scope: Scope, hmrBridge: HttpServer): void {
	const server = scope.server!;

	server.upgrade!(
		async (request: any, socket: any, head: any, next: any) => {
			// On the upgrade chain `request` is the raw Node IncomingMessage (carrying `.url`/`.headers`);
			// tolerate a Harper Request wrapper too.
			const req = request?._nodeRequest ?? request;
			const path = String(req?.url ?? '').split('?', 1)[0];
			if (path !== HMR_PATH) return next(request, socket, head); // not an HMR upgrade — leave it for Harper

			try {
				if (await isUpgradeAuthorized(scope, req)) {
					// Hand the authorized upgrade to Vite's listener (attached to the bridge via `hmr.server`),
					// which performs the handshake. We do NOT call `next`, so Harper won't also upgrade this socket.
					hmrBridge.emit('upgrade', req, socket, head);
					return;
				}
			} catch (e) {
				log(scope, 'debug', 'HMR WebSocket auth error; refusing upgrade:', e);
			}
			refuseUpgrade(socket);
		},
		{ runFirst: true }
	);

	// Ensure Harper actually wires its upgrade chain to the socket (it only does so once a `ws` consumer
	// exists). Pure pass-through: forward every connection to the next handler so `rest`/`mqtt` are unaffected.
	// (`next` is a 4th argument Harper passes at runtime that its published types omit, hence optional + any.)
	server.ws?.((ws: any, request: any, completion: any, next?: any) => next?.(ws, request, completion), {
		subProtocol: 'harper-vite-hmr',
	});
}

/** Refuse a WebSocket upgrade: emit a minimal `401` and close the socket. */
function refuseUpgrade(socket: any): void {
	try {
		socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
	} catch {
		// The socket may already be gone.
	}
	socket.destroy?.();
}

/**
 * SPA middleware: Vite serves assets and module transforms; HTML navigations get the transformed
 * `index.html` shell; everything else falls through to Harper (the REST API, custom resources, …).
 *
 * We serve the shell ourselves instead of letting Vite do it via `appType: 'spa'`, because Vite's version
 * of this assumes it owns the whole origin, and here it does not:
 *
 *   - Vite appends `vite404Middleware`, which *ends* every request it did not serve with a bare 404
 *     instead of calling `next()`. Nothing downstream of the dev server would ever run, so every Harper
 *     resource 404s for as long as HMR is on.
 *   - Vite's HTML fallback claims any GET whose `Accept` includes the wildcard media range — which is
 *     exactly what `fetch()` sends by default. An app's own API calls would silently receive the HTML
 *     shell instead of JSON.
 *
 * `acceptsHtml` keeps the shell for genuine `text/html` document navigations only, which is also how the
 * production SSR handler decides (see `setupProduction`), so dev and production agree on what a
 * navigation is.
 *
 * This assumes the single `index.html` entry an SPA has: every navigation gets that shell, so a project
 * with a second HTML entry point would need Vite's multi-page handling instead.
 */
function renderSpa(server: any, root: string): Middleware {
	const templatePath = join(root, 'index.html');
	return (req, res, next) => {
		server.middlewares(req, res, async (err?: unknown) => {
			if (err) return next(err);
			// Not a navigation, or nothing to serve as a shell: let Harper have it.
			if (!acceptsHtml(req) || !existsSync(templatePath)) return next();
			try {
				// Transform first, then write: a failure here must not leave a half-set `text/html` 200 on a
				// response the error handler is about to turn into a 500. Same order as `renderSsr` below.
				const html = await server.transformIndexHtml(req.url, readFileSync(templatePath, 'utf-8'));
				res.statusCode = 200;
				res.setHeader('Content-Type', 'text/html');
				res.setHeader('Cache-Control', 'no-cache');
				// Node clears `_hasBody` for a HEAD request, so this sends the headers and no body.
				res.end(html);
			} catch (e) {
				server.ssrFixStacktrace?.(e as Error);
				next(e);
			}
		});
	};
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

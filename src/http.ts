import type { Scope } from 'harper';
import { parentPort } from 'node:worker_threads';

/** A Connect-style middleware: forwards to `next()` when it does not handle the request. */
export type Middleware = (req: any, res: any, next: (err?: unknown) => void) => void;

/**
 * Compose Connect middlewares into one. Each runs only after the previous calls `next()` without an
 * error; the first to handle the response (by not calling `next`) ends the chain. When all fall through,
 * the composed middleware calls its own `next`. Lets us run, say, an auth check ahead of Vite.
 */
export function chain(...middlewares: Middleware[]): Middleware {
	return (req, res, next) => {
		let i = 0;
		const advance = (err?: unknown) => {
			if (err) return next(err);
			const middleware = middlewares[i++];
			if (!middleware) return next();
			middleware(req, res, advance);
		};
		advance();
	};
}

/** A request that should receive an HTML document (SPA shell / SSR render) rather than falling through. */
export function acceptsHtml(req: any): boolean {
	const method = req.method ?? 'GET';
	if (method !== 'GET' && method !== 'HEAD') return false;
	return String(req.headers?.accept ?? '').includes('text/html');
}

/**
 * Register an HTTP handler with Harper that runs `middleware` first and, for any request the middleware
 * does not handle, falls through to the next Harper layer (e.g. `rest: true` resources) via `nextLayer`.
 */
export function registerHttp(scope: Scope, middleware: Middleware, options?: Record<string, unknown>): void {
	scope.server?.http?.(
		(request: any, nextLayer: (request: any) => unknown) =>
			new Promise((resolve, reject) => {
				const res = request._nodeResponse;

				// A middleware that handles the request writes the response directly and never calls `next`.
				// Resolve once the response completes so Harper's awaited handler doesn't accumulate a pending
				// promise (and its captured req/res) per handled request — a leak under load. Resolving
				// `undefined` is exactly the "already handled via the node response" signal Harper looks for,
				// so it won't double-send; the fall-through path below resolves with the next layer instead.
				const onComplete = () => {
					cleanup();
					resolve(undefined);
				};
				const cleanup = () => {
					res?.removeListener?.('finish', onComplete);
					res?.removeListener?.('close', onComplete);
				};
				res?.on?.('finish', onComplete);
				res?.on?.('close', onComplete);

				// Bridge Harper's resolved identity onto the node request so a node-level middleware can run
				// its own auth check (e.g. the dev server's super_user gate). Harper itself does this for
				// fall-through requests (`request._nodeRequest.user = request.user`); we do it up front.
				request._nodeRequest.user = request.user;
				middleware(request._nodeRequest, res, (err?: unknown) => {
					cleanup();
					if (err) return reject(err);
					try {
						resolve(nextLayer(request));
					} catch (e) {
						reject(e);
					}
				});
			}),
		options
	);
}

/** Close the given instance both when the scope closes and when Harper broadcasts a shutdown message. */
export function registerShutdown(scope: Scope, close: () => unknown): void {
	// `scope`'s `close` event and a Harper `shutdown` message can both fire; close only once so we don't,
	// e.g., call Vite's `server.close()` twice.
	let closed = false;
	const closeOnce = () => {
		if (closed) return;
		closed = true;
		close();
	};

	const shutdownHandler = (msg: any) => {
		if (msg?.type === 'shutdown') closeOnce();
	};

	scope.on('close', () => {
		closeOnce();
		parentPort?.off('message', shutdownHandler);
	});

	parentPort?.on('message', shutdownHandler);
}

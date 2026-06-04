import type { Scope, User } from 'harper';
import type { Middleware } from './http.ts';

/**
 * Harper's canonical "is this a super_user" check. Matches how Harper itself gates privileged paths
 * (e.g. impersonation, token minting): the resolved user carries `role.permission.super_user === true`.
 */
export function isSuperUser(user: User | undefined): boolean {
	return user?.role?.permission?.super_user === true;
}

/**
 * A Connect middleware that restricts the chain behind it (the Vite dev server) to Harper `super_user`s,
 * authenticated via HTTP Basic auth. It runs the check itself against Harper's APIs:
 *
 * - `req.user` is the identity Harper's own auth layer already resolved for the request — including the
 *   super_user it auto-assigns to loopback requests under `authentication.authorizeLocal` (the default in
 *   `harper dev`). `registerHttp` bridges it onto the node request. So local development passes straight
 *   through with no prompt.
 * - Otherwise we validate an `Authorization: Basic` header directly with `server.authenticateUser` and, on
 *   failure, reply `401` with a `WWW-Authenticate: Basic` header so a browser prompts for credentials.
 *
 * NOTE: this guards the HTTP surface — the Vite dev server's asset, module-transform and `/@fs/`
 * (arbitrary file read) endpoints, which is the dangerous part. Vite's HMR *WebSocket* runs on its own
 * port and is not routed through here; keep it bound to localhost (or otherwise unexposed) in any
 * non-local deployment.
 */
export function superUserAuth(scope: Scope, realm: string): Middleware {
	return (req, res, next) => {
		// Fast path: Harper already authenticated a super_user (any scheme, or local dev).
		if (isSuperUser(req.user)) return next();

		authenticateBasic(scope, req)
			.then((user) => {
				if (isSuperUser(user)) {
					req.user = user; // surface the authenticated user to the rest of the chain
					return next();
				}
				challenge(res, realm);
			})
			.catch(next);
	};
}

/** Validate an `Authorization: Basic` header against Harper's user store; `undefined` when absent/invalid. */
async function authenticateBasic(scope: Scope, req: any): Promise<User | undefined> {
	const header = req.headers?.authorization;
	if (typeof header !== 'string' || !header.startsWith('Basic ')) return undefined;

	const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
	const separator = decoded.indexOf(':');
	if (separator === -1) return undefined; // malformed — no `username:password` pair
	const username = decoded.slice(0, separator);
	const password = decoded.slice(separator + 1);

	try {
		// `authenticateUser` always validates the password. (`getUser` skips it for a null password — the
		// certificate-auth path — so it must not be used here.) The third arg is the request, which Harper
		// uses only for contextual strategies (mTLS, etc.); it's unused for direct credential validation.
		// Bad credentials throw or resolve to a non-super_user; either way the caller falls through to the
		// 401 challenge.
		return await scope.server?.authenticateUser?.(username, password, req);
	} catch {
		return undefined;
	}
}

/** Send a `401` asking the browser to collect Basic credentials. */
function challenge(res: any, realm: string): void {
	res.statusCode = 401;
	res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
	res.setHeader('Content-Type', 'text/plain; charset=utf-8');
	res.end('401 Unauthorized — super_user credentials required.\n');
}

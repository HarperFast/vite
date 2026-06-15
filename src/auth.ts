import { databases, type Scope, type User } from 'harper';
import type { Middleware } from './http.ts';
import { isDevMode } from './options.ts';

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

/**
 * Whether a WebSocket upgrade request may reach the Vite dev server — i.e. whether it represents a Harper
 * `super_user`.
 *
 * The HMR WebSocket is served on Harper's own port (see `setupDevelopment`), so the same super_user gate as
 * the HTTP surface should apply. But Harper runs its auth layer on the HTTP request chain, NOT the upgrade
 * chain — `req.user` is unset here — so we authorize the raw upgrade ourselves, from the three signals a real
 * client carries on a same-origin upgrade, cheapest first:
 *
 *   1. A loopback peer under `authorizeLocal` — mirrors how Harper trusts localhost for the HTTP surface, so
 *      plain `harper dev` works with no prompt (the upgrade carries neither a Basic header nor a cookie, and
 *      `authorizeLocal` sets no cookie). We trust the real socket peer, not a spoofable `X-Forwarded-For`.
 *   2. An `Authorization: Basic` header, validated exactly like the HTTP gate. Browsers seldom attach this to
 *      a WebSocket handshake, but CLI clients (and some browsers) do.
 *   3. The `hdb-session` cookie Harper sets after any successful login (sessions are on by default). Cookies
 *      ARE reliably sent on a same-origin upgrade, so this is the path that carries a logged-in admin's
 *      identity from the page to a remotely-exposed HMR socket.
 *
 * Best-effort and fails closed: a missing global, store, or lookup error yields `false` (the upgrade is then
 * refused), never an unauthenticated pass.
 */
export async function isUpgradeAuthorized(scope: Scope, req: any): Promise<boolean> {
	if (authorizeLocalAllows(req)) return true;
	if (isSuperUser(await authenticateBasic(scope, req))) return true;
	if (isSuperUser(await authenticateSessionCookie(scope, req))) return true;
	return false;
}

/** True when the upgrade's real socket peer is loopback and Harper's `authorizeLocal` trust is in effect. */
function authorizeLocalAllows(req: any): boolean {
	if (!authorizeLocalEnabled()) return false;
	const ip = req?.socket?.remoteAddress ?? '';
	// Match Harper's own loopback test (covers `127.0.0.1`, IPv4-mapped `::ffff:127.0.0.1`, and IPv6 `::1`).
	return ip.includes('127.0.0.') || ip === '::1';
}

/**
 * Mirror the env-visible part of Harper's `authorizeLocal` resolution: an explicit `AUTHENTICATION_AUTHORIZELOCAL`
 * override wins, otherwise it defaults to dev mode (what `harper dev` sets). Harper also consults its config
 * file, which a plugin can't read here — so a config-file-only override isn't reflected; document accordingly.
 */
function authorizeLocalEnabled(): boolean {
	const explicit = process.env.AUTHENTICATION_AUTHORIZELOCAL;
	if (explicit != null) return explicit !== 'false' && explicit !== '0' && explicit !== '';
	return isDevMode();
}

/**
 * Resolve the user named by a Harper `hdb-session` cookie on the request, or `undefined`. Harper stores
 * sessions in `system.hdb_session` keyed by the id carried in the cookie; the cookie NAME is origin-prefixed
 * (e.g. `localhost_9926-hdb-session`), so we match any cookie whose name ends in `hdb-session` rather than
 * reconstructing Harper's exact prefix. Resolving a user from a session id needs no password — the id is the
 * proof — which is why this uses `getUser` (and why `authenticateBasic`, validating a password, must not).
 */
async function authenticateSessionCookie(scope: Scope, req: any): Promise<User | undefined> {
	const cookieHeader = req?.headers?.cookie;
	if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return undefined;

	// `system.hdb_session` is an internal Harper table; feature-detect it so this stays a no-op outside Harper
	// (unit tests) or on a host that doesn't expose it.
	const sessionStore = (databases as any)?.system?.hdb_session;
	if (typeof sessionStore?.get !== 'function') return undefined;

	for (const id of sessionIds(cookieHeader)) {
		try {
			const session = await sessionStore.get(id);
			const username = session?.user;
			if (typeof username !== 'string' || username.length === 0) continue;
			const user = await scope.server?.getUser?.(username, null, req);
			if (isSuperUser(user)) return user;
		} catch {
			// Unreadable session / store error — try the next candidate, else fall through to undefined.
		}
	}
	return undefined;
}

/** Session ids from every `*hdb-session` cookie in a Cookie header (a request can carry more than one). */
function sessionIds(cookieHeader: string): string[] {
	const ids: string[] = [];
	for (const pair of cookieHeader.split(/;\s*/)) {
		const eq = pair.indexOf('=');
		if (eq === -1) continue;
		const name = pair.slice(0, eq).trim();
		if (name === 'hdb-session' || name.endsWith('-hdb-session')) {
			const value = pair.slice(eq + 1).trim();
			if (value) ids.push(value);
		}
	}
	return ids;
}

/** Send a `401` asking the browser to collect Basic credentials. */
function challenge(res: any, realm: string): void {
	res.statusCode = 401;
	res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
	res.setHeader('Content-Type', 'text/plain; charset=utf-8');
	res.end('401 Unauthorized — super_user credentials required.\n');
}

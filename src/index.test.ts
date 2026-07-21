import { databases, type Scope } from 'harper';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApplication, viteWrapper } from './index.ts';
import { HMR_PATH } from './development.ts';
import { withBuildLock } from './buildLock.ts';

// The build lock reads its coordination table from `databases` (imported from `harper`). These unit tests
// run "outside Harper", so clear any real `harperfast_vite` database that a local Harper install may have
// opened on import — otherwise the production tests below would talk to a live table. `withBuildLock` then
// takes its no-table path and runs builds directly, which is exactly what these tests exercise.
(databases as any).harperfast_vite = {};

/** Build a mock Harper Scope with configurable options and an optional HTTP server. */
function makeScope(
	opts: {
		directory?: string;
		ssr?: string;
		files?: unknown;
		hmr?: unknown;
		output?: unknown;
		withHttp?: boolean;
		// `withWebSocket` implies an HTTP server too, and additionally exposes Harper's `upgrade`/`ws`
		// registration hooks plus `getUser` — the surface the HMR WebSocket gate uses.
		withWebSocket?: boolean;
		getUser?: (username: string, password: unknown, req: unknown) => unknown;
	} = {}
): Scope & {
	httpHandler?: any;
	httpHandlers: any[];
	entry: EventEmitter;
	logs: Array<{ level: string; message: string }>;
	upgradeHandler?: any;
	upgradeOptions?: any;
	wsHandler?: any;
	wsOptions?: any;
} {
	const scope = new EventEmitter() as any;
	scope.appName = 'test-app';
	scope.directory = opts.directory ?? '/test/dir';
	scope.logs = [];
	const capture = (level: string) => (message: string) => scope.logs.push({ level, message });
	scope.logger = { error() {}, warn: capture('warn'), info: capture('info'), debug: capture('debug') };
	scope.options = {
		get(key: string[]) {
			if (key[0] === 'ssr') return opts.ssr;
			if (key[0] === 'files') return opts.files;
			if (key[0] === 'hmr') return opts.hmr;
			if (key[0] === 'output') return opts.output;
			return undefined;
		},
	};
	const entry = new EventEmitter();
	scope.handleEntry = () => entry;
	scope.entry = entry;
	scope.httpHandlers = [];
	if (opts.withHttp || opts.withWebSocket) {
		const server: any = {
			http(handler: any) {
				scope.httpHandlers.push(handler);
				scope.httpHandler = handler; // most-recently registered, for convenience
			},
		};
		if (opts.withWebSocket) {
			server.upgrade = (handler: any, options: any) => {
				scope.upgradeHandler = handler;
				scope.upgradeOptions = options;
			};
			server.ws = (handler: any, options: any) => {
				scope.wsHandler = handler;
				scope.wsOptions = options;
			};
			if (opts.getUser) server.getUser = opts.getUser;
		}
		scope.server = server;
	}
	return scope;
}

/** Yield to the microtask/macrotask queue so async rebuilds settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A mock of a Node ServerResponse: captures what a handler writes and emits `finish` on `end`, like Node. */
function mockResponse() {
	const res = new EventEmitter() as any;
	res.statusCode = 0;
	res.headers = {} as Record<string, string>;
	res.ended = false;
	res.body = undefined as string | undefined;
	res.setHeader = (key: string, value: string) => {
		res.headers[key] = value;
	};
	res.end = (body?: string) => {
		res.ended = true;
		res.body = body;
		res.emit('finish'); // Node emits `finish` once the response is fully written
	};
	return res;
}

/** A user object shaped like Harper's resolved super_user (the guard checks `role.permission.super_user`). */
const SUPER_USER = { role: { permission: { super_user: true } } };

describe('handleApplication — development mode', () => {
	it('creates a Vite dev server with HMR and SPA app type when no ssr entry is configured', async (t) => {
		process.env.DEV_MODE = 'true';
		const closeMock = t.mock.fn(async () => {});
		const createServerMock = t.mock.method(viteWrapper, 'createServer', async () => ({
			close: closeMock,
			middlewares: t.mock.fn(),
		}));

		const scope = makeScope();
		await handleApplication(scope);

		assert.strictEqual(createServerMock.mock.callCount(), 1);
		const config = createServerMock.mock.calls[0].arguments[0];
		assert.strictEqual(config?.root, '/test/dir');
		assert.strictEqual(config?.server?.middlewareMode, true);
		assert.strictEqual(config.server.hmr, true);
		assert.strictEqual(config.appType, 'spa');
		assert.strictEqual(config.configFile, undefined, 'configFile is omitted so Vite auto-resolves it');

		scope.emit('close');
		assert.strictEqual(closeMock.mock.callCount(), 1);
		delete process.env.DEV_MODE;
	});

	it('uses the "custom" app type when an ssr entry is configured', async (t) => {
		process.env.DEV_MODE = 'true';
		const createServerMock = t.mock.method(viteWrapper, 'createServer', async () => ({
			close: t.mock.fn(),
			middlewares: t.mock.fn(),
			transformIndexHtml: t.mock.fn(),
			ssrLoadModule: t.mock.fn(),
			ssrFixStacktrace: t.mock.fn(),
		}));

		const scope = makeScope({ ssr: 'src/entry-server.tsx' });
		await handleApplication(scope);

		const config = createServerMock.mock.calls[0].arguments[0];
		assert.strictEqual(config?.appType, 'custom');
		delete process.env.DEV_MODE;
	});

	it('forwards requests to Vite and falls through to Harper when Vite does not handle them', async (t) => {
		process.env.DEV_MODE = 'true';
		// Vite middleware that "does not handle" the request: it calls next().
		const middlewares = t.mock.fn((_req: any, _res: any, next: any) => next());
		t.mock.method(viteWrapper, 'createServer', async () => ({
			close: t.mock.fn(),
			middlewares,
		}));

		const scope = makeScope({ withHttp: true });
		await handleApplication(scope);

		assert.ok(scope.httpHandler, 'an http handler is registered');
		// `user` is set: Harper auto-authorizes loopback requests as super_user, so the guard passes.
		const request = { _nodeRequest: { method: 'GET', headers: {} }, _nodeResponse: mockResponse(), user: SUPER_USER };
		const nextLayer = t.mock.fn(() => 'HARPER_RESPONSE');
		const result = await scope.httpHandler(request, nextLayer);

		assert.strictEqual(middlewares.mock.callCount(), 1);
		assert.strictEqual(nextLayer.mock.callCount(), 1, 'unhandled request falls through to Harper');
		assert.strictEqual(result, 'HARPER_RESPONSE');
		delete process.env.DEV_MODE;
	});

	it('resolves the handler when Vite handles the response, without falling through', { timeout: 5000 }, async (t) => {
		process.env.DEV_MODE = 'true';
		// Vite middleware that HANDLES the request: writes a response and never calls next() (assets, HMR).
		const middlewares = t.mock.fn((_req: any, res: any) => {
			res.statusCode = 200;
			res.end('asset bytes');
		});
		t.mock.method(viteWrapper, 'createServer', async () => ({ close: t.mock.fn(), middlewares }));

		const scope = makeScope({ withHttp: true });
		await handleApplication(scope);

		const res = mockResponse();
		const request = { _nodeRequest: { method: 'GET', headers: {} }, _nodeResponse: res, user: SUPER_USER };
		const nextLayer = t.mock.fn(() => 'HARPER_RESPONSE');

		// Before the fix this never settled (Vite handles assets without calling next), leaking a pending
		// promise per request. It now resolves once the response finishes, with `undefined` — Harper's
		// "already handled via the node response" signal. The 5s timeout fails fast if that ever regresses.
		const result = await scope.httpHandler(request, nextLayer);

		assert.strictEqual(result, undefined, 'a handled response resolves the handler with undefined');
		assert.strictEqual(res.ended, true, 'the middleware wrote and ended the response');
		assert.strictEqual(nextLayer.mock.callCount(), 0, 'a handled request does not fall through to Harper');
		delete process.env.DEV_MODE;
	});

	it('rejects unauthenticated dev-server requests with a 401 Basic challenge', async (t) => {
		process.env.DEV_MODE = 'true';
		const middlewares = t.mock.fn((_req: any, _res: any, next: any) => next());
		t.mock.method(viteWrapper, 'createServer', async () => ({ close: t.mock.fn(), middlewares }));

		const scope = makeScope({ withHttp: true });
		await handleApplication(scope);

		const res = mockResponse();
		// No `request.user` (a remote request Harper did not auto-authorize) and no Authorization header.
		const request = { _nodeRequest: { method: 'GET', headers: {} }, _nodeResponse: res };
		const nextLayer = t.mock.fn(() => 'HARPER');
		void scope.httpHandler(request, nextLayer);
		await tick();

		assert.strictEqual(res.statusCode, 401, 'unauthenticated request is challenged');
		assert.match(String(res.headers['WWW-Authenticate']), /^Basic /, 'sends a Basic auth challenge');
		assert.strictEqual(middlewares.mock.callCount(), 0, 'Vite is never reached without auth');
		assert.strictEqual(nextLayer.mock.callCount(), 0, 'does not fall through to Harper');
		delete process.env.DEV_MODE;
	});

	it('authenticates a super_user via Basic auth before reaching Vite', async (t) => {
		process.env.DEV_MODE = 'true';
		const middlewares = t.mock.fn((_req: any, _res: any, next: any) => next());
		t.mock.method(viteWrapper, 'createServer', async () => ({ close: t.mock.fn(), middlewares }));

		const scope = makeScope({ withHttp: true });
		const authenticateUser = t.mock.fn(async (username: string) => (username === 'admin' ? SUPER_USER : undefined));
		(scope.server as any).authenticateUser = authenticateUser;
		await handleApplication(scope);

		const authorization = 'Basic ' + Buffer.from('admin:secret').toString('base64');
		const request = { _nodeRequest: { method: 'GET', headers: { authorization } }, _nodeResponse: mockResponse() };
		const nextLayer = t.mock.fn(() => 'HARPER');
		const result = await scope.httpHandler(request, nextLayer);

		assert.strictEqual(authenticateUser.mock.callCount(), 1, 'validates the Basic credentials');
		assert.deepStrictEqual(
			authenticateUser.mock.calls[0].arguments.slice(0, 2),
			['admin', 'secret'],
			'parses username and password from the header'
		);
		assert.strictEqual(middlewares.mock.callCount(), 1, 'authenticated super_user reaches Vite');
		assert.strictEqual(result, 'HARPER');
		delete process.env.DEV_MODE;
	});

	it('rejects valid credentials that lack the super_user permission', async (t) => {
		process.env.DEV_MODE = 'true';
		const middlewares = t.mock.fn((_req: any, _res: any, next: any) => next());
		t.mock.method(viteWrapper, 'createServer', async () => ({ close: t.mock.fn(), middlewares }));

		const scope = makeScope({ withHttp: true });
		// A real, valid user — but without super_user.
		(scope.server as any).authenticateUser = t.mock.fn(async () => ({ role: { permission: { super_user: false } } }));
		await handleApplication(scope);

		const authorization = 'Basic ' + Buffer.from('reader:secret').toString('base64');
		const res = mockResponse();
		const request = { _nodeRequest: { method: 'GET', headers: { authorization } }, _nodeResponse: res };
		const nextLayer = t.mock.fn(() => 'HARPER');
		void scope.httpHandler(request, nextLayer);
		await tick();

		assert.strictEqual(res.statusCode, 401, 'a non-super_user is rejected');
		assert.strictEqual(middlewares.mock.callCount(), 0, 'Vite is never reached');
		delete process.env.DEV_MODE;
	});

	it('runs the dev server when hmr: true, even without DEV_MODE', async (t) => {
		delete process.env.DEV_MODE;
		const createServerMock = t.mock.method(viteWrapper, 'createServer', async () => ({
			close: t.mock.fn(),
			middlewares: t.mock.fn(),
		}));

		const scope = makeScope({ hmr: true });
		await handleApplication(scope);

		assert.strictEqual(createServerMock.mock.callCount(), 1, 'hmr: true forces the dev server');
	});
});

describe('handleApplication — HMR WebSocket gating', () => {
	// A raw upgrade request as Harper passes it on the upgrade chain (a Node IncomingMessage with url/headers/
	// socket). The peer defaults to a non-loopback (public) address, i.e. a "remote" client; pass `ip` to test
	// the loopback/authorizeLocal path.
	const upgradeRequest = (headers: Record<string, string>, opts: { url?: string; ip?: string } = {}) => ({
		url: opts.url ?? HMR_PATH,
		headers,
		socket: { remoteAddress: opts.ip ?? '203.0.113.5' },
	});

	/**
	 * Stub Harper's `system.hdb_session` table for one test. `databases.system` is a read-only accessor, so we
	 * redefine it (and restore it afterward) rather than assigning through it.
	 */
	function useSessionStore(t: any, getById: (id: string) => unknown) {
		const original = Object.getOwnPropertyDescriptor(databases, 'system');
		Object.defineProperty(databases, 'system', {
			value: { hdb_session: { get: async (id: string) => getById(id) } },
			configurable: true,
		});
		t.after(() => {
			if (original) Object.defineProperty(databases, 'system', original);
			else delete (databases as any).system;
		});
	}

	/** A stand-in for the raw socket Harper hands the upgrade chain: captures writes and whether it's closed. */
	function mockSocket() {
		const socket = { written: [] as string[], destroyed: false } as any;
		socket.write = (chunk: string) => (socket.written.push(chunk), true);
		socket.destroy = () => {
			socket.destroyed = true;
		};
		return socket;
	}

	/**
	 * Boot the dev server with a WebSocket-capable scope. Returns the captured Vite config, the scope (with the
	 * registered upgrade/ws handlers), and the HMR "bridge" server Vite was handed — with a spy attached to its
	 * `upgrade` event so a test can assert that an authenticated upgrade was forwarded to Vite.
	 */
	async function bootDev(t: any, opts: Parameters<typeof makeScope>[0] = {}) {
		process.env.DEV_MODE = 'true';
		t.after(() => delete process.env.DEV_MODE);
		let config: any;
		t.mock.method(viteWrapper, 'createServer', async (c: any) => {
			config = c;
			return { close: t.mock.fn(), middlewares: t.mock.fn() };
		});
		const scope = makeScope({ withWebSocket: true, ...opts });
		await handleApplication(scope);
		const bridge = config.server.hmr.server;
		const forwarded = t.mock.fn();
		bridge.on('upgrade', forwarded);
		return { config, scope, bridge, forwarded };
	}

	it('routes HMR through Harper on a gated path, allowing all hosts, when the upgrade hook exists', async (t) => {
		const { config, scope } = await bootDev(t);

		assert.strictEqual(config.server.middlewareMode, true);
		assert.strictEqual(config.server.hmr.path, HMR_PATH, 'HMR is served on a dedicated path');
		assert.ok(config.server.hmr.server, 'Vite attaches its WebSocket to the bridge, not a separate port');
		assert.strictEqual(config.server.allowedHosts, true, 'Vite host allowlist is off (the auth gate covers it)');
		assert.strictEqual(typeof scope.upgradeHandler, 'function', 'an upgrade gate is registered');
		assert.strictEqual(scope.upgradeOptions?.runFirst, true, 'the gate runs ahead of Harper’s own upgrade handling');
		assert.strictEqual(typeof scope.wsHandler, 'function', 'a ws handler is registered to wire the upgrade chain');
	});

	it('forwards an authenticated super_user upgrade (session cookie) to Vite', async (t) => {
		useSessionStore(t, (id) => (id === 'sess-1' ? { user: 'admin' } : undefined));

		const { scope, forwarded } = await bootDev(t, {
			getUser: async (username) => (username === 'admin' ? SUPER_USER : undefined),
		});

		const socket = mockSocket();
		const next = t.mock.fn();
		await scope.upgradeHandler(upgradeRequest({ cookie: 'app_9926-hdb-session=sess-1' }), socket, undefined, next);

		assert.strictEqual(forwarded.mock.callCount(), 1, 'the upgrade is handed to Vite');
		assert.strictEqual(next.mock.callCount(), 0, 'a handled upgrade does not fall through to Harper');
		assert.strictEqual(socket.destroyed, false, 'the socket is left open for the handshake');
	});

	it('forwards an authenticated super_user upgrade (Basic auth) to Vite', async (t) => {
		const { scope, forwarded } = await bootDev(t);
		(scope.server as any).authenticateUser = t.mock.fn(async (u: string) => (u === 'admin' ? SUPER_USER : undefined));

		const authorization = 'Basic ' + Buffer.from('admin:secret').toString('base64');
		const socket = mockSocket();
		await scope.upgradeHandler(upgradeRequest({ authorization }), socket, undefined, t.mock.fn());

		assert.strictEqual(forwarded.mock.callCount(), 1, 'a Basic-authenticated super_user reaches Vite');
		assert.strictEqual(socket.destroyed, false);
	});

	it('refuses an unauthenticated upgrade with a 401 and closes the socket', async (t) => {
		const { scope, forwarded } = await bootDev(t);

		const socket = mockSocket();
		const next = t.mock.fn();
		await scope.upgradeHandler(upgradeRequest({}), socket, undefined, next);

		assert.strictEqual(forwarded.mock.callCount(), 0, 'an unauthenticated upgrade never reaches Vite');
		assert.match(socket.written.join(''), /401 Unauthorized/, 'a 401 is written to the socket');
		assert.strictEqual(socket.destroyed, true, 'the socket is closed');
		assert.strictEqual(next.mock.callCount(), 0, 'the request is handled (rejected), not passed on');
	});

	it('rejects a valid session that resolves to a non-super_user', async (t) => {
		useSessionStore(t, () => ({ user: 'reader' }));

		const { scope, forwarded } = await bootDev(t, {
			getUser: async () => ({ role: { permission: { super_user: false } } }),
		});

		const socket = mockSocket();
		await scope.upgradeHandler(upgradeRequest({ cookie: 'app-hdb-session=sess-1' }), socket, undefined, t.mock.fn());

		assert.strictEqual(forwarded.mock.callCount(), 0, 'a non-super_user is refused');
		assert.strictEqual(socket.destroyed, true);
	});

	it('authorizes a loopback upgrade under authorizeLocal (plain `harper dev`, no credentials)', async (t) => {
		// bootDev runs with DEV_MODE=true, under which Harper trusts loopback for the HTTP surface; the gate
		// mirrors that so the HMR socket connects on localhost with neither a Basic header nor a session cookie.
		const { scope, forwarded } = await bootDev(t);

		const socket = mockSocket();
		await scope.upgradeHandler(upgradeRequest({}, { ip: '127.0.0.1' }), socket, undefined, t.mock.fn());

		assert.strictEqual(forwarded.mock.callCount(), 1, 'a loopback upgrade is forwarded to Vite');
		assert.strictEqual(socket.destroyed, false);
	});

	it('does not trust loopback when authorizeLocal is disabled', async (t) => {
		const { scope, forwarded } = await bootDev(t);
		process.env.AUTHENTICATION_AUTHORIZELOCAL = 'false';
		t.after(() => delete process.env.AUTHENTICATION_AUTHORIZELOCAL);

		const socket = mockSocket();
		await scope.upgradeHandler(upgradeRequest({}, { ip: '127.0.0.1' }), socket, undefined, t.mock.fn());

		assert.strictEqual(forwarded.mock.callCount(), 0, 'loopback alone is not trusted when authorizeLocal is off');
		assert.strictEqual(socket.destroyed, true);
	});

	it('lets non-HMR upgrades fall through to Harper untouched', async (t) => {
		const { scope, forwarded } = await bootDev(t);

		const socket = mockSocket();
		const next = t.mock.fn();
		const request = upgradeRequest({}, { url: '/some/other/socket' });
		await scope.upgradeHandler(request, socket, undefined, next);

		assert.strictEqual(next.mock.callCount(), 1, 'a non-HMR upgrade is passed to the next handler');
		assert.deepStrictEqual(next.mock.calls[0].arguments, [request, socket, undefined], 'forwarded unchanged');
		assert.strictEqual(forwarded.mock.callCount(), 0);
		assert.strictEqual(socket.destroyed, false, 'we do not touch upgrades we do not own');
	});

	it('registers a pass-through ws handler that forwards to the next handler', async (t) => {
		const { scope } = await bootDev(t);

		const next = t.mock.fn();
		const ws = {},
			request = {},
			completion = Promise.resolve();
		scope.wsHandler(ws, request, completion, next);

		assert.strictEqual(next.mock.callCount(), 1, 'non-HMR ws connections are forwarded to rest/mqtt');
		assert.deepStrictEqual(next.mock.calls[0].arguments, [ws, request, completion]);
	});

	it('falls back to a separate, ungated HMR port and warns when Harper has no upgrade hook', async (t) => {
		process.env.DEV_MODE = 'true';
		t.after(() => delete process.env.DEV_MODE);
		let config: any;
		t.mock.method(viteWrapper, 'createServer', async (c: any) => {
			config = c;
			return { close: t.mock.fn(), middlewares: t.mock.fn() };
		});
		// withHttp (not withWebSocket): the server exposes no `upgrade` hook.
		const scope = makeScope({ withHttp: true });
		await handleApplication(scope);

		assert.strictEqual(config.server.hmr, true, 'falls back to Vite’s own HMR WebSocket on a separate port');
		assert.strictEqual(scope.upgradeHandler, undefined, 'no upgrade gate is registered');
		assert.ok(
			scope.logs.some((l) => l.level === 'warn' && /separate, ungated port/.test(l.message)),
			'warns that the HMR WebSocket is ungated'
		);
	});
});

describe('handleApplication — hybrid production mode', () => {
	function mockProd(t: any, { build }: { build?: any } = {}) {
		// Use a real temp dir: production setup touches the filesystem (output existence checks).
		const root = mkdtempSync(join(tmpdir(), 'vite-test-'));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const buildMock = t.mock.method(viteWrapper, 'build', build ?? (async () => {}));
		return { root, buildMock };
	}

	// Path to the SSR server bundle the plugin builds for a given app root + entry.
	const ssrBundlePath = (root: string, entry: string) =>
		join(
			root,
			'node_modules',
			'.harper-vite-ssr',
			`${entry
				.split('/')
				.pop()!
				.replace(/\.\w+$/, '')}.js`
		);

	it('builds to the default output dir when it is missing (SPA needs no handler — static serves)', async (t) => {
		process.env.DEV_MODE = 'false';
		const { root, buildMock } = mockProd(t);

		const scope = makeScope({ directory: root, withHttp: true });
		await handleApplication(scope);

		assert.strictEqual(buildMock.mock.callCount(), 1, 'builds once because the output dir is missing');
		// The client builds to `<root>/dist` by default (the `output` option).
		assert.strictEqual(buildMock.mock.calls[0].arguments[0].build.outDir, join(root, 'dist'));
		// SPA serving is delegated entirely to the `static` plugin; the vite plugin registers no http handler.
		assert.strictEqual(scope.httpHandlers.length, 0, 'no http handler registered for an SPA build');
		delete process.env.DEV_MODE;
	});

	it('honors the output option for the build directory', async (t) => {
		process.env.DEV_MODE = 'false';
		const { root, buildMock } = mockProd(t);

		const scope = makeScope({ directory: root, withHttp: true, output: 'web' });
		await handleApplication(scope);

		assert.strictEqual(buildMock.mock.calls[0].arguments[0].build.outDir, join(root, 'web'));
		delete process.env.DEV_MODE;
	});

	it('builds the SSR bundle when a stale client-only output already exists', async (t) => {
		process.env.DEV_MODE = 'false';
		const { root, buildMock } = mockProd(t);
		// Simulate a leftover client build with no SSR bundle (the bug behind the ENOENT on render).
		mkdirSync(join(root, 'dist'), { recursive: true });

		const scope = makeScope({ directory: root, withHttp: true, ssr: 'src/entry-server.tsx' });
		await handleApplication(scope);

		// A build runs, and crucially it includes the SSR build (the missing bundle).
		const ranSsrBuild = buildMock.mock.calls.some((c: any) => c.arguments[0]?.build?.ssr === 'src/entry-server.tsx');
		assert.ok(ranSsrBuild, 'builds the missing SSR bundle');
		delete process.env.DEV_MODE;
	});

	it('does not rebuild when both the client output and SSR bundle already exist', async (t) => {
		process.env.DEV_MODE = 'false';
		const { root, buildMock } = mockProd(t);
		mkdirSync(join(root, 'dist'), { recursive: true });
		const bundle = ssrBundlePath(root, 'src/entry-server.tsx');
		mkdirSync(join(bundle, '..'), { recursive: true });
		writeFileSync(bundle, 'export const render = () => "";');

		const scope = makeScope({ directory: root, withHttp: true, ssr: 'src/entry-server.tsx' });
		await handleApplication(scope);

		assert.strictEqual(buildMock.mock.callCount(), 0, 'no rebuild when already fully built');
		delete process.env.DEV_MODE;
	});

	it('recompiles when watched files change', async (t) => {
		process.env.DEV_MODE = 'false';
		const { buildMock } = mockProd(t);

		const scope = makeScope({ withHttp: true, files: 'src/**/*' });
		await handleApplication(scope);
		assert.strictEqual(buildMock.mock.callCount(), 1, 'initial build');

		// Events during the initial file scan (before `ready`) must not trigger rebuilds.
		scope.entry.emit('all', { eventType: 'add', urlPath: '/App.tsx' });
		await tick();
		assert.strictEqual(buildMock.mock.callCount(), 1, 'no rebuild during initial scan');

		// After the entry handler emits `ready`, a change rebuilds.
		scope.entry.emit('ready');
		scope.entry.emit('all', { eventType: 'change', urlPath: '/App.tsx' });
		await tick();
		await tick();
		assert.strictEqual(buildMock.mock.callCount(), 2, 'rebuilds on change');
		delete process.env.DEV_MODE;
	});

	it('does not watch for changes when no files option is configured', async (t) => {
		process.env.DEV_MODE = 'false';
		const { buildMock } = mockProd(t);
		const handleEntryMock = t.mock.fn(() => new EventEmitter());

		const scope = makeScope({ withHttp: true });
		scope.handleEntry = handleEntryMock as any;
		await handleApplication(scope);

		assert.strictEqual(handleEntryMock.mock.callCount(), 0, 'handleEntry is not called without a files option');
		assert.strictEqual(buildMock.mock.callCount(), 1);
		delete process.env.DEV_MODE;
	});

	it('registers an SSR HTML handler that falls through for non-HTML requests', async (t) => {
		process.env.DEV_MODE = 'false';
		mockProd(t);

		const scope = makeScope({ withHttp: true, ssr: 'src/entry-server.tsx' });
		await handleApplication(scope);

		assert.strictEqual(scope.httpHandlers.length, 1, 'SSR registers exactly one http handler');

		// A non-HTML request (e.g. an API call) falls through to Harper.
		const request = { _nodeRequest: { method: 'GET', headers: { accept: 'application/json' } }, _nodeResponse: {} };
		const nextLayer = t.mock.fn(() => 'HARPER_API');
		const result = await scope.httpHandler(request, nextLayer);

		assert.strictEqual(nextLayer.mock.callCount(), 1);
		assert.strictEqual(result, 'HARPER_API');
		delete process.env.DEV_MODE;
	});

	it('answers HEAD navigations with headers only, without running the SSR render', async (t) => {
		process.env.DEV_MODE = 'false';
		mockProd(t);

		const scope = makeScope({ withHttp: true, ssr: 'src/entry-server.tsx' });
		await handleApplication(scope);

		const res = mockResponse();
		const request = { _nodeRequest: { method: 'HEAD', headers: { accept: 'text/html' } }, _nodeResponse: res };
		const nextLayer = t.mock.fn(() => 'HARPER');
		void scope.httpHandler(request, nextLayer);
		await tick();

		assert.strictEqual(res.statusCode, 200, 'HEAD gets a 200');
		assert.strictEqual(res.headers['Content-Type'], 'text/html');
		assert.strictEqual(res.ended, true, 'the response is ended');
		assert.strictEqual(res.body, undefined, 'no rendered body is produced for HEAD');
		assert.strictEqual(nextLayer.mock.callCount(), 0, 'a HEAD navigation does not fall through');
		delete process.env.DEV_MODE;
	});

	it('renders HTML via the built SSR bundle and reuses the cached module across requests', async (t) => {
		process.env.DEV_MODE = 'false';
		const { root } = mockProd(t);
		// A real client build (with the outlet) and a real SSR bundle, so the render path can import it.
		mkdirSync(join(root, 'dist'), { recursive: true });
		writeFileSync(join(root, 'dist', 'index.html'), '<div id="app"><!--ssr-outlet--></div>');
		const bundle = ssrBundlePath(root, 'src/entry-server.tsx');
		mkdirSync(join(bundle, '..'), { recursive: true });
		// `$&` in the output would be a replacement pattern under a literal `String.replace` — it must survive.
		writeFileSync(bundle, 'export const render = (url) => "<p>" + url + " $&</p>";');

		const scope = makeScope({ directory: root, withHttp: true, ssr: 'src/entry-server.tsx' });
		await handleApplication(scope);

		const get = async (url: string) => {
			const res = mockResponse();
			const request = { _nodeRequest: { method: 'GET', headers: { accept: 'text/html' }, url }, _nodeResponse: res };
			void scope.httpHandler(request, t.mock.fn());
			for (let i = 0; i < 100 && !res.ended; i++) await tick();
			return res;
		};

		const first = await get('/home');
		assert.strictEqual(first.statusCode, 200);
		assert.strictEqual(first.headers['Content-Type'], 'text/html');
		assert.strictEqual(
			first.body,
			'<div id="app"><p>/home $&</p></div>',
			'injects the per-URL render into the outlet, leaving `$&` literal'
		);

		// A second navigation reuses the cached module (mtime unchanged) and still renders per-URL.
		const second = await get('/about');
		assert.strictEqual(second.body, '<div id="app"><p>/about $&</p></div>');
		delete process.env.DEV_MODE;
	});

	it('runs the production build when hmr: false, even with DEV_MODE', async (t) => {
		process.env.DEV_MODE = 'true';
		const { buildMock } = mockProd(t);
		const createServerMock = t.mock.method(viteWrapper, 'createServer', async () => ({
			close: t.mock.fn(),
			middlewares: t.mock.fn(),
		}));

		const scope = makeScope({ withHttp: true, hmr: false });
		await handleApplication(scope);

		assert.strictEqual(createServerMock.mock.callCount(), 0, 'hmr: false skips the dev server');
		assert.strictEqual(buildMock.mock.callCount(), 1, 'hmr: false runs the production build');
		delete process.env.DEV_MODE;
	});
});

describe('withBuildLock', () => {
	// The lock coordinates through `databases.harperfast_vite.vite_build_info`. The `databases` export is a
	// shared singleton (cleared to `{}` at the top of this file), so assigning a mock table at that path
	// injects it into the module under test — this is why `buildLock` imports `databases` instead of reading
	// `globalThis`.
	const TABLE = 'vite_build_info';

	/** A record as Harper returns it from `table.get`: a status plus the time it was last written. */
	const building = (ageMs = 0) => ({ status: 'building', getUpdatedTime: () => Date.now() - ageMs });
	const idle = () => ({ status: 'idle', getUpdatedTime: () => Date.now() });

	/**
	 * A stand-in for the Harper build-info table. `get` returns the scripted records in order (the last one
	 * repeats); every `get`/`put` is appended to `events` so a test can assert the exact interleaving of
	 * claim → build → release.
	 */
	function makeTable(events: string[], getReturns: any[] = [undefined]) {
		let i = 0;
		return {
			puts: [] as Array<{ key: string; value: any }>,
			async get(_key: string) {
				return getReturns[Math.min(i++, getReturns.length - 1)];
			},
			async put(key: string, value: any) {
				this.puts.push({ key, value });
				events.push(`put:${value.status}`);
			},
		};
	}

	/** Install `table` as the build-info table for one test, removing it afterward so tests don't leak state. */
	function useTable(t: any, table: unknown) {
		(databases as any).harperfast_vite[TABLE] = table;
		t.after(() => delete (databases as any).harperfast_vite[TABLE]);
	}

	// A minimal Scope: `withBuildLock` only touches `appName` (the record key) and the optional `logger`.
	const scope = { appName: 'test-app', logger: {} } as unknown as Scope;

	it('runs the build directly when no Harper table is available (e.g. unit tests / outside Harper)', async (t) => {
		delete (databases as any).harperfast_vite[TABLE];
		const build = t.mock.fn(async () => {});

		await withBuildLock(scope, build);

		assert.strictEqual(build.mock.callCount(), 1, 'builds without any locking when there is no table');
	});

	it('claims the build, runs it, then releases the claim when no worker holds the record', async (t) => {
		const events: string[] = [];
		const table = makeTable(events); // get → undefined (no existing record)
		useTable(t, table);
		const build = t.mock.fn(async () => {
			events.push('build');
		});

		await withBuildLock(scope, build);

		assert.strictEqual(build.mock.callCount(), 1);
		assert.deepStrictEqual(
			events,
			['put:building', 'build', 'put:idle'],
			'claims (building) before building and releases (idle) after'
		);
		assert.deepStrictEqual(
			table.puts.map((p) => p.key),
			['test-app', 'test-app'],
			'keyed by appName'
		);
	});

	it('waits without building when another worker holds a fresh claim, returning once it is released', async (t) => {
		const events: string[] = [];
		// Gate sees a fresh "building" claim; after one poll the other worker has moved to "idle".
		const table = makeTable(events, [building(), idle()]);
		useTable(t, table);
		const build = t.mock.fn(async () => {
			events.push('build');
		});

		await withBuildLock(scope, build);

		assert.strictEqual(build.mock.callCount(), 0, 'does not build while another worker holds the claim');
		assert.deepStrictEqual(table.puts, [], 'never writes a claim of its own — the other worker produced the output');
	});

	it('treats a "building" record with no recent heartbeat as abandoned and builds anyway', async (t) => {
		const events: string[] = [];
		// No heartbeat for longer than the stale threshold → the holder is assumed crashed.
		const table = makeTable(events, [building(6 * 60 * 1000)]);
		useTable(t, table);
		const build = t.mock.fn(async () => {
			events.push('build');
		});

		await withBuildLock(scope, build);

		assert.strictEqual(build.mock.callCount(), 1, 'reclaims and builds past a stale claim');
		assert.deepStrictEqual(events, ['put:building', 'build', 'put:idle']);
	});

	it('releases the claim even when the build throws', async (t) => {
		const events: string[] = [];
		const table = makeTable(events);
		useTable(t, table);
		const build = t.mock.fn(async () => {
			events.push('build');
			throw new Error('boom');
		});

		await assert.rejects(withBuildLock(scope, build), /boom/);

		assert.deepStrictEqual(events, ['put:building', 'build', 'put:idle'], 'the finally block releases the claim');
	});

	it('re-stamps the claim on a heartbeat while a long build runs, then releases it', async (t) => {
		// Mock only setInterval — the heartbeat's timer. This path never reaches the waiter's sleep().
		t.mock.timers.enable({ apis: ['setInterval'] });
		const events: string[] = [];
		const table = makeTable(events); // get → undefined (no existing record)
		useTable(t, table);

		let finishBuild!: () => void;
		const build = t.mock.fn(() => new Promise<void>((resolve) => (finishBuild = resolve)));

		const done = withBuildLock(scope, build);
		await tick(); // claim the build, start the build, and arm the heartbeat
		assert.deepStrictEqual(events, ['put:building'], 'claims once up front');

		// Simulate a build long enough to cross two heartbeat intervals (30s each).
		t.mock.timers.tick(30_000);
		await tick();
		t.mock.timers.tick(30_000);
		await tick();
		assert.deepStrictEqual(
			events,
			['put:building', 'put:building', 'put:building'],
			'each heartbeat re-stamps the building claim so a live build never looks abandoned'
		);

		finishBuild();
		await done;
		assert.strictEqual(build.mock.callCount(), 1);
		assert.strictEqual(
			events.at(-1),
			'put:idle',
			'the terminal record is the last write — no heartbeat re-stamp after it'
		);
	});
});

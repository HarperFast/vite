/**
 * Integration tests: the plugin running inside a real, ephemeral Harper instance.
 *
 * @harperfast/integration-testing owns the Harper lifecycle — it allocates a loopback address, creates a
 * temporary install, copies the test-fixture in as a component, starts Harper, and tears it all down per
 * suite. We just drive HTTP and assert behavior.
 *
 * Both modes run from the *same* fixture: the plugin picks the Vite dev server (HMR) vs. the hybrid
 * production build from `DEV_MODE` (which `harper dev` sets), so the development suite starts Harper with
 * `DEV_MODE=true` and the production suite without it.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type StartedHarperTestContext } from '@harperfast/integration-testing';

// The HMR WebSocket path — must match `HMR_PATH` in src/development.ts. Kept as a literal (NOT imported from
// the plugin source) on purpose: this out-of-process driver must not pull the plugin's module graph — which
// `import { databases } from 'harper'` and so eagerly loads Harper's internals — into the test runner's own
// process, where it throws outside a configured Harper. If the two ever diverge, the WS test below fails loudly.
const HMR_PATH = '/@harper-vite-hmr';

// On macOS the framework's default install dir lives under `tmpdir()` → `/var/folders/…`, where `/var` is a
// symlink to `/private/var`. That mismatch breaks the plugin's production build (Vite realpaths the
// `index.html` input → `/var` vs `/private/var` → an illegal relative chunk name) and makes the dev server
// hang under the realpath form. A canonical dir under $HOME avoids it — and Harper's rootPath validation
// forbids `.`, so the directory name has no dot. On Linux/CI `tmpdir()` is already canonical; leave it be.
const scratchParent =
	platform() === 'darwin' ? join(realpathSync(homedir()), 'harper-integration-test') : realpathSync(tmpdir());
if (platform() === 'darwin') {
	mkdirSync(scratchParent, { recursive: true });
	process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR ??= scratchParent;
}

const fixtureDir = join(import.meta.dirname, '..', 'test-fixture');

// Harper's `exports` map blocks the framework's `require.resolve('harper/dist/bin/harper.js')`
// auto-resolution, so point it at the CLI entry directly (the same script `node_modules/.bin/harper` runs).
const harperBinPath = join(import.meta.dirname, '..', 'node_modules', 'harper', 'dist', 'bin', 'harper.js');

// `setupHarperWithFixture` copies the fixture into `<dataRootDir>/components/<basename>`; that copy — not
// the repo's source tree — is what the running plugin builds from and what we edit to test rebuilds.
const componentDir = (ctx: StartedHarperTestContext) =>
	join(ctx.harper.dataRootDir, 'components', basename(fixtureDir));

// Browsers send `Accept: text/html` for navigations; the plugin serves the HTML document only for such
// requests, so non-browser clients (and the app's own `fetch` calls) still reach the Harper API.
const htmlHeaders = { Accept: 'text/html' };

/** Poll the document until it contains `text` (or time out). The production build runs at startup — Harper
 * reports "successfully started" before it finishes — so requests must wait for the first build to land. */
async function waitForHtml(url: string, text: string, attempts = 60): Promise<string> {
	for (let i = 0; i < attempts; i++) {
		const html = await (await fetch(url, { headers: htmlHeaders })).text().catch(() => '');
		if (html.includes(text)) return html;
		await sleep(1000);
	}
	throw new Error(`timed out waiting for ${JSON.stringify(text)} at ${url}`);
}

suite('harper dev: server-renders with HMR over HTTP, and falls through to Harper resources', () => {
	// `setupHarperWithFixture` populates `ctx.harper` in place; it's fully set by the time any test runs.
	const ctx = {} as StartedHarperTestContext;
	// `DEV_MODE=true` is what `harper dev` sets; it switches the plugin to the Vite dev server (HMR).
	before(() => setupHarperWithFixture(ctx, fixtureDir, { harperBinPath, env: { DEV_MODE: 'true' } }));
	after(() => teardownHarper(ctx));

	test('HTML navigations are server-rendered, with the Vite HMR client injected', async () => {
		// Harper auto-authorizes loopback requests as super_user, so the dev server's auth guard passes.
		const page = await fetch(ctx.harper.httpURL, { headers: htmlHeaders });
		strictEqual(page.status, 200);
		const html = await page.text();
		ok(html.includes('Hello from Vite!'), 'page is server-rendered');
		ok(html.includes('/@vite/client'), 'Vite HMR client is present in dev');
	});

	test('requests the Vite app does not serve fall through to Harper resources', async () => {
		const api = await fetch(`${ctx.harper.httpURL}/Build`, { headers: { Accept: 'application/json' } });
		strictEqual(api.status, 200, 'Harper resource reachable through fall-through');
	});

	test('the HMR WebSocket connects through Harper’s own port behind the auth gate', async () => {
		// The HMR socket is served on Harper's port at the plugin's dedicated path — not Vite's default
		// standalone port. Loopback is auto-authorized (authorizeLocal), so the plugin's upgrade gate forwards
		// the upgrade to Vite, which completes the `vite-hmr` handshake. A successful open exercises the whole
		// real chain end to end: Harper's upgrade routing → the super_user gate → the Vite bridge → handshake.
		const wsURL = ctx.harper.httpURL.replace(/^http/, 'ws') + HMR_PATH;
		const outcome = await new Promise<string>((resolve) => {
			const ws = new WebSocket(wsURL, 'vite-hmr');
			const done = (r: string) => {
				try {
					ws.close();
				} catch {}
				resolve(r);
			};
			ws.addEventListener('open', () => done('open'));
			ws.addEventListener('error', () => done('error'));
			setTimeout(() => done('timeout'), 10_000);
		});
		strictEqual(outcome, 'open', 'the gated HMR WebSocket upgrade is authorized and the handshake completes');
	});
});

/**
 * Derive an SPA variant of the fixture — the same app, with `ssr` dropped from the component config — in a
 * scratch directory. Harper v5's module loader realpath-checks every import against the application
 * directory and rejects symlinks, so this has to be a physical copy, `node_modules` included.
 */
function makeSpaFixture(): string {
	const dir = mkdtempSync(join(scratchParent, 'spa-fixture-'));
	cpSync(fixtureDir, dir, { recursive: true });
	const config = readFileSync(join(fixtureDir, 'config.yaml'), 'utf8').replace(/^[ \t]*ssr:.*\n/m, '');
	writeFileSync(join(dir, 'config.yaml'), config);
	return dir;
}

suite('harper dev (SPA): serves the app shell for navigations and falls through for everything else', () => {
	const ctx = {} as StartedHarperTestContext;
	let spaFixtureDir: string;
	before(async () => {
		spaFixtureDir = makeSpaFixture();
		await setupHarperWithFixture(ctx, spaFixtureDir, { harperBinPath, env: { DEV_MODE: 'true' } });
	});
	after(async () => {
		await teardownHarper(ctx);
		rmSync(spaFixtureDir, { recursive: true, force: true });
	});

	test('HTML navigations get the app shell with the Vite HMR client injected', async () => {
		const page = await fetch(ctx.harper.httpURL, { headers: htmlHeaders });
		strictEqual(page.status, 200);
		const html = await page.text();
		ok(html.includes('<div id="app">'), 'the app shell is served');
		ok(html.includes('/@vite/client'), 'the shell went through transformIndexHtml');
	});

	test('deep links get the shell too, so client-side routes survive a reload', async () => {
		const page = await fetch(`${ctx.harper.httpURL}/some/client/route`, { headers: htmlHeaders });
		strictEqual(page.status, 200);
		ok((await page.text()).includes('/@vite/client'), 'an unknown path still gets the shell');
	});

	test('Harper resources stay reachable while the dev server is running', async () => {
		// Regression guard: under `appType: 'spa'` Vite appends its own 404 middleware, which *ends* every
		// request it did not serve instead of passing it on — so every Harper resource 404'd under `harper dev`.
		const api = await fetch(`${ctx.harper.httpURL}/Build`, { headers: { Accept: 'application/json' } });
		strictEqual(api.status, 200, 'a Harper resource is reachable through fall-through');
	});

	test('a wildcard Accept reaches the API instead of being answered with the shell', async () => {
		// Regression guard: `fetch()` sends a wildcard Accept by default, and Vite's SPA fallback treats that
		// as a navigation — so an app's own API calls silently received the HTML shell instead of JSON.
		const api = await fetch(`${ctx.harper.httpURL}/Build`);
		strictEqual(api.status, 200);
		ok(api.headers.get('content-type')?.includes('json'), 'the API answered, not the HTML shell');
		strictEqual(typeof (await api.json()).answer, 'number');
	});
});

suite('harper run: builds and server-renders the production output (no HMR)', () => {
	const ctx = {} as StartedHarperTestContext;
	before(async () => {
		await setupHarperWithFixture(ctx, fixtureDir, { harperBinPath });
		// Block until the startup build has produced the SSR render, so every test below sees a built app.
		await waitForHtml(ctx.harper.httpURL, 'Hello from Vite!');
	});
	after(() => teardownHarper(ctx));

	test('server-renders from the built SSR bundle, without the HMR client', async () => {
		const page = await fetch(ctx.harper.httpURL, { headers: htmlHeaders });
		strictEqual(page.status, 200);
		const html = await page.text();
		ok(html.includes('Hello from Vite!'), 'page is server-rendered from the production build');
		ok(!html.includes('/@vite/client'), 'no HMR client in production');
		ok(!html.includes('<!--ssr-outlet-->'), 'the SSR outlet was rendered, not served raw');
	});

	test("a hashed build asset is served by Harper's static plugin", async () => {
		// The whole point of the parallel-static design: the plugin renders HTML, `static` serves the assets.
		const html = await (await fetch(ctx.harper.httpURL, { headers: htmlHeaders })).text();
		const assetUrl = html.match(/\/assets\/[^"']+\.(?:js|css)/)?.[0];
		ok(assetUrl, 'rendered HTML references a built asset');
		const asset = await fetch(`${ctx.harper.httpURL}${assetUrl}`);
		strictEqual(asset.status, 200, 'the static plugin serves the built asset');
	});

	test('the client build output exists', () => {
		ok(existsSync(join(componentDir(ctx), 'dist')), 'client build output exists');
	});

	test('editing a watched source file triggers a rebuild that updates the served output', async () => {
		// Edit the ephemeral component copy (teardown discards it) rather than the repo's source.
		const appFile = join(componentDir(ctx), 'src', 'App.tsx');
		const original = readFileSync(appFile, 'utf8');
		writeFileSync(appFile, original.replace('Hello from Vite!', 'Hello from Rebuild!'));

		// waitForHtml throws (failing the test) if the change never gets picked up.
		await waitForHtml(ctx.harper.httpURL, 'Hello from Rebuild!');
	});
});

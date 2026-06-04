import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const harperBin = join(import.meta.dirname, '..', 'node_modules', '.bin', 'harper');
const fixtureDir = join(import.meta.dirname, '..', 'test-fixture');

// Base install/admin env shared by both modes. `DEFAULTS_MODE` selects Harper's dev (HTTP, open) vs
// prod (HTTPS, auth) install profile. The root path is passed as a CLI arg (`--ROOTPATH`) because that
// is what Harper v5 uses to locate/create its config for a fresh, isolated install.
const baseEnv = {
	HDB_INSTALL: 'true',
	TC_AGREEMENT: 'yes',
	HDB_ADMIN_USERNAME: 'HDB_ADMIN',
	HDB_ADMIN_PASSWORD: 'password',
	OPERATIONSAPI_NETWORK_PORT: '9925',
};

// Browsers send `Accept: text/html` for navigations; the plugin (like Vite's SPA fallback) only
// serves the HTML document for such requests, so non-browser clients still reach the Harper API.
const htmlHeaders = { Accept: 'text/html' };

function startHarper(command: 'dev' | 'run', rootPath: string, defaultsMode: 'dev' | 'prod') {
	rmSync(rootPath, { recursive: true, force: true });
	const harper = spawn(harperBin, [command, '.', `--ROOTPATH=${rootPath}`], {
		cwd: fixtureDir,
		env: { ...process.env, ...baseEnv, DEFAULTS_MODE: defaultsMode },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	harper.stdin.write('yes\n');
	return harper;
}

// Harper runs a pool of worker threads; give it a moment to release port 9926 before the next test
// starts another instance. Resolves once the process exits (or after a SIGKILL fallback).
async function stopHarper(child: any): Promise<void> {
	return new Promise((resolve) => {
		const force = setTimeout(() => child.kill('SIGKILL'), 8000);
		child.on('exit', () => {
			clearTimeout(force);
			setTimeout(resolve, 1000);
		});
		child.kill('SIGINT');
	});
}

async function waitForOutput(child: any, pattern: string, timeout = 90000): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timeout waiting for pattern: ${pattern}`)), timeout);
		child.stdout.on('data', (data: Buffer) => {
			const str = data.toString();
			process.stdout.write(str);
			if (str.includes(pattern)) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.stderr.on('data', (data: Buffer) => process.stderr.write(data.toString()));
	});
}

test('harper dev: server-renders with HMR over HTTP, and falls through to Harper resources', async () => {
	// Requires a locally runnable Harper; skipped in restricted CI environments.
	// Run `npm run test:integration` (which installs the local plugin into the fixture first).
	if (process.env.SKIP_INTEGRATION) return;
	const harper = startHarper('dev', '/tmp/hdb-vite-dev', 'dev');
	try {
		await waitForOutput(harper, 'successfully started');

		// HTML navigation is server-rendered on the fly via Vite's ssrLoadModule.
		const page = await fetch('http://localhost:9926/', { headers: htmlHeaders });
		assert.strictEqual(page.status, 200);
		const html = await page.text();
		assert.ok(html.includes('Hello from Vite!'), 'page is server-rendered');
		assert.ok(html.includes('/@vite/client'), 'Vite HMR client is present in dev');

		// Requests the Vite app does not serve fall through to Harper resources (dev profile is open).
		const api = await fetch('http://localhost:9926/Build', { headers: { Accept: 'application/json' } });
		assert.strictEqual(api.status, 200, 'Harper resource reachable through fall-through');
	} finally {
		await stopHarper(harper);
	}
});

test('harper run: builds and server-renders the production output over HTTPS (no HMR)', async () => {
	if (process.env.SKIP_INTEGRATION) return;
	// Prod profile serves HTTPS with a self-signed cert; accept it for this local test.
	const priorTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
	const harper = startHarper('run', '/tmp/hdb-vite-prod', 'prod');
	try {
		await waitForOutput(harper, 'successfully started');

		// Server-rendered from the built SSR bundle; no Vite dev client in production.
		const page = await fetch('https://localhost:9926/', { headers: htmlHeaders });
		assert.strictEqual(page.status, 200);
		const html = await page.text();
		assert.ok(html.includes('Hello from Vite!'), 'page is server-rendered from the production build');
		assert.ok(!html.includes('/@vite/client'), 'no HMR client in production');
		assert.ok(!html.includes('<!--ssr-outlet-->'), 'the SSR outlet was rendered, not served raw');

		// A hashed build asset is served by Harper's `static` plugin (configured alongside this plugin),
		// which is the whole point of the parallel-static design.
		const assetUrl = html.match(/\/assets\/[^"']+\.(?:js|css)/)?.[0];
		assert.ok(assetUrl, 'rendered HTML references a built asset');
		const asset = await fetch(`https://localhost:9926${assetUrl}`);
		assert.strictEqual(asset.status, 200, 'the static plugin serves the built asset');

		// The client build output exists (the `output` directory).
		const { existsSync } = await import('node:fs');
		assert.ok(existsSync(join(fixtureDir, 'dist')), 'client build output exists');

		// Rebuild-on-change: editing a watched source file recompiles and updates the served output.
		const appFile = join(fixtureDir, 'src', 'App.tsx');
		const original = readFileSync(appFile, 'utf8');
		try {
			writeFileSync(appFile, original.replace('Hello from Vite!', 'Hello from Rebuild!'));
			let rebuilt = false;
			for (let i = 0; i < 45 && !rebuilt; i++) {
				await sleep(1000);
				const r = await fetch('https://localhost:9926/', { headers: htmlHeaders });
				rebuilt = (await r.text()).includes('Hello from Rebuild!');
			}
			assert.ok(rebuilt, 'a source-file change triggers a rebuild that updates the served output');
		} finally {
			writeFileSync(appFile, original);
		}
	} finally {
		await stopHarper(harper);
		if (priorTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		else process.env.NODE_TLS_REJECT_UNAUTHORIZED = priorTlsSetting;
	}
});

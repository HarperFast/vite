import type { Scope } from 'harper';
import { basename, isAbsolute, join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { viteWrapper } from './wrappers.ts';
import { acceptsHtml, registerHttp } from './http.ts';
import { hasFilesOption, resolveOutput } from './options.ts';
import { withBuildLock } from './buildLock.ts';
import { log } from './log.ts';

/**
 * Hybrid production mode: build the app with Vite (the real production build) and — when `files` is
 * configured — recompile whenever watched files change. No HMR.
 *
 * The client is built to the `output` directory (default `dist`); serving it is delegated to Harper's
 * built-in `static` plugin, configured alongside this plugin in the application's `config.yaml` and
 * pointed at the same directory. So this plugin only builds; for SSR it additionally renders the HTML
 * document (which `static` can't do) while `static` serves the assets. SPA apps need no handler here at
 * all — `static` serves everything.
 */
export async function setupProduction(scope: Scope, ssrEntry?: string) {
	const root = scope.directory;

	// The client build directory (the `output` option), which the `static` plugin should also serve.
	const output = resolveOutput(scope.options?.get?.(['output']));
	const clientOutDir = isAbsolute(output) ? output : join(root, output);
	// The SSR server bundle is an internal artifact — keep it out of `output` so `static` never serves it.
	const serverOutDir = join(root, 'node_modules', '.harper-vite-ssr');
	// Vite/Rollup names the SSR bundle after the entry file.
	const serverEntryPath = ssrEntry ? join(serverOutDir, `${basename(ssrEntry).replace(/\.\w+$/, '')}.js`) : '';

	log(scope, 'info', `production mode (output: '${output}'${ssrEntry ? `, ssr: '${ssrEntry}'` : ', SPA'})`);

	const build = async (emptyOutDir: boolean) => {
		const startedAt = Date.now();
		log(scope, 'info', `building${ssrEntry ? ' client + SSR bundle' : ''} → '${output}'…`);
		await viteWrapper.build({ root, build: { outDir: clientOutDir, emptyOutDir } });
		if (ssrEntry) {
			await viteWrapper.build({
				root,
				build: { ssr: ssrEntry, outDir: serverOutDir, emptyOutDir },
			});
		}
		log(scope, 'info', `build complete in ${Date.now() - startedAt}ms`);
	};

	// A build is needed unless the client output exists AND — in SSR mode — the server bundle exists too.
	// (Checking only the client dir would skip the build when a stale/client-only `dist` is already present,
	// leaving the SSR bundle missing and failing at render time.)
	const isBuilt = () => existsSync(clientOutDir) && (!ssrEntry || existsSync(serverEntryPath));

	if (isBuilt()) {
		log(scope, 'info', `existing build found at '${output}', skipping initial build`);
	} else {
		// Only the worker that claims the build runs it; the rest wait for it to finish.
		await withBuildLock(scope, async () => {
			if (!isBuilt()) await build(true);
		});
	}

	// Recompile on change. One worker rebuilds (without emptying the output dir, so the previous assets keep
	// serving meanwhile); the `static` plugin's own watcher picks up the new output.
	const filesOption = scope.options?.get?.(['files']);
	if (hasFilesOption(filesOption)) {
		let active: Promise<void> | null = null;
		let queued = false;

		const runBuild = () => {
			active = (async () => {
				try {
					await withBuildLock(scope, () => build(false));
				} catch (e) {
					log(scope, 'error', 'rebuild failed:', e);
				} finally {
					active = null;
					if (queued) {
						queued = false;
						runBuild();
					}
				}
			})();
		};

		const scheduleRebuild = () => {
			if (active) {
				queued = true;
				log(scope, 'debug', 'rebuild already in progress; queued another');
				return;
			}
			runBuild();
		};

		// The entry handler replays the existing files as `add` events during its initial scan, then emits
		// `ready`. Only rebuild on changes *after* `ready`, so the initial scan doesn't trigger a redundant
		// build. (Earlier versions gated on `initialLoadComplete`, which the entry handler never emits — so
		// rebuilds never fired.)
		const entry = scope.handleEntry();
		let watching = false;
		entry.once('ready', () => {
			watching = true;
			log(
				scope,
				'info',
				`watching ${typeof filesOption === 'string' ? `'${filesOption}'` : 'configured files'} for changes`
			);
		});
		entry.on('all', (event: any) => {
			if (!watching) return; // ignore the initial scan
			log(
				scope,
				'info',
				`change detected (${event?.eventType ?? 'change'} ${event?.urlPath ?? event?.absolutePath ?? ''}); rebuilding`
			);
			scheduleRebuild();
		});
	} else {
		log(scope, 'info', 'rebuild-on-change disabled (no `files` option set)');
	}

	// SPA apps are fully served by the `static` plugin (assets + index.html). There's nothing more to do.
	if (!ssrEntry) return;

	// SSR: render the HTML document for navigations. `static` serves the built assets and falls through to
	// here for `text/html` requests; everything else falls through to Harper (e.g. the REST API).

	// The built `index.html` only changes on a rebuild, so read it once and re-read only when its mtime
	// moves. This keeps a (cheap) `statSync` on the per-request path but avoids re-reading the whole file
	// on every request — this handler can be reached by unauthenticated clients.
	const templatePath = join(clientOutDir, 'index.html');
	let cachedTemplate: { mtimeMs: number; html: string } | undefined;
	const readTemplate = (): string => {
		const mtimeMs = statSync(templatePath).mtimeMs;
		if (cachedTemplate?.mtimeMs !== mtimeMs) {
			cachedTemplate = { mtimeMs, html: readFileSync(templatePath, 'utf-8') };
		}
		return cachedTemplate.html;
	};

	// Resolve the SSR `render`, re-importing only when the bundle's *content* changes. The import is
	// cache-busted by a content hash rather than the mtime, so a rebuild that produces identical output
	// (a watched file changed but the SSR bundle didn't) reuses the existing module instead of accreting a
	// new one — Node can't evict ESM modules, so every distinct import lives for the process lifetime, and
	// hashing bounds that to the number of genuinely-different bundles served. The mtime is a cheap gate so
	// we don't hash on every request, and each worker still picks up another worker's rebuild (its mtime
	// moves → re-hash → re-import only if the content actually differs). A rebuild overwrites the bundle in
	// place (it shares the client build's `emptyOutDir`, so rebuilds don't wipe the dir); if a read/import
	// still races a partial write we keep serving the last good module.
	const serverEntryUrl = pathToFileURL(serverEntryPath).href;
	let cachedRender: { mtimeMs: number; hash: string; render: (url: string) => any } | undefined;
	const loadRender = async (): Promise<(url: string) => any> => {
		try {
			const mtimeMs = statSync(serverEntryPath).mtimeMs;
			if (cachedRender?.mtimeMs === mtimeMs) return cachedRender.render;

			const hash = createHash('sha256').update(readFileSync(serverEntryPath)).digest('hex');
			if (cachedRender?.hash === hash) {
				cachedRender.mtimeMs = mtimeMs; // same code, new mtime — refresh the cheap gate, skip re-import
				return cachedRender.render;
			}

			const { render } = await import(`${serverEntryUrl}?v=${hash}`);
			cachedRender = { mtimeMs, hash, render };
			return render;
		} catch (e) {
			if (cachedRender) return cachedRender.render; // mid-rebuild window — serve the previous bundle
			throw e;
		}
	};

	const renderHtml = async (url: string) => {
		const template = readTemplate();
		const render = await loadRender();
		const appHtml = await render(url);
		// Function replacer: a literal string would let `$&`/`$\``/`$'`/`$$` sequences in the rendered
		// markup be interpreted as replacement patterns and corrupt the document.
		return template.replace('<!--ssr-outlet-->', () => appHtml);
	};

	registerHttp(
		scope,
		(req, res, next) => {
			if (!acceptsHtml(req)) return next();
			// A HEAD asks only for headers; don't run the (potentially DB-touching) render for it.
			if ((req.method ?? 'GET') === 'HEAD') {
				res.statusCode = 200;
				res.setHeader('Content-Type', 'text/html');
				res.setHeader('Cache-Control', 'no-cache');
				return res.end();
			}
			renderHtml(req.url)
				.then((html) => {
					res.statusCode = 200;
					res.setHeader('Content-Type', 'text/html');
					res.setHeader('Cache-Control', 'no-cache');
					res.end(html);
				})
				.catch(next);
		},
		// Run ahead of Harper's authentication layer so the public HTML document renders for anonymous
		// visitors. `runFirst` unshifts this handler to the front of the HTTP chain; it only claims
		// `text/html` GET/HEAD navigations and otherwise falls through (`next()`), so authentication and the
		// REST API still run for API requests.
		{ runFirst: true }
	);
	log(scope, 'info', 'SSR render handler registered');
}

# `@harperfast/vite`

## Overview

A Harper application integration that runs a [Vite](https://vite.dev/) frontend inside a Harper component — with hot module replacement (HMR) for local development and a real production build when deployed (including on Harper Fabric).

It runs in one of two modes, chosen automatically:

| Mode                  | When                                  | Behavior                                                                                                                  |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Development**       | `harper dev` (Harper sets `DEV_MODE`) | Vite dev server in middleware mode with **HMR**.                                                                          |
| **Hybrid production** | `harper run` / Fabric (default)       | Builds your app with Vite (the real production build). **No HMR**, but it **recompiles automatically on source changes.** |

**Serving the built output is delegated to Harper's built-in [`static`](https://docs.harperdb.io/) plugin**, configured alongside this plugin and pointed at the same Vite output directory. So the two run in parallel: this plugin **builds** (and, for SSR, **renders** the HTML document — which `static` can't do), while `static` **serves** the assets. For an SPA you don't even need a handler from this plugin in production — `static` serves everything.

This separation makes for a clean deploy story: the output directory is the only contract between the two. You can build on the node, **build once and ship the output** (`static` serves it; this plugin can stay idle), or **pre-build and still edit live** (this plugin rebuilds on change → `static`'s watcher picks it up).

## Usage

Install the plugin in your Harper application:

```bash
npm install @harperfast/vite --save-dev
```

In your Harper application's `config.yaml`, add the plugin **and** a `static` block pointed at your Vite build output directory (the plugin builds; `static` serves). List the plugin first so its dev server takes precedence in `harper dev`:

```yaml
# Builds the app (and renders HTML in SSR mode) into the `output` directory.
'@harperfast/vite':
  package: '@harperfast/vite'
  files: 'src/**/*'
  output: 'dist'

# Serves the built assets from that same directory.
static:
  files: 'dist/**'
```

> For an **SSR** app, add `index: false` to the `static` block so it serves only assets and lets the plugin render `index.html`. For an **SPA**, leave `index` on (and optionally set `notFound: index.html` for client-side routing).

Then point your `dev` script at Harper:

```jsonc
// package.json
"scripts": {
  "dev": "harper dev .",   // development mode (HMR)
  "start": "harper run ."   // hybrid production mode
}
```

Your application runs on [http://localhost:9926](http://localhost:9926/).

### How it works

1. Harper loads your application and calls the plugin's `handleApplication`.
2. The plugin picks development or hybrid-production mode from the [`hmr`](#hmr) option, defaulting to `DEV_MODE` (set by `harper dev`).
3. **Development:** a Vite dev server is created with `root` set to the application directory, `middlewareMode: true`, and HMR enabled. Your `vite.config.{js,ts,mjs,...}` is auto-resolved. The dev server handles all requests and falls through to Harper for the rest.
4. **Hybrid production:** the plugin runs `vite build` if the output is missing and — when `files` is configured — rebuilds whenever those files change. The `static` plugin serves the built assets; for SSR, this plugin additionally renders the HTML document for `text/html` navigations (everything else falls through to Harper).

## Configuration

To enable autocompletion and validation, reference the bundled schema:

```yaml
# yaml-language-server: $schema=node_modules/@harperfast/vite/schema.json
'@harperfast/vite':
  package: '@harperfast/vite'
  files: 'src/**/*'
  output: 'dist'
  ssr: 'src/entry-server.tsx'
```

### `output`

- **Type**: `string`
- **Optional** (defaults to `dist`)

The build output directory (relative to the app root) the plugin builds the client into. **Point your `static` block at the same directory** (e.g. `files: 'dist/**'`) — that pairing is the whole contract between the two plugins. The plugin sets Vite's build `outDir` to this value, so it takes precedence over any `outDir` in `vite.config`.

### `files`

- **Type**: `string | string[] | FilesOptionObject`
- **Optional**

A glob (or array of globs) of files to watch. In **hybrid production mode**, a change to any matched file triggers a rebuild. Rebuilds keep serving the previously built assets until the new build finishes, then swap atomically — so there's no downtime window. Omit it to disable rebuild-on-change (the app is built once at startup).

Builds are coordinated across Harper's worker threads through a small Harper table (`harperfast_vite.vite_build_info`, defined in the plugin's `schema.graphql`): one worker claims the build while the others wait, so the app is compiled **once per instance** rather than once per thread — important when running multi-threaded (e.g. on Harper Fabric).

### `ssr`

- **Type**: `string`
- **Optional**

Path (relative to the application root) to your **server-side render entry**, e.g. `src/entry-server.tsx`. When set, the plugin renders HTML on the server. When omitted, the app is treated as a client-only **SPA**, fully served by the `static` plugin in production.

### `hmr`

- **Type**: `boolean`
- **Optional** (defaults to `DEV_MODE`)

Whether to run the Vite dev server with **hot module replacement**. When omitted, it follows Harper's dev mode (the `DEV_MODE` env, set by `harper dev`). Set `hmr: true` to force the dev server, or `hmr: false` to force the hybrid production build (build + recompile-on-change) — useful for testing the production path locally without `DEV_MODE`.

> **Caching** is configured on the `static` plugin, not here — set `cacheControl`/`maxAge`/`immutable` (or `setHeaders`) on the `static` block. Content-hashed assets (under Vite's `assets` dir) are safe to cache long-term; the HTML document this plugin renders is always sent with `no-cache`.

## Security

This plugin compiles — and, for SSR, executes — your application **inside the Harper process at runtime** rather than shipping pre-built artifacts. That convenience has a few security implications worth understanding.

### Runtime compilation: treat the app directory as trusted code

In production the Harper process runs `vite build` at startup and — when [`files`](#files) is set — again on every change to a watched file. For an **SSR** app the resulting server bundle is then imported and its `render()` runs **in-process**. Consequences:

- **Write access to the watched source is code execution.** Anyone who can modify the files matched by `files` (or the app source generally) gains arbitrary code execution in the Harper process on the next rebuild (SSR), or controls the JavaScript served to every visitor (SPA). Ensure nothing that handles untrusted input — file uploads especially — can write into the app directory or the build output, and restrict filesystem permissions to your deploy process.
- **The whole build toolchain runs with Harper's privileges.** `vite.config.*`, every Vite/Rollup plugin, and any build-time dependency hook execute in the Harper process during the build. Pin and vet build-time dependencies (committed lockfile, `npm ci`); a supply-chain compromise there runs on your server, not in an isolated CI step.
- **Build-time env can leak into client JS.** Vite inlines `import.meta.env.VITE_*` and `define` values into the **client** bundle at build time. Because the build runs on the deployed node with production env present, never expose a server-only secret through a `VITE_`-prefixed variable or `define`.

If you prefer the traditional model, **build in CI and ship the output**: point `static` at the committed build directory and omit `files` so this plugin never compiles on the node (it stays idle while `static` serves the artifacts).

### HMR / the dev server is gated behind super*user auth — HTTP \_and* WebSocket

The Vite dev server (HMR mode) exposes powerful endpoints — on-the-fly module transforms and arbitrary file reads via `/@fs/` — and is not designed to face untrusted networks. This plugin therefore **requires Harper `super_user` credentials for the entire dev server: both its HTTP surface and its HMR WebSocket.** That gate is what lets you safely turn HMR on against a _deployed_ instance — e.g. from a cloud IDE — for a live-edit workflow when a local environment isn't an option.

- **Local development is unaffected.** Harper auto-authorizes loopback requests as super_user under `authentication.authorizeLocal` (the default in `harper dev`), so `localhost` just works.
- **Remote/exposed HTTP requests are challenged.** A request Harper did not authenticate as super_user receives a `401` with a `WWW-Authenticate: Basic` header; the browser then prompts for credentials, which are validated against Harper's user store. (This is why hitting the dev server from another device — e.g. a phone on the LAN — prompts for your admin login.)
- **The HMR WebSocket runs on Harper's port and is gated too.** Instead of Vite's default standalone WebSocket port, the plugin routes HMR over Harper's own port on a dedicated path and authorizes every upgrade as super_user — by trusting a loopback peer under `authorizeLocal` (so local `harper dev` needs no credentials, just like the HTTP surface), or, for a remote browser, by validating the `hdb-session` cookie Harper sets when you log in (or an `Authorization` header). So once the page has authenticated, the HMR socket connects under the same identity; an unauthenticated remote upgrade is refused and the socket closed. Nothing is exposed on a second port.
- **Host checking is relaxed by design.** Because every request is already gated, the plugin sets Vite's `server.allowedHosts: true` so HMR also works when reached at a non-localhost hostname; the super_user gate — not Vite's host allowlist — is what protects the surface.
- **Older Harper hosts fall back to a separate port.** If the host Harper is too old to expose the WebSocket `upgrade` hook this relies on, the plugin reverts to Vite's standalone WebSocket port, which is **not** gated (the plugin logs a warning). Keep it bound to localhost.

As always, only grant `super_user` to people you trust, and prefer the production build (`hmr: false`) for anything that doesn't specifically need live editing.

### SSR renders before authentication

The SSR HTML handler is intentionally reachable by **unauthenticated** users (a public page must render for anonymous visitors). Your `render(url)` runs with no authenticated user and receives the **raw, attacker-controllable request URL**. So:

- If a rendered page contains sensitive data, enforce authorization **inside** your render path — don't assume a logged-in user.
- Treat `url` as untrusted input: validate or encode it before using it for routing, data lookups, or reflecting it into markup (to avoid reflected XSS or unintended data access).

## Server-Side Rendering (SSR)

SSR follows Vite's standard [server rendering](https://vite.dev/guide/ssr) conventions. You provide two entries and an HTML template; the plugin wires them into Harper.

**`index.html`** — a placeholder marks where rendered markup is injected:

```html
<div id="app"><!--ssr-outlet--></div>
<script type="module" src="/src/entry-client.tsx"></script>
```

**`src/entry-server.tsx`** — exports `render`, returning the markup for a URL:

```tsx
import { renderToString } from 'react-dom/server';
import { App } from './App.tsx';

export function render(url: string): string {
	// Use `url` to drive routing / per-request data loading.
	return renderToString(<App />);
}
```

**`src/entry-client.tsx`** — hydrates the server-rendered DOM:

```tsx
import { hydrateRoot } from 'react-dom/client';
import { App } from './App.tsx';

hydrateRoot(document.getElementById('app')!, <App />);
```

Enable it with `ssr: 'src/entry-server.tsx'`. The plugin then:

- **Development:** serves assets via Vite, and for HTML navigations transforms `index.html` (`transformIndexHtml`), loads the entry with `ssrLoadModule` (so edits are reflected immediately, with HMR for client code), calls `render(url)`, and injects the result into `<!--ssr-outlet-->`.
- **Hybrid production:** builds the client bundle and a separate SSR bundle, then for HTML navigations imports the built server entry, calls `render(url)`, and injects it into the built `index.html`.

Because the plugin only renders HTML for requests that accept `text/html` (i.e. browser navigations) and falls through otherwise, your Harper resources and REST API remain reachable on the same port. Inside `render`, you can `await` data from Harper resources (e.g. `tables.Product.get(id)`) to render data-driven pages.

> See `test-fixture/` for a complete, runnable SSR example.

## Caching

Two complementary layers:

**1. HTTP caching (via the `static` plugin).** Assets are served by Harper's `static` plugin, which sets validators (`ETag`/`Last-Modified`) and supports `cacheControl`/`maxAge`/`immutable`/`setHeaders` options on its config block. Content-hashed assets (under Vite's `assets` dir) are safe to cache long-term — e.g. `static: { files: 'dist/**', cacheControl: 'public, max-age=31536000, immutable' }`. The HTML document this plugin renders for SSR is always sent with `Cache-Control: no-cache` so navigations see fresh markup.

**2. Harper data/render caching.** Use a Harper table with a TTL as a cache. Define it with the `@table(expiration:)` directive, then populate it on a miss — ideal for caching expensive SSR output or upstream API responses:

```graphql
# schema.graphql — entries automatically expire after 60 seconds.
type RenderCache @table(expiration: 60) @export {
	path: ID @primaryKey
	html: String
	renderedAt: Date @createdTime
}
```

```js
// In your SSR render path: serve from cache, render + store on a miss.
async function renderCached(url) {
	const cached = await tables.RenderCache.get(url);
	if (cached) return cached.html;

	const html = await render(url);
	await tables.RenderCache.put({ path: url, html });
	return html;
}
```

Call `tables.RenderCache.invalidate(path)` (or `delete`) to bust an entry when the underlying data changes. Records are evicted automatically once they pass `expiration`.

## Precompute

Avoid doing the same work on every request:

- **Computed fields** — derive presentation- or denormalization-friendly values declaratively with `@computed`, instead of storing and maintaining them. The `from` expression is evaluated per Harper's computed-field rules (see the [Harper schema docs](https://docs.harperdb.io/)):

  ```graphql
  type Product @table @export {
  	id: ID @primaryKey
  	name: String
  	priceCents: Int
  	priceLabel: String @computed(from: "...") # derived from priceCents
  }
  ```

- **Startup precompute** — work at module load in a `jsResource` runs once when the component starts, not per request. Use it to build manifests, warm caches, or precompute derived data, then expose it through a resource:

  ```js
  // resources.js
  const manifest = buildExpensiveManifest(); // runs once at startup

  export class Manifest extends Resource {
  	get() {
  		return manifest;
  	}
  }
  ```

- **Build-time pre-rendering (SSG)** — for fully static pages, render them during the build and let the static server serve the resulting HTML, skipping per-request rendering entirely.

See [`test-fixture/resources.js`](test-fixture/resources.js) and [`test-fixture/schema.graphql`](test-fixture/schema.graphql) for working examples.

## Migrating from `@harperfast/vite-plugin`

This package was previously published as `@harperfast/vite-plugin` (through `0.3.0-beta.9`). Starting with `1.0.0` it is `@harperfast/vite`. The plugin's own API and behavior are unchanged — steps 1–2 are the rename; steps 3–4 are a quick check that the rest of your setup is in the shape the plugin expects.

1. Swap the dependency:

   ```bash
   npm uninstall @harperfast/vite-plugin
   npm install @harperfast/vite --save-dev
   ```

2. Update `config.yaml` — both the component key and its `package`:

   ```diff
   -'@harperfast/vite-plugin':
   -  package: '@harperfast/vite-plugin'
   +'@harperfast/vite':
   +  package: '@harperfast/vite'
      files: 'src/**/*'
      output: 'dist'
   ```

3. Make sure you have a `static` block. This plugin **builds** (and, in SSR mode, **renders** `index.html`); Harper's built-in `static` plugin **serves** the built assets. If you don't already have one, add it after the plugin block, pointed at the same directory as `output`:

   ```yaml
   static:
     files: 'dist/**' # same directory as the plugin's `output`
   ```

   For an **SSR** app add `index: false` (the plugin renders `index.html`); for an **SPA** leave `index` on and optionally set `notFound: index.html` for client-side routing. See [Usage](#usage).

4. Review your `vite.config.ts`. Nothing is strictly required — the plugin auto-resolves it and overrides Vite's build `outDir` with its `output` when it builds — but set `build.outDir` to the same directory so a standalone `vite build` stays consistent, alongside your framework plugin(s):

   ```ts
   import { defineConfig } from 'vite';
   import react from '@vitejs/plugin-react'; // or your framework's Vite plugin

   export default defineConfig({
   	plugins: [react()],
   	build: {
   		outDir: 'dist', // match the plugin's `output`
   		emptyOutDir: true,
   	},
   });
   ```

`@harperfast/vite-plugin` is deprecated and will receive no further updates.

## Tools Used

1. [TypeScript](https://www.typescriptlang.org/) for static typing
2. [ESLint](https://eslint.org/) for linting
3. [Prettier](https://prettier.io/) for code formatting
4. [Vite](https://vite.dev/) for the development server, middleware, and production build
5. Harper's built-in `static` plugin for serving the built output in production

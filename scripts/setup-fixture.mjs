// Prepares the test-fixture so it can load the *local* build of the plugin under Harper v5.
//
// Harper v5's module loader realpath-checks every import against the application directory and rejects
// anything resolving outside it (including symlinks). So the plugin — and its runtime dependency `sirv` —
// must physically live inside `test-fixture/node_modules`. We:
//   1. `npm install --install-links` in the fixture, which copies the `file:..` plugin dependency as real
//      files and installs its dependencies (sirv) in-path.
//   2. Overwrite the installed plugin payload with the freshly built `dist`, because npm caches `file:`
//      dependencies by version and won't pick up code changes on its own.
//   3. Remove stale build artifacts (`.vite` dep cache, `.harper-vite-ssr` server bundle) that local dev
//      runs leave behind. The integration framework copies the whole fixture into each ephemeral Harper
//      instance, and a stale, path-specific dep cache makes Vite hang re-optimizing while a leftover SSR
//      bundle makes the plugin skip its production build. A fresh CI checkout never has these.
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const fixture = join(root, 'test-fixture');
const dest = join(fixture, 'node_modules', '@harperfast', 'vite');

execSync('npm install --install-links', { cwd: fixture, stdio: 'inherit' });

for (const stale of ['.vite', '.harper-vite-ssr']) {
	rmSync(join(fixture, 'node_modules', stale), { recursive: true, force: true });
}

rmSync(join(dest, 'dist'), { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const entry of ['dist', 'config.yaml', 'schema.graphql', 'schema.json', 'package.json']) {
	cpSync(join(root, entry), join(dest, entry), { recursive: true });
}

console.log(`Installed local plugin build into ${dest}`);

import type { Scope } from 'harper';
import { normalizeSsrEntry, resolveHmr } from './options.ts';
import { setupDevelopment } from './development.ts';
import { setupProduction } from './production.ts';
import { log } from './log.ts';

// Re-export the mockable wrappers so tests (and consumers) can reach them from the entry point.
export { viteWrapper } from './wrappers.ts';

/**
 * Harper extension entry point. Runs the Vite dev server (HMR) or the hybrid-production build based on the
 * `hmr` option (defaulting to Harper's `DEV_MODE`), then hands off to the matching setup. SSR is enabled
 * when the `ssr` option points at a server entry.
 */
export async function handleApplication(scope: Scope) {
	const ssrEntry = normalizeSsrEntry(scope.options?.get?.(['ssr']));
	const hmr = resolveHmr(scope.options?.get?.(['hmr']));

	log(scope, 'info', `handling '${scope.appName}' in ${hmr ? 'development (HMR)' : 'production'} mode`);

	if (hmr) {
		await setupDevelopment(scope, ssrEntry);
	} else {
		await setupProduction(scope, ssrEntry);
	}
}

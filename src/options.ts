/** Harper sets `DEV_MODE` when started with `harper dev`. */
export function isDevMode(): boolean {
	return process.env.DEV_MODE === 'true' || process.env.DEV_MODE === '1';
}

/**
 * Whether to run the Vite dev server with HMR (vs. the hybrid production build).
 *
 * Controlled by the `hmr` option when it's an explicit boolean; otherwise defaults to Harper's dev mode
 * (the `DEV_MODE` env, set by `harper dev`).
 */
export function resolveHmr(hmrOption: unknown): boolean {
	return typeof hmrOption === 'boolean' ? hmrOption : isDevMode();
}

/** Normalize the optional `ssr` config value (path to the server entry) to a non-empty string or undefined. */
export function normalizeSsrEntry(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The build output directory (the `output` option), relative to the app root. This is where the plugin
 * builds the client and what the `static` plugin should serve. Defaults to `dist` (matching Vite's own
 * default), with any trailing slash trimmed.
 */
export function resolveOutput(value: unknown): string {
	const output = typeof value === 'string' && value.length > 0 ? value : 'dist';
	return output.replace(/\/+$/, '');
}

/** True when `files` is configured (string, non-empty array, or object), meaning we should watch for rebuilds. */
export function hasFilesOption(value: unknown): boolean {
	if (typeof value === 'string') return value.length > 0;
	if (Array.isArray(value)) return value.length > 0;
	return value != null && typeof value === 'object';
}

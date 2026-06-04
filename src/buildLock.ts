import { databases, type Scope } from 'harper';
import { setTimeout as sleep } from 'node:timers/promises';
import { log } from './log.ts';

// Harper runs `handleApplication` in every worker thread, so without coordination each worker would run
// its own `vite build` concurrently into the same output directory. We coordinate with a shared Harper
// table (defined in schema.graphql): a worker claims the per-app record with status "building" before
// compiling, and other workers see it and wait rather than building in parallel. This mirrors the
// `@harperfast/nextjs` build-info pattern and works across threads and processes that share the database.

const DATABASE = 'harperfast_vite';
const TABLE = 'vite_build_info';
const STALE_MS = 5 * 60 * 1000; // a "building" record older than this is treated as abandoned (crashed build)
const POLL_MS = 150;
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;

/** The build-info table, or undefined when running outside Harper (e.g. unit tests). */
function buildInfoTable(): any {
	return databases?.[DATABASE]?.[TABLE];
}

/** True while another worker holds a fresh "building" claim on this app. */
function heldByOther(info: any): boolean {
	return info?.status === 'building' && Date.now() - info.getUpdatedTime() < STALE_MS;
}

/**
 * Run `build` once across the workers sharing this app's build-info record. The worker that claims the
 * record runs the build; others wait until it finishes and return without building. Resolves once the
 * build is complete (whether performed by this worker or another), so callers can safely refresh from the
 * output afterward.
 *
 * Outside Harper (no `databases` global), it simply runs `build`.
 */
export async function withBuildLock(scope: Scope, build: () => Promise<void>): Promise<void> {
	const table = buildInfoTable();
	if (!table) {
		await build();
		return;
	}

	const key = scope.appName;

	// If another worker is already building, wait for it to finish and then skip — it produced the output.
	if (heldByOther(await table.get(key))) {
		log(scope, 'debug', 'another worker is building; waiting for it to finish');
		const start = Date.now();
		while (Date.now() - start < WAIT_TIMEOUT_MS) {
			await sleep(POLL_MS);
			if (!heldByOther(await table.get(key))) return;
		}
		log(scope, 'warn', 'timed out waiting for another worker to finish building');
		return;
	}

	// Claim the build. Other workers will observe "building" and wait above.
	await table.put(key, { status: 'building' });
	try {
		await build();
	} finally {
		await table.put(key, { status: 'idle' });
	}
}

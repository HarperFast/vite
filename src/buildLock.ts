import { databases, type Scope } from 'harper';
import { setTimeout as sleep } from 'node:timers/promises';
import { log } from './log.ts';

// Harper runs `handleApplication` in every worker thread, so without coordination each worker would run
// its own `vite build` concurrently into the same output directory. We coordinate with a shared Harper
// table (defined in schema.graphql): a worker claims the per-app record with status "building" before
// compiling, and other workers see it and wait rather than building in parallel. While building, the
// claiming worker re-stamps the record on a heartbeat so a build of any length stays fresh; a crashed
// builder's claim still goes stale (and is reclaimed) within STALE_MS. This mirrors the
// `@harperfast/nextjs` build-info pattern and works across threads and processes that share the database.

const DATABASE = 'harperfast_vite';
const TABLE = 'vite_build_info';
// While building, the claiming worker re-stamps its "building" record on this interval so a live build
// never looks abandoned, no matter how long it takes.
const HEARTBEAT_MS = 30 * 1000;
// A "building" record is treated as abandoned only once it has gone this long without a heartbeat — i.e.
// the worker holding it crashed. This bounds crash detection; it does NOT need to exceed the build
// duration, because the heartbeat keeps a live claim fresh. Must be comfortably larger than HEARTBEAT_MS
// to tolerate the event loop being busy during a build.
const STALE_MS = 2 * 60 * 1000;
const POLL_MS = 150;

/** The build-info table, or undefined when running outside Harper (e.g. unit tests). */
function buildInfoTable(): any {
	return databases?.[DATABASE]?.[TABLE];
}

/** True while another worker holds a fresh "building" claim on this app (heartbeat within STALE_MS). */
function heldByOther(info: any): boolean {
	return info?.status === 'building' && Date.now() - info.getUpdatedTime() < STALE_MS;
}

/**
 * Re-stamp the "building" claim on an interval so a live (possibly long) build never looks abandoned to
 * waiting workers. Returns a stop function that halts the heartbeat and awaits any in-flight re-stamp, so
 * the caller can then write the terminal "idle" record as the last word on the claim.
 */
function startClaimHeartbeat(table: any, key: string, scope: Scope): () => Promise<void> {
	let stopped = false;
	let timer: any;
	let inFlight: Promise<unknown> = Promise.resolve();

	function scheduleNext() {
		timer = setTimeout(beat, HEARTBEAT_MS);
		// Don't let the heartbeat timer keep the process alive on its own.
		timer.unref?.();
	}

	// Recursive setTimeout (not setInterval) so the next beat is scheduled only after the current write
	// settles — at most one re-stamp is ever in flight, so a slow write can't land after the terminal
	// record and revert the claim. Chaining off Promise.resolve() also turns a synchronous throw from
	// table.put into a caught rejection rather than an uncaught error in the timer callback.
	function beat() {
		if (stopped) return;
		inFlight = Promise.resolve()
			.then(() => table.put(key, { status: 'building' }))
			.catch((error: unknown) => log(scope, 'debug', 'build claim heartbeat failed', error))
			.finally(() => {
				if (!stopped) scheduleNext();
			});
	}

	scheduleNext();

	return async () => {
		stopped = true;
		clearTimeout(timer);
		await inFlight;
	};
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

	// If another worker is already building, wait for it. It heartbeats while building, so wait as long as
	// the claim stays fresh — however long the build takes. Stop once it finishes ("idle" → its output is
	// ready, so skip building) or its heartbeat lapses (crashed → fall through and rebuild below).
	if (heldByOther(await table.get(key))) {
		log(scope, 'debug', 'another worker is building; waiting for it to finish');
		while (true) {
			await sleep(POLL_MS);
			const info = await table.get(key);
			if (heldByOther(info)) continue;
			if (info?.status === 'idle') return;
			break;
		}
	}

	// Claim the build. Other workers will observe "building" and wait above; the heartbeat keeps the claim
	// fresh for the duration of the build.
	await table.put(key, { status: 'building' });
	const stopHeartbeat = startClaimHeartbeat(table, key, scope);
	try {
		await build();
	} finally {
		// Stop the heartbeat before writing the terminal record so no stray re-stamp can revert it to
		// "building" afterward.
		await stopHeartbeat();
		await table.put(key, { status: 'idle' });
	}
}

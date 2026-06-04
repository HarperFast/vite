/**
 * Precompute example.
 *
 * Work done at module load runs once when the component starts, not per request. Use this to
 * precompute expensive, request-independent data (build manifests, derived tables, warmed caches)
 * so requests stay fast. Here we precompute a value and expose it through a custom Resource.
 *
 * `Resource` (and `tables`, `databases`) are provided as globals to Harper jsResource modules.
 */

function fib(n) {
	return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

const precomputed = {
	// Computed once at startup rather than on every request.
	answer: fib(30),
	startedAt: new Date().toISOString(),
};

export class Build extends Resource {
	get() {
		return precomputed;
	}
}

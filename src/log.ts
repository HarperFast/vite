import type { Scope } from 'harper';

const PREFIX = '[@harperfast/vite]';

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log through Harper's scoped logger with a consistent prefix. Logger methods are optional, so this is a
 * no-op for any level the host logger doesn't implement. Note Harper's default log level is `warn`, so
 * set `logging.level` to `info` (or `debug`) to see build/rebuild diagnostics.
 */
export function log(scope: Scope, level: Level, message: string, ...args: unknown[]): void {
	scope.logger[level]?.(`${PREFIX} ${message}`, ...args);
}

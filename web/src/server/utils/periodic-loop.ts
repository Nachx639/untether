/**
 * The server's periodic loops (2026-11-11). An exception inside a timer is an uncaught
 * exception, and cli.ts stops the whole server on one: a single bad step of the orchestrator's
 * watch stopped it at least eight times in 16 hours, sessions and all. A loop's step runs
 * through here instead: what it throws (or rejects with) is caught, logged with its trace and
 * counted, and the loop goes on with its next turn. The doctor tells the count
 * (doctor-checks-machine.ts loopFailuresCheck): a loop that fails every turn is still a bug.
 *
 * `every(name, step, ms)` is setInterval with that guard; `loopStep(name, step)` guards the
 * step of a loop that arms its own timer. A raw setInterval in the server fails
 * periodic-loop.test.ts.
 */

import { createLogger } from './logger.js';

const logger = createLogger('loops');

/** The same failure of a loop is logged again only this often (a 50 ms loop would fill the log). */
const LOG_AGAIN_MS = 60_000;

export interface LoopFailure {
  name: string;
  /** Failed turns since this server started. */
  count: number;
  firstAt: number;
  lastAt: number;
  /** The last one. */
  error: string;
  stack?: string;
}

const failures = new Map<string, LoopFailure & { loggedAt: number }>();

function failed(name: string, error: unknown): void {
  const now = Date.now();
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const known = failures.get(name);
  const entry = known ?? { name, count: 0, firstAt: now, lastAt: now, error: message, loggedAt: 0 };
  const changed = entry.error !== message;
  entry.count += 1;
  entry.lastAt = now;
  entry.error = message;
  entry.stack = stack;
  failures.set(name, entry);
  if (!known || changed || now - entry.loggedAt >= LOG_AGAIN_MS) {
    entry.loggedAt = now;
    logger.error(
      `the loop "${name}" failed (${entry.count} time${entry.count === 1 ? '' : 's'}), it goes on: ${message}`
    );
    if (stack) logger.error('Stack trace:', stack);
  }
}

/**
 * `step` as a function that never throws and never leaves a rejection unhandled: a failed
 * turn is logged and counted under `name`.
 */
export function loopStep<Args extends unknown[]>(
  name: string,
  step: (...args: Args) => unknown
): (...args: Args) => void {
  return (...args) => {
    try {
      const result = step(...args);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        (result as PromiseLike<unknown>).then(undefined, (error) => failed(name, error));
      }
    } catch (error) {
      failed(name, error);
    }
  };
}

/** setInterval whose step cannot stop the server. `step` may be async: return its promise. */
export function every(name: string, step: () => unknown, ms: number): NodeJS.Timeout {
  return setInterval(loopStep(name, step), ms);
}

/** The loops that failed since this server started. */
export function loopFailures(): LoopFailure[] {
  return Array.from(failures.values(), ({ loggedAt: _loggedAt, ...failure }) => failure);
}

export function forgetLoopFailuresForTests(): void {
  failures.clear();
}

/**
 * The doctor's checks of the server process itself: its periodic loops and the times it
 * stopped on an uncaught exception.
 */

import { type CrashMark, readCrashMarks } from '../utils/crash-marks.js';
import type { LoopFailure } from '../utils/periodic-loop.js';
import { HOUR, MINUTE } from './doctor-checks-shared.js';
import type { DoctorCheck } from './untether-doctor.js';

const clock = (at: number) => new Date(at).toISOString().slice(11, 16);

/** The first frame of a trace that is the project's own code, else its first. */
function whereOf(stack: string | undefined): string {
  const frames = (stack ?? '').split('\n').filter((line) => /^\s*at /.test(line));
  const own = frames.find((line) => !/node:|node_modules/.test(line)) ?? frames[0];
  return own ? ` (${own.trim()})` : '';
}

/**
 * A periodic loop whose step threw (2026-11-11, utils/periodic-loop.ts): the loop goes on and
 * the server stays up, so without this nobody would know that the orchestrator's watch, the
 * scheduler's timer or a poll does nothing but fail. Told while it failed lately; cleared once
 * it has run clean for `windowMs`.
 */
export function loopFailuresCheck(deps: {
  failures: () => LoopFailure[];
  now?: () => number;
  windowMs?: number;
}): DoctorCheck {
  const now = deps.now ?? Date.now;
  const window = deps.windowMs ?? 30 * MINUTE;
  return {
    id: 'loop-failures',
    run() {
      return deps
        .failures()
        .filter((failure) => now() - failure.lastAt <= window)
        .map((failure) => ({
          key: `loop-failed:${failure.name}`,
          check: 'loop-failures',
          severity: 'warning' as const,
          problem: `the loop "${failure.name}" failed ${failure.count} time${failure.count === 1 ? '' : 's'} since the server started (last at ${clock(failure.lastAt)}Z): ${failure.error}${whereOf(failure.stack)}; it was caught and the loop goes on, but what it does is not being done`,
        }));
    },
  };
}

/**
 * The server stopped on an uncaught exception and was started again (2026-11-11: at least
 * eight times in 16 hours on one TypeError, and nobody saw it: every session's terminal
 * reconnects, the log starts afresh). cli.ts leaves a mark on its way out
 * (utils/crash-marks.ts); one finding per error, with how many times in the last 24 h.
 */
export function serverCrashesCheck(deps: {
  marks?: () => CrashMark[];
  file?: () => string;
  now?: () => number;
  windowMs?: number;
}): DoctorCheck {
  const now = deps.now ?? Date.now;
  const window = deps.windowMs ?? 24 * HOUR;
  const read = deps.marks ?? (() => (deps.file ? readCrashMarks(deps.file()) : []));
  return {
    id: 'server-crashes',
    run() {
      const byError = new Map<string, CrashMark[]>();
      for (const mark of read()) {
        const at = Date.parse(mark.at);
        if (!Number.isFinite(at) || now() - at > window) continue;
        byError.set(mark.error, [...(byError.get(mark.error) ?? []), mark]);
      }
      return Array.from(byError.entries()).map(([error, marks]) => {
        const last = marks[marks.length - 1];
        const hours = Math.round(window / HOUR);
        return {
          key: `server-crashed:${error.slice(0, 160)}`,
          check: 'server-crashes',
          severity: 'critical' as const,
          problem: `the server stopped ${marks.length} time${marks.length === 1 ? '' : 's'} in the last ${hours} h on an uncaught exception (${last.kind}, last at ${last.at}): ${error}${whereOf(last.stack)}`,
        };
      });
    },
  };
}

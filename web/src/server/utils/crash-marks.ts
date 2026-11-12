/**
 * The mark a server leaves when it stops on an uncaught exception (2026-11-11: it stopped at
 * least eight times in 16 hours on the same one, was started again each time, and nobody knew:
 * the log starts afresh with each server, so the only trace went with it). cli.ts writes one
 * line here before it exits; the next server's doctor reads them (doctor-checks-machine.ts
 * serverCrashesCheck) and says how many times it stopped in the last 24 h and on what.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Kept in the file: the newest. */
export const CRASH_MARKS_MAX = 200;

export interface CrashMark {
  at: string;
  kind: 'uncaughtException' | 'unhandledRejection';
  /** "TypeError: Cannot read properties of undefined (reading 'messages')". */
  error: string;
  /** The first lines of its trace. */
  stack?: string;
  pid: number;
}

/** Next to the server's log (~/.untether/crashes.jsonl for the real one). */
export function crashMarksFile(logFile: string): string {
  return path.join(path.dirname(logFile), 'crashes.jsonl');
}

export function crashMarkOf(
  kind: CrashMark['kind'],
  reason: unknown,
  now: number = Date.now()
): CrashMark {
  const error =
    reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? 'unknown');
  const stack =
    reason instanceof Error && reason.stack
      ? reason.stack
          .split('\n')
          .filter((line) => /^\s+at /.test(line))
          .slice(0, 6)
          .map((line) => line.trim())
          .join('\n')
      : undefined;
  return {
    at: new Date(now).toISOString(),
    kind,
    error: error.slice(0, 500),
    ...(stack ? { stack } : {}),
    pid: process.pid,
  };
}

export function readCrashMarks(file: string): CrashMark[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const marks: CrashMark[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const mark = JSON.parse(line) as Partial<CrashMark>;
      if (typeof mark.at === 'string' && typeof mark.error === 'string') {
        marks.push(mark as CrashMark);
      }
    } catch {
      // A line cut short by the exit itself: the others still count.
    }
  }
  return marks;
}

/**
 * Written while the process is going down: synchronous, and never throws (failing to leave
 * the mark must not hide the exception that is being reported).
 */
export function recordCrash(file: string, mark: CrashMark): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const kept = readCrashMarks(file).slice(-(CRASH_MARKS_MAX - 1));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${[...kept, mark].map((entry) => JSON.stringify(entry)).join('\n')}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch {
    // Nothing more to do on the way out.
  }
}

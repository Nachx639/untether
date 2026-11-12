/** Constants and free helpers of PtyManager (pty-manager.ts). */

import * as fs from 'fs';
import * as path from 'path';
import type { Session } from '../../../shared/types.js';
import { createLogger } from '../../utils/logger.js';
import type { PtySession } from '../types.js';

export const logger = createLogger('pty-manager');

/** How far back a Mac-window session's recording is read for its size at most (each look). */
export const SIZE_SEED_LOOKBACK_BYTES = 16 * 1024 * 1024;
/** How often page-owned Mac-window sessions are checked for an owner gone away (sweepSizeOwners). */
export const SIZE_SWEEP_INTERVAL_MS = 15_000;
/** A shielded session whose tmux can't be reached is attached again after this long. */
export const SHIELD_REATTACH_RETRY_MS = 5 * 60_000;
/** Input typed while a shielded session re-attaches waits this long, up to this many chars. */
export const SHIELD_INPUT_QUEUE_MS = 30_000;
export const SHIELD_INPUT_QUEUE_MAX = 64 * 1024;
// Foreground process tracking constants
export const PROCESS_POLL_INTERVAL_MS = 500; // How often to check foreground process
/** A session with terminal input or output this recently is polled every tick. */
export const FOREGROUND_ACTIVE_MS = 5000;
/**
 * A session running a command that prints all the time (Claude's TUI) but got no input lately
 * is polled this often: only the command's end can come, and it is told after 3 s anyway.
 */
export const FOREGROUND_BUSY_POLL_MS = 2000;
/** A quiet session is polled this often. */
export const FOREGROUND_IDLE_POLL_MS = 15_000;

/**
 * Whether the foreground poll looks at `session` now (2026-11-02): every tick after input (a
 * command starts after input), or after output at the shell; every 2 s while a command runs
 * and prints; every 15 s when the terminal is quiet. Exported for tests.
 */
export function foregroundPollDue(
  session: Pick<
    PtySession,
    | 'lastOutputTimestamp'
    | 'lastInputTimestamp'
    | 'lastForegroundPollAt'
    | 'shellPgid'
    | 'currentForegroundPgid'
  >,
  now: number
): boolean {
  const since = now - (session.lastForegroundPollAt ?? 0);
  if (now - (session.lastInputTimestamp ?? 0) < FOREGROUND_ACTIVE_MS) return true;
  if (now - (session.lastOutputTimestamp ?? 0) < FOREGROUND_ACTIVE_MS) {
    const commandRuns =
      session.shellPgid !== undefined && session.currentForegroundPgid !== session.shellPgid;
    return !commandRuns || since >= FOREGROUND_BUSY_POLL_MS;
  }
  return since >= FOREGROUND_IDLE_POLL_MS;
}
export const MIN_COMMAND_DURATION_MS = 3000; // Minimum duration for command completion notifications (3 seconds)
export const SHELL_COMMANDS = new Set(['cd', 'ls', 'pwd', 'echo', 'export', 'alias', 'unset']); // Built-in commands to ignore

/**
 * 2026-10-18: building the Mac app rebuilds node-pty in the node_modules a dev server runs
 * from; for those seconds its spawn-helper is missing and every new session failed with
 * "posix_spawnp failed". That error is retried for up to 10 s before it is reported.
 */
export async function spawnRetrying<T>(
  spawn: () => T,
  { attempts = 6, delayMs = 2000 }: { attempts?: number; delayMs?: number } = {}
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return spawn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || !message.includes('posix_spawnp failed')) throw error;
      logger.warn(`spawn failed (${message}), retrying in ${delayMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Exited sessions "clean up exited" keeps: one whose Claude conversation or Codex thread can
 * be resumed ("Resume" lives on the exited session), and shielded ones whose tmux was lost or whose
 * restore failed (the next start may bring them back, and they tell why they ended).
 *
 * 2026-10-20: the Mac app called the cleanup on every server start, crash restarts included,
 * and deleted them: no "Resume Claude" after a crash, and tasks lost the session they resume.
 */
export function keptByExitedCleanup(
  session: Pick<Session, 'claudeSessionId' | 'codexThreadId' | 'shieldEnd' | 'shielded'>
): boolean {
  return exitedCleanupKeepReason(session) !== null;
}

/**
 * Why "clean up exited" keeps a session (see keptByExitedCleanup); `task` is a session an open
 * task or an orchestrator still needs (the route's `keep`).
 */
export type ExitedKeepReason = 'claude' | 'codex' | 'shielded' | 'task';

export function exitedCleanupKeepReason(
  session: Pick<Session, 'claudeSessionId' | 'codexThreadId' | 'shieldEnd' | 'shielded'>
): Exclude<ExitedKeepReason, 'task'> | null {
  if (session.claudeSessionId) return 'claude';
  if (session.codexThreadId) return 'codex';
  return session.shieldEnd === 'restore-failed' || session.shieldEnd === 'tmux-lost'
    ? 'shielded'
    : null;
}

/**
 * Why a spawn failed, when the cause can be told (2026-10-20: "posix_spawnp failed" for two
 * minutes while a dependency update had removed node-pty's build; nobody could tell why).
 */
export function spawnFailureHint(message: string, exists = fs.existsSync): string {
  if (!/posix_spawn/i.test(message)) return '';
  try {
    const dir = path.dirname(require.resolve('node-pty/package.json'));
    if (!exists(path.join(dir, 'build', 'Release', 'spawn-helper'))) {
      return " (node-pty's spawn-helper is missing: run `node scripts/ensure-native-modules.js` in web/)";
    }
  } catch {
    // node-pty not resolvable from here: no hint
  }
  return '';
}

/** node-pty, loaded by PtyManager.initialize() (a live binding for every module that uses it). */
export let pty: typeof import('node-pty');

export function setPty(loaded: typeof import('node-pty')): void {
  pty = loaded;
}

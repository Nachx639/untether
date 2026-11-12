/**
 * Restarts idle Claude Code sessions that run an older version than the one installed.
 *
 * 2026-10-31: the user keeps shielded (tmux) Claude sessions open for days, ready to use. Claude
 * Code updates itself on disk and shows "Update installed · /restart to apply", but those
 * sessions stayed on the old version indefinitely: nobody types /restart into a session that
 * is just waiting. With the user's `restartUpdatedClaude` setting on (off by default), each
 * session whose Claude started as an older version than the installed one (its own
 * `sessions/<pid>.json` says the version it started as) is restarted once it has been idle
 * for a while, nobody typed into it and nothing on its screen would be lost:
 *
 * - Claude's own `/restart` first (2.1.316 tried by hand: same pid, `--resume` of the same
 *   conversation, model and permission flags kept), so the Untether session, its role
 *   (orchestrator, task) and its titles stay as they are. Typed only when Claude's command menu
 *   offers it; else the line is cleared again.
 * - Without it, the session is reopened as Blindar does (`claude --resume` of its conversation
 *   with its flags, the stores following through SessionReplacements), when its program is one
 *   Untether runs (not a terminal window's, not a nested tmux).
 *
 * One session at a time, never under load, and at most one attempt per conversation and target
 * version (kept on disk): a restart that fails is logged and not tried again for that version.
 * Codex has no equivalent: its CLI is updated by its installer and has no in-place restart.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CELL_ATTR } from '../../shared/terminal-text-formatter.js';
import type { ClaudeStatus } from './claude-chat.js';

/** Claude has been idle at its prompt this long (its own statusUpdatedAt) before a restart. */
export const RESTART_IDLE_MS = 2 * 60_000;
/** No client typed into the session for this long. */
export const RESTART_QUIET_INPUT_MS = 2 * 60_000;
/** How long the restarted Claude has to report the new version. */
export const RESTART_CONFIRM_MS = 90_000;
/** Attempts older than this are forgotten (a conversation still open by then is a new case). */
const ATTEMPT_TTL_MS = 30 * 24 * 60 * 60_000;

/** "2.1.316 (Claude Code)" → "2.1.316". */
export function parseClaudeVersion(output: string | undefined): string | undefined {
  const match = output?.trim().match(/^v?(\d+(?:\.\d+)+)/);
  return match ? match[1] : undefined;
}

/** -1, 0 or 1 comparing dotted numeric versions ("2.1.310" < "2.1.316"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** A terminal cell as the buffer snapshot gives it (FAINT is 0x08, INVISIBLE 0x20). */
export interface ScreenCell {
  char: string;
  attributes?: number;
}

const { DIM: FAINT, INVISIBLE } = CELL_ATTR;

/**
 * Whether Claude's input box holds text the user wrote: its last `❯` row has a visible
 * character after the `❯` that is not drawn faint (its placeholder, `Try "…"`, and its prompt
 * suggestions are faint; a real draft is not). undefined: no input box on screen, nothing can
 * be told (a full-screen dialog, another program).
 */
export function claudeInputDraft(rows: ScreenCell[][]): boolean | undefined {
  for (let y = rows.length - 1; y >= 0; y--) {
    const row = rows[y];
    const at = row.findIndex((cell) => cell.char === '❯');
    if (at < 0) continue;
    // Only leading blanks before it: a ❯ inside some text is not the prompt.
    if (row.slice(0, at).some((cell) => cell.char.trim() !== '')) continue;
    return row
      .slice(at + 1)
      .some(
        (cell) =>
          cell.char.replace(/\s/g, '') !== '' &&
          ((cell.attributes ?? 0) & (FAINT | INVISIBLE)) === 0
      );
  }
  return undefined;
}

/** Claude Code's own update line ("Update installed · /restart to apply") on the screen. */
export function updateNoticeOnScreen(text: string): {
  installed: boolean;
  restartCommand: boolean;
} {
  const installed = /Update installed/.test(text);
  return { installed, restartCommand: installed && /\/restart\b/.test(text) };
}

/** Claude's command menu, after typing "/restart", offers it ("/restart  Restart Claude …"). */
export function restartCommandOffered(text: string): boolean {
  return text.split('\n').some((line) => /^\s*(?:❯\s*)?\/restart\s{2,}\S/.test(line));
}

export interface RestartableSession {
  id: string;
  status: string;
  lastInputTimestamp?: number;
}

export interface SessionScreenLook {
  /** Text the user wrote sits in Claude's input box (undefined: no input box seen). */
  draft: boolean | undefined;
  /** A menu or question of Claude's is on screen (readScreenChoices). */
  menu: boolean;
  /** Claude's "Update installed" line is on screen. */
  updateNotice: boolean;
}

export type RestartResult =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      error: string /** Nothing was touched: the next way may be tried. */;
      untouched?: boolean;
    };

/** What the session routes do for it (routes/sessions.ts exposeClaudeRestart). */
export interface ClaudeRestartActions {
  inPlace: (sessionId: string) => Promise<RestartResult>;
  reopen: (sessionId: string) => Promise<RestartResult>;
  screen: (sessionId: string) => Promise<SessionScreenLook | undefined>;
  claudeStatus: (sessionId: string) => Promise<ClaudeStatus | undefined>;
}

export interface ClaudeUpdateRestartDeps {
  enabled: () => boolean;
  installedVersion: () => Promise<string | undefined>;
  sessions: () => RestartableSession[];
  claudeStatus: (sessionId: string) => Promise<ClaudeStatus | undefined>;
  screen: (sessionId: string) => Promise<SessionScreenLook | undefined>;
  /** Why the session must stay as it is now (a task checking or merging on it), or null. */
  heldBy: (sessionId: string) => string | null;
  /** The Mac has room for it (load); false skips this look. */
  loadOk: () => boolean;
  /** Claude's own /restart, typed only when its menu offers it ({untouched} otherwise). */
  restartInPlace: (sessionId: string) => Promise<RestartResult>;
  /** Reopen as Blindar does (claude --resume in a new session; the stores follow). */
  reopen?: (sessionId: string) => Promise<RestartResult>;
  /** The session shows "updated to X". */
  markUpdated: (sessionId: string, from: string | undefined, to: string) => void;
  statePath: string;
  log: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  confirmMs?: number;
}

interface Attempt {
  at: number;
  ok: boolean;
  from?: string;
  error?: string;
}

export class ClaudeUpdateRestarter {
  private running = false;
  private attempts: Record<string, Attempt> | null = null;

  constructor(private readonly deps: ClaudeUpdateRestartDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private loadAttempts(): Record<string, Attempt> {
    if (this.attempts) return this.attempts;
    let loaded: Record<string, Attempt> = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.statePath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) loaded = raw;
    } catch {
      // First run, or a broken file: start empty.
    }
    const cutoff = this.now() - ATTEMPT_TTL_MS;
    for (const [key, attempt] of Object.entries(loaded)) {
      if (typeof attempt?.at !== 'number' || attempt.at < cutoff) delete loaded[key];
    }
    this.attempts = loaded;
    return loaded;
  }

  private saveAttempt(key: string, attempt: Attempt): void {
    const attempts = this.loadAttempts();
    attempts[key] = attempt;
    try {
      fs.mkdirSync(path.dirname(this.deps.statePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.deps.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(attempts, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.deps.statePath);
    } catch (error) {
      (this.deps.warn ?? this.deps.log)(`claude update restarts not saved: ${error}`);
    }
  }

  /** Whether a restart of this conversation to `version` was tried already. */
  tried(conversation: string, version: string): boolean {
    return this.loadAttempts()[`${conversation}@${version}`] !== undefined;
  }

  /** One look: restarts at most one session. The session id it restarted, if any. */
  async tick(): Promise<string | null> {
    if (this.running || !this.deps.enabled()) return null;
    this.running = true;
    try {
      return await this.look();
    } finally {
      this.running = false;
    }
  }

  private async look(): Promise<string | null> {
    if (!this.deps.loadOk()) return null;
    const installed = await this.deps.installedVersion().catch(() => undefined);
    const now = this.now();
    for (const session of this.deps.sessions()) {
      if (session.status !== 'running') continue;
      if (
        typeof session.lastInputTimestamp === 'number' &&
        now - session.lastInputTimestamp < RESTART_QUIET_INPUT_MS
      ) {
        continue;
      }
      const claude = await this.deps.claudeStatus(session.id).catch(() => undefined);
      const conversation = claude?.sessionId;
      if (!claude || !conversation) continue;
      // Idle at its prompt for a while; background agents or shells it still runs would die.
      if (claude.status !== 'idle' || claude.waitingForBackground) continue;
      if (typeof claude.since !== 'number' || now - claude.since < RESTART_IDLE_MS) continue;
      const behind =
        !!installed && !!claude.version && compareVersions(claude.version, installed) < 0;
      // Its version unknown (an older Claude's session file): its own update line decides.
      if (!behind && claude.version) continue;
      if (this.deps.heldBy(session.id)) continue;
      const screen = await this.deps.screen(session.id).catch(() => undefined);
      if (!screen) continue;
      if (!behind && !screen.updateNotice) continue;
      const target = installed ?? 'latest';
      if (this.tried(conversation, target)) continue;
      // Nothing on screen may be lost: a draft (or no input box seen), a menu or a question.
      if (screen.draft !== false || screen.menu) continue;
      await this.restart(session.id, conversation, claude.version, target);
      return session.id;
    }
    return null;
  }

  private async restart(
    sessionId: string,
    conversation: string,
    from: string | undefined,
    to: string
  ): Promise<void> {
    const key = `${conversation}@${to}`;
    const label = `session ${sessionId} (Claude ${from ?? 'unknown'} → ${to})`;
    // Recorded before anything is typed: a server restart midway never tries it twice.
    this.saveAttempt(key, { at: this.now(), ok: false, from, error: 'in progress' });
    let result = await this.deps
      .restartInPlace(sessionId)
      .catch((error): RestartResult => ({ ok: false, error: String(error) }));
    let how = '/restart';
    if (!result.ok && result.untouched && this.deps.reopen) {
      how = 'reopen';
      result = await this.deps
        .reopen(sessionId)
        .catch((error): RestartResult => ({ ok: false, error: String(error) }));
    }
    if (result.ok) {
      const confirmed = await this.confirm(result.sessionId, to);
      if (confirmed.ok) {
        this.saveAttempt(key, { at: this.now(), ok: true, from });
        this.deps.markUpdated(result.sessionId, from, confirmed.version);
        this.deps.log(
          `claude update restart: ${label} restarted via ${how}${result.sessionId === sessionId ? '' : ` as ${result.sessionId}`}, now on ${confirmed.version}`
        );
        return;
      }
      result = { ok: false, error: confirmed.error };
    }
    this.saveAttempt(key, { at: this.now(), ok: false, from, error: result.error });
    (this.deps.warn ?? this.deps.log)(
      `claude update restart: ${label} failed via ${how}: ${result.error}; not tried again for ${to}`
    );
  }

  /** The restarted Claude reports a version (the target, when one is known). */
  private async confirm(
    sessionId: string,
    to: string
  ): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
    const sleep = this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = this.now() + (this.deps.confirmMs ?? RESTART_CONFIRM_MS);
    let last: string | undefined;
    while (this.now() < deadline) {
      await sleep(2000);
      const session = this.deps.sessions().find((candidate) => candidate.id === sessionId);
      if (session && session.status !== 'running') {
        return { ok: false, error: 'the session ended while restarting' };
      }
      const claude = await this.deps.claudeStatus(sessionId).catch(() => undefined);
      last = claude?.version;
      if (last && (to === 'latest' || compareVersions(last, to) >= 0)) {
        return { ok: true, version: last };
      }
    }
    return {
      ok: false,
      error: last ? `Claude still reports ${last}` : 'Claude did not come back in time',
    };
  }
}

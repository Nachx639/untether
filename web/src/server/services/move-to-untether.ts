/**
 * "Llevar a Untether" (2026-10-25): a Claude session opened with `ut claude` in a terminal
 * window (isForwardedSession) moves into a shielded Untether session. User report: "¿se puede
 * mover la terminal de bakery orquestador que tengo abierta en el Mac y que quede solo
 * abierta en Untether?"; Blindar answered 409 "Session runs in a terminal window".
 *
 * The shield route does the move (routes/sessions.ts): it refuses while Claude works or waits
 * for an answer unless the user confirms, ends the program through the forwarder's control
 * socket (the clean Kill, FORWARDER_CLOSE_GRACE_MS), resumes the same conversation shielded
 * with its titles, and every store keyed by session id follows through SessionReplacements.
 * This module holds what is left of the window: a line saying where the session went, and the
 * window closed when it is nothing but that idle shell.
 *
 * 2026-10-25, first real move: "window of session fwd_…: notice not written, unavailable". The
 * server wrote the line into the window's tty 700 ms after the Kill, but `ut` exits 166 on a
 * close from Untether and the user's zsh `claude()` wrapper then exits its shell: the tab was
 * already gone, and "unavailable" hid that it had closed. Now the Kill carries the line and
 * the forwarder writes it after the program's last frame, before `ut` returns (ut-fwd
 * window_notice, recorded as windowNoticeWritten); the server writes it only for a forwarder
 * that did not (one started before that), and a tab that is gone reads "gone".
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import type { ClaudeStatus } from './claude-chat.js';
import type { OsascriptOutcome, OsascriptScript } from './mac-sessions/osascript.js';
import { closeIdleArgs, parseCloseIdle } from './mac-sessions/terminal-scripts.js';

const execFileAsync = promisify(execFile);

/** Longest notice written into the window. */
const NOTICE_MAX_LENGTH = 300;

/**
 * Why Claude can't be moved without asking: it works ("busy", also while only background
 * agents run, they would end with it) or waits for an answer ("waiting"). Null when idle, or
 * when its status can't be read (nothing then to interrupt that Untether knows of).
 */
export function claudeAtWork(status: ClaudeStatus | undefined): string | null {
  if (!status || status.status === 'idle') return null;
  return status.status;
}

/**
 * The line left in the window, as the page wrote it in the user's language; one line of
 * printable text (no escape sequence reaches the terminal), else an English default.
 */
export function windowNoticeText(raw: unknown, name: string): string {
  const fallback = `Untether: this session continues in Untether${name ? ` («${name}»)` : ''}.`;
  if (typeof raw !== 'string') return fallback;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what goes
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return text ? text.slice(0, NOTICE_MAX_LENGTH) : fallback;
}

/** The terminal device of `pid` ("/dev/ttys003"), null when it has none or is gone. */
export async function ttyOfPid(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'tty=', '-p', String(pid)], {
      timeout: 5000,
    });
    const tty = stdout.trim();
    return /^tty[A-Za-z0-9]{1,16}$/.test(tty) ? `/dev/${tty}` : null;
  } catch {
    return null;
  }
}

export type CloseWindowResult =
  | 'closed'
  /** The tab closed on its own: its shell ended with `ut` (a wrapper exits on its code 166). */
  | 'gone'
  /** The tab has other tabs beside it, or a program runs in it: left open. */
  | 'kept'
  | 'not-found'
  /** The app can't be scripted from here (not Terminal or iTerm, Automation refused, a hang). */
  | 'unavailable';

export interface LeaveWindowDeps {
  /** Writes to the window's terminal device (fs.writeFileSync unless given). */
  writeTty?: (tty: string, text: string) => void;
  /** Whether the window's terminal can still be opened, i.e. its tab is open. */
  ttyOpen?: (tty: string) => boolean;
  /** Closes the window of that tty when it holds nothing else (server.ts: AppleScript). */
  closeWindow?: (app: string, tty: string) => Promise<CloseWindowResult>;
  /** Waits before looking: the window's shell prints its prompt (or exits) once `ut` returned. */
  delay?: (ms: number) => Promise<void>;
  /** Its forwarder has ended (it writes the notice, then its exit, then ends). */
  forwarderEnded?: () => boolean;
  /** Its forwarder wrote the notice the Kill carried (session.json windowNoticeWritten). */
  forwarderWroteNotice?: () => boolean;
}

/** Who put the notice in the window. */
export type WindowNoticeWriter = 'forwarder' | 'server' | 'none';

/** Longest wait for the forwarder to end after its program did (it flushes for up to 1 s). */
const FORWARDER_END_WAIT_MS = 3000;

function ttyCanBeOpened(tty: string): boolean {
  try {
    const { O_WRONLY, O_NOCTTY, O_NONBLOCK } = fs.constants;
    fs.closeSync(fs.openSync(tty, O_WRONLY | O_NOCTTY | O_NONBLOCK));
    return true;
  } catch {
    return false;
  }
}

/**
 * What is left of the window once its program ended: the notice (unless its forwarder wrote
 * it), then the window closed when that is possible. Never throws; says what it did.
 */
export async function leaveTerminalWindow(
  window: { tty: string; app: string | null; notice: string },
  deps: LeaveWindowDeps = {}
): Promise<{ notice: WindowNoticeWriter; closed: CloseWindowResult }> {
  const writeTty = deps.writeTty ?? ((tty, text) => fs.writeFileSync(tty, text));
  const ttyOpen = deps.ttyOpen ?? ttyCanBeOpened;
  const delay = deps.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (deps.forwarderEnded) {
    for (let waited = 0; !deps.forwarderEnded() && waited < FORWARDER_END_WAIT_MS; waited += 100) {
      await delay(100);
    }
  }
  await delay(700);
  let notice: WindowNoticeWriter = deps.forwarderWroteNotice?.() ? 'forwarder' : 'none';
  if (!ttyOpen(window.tty)) return { notice, closed: 'gone' };
  if (notice === 'none') {
    try {
      writeTty(window.tty, `\r\n\u001b[1m${window.notice}\u001b[0m\r\n`);
      notice = 'server';
    } catch {
      if (!ttyOpen(window.tty)) return { notice, closed: 'gone' };
    }
  }
  let closed: CloseWindowResult = 'unavailable';
  if (window.app && deps.closeWindow) {
    closed = await deps.closeWindow(window.app, window.tty).catch(() => 'unavailable' as const);
  }
  return { notice, closed };
}

/**
 * Closes the window of `tty` in `app` (Terminal or iTerm2) through the osascript runner when
 * it is that tab alone with nothing but its shell (terminal-scripts.ts *_CLOSE_IDLE).
 */
export async function closeIdleTerminalWindow(
  run: (app: string, script: OsascriptScript, args: string[]) => Promise<OsascriptOutcome>,
  app: string,
  tty: string
): Promise<CloseWindowResult> {
  const call = closeIdleArgs(app, tty);
  if (!call) return 'unavailable';
  const outcome = await run(app, call.script, call.args);
  if (outcome.kind !== 'ok') {
    const gone =
      outcome.kind === 'error' && (outcome.error === 'gone' || outcome.error === 'not-running');
    return gone ? 'not-found' : 'unavailable';
  }
  const result = parseCloseIdle(outcome.stdout);
  return result === 'unparsable' ? 'unavailable' : result;
}

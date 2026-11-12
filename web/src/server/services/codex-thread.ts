/**
 * Which Codex thread a session runs, so an exited session offers "Resume" (`codex resume <id>`)
 * and Blindar reopens it on its conversation, as with Claude (claude-session-id.ts).
 *
 * Checked with Codex 0.164 (2026-11-10, a throwaway CODEX_HOME and a local stand-in model):
 * - `codex resume <id>` writes on in the thread's first rollout: one file per thread, named
 *   after it, however often it is resumed.
 * - The rollout is written by Codex's app-server daemon, shared by every TUI of that
 *   CODEX_HOME; it holds `thread-writer-locks/<id>.lock` and outlives the TUI. So a thread
 *   has one writer of its file by Codex's own design, and neither the lock nor the open file
 *   says which TUI shows a thread: a second `codex resume <id>` next to a live one attaches
 *   to the same thread and both type into it. Untether keeps one session per thread itself.
 * - `/rename` (and Codex's own naming) appends `{id, thread_name}` to session_index.jsonl.
 * - A Codex makes its thread as it starts (the thread id and the rollout carry that time);
 *   the rollout file appears with the first prompt.
 * - As it quits, Codex prints "To reconnect, run: codex resume <id>"; killed, it prints nothing.
 * - Nothing on disk or in the process table links a TUI to its thread (the daemon's log only
 *   names the daemon).
 *
 * Which thread a session's Codex is on, from the surest to the least sure:
 * 1. the one its command resumes (`codex resume <id>`): exact;
 * 2. the one Codex named as it quit, read from the end of the session's recording: exact;
 * 3. while it runs otherwise, the rollout started in its folder since it started (its chat is
 *    read from the same match, codex-chat.ts). With another Codex in the folder, only the
 *    first rollout made after its start and before the next one's (findCodexRolloutAmong).
 *    A guess: wrong if two Codex start in one folder within the seconds one takes to start,
 *    or if a `/new` in an older one falls between a newer one's start and its first prompt.
 *    What Codex says as it quits corrects it. A `/new` inside a resumed Codex, or with
 *    another Codex in the folder, is not followed.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Session } from '../../shared/types.js';
import { createLogger } from '../utils/logger.js';
import { every } from '../utils/periodic-loop.js';
import { type ProcessTable, readProcessTable } from './claude-chat.js';
import {
  type CodexSessionRef,
  codexRolloutFirstPrompt,
  codexRolloutOrigin,
  defaultCodexDir,
  findCodexRolloutAmong,
  findCodexRolloutById,
} from './codex-chat.js';
import {
  CODEX_INLINE_FLAG,
  codexResumeTarget,
  codexSessionRef,
  isCodexProcessArgs,
  isCodexThreadId,
  parseUtcStart,
  processCwd,
} from './codex-process.js';

const logger = createLogger('codex-thread');

const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Codex thread id from its rollout file name (`rollout-<time>-<uuid>.jsonl`). */
export function codexIdFromRollout(rolloutPath: string | null | undefined): string | null {
  return rolloutPath?.match(ROLLOUT_ID)?.[1]?.toLowerCase() ?? null;
}

/** Whether the command starts Codex itself (`codex …`, `/opt/bin/codex …`), not a shell around it. */
export function startsCodex(command: readonly string[] | undefined): boolean {
  return path.basename(command?.[0] ?? '') === 'codex';
}

/** Options that pick or start another conversation, or only list: never carried. */
const DROPPED = new Set([
  '--last',
  '--all',
  '--include-non-interactive',
  '-h',
  '--help',
  '-V',
  '--version',
]);
/** …the same, taking every following word that isn't an option (the first prompt's images). */
const DROPPED_VARIADIC = new Set(['-i', '--image']);
/** …and with a value only when one follows. */
const DROPPED_OPTIONAL = new Set(['--worktree']);
/** Options with a value of their own (`codex resume --help`, 0.164). */
const WITH_VALUE = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
  '-m',
  '--model',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-C',
  '--cd',
  '--add-dir',
  '-a',
  '--ask-for-approval',
]);
/** Options without a value; any other `--flag word` is kept as a flag and its value. */
const BOOLEAN = new Set([
  '--strict-config',
  '--oss',
  '--approve-for-me',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--search',
  '--no-daemon',
  '--yolo',
  '--full-auto',
  CODEX_INLINE_FLAG,
]);

/**
 * The options of a Codex command line (the words after the executable) a resume keeps: all
 * but the subcommand and thread it had, the prompt (typed once, never again), its images and
 * the options that pick another conversation. `codex resume` takes the same options as
 * `codex` (0.164), so they go after the thread. The argv is exact (the server started it).
 */
export function carriedCodexArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break; // The rest is the prompt.
    if (!arg.startsWith('-')) continue; // `resume`, its thread, or the prompt.
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const next = args[i + 1];
    const takesNext = next !== undefined && !next.startsWith('-');
    if (DROPPED.has(name)) continue;
    if (DROPPED_OPTIONAL.has(name)) {
      if (eq < 0 && takesNext) i++;
      continue;
    }
    if (DROPPED_VARIADIC.has(name)) {
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (eq > 0 || BOOLEAN.has(name)) {
      kept.push(arg);
    } else if (WITH_VALUE.has(name)) {
      if (next !== undefined) kept.push(arg, args[++i]);
    } else if (
      takesNext &&
      name.startsWith('--') &&
      next !== 'resume' &&
      next !== 'fork' &&
      !isCodexThreadId(next)
    ) {
      // An option this list does not know (a newer Codex), with what looks like its value.
      kept.push(arg, args[++i]);
    } else {
      kept.push(arg);
    }
  }
  return kept;
}

/**
 * The command that carries a session's Codex on in `threadId`: its own executable and options
 * (model, sandbox, `-c` overrides…) with `resume <id>`. Only for a command that starts Codex
 * itself (startsCodex).
 */
export function codexResumeCommand(command: readonly string[], threadId: string): string[] {
  return [command[0], 'resume', threadId, ...carriedCodexArgs(command.slice(1))];
}

let indexCache: { file: string; mtimeMs: number; size: number; names: Map<string, string> } | null =
  null;

/** The name Codex (or the user, with `/rename`) gave a thread: session_index.jsonl, last entry wins. */
export function codexThreadName(
  threadId: string,
  codexDir = defaultCodexDir()
): string | undefined {
  const file = path.join(codexDir, 'session_index.jsonl');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (
    !indexCache ||
    indexCache.file !== file ||
    indexCache.mtimeMs !== stat.mtimeMs ||
    indexCache.size !== stat.size
  ) {
    const names = new Map<string, string>();
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
          if (typeof entry.id !== 'string') continue;
          const name = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : '';
          if (name) names.set(entry.id.toLowerCase(), name);
          else names.delete(entry.id.toLowerCase());
        } catch {
          // A line being written, or not JSON: skipped.
        }
      }
    } catch {
      return undefined;
    }
    indexCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, names };
  }
  return indexCache.names.get(threadId.toLowerCase());
}

/**
 * The title of a Codex thread: its name, else its first prompt. It belongs to the thread, so
 * a session that resumes it shows the same one, and an ended session keeps it.
 */
export function codexThreadTitle(
  threadId: string,
  codexDir = defaultCodexDir()
): string | undefined {
  const name = codexThreadName(threadId, codexDir);
  if (name) return name;
  const rollout = findCodexRolloutById(codexDir, threadId);
  return rollout ? codexRolloutFirstPrompt(rollout) : undefined;
}

/** Whether a thread's rollout is still there to resume. */
export function codexThreadExists(threadId: string, codexDir = defaultCodexDir()): boolean {
  return findCodexRolloutById(codexDir, threadId) !== null;
}

export interface LiveCodexDeps {
  table: () => Promise<Pick<ProcessTable, 'args' | 'starts'>>;
  cwdOf: (pid: number) => Promise<string | null>;
  codexDir: () => string;
}

const liveDefaults: LiveCodexDeps = {
  // Read now, not the table shared for a couple of seconds: a Codex opened a moment ago counts.
  table: readProcessTable,
  cwdOf: processCwd,
  codexDir: defaultCodexDir,
};

/** A Codex makes its thread this long after it starts, at most (the first one starts the daemon). */
const THREAD_AFTER_START_MS = 30_000;

/**
 * The pid of an interactive Codex on this computer that shows `threadId`, in or outside
 * Untether (a Terminal tab, a tmux pane). Asked before an ended session's thread is resumed:
 * a second TUI would attach to the same thread and both would type into it. Two ways in:
 * - one started as `codex resume <threadId>`: exact;
 * - one started without `resume`, in the thread's folder, moments before the thread was made:
 *   the Codex that made it and still runs (2026-11-10 review: only resumes were seen). Two
 *   Codex started there within those moments both count, which only refuses a resume.
 * Not seen: a thread picked in another Codex's own `/resume` list (nothing outside that Codex
 * says which thread it shows; its daemon is then the one writer of the file all the same).
 */
export async function liveCodexThreadPid(
  threadId: string,
  deps: Partial<LiveCodexDeps> = {}
): Promise<number | null> {
  const { table, cwdOf, codexDir } = { ...liveDefaults, ...deps };
  const wanted = threadId.toLowerCase();
  const processes = await table();
  const rollout = findCodexRolloutById(codexDir(), wanted);
  const origin = rollout ? codexRolloutOrigin(rollout) : null;
  for (const [pid, args] of processes.args) {
    if (!isCodexProcessArgs(args)) continue;
    const resumed = codexResumeTarget(args.trim().split(/\s+/));
    if (resumed === wanted) return pid;
    if (resumed || !origin) continue;
    const startedAt = parseUtcStart(processes.starts.get(pid));
    if (startedAt === undefined) continue;
    const after = origin.startedAt - startedAt;
    if (after < -2000 || after > THREAD_AFTER_START_MS) continue;
    const cwd = await cwdOf(pid);
    if (cwd && realFolder(cwd) === origin.cwd) return pid;
  }
  return null;
}

/** How much of the end of a session's recording is read for Codex's parting words. */
const EXIT_HINT_TAIL_BYTES = 8 * 1024;
/** What Codex prints after the command, at most (how to stop the turn, the token usage). */
const EXIT_HINT_TRAILER_MAX = 600;

/**
 * The thread Codex names as it quits ("To reconnect, run: codex resume <id>", Codex 0.164;
 * "To continue this session, run codex resume <id>" before), from the end of a session's
 * recording. Only Codex's own parting words count (2026-11-10 review: any "codex resume <id>"
 * in the last output did, also one a command or the conversation printed in a session that
 * was then killed): its sentence right before the command, and nothing after it but its
 * short trailer and the recording's exit line. Killed, Codex says nothing.
 */
export function codexExitHint(recordingTail: string): string | null {
  const hints = [
    ...recordingTail.matchAll(
      /To (?:reconnect|continue this session), run[^\n]{0,200}?codex resume ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/gi
    ),
  ];
  const last = hints[hints.length - 1];
  if (!last || last.index === undefined) return null;
  const rest = recordingTail.slice(last.index + last[0].length);
  // One output event at most after it, then the exit line: nothing else was printed since.
  if (rest.length > EXIT_HINT_TRAILER_MAX || rest.split('\n').filter(Boolean).length > 2)
    return null;
  return last[1].toLowerCase();
}

/** codexExitHint of a recording file (its last bytes), or null. */
export function readCodexExitHint(recordingPath: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(recordingPath, 'r');
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, EXIT_HINT_TAIL_BYTES));
    fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return codexExitHint(buffer.toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function realFolder(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * The rollout of a Codex among the others of its folder (findCodexRolloutAmong), never one
 * whose thread another session has recorded (`taken`).
 */
function matchRollout(
  ref: CodexSessionRef,
  rivalStarts: number[],
  taken: ReadonlySet<string>
): string | null {
  const since = Date.parse(ref.startedAt);
  if (Number.isNaN(since) || !ref.workingDir) return null;
  const claimed = new Set<string>();
  for (let attempt = 0; attempt < 50; attempt++) {
    const rollout = findCodexRolloutAmong(
      defaultCodexDir(),
      ref.workingDir,
      since,
      rivalStarts,
      claimed
    );
    const threadId = codexIdFromRollout(rollout);
    if (!rollout || !threadId) return null;
    if (!taken.has(threadId)) return rollout;
    claimed.add(rollout);
  }
  return null;
}

/**
 * Whether a running session's recorded thread is sure enough to end its Codex and reopen it
 * on that thread (Blindar): the one its command resumes, or the only Codex of its folder
 * among the running sessions. With another Codex there the thread is a guess by times
 * (2026-11-10 review: ending a session on a guess could carry on the other's conversation).
 */
export async function codexThreadIsSure(
  session: Session,
  others: readonly Session[],
  refOf: (session: Session) => Promise<CodexSessionRef | null>
): Promise<boolean> {
  if (!session.codexThreadId) return false;
  if (codexResumeTarget(session.command) === session.codexThreadId) return true;
  const folder = realFolder(session.workingDir);
  for (const other of others) {
    if (other.id === session.id || other.status !== 'running') continue;
    const ref = await refOf(other).catch(() => null);
    if (ref && !ref.resumedThreadId && realFolder(ref.workingDir) === folder) return false;
  }
  return true;
}

export interface CodexThreadRecorderOptions {
  listSessions: () => Session[];
  /** The pid under which Codex runs (a shielded session's program inside tmux). */
  rootPid: (session: Session) => number | undefined;
  /** Records a session's thread; `undefined` takes back one recorded by mistake. */
  save: (sessionId: string, threadId: string | undefined) => void;
  /** A session's recording (its cast file), read for what Codex said as it quit. */
  recordingPath?: (sessionId: string) => string | undefined;
  ref?: (session: Session) => Promise<CodexSessionRef | null>;
  /** The rollout of a Codex, given when the others of its folder started and the threads taken. */
  match?: (
    ref: CodexSessionRef,
    rivalStarts: number[],
    taken: ReadonlySet<string>
  ) => string | null;
  /** Ended sessions whose recording was read already (kept by the caller across looks). */
  hintsRead?: Set<string>;
  intervalMs?: number;
}

/**
 * One look.
 *
 * Running sessions with a Codex in them (its command, or typed in its shell; shielded or not)
 * get that Codex's thread recorded when it differs from the recorded one (none yet, or `/new`
 * since): the one its command resumes (exact), else its rollout among the Codex of its
 * folder, never a thread another session has (one session per thread).
 *
 * Sessions that just ended, started as `codex …`: the thread Codex named as it quit is
 * recorded, whatever was recorded before, and taken back from a running session that had it
 * by its rollout (it was that session's guess).
 */
export async function recordCodexThreads(options: CodexThreadRecorderOptions): Promise<number> {
  const refOf =
    options.ref ??
    ((session: Session) => codexSessionRef({ ...session, pid: options.rootPid(session) }));
  const match = options.match ?? matchRollout;
  const sessions = options.listSessions();
  const running = sessions.filter((session) => session.status === 'running');
  let saved = 0;

  const refs = new Map<string, CodexSessionRef>();
  for (const session of running) {
    try {
      const ref = await refOf(session);
      if (ref) refs.set(session.id, ref);
    } catch (error) {
      logger.debug(`could not look for the Codex of ${session.id}: ${error}`);
    }
  }
  /** Who has each thread: every session's record, the ended ones too. */
  const owners = new Map<string, Set<string>>();
  const own = (threadId: string, sessionId: string) => {
    owners.set(threadId, (owners.get(threadId) ?? new Set()).add(sessionId));
  };
  for (const session of sessions) if (session.codexThreadId) own(session.codexThreadId, session.id);

  for (const session of running) {
    const ref = refs.get(session.id);
    if (!ref) continue;
    try {
      let threadId = ref.resumedThreadId ?? null;
      if (!threadId) {
        const folder = realFolder(ref.workingDir);
        const rivalStarts: number[] = [];
        for (const [otherId, other] of refs) {
          if (otherId === session.id || other.resumedThreadId) continue;
          const start = Date.parse(other.startedAt);
          if (!Number.isNaN(start) && realFolder(other.workingDir) === folder)
            rivalStarts.push(start);
        }
        const taken = new Set<string>();
        for (const [id, sessionIds] of owners) {
          if ([...sessionIds].some((owner) => owner !== session.id)) taken.add(id);
        }
        threadId = codexIdFromRollout(match(ref, rivalStarts, taken));
      }
      if (!threadId || threadId === session.codexThreadId) continue;
      options.save(session.id, threadId);
      if (session.codexThreadId) owners.get(session.codexThreadId)?.delete(session.id);
      own(threadId, session.id);
      saved++;
    } catch (error) {
      logger.debug(`could not record the Codex thread of ${session.id}: ${error}`);
    }
  }

  if (options.recordingPath) {
    const hintsRead = options.hintsRead ?? new Set<string>();
    for (const session of sessions) {
      if (session.status !== 'exited' || hintsRead.has(session.id)) continue;
      hintsRead.add(session.id);
      if (!startsCodex(session.command)) continue;
      try {
        const recording = options.recordingPath(session.id);
        const threadId = recording ? readCodexExitHint(recording) : null;
        if (!threadId) continue;
        // A running session that had it from its rollout guessed wrong.
        for (const other of running) {
          if (
            other.codexThreadId !== threadId ||
            refs.get(other.id)?.resumedThreadId === threadId
          ) {
            continue;
          }
          logger.warn(`session ${other.id} was not on Codex thread ${threadId}: ${session.id} was`);
          options.save(other.id, undefined);
        }
        if (threadId === session.codexThreadId) continue;
        options.save(session.id, threadId);
        saved++;
      } catch (error) {
        logger.debug(`could not read what Codex said as it quit in ${session.id}: ${error}`);
      }
    }
    if (hintsRead.size > 5000) hintsRead.clear();
  }
  return saved;
}

/** Looks every `intervalMs` (default 5 s); returns the stop function. */
export function startCodexThreadRecorder(options: CodexThreadRecorderOptions): () => void {
  const withHints = { ...options, hintsRead: options.hintsRead ?? new Set<string>() };
  let running = false;
  const timer = every(
    'codex thread',
    () => {
      if (running) return;
      running = true;
      recordCodexThreads(withHints)
        .catch((error) => logger.debug(`Codex thread look failed: ${error}`))
        .finally(() => {
          running = false;
        });
    },
    options.intervalMs ?? 5000
  );
  timer.unref?.();
  return () => clearInterval(timer);
}

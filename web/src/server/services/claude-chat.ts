/**
 * Claude Code chat transcript reader.
 *
 * Claude Code is a full-screen TUI: the terminal only ever holds the visible screen, so
 * the phone chat view reads the conversation from Claude Code's own transcript instead.
 * A running `claude` process writes <Claude dir>/sessions/<pid>.json (sessionId, cwd,
 * status) and appends the conversation to <Claude dir>/projects/<cwd slug>/<sessionId>.jsonl;
 * the Claude dir is CLAUDE_CONFIG_DIR, else ~/.claude.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { claudeConfigDir } from '../utils/claude-dir.js';
import { createLogger } from '../utils/logger.js';
import { diffForToolUse } from './edit-diff.js';

const logger = createLogger('claude-chat');

const execFileAsync = promisify(execFile);

export type ClaudeChatRole = 'user' | 'assistant' | 'tool' | 'note';

export interface ClaudeChatMessage {
  id: string;
  role: ClaudeChatRole;
  text: string;
  timestamp?: string;
  /** Tool name for role "tool" (e.g. "Bash", "Edit"). */
  tool?: string;
  /** AskUserQuestion with a single single-choice question: answerable by its option number. */
  question?: { text: string; options: string[] };
  /** Tool call detail shown when the chip is expanded (command, file, pattern…). */
  detail?: string;
  /** Start of the tool's output, attached when its result arrives. */
  result?: string;
  isError?: boolean;
  toolUseId?: string;
  /** Edit/MultiEdit/Write: the change as signed lines ('-', '+', ' ') or DIFF_GAP. */
  diff?: string[];
  /** Diff lines left out past the ones in `diff`. */
  diffMore?: number;
}

export interface ClaudeChat {
  available: boolean;
  /** Claude Code's own status: "idle", "busy" or "waiting". */
  status?: string;
  /** What Claude Code waits for when status is "waiting" (e.g. a permission dialog). */
  waitingFor?: string;
  /** Title Claude Code generated for the conversation. */
  title?: string;
  /** While busy: what Claude is doing right now. */
  activity?: ClaudeActivity;
  /**
   * Busy, but the reply is over: Claude Code stays "busy" while background agents or tasks
   * run, so this tells "waiting for background work" apart from a turn still in progress.
   */
  waitingForBackground?: boolean;
  messages: ClaudeChatMessage[];
}

interface ClaudeSessionFile {
  sessionId?: string;
  cwd?: string;
  status?: string;
  waitingFor?: string;
  /** Epoch ms of the last status change (Claude Code writes it with the status). */
  statusUpdatedAt?: number;
  /** Its turn ended with a background shell still running (Claude Code's "shell"). */
  backgroundShell?: boolean;
  /** The Claude Code version this process started as ("2.1.316"). */
  version?: string;
  /** When this Claude process started (epoch ms). */
  startedAt?: number;
  /** `interactive` for a terminal CLI; another value for one-off runs. */
  kind?: string;
  /** `cli` when started as a command, `sdk-cli` when an SDK drives it. */
  entrypoint?: string;
}

interface TranscriptCache {
  offset: number;
  messages: ClaudeChatMessage[];
  /** Tool calls by tool_use id, to attach their results when those lines arrive. */
  tools: Map<string, ClaudeChatMessage>;
  title?: string;
  /** The read position is mid-line (tail start or an oversized line): skip to the next line. */
  skipPartialLine?: boolean;
  /** Last step Claude took in the conversation, for the live activity line. */
  lastStep?: TranscriptStep;
  /** The latest prompt's id and its text message, to add the images that follow it. */
  lastPrompt?: { promptId?: string; index: number };
  /** The main thread's last turn ended (and when): nothing has started another since. */
  turnEnded?: TurnEnd;
  /**
   * The API error that ended the main thread's last turn (Claude Code writes it as an
   * assistant entry with `isApiErrorMessage` and an `error` name), until something follows.
   */
  apiError?: TranscriptApiError;
}

/** A turn's API error as the transcript records it. */
export interface TranscriptApiError {
  /** Claude Code's error name: rate_limit, authentication_failed, server_error… */
  error: string;
  /** What it showed ("You've hit your limit · resets 4am (Europe/Madrid)"). */
  text: string;
  at?: number;
}

/** A finished turn of the main thread: `at` is when its reply ended (epoch ms). */
interface TurnEnd {
  at?: number;
}

/** What the end of the transcript says Claude is doing. */
type TranscriptStep =
  | { kind: 'thinking' | 'writing'; at?: number }
  | { kind: 'tool'; tool: ClaudeChatMessage };

/** Live activity of a working Claude: structured, the client words it in its own language. */
export interface ClaudeActivity {
  /** "thinking", "writing" or "tool". */
  kind: 'thinking' | 'writing' | 'tool';
  /** Tool name while a tool call has no result yet (e.g. "Bash", "Edit"). */
  tool?: string;
  /** Short subject of the tool call: command, file name, pattern, host… (≤ 60 chars). */
  target?: string;
  /** When this step began (epoch ms). */
  since?: number;
}

const MAX_MESSAGES = 400;
const MAX_CACHED_TRANSCRIPTS = 20;
/** First read of a transcript only looks at its end. */
const INITIAL_TAIL_BYTES = 4 * 1024 * 1024;
/** Upper bound for one synchronous read during a poll. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const transcriptCache = new Map<string, TranscriptCache>();

/** What the extended `ps` columns say about a process besides its parent. */
export interface ProcInfo {
  ppid: number;
  /** Its process group, and the foreground group of its terminal (0 or -1 without one). */
  pgid: number;
  tpgid: number;
  /** Its terminal: "ttys001" on macOS, "pts/3" on Linux; null without one. */
  tty: string | null;
  /** `ps` state: "S+", "Ss", "Z" for a zombie… */
  stat: string;
  uid: number;
}

export interface ProcessTable {
  children: Map<number, number[]>;
  /** `ps` lstart per pid, normalized; matches Claude Code's procStart. */
  starts: Map<number, string>;
  /** Command line per pid (`ps` args), to spot agents started inside a shell. */
  args: Map<number, string>;
  /** Group, terminal, state and owner per pid (Mac Sessions); empty without `extended`. */
  procs: Map<number, ProcInfo>;
  /** False when `ps` refused those columns and only pid, ppid, lstart and args were read. */
  extended: boolean;
}

let processCache: { at: number; table: ProcessTable } | null = null;

const normalizeStart = (start: string) => start.trim().replace(/\s+/g, ' ');

let processTableInFlight: Promise<ProcessTable> | null = null;

/** Process tree and start times, shared for a couple of seconds across requests. */
export async function processTable(): Promise<ProcessTable> {
  if (processCache && Date.now() - processCache.at < 2000) return processCache.table;
  // Concurrent requests (several clients polling /sessions) share one `ps` run.
  processTableInFlight ??= readProcessTable()
    .then((table) => {
      processCache = { at: Date.now(), table };
      return table;
    })
    .finally(() => {
      processTableInFlight = null;
    });
  return processTableInFlight;
}

/**
 * Drop the shared process table so the next look runs `ps` again (tests: they slept 2.1 s
 * per step for the 2 s cache to run out, 2026-11-02).
 */
export function clearProcessTableCache(): void {
  processCache = null;
}

/**
 * The `ps -o` columns. The terminal is `tdev` on macOS: `tty` there doubles the time `ps`
 * takes (47 → 100 ms); Linux only has `tty`.
 */
export function processTableColumns(platform: NodeJS.Platform = process.platform): string {
  const terminal = platform === 'linux' ? 'tty' : 'tdev';
  return `pid=,ppid=,pgid=,tpgid=,${terminal}=,stat=,uid=,lstart=,args=`;
}

const LEGACY_COLUMNS = 'pid=,ppid=,lstart=,args=';

async function runPs(columns: string): Promise<string> {
  // Claude Code records procStart as `ps` lstart in UTC; local time never matches.
  const { stdout } = await execFileAsync('ps', ['-A', '-o', columns], {
    env: { ...process.env, TZ: 'UTC' },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/**
 * One `ps` of every process. A `ps` that refuses the extended columns gets the basic ones,
 * and the table says so (`extended: false`). Arguments are never logged: they can hold prompts
 * and secrets. `run` is for tests.
 */
export async function readProcessTable(
  run: (columns: string) => Promise<string> = runPs,
  platform: NodeJS.Platform = process.platform
): Promise<ProcessTable> {
  let stdout: string;
  try {
    stdout = await run(processTableColumns(platform));
  } catch {
    stdout = await run(LEGACY_COLUMNS);
  }
  return parseProcessTable(stdout);
}

// pid, ppid, pgid, tpgid, terminal, state, uid, then lstart, always five words ("Thu Oct  2
// 10:00:00 2026"), then args.
const EXTENDED_LINE =
  /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s+(.*))?$/;
const LEGACY_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s+(.*))?$/;

/** A `ps` terminal column as a name: macOS's tdev "16/1" is ttys001; "??" or "?" is none. */
export function terminalName(value: string): string | null {
  if (value === '??' || value === '?') return null;
  const pty = /^16\/(\d+)$/.exec(value);
  return pty ? `ttys${pty[1].padStart(3, '0')}` : value;
}

/**
 * `ps` output as a table (exported for tests), with the extended columns or only
 * `pid=,ppid=,lstart=,args=`: each line is read in whichever of the two shapes it has.
 */
export function parseProcessTable(stdout: string): ProcessTable {
  const children = new Map<number, number[]>();
  const starts = new Map<number, string>();
  const args = new Map<number, string>();
  const procs = new Map<number, ProcInfo>();
  for (const line of stdout.split('\n')) {
    const extended = EXTENDED_LINE.exec(line);
    const match = extended
      ? [extended[1], extended[2], extended[8], extended[9]]
      : LEGACY_LINE.exec(line)?.slice(1);
    if (!match) continue;
    const pid = Number(match[0]);
    const ppid = Number(match[1]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
    starts.set(pid, normalizeStart(match[2]));
    if (match[3]) args.set(pid, match[3].trim());
    if (extended) {
      procs.set(pid, {
        ppid,
        pgid: Number(extended[3]),
        tpgid: Number(extended[4]),
        tty: terminalName(extended[5]),
        stat: extended[6],
        uid: Number(extended[7]),
      });
    }
  }
  return { children, starts, args, procs, extended: procs.size > 0 };
}

/** All descendants of `rootPid` in `table` (breadth first), including itself. */
export function descendants(table: Pick<ProcessTable, 'children'>, rootPid: number): number[] {
  const { children } = table;
  const result: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0 && result.length < 200) {
    const pid = queue.shift() as number;
    result.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}

/**
 * 2026-11-02 (CPU measurement): the status notifier (every 3 s) and each GET /sessions ran
 * `ps -A` over every process of the Mac (~40 ms each) only to find the claude under each
 * session again, which almost never moves. The claude found under a session (the first pid
 * of its tree with a session file) is remembered; `ps` runs again when Claude's sessions
 * folder changes (a claude started or ended: its file comes or goes), when a remembered pid
 * died, for a session not seen yet, and at least every 30 s (pid reuse, anything missed).
 */
const CLAUDE_PID_RECHECK_MS = 30_000;
/**
 * One root's answer and what it was valid for. Each root keeps its own `ps` time and sessions
 * mtime (2026-11-02 review: with one global stamp, a lookup for one session after a change
 * renewed it for every other root, which kept an old answer up to 30 s more).
 */
interface ClaudePidEntry {
  /** The claude pid under the root (null: none found). */
  pid: number | null;
  /** `ps` lstart of that pid. */
  start?: string;
  at: number;
  claudeDir: string;
  sessionsMtime: number;
}
const claudePidCache = {
  /** Session root pid → what the last `ps` that looked at it found. */
  roots: new Map<number, ClaudePidEntry>(),
  /** Process table reads so far (tests). */
  lookups: 0,
};

/** How many times the claude lookup read the process table (tests). */
export function claudePidLookups(): number {
  return claudePidCache.lookups;
}

/** Forget the remembered claude pids (tests). */
export function clearClaudePidCache(): void {
  claudePidCache.roots.clear();
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function sessionsMtime(claudeDir: string): number {
  try {
    return fs.statSync(path.join(claudeDir, 'sessions')).mtimeMs;
  } catch {
    return 0;
  }
}

/** Whether `entry` still answers for `root`: same folder state, recent, its pids alive. */
function claudePidEntryFresh(
  entry: ClaudePidEntry | undefined,
  root: number,
  claudeDir: string,
  mtime: number,
  now: number,
  alive: (pid: number) => boolean = pidAlive
): entry is ClaudePidEntry {
  return (
    entry !== undefined &&
    entry.claudeDir === claudeDir &&
    entry.sessionsMtime === mtime &&
    now - entry.at < CLAUDE_PID_RECHECK_MS &&
    alive(root) &&
    (entry.pid === null || alive(entry.pid))
  );
}

/**
 * The pids to look for a Claude session file under each of `rootPids`, in order, and the `ps`
 * start times to check those files with: the remembered claude alone when nothing moved, the
 * whole process tree after a `ps` otherwise.
 */
async function claudeCandidates(
  rootPids: number[],
  claudeDir: string,
  now = Date.now()
): Promise<{ starts: Map<number, string>; trees: Map<number, number[]> }> {
  const cache = claudePidCache;
  const mtime = sessionsMtime(claudeDir);
  const entries = rootPids.map((root) => cache.roots.get(root));
  if (entries.every((entry, i) => claudePidEntryFresh(entry, rootPids[i], claudeDir, mtime, now))) {
    const trees = new Map<number, number[]>();
    const starts = new Map<number, string>();
    rootPids.forEach((root, i) => {
      const entry = entries[i] as ClaudePidEntry;
      trees.set(root, entry.pid ? [entry.pid] : []);
      if (entry.pid && entry.start) starts.set(entry.pid, entry.start);
    });
    return { starts, trees };
  }

  const table = await processTable();
  cache.lookups++;
  const trees = new Map<number, number[]>();
  for (const root of rootPids) {
    const tree = descendants(table, root);
    trees.set(root, tree);
    const pid = tree.find((candidate) => readSessionFile(claudeDir, candidate, table.starts));
    cache.roots.set(root, {
      pid: pid ?? null,
      start: pid ? table.starts.get(pid) : undefined,
      at: now,
      claudeDir,
      sessionsMtime: mtime,
    });
  }
  // Roots no session asked about for a while: drop them (dead sessions).
  for (const [root, entry] of cache.roots) {
    if (now - entry.at >= 2 * CLAUDE_PID_RECHECK_MS) cache.roots.delete(root);
  }
  return { starts: table.starts, trees };
}

/**
 * Claude Code writes a new session's file before its first status (2026-10-22: the doctor
 * reported sessions/63740.json "has no status" 1 s after that claude started; it had "busy"
 * a moment later). A missing field is only a format change once the session is past startup.
 */
const SESSION_FILE_STARTUP_MS = 60_000;

export function sessionFileSurprise(
  session: { status?: string; sessionId?: unknown; startedAt?: unknown },
  pid: number,
  now = Date.now()
): string | null {
  const missing =
    typeof session.sessionId !== 'string'
      ? 'sessionId'
      : session.status === undefined
        ? 'status'
        : null;
  if (!missing) return null;
  if (typeof session.startedAt === 'number' && now - session.startedAt < SESSION_FILE_STARTUP_MS) {
    return null;
  }
  return `a session file (sessions/${pid}.json) has no ${missing}`;
}

export function readSessionFile(
  claudeDir: string,
  pid: number,
  starts: Map<number, string>
): ClaudeSessionFile | null {
  let session: ClaudeSessionFile & { procStart?: string };
  try {
    session = JSON.parse(fs.readFileSync(path.join(claudeDir, 'sessions', `${pid}.json`), 'utf8'));
  } catch {
    return null;
  }
  const surprise = sessionFileSurprise(session, pid);
  if (surprise) noteFormatSurprise('session-file-fields', surprise);
  if (typeof session.cwd !== 'string' || typeof session.sessionId !== 'string') {
    // Hand-edited or future-format files: never let a bad field throw out of a poll.
    session = {
      ...session,
      cwd: undefined as unknown as string,
      sessionId: undefined as unknown as string,
    };
  }
  // A file left by a crashed claude must not be attributed to a new process reusing its pid.
  const started = starts.get(pid);
  if (session.procStart && started && normalizeStart(session.procStart) !== started) return null;
  return withKnownStatus(session);
}

const KNOWN_STATUSES = new Set(['busy', 'idle', 'waiting']);
const unknownStatusesSeen = new Set<string>();

const KNOWN_STOP_REASONS = new Set([
  'end_turn',
  'tool_use',
  'max_tokens',
  'stop_sequence',
  'pause_turn',
  'refusal',
  'model_context_window_exceeded',
]);
const formatSurprises = new Map<string, string>();

/**
 * Something in Claude Code's files Untether did not expect (a new stop reason, a session file
 * without its status): noted once and logged, and Untether's doctor reports it (2026-10-20
 * review: every such change used to fail in silence).
 */
function noteFormatSurprise(key: string, text: string): void {
  if (formatSurprises.has(key)) return;
  formatSurprises.set(key, text);
  logger.warn(`Claude Code format: ${text}`);
}

export function claudeFormatSurprises(): string[] {
  return Array.from(formatSurprises.values());
}

/** Status words Claude Code wrote that Untether doesn't know (Untether's doctor reports them). */
export function unknownClaudeStatuses(): string[] {
  return Array.from(unknownStatusesSeen);
}

/**
 * Claude Code's status in the words the rest of Untether knows. 2026-10-20: Claude Code began
 * writing "shell" for a turn that ended with a background shell still running (it used to stay
 * "busy"); Untether knew only idle, so a task waiting on its serial monitor never got its
 * follow-ups and the orchestrator was told nothing. It is background work again, and any other
 * new status is logged once (it reads as idle: the prompt is the safe guess for a turn that is
 * neither working nor asking).
 */
function withKnownStatus(session: ClaudeSessionFile): ClaudeSessionFile {
  const status = session.status;
  if (status === undefined || KNOWN_STATUSES.has(status)) return session;
  if (status === 'shell') return { ...session, status: 'busy', backgroundShell: true };
  if (!unknownStatusesSeen.has(status)) {
    unknownStatusesSeen.add(status);
    logger.warn(`Claude Code reports an unknown status "${status}": treated as idle`);
  }
  return { ...session, status: 'idle' };
}

const transcriptLookups = new Map<string, { at: number; path: string | null }>();
/** A transcript appears with Claude's first message; until then re-scan at most this often. */
const MISSING_TRANSCRIPT_RECHECK_MS = 5000;

/** findTranscript, cached: the fallback scan walks every project directory synchronously. */
function cachedFindTranscript(claudeDir: string, cwd: string, sessionId: string): string | null {
  const key = `${claudeDir}\0${cwd}\0${sessionId}`;
  const cached = transcriptLookups.get(key);
  if (cached?.path && fs.existsSync(cached.path)) return cached.path;
  if (cached && !cached.path && Date.now() - cached.at < MISSING_TRANSCRIPT_RECHECK_MS) return null;
  const found = findTranscript(claudeDir, cwd, sessionId);
  transcriptLookups.set(key, { at: Date.now(), path: found });
  if (transcriptLookups.size > 200) {
    transcriptLookups.delete(transcriptLookups.keys().next().value as string);
  }
  return found;
}

const resumableCache = new Map<string, { exists: boolean; at: number }>();
/** "No transcript" is rechecked after a while: a read error must not hide Resume for good. */
const NOT_RESUMABLE_RECHECK_MS = 60_000;

/**
 * Whether `claude --resume <sessionId>` can work: Claude Code only writes a transcript once a
 * conversation has its first message. Asked for exited sessions, where "yes" never changes.
 */
export function claudeConversationExists(
  cwd: string,
  sessionId: string,
  claudeDir = claudeConfigDir()
): boolean {
  const key = `${claudeDir}\0${cwd}\0${sessionId}`;
  const cached = resumableCache.get(key);
  if (cached && (cached.exists || Date.now() - cached.at < NOT_RESUMABLE_RECHECK_MS)) {
    return cached.exists;
  }
  const exists = findTranscript(claudeDir, cwd, sessionId) !== null;
  resumableCache.delete(key);
  resumableCache.set(key, { exists, at: Date.now() });
  if (resumableCache.size > 2000) {
    resumableCache.delete(resumableCache.keys().next().value as string);
  }
  return exists;
}

/**
 * What one transcript has shown so far, read once and then only what Claude appended: the
 * folder Claude started in and where its recent tool calls place it (WorkTracker).
 */
interface WorkDirScan {
  mtimeMs: number;
  size: number;
  offset: number;
  tracker: WorkTracker;
  startCwd: string | null;
  dir: string | null;
  /** The file's first bytes: other ones mean a rewritten transcript, read again. */
  head: string;
}
const workDirCache = new Map<string, WorkDirScan>();
const WORK_DIR_CHUNK = 4 * 1024 * 1024;
/** A first read covers this much of a transcript's end (some reach hundreds of MB). */
const WORK_DIR_FIRST_READ = 32 * 1024 * 1024;

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

const CD = /(?:^|&&|;|\|\||\n)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?=&&|;|\|\||\n|$)/g;
const GIT_INIT = /\bgit\s+init\b(?:\s+(?:-\S+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|-][^\s;&|]*)))?/;
/** Absolute or home paths a command names (~/x, $HOME/x, /Users/n/x); /dev/null and co. left out. */
const NAMED_PATH =
  /(?:^|[\s"'=(<>|;&])((?:~|\$HOME|\$\{HOME\})(?=[/\s"';&|)]|$)[^\s"'`;&|<>()]*|\/(?!dev\/)[^\s"'`;&|<>()*]+)/g;

/** How many of the newest tool calls with a folder decide where a session works. */
export const WORK_WINDOW = 25;
/** The share of that window one project needs ("una mayoría clara"). */
export const WORK_MAJORITY = 0.6;
/** And at least this many calls there (a short transcript is no majority yet). */
export const WORK_MIN_STEPS = 10;
/** That majority has to hold this long (transcript time) before the session moves. */
export const WORK_MIN_STAY_MS = 5 * 60_000;
/** A pause longer than this between tool calls is no stay: the held time starts again. */
export const WORK_IDLE_GAP_MS = 10 * 60_000;

/**
 * One tool call: the folder or file it acts on (absolute; null when unknown or none, as for a
 * web search), the repository a `git init` makes (null otherwise) and when (ms, 0 unknown).
 */
export interface ToolStep {
  dir: string | null;
  created: string | null;
  at: number;
}

/** `dir` made absolute (~ and $HOME expanded, relative to `base`); null when unknown. */
function absoluteDir(dir: string | undefined, home: string, base?: string | null): string | null {
  if (!dir) return null;
  dir = dir.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  // A folder named by a variable or a command ($DIR, `pwd`): unknown.
  if (/[$`]/.test(dir)) return null;
  if (!path.isAbsolute(dir)) {
    if (!base) return null;
    dir = path.resolve(base, dir);
  }
  return path.normalize(dir);
}

const inside = (dir: string, parent: string) =>
  dir === parent || dir.startsWith(`${parent}${path.sep}`);

/**
 * The tool calls of one transcript line and the folder each acts on: the folder of a file it
 * reads or writes, the path a search looks in, the folder a command `cd`s into or runs in (or,
 * without a cd, a place it names deeper than its cwd, else one it names outside it when none
 * is inside: Claude Code keeps the cwd of an old `cd`, and `cat /tmp/x` from there works in
 * /tmp), a repository `git init` makes.
 */
export function toolSteps(line: string, home: string): ToolStep[] {
  if (!line.includes('"tool_use"')) return [];
  let entry: { cwd?: unknown; timestamp?: unknown; message?: { content?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  const cwd = typeof entry.cwd === 'string' ? entry.cwd : null;
  const at = (typeof entry.timestamp === 'string' && Date.parse(entry.timestamp)) || 0;
  const steps: ToolStep[] = [];
  for (const item of content as Array<{
    type?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>) {
    if (item?.type !== 'tool_use' || !item.input) continue;
    const name = item.name ?? '';
    let dir: string | null = null;
    let created: string | null = null;
    const filePath = item.input.file_path ?? item.input.notebook_path;
    if (FILE_TOOLS.has(name) && typeof filePath === 'string') {
      const file = absoluteDir(filePath, home, cwd);
      dir = file && path.dirname(file);
    } else if (SEARCH_TOOLS.has(name)) {
      const where = item.input.path;
      dir = typeof where === 'string' && where ? absoluteDir(where, home, cwd) : cwd;
    } else if (name === 'Bash' && typeof item.input.command === 'string') {
      const command = item.input.command;
      dir = cwd;
      let rest = command;
      let cdSeen = false;
      for (const cd of command.matchAll(CD)) {
        cdSeen = true;
        dir = absoluteDir(cd[1] ?? cd[2] ?? cd[3], home, dir ?? cwd);
        rest = command.slice((cd.index ?? 0) + cd[0].length);
      }
      if (!cdSeen && cwd) {
        const named = [...command.matchAll(NAMED_PATH)]
          .map((match) => absoluteDir(match[1], home, cwd))
          .filter((found): found is string => !!found && found !== '/');
        // A place deeper than the cwd is more precise (2026-11-04 review: from ~,
        // `git -C ~/Projects/app status` works in app); else one outside it, when the command
        // names nothing inside it.
        const deeper = named.find((found) => found !== cwd && inside(found, cwd));
        if (deeper) dir = deeper;
        else if (named.length > 0 && !named.some((found) => inside(found, cwd))) dir = named[0];
      }
      const init = rest.match(GIT_INIT);
      if (init) {
        const target = init[1] ?? init[2] ?? init[3];
        created = target ? absoluteDir(target, home, dir ?? cwd) : dir;
      }
    } else {
      continue;
    }
    steps.push({ dir, created, at });
  }
  return steps;
}

const projectCache = new Map<string, { project: string; at: number }>();

/**
 * The project a folder or file belongs to: the nearest git repository holding it under the
 * home folder, else its folder two levels under home (~/Projects/app, as the client's
 * folderGroupKey); '' outside any (the home folder, ~/Projects, a hidden folder, /tmp).
 */
export function projectOf(target: string, home = os.homedir()): string {
  const rest = path.relative(home, target);
  if (!rest || rest.startsWith('..') || path.isAbsolute(rest)) return '';
  const parts = rest.split(path.sep).filter(Boolean);
  if (parts.some((part) => part.startsWith('.'))) return '';
  const key = `${home}\0${target}`;
  const cached = projectCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.project;
  let project = '';
  for (let n = parts.length; n >= 1 && !project; n--) {
    const dir = path.join(home, ...parts.slice(0, n));
    if (fs.existsSync(path.join(dir, '.git'))) project = dir;
  }
  if (!project && parts.length >= 2) {
    const folder = path.join(home, parts[0], parts[1]);
    try {
      if (fs.statSync(folder).isDirectory()) project = folder;
    } catch {
      // not there
    }
  }
  projectCache.delete(key);
  projectCache.set(key, { project, at: Date.now() });
  if (projectCache.size > 2000) projectCache.delete(projectCache.keys().next().value as string);
  return project;
}

/** A folder inside some git repository (wherever it is): a session started there stays there. */
function inRepository(dir: string): boolean {
  for (let at = dir; ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, '.git'))) return true;
    if (path.dirname(at) === at) return false;
  }
}

/** Where recent tool calls place a session (trackWork). */
export interface WorkTracker {
  window: Array<{ project: string; at: number }>;
  current: string;
  candidate: { project: string; since: number } | null;
  /** The newest known time: a call without one happened then. */
  lastAt: number;
}

export function newWorkTracker(): WorkTracker {
  return { window: [], current: '', candidate: null, lastAt: 0 };
}

/**
 * Where a session started outside a project works, from its tool calls (oldest first): the
 * project ('' for none) holding a clear majority of the newest WORK_WINDOW calls with a
 * folder (WORK_MAJORITY and WORK_MIN_STEPS), once that majority held WORK_MIN_STAY_MS. It
 * leaves the same way (another project or none taking the majority); a `git init` makes the
 * new repository its project at once.
 *
 * 2026-11-04: a session opened in ~ about a finance bot and channel insights ran a burst of
 * commands in ~/Projects/bakery (cd + ./bakery up + a subagent) and showed in the
 * bakery group: the newest change won. A burst is not a move.
 */
export function trackWork(
  tracker: WorkTracker,
  step: { project: string; created?: boolean; at: number }
): void {
  const at = step.at || tracker.lastAt;
  if (tracker.candidate && at - tracker.lastAt > WORK_IDLE_GAP_MS) tracker.candidate.since = at;
  tracker.lastAt = at;
  if (step.created) {
    tracker.current = step.project;
    tracker.window = [];
    tracker.candidate = null;
    return;
  }
  tracker.window.push({ project: step.project, at });
  if (tracker.window.length > WORK_WINDOW) tracker.window.shift();
  const counts = new Map<string, number>();
  let top = '';
  let most = 0;
  for (const { project } of tracker.window) {
    const count = (counts.get(project) ?? 0) + 1;
    counts.set(project, count);
    if (count > most) {
      top = project;
      most = count;
    }
  }
  const clear = most >= WORK_MIN_STEPS && most >= tracker.window.length * WORK_MAJORITY;
  if (!clear || top === tracker.current) {
    tracker.candidate = null;
    return;
  }
  if (tracker.candidate?.project !== top) tracker.candidate = { project: top, since: at };
  if (at - tracker.candidate.since >= WORK_MIN_STAY_MS) {
    tracker.current = top;
    tracker.candidate = null;
  }
}

/**
 * The folder Claude works in now. A session started in a project (the `cwd` of the
 * transcript's first entry is in a repository or a project folder) stays there. One started
 * outside one (~, ~/Projects) goes where most of its recent work is (trackWork), else stays
 * where it started. Not the `cwd` of its newest entry: Claude Code moves it with every `cd`,
 * also one only to look. Reads the transcript once (its last 32MB), then only what was
 * appended. Null when unknown.
 *
 * 2026-10-18: a session opened in ~ wrote a new app with `cd ~/Projects/skylark && …`, while
 * its cwd stayed ~: it showed under another project.
 */
export function claudeWorkingDir(
  cwd: string,
  sessionId: string,
  claudeDir = claudeConfigDir(),
  home = os.homedir()
): string | null {
  const file = findTranscript(claudeDir, cwd, sessionId);
  if (!file) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  let scan = workDirCache.get(file);
  if (scan && scan.mtimeMs === stat.mtimeMs && scan.size === stat.size) return scan.dir;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const headBuffer = Buffer.alloc(Math.min(stat.size, 64));
      fs.readSync(fd, headBuffer, 0, headBuffer.length, 0);
      const head = headBuffer.toString('latin1');
      if (!scan || stat.size < scan.offset || scan.head !== head) {
        scan = {
          mtimeMs: 0,
          size: 0,
          offset: 0,
          tracker: newWorkTracker(),
          startCwd: null,
          dir: null,
          head,
        };
        if (stat.size > WORK_DIR_FIRST_READ) {
          scan.offset = stat.size - WORK_DIR_FIRST_READ;
          const start = Buffer.alloc(1024 * 1024);
          const read = fs.readSync(fd, start, 0, start.length, 0);
          for (const line of start.toString('utf8', 0, read).split('\n')) {
            scan.startCwd = lineCwd(line);
            if (scan.startCwd) break;
          }
        }
      }
      const buffer = Buffer.alloc(WORK_DIR_CHUNK);
      while (scan.offset < stat.size) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, scan.offset);
        if (read <= 0) break;
        const end = buffer.lastIndexOf(10, read - 1);
        // A line longer than a chunk (a huge tool result) holds no tool call worth reading.
        const used = end >= 0 ? end + 1 : read === buffer.length ? read : 0;
        if (!used) break;
        for (const line of buffer.toString('utf8', 0, end >= 0 ? end : 0).split('\n')) {
          if (!scan.startCwd) scan.startCwd = lineCwd(line);
          for (const step of toolSteps(line, home)) {
            if (step.created) {
              trackWork(scan.tracker, { project: step.created, created: true, at: step.at });
            } else if (step.dir) {
              trackWork(scan.tracker, { project: projectOf(step.dir, home), at: step.at });
            }
          }
        }
        scan.offset += used;
      }
    } finally {
      fs.closeSync(fd);
    }
    const start = scan.startCwd;
    const startedInProject = !!start && (!!projectOf(start, home) || inRepository(start));
    scan.dir = startedInProject ? start : scan.tracker.current || start;
  } catch {
    // keep what was read before
  }
  if (!scan) return null;
  scan.mtimeMs = stat.mtimeMs;
  scan.size = stat.size;
  workDirCache.delete(file);
  workDirCache.set(file, scan);
  if (workDirCache.size > 500) workDirCache.delete(workDirCache.keys().next().value as string);
  return scan.dir;
}

/** The `cwd` a transcript line records, else null. */
function lineCwd(line: string): string | null {
  const match = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

/** A conversation's transcript (.jsonl), wherever Claude keeps it; null when there is none. */
export function findClaudeTranscript(
  cwd: string,
  sessionId: string,
  claudeDir = claudeConfigDir()
): string | null {
  return findTranscript(claudeDir, cwd, sessionId);
}

function findTranscript(claudeDir: string, cwd: string, sessionId: string): string | null {
  const projectsDir = path.join(claudeDir, 'projects');
  const direct = path.join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // no projects dir
  }
  return null;
}

function summarizeToolUse(name: string, input: Record<string, unknown> | undefined): string {
  const str = (key: string) => (typeof input?.[key] === 'string' ? (input[key] as string) : '');
  const file = str('file_path') || str('notebook_path') || str('path');
  switch (name) {
    case 'Bash':
      return str('description') || str('command');
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return file ? path.basename(file) : '';
    case 'Grep':
    case 'Glob':
      return str('pattern');
    case 'WebFetch':
      return str('url');
    case 'WebSearch':
      return str('query');
    case 'Agent':
    case 'Task':
      return str('description');
    default:
      return str('description');
  }
}

function singleChoiceQuestion(
  input: Record<string, unknown> | undefined
): ClaudeChatMessage['question'] | undefined {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  if (questions.length !== 1) return undefined;
  const [question] = questions as Array<{
    question?: unknown;
    multiSelect?: unknown;
    options?: Array<{ label?: unknown }>;
  }>;
  if (question.multiSelect || typeof question.question !== 'string') return undefined;
  const options = (question.options ?? [])
    .map((option) => option.label)
    .filter((label): label is string => typeof label === 'string');
  return options.length > 0 ? { text: question.question, options } : undefined;
}

const MAX_RESULT_CHARS = 1500;
const MAX_RESULT_LINES = 20;

function detailForToolUse(name: string, input: Record<string, unknown> | undefined): string {
  const str = (key: string) => (typeof input?.[key] === 'string' ? (input[key] as string) : '');
  switch (name) {
    case 'Bash':
      return str('command') ? `$ ${str('command')}` : '';
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return str('file_path') || str('notebook_path');
    case 'Grep':
      return [str('pattern'), str('path') && `in ${str('path')}`].filter(Boolean).join(' ');
    case 'Glob':
      return str('pattern');
    case 'WebFetch':
      return str('url');
    case 'WebSearch':
      return str('query');
    case 'Agent':
    case 'Task':
      return str('prompt').slice(0, 400);
    default:
      return input ? JSON.stringify(input).slice(0, 400) : '';
  }
}

function truncateResult(text: string): string {
  const lines = text.split('\n');
  let result = lines.slice(0, MAX_RESULT_LINES).join('\n');
  if (result.length > MAX_RESULT_CHARS) result = result.slice(0, MAX_RESULT_CHARS);
  return result.length < text.length ? `${result.trimEnd()}\n…` : result;
}

/** Tool results carried by a user transcript line (exported for tests). */
export function parseToolResults(
  line: string
): Array<{ toolUseId: string; text: string; isError: boolean }> {
  let entry: { type?: string; message?: { content?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const content = entry.type === 'user' ? entry.message?.content : undefined;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
    .map((block) => {
      const raw = block.content;
      const text =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw
                .filter((part: { type?: string }) => part?.type === 'text')
                .map((part: { text?: string }) => part.text ?? '')
                .join('\n')
            : '';
      return {
        toolUseId: block.tool_use_id,
        text: truncateResult(text),
        isError: !!block.is_error,
      };
    });
}

/** Strip Claude Code's own markup from user text; null when nothing human-written is left. */
function cleanUserText(text: string): string | null {
  const command = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return args ? `${command[1]} ${args}` : command[1];
  }
  if (/^\s*<(local-command|system-reminder|command-message|bash-|task-notification)/.test(text)) {
    return null;
  }
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return cleaned || null;
}

/** An image uploaded through Untether (same names as the files route accepts). */
const UPLOADED_IMAGE_PATH =
  /\/uploads\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp|heic|heif)$/i;

/**
 * Claude Code takes an image path out of the prompt text, sends the image, and logs where it
 * came from in a separate meta line: `[Image: source: /path]`. Returns the uploaded images
 * named by such a line (exported for tests), so the chat can show them with their prompt
 * (2026-10-02: they were dropped, and a photo sent from the phone never appeared).
 */
export function parseImageSources(
  line: string
): { id: string; promptId?: string; timestamp?: string; paths: string[] } | null {
  if (!line.includes('[Image: source: ')) return null;
  let entry: {
    type?: string;
    uuid?: string;
    promptId?: string;
    timestamp?: string;
    isMeta?: boolean;
    isSidechain?: boolean;
    message?: { content?: unknown };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry.type !== 'user' || !entry.isMeta || entry.isSidechain) return null;
  const content = entry.message?.content;
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((b: { type?: string; text?: unknown }) =>
            b?.type === 'text' && typeof b.text === 'string' ? [b.text] : []
          )
        : [];
  const paths = texts.flatMap((text) => {
    const match = text.trim().match(/^\[Image: source: (.+)\]$/);
    return match && UPLOADED_IMAGE_PATH.test(match[1]) ? [match[1]] : [];
  });
  if (paths.length === 0) return null;
  return {
    id: entry.uuid ?? `images-${entry.timestamp}`,
    promptId: entry.promptId,
    timestamp: entry.timestamp,
    paths,
  };
}

/** Add images logged after a prompt to that prompt's message (or show them on their own). */
function attachImageSources(
  cache: TranscriptCache,
  images: NonNullable<ReturnType<typeof parseImageSources>>
) {
  const prompt = cache.lastPrompt;
  const target = prompt ? cache.messages[prompt.index] : undefined;
  if (target?.role === 'user' && prompt?.promptId && prompt.promptId === images.promptId) {
    // A new object and id, so a client that already showed the text sees the change.
    cache.messages[prompt.index] = {
      ...target,
      id: `${target.id}+${images.id}`,
      text: `${images.paths.join(' ')}\n${target.text}`,
    };
    return;
  }
  cache.messages.push({
    id: images.id,
    role: 'user',
    text: images.paths.join(' '),
    timestamp: images.timestamp,
  });
  cache.lastPrompt = { promptId: images.promptId, index: cache.messages.length - 1 };
}

/** Turn one transcript line into chat messages (exported for tests). */
export function parseTranscriptLine(line: string): ClaudeChatMessage[] {
  let entry: {
    type?: string;
    uuid?: string;
    timestamp?: string;
    isSidechain?: boolean;
    isMeta?: boolean;
    message?: { content?: unknown };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain || entry.isMeta) {
    return [];
  }

  const id = entry.uuid ?? `${entry.type}-${entry.timestamp}`;
  const timestamp = entry.timestamp;
  const content = entry.message?.content;
  const blocks: Array<{
    type?: string;
    text?: string;
    name?: string;
    input?: unknown;
    id?: string;
  }> =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content
        : [];

  const messages: ClaudeChatMessage[] = [];
  blocks.forEach((block, index) => {
    const blockId = `${id}:${index}`;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (entry.type === 'user' && block.text.startsWith('[Request interrupted by user')) {
        messages.push({ id: blockId, role: 'note', text: 'Interrupted', timestamp });
        return;
      }
      const text = entry.type === 'user' ? cleanUserText(block.text) : block.text.trim();
      if (text) messages.push({ id: blockId, role: entry.type as ClaudeChatRole, text, timestamp });
    } else if (entry.type === 'assistant' && block.type === 'tool_use' && block.name) {
      const input = block.input as Record<string, unknown> | undefined;
      const diff = diffForToolUse(block.name, input);
      messages.push({
        id: blockId,
        role: 'tool',
        tool: block.name,
        text: summarizeToolUse(block.name, input),
        timestamp,
        question: block.name === 'AskUserQuestion' ? singleChoiceQuestion(input) : undefined,
        detail: detailForToolUse(block.name, input) || undefined,
        toolUseId: block.id,
        diff: diff?.lines,
        diffMore: diff?.more || undefined,
      });
    }
  });
  return messages;
}

function readTranscript(transcriptPath: string): TranscriptCache {
  const size = fs.statSync(transcriptPath).size;
  let cache = transcriptCache.get(transcriptPath);
  if (cache) {
    // Keep the map in least-recently-used order.
    transcriptCache.delete(transcriptPath);
    transcriptCache.set(transcriptPath, cache);
  }
  if (!cache || size < cache.offset) {
    // Transcripts with pasted images can be huge: start from the tail, not the beginning.
    const tailStart = Math.max(0, size - INITIAL_TAIL_BYTES);
    cache = { offset: tailStart, messages: [], tools: new Map(), skipPartialLine: tailStart > 0 };
    transcriptCache.set(transcriptPath, cache);
    while (transcriptCache.size > MAX_CACHED_TRANSCRIPTS) {
      transcriptCache.delete(transcriptCache.keys().next().value as string);
    }
  }
  if (size > cache.offset) {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      // Bounded reads keep each poll from blocking the server on a large backlog.
      const buffer = Buffer.alloc(Math.min(size - cache.offset, MAX_READ_BYTES));
      fs.readSync(fd, buffer, 0, buffer.length, cache.offset);
      let start = 0;
      if (cache.skipPartialLine) {
        const firstNewline = buffer.indexOf(0x0a);
        if (firstNewline < 0) {
          cache.offset += buffer.length;
          return cache;
        }
        start = firstNewline + 1;
        cache.skipPartialLine = false;
      }
      // Only consume complete lines; the writer may be mid-append.
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline < start && buffer.length === MAX_READ_BYTES) {
        // A single line longer than the read window (e.g. a huge pasted image): skip it.
        cache.offset += buffer.length;
        cache.skipPartialLine = true;
      } else if (lastNewline < start) {
        // Skipped the partial line; no complete line after it yet.
        cache.offset += start;
      } else {
        cache.offset += start;
        const chunk = buffer.subarray(start, lastNewline).toString('utf8');
        for (const line of chunk.split('\n')) {
          if (!line) continue;
          if (line.includes('"ai-title"')) {
            try {
              const entry = JSON.parse(line) as { type?: string; aiTitle?: unknown };
              if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
                cache.title = entry.aiTitle;
              }
            } catch {
              // not a complete JSON line
            }
          }
          const images = parseImageSources(line);
          if (images) attachImageSources(cache, images);
          const messages = parseTranscriptLine(line);
          for (const message of messages) {
            cache.messages.push(message);
            if (message.toolUseId) cache.tools.set(message.toolUseId, message);
            if (message.role === 'user') {
              cache.lastPrompt = {
                promptId: line.match(/"promptId":"([^"]+)"/)?.[1],
                index: cache.messages.length - 1,
              };
            }
          }
          const results = parseToolResults(line);
          for (const result of results) {
            const tool = cache.tools.get(result.toolUseId);
            if (tool) {
              tool.result = result.text;
              tool.isError = result.isError;
            }
          }
          cache.lastStep = nextStep(
            cache.lastStep,
            line,
            messages,
            results.length > 0,
            cache.messages
          );
          cache.turnEnded = turnAfter(cache.turnEnded, line);
          cache.apiError = apiErrorAfter(cache.apiError, line);
        }
        cache.offset += lastNewline - start + 1;
        if (cache.messages.length > MAX_MESSAGES) {
          const dropped = cache.messages.length - MAX_MESSAGES;
          cache.messages = cache.messages.slice(-MAX_MESSAGES);
          if (cache.lastPrompt) {
            cache.lastPrompt =
              cache.lastPrompt.index >= dropped
                ? { ...cache.lastPrompt, index: cache.lastPrompt.index - dropped }
                : undefined;
          }
          const kept = new Set(cache.messages);
          for (const [toolUseId, tool] of cache.tools) {
            if (!kept.has(tool)) cache.tools.delete(toolUseId);
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return cache;
}

function lineTime(line: string): number | undefined {
  const match = line.match(/"timestamp":"([^"]+)"/);
  const at = match ? Date.parse(match[1]) : Number.NaN;
  return Number.isNaN(at) ? undefined : at;
}

/** The step a transcript line moves Claude to (lines with nothing to say keep the last one). */
function nextStep(
  previous: TranscriptStep | undefined,
  line: string,
  messages: ClaudeChatMessage[],
  hasResults: boolean,
  conversation: ClaudeChatMessage[]
): TranscriptStep | undefined {
  const last = messages[messages.length - 1];
  if (last?.role === 'tool') return { kind: 'tool', tool: last };
  if (last?.role === 'assistant') return { kind: 'writing', at: lineTime(line) };
  if (hasResults) {
    // Parallel calls resolve one by one: show one still running, if any.
    for (let i = conversation.length - 1; i >= 0 && conversation[i].role === 'tool'; i--) {
      if (conversation[i].result === undefined) return { kind: 'tool', tool: conversation[i] };
    }
  }
  // A prompt or a tool result: Claude is working out what to do next.
  if (last?.role === 'user' || hasResults) return { kind: 'thinking', at: lineTime(line) };
  // Thinking blocks are not chat messages; a cheap check avoids parsing every line again.
  if (line.includes('"type":"thinking"') && line.includes('"type":"assistant"')) {
    return { kind: 'thinking', at: lineTime(line) };
  }
  return previous;
}

/**
 * User entries that Claude Code writes without starting a turn: a local slash command and its
 * output (`/model`, `/effort`), a `!` shell command. A skill's `<command-message>` line is
 * followed by its prompt as a meta entry, and that one does start the turn.
 */
const NOT_A_TURN =
  /^\s*<(command-name|command-message|local-command-|bash-input|bash-stdout|bash-stderr)/;

/** The text a user entry starts with, if any. */
function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: string; text?: unknown } | undefined;
  return first?.type === 'text' && typeof first.text === 'string' ? first.text : undefined;
}

/**
 * Whether the main thread's turn is over after a transcript line. Claude Code keeps its
 * status "busy" for as long as any background agent or task runs, even after its reply; the
 * session file can't tell the two apart, so the transcript does (2026-10-04: the phone said
 * "Working…" for an hour while Claude was waiting for the user). The turn is over at a main
 * thread reply that ended with `end_turn` (or an interrupt), and open again at anything that
 * starts one: a prompt, a peer or task-notification message, a tool result, a queued command.
 * Subagent (sidechain) entries and bookkeeping lines leave it as it was.
 */
function turnAfter(previous: TurnEnd | undefined, line: string): TurnEnd | undefined {
  // Most lines are bookkeeping (titles, modes, hooks): skip them without parsing.
  if (
    !line.includes('"type":"assistant"') &&
    !line.includes('"type":"user"') &&
    !line.includes('"queued_command"') &&
    !line.includes('"turn_duration"')
  ) {
    return previous;
  }
  let entry: {
    type?: string;
    subtype?: string;
    isSidechain?: boolean;
    timestamp?: string;
    attachment?: { type?: string };
    message?: { stop_reason?: unknown; content?: unknown };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return previous;
  }
  if (entry.isSidechain) return previous;
  const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
  const ended = { at: Number.isNaN(at) ? undefined : at };
  if (entry.type === 'assistant') {
    const reason = entry.message?.stop_reason;
    if (typeof reason === 'string' && !KNOWN_STOP_REASONS.has(reason)) {
      noteFormatSurprise(`stop_reason:${reason}`, `a reply ended with stop_reason "${reason}"`);
    }
    return reason === 'end_turn' ? ended : undefined;
  }
  // Claude Code closes every main-thread turn with one of these (2026-10-20 review): a turn
  // that ends some other way than end_turn is still over.
  if (entry.type === 'system' && entry.subtype === 'turn_duration') return ended;
  if (entry.type === 'user') {
    const text = userText(entry.message?.content);
    if (text !== undefined && text.startsWith('[Request interrupted by user')) return ended;
    if (text !== undefined && NOT_A_TURN.test(text)) return previous;
    return undefined;
  }
  if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') return undefined;
  return previous;
}

/**
 * The API error the main thread's last turn ended on, after a transcript line: set by an
 * `isApiErrorMessage` entry, cleared by any other main-thread reply or prompt (it went on).
 */
function apiErrorAfter(
  previous: TranscriptApiError | undefined,
  line: string
): TranscriptApiError | undefined {
  if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) return previous;
  let entry: {
    type?: string;
    isSidechain?: boolean;
    isApiErrorMessage?: boolean;
    isMeta?: boolean;
    error?: unknown;
    timestamp?: string;
    message?: { content?: unknown };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return previous;
  }
  if (entry.isSidechain || entry.isMeta) return previous;
  if (entry.type === 'assistant' && entry.isApiErrorMessage) {
    const content = entry.message?.content;
    const text = Array.isArray(content)
      ? content
          .map((part: { type?: string; text?: unknown }) =>
            part?.type === 'text' && typeof part.text === 'string' ? part.text : ''
          )
          .join(' ')
          .trim()
      : typeof content === 'string'
        ? content.trim()
        : '';
    const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    return {
      error: typeof entry.error === 'string' ? entry.error : 'unknown',
      text: text.slice(0, 500),
      ...(Number.isNaN(at) ? {} : { at }),
    };
  }
  if (entry.type === 'assistant') return undefined;
  if (entry.type === 'user') {
    const text = userText(entry.message?.content);
    // A tool result or a local command is no new turn; a prompt is.
    if (text === undefined || NOT_A_TURN.test(text)) return previous;
    return undefined;
  }
  return previous;
}

/** The API error these transcript lines end on, if any (exported for tests). */
export function apiErrorFromLines(lines: string[]): TranscriptApiError | undefined {
  let error: TranscriptApiError | undefined;
  for (const line of lines) error = apiErrorAfter(error, line);
  return error;
}

/**
 * The API error the last turn of the conversation `rootPid` runs ended on: null when it ended
 * on none, undefined when its transcript can't be read (no Claude there).
 */
export async function readClaudeTurnError(
  rootPid: number,
  claudeDir = claudeConfigDir()
): Promise<TranscriptApiError | null | undefined> {
  const { starts, trees } = await claudeCandidates([rootPid], claudeDir);
  for (const pid of trees.get(rootPid) ?? []) {
    const session = readSessionFile(claudeDir, pid, starts);
    if (!session?.sessionId || !session.cwd) continue;
    const transcriptPath = cachedFindTranscript(claudeDir, session.cwd, session.sessionId);
    if (!transcriptPath) return undefined;
    try {
      return readTranscript(transcriptPath).apiError ?? null;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Whether a main-thread turn ends anywhere in these lines (the doctor's compatibility probe). */
export function turnEndSeen(lines: string[]): boolean {
  let turn: TurnEnd | undefined;
  for (const line of lines) {
    turn = turnAfter(turn, line);
    if (turn) return true;
  }
  return false;
}

/** Whether these transcript lines end with the main thread's turn over (exported for tests). */
export function turnEndedFromLines(lines: string[]): boolean {
  let turn: TurnEnd | undefined;
  for (const line of lines) turn = turnAfter(turn, line);
  return turn !== undefined;
}

/**
 * Busy only because of background work: the turn ended after Claude became busy. A turn that
 * ended before then is the previous one, still the transcript's tail for a moment after a new
 * prompt (and up to PREVIEW_TTL_MS in the cached summaries).
 */
function waitingForBackground(session: ClaudeSessionFile, turnEnded: TurnEnd | undefined): boolean {
  if (session.backgroundShell) return true;
  if (session.status !== 'busy' || !turnEnded) return false;
  const busySince = session.statusUpdatedAt;
  return typeof busySince !== 'number' || turnEnded.at === undefined || turnEnded.at >= busySince;
}

const ACTIVITY_TARGET_MAX = 60;

function activityTarget(tool: ClaudeChatMessage): string | undefined {
  let target = tool.text;
  if (tool.tool === 'WebFetch' && target) {
    try {
      target = new URL(target).host || target;
    } catch {
      // not a URL: keep the text
    }
  }
  if (tool.tool === 'TodoWrite') return undefined;
  target = target.replace(/\s+/g, ' ').trim();
  if (!target) return undefined;
  return target.length > ACTIVITY_TARGET_MAX
    ? `${target.slice(0, ACTIVITY_TARGET_MAX - 1)}…`
    : target;
}

function activityOf(step: TranscriptStep | undefined): ClaudeActivity | undefined {
  if (!step) return undefined;
  if (step.kind !== 'tool') return { kind: step.kind, since: step.at };
  const at = step.tool.timestamp ? Date.parse(step.tool.timestamp) : Number.NaN;
  const since = Number.isNaN(at) ? undefined : at;
  // The result arrived but no later line yet (should not last): Claude reads it.
  if (step.tool.result !== undefined) return { kind: 'thinking', since };
  return { kind: 'tool', tool: step.tool.tool, target: activityTarget(step.tool), since };
}

/** Live activity at the end of these transcript lines (exported for tests). */
export function activityFromLines(lines: string[]): ClaudeActivity | undefined {
  const tools = new Map<string, ClaudeChatMessage>();
  const conversation: ClaudeChatMessage[] = [];
  let step: TranscriptStep | undefined;
  for (const line of lines) {
    const messages = parseTranscriptLine(line);
    conversation.push(...messages);
    for (const message of messages) if (message.toolUseId) tools.set(message.toolUseId, message);
    const results = parseToolResults(line);
    for (const result of results) {
      const tool = tools.get(result.toolUseId);
      if (tool) tool.result = result.text;
    }
    step = nextStep(step, line, messages, results.length > 0, conversation);
  }
  return activityOf(step);
}

/** Read the Claude Code conversation running inside the process tree of `rootPid`. */
/**
 * Right after Claude turns busy the transcript may still end with the previous turn's last
 * step: don't time it from then ("Writing… · 2h 5m"); start from when Claude became busy.
 */
function currentTurn<T extends { since?: number }>(
  activity: T | undefined,
  busySince: number | undefined
): T | undefined {
  if (!activity || typeof busySince !== 'number') return activity;
  return activity.since !== undefined && activity.since < busySince
    ? { ...activity, since: busySince }
    : activity;
}

export async function readClaudeChat(
  rootPid: number,
  claudeDir = claudeConfigDir()
): Promise<ClaudeChat> {
  const { starts, trees } = await claudeCandidates([rootPid], claudeDir);
  for (const pid of trees.get(rootPid) ?? []) {
    const session = readSessionFile(claudeDir, pid, starts);
    if (!session?.sessionId || !session.cwd) continue;
    const transcriptPath = cachedFindTranscript(claudeDir, session.cwd, session.sessionId);
    const transcript = transcriptPath ? readTranscript(transcriptPath) : null;
    const background = waitingForBackground(session, transcript?.turnEnded);
    return {
      available: true,
      status: session.status,
      waitingFor: session.status === 'waiting' ? session.waitingFor : undefined,
      title: transcript?.title,
      activity:
        session.status === 'busy' && !background
          ? currentTurn(activityOf(transcript?.lastStep), session.statusUpdatedAt)
          : undefined,
      ...(background ? { waitingForBackground: true } : {}),
      messages: transcript?.messages ?? [],
    };
  }
  return { available: false, messages: [] };
}

export interface ClaudeStatus {
  status: string;
  waitingFor?: string;
  /** Claude Code conversation id (for `claude --resume`). */
  sessionId?: string;
  /** Conversation title Claude Code generated (ai-title). */
  title?: string;
  /** Last user or assistant message, one line, for session list previews. */
  preview?: { role: 'user' | 'assistant'; text: string };
  /** When the current status began (epoch ms): tells two identical prompts apart. */
  since?: number;
  /** While busy: what Claude is doing right now (from the transcript tail). */
  activity?: ClaudeActivity;
  /** Busy only because background agents or tasks run: the reply is over (see turnAfter). */
  waitingForBackground?: boolean;
  /** The Claude Code process (its pid) and the version it started as (claude-update-restart). */
  pid?: number;
  version?: string;
  /** When the Claude Code process started (epoch ms, its sessions/<pid>.json). */
  startedAt?: number;
}

const PREVIEW_MAX_LENGTH = 160;
const PREVIEW_TTL_MS = 2500;
const previewCache = new Map<
  string,
  {
    at: number;
    title?: string;
    preview?: ClaudeStatus['preview'];
    activity?: ClaudeActivity;
    turnEnded?: TurnEnd;
  }
>();

/**
 * A table's rows as their cells ("C · 1972"), its delimiter row dropped, rows joined by "; ".
 * Flattened to one line as markdown, a table read "| Lenguaje | Año | |---|---| | C | 1972 |"
 * in the session list and in pushes (2026-10-03).
 */
function tablesAsText(markdown: string): string {
  const out: string[] = [];
  let rows: string[] = [];
  const flush = () => {
    if (rows.length > 0) out.push(rows.join('; '));
    rows = [];
  };
  for (const line of markdown.split('\n')) {
    const row = line.match(/^\s*\|(.*)\|\s*$/);
    if (!row) {
      flush();
      out.push(line);
    } else if (!/^[\s|:-]*$/.test(row[1])) {
      const cells = row[1].split('|').map((cell) => cell.trim());
      rows.push(cells.filter(Boolean).join(' · '));
    }
  }
  flush();
  return out.join('\n');
}

/** One line of plain text for a list preview: markdown markup removed, whitespace collapsed. */
export function plainPreview(markdown: string): string {
  return tablesAsText(markdown)
    .replace(/^\s*[-*•+]\s+/gm, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Title and last message of a transcript, re-read at most every couple of seconds. */
function transcriptSummary(transcriptPath: string) {
  const cached = previewCache.get(transcriptPath);
  if (cached && Date.now() - cached.at < PREVIEW_TTL_MS) return cached;
  let transcript: TranscriptCache;
  try {
    transcript = readTranscript(transcriptPath);
  } catch {
    return cached ?? { at: Date.now() };
  }
  let preview: ClaudeStatus['preview'];
  for (let i = transcript.messages.length - 1; i >= 0; i--) {
    const message = transcript.messages[i];
    if ((message.role === 'user' || message.role === 'assistant') && message.text.trim()) {
      const text = plainPreview(message.text);
      preview = {
        role: message.role,
        text: text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH - 1)}…` : text,
      };
      break;
    }
  }
  const summary = {
    at: Date.now(),
    title: transcript.title,
    preview,
    activity: activityOf(transcript.lastStep),
    turnEnded: transcript.turnEnded,
  };
  previewCache.set(transcriptPath, summary);
  if (previewCache.size > MAX_CACHED_TRANSCRIPTS) {
    previewCache.delete(previewCache.keys().next().value as string);
  }
  return summary;
}

/** Claude Code status for each session root pid that runs Claude Code. */
export async function readClaudeStatuses(
  rootPids: number[],
  claudeDir = claudeConfigDir()
): Promise<Map<number, ClaudeStatus>> {
  const statuses = new Map<number, ClaudeStatus>();
  const { starts, trees } = await claudeCandidates(rootPids, claudeDir);
  for (const rootPid of rootPids) {
    for (const pid of trees.get(rootPid) ?? []) {
      const session = readSessionFile(claudeDir, pid, starts);
      if (!session?.status) continue;
      const transcriptPath =
        session.sessionId && session.cwd
          ? cachedFindTranscript(claudeDir, session.cwd, session.sessionId)
          : null;
      const summary = transcriptPath ? transcriptSummary(transcriptPath) : undefined;
      const background = waitingForBackground(session, summary?.turnEnded);
      statuses.set(rootPid, {
        status: session.status,
        waitingFor: session.status === 'waiting' ? session.waitingFor : undefined,
        sessionId: session.sessionId,
        title: summary?.title,
        preview: summary?.preview,
        since: typeof session.statusUpdatedAt === 'number' ? session.statusUpdatedAt : undefined,
        activity:
          session.status === 'busy' && !background
            ? currentTurn(summary?.activity, session.statusUpdatedAt)
            : undefined,
        ...(background ? { waitingForBackground: true } : {}),
        pid,
        ...(typeof session.version === 'string' ? { version: session.version } : {}),
        ...(typeof session.startedAt === 'number' ? { startedAt: session.startedAt } : {}),
      });
      break;
    }
  }
  return statuses;
}

/**
 * Claude Code's status as typing into it sees it: a turn that ended with background work still
 * running has its prompt free, so it reads "idle" (2026-10-20: queued input and orchestrator
 * events waited forever behind a serial monitor left running).
 */
export function promptStatus(claude: ClaudeStatus | undefined): string | undefined {
  return claude?.waitingForBackground ? 'idle' : claude?.status;
}

/** The whole text of the last reply of the conversation `rootPid` runs. */
export async function readLastReply(
  rootPid: number,
  claudeDir = claudeConfigDir()
): Promise<string | undefined> {
  const chat = await readClaudeChat(rootPid, claudeDir);
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const message = chat.messages[i];
    if (message.role === 'assistant' && message.text.trim()) return message.text.trim();
    if (message.role === 'user' && message.text.trim()) return undefined;
  }
  return undefined;
}

/**
 * The Claude Code conversation each session root pid runs (from Claude's own
 * `sessions/<pid>.json`), without reading any transcript: the background recorder's cheap look.
 */
export async function readClaudeSessionIds(
  rootPids: number[],
  claudeDir = claudeConfigDir()
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  if (rootPids.length === 0) return ids;
  const { starts, trees } = await claudeCandidates(rootPids, claudeDir);
  for (const rootPid of rootPids) {
    for (const pid of trees.get(rootPid) ?? []) {
      const sessionId = readSessionFile(claudeDir, pid, starts)?.sessionId;
      if (!sessionId) continue;
      ids.set(rootPid, sessionId);
      break;
    }
  }
  return ids;
}

/**
 * Codex started inside a shell session: `codex` typed at a zsh prompt is not the session's
 * command, so it is found in the session's process tree instead (like Claude Code). Its
 * working directory and start time then pick its rollout, exactly as for a session started
 * with `codex` directly.
 *
 * The npm package runs as `node …/bin/codex` and spawns the native `…/vendor/…/codex/codex`
 * (checked on macOS with Codex 0.155, 2026-10-02); either one is enough.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import type { SessionMultiplexer } from '../../shared/types.js';
import { descendants, type ProcessTable, processTable } from './claude-chat.js';
import { type CodexSessionRef, forgetCodexSession, isCodexCommand } from './codex-chat.js';
import { agentExecutable } from './task-launcher.js';

const execFileAsync = promisify(execFile);

/** Codex subcommands that don't open the TUI (no chat to show for them). */
const NON_INTERACTIVE = new Set([
  'exec',
  'e',
  'app-server',
  'mcp',
  'mcp-server',
  'login',
  'logout',
  'completion',
  'apply',
  'a',
  'sandbox',
  'debug',
  'cloud',
  'proto',
  'help',
  '--version',
  '-V',
  '--help',
  '-h',
]);

/**
 * Top-level Codex options that take a separate value (`-m o3`): the value is not the
 * subcommand. From the `codex` help text (Codex 0.155, 2026-10-02); `--opt=value` needs no
 * entry, and flags such as `--oss` or `--search` take no value.
 */
const OPTIONS_WITH_VALUE = new Set([
  '-m',
  '--model',
  '-c',
  '--config',
  '-p',
  '--profile',
  '-C',
  '--cd',
  '-s',
  '--sandbox',
  '-a',
  '--ask-for-approval',
  '-i',
  '--image',
  '--add-dir',
  '--local-provider',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
]);

/** Where the subcommand (or prompt) word of Codex's arguments is; options and values skipped. */
function codexSubcommandIndex(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (NON_INTERACTIVE.has(word)) return i;
    if (OPTIONS_WITH_VALUE.has(word)) {
      i++;
      continue;
    }
    if (!word.startsWith('-')) return i;
  }
  return -1;
}

/** The subcommand (or prompt) word of Codex's arguments, skipping options and their values. */
function codexSubcommand(args: string[]): string | undefined {
  return args[codexSubcommandIndex(args)];
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a word is a Codex thread id (a UUID; `codex resume` also takes names, never used here). */
export function isCodexThreadId(word: unknown): word is string {
  return typeof word === 'string' && THREAD_ID.test(word);
}

/** Where Codex's own arguments start in a command line: past `env VAR=…` and `node`/`bun`. */
function codexArgsIndex(words: readonly string[]): number {
  let { index } = agentExecutable(words);
  if (/^(node\d*|bun)$/.test(base(words[index]))) {
    index = words.findIndex((word, i) => i > index && !word.startsWith('-'));
    if (index < 0) return -1;
  }
  const name = base(words[index]);
  return name === 'codex' || name === 'codex.js' ? index + 1 : -1;
}

/**
 * The thread `codex resume <id>` continues (an argv, or the words of a `ps` line), if any:
 * `codex resume --no-alt-screen <id>`, `node …/bin/codex -m o3 resume <id> --search`. A resumed
 * Codex writes on in the thread's first rollout, which is older than the session: its start
 * time finds nothing (checked with Codex 0.164, 2026-11-10), the command says which it is.
 */
export function codexResumeTarget(words: readonly unknown[] | undefined): string | null {
  if (!Array.isArray(words) || words.some((word) => typeof word !== 'string')) return null;
  const start = codexArgsIndex(words as string[]);
  if (start < 0) return null;
  const args = (words as string[]).slice(start);
  const subcommand = codexSubcommandIndex(args);
  if (args[subcommand] !== 'resume') return null;
  const target = args[subcommand + 1 + codexSubcommandIndex(args.slice(subcommand + 1))];
  return isCodexThreadId(target) ? target.toLowerCase() : null;
}

/**
 * Codex's alternate screen has no history and no mouse reporting (checked on codex-cli 0.164),
 * so a session could not be scrolled at all: its wheel and swipes had nothing to move
 * (user report, 2026-11-09). Inline, the conversation goes into the terminal's own history.
 */
export const CODEX_INLINE_FLAG = '--no-alt-screen';

/**
 * Every Codex TUI Untether starts runs inline: applied where a session's command is resolved
 * (PtyManager.resolveSpawn), so new sessions, tasks, orchestrators and restores all get it.
 * `resume` and `fork` take the flag themselves: they have their own, separate from the root's.
 * A shell wrapping Codex (`zsh -c "… codex"`) and non-interactive subcommands are left alone.
 */
export function codexInlineCommand(command: string[]): string[] {
  const { index, name } = agentExecutable(command);
  if (name !== 'codex' || command.includes(CODEX_INLINE_FLAG)) return command;
  const args = command.slice(index + 1);
  const subcommand = codexSubcommandIndex(args);
  const word = args[subcommand];
  if (word !== undefined && NON_INTERACTIVE.has(word)) return command;
  const after = word === 'resume' || word === 'fork' ? index + 1 + subcommand : index;
  return [...command.slice(0, after + 1), CODEX_INLINE_FLAG, ...command.slice(after + 1)];
}

const base = (word: string | undefined) => (word ?? '').split('/').pop()?.toLowerCase() ?? '';

/** Whether a `ps` command line is an interactive Codex CLI (native binary or npm launcher). */
export function isCodexProcessArgs(args: string): boolean {
  const words = args.trim().split(/\s+/);
  let rest: string[];
  if (base(words[0]) === 'codex') {
    rest = words.slice(1);
  } else if (/^(node\d*|bun)$/.test(base(words[0]))) {
    const scriptIndex = words.findIndex((word, i) => i > 0 && !word.startsWith('-'));
    if (scriptIndex < 0) return false;
    const script = words[scriptIndex];
    const isCodex =
      base(script) === 'codex' ||
      (base(script) === 'codex.js' && script.includes('/@openai/codex/'));
    if (!isCodex) return false;
    rest = words.slice(scriptIndex + 1);
  } else {
    return false;
  }
  const subcommand = codexSubcommand(rest);
  return !subcommand || !NON_INTERACTIVE.has(subcommand);
}

/** The first Codex process under `rootPid` (breadth first: the launcher before its child). */
export function findCodexPid(table: ProcessTable, rootPid: number): number | undefined {
  return findAgentPid(table, rootPid, isCodexProcessArgs);
}

/** `ps` lstart (rendered in UTC) as epoch ms. */
export function parseUtcStart(start: string | undefined): number | undefined {
  if (!start) return undefined;
  const at = Date.parse(`${start} UTC`);
  return Number.isNaN(at) ? undefined : at;
}

/** Working directory of a process (macOS: lsof; Linux: /proc). */
export async function processCwd(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      timeout: 5000,
    });
    const line = stdout.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

export interface CodexProcessDeps {
  table: () => Promise<ProcessTable>;
  cwdOf: (pid: number) => Promise<string | null>;
}

const defaultDeps: CodexProcessDeps = { table: processTable, cwdOf: processCwd };

/** A process keeps its pid and start time; its cwd is looked up once (lsof is slow). */
const cwdCache = new Map<string, string>();

export interface CodexProcess {
  pid: number;
  startedAt: number;
  cwd: string;
  /** Its `ps` command line. */
  args: string;
}

/** The first process under `rootPid` (breadth first) whose `ps` args satisfy `isAgent`. */
export function findAgentPid(
  table: ProcessTable,
  rootPid: number,
  isAgent: (args: string) => boolean
): number | undefined {
  for (const pid of descendants(table, rootPid)) {
    const args = table.args.get(pid);
    if (args && isAgent(args)) return pid;
  }
  return undefined;
}

/**
 * Claims made under a process id (processClaimId), with how to give each back. Each rollout or
 * chat file goes to one claimer at a time; a process that is gone no longer needs its own.
 */
const processClaims = new Map<
  string,
  { pid: number; startedAt: number; release: (id: string) => void }
>();

/** Gives back the claims of processes no longer in `table` (ended, or their pid reused). */
export function releaseEndedClaims(table: ProcessTable) {
  for (const [id, claim] of processClaims) {
    if (parseUtcStart(table.starts.get(claim.pid)) === claim.startedAt) continue;
    claim.release(id);
    processClaims.delete(id);
  }
}

/**
 * The id a rollout (or chat file) found from a process is claimed under: the process, not the
 * session that found it. A session attached to a tmux session and the Mac list's read of that
 * pane then get the same one; each took it from the other while claims were per session. Once
 * the process is gone the claim is given back (`release`), so `gemini --resume` run next in the
 * same shell gets the chat its previous run had.
 */
export function processClaimId(
  agent: Omit<CodexProcess, 'args'>,
  release: (id: string) => void
): string {
  const id = `proc:${agent.pid}:${agent.startedAt}`;
  if (!processClaims.has(id)) {
    processClaims.set(id, { pid: agent.pid, startedAt: agent.startedAt, release });
    if (processClaims.size > 200) processClaims.delete(processClaims.keys().next().value as string);
  }
  return id;
}

/** An agent CLI (Codex, Gemini…) running somewhere under `rootPid`, if any. */
export async function findAgentProcess(
  rootPid: number,
  isAgent: (args: string) => boolean,
  deps: CodexProcessDeps = defaultDeps
): Promise<CodexProcess | null> {
  const table = await deps.table();
  releaseEndedClaims(table);
  const pid = findAgentPid(table, rootPid, isAgent);
  if (pid === undefined) return null;
  const start = table.starts.get(pid);
  const startedAt = parseUtcStart(start);
  if (startedAt === undefined) return null;
  const key = `${pid}|${start}`;
  let cwd = cwdCache.get(key);
  if (cwd === undefined) {
    const found = await deps.cwdOf(pid);
    if (!found) return null;
    cwd = found;
    cwdCache.set(key, cwd);
    if (cwdCache.size > 200) cwdCache.delete(cwdCache.keys().next().value as string);
  }
  return { pid, startedAt, cwd, args: table.args.get(pid) ?? '' };
}

/** The interactive Codex running somewhere under `rootPid`, if any. */
export function findCodexProcess(
  rootPid: number,
  deps: CodexProcessDeps = defaultDeps
): Promise<CodexProcess | null> {
  return findAgentProcess(rootPid, isCodexProcessArgs, deps);
}

export interface SessionLike {
  id: string;
  command?: string[];
  workingDir: string;
  startedAt: string;
  pid?: number;
  status?: string;
  /**
   * Attached to a tmux session: its command is `tmux … attach-session`, never the agent, though
   * a socket path or target may contain "codex" or "gemini".
   */
  multiplexer?: SessionMultiplexer;
}

/**
 * What to match a session's Codex rollout with: the session itself when it was started with
 * `codex`, else the Codex process running inside it (a shell where `codex` was typed, or the
 * pane of an attached tmux session). Started as `codex resume <id>`, it says which thread.
 */
export async function codexSessionRef(
  session: SessionLike,
  deps: CodexProcessDeps = defaultDeps
): Promise<CodexSessionRef | null> {
  if (!session.multiplexer && isCodexCommand(session.command)) {
    const resumed = codexResumeTarget(session.command);
    return resumed ? { ...session, resumedThreadId: resumed } : session;
  }
  if (!session.pid || session.status !== 'running') return null;
  const codex = await findCodexProcess(session.pid, deps);
  if (!codex) return null;
  const resumed = codexResumeTarget(codex.args.trim().split(/\s+/));
  return {
    id: processClaimId(codex, forgetCodexSession),
    workingDir: codex.cwd,
    startedAt: new Date(codex.startedAt).toISOString(),
    ...(resumed ? { resumedThreadId: resumed } : {}),
  };
}

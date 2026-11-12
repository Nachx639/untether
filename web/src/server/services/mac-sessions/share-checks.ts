/**
 * Share with phone: the fresh checks run before an agent is closed in its tab, and again
 * after. Each reads the Mac right now (a `ps` of its own, the agent's session file, the tail
 * of its transcript), never a cached scan.
 *
 * - Started from that tab's prompt: the agent leads the tty's foreground process group, and
 *   its parent is a shell on the same tty in a group of its own. Closing it then hands the
 *   prompt back to that shell, where the relaunch line is typed.
 * - Idle: Claude's own session file (`<claudeDir>/sessions/<pid>.json`) says `idle`, for this
 *   process (procStart), started interactively from the CLI.
 * - No background work: no descendant runs a Bash-tool command (its zsh has `shell-snapshots`
 *   in its arguments). Subagents run inside the Claude process and can't be seen this way;
 *   the confirm sheet says they stop.
 * - Flushed: the transcript ends with a newline and its last line is whole JSON.
 * - No draft: the tab's visible prompt holds no unsent text (read from the probe's contents).
 *
 * Probe P1 (2026-10-04, Claude Code 2.1.289 in a pty of ours, idle, `kill -TERM` and then
 * `kill -INT`): both exit in about 1 s (0.93 s and 1.01 s), the session file is gone after
 * 0.33 s, the transcript keeps its bytes and grows by one whole `cost-state` line ending in
 * `\n` (so after the close it is checked to be at least as long, not unchanged), and
 * `~/.claude.json` records `lastGracefulShutdown: true` with that `lastSessionId`. The exit
 * code is 143 for SIGTERM, 0 for SIGINT.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isMacShareConversationId } from '../../../shared/mac-share.js';
import type { ProcessTable } from '../claude-chat.js';
import { ancestors, isForwarderArgs, isTmuxServerProcess } from './process-tree.js';

/** Shells whose tab can take a typed line, from the parent's args[0] (`-zsh`, `/bin/bash`). */
const SHELL_NAMES = new Set(['zsh', 'bash', 'sh', 'dash', 'ksh', 'fish']);
/** Descendants looked at for background work. */
const MAX_DESCENDANTS = 200;

const normalizeStart = (start: string) => start.trim().replace(/\s+/g, ' ');

export interface ShellJob {
  pid: number;
  lstart: string;
  /** "ttys001" as `ps` gives it. */
  tty: string;
  shellPid: number;
  shellPgid: number;
  /** The shell's args[0] (`-zsh`). */
  shellArg0: string;
  /** The agent's own `ps` arguments. */
  args: string;
}

export type ShellJobProblem = 'gone' | 'not-shareable' | 'not-shell-job';

/**
 * The agent `pid` (which must still have started at `lstart`) as the foreground job of an
 * interactive shell on its tty, or why it isn't one.
 */
export function shellJobOf(
  table: ProcessTable,
  pid: number,
  lstart: string
): ShellJob | { problem: ShellJobProblem } {
  if (table.starts.get(pid) !== lstart) return { problem: 'gone' };
  const agent = table.procs.get(pid);
  if (!agent) return { problem: table.extended ? 'gone' : 'not-shareable' };
  const chain = ancestors(table, pid);
  // In tmux, or already under a ut forwarder: not a plain tab's job.
  if (
    chain.some((p) => isTmuxServerProcess(table, p) || isForwarderArgs(table.args.get(p) ?? ''))
  ) {
    return { problem: 'not-shareable' };
  }
  if (!agent.tty) return { problem: 'not-shell-job' };
  const shell = table.procs.get(agent.ppid);
  const shellArgs = table.args.get(agent.ppid) ?? '';
  const shellArg0 = shellArgs.split(' ')[0] ?? '';
  const shellName = path.basename(shellArg0).replace(/^-/, '');
  if (
    !shell ||
    !SHELL_NAMES.has(shellName) ||
    shell.tty !== agent.tty ||
    agent.pgid !== pid ||
    agent.tpgid !== pid ||
    shell.pgid === agent.pgid
  ) {
    return { problem: 'not-shell-job' };
  }
  return {
    pid,
    lstart,
    tty: agent.tty,
    shellPid: agent.ppid,
    shellPgid: shell.pgid,
    shellArg0,
    args: table.args.get(pid) ?? '',
  };
}

/** Whether the shell got its tab's foreground back (after the close, before typing). */
export function shellHasForeground(table: ProcessTable, job: ShellJob): boolean {
  const shell = table.procs.get(job.shellPid);
  return !!shell && shell.tty === job.tty && shell.tpgid === job.shellPgid;
}

/** Whether the agent process is gone: no pid, or a pid that is now another process. */
export function agentGone(table: ProcessTable, pid: number, lstart: string): boolean {
  const start = table.starts.get(pid);
  const info = table.procs.get(pid);
  return start !== lstart || info?.stat.startsWith('Z') === true;
}

/** A Bash-tool command still running under the agent (V7). */
export function hasBackgroundWork(table: ProcessTable, pid: number): boolean {
  const queue = [...(table.children.get(pid) ?? [])];
  let seen = 0;
  while (queue.length > 0 && seen < MAX_DESCENDANTS) {
    const child = queue.shift() as number;
    seen++;
    if ((table.args.get(child) ?? '').includes('/shell-snapshots/')) return true;
    queue.push(...(table.children.get(child) ?? []));
  }
  return false;
}

/** What `<claudeDir>/sessions/<pid>.json` says, for the process that started at `lstart`. */
export interface ClaudeSessionRecord {
  status?: string;
  /** Epoch ms of the last status change. */
  statusUpdatedAt?: number;
  kind?: string;
  entrypoint?: string;
  sessionId?: string;
  cwd?: string;
}

/** Reads the session file of `pid` fresh; null when missing, unreadable or another process's. */
export function readClaudeSessionRecord(
  claudeDir: string,
  pid: number,
  lstart: string
): ClaudeSessionRecord | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(path.join(claudeDir, 'sessions', `${pid}.json`), 'utf8'));
  } catch {
    return null;
  }
  if (typeof data?.procStart !== 'string' || normalizeStart(data.procStart) !== lstart) {
    return null;
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return {
    status: text(data.status),
    statusUpdatedAt: typeof data.statusUpdatedAt === 'number' ? data.statusUpdatedAt : undefined,
    kind: text(data.kind),
    entrypoint: text(data.entrypoint),
    sessionId: text(data.sessionId),
    cwd: text(data.cwd),
  };
}

export type IdleProblem = 'busy' | 'waiting' | 'no-conversation' | 'not-shareable';

/** Whether a session record is an interactive CLI Claude, idle, with a conversation id. */
export function idleProblem(record: ClaudeSessionRecord | null): IdleProblem | undefined {
  if (!record) return 'busy';
  if (record.kind !== undefined && record.kind !== 'interactive') return 'not-shareable';
  if (record.entrypoint !== undefined && record.entrypoint !== 'cli') return 'not-shareable';
  if (record.status === 'waiting') return 'waiting';
  if (record.status !== 'idle') return 'busy';
  if (!isMacShareConversationId(record.sessionId)) return 'no-conversation';
  return undefined;
}

export interface TranscriptState {
  size: number;
  /** Ends with `\n`, and its last line is whole JSON (of this conversation when it says). */
  flushed: boolean;
}

/** The transcript's size and whether it is flushed; null when there is none. */
export function transcriptState(file: string, conversationId: string): TranscriptState | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    if (size === 0) return { size, flushed: false };
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const tail = buffer.toString('utf8');
    if (!tail.endsWith('\n')) return { size, flushed: false };
    const lines = tail.slice(0, -1).split('\n');
    const last = lines[lines.length - 1];
    // A tail cut mid-line is fine: only the last line matters, and it is whole here.
    if (lines.length < 2 && length < size) return { size, flushed: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(last);
    } catch {
      return { size, flushed: false };
    }
    const id = (parsed as { sessionId?: unknown } | null)?.sessionId;
    return { size, flushed: id === undefined || id === conversationId };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Claude's transcript of a conversation: under its folder's project, else any project. */
export function claudeTranscriptPath(
  claudeDir: string,
  cwd: string,
  conversationId: string
): string | null {
  if (!isMacShareConversationId(conversationId)) return null;
  const projects = path.join(claudeDir, 'projects');
  const direct = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${conversationId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const dir of fs.readdirSync(projects)) {
      const candidate = path.join(projects, dir, `${conversationId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // No projects folder.
  }
  return null;
}

const RULE = /^\s*[╭╰]?─{8,}[╮╯]?\s*$/;
const PROMPT = /^\s*│?\s*[❯>][\s ]?(.*?)\s*│?\s*$/;

/**
 * Unsent text in Claude's input box on the tab's visible screen: the last `❯` line between
 * two horizontal rules (older versions: a box with `>`), and the lines under it up to the
 * rule. An empty prompt is `❯` and a no-break space. Placeholder text on an empty prompt would
 * read as a draft: none showed in P1 after a turn (2.1.289), but a brand-new session may have
 * one; the owner prefers a refusal to a lost draft. Contents that don't show the box (an
 * alternate screen Terminal doesn't report) answer false: nothing can be told.
 */
export function hasPromptDraft(contents: string | undefined): boolean {
  if (!contents) return false;
  const lines = contents.replace(/\r/g, '').split('\n');
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE.test(lines[i])) {
      bottom = i;
      break;
    }
  }
  if (bottom < 0) return false;
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    if (RULE.test(lines[i])) {
      top = i;
      break;
    }
  }
  if (top < 0) return false;
  const inside = lines.slice(top + 1, bottom);
  const promptIndex = inside.findIndex((line) => PROMPT.test(line));
  if (promptIndex < 0) {
    // A rule pair without a prompt (the status area): try the box above it.
    return hasPromptDraft(lines.slice(0, top + 1).join('\n'));
  }
  const first = PROMPT.exec(inside[promptIndex])?.[1] ?? '';
  const rest = inside.slice(promptIndex + 1).map((line) => line.replace(/^\s*│?|│?\s*$/g, ''));
  return [first, ...rest].some((text) => text.replace(/[\s ]/g, '') !== '');
}

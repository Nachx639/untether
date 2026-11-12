/**
 * Mac Sessions: the Claude Code, Codex and Gemini processes running on this computer outside
 * Untether, and their live status from the same readers Untether sessions use.
 *
 * - Claude: one <Claude dir>/sessions/<pid>.json per running claude (never the <pid>.<hash>.key
 *   files next to them), kept only while that pid is the user's and started when the file says
 *   (procStart), so a file left by a crash is never taken for a new process with its pid.
 * - Codex and Gemini: their command lines in the process table; of a launcher and the native
 *   binary it runs, only the launcher. Their folder comes from one lsof for all new pids.
 * Agents without a terminal, and Claudes not started from the CLI (an SDK bot), are left out
 * unless macSessionsIncludeHeadless is set. A process whose environment has
 * UNTETHER_SESSION_ID belongs to another Untether instance: only that name's presence is
 * checked, and environment text is never kept, logged or returned.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  MacAgentKind,
  MacAgentStatus,
  MacLiveConversation,
} from '../../../shared/mac-sessions.js';
import { claudeConfigDir } from '../../utils/claude-dir.js';
import {
  type ClaudeChatMessage,
  type ClaudeStatus,
  type ProcessTable,
  plainPreview,
  readClaudeStatuses,
} from '../claude-chat.js';
import {
  type CodexChat,
  type CodexSessionRef,
  defaultCodexDir,
  findCodexRollout,
  forgetCodexSession,
  readCodexChat,
} from '../codex-chat.js';
import {
  isCodexProcessArgs,
  parseUtcStart,
  processClaimId,
  releaseEndedClaims,
} from '../codex-process.js';
import { codexIdFromRollout } from '../codex-thread.js';
import {
  forgetGeminiSession,
  type GeminiChat,
  type GeminiSessionRef,
  readGeminiChat,
} from '../gemini-chat.js';
import { isGeminiProcessArgs } from '../gemini-process.js';
import { parseLsofCwds } from '../preview-candidates.js';
import {
  assertRealScanAllowed,
  classifyProcess,
  hostAppOf,
  isOwnShieldSocket,
  type OwnershipContext,
  type ProcessOwner,
} from './process-tree.js';

/** An agent process: its pid and start time name it, even once the pid is reused. */
export interface MacAgentProcess {
  agent: MacAgentKind;
  pid: number;
  /** ps lstart, normalized (UTC). */
  lstart: string;
  startSec: number;
  /** ISO time it started. */
  startedAt: string;
  tty: string | null;
  cwd?: string;
  /** Claude's conversation (sessionId). */
  conversationId?: string;
  /** The Claude dir its session file is in. */
  claudeDir?: string;
}

/** Where an agent outside Untether runs: a tmux pane, or an app's terminal. */
export type MacAgentOwner = Exclude<ProcessOwner, { owner: 'untether' }>;

export interface PlacedAgent extends MacAgentProcess {
  owner: MacAgentOwner;
}

/** What an agent's row shows about it, read from its own pid (never the pane's). */
export interface MacAgentState {
  status?: MacAgentStatus;
  title?: string;
  conversationId?: string;
}

interface ClaudeSessionFile {
  pid: number;
  lstart: string;
  sessionId?: string;
  cwd?: string;
  entrypoint?: string;
}

const SESSION_FILE = /^(\d+)\.json$/;
const PREVIEW_MAX_LENGTH = 160;

const normalizeStart = (start: string) => start.trim().replace(/\s+/g, ' ');
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

function isUsersProcess(table: ProcessTable, pid: number, uid: number): boolean {
  const info = table.procs.get(pid);
  return !!info && info.uid === uid && !info.stat.startsWith('Z');
}

/**
 * The session files of the user's running Claudes, read in `claudeDir`/sessions. Only
 * `<pid>.json` is ever opened, and only for a pid that runs and started at its procStart.
 */
export async function readClaudeSessionFiles(
  table: ProcessTable,
  uid: number,
  claudeDir: string
): Promise<ClaudeSessionFile[]> {
  const dir = path.join(claudeDir, 'sessions');
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const files: ClaudeSessionFile[] = [];
  for (const name of names) {
    const pid = Number(SESSION_FILE.exec(name)?.[1]);
    const lstart = table.starts.get(pid);
    if (!pid || !lstart || !isUsersProcess(table, pid, uid)) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    // A file left behind by a claude that crashed names a pid some other process may have now.
    if (typeof data?.procStart !== 'string' || normalizeStart(data.procStart) !== lstart) continue;
    files.push({
      pid,
      lstart,
      sessionId: text(data.sessionId),
      cwd: text(data.cwd),
      entrypoint: text(data.entrypoint),
    });
  }
  return files;
}

function processOf(
  table: ProcessTable,
  agent: MacAgentKind,
  pid: number
): MacAgentProcess | undefined {
  const lstart = table.starts.get(pid);
  const startedAt = parseUtcStart(lstart);
  if (!lstart || startedAt === undefined) return undefined;
  return {
    agent,
    pid,
    lstart,
    startSec: Math.floor(startedAt / 1000),
    startedAt: new Date(startedAt).toISOString(),
    tty: table.procs.get(pid)?.tty ?? null,
  };
}

const AGENT_ARGS: Array<[MacAgentKind, (args: string) => boolean]> = [
  ['codex', isCodexProcessArgs],
  ['gemini', isGeminiProcessArgs],
];

/** The interactive Codex and Gemini processes of the user: a launcher, not the binary it runs. */
function cliAgentProcesses(table: ProcessTable, uid: number): MacAgentProcess[] {
  const found: MacAgentProcess[] = [];
  for (const [pid, args] of table.args) {
    const kind = AGENT_ARGS.find(([, matches]) => matches(args));
    if (!kind || !isUsersProcess(table, pid, uid)) continue;
    const parentArgs = table.args.get(table.procs.get(pid)?.ppid ?? 0);
    if (parentArgs && kind[1](parentArgs)) continue;
    const agent = processOf(table, kind[0], pid);
    if (agent) found.push(agent);
  }
  return found;
}

/** The last thing said in a conversation, on one line, for the row. */
function previewOf(messages: readonly ClaudeChatMessage[]): MacAgentStatus['preview'] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if ((message.role === 'user' || message.role === 'assistant') && message.text.trim()) {
      const line = plainPreview(message.text);
      return {
        role: message.role,
        text: line.length > PREVIEW_MAX_LENGTH ? `${line.slice(0, PREVIEW_MAX_LENGTH - 1)}…` : line,
      };
    }
  }
  return undefined;
}

export interface AgentFinderDeps {
  uid: number;
  /** claudeConfigDir() unless given. */
  claudeDir?: () => string;
  /** The working folders of Codex and Gemini processes (one batched lsof, or /proc). */
  cwdsOf(pids: number[]): Promise<Map<number, string>>;
  /** Of these pids, the ones whose environment has UNTETHER_SESSION_ID. */
  untetherEnvOf(pids: number[], table: ProcessTable): Promise<Set<number>>;
  /** Claude Code's status of a claude process (readClaudeStatuses). */
  claudeStatus(pid: number, claudeDir: string): Promise<ClaudeStatus | undefined>;
  codexChat(ref: CodexSessionRef): CodexChat;
  /** Codex's thread id for a process started in `cwd` at `startedAt` (epoch ms). */
  codexThreadId(cwd: string, startedAt: number): string | null;
  geminiChat(ref: GeminiSessionRef): GeminiChat;
}

const MAX_CACHED = 500;

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.set(key, value);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
}

/** Finds the agents and reads their status; it keeps what can't change for a process. */
export class MacAgentFinder {
  /** Per process (pid and start time): its folder, and whether it is another Untether's. */
  private readonly cwds = new Map<string, string>();
  private readonly untetherEnv = new Map<string, boolean>();
  private readonly threadIds = new Map<string, { at: number; id: string | null }>();

  constructor(
    private readonly deps: AgentFinderDeps,
    private readonly now: () => number = Date.now
  ) {}

  claudeDir(): string {
    return (this.deps.claudeDir ?? claudeConfigDir)();
  }

  /**
   * The user's agents running now. Without the extended ps columns nothing can be told about
   * terminals and owners: none (the scan says it is partial).
   */
  async find(
    table: ProcessTable,
    options: { includeHeadless: boolean }
  ): Promise<MacAgentProcess[]> {
    // A Codex or Gemini that ended gives its file back: run again in the same terminal (`gemini
    // --resume`), the new process reads the same chat.
    releaseEndedClaims(table);
    if (!table.extended) return [];
    const claudeDir = this.claudeDir();
    const agents: MacAgentProcess[] = [];
    for (const file of await readClaudeSessionFiles(table, this.deps.uid, claudeDir)) {
      const agent = processOf(table, 'claude', file.pid);
      if (!agent) continue;
      const headless =
        agent.tty === null || (file.entrypoint !== undefined && file.entrypoint !== 'cli');
      if (headless && !options.includeHeadless) continue;
      agents.push({ ...agent, cwd: file.cwd, conversationId: file.sessionId, claudeDir });
    }
    const others = cliAgentProcesses(table, this.deps.uid).filter(
      (agent) => agent.tty !== null || options.includeHeadless
    );
    const key = (agent: MacAgentProcess) => `${agent.pid}|${agent.lstart}`;
    const unknown = others.filter((agent) => !this.cwds.has(key(agent)));
    if (unknown.length > 0) {
      const found = await this.deps.cwdsOf(unknown.map((agent) => agent.pid)).catch(() => null);
      for (const agent of unknown) {
        const cwd = found?.get(agent.pid);
        if (cwd) remember(this.cwds, key(agent), cwd);
      }
    }
    for (const agent of others) agents.push({ ...agent, cwd: this.cwds.get(key(agent)) });
    return agents;
  }

  /**
   * The agents that are not Untether's, each with where it runs (classifyProcess). A tmux
   * pane decides before the environment, which panes inherit from the shell that started their
   * tmux server; of the others, those with UNTETHER_SESSION_ID are another instance's.
   */
  async outsideUntether(
    agents: MacAgentProcess[],
    table: ProcessTable,
    ctx: OwnershipContext
  ): Promise<PlacedAgent[]> {
    const placed: PlacedAgent[] = [];
    for (const agent of agents) {
      const owner = classifyProcess(table, agent.pid, ctx);
      if (owner.owner !== 'untether') placed.push({ ...agent, owner });
    }
    const key = (agent: MacAgentProcess) => `${agent.pid}|${agent.lstart}`;
    const unknown = placed.filter(
      (agent) => agent.owner.owner === 'mac' && !this.untetherEnv.has(key(agent))
    );
    if (unknown.length > 0) {
      const marked = await this.deps
        .untetherEnvOf(
          unknown.map((agent) => agent.pid),
          table
        )
        .catch(() => new Set<number>());
      for (const agent of unknown) remember(this.untetherEnv, key(agent), marked.has(agent.pid));
    }
    return placed.filter(
      (agent) => agent.owner.owner !== 'mac' || !this.untetherEnv.get(key(agent))
    );
  }

  /** Status, title and conversation of an agent, read from its own pid. */
  async state(agent: MacAgentProcess): Promise<MacAgentState> {
    if (agent.agent === 'claude') {
      const claude = await this.deps.claudeStatus(agent.pid, agent.claudeDir ?? this.claudeDir());
      if (!claude) return { conversationId: agent.conversationId };
      const { sessionId, ...status } = claude;
      return { status, title: status.title, conversationId: sessionId ?? agent.conversationId };
    }
    if (!agent.cwd) return {};
    const startedAt = agent.startSec * 1000;
    const ref = {
      // Per process: an attached Untether session reading the same agent finds the same file.
      id: processClaimId(
        { pid: agent.pid, startedAt, cwd: agent.cwd },
        agent.agent === 'codex' ? forgetCodexSession : forgetGeminiSession
      ),
      workingDir: agent.cwd,
      startedAt: agent.startedAt,
    };
    const chat = agent.agent === 'codex' ? this.deps.codexChat(ref) : this.deps.geminiChat(ref);
    const status: MacAgentStatus = {
      status: chat.status ?? 'idle',
      ...(chat.title ? { title: chat.title } : {}),
      ...(chat.activity ? { activity: chat.activity, since: chat.activity.since } : {}),
    };
    const preview = previewOf(chat.messages);
    if (preview) status.preview = preview;
    return {
      status,
      title: chat.title,
      conversationId:
        agent.agent === 'codex' ? (this.threadId(agent.cwd, startedAt) ?? undefined) : undefined,
    };
  }

  private threadId(cwd: string, startedAt: number): string | null {
    const key = `${cwd}\0${startedAt}`;
    const known = this.threadIds.get(key);
    // Codex can start a new conversation in the same process (/new): look again now and then.
    if (known && this.now() - known.at < 10_000) return known.id;
    const id = this.deps.codexThreadId(cwd, startedAt);
    remember(this.threadIds, key, { at: this.now(), id });
    return id;
  }
}

/** What History and the resume guard send the phone: one type on both sides. */
export type LiveConversation = MacLiveConversation;

/** Where History says a conversation runs when it is in another Untether instance's session. */
const OTHER_UNTETHER_APP = 'Untether';

/**
 * Whether a process is this server's: under it, in one of its running sessions, or in its own
 * shield. History knows those from the sessions it lists. Another instance's shield or `ut`
 * forwarder runs sessions this server doesn't list.
 */
function isThisServers(owner: ProcessOwner, ctx: OwnershipContext): boolean {
  if (owner.owner !== 'untether') return false;
  if (owner.by === 'shield') {
    return !!owner.socketPath && isOwnShieldSocket(owner.socketPath, ctx.ownShieldSocket);
  }
  return owner.by === 'server' || owner.by === 'session';
}

/**
 * Claude conversations running right now outside this server's sessions (in a tmux pane,
 * another terminal, or another Untether instance's session), by conversation id: History
 * never resumes one of those, which would make a second writer. Every Claude counts here, with
 * or without a terminal; `ids` names the ones the latest Mac Sessions scan listed.
 */
export async function liveClaudeConversations(
  table: ProcessTable,
  ctx: OwnershipContext,
  options: {
    claudeDir: string;
    ids?: (
      pid: number,
      lstart: string
    ) => Pick<LiveConversation, 'chatId' | 'tmuxId' | 'tmuxName' | 'windowIndex'> | undefined;
  }
): Promise<Map<string, LiveConversation>> {
  const live = new Map<string, LiveConversation>();
  if (!table.extended) return live;
  for (const file of await readClaudeSessionFiles(table, ctx.uid, options.claudeDir)) {
    if (!file.sessionId) continue;
    const owner = classifyProcess(table, file.pid, ctx);
    if (isThisServers(owner, ctx)) continue;
    let app: string | null = null;
    if (owner.owner === 'mac') {
      app = owner.app;
    } else if (owner.owner === 'untether') {
      // Another instance's: a ut in a terminal window, or one of its shielded sessions.
      app =
        owner.by === 'forwarder'
          ? hostAppOf(table, file.pid, ctx.platform ?? process.platform)
          : OTHER_UNTETHER_APP;
    }
    const ids = options.ids?.(file.pid, file.lstart);
    live.set(file.sessionId, {
      where: owner.owner === 'tmux' ? 'tmux' : 'terminal',
      ...(app ? { app } : {}),
      ...(ids?.chatId ? { chatId: ids.chatId } : {}),
      ...(ids?.tmuxId ? { tmuxId: ids.tmuxId } : {}),
      ...(ids?.tmuxId && ids.tmuxName !== undefined ? { tmuxName: ids.tmuxName } : {}),
      ...(ids?.tmuxId && ids.windowIndex !== undefined ? { windowIndex: ids.windowIndex } : {}),
    });
  }
  return live;
}

const ENV_MARKER = /(^|\s)UNTETHER_SESSION_ID=/;

/**
 * `ps -E -o pid=,command=` output → the pids whose environment has UNTETHER_SESSION_ID. Each
 * line is the pid, the command line (as the table has it) and the environment after it; a line
 * whose command line no longer matches (another process now) counts as unmarked.
 */
export function parsePsEnvironment(stdout: string, table: ProcessTable): Set<number> {
  const marked = new Set<number>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const rest = match[2].trimStart();
    const args = table.args.get(pid);
    if (args && rest.startsWith(args) && ENV_MARKER.test(rest.slice(args.length))) {
      marked.add(pid);
    }
  }
  return marked;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: 2000, maxBuffer: 16 * 1024 * 1024 },
      // Exit status 1 still has output: a pid that ended meanwhile.
      (error, stdout) => resolve(!error || error.code === 1 ? String(stdout) : '')
    );
  });
}

/** UNTETHER_SESSION_ID in the environment of these processes: ps -E (macOS), /proc (Linux). */
export async function untetherEnvOf(
  pids: number[],
  table: ProcessTable,
  platform: NodeJS.Platform = process.platform
): Promise<Set<number>> {
  if (pids.length === 0) return new Set();
  if (platform === 'linux') {
    const marked = new Set<number>();
    for (const pid of pids) {
      const environ = await fs.promises.readFile(`/proc/${pid}/environ`, 'latin1').catch(() => '');
      if (environ.split('\0').some((entry) => entry.startsWith('UNTETHER_SESSION_ID='))) {
        marked.add(pid);
      }
    }
    return marked;
  }
  if (platform !== 'darwin') return new Set();
  return parsePsEnvironment(
    await run('ps', ['-E', '-o', 'pid=,command=', '-p', pids.join(',')]),
    table
  );
}

/** Working folders of processes: one lsof (macOS), /proc (Linux). */
export async function processCwds(
  pids: number[],
  platform: NodeJS.Platform = process.platform
): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  if (platform === 'linux') {
    const cwds = new Map<number, string>();
    for (const pid of pids) {
      const cwd = await fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => null);
      if (cwd) cwds.set(pid, cwd);
    }
    return cwds;
  }
  if (platform !== 'darwin') return new Map();
  return parseLsofCwds(
    await run('/usr/sbin/lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'])
  );
}

/** What the real agent scan reads: this machine. Refused under vitest (assertRealScanAllowed). */
export function realAgentFinderDeps(platform: NodeJS.Platform = process.platform): AgentFinderDeps {
  assertRealScanAllowed('agent scan');
  return {
    uid: process.getuid?.() ?? -1,
    cwdsOf: (pids) => processCwds(pids, platform),
    untetherEnvOf: (pids, table) => untetherEnvOf(pids, table, platform),
    claudeStatus: async (pid, claudeDir) => (await readClaudeStatuses([pid], claudeDir)).get(pid),
    codexChat: (ref) => readCodexChat(ref),
    codexThreadId: (cwd, startedAt) =>
      codexIdFromRollout(findCodexRollout(defaultCodexDir(), cwd, startedAt)),
    geminiChat: (ref) => readGeminiChat(ref),
  };
}

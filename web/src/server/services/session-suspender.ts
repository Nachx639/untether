/**
 * Suspends idle Claude Code sessions and wakes them again (2026-10-31).
 *
 * The user's Mac (24 GB) ran out of memory with 10–14 Claude sessions open: each one holds
 * 150–250 MB plus ~10 MCP servers. With the `suspendIdleClaude` setting on, a shielded Claude
 * session idle for a long time (120 min by default) is suspended: its Claude and the whole
 * process tree under it (its MCP servers) end, and the session stays in every list, marked as
 * paused, with everything needed to bring it back in session.json (`suspended`). A tap, or
 * anything Untether has to type into it (a task event, `ut project tell`, an orchestrator
 * message, input through the API), wakes it first: the same Untether session id runs
 * `claude --resume <conversation>` with the flags it had, in its folder, shielded again.
 *
 * Same day's incident: another session ended 7 sessions with SIGTERM because their CPU was at 0
 * and they had no children but their MCP servers. They were working (orchestrators waiting on
 * their tasks, a half-done session). An idle CPU is not an idle session. So every rule below
 * has to agree, and any doubt (a read that fails, an unknown format) keeps the session awake:
 *
 * - a shielded session Untether runs, with Claude Code at its root, a known conversation whose
 *   transcript exists and ends with a complete line;
 * - Claude idle at its prompt for the whole idle time: no turn, no permission menu, no
 *   question, no dialog, nothing typed in its input box;
 * - no output, no input and nobody looking at it (phone or desktop) for the idle time;
 * - no process under Claude but its MCP / language servers (no background shell, monitor, dev
 *   server, build, `openclaw agent`);
 * - nothing scheduled inside that Claude that would be lost: a ScheduleWakeup not stopped and
 *   not fired, a CronCreate not deleted, a /loop or ralph-loop on, a background Agent /
 *   Workflow / Bash / Monitor without its end notification;
 * - not an orchestrator with an open task or anything queued for it, not a task's session
 *   (any task not finished), not marked "keep awake" by the user.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { SessionInput, SessionSuspension } from '../../shared/types.js';
import type { DoctorCheck, DoctorFinding } from './untether-doctor.js';

/** Default idle time before a session is suspended. */
export const DEFAULT_SUSPEND_IDLE_MINUTES = 120;
/** Lowest idle time the setting accepts (a few minutes would suspend sessions in use). */
export const MIN_SUSPEND_IDLE_MINUTES = 15;
/**
 * After a failed wake, automatic wakes (an orchestrator event, a task) are not tried again for
 * this long: a broken session is not restarted in a loop. The user's own tap always tries.
 */
export const WAKE_RETRY_AFTER_MS = 10 * 60_000;
/** How long a woken Claude has to report its conversation before the wake counts as failed. */
export const WAKE_CONFIRM_MS = 90_000;
/** A Monitor that says nothing more after its own timeout is over by then. */
const MONITOR_END_GRACE_MS = 60_000;
/** Language servers Claude starts for its LSP tool: stateless, started again on demand. */
const LANGUAGE_SERVER = /(?:^|[\s/])[\w.-]*(?:-lsp|lsp-server|language-?server|langserver)\b/i;
/** An MCP server's command line (stdio servers Claude starts from its config and plugins). */
const MCP_SERVER = /mcp/i;
/** Commands Claude's Bash tool runs (they source its shell snapshot). */
const BASH_TOOL = /shell-snapshots/;
const OPENCLAW_AGENT = /openclaw(?:\.mjs)?\s+agent\b/;
/** Children started this soon after Claude count as its MCP servers (they start with it). */
const MCP_START_WINDOW_MS = 60_000;

export function clampIdleMinutes(value: unknown): number {
  const minutes =
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : Number.NaN;
  if (Number.isNaN(minutes)) return DEFAULT_SUSPEND_IDLE_MINUTES;
  return Math.min(7 * 24 * 60, Math.max(MIN_SUSPEND_IDLE_MINUTES, minutes));
}

// ---------------------------------------------------------------------------------------------
// Transcript: what this Claude process still has scheduled or running in the background.
// ---------------------------------------------------------------------------------------------

interface TranscriptEntry {
  type?: string;
  subtype?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  timestamp?: string;
  taskId?: string;
  taskKind?: string;
  cronKind?: string;
  content?: unknown;
  message?: { role?: string; content?: unknown };
  toolUseResult?: unknown;
  attachment?: { type?: string; content?: unknown; prompt?: unknown };
}

const FINISHED_STATUSES = new Set([
  'completed',
  'failed',
  'killed',
  'stopped',
  'cancelled',
  'canceled',
  'error',
  'timeout',
  'expired',
]);

/** `<task-notification>`s in a piece of text: task id → its status (when it has one). */
function notificationsIn(text: string): Array<{ taskId: string; status?: string }> {
  const found: Array<{ taskId: string; status?: string }> = [];
  for (const block of text.split('<task-notification>').slice(1)) {
    const body = block.split('</task-notification>')[0];
    const taskId = body.match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/)?.[1];
    if (!taskId) continue;
    const status = body.match(/<status>\s*([a-z_ -]+?)\s*<\/status>/i)?.[1]?.toLowerCase();
    found.push({ taskId, ...(status ? { status } : {}) });
  }
  return found;
}

/** The text of a user entry the user (or Claude's queue) put there, not a tool result. */
function userEntryText(entry: TranscriptEntry): string | undefined {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const typed = block as { type?: string; text?: unknown };
      if (typed.type === 'tool_result') return undefined;
      if (typed.type === 'text' && typeof typed.text === 'string') texts.push(typed.text);
    }
  }
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : ''
      )
      .join('\n');
  }
  return '';
}

/** The background task a tool call started, from its result; null: it started none. */
function launchedTask(
  tool: { name: string; input: Record<string, unknown> },
  resultText: string,
  result: unknown
): { id?: string; kind: string; timeoutMs?: number } | null {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  if (tool.name === 'Monitor') {
    const timeout = typeof r.timeoutMs === 'number' ? r.timeoutMs : undefined;
    return {
      id: str(r.taskId) ?? resultText.match(/\btask ([A-Za-z0-9_-]+)/)?.[1],
      kind: 'Monitor',
      // A persistent monitor runs until it is stopped.
      ...(timeout !== undefined && r.persistent !== true ? { timeoutMs: timeout } : {}),
    };
  }
  const async =
    tool.input.run_in_background === true ||
    r.isAsync === true ||
    r.status === 'async_launched' ||
    str(r.backgroundTaskId) !== undefined ||
    /\b(?:running in background|launched in background|Async agent launched)\b/i.test(resultText);
  if (!async) return null;
  return {
    id:
      str(r.backgroundTaskId) ??
      str(r.taskId) ??
      str(r.agentId) ??
      resultText.match(/background with ID: ([A-Za-z0-9_-]+)/)?.[1] ??
      resultText.match(/Task ID: ([A-Za-z0-9_-]+)/)?.[1] ??
      resultText.match(/agentId: ([A-Za-z0-9_-]+)/)?.[1],
    kind: tool.input.run_in_background === true ? `${tool.name} (background)` : tool.name,
  };
}

/**
 * What the Claude process that started at `sinceMs` still has scheduled or running in the
 * background, read from its transcript lines: each element is one reason not to suspend it.
 * Only what this process started counts (earlier ones died with their process). Formats read
 * on this Mac (Claude Code 2.1.31x): ScheduleWakeup's result has `scheduledFor`, a fire is a
 * `system` entry `scheduled_task_fire`; CronCreate's result has `id`; background Bash has
 * `backgroundTaskId`, Agent `isAsync`/`agentId`, Workflow `status: async_launched`/`taskId`,
 * Monitor `taskId`/`timeoutMs`; each ends with a `<task-notification>` carrying its
 * `<task-id>` and a `<status>`, or with TaskStop.
 */
export function transcriptHolds(lines: string[], sinceMs: number, now = Date.now()): string[] {
  const holds: string[] = [];
  const tools = new Map<string, { name: string; input: Record<string, unknown>; at: number }>();
  const answered = new Set<string>();
  const launched = new Map<string, { kind: string; at: number; timeoutMs?: number }>();
  const finished = new Set<string>();
  let unknownLaunch: string | undefined;
  let wakeup: { at: number; scheduledFor?: number; stop: boolean } | undefined;
  let wakeupFiredAfter = false;
  const crons = new Map<string, { recurring: boolean; at: number }>();
  let unknownCron = false;
  const firedTasks = new Set<string>();
  const deletedCrons = new Set<string>();
  let lastUserCommand: string | undefined;
  let unreadable = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      unreadable++;
      continue;
    }
    if (entry.isSidechain) continue;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    // Entries without a time (snapshots, titles) carry nothing scheduled.
    if (Number.isNaN(at) || at < sinceMs) continue;

    if (entry.type === 'system' && entry.subtype === 'scheduled_task_fire') {
      if (entry.taskKind === 'loop' || entry.cronKind === 'loop') wakeupFiredAfter = true;
      if (typeof entry.taskId === 'string') firedTasks.add(entry.taskId);
      continue;
    }
    if (entry.type === 'queue-operation' || entry.type === 'attachment') {
      const text =
        typeof entry.content === 'string'
          ? entry.content
          : typeof entry.attachment?.content === 'string'
            ? entry.attachment.content
            : typeof entry.attachment?.prompt === 'string'
              ? entry.attachment.prompt
              : '';
      for (const note of notificationsIn(text)) {
        if (note.status && FINISHED_STATUSES.has(note.status)) finished.add(note.taskId);
      }
      continue;
    }
    const content = entry.message?.content;
    if (entry.type === 'user') {
      const text = userEntryText(entry);
      if (text !== undefined) {
        for (const note of notificationsIn(text)) {
          if (note.status && FINISHED_STATUSES.has(note.status)) finished.add(note.taskId);
        }
        const command = text.match(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/)?.[1];
        // The user's own turn (not a notification, not Claude's own wake-up prompt).
        if (!entry.isMeta && !text.includes('<task-notification>')) {
          lastUserCommand = command;
        }
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          const result = block as { type?: string; tool_use_id?: string; content?: unknown };
          if (result?.type !== 'tool_result' || typeof result.tool_use_id !== 'string') continue;
          answered.add(result.tool_use_id);
          const tool = tools.get(result.tool_use_id);
          if (!tool) continue;
          const resultText = toolResultText(result.content);
          if (tool.name === 'ScheduleWakeup') {
            const r = entry.toolUseResult as { scheduledFor?: unknown } | undefined;
            if (wakeup && typeof r?.scheduledFor === 'number') wakeup.scheduledFor = r.scheduledFor;
          } else if (tool.name === 'CronCreate') {
            const r = entry.toolUseResult as { id?: unknown; recurring?: unknown } | undefined;
            const id =
              typeof r?.id === 'string' ? r.id : resultText.match(/\b([0-9a-f]{8})\b/)?.[1];
            if (id) {
              crons.set(id, {
                recurring: r?.recurring !== false && tool.input.recurring !== false,
                at,
              });
            } else if (!/error|fail/i.test(resultText)) {
              unknownCron = true;
            }
          } else {
            const task = launchedTask(tool, resultText, entry.toolUseResult);
            if (task?.id) launched.set(task.id, { kind: task.kind, at, timeoutMs: task.timeoutMs });
            else if (task && !/error|fail/i.test(resultText)) unknownLaunch = task.kind;
          }
        }
      }
      continue;
    }
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        const use = block as { type?: string; id?: string; name?: string; input?: unknown };
        if (use?.type !== 'tool_use' || typeof use.id !== 'string' || !use.name) continue;
        const input = (use.input && typeof use.input === 'object' ? use.input : {}) as Record<
          string,
          unknown
        >;
        tools.set(use.id, { name: use.name, input, at });
        if (use.name === 'ScheduleWakeup') {
          wakeup = { at, stop: input.stop === true };
          wakeupFiredAfter = false;
        } else if (use.name === 'CronDelete' && typeof input.id === 'string') {
          deletedCrons.add(input.id);
        } else if (use.name === 'TaskStop') {
          const id = input.task_id ?? input.taskId ?? input.id;
          if (typeof id === 'string') finished.add(id);
        }
      }
    }
  }

  if (unreadable > 0) holds.push(`${unreadable} transcript line(s) could not be read`);
  for (const [id, tool] of tools) {
    if (!answered.has(id)) holds.push(`${tool.name} call without its result`);
  }
  if (wakeup && !wakeup.stop) {
    const future = wakeup.scheduledFor !== undefined && wakeup.scheduledFor > now - 5 * 60_000;
    if (future || !wakeupFiredAfter) holds.push('a ScheduleWakeup is pending');
  }
  for (const [id, cron] of crons) {
    if (deletedCrons.has(id)) continue;
    if (!cron.recurring && firedTasks.has(id)) continue;
    holds.push(`cron job ${id} (CronCreate) is still scheduled`);
  }
  if (unknownCron) holds.push('a CronCreate whose job id could not be read');
  if (lastUserCommand && /(^|:)(loop|ralph-loop)$/.test(lastUserCommand)) {
    holds.push(`the last command was /${lastUserCommand}`);
  }
  if (unknownLaunch) holds.push(`a ${unknownLaunch} whose task id could not be read`);
  for (const [id, task] of launched) {
    if (finished.has(id)) continue;
    if (task.timeoutMs !== undefined && now > task.at + task.timeoutMs + MONITOR_END_GRACE_MS) {
      continue;
    }
    holds.push(`${task.kind} ${id} has not finished`);
  }
  return holds;
}

/** The transcript ends with a whole line (Claude wrote its last entry completely). */
export function transcriptEndsCleanly(tail: string): boolean {
  if (!tail.endsWith('\n')) return false;
  const last = tail.trimEnd().split('\n').pop() ?? '';
  if (!last) return true;
  try {
    JSON.parse(last);
    return true;
  } catch {
    return false;
  }
}

/** A ralph-loop is active in this folder (its Stop hook keeps the conversation going). */
export function ralphLoopActive(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, '.claude', 'ralph-loop.local.md'));
}

// ---------------------------------------------------------------------------------------------
// Processes under Claude.
// ---------------------------------------------------------------------------------------------

export interface ProcessView {
  children: Map<number, number[]>;
  args: Map<number, string>;
  /** Start time per pid, epoch ms. */
  startMs: (pid: number) => number | undefined;
}

/** Every pid under `root` (not `root` itself). */
export function processesUnder(view: Pick<ProcessView, 'children'>, root: number): number[] {
  const out: number[] = [];
  const queue = [...(view.children.get(root) ?? [])];
  while (queue.length > 0 && out.length < 1000) {
    const pid = queue.shift() as number;
    out.push(pid);
    queue.push(...(view.children.get(pid) ?? []));
  }
  return out;
}

/**
 * Reasons the processes under Claude (`claudePid`) forbid a suspension: anything that is not
 * one of its MCP servers or language servers (with what those started). An MCP server is a
 * direct child whose command names MCP, or one started with Claude itself (within a minute);
 * never a command of Claude's Bash tool, a shell, `caffeinate` (Claude holds the Mac awake
 * while working) or `openclaw agent`.
 */
export function processHolds(view: ProcessView, claudePid: number): string[] {
  const holds: string[] = [];
  const claudeStart = view.startMs(claudePid);
  for (const pid of processesUnder(view, claudePid)) {
    const args = view.args.get(pid) ?? '';
    if (BASH_TOOL.test(args)) holds.push(`a command of Claude's Bash tool runs (pid ${pid})`);
    else if (OPENCLAW_AGENT.test(args)) holds.push(`openclaw agent runs (pid ${pid})`);
  }
  for (const pid of view.children.get(claudePid) ?? []) {
    const args = view.args.get(pid) ?? '';
    const program = args.split(/\s+/)[0]?.split('/').pop() ?? '';
    const shell = /^-?(?:ba|z|fi|da|k|c|tc)?sh$/.test(program);
    if (shell || program === 'caffeinate') {
      holds.push(`${program} runs under Claude (pid ${pid})`);
      continue;
    }
    if (MCP_SERVER.test(args) || LANGUAGE_SERVER.test(args)) continue;
    const start = view.startMs(pid);
    if (
      claudeStart !== undefined &&
      start !== undefined &&
      start - claudeStart <= MCP_START_WINDOW_MS
    ) {
      continue;
    }
    holds.push(`a process under Claude is not an MCP server: ${args.slice(0, 80)} (pid ${pid})`);
  }
  return holds;
}

// ---------------------------------------------------------------------------------------------
// The rules, all together.
// ---------------------------------------------------------------------------------------------

export interface SuspendCandidate {
  id: string;
  status: string;
  shielded?: boolean;
  command: string[];
  workingDir: string;
  claudeSessionId?: string;
  keepAwake?: boolean;
  suspended?: SessionSuspension;
  /** A ut window's session or one attached to a user's tmux: not Untether's to stop. */
  external?: boolean;
  lastInputAt?: number;
  /** Last output written (its cast's mtime). */
  lastOutputAt?: number;
}

export interface ClaudeLook {
  status: string;
  waitingFor?: string;
  sessionId?: string;
  since?: number;
  waitingForBackground?: boolean;
  pid?: number;
  /** Process start (epoch ms), from Claude's own sessions/<pid>.json. */
  startedAt?: number;
}

export interface ScreenLook {
  draft: boolean | undefined;
  menu: boolean;
}

/** Everything one decision reads, gathered once (SessionSuspender.inspect). */
export interface SuspendFacts {
  session: SuspendCandidate;
  idleMs: number;
  now: number;
  claude?: ClaudeLook;
  transcriptPath?: string | null;
  transcriptTail?: string;
  transcriptLines?: string[];
  /** transcriptHolds of an unchanged transcript, from an earlier look (instead of its lines). */
  transcriptHolds?: string[];
  screen?: ScreenLook;
  watched: boolean;
  processHolds?: string[];
  /** Why its role keeps it (open tasks, queued events, a task's session), or null. */
  heldBy: string | null;
  ralphLoop: boolean;
  /**
   * The user asked for it (POST /api/sessions/:id/suspend, 2026-10-31): no idle time, and the
   * user looking at it or having marked it "keep awake" does not keep it. Every other rule holds.
   */
  byUser?: boolean;
}

/** The rules that only read the session itself (cheap: checked first, on every look). */
export function sessionBlockers(
  facts: Pick<SuspendFacts, 'session' | 'idleMs' | 'now' | 'watched' | 'heldBy' | 'byUser'>
): string[] {
  const { session, idleMs, now, byUser } = facts;
  const reasons: string[] = [];
  if (session.status !== 'running') reasons.push(`session is ${session.status}`);
  if (session.suspended) reasons.push('already suspended');
  if (!session.shielded) reasons.push('not shielded (only shielded sessions resume in place)');
  if (session.external) reasons.push('runs outside Untether (terminal window or tmux)');
  if (session.keepAwake && !byUser) reasons.push('marked "keep awake"');
  if (!session.command.some((arg) => arg.split('/').pop() === 'claude')) {
    reasons.push('not a Claude session');
  }
  // Unknown (none since the server started) is fine: Claude's own idle time covers a sent
  // message, and the screen check covers text typed and not sent.
  if (!byUser) {
    if (session.lastInputAt !== undefined && now - session.lastInputAt < idleMs) {
      reasons.push('input in the idle time');
    }
    if (session.lastOutputAt === undefined || now - session.lastOutputAt < idleMs) {
      reasons.push('output in the idle time');
    }
    if (facts.watched) reasons.push('someone is looking at it');
  }
  if (facts.heldBy) reasons.push(facts.heldBy);
  return reasons;
}

/** Each reason the session must stay awake; empty: it may be suspended. */
export function suspendBlockers(facts: SuspendFacts): string[] {
  const { now, claude, idleMs, session } = facts;
  const reasons = sessionBlockers(facts);
  if (!claude) {
    reasons.push('no Claude status');
  } else {
    if (!claude.sessionId) reasons.push('no Claude conversation id');
    else if (session.claudeSessionId && claude.sessionId !== session.claudeSessionId) {
      reasons.push('Claude runs another conversation than the session recorded');
    }
    if (claude.status !== 'idle' || claude.waitingForBackground) {
      reasons.push(
        `Claude is ${claude.waitingForBackground ? 'waiting on background work' : claude.status}`
      );
    }
    if (typeof claude.since !== 'number') {
      reasons.push('Claude idle time unknown');
    } else if (!facts.byUser && now - claude.since < idleMs) {
      reasons.push('Claude was not idle for the whole idle time');
    }
    if (!claude.pid) reasons.push('Claude process unknown');
    if (typeof claude.startedAt !== 'number') reasons.push('Claude start time unknown');
  }
  if (!facts.transcriptPath) reasons.push('transcript not found');
  else if (facts.transcriptTail === undefined || !transcriptEndsCleanly(facts.transcriptTail)) {
    reasons.push('transcript does not end with a complete entry');
  }
  if (facts.transcriptHolds) {
    reasons.push(...facts.transcriptHolds);
  } else if (facts.transcriptLines && claude?.startedAt !== undefined) {
    reasons.push(...transcriptHolds(facts.transcriptLines, claude.startedAt - 5000, now));
  } else if (facts.transcriptPath) {
    reasons.push('transcript not read');
  }
  if (facts.ralphLoop) reasons.push('a ralph-loop is active in its folder');
  if (!facts.screen) reasons.push('screen not readable');
  else {
    if (facts.screen.draft !== false) reasons.push('text in its input box (or no input box seen)');
    if (facts.screen.menu) reasons.push('a menu or question is on screen');
  }
  if (!facts.processHolds) reasons.push('process tree not read');
  else reasons.push(...facts.processHolds);
  return reasons;
}

/**
 * What kind of reason keeps a session awake, for the user who asked to suspend it (the app
 * shows each kind in their language; the reason itself stays as the detail):
 * - busy: a turn runs (or Claude changed, or its last entry is not complete);
 * - question: Claude waits for an answer, or a menu or question is on screen;
 * - draft: text typed in its input box (never thrown away: it stays awake);
 * - background: a background shell, agent, workflow or program under Claude;
 * - scheduled: a Monitor, ScheduleWakeup, CronCreate, /loop or ralph-loop;
 * - tasks: an orchestrator with open tasks or queued messages, or a task's session;
 * - waking: a wake of it is on its way;
 * - notAllowed: not a shielded Claude session Untether runs (or it is not running);
 * - unknown: something could not be read, so it is not certain it is safe.
 */
export type BlockerKind =
  | 'busy'
  | 'question'
  | 'draft'
  | 'background'
  | 'scheduled'
  | 'tasks'
  | 'waking'
  | 'notAllowed'
  | 'unknown';

export interface Blocker {
  kind: BlockerKind;
  reason: string;
}

/** The kind of one of suspendBlockers' reasons (see BlockerKind). */
export function blockerKind(reason: string): BlockerKind {
  if (reason.startsWith('text in its input box')) return 'draft';
  if (/^a menu or question is on screen|^Claude is waiting$/.test(reason)) return 'question';
  if (
    /ScheduleWakeup|CronCreate|^cron job |ralph-loop|^the last command was \/|^Monitor /.test(
      reason
    )
  ) {
    return 'scheduled';
  }
  if (
    /^Claude is waiting on background work|has not finished$|whose task id could not be read|runs under Claude \(pid|^a command of Claude's Bash tool runs|^openclaw agent runs|is not an MCP server/.test(
      reason
    )
  ) {
    return 'background';
  }
  if (
    /^Claude is |^Claude was not idle|^Claude changed|call without its result$|does not end with a complete entry|^input in the idle time|Input arrived since the last look|^output in the idle time/.test(
      reason
    )
  ) {
    return 'busy';
  }
  if (/^task [^ ]+ \(.*\) runs in it$|^it orchestrates |^waiting to reach it/.test(reason)) {
    return 'tasks';
  }
  if (reason.startsWith('waking up')) return 'waking';
  if (
    /^session is |^already suspended|^not shielded|^runs outside Untether|^not a Claude session|^marked "keep awake"|^someone is looking at it/.test(
      reason
    )
  ) {
    return 'notAllowed';
  }
  return 'unknown';
}

/**
 * The reasons as the user sees them: each with its kind; when a known reason is there, the
 * "could not read" ones that follow from it (a busy Claude's screen is not read) are left out.
 */
export function blockersForUser(reasons: readonly string[]): Blocker[] {
  const all = reasons.map((reason) => ({ kind: blockerKind(reason), reason }));
  const known = all.filter((blocker) => blocker.kind !== 'unknown');
  return known.length > 0 ? known : all;
}

// ---------------------------------------------------------------------------------------------
// The service.
// ---------------------------------------------------------------------------------------------

export type WakeResult = { ok: true; sessionId: string } | { ok: false; error: string };

export type SuspendByUserResult =
  | { ok: true; sessionId: string }
  | { ok: false; blockers: Blocker[] };

export interface SessionSuspenderDeps {
  enabled: () => boolean;
  idleMinutes: () => number;
  sessions: () => SuspendCandidate[];
  claude: (sessionId: string) => Promise<ClaudeLook | undefined>;
  transcriptPath: (cwd: string, conversation: string) => string | null;
  screen: (sessionId: string) => Promise<ScreenLook | undefined>;
  watched: (sessionId: string) => boolean;
  processView: () => Promise<ProcessView>;
  heldBy: (sessionId: string) => string | null;
  /**
   * Ends Claude and its process tree; the session stays, marked suspended. Refuses when input
   * came after `lastInputSeen`; input that comes while it runs is held and returned.
   */
  suspend: (
    sessionId: string,
    record: SessionSuspension,
    tree: number[],
    lastInputSeen: number | undefined
  ) => Promise<{ heldInput?: SessionInput[] } | undefined>;
  /** Types input into a running session (the held input, once it woke again). */
  sendInput?: (sessionId: string, input: SessionInput) => void;
  /** Starts `claude --resume` in the same session again. */
  resume: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Records a failed wake on the (still suspended) session, or clears the record. */
  setSuspension: (sessionId: string, record: SessionSuspension | undefined) => void;
  /** The conversation runs outside Untether right now (a second writer must never start). */
  liveElsewhere: (conversation: string) => Promise<boolean>;
  /** Extra facts saved with the suspension (orchestrated project, linked tasks). */
  roleOf?: (sessionId: string) => Pick<SessionSuspension, 'orchestratorOf' | 'tasks'>;
  log: (message: string) => void;
  warn: (message: string) => void;
  /** Why each session stays awake, when that changes (debug log). */
  debug?: (message: string) => void;
  /** A wake failed: tell the user (push). */
  alert?: (sessionId: string, error: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  wakeConfirmMs?: number;
  readFile?: (file: string) => string;
}

export class SessionSuspender {
  private running = false;
  /** Sessions being suspended right now (the minute's look or the user's), one at a time. */
  private readonly suspending = new Set<string>();
  private readonly wakes = new Map<string, Promise<WakeResult>>();
  /** Last reasons per session, for the doctor and the log on demand. */
  readonly lastBlockers = new Map<string, string[]>();

  constructor(private readonly deps: SessionSuspenderDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  isSuspended(sessionId: string): boolean {
    return !!this.deps.sessions().find((session) => session.id === sessionId)?.suspended;
  }

  /** Gathers what the rules read; the cheap ones first, the rest only when they pass. */
  async inspect(session: SuspendCandidate, byUser = false): Promise<SuspendFacts> {
    const now = this.now();
    const idleMs = byUser ? 0 : clampIdleMinutes(this.deps.idleMinutes()) * 60_000;
    const facts: SuspendFacts = {
      session,
      idleMs,
      now,
      watched: this.deps.watched(session.id),
      heldBy: this.deps.heldBy(session.id),
      ralphLoop: false,
      ...(byUser ? { byUser } : {}),
    };
    // The user is told every reason at once; the minute's look stops at the first cheap one.
    const eligible = byUser
      ? session.status === 'running' && !session.suspended && !!session.shielded
      : sessionBlockers(facts).length === 0;
    if (!eligible) return facts;
    facts.claude = await this.deps.claude(session.id).catch(() => undefined);
    const conversation = facts.claude?.sessionId;
    if (!facts.claude || !conversation || (!byUser && facts.claude.status !== 'idle')) {
      return facts;
    }
    facts.transcriptPath = this.deps.transcriptPath(session.workingDir, conversation);
    if (facts.transcriptPath) this.readTranscript(facts, facts.transcriptPath, facts.claude);
    facts.ralphLoop = ralphLoopActive(session.workingDir);
    facts.screen = await this.deps.screen(session.id).catch(() => undefined);
    if (facts.claude.pid) {
      const view = await this.deps.processView().catch(() => undefined);
      if (view) facts.processHolds = processHolds(view, facts.claude.pid);
    }
    return facts;
  }

  /**
   * Transcripts read on earlier looks, by path: an unchanged one (size, mtime, same Claude
   * process) is not read again for a few minutes. A session held by a cron would otherwise
   * have its whole transcript (tens of MB) read every minute. What it holds can only clear
   * with time (a Monitor's timeout), never appear, so a cached hold errs on staying awake.
   */
  private readonly transcripts = new Map<
    string,
    { size: number; mtimeMs: number; since: number; at: number; tail: string; holds: string[] }
  >();

  private readTranscript(facts: SuspendFacts, file: string, claude: ClaudeLook): void {
    const since = (claude.startedAt ?? Number.NaN) - 5000;
    try {
      const stat = fs.statSync(file);
      const cached = this.transcripts.get(file);
      if (
        cached &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.since === since &&
        facts.now - cached.at < 5 * 60_000
      ) {
        facts.transcriptTail = cached.tail;
        facts.transcriptHolds = cached.holds;
        return;
      }
      const text = (this.deps.readFile ?? ((path) => fs.readFileSync(path, 'utf8')))(file);
      facts.transcriptTail = text.slice(-4096);
      if (Number.isNaN(since)) return;
      facts.transcriptHolds = transcriptHolds(text.split('\n'), since, facts.now);
      this.transcripts.set(file, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        since,
        at: facts.now,
        tail: facts.transcriptTail,
        holds: facts.transcriptHolds,
      });
      if (this.transcripts.size > 100) {
        this.transcripts.delete(this.transcripts.keys().next().value as string);
      }
    } catch {
      // Unreadable: the rules keep it awake.
    }
  }

  /** One look: suspends at most one session. Its id, if it did. */
  private wasEnabled: boolean | undefined;

  async tick(): Promise<string | null> {
    const enabled = this.deps.enabled();
    if (enabled !== this.wasEnabled) {
      this.wasEnabled = enabled;
      this.deps.log(
        `session suspend: ${enabled ? `on (after ${clampIdleMinutes(this.deps.idleMinutes())} min idle)` : 'off'}`
      );
    }
    if (this.running || !enabled) return null;
    this.running = true;
    try {
      const sessions = this.deps.sessions();
      // Sessions that are gone are forgotten (2026-11-10: the map only grew).
      if (this.lastBlockers.size > sessions.length) {
        const known = new Set(sessions.map((session) => session.id));
        for (const id of this.lastBlockers.keys()) if (!known.has(id)) this.lastBlockers.delete(id);
      }
      for (const session of sessions) {
        if (session.status !== 'running' || session.suspended) continue;
        if (this.wakes.has(session.id) || this.suspending.has(session.id)) continue;
        const facts = await this.inspect(session);
        const blockers = suspendBlockers(facts);
        const before = this.lastBlockers.get(session.id);
        if (before?.join('|') !== blockers.join('|')) {
          this.deps.debug?.(
            `session suspend: ${session.id} stays awake: ${blockers.join('; ') || 'nothing'}`
          );
        }
        this.lastBlockers.set(session.id, blockers);
        if (blockers.length > 0) continue;
        if (await this.suspendOnce(session, facts)) return session.id;
      }
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * Suspends a session the user asked to (its menu, or a swipe on the phone): the same rules
   * and the same safe stop as the minute's look, without its idle time (see SuspendFacts.byUser).
   * Anything that keeps it awake is answered instead, and nothing is suspended: a turn, a
   * question or menu, text in its input box (kept: it is never thrown away), background work,
   * anything scheduled, an orchestrator's open tasks or queue.
   */
  async suspendByUser(sessionId: string): Promise<SuspendByUserResult> {
    const session = this.deps.sessions().find((candidate) => candidate.id === sessionId);
    if (!session) {
      return { ok: false, blockers: [{ kind: 'notAllowed', reason: 'session not found' }] };
    }
    if (this.wakes.has(sessionId)) {
      return { ok: false, blockers: [{ kind: 'waking', reason: 'waking up right now' }] };
    }
    if (this.suspending.has(sessionId)) {
      return { ok: false, blockers: [{ kind: 'busy', reason: 'being suspended right now' }] };
    }
    const facts = await this.inspect(session, true);
    const blockers = suspendBlockers(facts);
    if (blockers.length > 0) {
      this.deps.log(
        `session suspend: ${sessionId} not suspended at the user's request: ${blockers.join('; ')}`
      );
      return { ok: false, blockers: blockersForUser(blockers) };
    }
    if (this.suspending.has(sessionId) || this.wakes.has(sessionId)) {
      return { ok: false, blockers: [{ kind: 'busy', reason: 'being suspended right now' }] };
    }
    this.suspending.add(sessionId);
    try {
      const outcome = await this.suspendNow(session, facts);
      if (outcome === true) return { ok: true, sessionId };
      return { ok: false, blockers: blockersForUser(outcome) };
    } finally {
      this.suspending.delete(sessionId);
    }
  }

  private async suspendOnce(session: SuspendCandidate, facts: SuspendFacts): Promise<boolean> {
    if (this.suspending.has(session.id)) return false;
    this.suspending.add(session.id);
    try {
      return (await this.suspendNow(session, facts)) === true;
    } finally {
      this.suspending.delete(session.id);
    }
  }

  /** True once suspended; else why it was not (every reason is also kept in lastBlockers). */
  private async suspendNow(
    session: SuspendCandidate,
    facts: SuspendFacts
  ): Promise<true | string[]> {
    const claude = facts.claude as ClaudeLook;
    const byUser = facts.byUser === true;
    const keep = (reasons: string[]): string[] => {
      this.lastBlockers.set(session.id, reasons);
      return reasons;
    };
    // Looked at again right before: anything that changed meanwhile keeps it awake.
    const again = await this.inspect(
      this.deps.sessions().find((candidate) => candidate.id === session.id) ?? session,
      byUser
    );
    const late = suspendBlockers(again);
    if (late.length > 0) return keep(late);
    const view = await this.deps.processView().catch(() => undefined);
    const tree = view && claude.pid ? [claude.pid, ...processesUnder(view, claude.pid)] : [];
    // The very last look before stopping it: the same Claude, still idle since the same moment.
    const last = await this.deps.claude(session.id).catch(() => undefined);
    if (
      !last ||
      last.pid !== again.claude?.pid ||
      last.status !== 'idle' ||
      last.waitingForBackground ||
      last.since !== again.claude?.since
    ) {
      return keep(['Claude changed right before suspending']);
    }
    const idleMinutes = Math.round((this.now() - (claude.since ?? this.now())) / 60_000);
    const record: SessionSuspension = {
      at: new Date(this.now()).toISOString(),
      claudeSessionId: claude.sessionId as string,
      command: session.command,
      workingDir: session.workingDir,
      shielded: true,
      idleMinutes,
      ...(byUser ? { byUser: true as const } : {}),
      ...(this.deps.roleOf?.(session.id) ?? {}),
    };
    let held: SessionInput[] = [];
    try {
      held =
        (await this.deps.suspend(session.id, record, tree, again.session.lastInputAt))?.heldInput ??
        [];
    } catch (error) {
      this.deps.warn(`session suspend: ${session.id} could not be suspended: ${error}`);
      return keep([`could not be suspended: ${error instanceof Error ? error.message : error}`]);
    }
    this.deps.log(
      `session suspend: ${session.id} suspended${byUser ? " at the user's request" : ''} (Claude ${record.claudeSessionId} idle ${idleMinutes} min, ${tree.length} process(es) ended) in ${session.workingDir}`
    );
    if (held.length > 0) {
      // Typed while it was being stopped: kept on disk with the suspension (pendingInput) and
      // typed by the wake; a failed wake keeps it for the next one.
      this.deps.log(`session suspend: ${session.id} got input while suspending; waking it`);
      await this.wake(session.id, 'input typed while it was suspending', { byUser: true });
    }
    return true;
  }

  /**
   * Wakes a suspended session (the same session id runs `claude --resume` again) and waits
   * until its Claude reports the conversation. A session that is not suspended answers at
   * once. Concurrent wakes of one session share one attempt. A failed wake leaves the session
   * suspended with the error (shown with a retry), logged and told.
   */
  wake(sessionId: string, why: string, options: { byUser?: boolean } = {}): Promise<WakeResult> {
    const pending = this.wakes.get(sessionId);
    if (pending) return pending;
    const session = this.deps.sessions().find((candidate) => candidate.id === sessionId);
    if (!session?.suspended) return Promise.resolve({ ok: true, sessionId });
    // A wake that failed a moment ago is not retried by every queued event (the queue keeps
    // them on disk, and they go in once it wakes); only the user's own tap tries again now.
    // Read from its record on disk (resumeError/resumeErrorAt), so a restart keeps the wait
    // and the "told once" (2026-11-02: kept in memory, each restart retried and alerted again).
    const failed = session.suspended;
    const failedAt = Date.parse(failed.resumeErrorAt ?? '');
    if (
      failed.resumeError &&
      !options.byUser &&
      Number.isFinite(failedAt) &&
      this.now() - failedAt < WAKE_RETRY_AFTER_MS
    ) {
      return Promise.resolve({ ok: false, error: `its last wake failed: ${failed.resumeError}` });
    }
    const attempt = this.wakeNow(session, session.suspended, why).finally(() => {
      this.wakes.delete(sessionId);
    });
    this.wakes.set(sessionId, attempt);
    return attempt;
  }

  /** Wakes it if it is suspended; true when it runs (or never was suspended). */
  async ensureAwake(sessionId: string, why: string): Promise<boolean> {
    return (await this.wake(sessionId, why)).ok;
  }

  private async wakeNow(
    session: SuspendCandidate,
    record: SessionSuspension,
    why: string
  ): Promise<WakeResult> {
    const fail = (error: string): WakeResult => {
      // Told once per run of failures, not on every retry.
      const known = !!record.resumeError;
      this.deps.setSuspension(session.id, {
        ...record,
        wakingAt: undefined,
        resumeError: error,
        resumeErrorAt: new Date(this.now()).toISOString(),
      });
      this.deps.warn(`session suspend: waking ${session.id} (${why}) failed: ${error}`);
      if (!known) this.deps.alert?.(session.id, error);
      return { ok: false, error };
    };
    if (await this.deps.liveElsewhere(record.claudeSessionId).catch(() => false)) {
      return fail('its conversation is running outside Untether right now');
    }
    if (!fs.existsSync(record.workingDir)) {
      return fail(`its folder ${record.workingDir} no longer exists`);
    }
    this.deps.log(`session suspend: waking ${session.id} (${why})`);
    const started = await this.deps
      .resume(session.id)
      .catch((error): { ok: false; error: string } => ({ ok: false, error: String(error) }));
    if (!started.ok) return fail(started.error);
    // Claude has to come back on the same conversation.
    const sleep = this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = this.now() + (this.deps.wakeConfirmMs ?? WAKE_CONFIRM_MS);
    while (this.now() < deadline) {
      await sleep(1000);
      const current = this.deps.sessions().find((candidate) => candidate.id === session.id);
      if (!current || current.status !== 'running') {
        return fail('Claude ended right after resuming');
      }
      const claude = await this.deps.claude(session.id).catch(() => undefined);
      if (claude?.sessionId === record.claudeSessionId) {
        // Input held while it was being stopped goes in first, read from disk now (it may
        // have grown since the wake began).
        const pending =
          this.deps.sessions().find((candidate) => candidate.id === session.id)?.suspended
            ?.pendingInput ?? record.pendingInput;
        this.deps.setSuspension(session.id, undefined);
        for (const input of pending ?? []) this.deps.sendInput?.(session.id, input);
        if (pending?.length) {
          this.deps.log(`session suspend: ${session.id} got its ${pending.length} held input(s)`);
        }
        this.deps.log(
          `session suspend: ${session.id} woke (${why}), Claude ${record.claudeSessionId} is ${claude.status}`
        );
        return { ok: true, sessionId: session.id };
      }
    }
    // It runs, but its Claude did not report the conversation: callers are told it failed and
    // keep their queues. Input held from the suspension was the user's own typing into this
    // session: it goes to the resumed program's terminal (kept there until it reads it)
    // rather than nowhere.
    const pending =
      this.deps.sessions().find((candidate) => candidate.id === session.id)?.suspended
        ?.pendingInput ?? record.pendingInput;
    this.deps.setSuspension(session.id, undefined);
    for (const input of pending ?? []) this.deps.sendInput?.(session.id, input);
    const error = 'Claude did not report its conversation in time';
    this.deps.warn(`session suspend: ${session.id} woke (${why}) but ${error}`);
    return { ok: false, error };
  }

  /**
   * After a server restart: a suspension cut short (Claude still runs: its tmux was attached
   * again) is dropped; so is a wake cut short whose session runs; one whose session does not
   * run stays suspended and wakes on the next ask.
   */
  async reconcile(): Promise<void> {
    for (const session of this.deps.sessions()) {
      const record = session.suspended;
      if (!record) continue;
      if (session.status === 'running' && !record.wakingAt) {
        this.deps.setSuspension(session.id, undefined);
        this.deps.warn(
          `session suspend: ${session.id} was being suspended when the server stopped; it still runs, left awake`
        );
      } else if (session.status === 'running' && record.wakingAt) {
        // The wake was cut after its tmux was made: the session runs, so it is not suspended,
        // whether or not its Claude has reported yet (what wakeNow does when its wait runs
        // out). 2026-11-10: this looked once, 15 s after the start; a Claude still loading
        // left a running session marked suspended for good, and everything typed into it was
        // dropped ("it did not wake"). The input held from before goes in, as there.
        const claude = await this.deps.claude(session.id).catch(() => undefined);
        this.deps.setSuspension(session.id, undefined);
        for (const input of record.pendingInput ?? []) this.deps.sendInput?.(session.id, input);
        if (claude?.sessionId !== record.claudeSessionId) {
          this.deps.warn(
            `session suspend: ${session.id} was waking when the server stopped; it runs, though its Claude has not reported its conversation yet`
          );
        }
      } else if (record.wakingAt) {
        this.deps.setSuspension(session.id, { ...record, wakingAt: undefined });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The doctor's look.
// ---------------------------------------------------------------------------------------------

/**
 * Suspended sessions for Untether's doctor: each one is recorded (info) with when and why, a
 * failed wake is a warning (the session waits on the user's retry), and one stuck waking (a wake
 * cut short) too. With the setting off, sessions still suspended are told once.
 */
export function suspendedSessionsCheck(deps: {
  sessions: () => Array<{
    id: string;
    title?: string;
    status: string;
    suspended: SessionSuspension;
  }>;
  enabled: () => boolean;
  now?: () => number;
}): DoctorCheck {
  return {
    id: 'suspended-sessions',
    run() {
      const now = deps.now?.() ?? Date.now();
      const findings: DoctorFinding[] = [];
      for (const session of deps.sessions()) {
        const record = session.suspended;
        const name = `session ${session.id.slice(0, 8)} "${session.title ?? ''}"`;
        if (record.resumeError) {
          findings.push({
            key: `suspended-wake-failed:${session.id}:${record.resumeErrorAt ?? ''}`,
            check: 'suspended-sessions',
            severity: 'warning',
            problem: `${name} could not wake from its suspension: ${record.resumeError} (it stays suspended; tap it to retry)`,
          });
          continue;
        }
        const waking = record.wakingAt ? Date.parse(record.wakingAt) : Number.NaN;
        if (!Number.isNaN(waking) && now - waking > 5 * 60_000) {
          findings.push({
            key: `suspended-wake-stuck:${session.id}`,
            check: 'suspended-sessions',
            severity: 'warning',
            problem: `${name} has been waking for ${Math.round((now - waking) / 60_000)} min (status ${session.status})`,
          });
          continue;
        }
        findings.push({
          key: `suspended:${session.id}:${record.at}`,
          check: 'suspended-sessions',
          severity: 'info',
          problem: `${name} suspended at ${record.at} ${record.byUser ? "at the user's request" : `after ${record.idleMinutes} min idle`} (Claude ${record.claudeSessionId}); it wakes on a tap or on input${deps.enabled() ? '' : ' (suspending is off now)'}`,
        });
      }
      return findings;
    },
  };
}

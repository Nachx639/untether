/**
 * An agent's state from what the agent itself records, not from its screen (2026-11-01).
 *
 * The agents still run in their own TUI inside the shielded tmux, and the user sees them and
 * types into them as always. What Untether decides about them (the turn is over, it waits for
 * a permission or an answer, its usage limit cut it short, it is still editing files) comes
 * from structured sources first:
 *
 *   Claude Code  hooks Untether adds to the sessions it starts (claude-hooks.ts): SessionStart,
 *                UserPromptSubmit, PreToolUse/PostToolUse(+Failure), PermissionRequest,
 *                Notification (permission_prompt, idle_prompt, elicitation_dialog), Stop,
 *                StopFailure (the API error or limit that ended a turn), SubagentStop,
 *                PreCompact/PostCompact, SessionEnd.
 *   Codex        its rollout ($CODEX_HOME/sessions/…/rollout-*.jsonl): task_started,
 *                task_complete (with `error.codex_error_info` when a limit or an API error
 *                ended the turn), turn_aborted, tool calls and their outputs, token_count
 *                (rate_limits with resets_at), compacted.
 *
 * The screen (agent-halt.ts) and the PTY's last output time are what is left when none of
 * these is there (a Claude typed by hand in a shell, an agent version without them): every
 * decision taken from them is counted and logged (SignalLedger), so what still depends on the
 * screen shows.
 *
 * Pure: events in, state out. agent-event-service.ts reads the files.
 */
import {
  claudeResponseFailure,
  codexCallFailure,
  FailureLoops,
  type FailureRun,
} from './agent-failure-loop.js';
import { type AgentHalt, type AgentHaltKind, parseResumeAt } from './agent-halt.js';

export type AgentStateName =
  /** Started, no turn yet. */
  | 'starting'
  | 'working'
  | 'turn-ended'
  /** A permission dialog of the agent's own waits for the user. */
  | 'permission'
  /** The agent asked the user something (AskUserQuestion, an MCP elicitation, a plan). */
  | 'question'
  /** Its turn was cut short by a usage limit, an API error or a lost login (see `halt`). */
  | 'halted'
  | 'compacting'
  | 'ended';

export type AgentEventSource = 'claude-hook' | 'codex-rollout';

export type AgentEventKind =
  | 'session-start'
  | 'turn-start'
  | 'tool-start'
  | 'tool-end'
  | 'activity'
  | 'permission'
  | 'question'
  | 'turn-end'
  | 'halt'
  | 'compact-start'
  | 'compact-end'
  | 'limits'
  | 'session-end';

export interface AgentEvent {
  at: number;
  source: AgentEventSource;
  kind: AgentEventKind;
  /** The tool of a tool event; its call id pairs a start with its end. */
  tool?: string;
  callId?: string;
  /** tool-start (and tool-end when known): what the call is about, one short line. */
  detail?: string;
  /**
   * tool-end: the call failed (Claude's PostToolUseFailure, a non-zero exit code): its error
   * output (agent-failure-loop.ts).
   */
  failure?: string;
  /** activity: a message someone typed to the agent, not its own output (no progress). */
  byUser?: boolean;
  /**
   * turn-end: the agent's last message. halt: its error text. permission/question: what it
   * asks.
   */
  message?: string;
  halt?: AgentHalt;
  /** turn-end: an error that ended the turn but is no halt (a refused prompt, too long). */
  error?: string;
  /** compact-end: the compaction ran on its own mid-turn ('auto') or was asked ('manual'). */
  trigger?: string;
  /** limits: when a limit that is used up resets (epoch ms). */
  resetsAt?: number;
  /** The agent's conversation (Claude session_id, Codex thread id). */
  conversationId?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const oneLine = (value: string, max = 300): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Claude Code's StopFailure `error`: which ones are a halt (going on later works) and which
 * end the turn for a reason going on would hit again (a refused or too long prompt).
 */
const CLAUDE_ERRORS: Record<string, AgentHaltKind | null> = {
  rate_limit: 'usage-limit',
  billing_error: 'usage-limit',
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  account_on_hold: 'auth',
  verification_required: 'auth',
  cloud_credential_error: 'auth',
  overloaded: 'api-error',
  server_error: 'api-error',
  unknown: 'api-error',
  invalid_request: null,
  model_not_found: null,
  max_output_tokens: null,
};

/** The halt kind of a Claude error name (StopFailure `error`, a transcript's `error`). */
export function claudeErrorKind(error: string): AgentHaltKind | null {
  if (error in CLAUDE_ERRORS) return CLAUDE_ERRORS[error];
  // A new one: an error that ended the turn, not the account's or the service's (unknown).
  return null;
}

/** Codex's `codex_error_info` (codex-cli 0.164): the same split. */
const CODEX_ERRORS: Record<string, AgentHaltKind | null> = {
  usage_limit_exceeded: 'usage-limit',
  session_budget_exceeded: 'usage-limit',
  rate_limit_exceeded: 'api-error',
  server_overloaded: 'api-error',
  internal_server_error: 'api-error',
  http_connection_failed: 'api-error',
  response_stream_connection_failed: 'api-error',
  response_stream_disconnected: 'api-error',
  response_too_many_failed_attempts: 'api-error',
  unauthorized: 'auth',
  context_window_exceeded: null,
  cyber_policy: null,
  bio_policy: null,
  misalignment_policy_violation: null,
  bad_request: null,
  invalid_prompt: null,
  sandbox_error: null,
  active_turn_not_steerable: null,
  thread_rollback_failed: null,
  other: null,
};

/** `codex_error_info` is a name, or an object keyed by it ({"http_connection_failed": {…}}). */
function codexErrorName(info: unknown): string | undefined {
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object') {
    const keys = Object.keys(info);
    if (keys.length === 1) return keys[0];
  }
  return undefined;
}

export function codexErrorKind(info: unknown): AgentHaltKind | null {
  const name = codexErrorName(info);
  if (!name) return null;
  return CODEX_ERRORS[name] ?? null;
}

function haltOf(kind: AgentHaltKind, message: string, at: number, resetsAt?: number): AgentHalt {
  const resumeAt =
    kind === 'usage-limit'
      ? resetsAt !== undefined
        ? resetsAt
        : parseResumeAt(message, at)
      : undefined;
  return { kind, message: oneLine(message), ...(resumeAt !== undefined ? { resumeAt } : {}) };
}

const DETAIL_MAX = 120;
/** A failed call's error output kept on its event: enough for its error line. */
const FAILURE_TEXT_MAX = 4000;

/**
 * One short line for what a tool call is about (2026-11-02: a task that sat 1h40m on a Monitor
 * showed only "busy"): its command, description, file or pattern.
 */
export function toolDetail(input: unknown): string | undefined {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return text(value) ? oneLine(value as string, DETAIL_MAX) : undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const fields = value as Record<string, unknown>;
  for (const key of [
    'command',
    'cmd',
    'description',
    'file_path',
    'path',
    'pattern',
    'url',
    'prompt',
  ]) {
    const field = fields[key];
    const said = Array.isArray(field)
      ? field.filter((part) => typeof part === 'string').join(' ')
      : text(field);
    if (said?.trim()) return oneLine(said, DETAIL_MAX);
  }
  return undefined;
}

/** A permission request's command, file or pattern, long enough to judge it (never one line cut at 120). */
export const PERMISSION_ASK_MAX = 4000;

function permissionAsked(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const fields = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'prompt']) {
    const said = text(fields[key]);
    if (said) return said.slice(0, PERMISSION_ASK_MAX);
  }
  return undefined;
}

/** Tools whose call waits for the user: AskUserQuestion's answer, a plan to approve. */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function questionOf(tool: string, input: unknown): string {
  if (tool === 'ExitPlanMode') return 'Approve the plan';
  const questions = (input as { questions?: Array<{ question?: unknown }> } | undefined)?.questions;
  const first = Array.isArray(questions) ? text(questions[0]?.question) : undefined;
  return first ? oneLine(first, 500) : 'Waiting for your answer';
}

/**
 * One Claude Code hook's input (the JSON it gets on stdin) as an event, or null for one that
 * says nothing about the agent's state. `at` is when the hook ran.
 */
export function claudeHookEvent(input: Record<string, unknown>, at: number): AgentEvent | null {
  const name = text(input.hook_event_name);
  const conversationId = text(input.session_id);
  const base = {
    at,
    source: 'claude-hook' as const,
    ...(conversationId ? { conversationId } : {}),
  };
  const tool = text(input.tool_name);
  const callId = text(input.tool_use_id);
  switch (name) {
    case 'SessionStart':
      // After a compaction the conversation goes on: that is the end of the compaction.
      return input.source === 'compact'
        ? { ...base, kind: 'compact-end', trigger: 'auto' }
        : { ...base, kind: 'session-start' };
    case 'UserPromptSubmit':
      return { ...base, kind: 'turn-start' };
    case 'PreToolUse':
      if (tool && ASKING_TOOLS.has(tool)) {
        return { ...base, kind: 'question', tool, message: questionOf(tool, input.tool_input) };
      }
      {
        const detail = toolDetail(input.tool_input);
        return {
          ...base,
          kind: 'tool-start',
          ...(tool ? { tool } : {}),
          ...(callId ? { callId } : {}),
          ...(detail ? { detail } : {}),
        };
      }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const detail = toolDetail(input.tool_input);
      const failure =
        name === 'PostToolUseFailure'
          ? (text(input.error) ?? 'failed')
          : claudeResponseFailure(input.tool_response);
      return {
        ...base,
        kind: 'tool-end',
        ...(tool ? { tool } : {}),
        ...(callId ? { callId } : {}),
        ...(detail ? { detail } : {}),
        ...(failure !== undefined ? { failure: failure.slice(0, FAILURE_TEXT_MAX) } : {}),
      };
    }
    case 'PermissionRequest': {
      // What it asks permission for, whole (2026-11-10: a task sat hours on a prompt nobody
      // could read from outside its screen; "Permission for Bash" said nothing of the command).
      const asked = permissionAsked(input.tool_input);
      return {
        ...base,
        kind: 'permission',
        message: `${tool ? `Permission for ${tool}` : 'Permission'}${asked ? `: ${asked}` : ''}`,
        ...(asked ? { detail: asked } : {}),
      };
    }
    case 'Notification': {
      const type = text(input.notification_type);
      const message = text(input.message);
      if (type === 'permission_prompt') {
        return { ...base, kind: 'permission', message: message ? oneLine(message) : 'Permission' };
      }
      if (type === 'elicitation_dialog') {
        return { ...base, kind: 'question', message: message ? oneLine(message) : 'Question' };
      }
      // idle_prompt: at its prompt a while, waiting for the user (its turn was over already).
      return null;
    }
    case 'Stop': {
      const message = text(input.last_assistant_message);
      return { ...base, kind: 'turn-end', ...(message ? { message } : {}) };
    }
    case 'StopFailure': {
      const error = text(input.error) ?? 'unknown';
      const details =
        text(input.error_details) ?? text(input.last_assistant_message) ?? `API error: ${error}`;
      const kind = claudeErrorKind(error);
      if (!kind) return { ...base, kind: 'turn-end', error, message: details };
      return { ...base, kind: 'halt', halt: haltOf(kind, details, at), message: details };
    }
    case 'SubagentStop':
      return { ...base, kind: 'activity' };
    case 'PreCompact':
      return {
        ...base,
        kind: 'compact-start',
        ...(text(input.trigger) ? { trigger: text(input.trigger) } : {}),
      };
    case 'PostCompact':
      return {
        ...base,
        kind: 'compact-end',
        ...(text(input.trigger) ? { trigger: text(input.trigger) } : {}),
      };
    case 'SessionEnd':
      return { ...base, kind: 'session-end' };
    default:
      return null;
  }
}

/** A used-up limit's reset in a Codex token_count's rate_limits (epoch ms), if one is used up. */
function exhaustedReset(rateLimits: unknown): number | undefined {
  if (!rateLimits || typeof rateLimits !== 'object') return undefined;
  const limits = rateLimits as Record<string, unknown>;
  let reset: number | undefined;
  for (const key of ['primary', 'secondary']) {
    const window = limits[key] as { used_percent?: unknown; resets_at?: unknown } | null;
    if (!window || typeof window.used_percent !== 'number' || window.used_percent < 100) continue;
    if (typeof window.resets_at !== 'number') continue;
    const at = window.resets_at * 1000;
    reset = reset === undefined ? at : Math.max(reset, at);
  }
  return reset;
}

/**
 * Reads a Codex rollout line by line into events. Stateful only for what one line can't say:
 * the reset time of a used-up limit (token_count) comes before the task_complete it explains.
 */
export class CodexRolloutReader {
  private resetsAt?: number;

  line(line: string): AgentEvent | null {
    let entry: { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> };
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    const payload = entry.payload;
    if (!payload || typeof payload !== 'object') return null;
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    if (!Number.isFinite(at)) return null;
    const base = { at, source: 'codex-rollout' as const };
    const kind = payload.type;
    if (entry.type === 'event_msg') {
      if (kind === 'task_started') {
        this.resetsAt = undefined;
        return { ...base, kind: 'turn-start' };
      }
      if (kind === 'token_count') {
        const reset = exhaustedReset(payload.rate_limits);
        this.resetsAt = reset;
        return reset !== undefined ? { ...base, kind: 'limits', resetsAt: reset } : null;
      }
      if (kind === 'task_complete') {
        const error = payload.error as { message?: unknown; codex_error_info?: unknown } | null;
        const last = text(payload.last_agent_message);
        if (error && typeof error === 'object') {
          const message = text(error.message) ?? 'Codex error';
          const halt = codexErrorKind(error.codex_error_info);
          if (halt) {
            return {
              ...base,
              kind: 'halt',
              halt: haltOf(halt, message, at, this.resetsAt),
              message,
            };
          }
          return {
            ...base,
            kind: 'turn-end',
            error: codexErrorName(error.codex_error_info) ?? 'error',
            message: last ?? message,
          };
        }
        return { ...base, kind: 'turn-end', ...(last ? { message: last } : {}) };
      }
      if (kind === 'turn_aborted') return { ...base, kind: 'turn-end', error: 'interrupted' };
      return null;
    }
    if (entry.type === 'compacted') return { ...base, kind: 'compact-end', trigger: 'auto' };
    if (entry.type !== 'response_item') return null;
    const callId = text(payload.call_id);
    if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
      const tool = text(payload.name) ?? 'shell';
      const detail = toolDetail(payload.arguments ?? payload.input ?? payload.action);
      return {
        ...base,
        kind: 'tool-start',
        tool,
        ...(callId ? { callId } : {}),
        ...(detail ? { detail } : {}),
      };
    }
    if (
      kind === 'function_call_output' ||
      kind === 'custom_tool_call_output' ||
      kind === 'local_shell_call_output'
    ) {
      const failure = codexCallFailure(payload.output);
      return {
        ...base,
        kind: 'tool-end',
        ...(callId ? { callId } : {}),
        ...(failure !== undefined ? { failure: failure.slice(0, FAILURE_TEXT_MAX) } : {}),
      };
    }
    if (kind === 'message' && payload.role === 'user') {
      return { ...base, kind: 'activity', byUser: true };
    }
    if (kind === 'message' || kind === 'reasoning') return { ...base, kind: 'activity' };
    return null;
  }
}

/** What Untether knows of an agent's state from its events. */
export interface AgentSnapshot {
  state: AgentStateName;
  /** When it got to this state (epoch ms). */
  since: number;
  source: AgentEventSource;
  /** Its last event of any kind. */
  lastEventAt: number;
  /** Its last turn start, tool call or tool result: when it last did something. */
  lastActionAt?: number;
  /**
   * Its last real progress (2026-11-02): model output (a tool call, a message, the end of its
   * turn) or a tool result. Not a turn start (someone typed to it), not a call merely open.
   */
  lastProgressAt?: number;
  /** Tool calls started and not ended yet (a long command still running). */
  toolsOpen: number;
  /** The oldest call still open: what the agent waits on, and since when. */
  waitingOn?: AgentWait;
  turnStartedAt?: number;
  turnEndedAt?: number;
  /**
   * The last message someone typed that the agent took in (Codex's rollout only). One taken
   * into a turn already going on starts no turn of its own (2026-11-09).
   */
  lastUserInputAt?: number;
  /** The last message of its last turn (Stop's last_assistant_message, task_complete's). */
  finalMessage?: string;
  /** An error that ended its last turn without being a halt. */
  turnError?: string;
  /** state 'halted': what cut it short. */
  halt?: AgentHalt;
  /** state 'permission' / 'question': what it asks. */
  asking?: string;
  conversationId?: string;
  /**
   * Its failing calls, one run per identical failure (agent-failure-loop.ts, 2026-11-03), the
   * most recent last. Absent while none failed.
   */
  failures?: FailureRun[];
}

/** A tool call the agent waits on. */
export interface AgentWait {
  tool: string;
  detail?: string;
  since: number;
}

interface Tracked extends AgentSnapshot {
  open: Map<string, AgentWait>;
  /** The oldest call without an id still counted open. */
  anonymousWait?: AgentWait;
  /** Open calls without an id (counted, never paired). */
  openAnonymous: number;
  /** The state before a compaction or a question, to go back to. */
  before?: AgentStateName;
  loops: FailureLoops;
}

const MAX_TRACKED = 500;

const STATE_NAMES: ReadonlySet<string> = new Set<AgentStateName>([
  'starting',
  'working',
  'turn-ended',
  'permission',
  'question',
  'halted',
  'compacting',
  'ended',
]);

/**
 * A session's tracked state as written to disk (2026-11-03): the snapshot plus the calls still
 * open, so a server restart (they follow merges) does not forget a Claude busy in one long tool
 * call, its progress clock or its turn. Read back by AgentStateTracker.restore.
 */
export interface AgentTrackedState extends AgentSnapshot {
  open: Array<[string, AgentWait]>;
  /** Its failure runs (agent-failure-loop.ts), so a restart keeps counting the same loop. */
  failures?: FailureRun[];
  openAnonymous: number;
  anonymousWait?: AgentWait;
  before?: AgentStateName;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function waitOf(value: unknown): AgentWait | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const wait = value as Record<string, unknown>;
  if (typeof wait.tool !== 'string' || !finite(wait.since)) return undefined;
  return {
    tool: wait.tool,
    ...(typeof wait.detail === 'string' ? { detail: wait.detail } : {}),
    since: wait.since,
  };
}

/** A written AgentTrackedState checked field by field; undefined when it isn't one. */
function trackedFrom(value: unknown): Tracked | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.state !== 'string' || !STATE_NAMES.has(v.state)) return undefined;
  if (!finite(v.since) || !finite(v.lastEventAt)) return undefined;
  if (v.source !== 'claude-hook' && v.source !== 'codex-rollout') return undefined;
  const open = new Map<string, AgentWait>();
  if (Array.isArray(v.open)) {
    for (const entry of v.open) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const wait = waitOf(entry[1]);
      if (wait) open.set(entry[0], wait);
    }
  }
  const anonymousWait = waitOf(v.anonymousWait);
  const openAnonymous =
    finite(v.openAnonymous) && v.openAnonymous > 0 && anonymousWait
      ? Math.floor(v.openAnonymous)
      : 0;
  const t: Tracked = {
    state: v.state as AgentStateName,
    since: v.since,
    source: v.source,
    lastEventAt: v.lastEventAt,
    toolsOpen: 0,
    open,
    openAnonymous,
    ...(openAnonymous > 0 && anonymousWait ? { anonymousWait } : {}),
    loops: FailureLoops.from(v.failures),
  };
  for (const key of [
    'lastActionAt',
    'lastProgressAt',
    'turnStartedAt',
    'turnEndedAt',
    'lastUserInputAt',
  ] as const) {
    if (finite(v[key])) t[key] = v[key];
  }
  for (const key of ['finalMessage', 'turnError', 'asking', 'conversationId'] as const) {
    if (typeof v[key] === 'string') t[key] = v[key];
  }
  if (v.halt && typeof v.halt === 'object') t.halt = v.halt as AgentHalt;
  if (typeof v.before === 'string' && STATE_NAMES.has(v.before)) {
    t.before = v.before as AgentStateName;
  }
  settleWaits(t);
  return t;
}

/** toolsOpen and waitingOn from the calls still open. */
function settleWaits(t: Tracked): void {
  t.toolsOpen = t.open.size + t.openAnonymous;
  const waits = [...t.open.values(), ...(t.anonymousWait ? [t.anonymousWait] : [])];
  const oldest = waits.reduce<AgentWait | undefined>(
    (first, wait) => (!first || wait.since < first.since ? wait : first),
    undefined
  );
  if (oldest) t.waitingOn = { ...oldest };
  else delete t.waitingOn;
}

/** Each session's agent state, from its events in the order they happened. */
export class AgentStateTracker {
  private sessions = new Map<string, Tracked>();

  apply(sessionId: string, event: AgentEvent): void {
    let tracked = this.sessions.get(sessionId);
    if (!tracked) {
      tracked = {
        state: 'starting',
        since: event.at,
        source: event.source,
        lastEventAt: event.at,
        toolsOpen: 0,
        open: new Map(),
        openAnonymous: 0,
        loops: new FailureLoops(),
      };
      this.sessions.set(sessionId, tracked);
      if (this.sessions.size > MAX_TRACKED) {
        this.sessions.delete(this.sessions.keys().next().value as string);
      }
    }
    const t = tracked;
    t.source = event.source;
    t.lastEventAt = Math.max(t.lastEventAt, event.at);
    if (event.conversationId) t.conversationId = event.conversationId;
    const enter = (state: AgentStateName) => {
      if (t.state !== state) {
        t.state = state;
        t.since = event.at;
      }
      if (state !== 'halted') delete t.halt;
      if (state !== 'permission' && state !== 'question') delete t.asking;
    };
    const closeTools = () => {
      t.open.clear();
      t.openAnonymous = 0;
      delete t.anonymousWait;
    };
    const progress = () => {
      t.lastProgressAt = Math.max(t.lastProgressAt ?? event.at, event.at);
    };
    switch (event.kind) {
      case 'session-start':
        closeTools();
        enter('starting');
        break;
      case 'turn-start':
        closeTools();
        t.turnStartedAt = event.at;
        t.lastActionAt = event.at;
        delete t.finalMessage;
        delete t.turnError;
        enter('working');
        break;
      case 'tool-start': {
        const wait: AgentWait = {
          tool: event.tool ?? 'tool',
          ...(event.detail ? { detail: event.detail } : {}),
          since: event.at,
        };
        if (event.callId) t.open.set(event.callId, wait);
        else {
          t.openAnonymous++;
          t.anonymousWait ??= wait;
        }
        t.lastActionAt = event.at;
        progress();
        enter('working');
        break;
      }
      case 'tool-end': {
        const started = event.callId ? t.open.get(event.callId) : undefined;
        if (event.tool || started) {
          t.loops.toolEnded(
            {
              tool: event.tool ?? started?.tool ?? 'tool',
              command: event.detail ?? started?.detail,
              failure: event.failure,
              at: event.at,
            },
            t.turnStartedAt ?? 0
          );
        }
        if (event.callId && t.open.has(event.callId)) t.open.delete(event.callId);
        else if (t.openAnonymous > 0) {
          t.openAnonymous--;
          if (t.openAnonymous === 0) delete t.anonymousWait;
        }
        t.lastActionAt = event.at;
        progress();
        // An answered question, a granted permission: back at work.
        enter('working');
        break;
      }
      case 'activity':
        if (event.byUser) t.lastUserInputAt = event.at;
        else progress();
        if (t.state === 'starting' || t.state === 'turn-ended') break;
        if (t.state !== 'halted' && t.state !== 'ended') enter('working');
        break;
      case 'permission':
      case 'question':
        // Claude's Notification for the same prompt ("Claude needs your permission to use
        // Bash") comes after its PermissionRequest: it does not replace what that one said.
        if (
          event.kind === 'permission' &&
          t.state === 'permission' &&
          !event.detail &&
          t.asking?.includes(': ')
        ) {
          break;
        }
        enter(event.kind);
        t.asking = event.message;
        break;
      case 'turn-end':
        closeTools();
        progress();
        t.turnEndedAt = event.at;
        if (event.message) t.finalMessage = event.message;
        if (event.error) t.turnError = event.error;
        enter('turn-ended');
        break;
      case 'halt':
        closeTools();
        t.turnEndedAt = event.at;
        enter('halted');
        t.halt = event.halt;
        break;
      case 'compact-start':
        if (t.state !== 'compacting') t.before = t.state;
        enter('compacting');
        break;
      case 'compact-end': {
        if (t.state !== 'compacting' && event.trigger === 'auto') break;
        const back = event.trigger === 'manual' ? 'turn-ended' : (t.before ?? 'working');
        enter(back === 'compacting' ? 'working' : back);
        delete t.before;
        break;
      }
      case 'limits':
        // A used-up limit seen mid-turn: kept on the halt that follows (CodexRolloutReader).
        break;
      case 'session-end':
        closeTools();
        enter('ended');
        break;
    }
    settleWaits(t);
  }

  /** Everything tracked of the session, to write to disk (see restore). */
  dump(sessionId: string): AgentTrackedState | undefined {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) return undefined;
    const { open, loops, ...rest } = tracked;
    const failures = loops.list();
    return {
      ...rest,
      open: [...open.entries()].map(([id, wait]) => [id, { ...wait }]),
      ...(failures.length ? { failures } : {}),
    };
  }

  /**
   * Takes back a state `dump` wrote (after a server restart), unless events of this session were
   * seen already: those are newer. False when there was nothing valid to take back.
   */
  restore(sessionId: string, state: unknown): boolean {
    if (this.sessions.has(sessionId)) return false;
    const tracked = trackedFrom(state);
    if (!tracked) return false;
    this.sessions.set(sessionId, tracked);
    if (this.sessions.size > MAX_TRACKED) {
      this.sessions.delete(this.sessions.keys().next().value as string);
    }
    return true;
  }

  get(sessionId: string): AgentSnapshot | undefined {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) return undefined;
    const {
      open: _open,
      openAnonymous: _anonymous,
      anonymousWait: _wait,
      before: _before,
      loops,
      ...snapshot
    } = tracked;
    const failures = loops.list();
    return { ...snapshot, ...(failures.length ? { failures } : {}) };
  }

  /**
   * Whether the agent did something at or after `since`: a turn start, a tool call or result,
   * or a tool call still running (a command that may write files). Undefined when its events
   * tell nothing (none seen for this session).
   */
  actedSince(sessionId: string, since: number): boolean | undefined {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) return undefined;
    if (tracked.open.size + tracked.openAnonymous > 0) return true;
    return tracked.lastActionAt !== undefined && tracked.lastActionAt >= since;
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }
}

/** A decision about an agent and where its answer came from. */
export type AgentDecision =
  /** Did a turn end on a usage limit, an API error, a lost login? */
  | 'halt'
  /** Did the agent act while a check ran (files changed by it, or by the check)? */
  | 'agent-active'
  /** Is a Codex turn over? */
  | 'turn-ended'
  /** Is a settled Codex task's agent at work again? */
  | 'works-again'
  /** Did the agent end on a question for the user? */
  | 'question';

/**
 * Where an answer came from: the agent's own events, its transcript, Claude's own status file,
 * or the fallbacks: the screen's text, the PTY's last output time, the reply's last character.
 */
export type SignalSource = 'events' | 'transcript' | 'status-file' | 'screen' | 'output' | 'text';

/** Sources that read the terminal, not the agent: what this file is about to retire. */
export const SCREEN_SOURCES: ReadonlySet<SignalSource> = new Set(['screen', 'output']);

/**
 * Counts each decision by its source and logs those taken from the screen (once a minute per
 * decision and session at most), so a decision that still depends on it shows in the log.
 */
export class SignalLedger {
  private counts = new Map<string, number>();
  private lastLogged = new Map<string, number>();

  constructor(
    private readonly log?: (message: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  record(decision: AgentDecision, source: SignalSource, sessionId?: string, why?: string): void {
    const key = `${decision}:${source}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (!SCREEN_SOURCES.has(source) || !this.log) return;
    const logKey = `${key}:${sessionId ?? ''}`;
    const last = this.lastLogged.get(logKey);
    if (last !== undefined && this.now() - last < 60_000) return;
    this.lastLogged.set(logKey, this.now());
    if (this.lastLogged.size > 1000)
      this.lastLogged.delete(this.lastLogged.keys().next().value as string);
    this.log(
      `[agent-state] ${decision} decided from the ${source === 'screen' ? 'screen' : 'terminal output time'}` +
        `${sessionId ? ` (session ${sessionId})` : ''}${why ? `: ${why}` : ''}`
    );
  }

  /** Counts so far: decision → source → times. */
  snapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [key, count] of this.counts) {
      const [decision, source] = key.split(':');
      out[decision] ??= {};
      out[decision][source] = count;
    }
    return out;
  }

  /** How many decisions came from the screen or the output time, and how many in all. */
  screenShare(): { screen: number; total: number } {
    let screen = 0;
    let total = 0;
    for (const [key, count] of this.counts) {
      total += count;
      if (SCREEN_SOURCES.has(key.split(':')[1] as SignalSource)) screen += count;
    }
    return { screen, total };
  }
}

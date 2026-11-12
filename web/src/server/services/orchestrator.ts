/**
 * A project's orchestrator (P7, 2026-10-18): one Claude session in the repository's main
 * checkout that gets the user's goal, splits it into tasks with `ut task …`, follows them and
 * merges them, and pings the user only when something is off.
 *
 * - start(repo, goal): a new Claude session (the user's Claude quick start, without its
 *   permission bypass) with exactly `Bash(ut task:*)` and `Bash(ut project:*)` allowed, briefed
 *   by shared/orchestrator-prompt.ts. It gets the orchestrator's rights on the project
 *   (task-commands.ts: risk, discarding, keeping and settings still wait for the user's OK);
 *   its session id is kept in projects.json so it survives a server restart. A second goal for
 *   a running orchestrator (or one still starting) is typed into it instead.
 * - Delivery (2026-10-20): goals, briefs and task events wait in a queue per orchestrator and
 *   go in one at a time, only while its Claude is not at work, and stay queued until they were
 *   really typed (no give-up while the session runs). start/adopt wait a while for the brief
 *   and answer `pending` when it is still queued.
 * - Events: a push about a task the orchestrator started (origin 'orchestrator') is typed
 *   into the orchestrator's session instead, with the task's blocker in full and what to do
 *   next. Only "merged" still reaches the phone (optional). Events whose task moved on before
 *   they were typed are dropped. Discarded tasks and tasks working for over an hour are
 *   noticed by a light watch; taskEvent()/notice() take the rest (phone actions,
 *   confirmations). When the orchestrator goes away, events it never got become pushes again.
 * - Its own "finished" / "replied" pushes reach the phone unless it replied with the quiet
 *   marker (or with no text at all).
 * - adopt(repo, session): an open Claude session becomes the project's orchestrator, wherever
 *   it was opened (every command carries --repo). It keeps its conversation, gets the same
 *   rights and a short brief, and the open tasks it started before tell it too.
 * - stop(repo): forgets it and ends its session (an adopted one is told and left open); the
 *   tasks go on (their pushes reach the user again).
 * - Digest (2026-11-02): only events that need the orchestrator (isUrgentEvent) go in at once;
 *   informational ones wait for the project's digest (digestMinutes, default 15) or go in
 *   ahead of the next urgent note or message. Held ones never go to the phone as held pushes.
 * - Blindar or "Resume Claude" reopens a session as another: the orchestrator follows it
 *   (sessionReplacing / sessionReplaced), with its queued events, even after it had ended.
 */

import * as fs from 'fs';
import * as path from 'path';
import { actualModelText, taskActualModel } from '../../shared/agent-models.js';
import {
  PROMPT_ESCALATE_MS,
  promptSummary,
  promptWhole,
  type TaskPrompt,
  wrappedNote,
} from '../../shared/agent-prompt.js';
import { agentPush } from '../../shared/agent-push.js';
import {
  cleanGoal,
  DIGEST_MINUTES_DEFAULT,
  isQuietReply,
  isUrgentEvent,
  ORCHESTRATOR_MANUAL_VERSION,
  type OrchestratorEvent,
  type OrchestratorEventKind,
  type OrchestratorProvider,
  oneLine,
  orchestratorAdoptPrompt,
  orchestratorEventMessage,
  orchestratorManualUpdates,
  orchestratorPrompt,
} from '../../shared/orchestrator-prompt.js';
import type { ProjectSettings } from '../../shared/projects.js';
import { clockOf, failureNudgesLine, progressLine } from '../../shared/task-progress.js';
import { taskResultLines } from '../../shared/task-result.js';
import {
  autoFixRounds,
  TASK_AUTO_FIX_MAX,
  TASK_AUTO_FIX_TOTAL_MAX,
  TASK_FINAL_STATES,
  type TaskRecord,
  type TaskState,
  taskTitleFromPrompt,
} from '../../shared/tasks.js';
import { loopStep } from '../utils/periodic-loop.js';
import type { AgentHalt } from './agent-halt.js';
import { BACKGROUND } from './claude-status-notifier.js';
import type { NotificationPayload } from './push-notification-service.js';
import type { SessionReplacementFollower } from './session-replacements.js';

/**
 * What the orchestrator's Claude may run without asking. Read-only tools (Read, Grep, Glob)
 * need no rule: Claude Code runs them in its folder without asking, which is all it needs to
 * write precise prompts; anywhere else it asks the user, as it should.
 */
export const ORCHESTRATOR_ALLOWED_TOOLS = ['Bash(ut task:*)', 'Bash(ut project:*)'];

/** After typing something in, wait this long for Claude to pick it up before typing more. */
export const DELIVERY_SETTLE_MS = 60_000;
/** Typing failed while the session runs: try again after this long. */
export const DELIVERY_RETRY_MS = 15_000;
/** How long a task's push may wait for a busy orchestrator before the phone gets it too. */
export const HELD_PUSH_MS = 15 * 60_000;

/** How long start/adopt wait for the brief to be typed before answering `pending`. */
export const BRIEF_WAIT_MS = 45_000;
/**
 * A long working spell with real progress this recent is informational (digest); older, or
 * none at all, it needs the orchestrator to look (2026-11-02).
 */
export const LONG_RUNNING_PROGRESS_MS = 30 * 60_000;
/** A task working this long in one go is news for its orchestrator. */
export const LONG_RUNNING_MS = 60 * 60_000;
/** How often the watch looks at the orchestrators' tasks (discarded, long-running). */
export const WATCH_INTERVAL_MS = 60_000;
/** After a usage limit's reset time, before typing into its Claude again. */
const LIMIT_RESET_SLACK_MS = 30_000;
/** A limit's reset is looked at again at least this often (its Claude may go on earlier). */
const LIMIT_RECHECK_MS = 10 * 60_000;
/** Ended orchestrators remembered for a resume of their conversation. */
const EXITED_KEEP = 50;

const TASK_PUSHES: Record<string, OrchestratorEventKind> = {
  'task-ready': 'ready',
  'task-needs-you': 'needs_you',
  'task-failed': 'failed',
  'task-merged': 'merged',
  'task-done': 'done',
  'task-paused': 'paused',
  'task-queued': 'queued',
  'task-started': 'started',
  'task-agent-changed': 'agent-changed',
  'task-budget': 'budget',
  'task-stalled': 'stalled',
  'task-looping': 'looping',
};

/** Flags of the user's quick start that must not reach the orchestrator's Claude. */
const BYPASS_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
]);
const TOOL_FLAGS = new Set(['--allowedTools', '--allowed-tools']);

/**
 * The orchestrator's command line from the user's Claude quick start. 2026-10-20: the quick
 * start's --dangerously-skip-permissions made the "only ut task" rule fake: orchestrators ran
 * pkill, curl and git, edited another repository and deleted a file. Its permission flags
 * (bypass, any --permission-mode, its own allowed tools) are dropped, so --allowedTools is
 * the whole list and anything else asks the user.
 */
export function orchestratorCommand(base: string[]): string[] {
  const argv = path.basename(base[0] ?? '') === 'claude' ? base : ['claude'];
  const out = [argv[0]];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (BYPASS_FLAGS.has(arg) || arg.startsWith('--permission-mode=')) continue;
    if (arg === '--permission-mode') {
      i++;
      continue;
    }
    if ([...TOOL_FLAGS].some((flag) => arg.startsWith(`${flag}=`))) continue;
    if (TOOL_FLAGS.has(arg)) {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) i++;
      continue;
    }
    out.push(arg);
  }
  return [...out, '--allowedTools', ...ORCHESTRATOR_ALLOWED_TOOLS];
}

export interface OrchestratorInfo {
  repoPath: string;
  sessionId: string;
  /** A session the user made the orchestrator: stopping it leaves the session open. */
  adopted?: boolean;
  /** Its brief is not typed in yet (Claude still starting, or busy). */
  pending?: boolean;
}

export interface OrchestratorDeps {
  commands: {
    registerOrchestrator(sessionId: string, repoPath: string): void;
    unregisterOrchestrator(sessionId: string, repoPath?: string): void;
  };
  settings: {
    get(repoPath: string): ProjectSettings;
    update(
      repoPath: string,
      patch: { orchestratorSessionId: string | null; orchestratorAdopted?: boolean | null }
    ): unknown;
    list(): Array<{ repoPath: string; settings: ProjectSettings }>;
    /** Moves records of project folders that were renamed or moved (before restore looks). */
    followMoves?: () => Promise<unknown>;
    /** Where a folder a project moved away from is now (null: not one). */
    currentPath?: (dir: string) => string | null;
  };
  tasks: () => { get(id: string): TaskRecord | undefined; list(): TaskRecord[] } | null;
  /** Starts the orchestrator's session in the repository. */
  createSession(
    command: string[],
    options: { name: string; userTitle: string; workingDir: string }
  ): Promise<{ sessionId: string }>;
  /**
   * Types text into the session once Claude is ready at its prompt; resolves to whether it
   * was typed. It waits while `keepWaiting` says yes and the session runs.
   */
  deliver(
    sessionId: string,
    text: string,
    options?: { keepWaiting?: () => boolean; trustFolder?: boolean }
  ): Promise<boolean> | boolean;
  /** 'running' while the session lives. */
  sessionStatus(sessionId: string): string | undefined;
  stopSession(sessionId: string): Promise<void>;
  /** The user's Claude command line (quick start). */
  claudeCommand(): string[];
  /** The configured external model providers, for the brief (model-providers.ts); none: unset. */
  providers?: () => OrchestratorProvider[] | undefined;
  /** The main checkout of the repository `dir` is in (normalized), null outside one. */
  resolveRepo(dir: string): Promise<string | null>;
  /**
   * The open tasks `sessionId` started in the project before it became its orchestrator now
   * tell it (task-scheduler.adoptTasks); resolves to how many.
   */
  adoptTasks?: (sessionId: string, repoPath: string) => number;
  /** "Merged" pushes of the orchestrator's tasks still reach the phone (default yes). */
  pushMerged?: () => boolean;
  /** Sends a push (events the orchestrator never got, when it goes away). */
  notify?: (payload: NotificationPayload) => void;
  /**
   * Closes (discards) a task that changed nothing once its report is typed into the
   * orchestrator; a task with work of any kind is never closed by it.
   */
  closeReported?: (taskId: string) => void;
  /** The Claude conversation the session runs, when known (tells a Claude session). */
  claudeConversation?: (sessionId: string) => string | undefined;
  pathExists?: (dir: string) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string) => void;
  /**
   * The ledger of messages between agents (agent-messages.ts): told when one of its messages
   * was typed in, or never will be.
   */
  messages?: {
    delivered(id: string): void;
    undeliverable(id: string, why: string): void;
    /** Still queued, and why it cannot be typed in now. */
    waiting?(id: string, why: string): void;
  };
  /**
   * What cut the session's Claude short, by its own events (a usage limit, an API error), while
   * no turn started since. 2026-11-10: text typed into a Claude at its usage limit only fails
   * again; it waits for the reset, saying so.
   */
  halt?: (sessionId: string) => AgentHalt | undefined;
  /** The question of a menu or dialog on the session's screen, null when none. */
  screenPrompt?: (sessionId: string) => Promise<string | null>;
  /**
   * Where what waits to be typed into each orchestrator is kept (its queue, task events and
   * whether its brief is still pending), so a restart loses none of it (2026-10-20: they
   * lived in memory only; an adopted session never learned its role and a held-back question
   * was lost). JSON, written atomically, 0600. None: memory only (tests).
   */
  statePath?: string;
}

/** What orchestrators.json holds per orchestrator. */
interface StoredOrchestrator {
  sessionId: string;
  repoPath: string;
  messages: string[];
  /** The ledger id of each of `messages`, by position (null: not a ledger message). */
  messageIds?: Array<string | null>;
  events: QueuedEvent[];
  briefPending?: boolean;
  brief?: string;
  /** The manual version its brief had (ORCHESTRATOR_MANUAL_VERSION); none = the first. */
  manual?: number;
  /** Working spells already told as long (task id → its stateSince). */
  longNoted?: Record<string, string>;
  /** The latest task pushes it took (their outbox ids): a resend of one is ignored. */
  delivered?: string[];
}

/** Task push ids each orchestrator remembers (a resend comes right after a restart). */
const DELIVERED_KEPT = 200;

/** An orchestrator whose session ended: resuming its conversation makes it one again. */
interface StoredExited {
  sessionId: string;
  repoPath: string;
  adopted: boolean;
}

const STATE_VERSION = 1;

/** Text to type in; `settle` hears whether it was. */
interface Message {
  text: string;
  /** Its id in the ledger of messages between agents (another orchestrator's request). */
  id?: string;
  settle?: (typed: boolean) => void;
  /**
   * The brief of a session Untether started: starting it was trusting its folder, so Claude
   * Code's trust dialog is answered while it goes in (2026-10-23: a new orchestrator sat on
   * "Yes, I trust this folder" and the user saw it on the phone without knowing why).
   */
  trustFolder?: boolean;
}

interface QueuedEvent {
  event: OrchestratorEvent;
  /** The task's state when it happened: once the task is elsewhere, the event is stale. */
  state?: TaskState;
  /** The phone push it stands for (sent after all when the orchestrator never gets it). */
  payload?: NotificationPayload;
  /** Needs the orchestrator now (isUrgentEvent); false: it waits for the project's digest. */
  urgent?: boolean;
}

interface Batch {
  messages: Message[];
  events: QueuedEvent[];
  /** Carried elsewhere or forgotten: its outcome no longer matters. */
  abandoned: boolean;
}

interface Running {
  repoPath: string;
  sessionId: string;
  /** Its Claude's last status (idle, busy, waiting, busy:background). */
  status?: string;
  /** Goals and briefs to type in, in order. */
  queue: Message[];
  /**
   * Task events to type in: the newest per task, in arrival order (2026-10-18: a task's
   * "ready" arrived twice, then "merged", all in one go after the orchestrator had merged it).
   */
  events: Map<string, QueuedEvent>;
  /** Being typed now: nothing else goes in meanwhile (one delivery at a time). */
  inFlight?: Batch;
  /** When something was last typed in; nothing more goes in until Claude picks it up. */
  deliveredAt?: number;
  retry?: unknown;
  /** When the held digest is due (its timer wakes flush then). */
  digestTimer?: unknown;
  digestDueAt?: number;
  /** Its brief still waits to be typed. */
  briefPending?: boolean;
  /** The manual version it knows (its brief's, or the updates it was told since). */
  manual?: number;
  /** The brief's text while it is pending (re-queued after a restart). */
  brief?: string;
  /** Task states the watch saw last, and the working spells already reported as long. */
  seen: Map<string, TaskState>;
  longNoted: Map<string, string>;
  /** Task pushes it took, by outbox id (StoredOrchestrator.delivered). */
  delivered: Set<string>;
}

export type OrchestratorStartResult =
  | { ok: true; repoPath: string; sessionId: string; reused: boolean; pending?: boolean }
  | { ok: false; code: 'bad-request' | 'conflict' | 'error'; message: string };

export class Orchestrator {
  private running = new Map<string, Running>();
  /** Sessions Blindar is reopening: their end is not the orchestrator's. */
  private readonly replacing = new Set<string>();
  /** Starts under way, per project (2026-10-20: two at once made two orchestrators). */
  private readonly starting = new Map<string, Promise<OrchestratorStartResult>>();
  /**
   * Orchestrators whose session ended, by session id: a resumed conversation takes the role
   * back (2026-10-20: a resumed orchestrator came back as a plain session, its tasks pushing
   * to the phone).
   */
  private readonly exited = new Map<string, { repoPath: string; adopted: boolean }>();
  /** Every session's last Claude status (a new entry starts from it). */
  private readonly lastStatus = new Map<string, string>();
  private watchTimer?: unknown;
  private readonly now: () => number;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * After a restart: orchestrators whose sessions still run, from projects.json. Mappings of
   * project folders that are gone (after following moved ones) or of sessions that ended are
   * cleared, and only those two keys (2026-10-20: skylark stayed mapped to a session adopted for
   * a folder that no longer existed).
   */
  async restore(): Promise<void> {
    try {
      await this.deps.settings.followMoves?.();
    } catch (error) {
      this.deps.log?.(`orchestrator restore: following moved projects failed: ${error}`);
    }
    for (const stored of this.readExited()) {
      this.remember(stored.sessionId, this.currentRepo(stored.repoPath), stored.adopted);
    }
    for (const { repoPath, settings } of this.deps.settings.list()) {
      const sessionId = settings.orchestratorSessionId;
      if (!sessionId) continue;
      const exists = this.pathExists(repoPath);
      if (exists && this.deps.sessionStatus(sessionId) === 'running') {
        this.track(repoPath, sessionId);
        continue;
      }
      if (exists) this.remember(sessionId, repoPath, !!settings.orchestratorAdopted);
      this.deps.log?.(
        `orchestrator ${sessionId} of ${repoPath} dropped: ${exists ? 'its session ended' : 'the folder is gone'}`
      );
      this.saveSettings(repoPath, { orchestratorSessionId: null, orchestratorAdopted: null });
    }
    this.restoreQueues();
  }

  /**
   * What the orchestrators had still to get before the restart: back in their queues (a brief
   * that was never typed in first); an orchestrator that is gone has its events pushed to the
   * phone instead.
   */
  private restoreQueues(): void {
    for (const stored of this.readState()) {
      // 2026-10-25: orchestrators.json kept toolshed after it became bakery; its queue
      // follows the project instead of going to the phone as an orchestrator that is gone.
      stored.repoPath = this.currentRepo(stored.repoPath);
      const entry = this.running.get(stored.sessionId);
      if (!entry || entry.repoPath !== stored.repoPath) {
        for (const queued of stored.events) if (queued.payload) this.deps.notify?.(queued.payload);
        for (const id of stored.messageIds ?? []) {
          if (id) this.deps.messages?.undeliverable(id, 'its orchestrator is gone');
        }
        if (stored.messages.length || stored.events.length) {
          this.deps.log?.(
            `orchestrator ${stored.sessionId} is gone: ${stored.events.length} event(s) to the phone, ${stored.messages.length} message(s) dropped`
          );
        }
        continue;
      }
      // Still starting: the one Untether started may still show its trust dialog.
      const trustFolder =
        !!stored.briefPending && !this.deps.settings.get(stored.repoPath).orchestratorAdopted;
      const message = (text: string, index = -1): Message => {
        const id = stored.messageIds?.[index];
        return {
          text,
          ...(typeof id === 'string' ? { id } : {}),
          ...(trustFolder && text === stored.brief ? { trustFolder } : {}),
        };
      };
      const messages = stored.messages.map(message);
      if (stored.briefPending && stored.brief && !stored.messages.includes(stored.brief)) {
        messages.unshift(message(stored.brief));
      }
      entry.queue.push(...messages);
      for (const queued of stored.events) {
        const key = eventKey(queued.event);
        if (!entry.events.has(key)) entry.events.set(key, queued);
      }
      if (stored.briefPending) {
        entry.briefPending = true;
        entry.brief = stored.brief;
      }
      entry.manual = stored.briefPending ? ORCHESTRATOR_MANUAL_VERSION : stored.manual;
      // 2026-10-20 review: empty after every restart, so each one told the same long spells.
      for (const [taskId, since] of Object.entries(stored.longNoted ?? {})) {
        if (typeof since === 'string') entry.longNoted.set(taskId, since);
      }
      for (const id of stored.delivered ?? []) if (typeof id === 'string') entry.delivered.add(id);
      this.deps.log?.(
        `orchestrator ${stored.sessionId}: ${messages.length} message(s) and ${stored.events.length} event(s) restored`
      );
    }
    // An orchestrator briefed with an older manual hears what changed since.
    for (const entry of this.running.values()) {
      const updates = orchestratorManualUpdates(entry.manual ?? 1);
      if (updates) entry.queue.push({ text: updates });
      entry.manual = ORCHESTRATOR_MANUAL_VERSION;
    }
    this.persist();
    for (const entry of this.running.values()) this.flush(entry);
  }

  private readExited(): StoredExited[] {
    if (!this.deps.statePath) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.deps.statePath, 'utf8')) as {
        exited?: unknown;
      };
      return Array.isArray(data.exited)
        ? (data.exited as StoredExited[]).filter(
            (item) =>
              !!item && typeof item.sessionId === 'string' && typeof item.repoPath === 'string'
          )
        : [];
    } catch {
      return [];
    }
  }

  private readState(): StoredOrchestrator[] {
    if (!this.deps.statePath) return [];
    let data: { version?: unknown; orchestrators?: unknown };
    try {
      data = JSON.parse(fs.readFileSync(this.deps.statePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log?.(`orchestrator state unreadable, ignored: ${error}`);
      }
      return [];
    }
    if (data?.version !== STATE_VERSION || !Array.isArray(data.orchestrators)) return [];
    return (data.orchestrators as StoredOrchestrator[]).filter(
      (item) =>
        !!item &&
        typeof item.sessionId === 'string' &&
        typeof item.repoPath === 'string' &&
        Array.isArray(item.messages) &&
        item.messages.every((text) => typeof text === 'string') &&
        Array.isArray(item.events) &&
        item.events.every((queued) => !!queued?.event && typeof queued.event.taskId === 'string')
    );
  }

  /**
   * A task's push held back for its orchestrator goes to the phone after all once it has
   * waited HELD_PUSH_MS: the orchestrator may be busy for hours, or stuck at a prompt of its
   * own (2026-10-20 review: a task needing the user stayed unheard meanwhile). The event
   * stays queued for the orchestrator.
   */
  private releaseHeldPushes(): void {
    let changed = false;
    for (const entry of this.running.values()) {
      for (const queued of entry.events.values()) {
        const at = queued.event.at;
        // Held for the digest on purpose: informational, never worth the phone.
        if (!queued.payload || queued.urgent === false) continue;
        if (at === undefined || this.now() - at < HELD_PUSH_MS) continue;
        this.deps.notify?.(queued.payload);
        queued.payload = undefined;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Save what waits for every orchestrator (atomically, 0600). */
  private persist(): void {
    const file = this.deps.statePath;
    if (!file) return;
    const orchestrators: StoredOrchestrator[] = [...this.running.values()].map((entry) => {
      const waiting = [...(entry.inFlight?.messages ?? []), ...entry.queue];
      const messages = waiting.map((message) => message.text);
      const messageIds = waiting.map((message) => message.id ?? null);
      const events = [...(entry.inFlight?.events ?? [])].filter(
        (queued) => !entry.events.has(eventKey(queued.event))
      );
      events.push(...entry.events.values());
      return {
        sessionId: entry.sessionId,
        repoPath: entry.repoPath,
        messages,
        ...(messageIds.some(Boolean) ? { messageIds } : {}),
        events,
        ...(entry.briefPending ? { briefPending: true, brief: entry.brief } : {}),
        ...(entry.manual !== undefined ? { manual: entry.manual } : {}),
        ...(entry.longNoted.size ? { longNoted: Object.fromEntries(entry.longNoted) } : {}),
        ...(entry.delivered.size ? { delivered: [...entry.delivered] } : {}),
      };
    });
    // 2026-10-20 review: kept only in memory, so after a restart "Resume Claude" on an
    // orchestrator's conversation brought it back as a plain session.
    const exited: StoredExited[] = Array.from(this.exited, ([sessionId, entry]) => ({
      sessionId,
      ...entry,
    }));
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        `${JSON.stringify({ version: STATE_VERSION, orchestrators, exited })}\n`,
        {
          mode: 0o600,
        }
      );
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
    } catch (error) {
      this.deps.log?.(`orchestrator state could not be saved: ${error}`);
    }
  }

  /**
   * Project folders that moved (ProjectSettingsStore.followedBy): the orchestrators of the old
   * folder, running or exited, belong to the new one, their rights and what waits for them
   * included (2026-10-25: toolshed renamed to bakery kept its orchestrator on toolshed, so
   * sessionFor(bakery) found none and `ut project tell bakery` failed). How many moved.
   */
  projectsMoved(moved: ReadonlyArray<{ from: string; to: string }>): number {
    let count = 0;
    for (const { from, to } of moved) {
      for (const entry of this.running.values()) {
        if (entry.repoPath !== from) continue;
        this.deps.commands.unregisterOrchestrator(entry.sessionId, from);
        entry.repoPath = to;
        this.deps.commands.registerOrchestrator(entry.sessionId, to);
        this.deps.log?.(
          `orchestrator ${entry.sessionId} follows its project from ${from} to ${to}`
        );
        count++;
      }
      for (const entry of this.exited.values()) {
        if (entry.repoPath !== from) continue;
        entry.repoPath = to;
        count++;
      }
    }
    if (count) this.persist();
    return count;
  }

  /** Running orchestrators, one per project. */
  list(): OrchestratorInfo[] {
    return [...this.running.values()]
      .filter((entry) => this.deps.sessionStatus(entry.sessionId) === 'running')
      .map(({ repoPath, sessionId, briefPending }) => ({
        repoPath,
        sessionId,
        ...(this.deps.settings.get(repoPath).orchestratorAdopted ? { adopted: true } : {}),
        ...(briefPending ? { pending: true } : {}),
      }));
  }

  /** The project's orchestrator session, when one runs. */
  sessionFor(repoPath: string): string | undefined {
    const entry = [...this.running.values()].find((item) => item.repoPath === repoPath);
    return entry && this.deps.sessionStatus(entry.sessionId) === 'running'
      ? entry.sessionId
      : undefined;
  }

  async start(dir: string, goal: string): Promise<OrchestratorStartResult> {
    const text = cleanGoal(goal);
    if (!text) return { ok: false, code: 'bad-request', message: 'A goal is required' };
    const repoPath = await this.deps.resolveRepo(dir);
    if (!repoPath)
      return { ok: false, code: 'bad-request', message: 'Not inside a git repository' };
    const under = this.starting.get(repoPath);
    if (under) await under;
    const current = this.sessionFor(repoPath);
    if (current) {
      this.enqueue(current, `[untether] New goal from the user:\n${text}`);
      return { ok: true, repoPath, sessionId: current, reused: true };
    }
    const job = this.startNew(repoPath, text);
    this.starting.set(repoPath, job);
    try {
      return await job;
    } finally {
      if (this.starting.get(repoPath) === job) this.starting.delete(repoPath);
    }
  }

  private async startNew(repoPath: string, text: string): Promise<OrchestratorStartResult> {
    const repoName = path.basename(repoPath);
    let sessionId: string;
    try {
      ({ sessionId } = await this.deps.createSession(
        orchestratorCommand(this.deps.claudeCommand()),
        {
          name: `orchestrator (${repoName})`,
          // The board's badge says it is the orchestrator; the title says what for.
          userTitle: taskTitleFromPrompt(text).slice(0, 60),
          workingDir: repoPath,
        }
      ));
    } catch (error) {
      return {
        ok: false,
        code: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    this.track(repoPath, sessionId);
    this.saveSettings(repoPath, { orchestratorSessionId: sessionId, orchestratorAdopted: null });
    this.deps.log?.(`orchestrator ${sessionId} started in ${repoPath}`);
    const typed = await this.brief(
      sessionId,
      orchestratorPrompt({ goal: text, repoPath, repoName, providers: this.deps.providers?.() }),
      { trustFolder: true }
    );
    if (typed === false) {
      this.forget(sessionId, repoPath);
      return {
        ok: false,
        code: 'error',
        message: "The orchestrator's session ended before it got the goal",
      };
    }
    return { ok: true, repoPath, sessionId, reused: false, ...(typed ? {} : { pending: true }) };
  }

  /**
   * Make a running Claude session the project's orchestrator, keeping its conversation. A
   * goal, when given, goes with the brief; without one it carries on with what it was doing.
   * The session may sit in any folder (the user adopted one in ~/Projects for
   * ~/Projects/untether, 2026-10-20): its brief names the project and every command carries
   * --repo.
   */
  async adopt(dir: string, sessionId: string, goal = ''): Promise<OrchestratorStartResult> {
    const repoPath = await this.deps.resolveRepo(dir);
    if (!repoPath)
      return { ok: false, code: 'bad-request', message: 'Not inside a git repository' };
    if (this.deps.sessionStatus(sessionId) !== 'running') {
      return { ok: false, code: 'bad-request', message: 'That session is not running' };
    }
    if (!this.lastStatus.has(sessionId) && !this.deps.claudeConversation?.(sessionId)) {
      return { ok: false, code: 'bad-request', message: 'That session is not running Claude' };
    }
    const ownTask = this.deps
      .tasks()
      ?.list()
      .some((task) => task.sessionId === sessionId && !TASK_FINAL_STATES.includes(task.state));
    if (ownTask) {
      return { ok: false, code: 'bad-request', message: "A task's session cannot orchestrate" };
    }
    const elsewhere = this.running.get(sessionId);
    if (elsewhere && elsewhere.repoPath !== repoPath) {
      return {
        ok: false,
        code: 'conflict',
        message: `That session already orchestrates ${path.basename(elsewhere.repoPath)}`,
      };
    }
    const text = cleanGoal(goal);
    const current = this.sessionFor(repoPath);
    if (current === sessionId) {
      // Adopting it again means "tell it again" (2026-10-20: Inkwell's orchestrator, registered
      // before briefs were retried, never got one, and re-adopting it answered OK and typed
      // nothing). Only a brief still waiting to go in is not doubled.
      if (this.running.get(sessionId)?.briefPending) {
        if (text) this.enqueue(current, `[untether] New goal from the user:\n${text}`);
        return { ok: true, repoPath, sessionId, reused: true, pending: true };
      }
      const adoptedTasks = this.deps.adoptTasks?.(sessionId, repoPath) ?? 0;
      this.deps.log?.(`orchestrator ${sessionId} re-adopted in ${repoPath}: brief sent again`);
      const typed = await this.brief(
        sessionId,
        orchestratorAdoptPrompt({
          goal: text,
          repoPath,
          repoName: path.basename(repoPath),
          adoptedTasks,
          providers: this.deps.providers?.(),
        })
      );
      if (typed === false) {
        return { ok: false, code: 'error', message: 'Could not type the brief into that session' };
      }
      return { ok: true, repoPath, sessionId, reused: true, ...(typed ? {} : { pending: true }) };
    }
    if (current || this.starting.has(repoPath)) {
      return {
        ok: false,
        code: 'conflict',
        message: 'This project already has an orchestrator: stop it first',
      };
    }
    this.track(repoPath, sessionId);
    this.saveSettings(repoPath, { orchestratorSessionId: sessionId, orchestratorAdopted: true });
    const adoptedTasks = this.deps.adoptTasks?.(sessionId, repoPath) ?? 0;
    const repoName = path.basename(repoPath);
    this.deps.log?.(`orchestrator ${sessionId} adopted in ${repoPath} (${adoptedTasks} tasks)`);
    const typed = await this.brief(
      sessionId,
      orchestratorAdoptPrompt({
        goal: text,
        repoPath,
        repoName,
        adoptedTasks,
        providers: this.deps.providers?.(),
      })
    );
    if (typed === false) {
      this.forget(sessionId, repoPath);
      return { ok: false, code: 'error', message: 'Could not type the brief into that session' };
    }
    return { ok: true, repoPath, sessionId, reused: false, ...(typed ? {} : { pending: true }) };
  }

  /** Blindar is about to reopen `sessionId` as another session. */
  sessionReplacing(sessionId: string): void {
    if (this.running.has(sessionId)) this.replacing.add(sessionId);
  }

  /**
   * It was not reopened and still runs (its program outlived Llevar a Untether's close,
   * 2026-10-25): it stays the orchestrator; an end that came meanwhile counts now.
   */
  notReplaced(sessionId: string): void {
    if (!this.replacing.delete(sessionId)) return;
    if (this.deps.sessionStatus(sessionId) !== 'running') this.onSessionExited(sessionId);
  }

  /**
   * The reopened session (null when reopening failed) is the orchestrator now: after Blindar,
   * or after "Resume Claude" of an orchestrator whose session had ended.
   */
  sessionReplaced(oldSessionId: string, newSessionId: string | null): number {
    this.replacing.delete(oldSessionId);
    const entry = this.running.get(oldSessionId);
    if (!entry) {
      return this.resumed(oldSessionId, newSessionId) || this.recorded(oldSessionId, newSessionId);
    }
    const { repoPath } = entry;
    const adopted = !!this.deps.settings.get(repoPath).orchestratorAdopted;
    if (!newSessionId) {
      this.forget(oldSessionId, repoPath);
      return 0;
    }
    const carried = this.takePending(entry);
    this.forget(oldSessionId, repoPath);
    this.track(repoPath, newSessionId);
    this.saveSettings(repoPath, {
      orchestratorSessionId: newSessionId,
      orchestratorAdopted: adopted || null,
    });
    const next = this.running.get(newSessionId);
    if (next) {
      next.queue.push(...carried.messages);
      for (const queued of carried.events) next.events.set(eventKey(queued.event), queued);
      next.briefPending = carried.briefPending;
      next.brief = carried.brief;
      this.flush(next);
    }
    this.persist();
    this.deps.log?.(`orchestrator ${oldSessionId} reopened as ${newSessionId} in ${repoPath}`);
    return 1;
  }

  /**
   * Its role (orchestrators.json, projects.json) and queued events follow its session
   * (server.ts registers this with SessionReplacements). Its references are the orchestrators
   * it tracks, one being reopened included, and the ones projects.json names (recorded); not
   * the ended ones it let go, which only the user's resume makes orchestrators again.
   */
  replacementFollower(): SessionReplacementFollower {
    return {
      replacing: (sessionId) => this.sessionReplacing(sessionId),
      notReplaced: (sessionId) => this.notReplaced(sessionId),
      replaced: (oldSessionId, newSessionId) => this.sessionReplaced(oldSessionId, newSessionId),
      references: () => [
        ...this.running.keys(),
        ...this.deps.settings
          .list()
          .map(({ settings }) => settings.orchestratorSessionId ?? '')
          .filter(Boolean),
      ],
    };
  }

  /**
   * projects.json still names `oldSessionId` as a project's orchestrator although it is not
   * tracked (an end heard before the reopen was announced, a restore that missed it): the
   * session its conversation runs in now orchestrates, unless another one already does
   * (2026-10-25 review: the doctor no longer looked at projects.json, nothing would mend it).
   */
  private recorded(oldSessionId: string, newSessionId: string | null): number {
    if (!newSessionId) return 0;
    let moved = 0;
    for (const { repoPath, settings } of this.deps.settings.list()) {
      if (settings.orchestratorSessionId !== oldSessionId) continue;
      if (this.sessionFor(repoPath) || !this.pathExists(repoPath)) continue;
      this.track(repoPath, newSessionId);
      this.saveSettings(repoPath, {
        orchestratorSessionId: newSessionId,
        orchestratorAdopted: settings.orchestratorAdopted || null,
      });
      this.persist();
      this.deps.log?.(`orchestrator ${oldSessionId} of ${repoPath} followed to ${newSessionId}`);
      moved++;
    }
    return moved;
  }

  /** An ended orchestrator's conversation resumed in `newSessionId`: it orchestrates again. */
  private resumed(oldSessionId: string, newSessionId: string | null): number {
    const was = this.exited.get(oldSessionId);
    if (!was || !newSessionId) return 0;
    this.exited.delete(oldSessionId);
    if (this.sessionFor(was.repoPath) || !this.pathExists(was.repoPath)) return 0;
    this.track(was.repoPath, newSessionId);
    this.saveSettings(was.repoPath, {
      orchestratorSessionId: newSessionId,
      orchestratorAdopted: was.adopted || null,
    });
    this.enqueue(
      newSessionId,
      `[untether] You orchestrate ${path.basename(was.repoPath)} again (commands with --repo ${was.repoPath}): its task events reach you again. Check \`ut task list --repo ${was.repoPath}\`, then end your turn.`
    );
    this.deps.log?.(`orchestrator ${oldSessionId} resumed as ${newSessionId} in ${was.repoPath}`);
    return 1;
  }

  /** Forget the project's orchestrator and end its session (an adopted one is told). */
  async stop(
    dir: string
  ): Promise<{ ok: boolean; sessionId?: string; kept?: boolean; message?: string }> {
    // 2026-10-24: a project whose folder is gone (forgotten) kept its running orchestrator:
    // a path it orchestrates is stopped even when it is no longer a repository.
    const given = path.resolve(dir).replace(/(.)\/+$/, '$1');
    const known = (repo: string) =>
      [...this.running.values()].some((entry) => entry.repoPath === repo) ||
      !!this.deps.settings.get(repo).orchestratorSessionId;
    const repoPath = (await this.deps.resolveRepo(dir)) ?? (known(given) ? given : null);
    if (!repoPath) return { ok: false, message: 'Not inside a git repository' };
    const sessionId =
      [...this.running.values()].find((entry) => entry.repoPath === repoPath)?.sessionId ??
      this.deps.settings.get(repoPath).orchestratorSessionId;
    if (!sessionId) return { ok: false, message: 'No orchestrator in this project' };
    // An adopted one is the user's own conversation: it only stops orchestrating (2026-10-18).
    const adopted = !!this.deps.settings.get(repoPath).orchestratorAdopted;
    this.forget(sessionId, repoPath);
    this.exited.delete(sessionId);
    if (this.deps.sessionStatus(sessionId) === 'running') {
      if (adopted) {
        // 2026-10-20: it was told nothing and went on answering events that no longer came.
        const text = `[untether] You no longer orchestrate ${path.basename(repoPath)}; task events go to the user from now on.`;
        void Promise.resolve(this.deps.deliver(sessionId, text)).catch(() => false);
      } else {
        await this.deps.stopSession(sessionId).catch(() => {});
      }
    }
    this.deps.log?.(`orchestrator ${sessionId} stopped in ${repoPath}`);
    return { ok: true, sessionId, ...(adopted ? { kept: true } : {}) };
  }

  /** A status change of some session's Claude (ClaudeStatusNotifier.onTransition). */
  onClaudeTransition(sessionId: string, status: string): void {
    this.lastStatus.set(sessionId, status);
    const entry = this.running.get(sessionId);
    if (!entry) return;
    const known = entry.status !== undefined;
    entry.status = status;
    // Busy, or idle again after a status already seen: it picked up what was typed.
    if (status === 'busy' || status === BACKGROUND || (status === 'idle' && known)) {
      entry.deliveredAt = undefined;
    }
    // Waiting on background work its turn ended with, its prompt takes what is queued too.
    if (status === 'idle' || status === BACKGROUND) this.flush(entry);
  }

  /** A session ended: an orchestrator that did is forgotten (and remembered for a resume). */
  onSessionExited(sessionId: string): void {
    this.lastStatus.delete(sessionId);
    if (this.replacing.has(sessionId)) return;
    const entry = this.running.get(sessionId);
    if (!entry) return;
    this.remember(
      sessionId,
      entry.repoPath,
      !!this.deps.settings.get(entry.repoPath).orchestratorAdopted
    );
    this.forget(sessionId, entry.repoPath);
  }

  /**
   * A task push (task-scheduler.ts): for a task this project's orchestrator started, typed
   * into the orchestrator instead; "merged" still reaches the phone unless switched off.
   */
  routeTaskPush(payload: NotificationPayload): NotificationPayload | null {
    const kind = TASK_PUSHES[payload.type];
    const taskId = payload.data?.taskId;
    // 2026-10-20: a quiet push (an automatic fix under way, a review being retried, a task with
    // pushes off) is for an orchestrator only: never the phone, whoever else would get it.
    const quiet = payload.data?.quiet === true;
    // For the user whoever the task reports to (a prompt nobody answered, one only they may
    // approve: task-scheduler-input.ts tellUserOfPrompt): never typed here instead.
    if (payload.data?.toUser === true) return payload;
    if (!kind || typeof taskId !== 'string') return quiet ? null : payload;
    const task = this.deps.tasks()?.get(taskId);
    const entry = task ? this.entryFor(task) : undefined;
    if (!task || !entry) return quiet ? null : payload;
    // Pushes are sent at least once (task-scheduler.ts post): one whose id it already took is
    // a resend after a restart, ignored (saved with what it queued: persist below).
    const pushId = typeof payload.data?.pushId === 'string' ? payload.data.pushId : undefined;
    if (pushId && entry.delivered.has(pushId)) {
      this.deps.log?.(`orchestrator ${entry.sessionId}: task push ${pushId} again, ignored`);
      return null;
    }
    if (pushId) {
      entry.delivered.add(pushId);
      while (entry.delivered.size > DELIVERED_KEPT) {
        entry.delivered.delete(entry.delivered.values().next().value as string);
      }
    }
    const fallback = typeof payload.data?.detail === 'string' ? payload.data.detail : '';
    const keepMerged = !quiet && kind === 'merged' && (this.deps.pushMerged?.() ?? true);
    const autoFix = task.autoFix
      ? { attempts: task.autoFix.attempts, max: task.autoFix.max }
      : undefined;
    const blocker = task.blocker?.kind;
    const fixable =
      blocker === 'review' ||
      blocker === 'verify' ||
      blocker === 'conflict' ||
      (blocker === 'merge-error' && !!task.blocker?.agentFixable);
    // Ran out: this blocker's rounds, or all of the task's rounds together.
    const fixedOut =
      fixable &&
      ((task.autoFixes?.[blocker] ?? 0) >= TASK_AUTO_FIX_MAX ||
        autoFixRounds(task) >= TASK_AUTO_FIX_TOTAL_MAX);
    // A reminder that it still waits on someone (task-scheduler.ts remindStale) says so first.
    const reminder = typeof payload.data?.reminder === 'string' ? payload.data.reminder : '';
    const detail = [reminder, taskDetail(task, kind) || fallback].filter(Boolean).join(' · ');
    // Untether's own handling ran out: a stall told again, a pause with no try left.
    const escalated =
      (kind === 'stalled' && payload.data?.escalated === true) ||
      (kind === 'paused' && !!task.halt && !task.halt.nextTryAt) ||
      // A task it waits for (--after, its zone) was discarded or failed: a decision is asked.
      (kind === 'queued' && payload.data?.waitStopped === true);
    this.queueEvent(entry, {
      event: {
        ...this.eventFor(task, kind, detail),
        ...(autoFix ? { autoFix } : fixedOut ? { autoFixedOut: true } : {}),
        ...(escalated ? { escalated: true } : {}),
      },
      // Being fixed: the task moves on at once (working), and the note is still news.
      ...(autoFix ? {} : { state: task.state }),
      ...(keepMerged || quiet ? {} : { payload }),
    });
    return keepMerged ? payload : null;
  }

  /**
   * Something happened to an orchestrator's task that makes no push of its own: its agent
   * works again after the user asked it from the phone, it was discarded, a confirmation the
   * orchestrator asked for was answered, or it has been working for an hour. False when the
   * task has no running orchestrator.
   */
  taskEvent(
    taskId: string,
    kind: Extract<
      OrchestratorEventKind,
      'working-again' | 'discarded' | 'confirmation' | 'long-running'
    >,
    detail = '',
    { escalated = false } = {}
  ): boolean {
    const task = this.deps.tasks()?.get(taskId);
    const entry = task ? this.entryFor(task) : undefined;
    if (!task || !entry) return false;
    entry.seen.set(task.id, task.state);
    this.queueEvent(entry, {
      event: {
        ...this.eventFor(task, kind, detail || taskDetail(task, kind)),
        ...(escalated ? { escalated: true } : {}),
      },
      // A decision is news whatever the task does next; the rest is about its state.
      ...(kind === 'confirmation' ? {} : { state: task.state }),
    });
    return true;
  }

  /**
   * A note for the project's orchestrator that is about no task (a settings change it asked
   * for was approved, declined or expired). False when the project has none running.
   */
  notice(repoPath: string, text: string): boolean {
    const sessionId = this.sessionFor(repoPath);
    if (!sessionId) return false;
    this.enqueue(sessionId, `[untether] ${oneLine(text)}`);
    return true;
  }

  /**
   * Another project's orchestrator asks this one something (`ut project tell`): `text` is
   * already marked as that agent's and not the user's, with its id and how to answer it
   * (orchestratorRelayMessage); `messageId` is its record in the ledger, told once it was
   * typed in. False when the project has no orchestrator running.
   */
  relay(toRepo: string, text: string, messageId?: string): boolean {
    const sessionId = this.sessionFor(toRepo);
    if (!sessionId) return false;
    this.enqueue(sessionId, text, messageId);
    return true;
  }

  /**
   * A request from an external app through the project's connector (connector-service.ts),
   * already wrapped and quoted (externalRequestMessage): the same queue as `ut project tell`.
   * False when the project has no orchestrator running.
   */
  external(toRepo: string, text: string): boolean {
    const sessionId = this.sessionFor(toRepo);
    if (!sessionId) return false;
    this.enqueue(sessionId, text);
    return true;
  }

  /**
   * The orchestrator's own "finished" / "replied" pushes: dropped when it replied with the
   * quiet marker or with no text, kept otherwise (a question, a report, the final summary).
   * 2026-10-20: it was kept only when the preview ended in "?", and dropped while any task was
   * open (a failed task stays open forever), so questions, failure reports and summaries
   * rarely reached the phone. The preview is the reply's start; the marker is the whole reply,
   * so the preview is enough to tell it.
   */
  rewritePush(payload: NotificationPayload): NotificationPayload | null {
    const kind = agentPush(payload.type)?.kind;
    if (kind !== 'finished' && kind !== 'replied') return payload;
    const sessionId = payload.data?.sessionId;
    if (typeof sessionId !== 'string' || !this.running.has(sessionId)) return payload;
    const reply = typeof payload.data?.detail === 'string' ? payload.data.detail : '';
    return !reply.trim() || isQuietReply(reply) ? null : payload;
  }

  /** What waits to be typed into the orchestrator (tests, diagnostics). */
  /**
   * What still waits to reach this orchestrator (queued messages, task events, a delivery on
   * its way, its brief), in one line; null when nothing does (session-suspender.ts).
   */
  waitingWork(sessionId: string): string | null {
    const entry = this.running.get(sessionId);
    if (!entry) return null;
    const parts: string[] = [];
    if (entry.queue.length > 0) parts.push(`${entry.queue.length} queued message(s)`);
    if (entry.events.size > 0) {
      const held = [...entry.events.values()].filter((queued) => queued.urgent === false).length;
      parts.push(
        `${entry.events.size} queued task event(s)${held ? ` (${held} for the digest)` : ''}`
      );
    }
    if (entry.inFlight) parts.push('a delivery on its way');
    if (entry.briefPending) parts.push('its brief');
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /** The project this session orchestrates, if any. */
  repoOf(sessionId: string): string | undefined {
    return this.running.get(sessionId)?.repoPath;
  }

  pending(sessionId: string): readonly string[] {
    const entry = this.running.get(sessionId);
    if (!entry) return [];
    const { urgent, digest } = splitEvents([...entry.events.values()]);
    return [
      ...entry.queue.map((message) => message.text),
      ...(urgent.length || digest.length ? [orchestratorEventMessage(urgent, digest)] : []),
    ];
  }

  private entryFor(task: TaskRecord): Running | undefined {
    const sessionId = task.orchestratorSessionId;
    if (task.origin !== 'orchestrator' || !sessionId) return undefined;
    const entry = this.running.get(sessionId);
    return entry && this.deps.sessionStatus(sessionId) === 'running' ? entry : undefined;
  }

  private eventFor(
    task: TaskRecord,
    kind: OrchestratorEventKind,
    detail: string
  ): OrchestratorEvent {
    return {
      taskId: task.id,
      name: task.name,
      ...(task.branch ? { branch: task.branch } : {}),
      kind,
      ...(task.blocker && ['ready', 'needs_you', 'failed'].includes(kind)
        ? { blocker: task.blocker.kind, ...(task.blocker.onScreen ? { onScreen: true } : {}) }
        : {}),
      ...(detail ? { detail } : {}),
      ...(kind === 'ready' && task.isolation === 'none' ? { noWorktree: true } : {}),
      ...(eventResult(task, kind) ?? {}),
      ...(eventMemoryNote(task, kind) ?? {}),
      at: this.now(),
    };
  }

  private queueEvent(entry: Running, queued: QueuedEvent): void {
    queued.urgent = isUrgentEvent(queued.event);
    const key = eventKey(queued.event);
    entry.events.delete(key);
    entry.events.set(key, queued);
    this.flush(entry);
    this.persist();
  }

  /** Type `text` as the brief and wait a while for it: true typed, false never, null not yet. */
  private brief(
    sessionId: string,
    text: string,
    { trustFolder = false } = {}
  ): Promise<boolean | null> {
    const entry = this.running.get(sessionId);
    if (!entry) return Promise.resolve(false);
    entry.briefPending = true;
    entry.brief = text;
    entry.manual = ORCHESTRATOR_MANUAL_VERSION;
    return new Promise((resolve) => {
      let done = false;
      const timer = this.setTimer(() => {
        if (!done) resolve(null);
        done = true;
      }, BRIEF_WAIT_MS);
      entry.queue.push({
        text,
        ...(trustFolder ? { trustFolder } : {}),
        settle: (typed) => {
          const current = [...this.running.values()].find(
            (item) => item.repoPath === entry.repoPath
          );
          if (typed && current) {
            current.briefPending = undefined;
            current.brief = undefined;
            this.persist();
          }
          if (done) return;
          done = true;
          this.clearTimer(timer);
          resolve(typed);
        },
      });
      this.flush(entry);
    });
  }

  private remember(sessionId: string, repoPath: string, adopted: boolean): void {
    this.exited.delete(sessionId);
    this.exited.set(sessionId, { repoPath, adopted });
    while (this.exited.size > EXITED_KEEP) {
      this.exited.delete(this.exited.keys().next().value as string);
    }
  }

  private track(repoPath: string, sessionId: string): void {
    for (const [id, entry] of this.running) {
      if (entry.repoPath === repoPath && id !== sessionId) this.forget(id, repoPath);
    }
    if (!this.running.has(sessionId)) {
      const seen = new Map<string, TaskState>();
      for (const task of this.deps.tasks()?.list() ?? []) {
        if (task.orchestratorSessionId === sessionId) seen.set(task.id, task.state);
      }
      this.running.set(sessionId, {
        repoPath,
        sessionId,
        // 2026-10-20: an adopted session busy with the user was taken for idle and its brief
        // typed into a turn at work. It starts from the status already seen.
        status: this.lastStatus.get(sessionId),
        queue: [],
        events: new Map(),
        seen,
        longNoted: new Map(),
        delivered: new Set(),
      });
    }
    this.exited.delete(sessionId);
    this.deps.commands.registerOrchestrator(sessionId, repoPath);
    this.scheduleWatch();
  }

  /** Everything still to type, in-flight included (that delivery's outcome is ignored). */
  private takePending(entry: Running): {
    messages: Message[];
    events: QueuedEvent[];
    briefPending?: boolean;
    brief?: string;
  } {
    const messages = [...(entry.inFlight?.messages ?? []), ...entry.queue];
    const events = [...(entry.inFlight?.events ?? [])].filter(
      (queued) => !entry.events.has(eventKey(queued.event))
    );
    events.push(...entry.events.values());
    if (entry.inFlight) entry.inFlight.abandoned = true;
    entry.inFlight = undefined;
    entry.queue = [];
    entry.events = new Map();
    return { messages, events, briefPending: entry.briefPending, brief: entry.brief };
  }

  /**
   * Forget an orchestrator. What it never got goes to the phone after all (2026-10-20: the
   * pushes of events still queued were lost on stop or exit), and briefs waiting hear "never".
   */
  private forget(sessionId: string, repoPath: string): void {
    const entry = this.running.get(sessionId);
    if (entry) {
      if (entry.retry !== undefined) this.clearTimer(entry.retry);
      this.clearDigest(entry);
      const left = this.takePending(entry);
      this.running.delete(sessionId);
      for (const message of left.messages) {
        message.settle?.(false);
        if (message.id) this.deps.messages?.undeliverable(message.id, 'its orchestrator ended');
      }
      for (const queued of left.events) if (queued.payload) this.deps.notify?.(queued.payload);
    }
    this.deps.commands.unregisterOrchestrator(sessionId, repoPath);
    if (this.deps.settings.get(repoPath).orchestratorSessionId === sessionId) {
      this.saveSettings(repoPath, { orchestratorSessionId: null, orchestratorAdopted: null });
    }
    if (!this.running.size && this.watchTimer !== undefined) {
      this.clearTimer(this.watchTimer);
      this.watchTimer = undefined;
    }
    this.persist();
  }

  private enqueue(sessionId: string, text: string, id?: string): void {
    const entry = this.running.get(sessionId);
    if (!entry) return;
    entry.queue.push({ text, ...(id ? { id } : {}) });
    this.flush(entry);
    this.persist();
  }

  /**
   * Events whose task has moved on since are no news any more (2026-10-20: bursts of stale
   * "ready" and "needs you", each answered to the user): its newer event, if any, is queued.
   */
  private dropStale(entry: Running): void {
    const tasks = this.deps.tasks();
    if (!tasks) return;
    for (const [key, queued] of entry.events) {
      if (!queued.state) continue;
      const task = tasks.get(queued.event.taskId);
      if (!task || task.state !== queued.state) entry.events.delete(key);
    }
  }

  /**
   * Type the queued goals and events in one message, when Claude is not at work (busy), not
   * waiting on a prompt of its own, has picked up what was typed last, and nothing is being
   * typed already. Kept queued until it was typed.
   */
  private flush(entry: Running): void {
    if (entry.inFlight) return;
    this.dropStale(entry);
    if (!entry.queue.length && !entry.events.size) return;
    // Only informational events, their digest not due yet: they wait for it.
    if (!entry.queue.length && !this.digestDue(entry)) return;
    if (entry.status === 'busy' || entry.status === 'waiting') {
      this.noteWaiting(entry);
      return;
    }
    // At its usage limit until a known time: typed then, never into the limit.
    const until = this.limitedUntil(entry);
    if (until !== undefined) {
      this.noteWaiting(entry);
      this.retryIn(entry, Math.min(until - this.now() + LIMIT_RESET_SLACK_MS, LIMIT_RECHECK_MS));
      return;
    }
    if (entry.deliveredAt !== undefined) {
      const left = entry.deliveredAt + DELIVERY_SETTLE_MS - this.now();
      if (left > 0) {
        this.retryIn(entry, left);
        return;
      }
    }
    const batch: Batch = {
      messages: entry.queue,
      events: [...entry.events.values()],
      abandoned: false,
    };
    entry.queue = [];
    entry.events = new Map();
    entry.inFlight = batch;
    this.clearDigest(entry);
    const { urgent, digest } = splitEvents(batch.events);
    const text = [
      ...batch.messages.map((message) => message.text),
      ...(urgent.length || digest.length ? [orchestratorEventMessage(urgent, digest)] : []),
    ].join('\n');
    const keepWaiting = () => !batch.abandoned && this.running.get(entry.sessionId) === entry;
    const trustFolder = batch.messages.some((message) => message.trustFolder);
    let result: Promise<boolean> | boolean;
    try {
      result = this.deps.deliver(entry.sessionId, text, {
        keepWaiting,
        ...(trustFolder ? { trustFolder } : {}),
      });
    } catch {
      result = false;
    }
    if (typeof result === 'boolean') this.delivered(entry, batch, result);
    else {
      result.then(
        (typed) => this.delivered(entry, batch, typed),
        () => this.delivered(entry, batch, false)
      );
    }
  }

  private delivered(entry: Running, batch: Batch, typed: boolean): void {
    if (entry.inFlight === batch) entry.inFlight = undefined;
    // Carried to a reopened session or forgotten: that path took care of its content.
    if (batch.abandoned || this.running.get(entry.sessionId) !== entry) return;
    if (typed) {
      entry.deliveredAt = this.now();
      for (const message of batch.messages) {
        message.settle?.(true);
        if (message.id) this.deps.messages?.delivered(message.id);
      }
      // Its report is in: the task has nothing else to give, it closes as done (no news).
      for (const { event } of batch.events) {
        if (event.kind !== 'ready' || event.blocker !== 'no-changes') continue;
        const task = this.deps.tasks()?.get(event.taskId);
        if (task?.state !== 'ready' || task.blocker?.kind !== 'no-changes') continue;
        entry.seen.set(task.id, 'done');
        this.deps.closeReported?.(task.id);
      }
      // A brief restored after a restart has no one waiting on it: it is in now.
      if (entry.brief !== undefined && batch.messages.some((m) => m.text === entry.brief)) {
        entry.briefPending = undefined;
        entry.brief = undefined;
      }
      this.flush(entry);
      this.persist();
      return;
    }
    // Not typed: back in line, before what came meanwhile (a newer event of a task wins).
    entry.queue = [...batch.messages, ...entry.queue];
    const events = new Map<string, QueuedEvent>();
    for (const queued of batch.events) {
      const key = eventKey(queued.event);
      if (!entry.events.has(key)) events.set(key, queued);
    }
    for (const [key, queued] of entry.events) events.set(key, queued);
    entry.events = events;
    // A session that ended: forgotten now (its events go to the phone), unless Blindar is
    // reopening it (sessionReplaced carries the queue over).
    if (this.deps.sessionStatus(entry.sessionId) !== 'running') {
      if (!this.replacing.has(entry.sessionId)) this.onSessionExited(entry.sessionId);
      return;
    }
    this.deps.log?.(`orchestrator ${entry.sessionId}: not typed yet, trying again`);
    this.noteWaiting(entry);
    this.retryIn(entry, DELIVERY_RETRY_MS);
  }

  /** When its Claude's usage limit resets, while it is stopped at it and that is still ahead. */
  private limitedUntil(entry: Running): number | undefined {
    let halt: AgentHalt | undefined;
    try {
      halt = this.deps.halt?.(entry.sessionId);
    } catch {
      return undefined;
    }
    if (halt?.kind !== 'usage-limit' || halt.resumeAt === undefined) return undefined;
    return halt.resumeAt > this.now() ? halt.resumeAt : undefined;
  }

  /**
   * The messages between agents still to type into this orchestrator say why they wait (the
   * ledger shows it in `ut project messages` and tells their senders): a turn going on, a
   * prompt of its own, its usage limit, a dialog on its screen. 2026-11-10: m699vq7 stayed
   * «queued (not typed in yet)» for over four hours and nothing said why.
   */
  private noteWaiting(entry: Running): void {
    // Called on its object: `messages` is the ledger itself, and a method taken off it loses
    // its `this` (2026-11-11: "Cannot read properties of undefined (reading 'messages')" was an
    // uncaught exception in this timer, so the server stopped each time a message waited on an
    // orchestrator that was busy or at its usage limit).
    const messages = this.deps.messages;
    if (!messages?.waiting) return;
    const waiting = (id: string, why: string) => messages.waiting?.(id, why);
    const ids = [...(entry.inFlight?.messages ?? []), ...entry.queue]
      .map((message) => message.id)
      .filter((id): id is string => !!id);
    if (!ids.length) return;
    const tell = (why: string) => {
      for (const id of ids) waiting(id, why);
    };
    const until = this.limitedUntil(entry);
    if (until !== undefined) {
      tell(
        `its orchestrator's Claude is stopped at its usage limit until ${clockOf(until)}; it is typed in then`
      );
      return;
    }
    if (entry.status === 'busy') {
      tell("its orchestrator's Claude is in the middle of a turn; it is typed in when that ends");
      return;
    }
    let halt: AgentHalt | undefined;
    try {
      halt = this.deps.halt?.(entry.sessionId);
    } catch {
      halt = undefined;
    }
    const halted = halt ? ` (it was cut short: ${halt.message.slice(0, 160)})` : '';
    const generic =
      entry.status === 'waiting'
        ? "its orchestrator's Claude shows a prompt of its own on its screen and waits for the user's answer there"
        : `its orchestrator's Claude is not ready at its prompt${halted}`;
    const read = this.deps.screenPrompt;
    if (!read) {
      tell(generic);
      return;
    }
    void read(entry.sessionId)
      .catch(() => null)
      .then((question) => {
        if (this.running.get(entry.sessionId) !== entry) return;
        tell(
          question
            ? `its orchestrator's session shows a prompt that waits for the user's answer on its screen («${question.slice(0, 160)}»)${halted}`
            : generic
        );
      });
  }

  /**
   * Whether the queued events go in now: one of them is urgent, the project has no digest
   * (digestMinutes 0), or the oldest held one waited its digestMinutes. Not yet: the digest's
   * timer is armed for when it is due.
   */
  private digestDue(entry: Running): boolean {
    const held = [...entry.events.values()];
    if (held.some((queued) => queued.urgent !== false)) return true;
    const minutes = this.digestMinutes(entry.repoPath);
    if (minutes <= 0) return true;
    const oldest = Math.min(...held.map((queued) => queued.event.at ?? this.now()));
    const dueAt = oldest + minutes * 60_000;
    const left = dueAt - this.now();
    if (left <= 0) return true;
    if (entry.digestTimer === undefined || entry.digestDueAt !== dueAt) {
      this.clearDigest(entry);
      entry.digestDueAt = dueAt;
      entry.digestTimer = this.setTimer(() => {
        entry.digestTimer = undefined;
        entry.digestDueAt = undefined;
        if (this.running.get(entry.sessionId) === entry) this.flush(entry);
      }, left);
    }
    return false;
  }

  private clearDigest(entry: Running): void {
    if (entry.digestTimer !== undefined) this.clearTimer(entry.digestTimer);
    entry.digestTimer = undefined;
    entry.digestDueAt = undefined;
  }

  /** The project's digestMinutes (DIGEST_MINUTES_DEFAULT when unset). */
  private digestMinutes(repoPath: string): number {
    try {
      const minutes = this.deps.settings.get(repoPath).digestMinutes;
      return typeof minutes === 'number' && Number.isFinite(minutes)
        ? minutes
        : DIGEST_MINUTES_DEFAULT;
    } catch {
      return DIGEST_MINUTES_DEFAULT;
    }
  }

  private retryIn(entry: Running, ms: number): void {
    if (entry.retry !== undefined) return;
    entry.retry = this.setTimer(
      loopStep('orchestrator delivery retry', () => {
        entry.retry = undefined;
        if (this.running.get(entry.sessionId) === entry) this.flush(entry);
      }),
      ms
    );
  }

  /** The light watch: discarded tasks and long working spells make no push of their own. */
  private scheduleWatch(): void {
    if (this.watchTimer !== undefined) return;
    this.watchTimer = this.setTimer(() => {
      this.watchTimer = undefined;
      // A watch that throws is logged and counted (the doctor tells it) and the next one is
      // still armed: 2026-11-11, one that threw was an uncaught exception that stopped the server.
      loopStep('orchestrator watch', () => this.watch())();
      if (this.running.size) this.scheduleWatch();
    }, WATCH_INTERVAL_MS);
  }

  private watch(): void {
    this.releaseHeldPushes();
    // A delivery waiting inside its typing (a dialog on screen) retries nothing: looked at here.
    for (const entry of this.running.values()) this.noteWaiting(entry);
    const tasks = this.deps.tasks()?.list() ?? [];
    for (const entry of Array.from(this.running.values())) {
      for (const task of tasks) {
        if (task.orchestratorSessionId !== entry.sessionId || task.origin !== 'orchestrator') {
          continue;
        }
        const before = entry.seen.get(task.id);
        entry.seen.set(task.id, task.state);
        // 2026-10-20: a task made and discarded within one watch was never seen before, so
        // its discard was never told. `seen` starts with every task it had when it was
        // tracked, so one it never saw was made since: its discard is news too.
        if (task.state === 'discarded' && before !== 'discarded') {
          this.taskEvent(task.id, 'discarded');
        } else if (task.state === 'working') {
          const since = Date.parse(task.stateSince);
          if (
            Number.isFinite(since) &&
            this.now() - since >= LONG_RUNNING_MS &&
            entry.longNoted.get(task.id) !== task.stateSince
          ) {
            entry.longNoted.set(task.id, task.stateSince);
            const minutes = Math.round((this.now() - since) / 60_000);
            // 2026-11-02: the note looked healthy while its agent had sat 1h40m on a Monitor.
            // With recent real progress it is news only (digest); without, it needs a look.
            const progressAt = task.progress ? Date.parse(task.progress.at) : Number.NaN;
            const progressing =
              Number.isFinite(progressAt) &&
              this.now() - progressAt < LONG_RUNNING_PROGRESS_MS &&
              !task.progress?.waitingOn;
            this.taskEvent(
              task.id,
              'long-running',
              `working for ${minutes} min; ${progressNote(task, this.now())}`,
              { escalated: !progressing }
            );
          }
        }
      }
    }
  }

  private saveSettings(
    repoPath: string,
    patch: { orchestratorSessionId: string | null; orchestratorAdopted?: boolean | null }
  ): void {
    try {
      this.deps.settings.update(repoPath, patch);
    } catch (error) {
      this.deps.log?.(`orchestrator: could not save the settings of ${repoPath}: ${error}`);
    }
  }

  /** The folder a stored repoPath is in now (a project moved away from it), else itself. */
  private currentRepo(repoPath: string): string {
    return this.deps.settings.currentPath?.(repoPath) ?? repoPath;
  }

  private pathExists(dir: string): boolean {
    return (this.deps.pathExists ?? fs.existsSync)(dir);
  }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms);
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  }

  private clearTimer(handle: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

/**
 * Its agent's structured result for the orchestrator, on the events where the task finished
 * a turn: the outcome, files, tests, risks and follow-ups, and where it disagrees with the branch.
 */
function eventResult(
  task: TaskRecord,
  kind: OrchestratorEventKind
): { result: string[] } | undefined {
  if (!['ready', 'needs_you', 'failed', 'merged', 'done'].includes(kind)) return undefined;
  const actual = taskActualModel(task);
  const lines = [
    // 2026-11-08: the model it really ran with, next to the asked one (agent-models.ts).
    ...(actual
      ? [
          `model: ${actualModelText(actual, task.modelProvider ? undefined : task.model)}${task.model ? '' : " (the agent's default)"}`,
        ]
      : []),
    ...(task.resultMismatch ? [`mismatch: ${task.resultMismatch}`] : []),
    ...(task.result ? taskResultLines(task.result) : []),
    // 2026-11-03: nudges for a repeated failure and whether they helped, to measure them.
    ...[failureNudgesLine(task.failureNudges)].filter((line): line is string => !!line),
    ...(kind === 'merged' && task.memoryNote && 'saved' in task.memoryNote
      ? [
          `memory note ${task.memoryNote.updated ? 'updated' : 'saved'} by Untether: ${task.memoryNote.saved}`,
        ]
      : []),
  ];
  return lines.length ? { result: lines } : undefined;
}

/**
 * A merged task's memory note that Untether did not save (TaskRecord.memoryNote skipped): its
 * orchestrator gets it whole, to save it where the project keeps its memory.
 */
function eventMemoryNote(
  task: TaskRecord,
  kind: OrchestratorEventKind
): Pick<OrchestratorEvent, 'memoryNote'> | undefined {
  const note = task.result?.memoryNote;
  if (kind !== 'merged' || !note) return undefined;
  const why =
    task.memoryNote && 'skipped' in task.memoryNote
      ? task.memoryNote.skipped
      : task.memoryNote
        ? undefined
        : 'not saved when it merged';
  return why ? { memoryNote: { ...note, why } } : undefined;
}

/** Held events split: urgent ones, and the digest's informational ones (in arrival order). */
function splitEvents(events: readonly QueuedEvent[]): {
  urgent: OrchestratorEvent[];
  digest: OrchestratorEvent[];
} {
  return {
    urgent: events.filter((queued) => queued.urgent !== false).map((queued) => queued.event),
    digest: events.filter((queued) => queued.urgent === false).map((queued) => queued.event),
  };
}

/** A task's state events replace each other; an answered request is news of its own. */
function eventKey(event: OrchestratorEvent): string {
  return event.kind === 'confirmation' ? `${event.taskId}:confirmation` : event.taskId;
}

/**
 * What the orchestrator needs to know, from the task record (not the push's 200-character
 * cut): the blocker in full with its detail lines, else the agent's summary.
 */
/** "last real progress 15:54 (25 min ago, a commit); waiting on Monitor "…" since 15:55". */
export function progressNote(task: TaskRecord, now: number): string {
  const mark = task.progress;
  if (!mark) return 'last real progress unknown (no events from its agent)';
  const waiting = mark.waitingOn
    ? `; waiting on ${mark.waitingOn.what} since ${clockOf(Date.parse(mark.waitingOn.since))}`
    : '';
  return `last real progress ${progressLine(mark, now)}${waiting}`;
}

function promptEventText(taskId: string, prompt: TaskPrompt): string {
  const ref = taskId.slice(0, 8);
  const options = prompt.options.map((option, index) => `${index + 1}. ${option}`).join(' / ');
  const mayApprove = prompt.deletes
    ? 'it deletes: you may deny it or say what to do instead, only the user approves it'
    : 'approve it only if it deletes nothing and you know what it runs';
  // On a command Untether rewrote: whole, and said so; the user's phone was told already.
  const asked = prompt.wrapped ? promptWhole(prompt) : promptSummary(prompt);
  const told = prompt.wrapped
    ? `${wrappedNote(prompt.wrapped)}; the user's phone was told at once`
    : `Unanswered for ${Math.round(PROMPT_ESCALATE_MS / 60_000)} min, the user hears on the phone`;
  return `its agent asks: ${asked || 'a prompt Untether could not read'}${options ? ` [${options}]` : ''}. \`ut task status ${ref}\` shows it whole; \`ut task answer ${ref} approve | deny | <number> | --text "what to do instead"\` answers it (${mayApprove}). ${told}`;
}

function taskDetail(task: TaskRecord, kind: OrchestratorEventKind): string {
  if (task.blocker && ['ready', 'needs_you', 'failed'].includes(kind)) {
    return [
      task.blocker.message,
      ...(task.blocker.kind === 'no-changes' && task.summary
        ? [`its report: ${task.summary}`]
        : []),
      ...(task.blocker.detail ?? []),
      // Stopped on a prompt of its agent's own: what it asks and the way out (2026-11-10).
      ...(task.blocker.prompt && kind === 'needs_you'
        ? [promptEventText(task.id, task.blocker.prompt)]
        : []),
      ...(task.reviewRetryAt && task.blocker.kind === 'review-unavailable'
        ? [`next try at ${task.reviewRetryAt}`]
        : []),
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (kind === 'ready' || kind === 'merged' || kind === 'done') return task.summary ?? '';
  if (kind === 'failed') return task.error ?? '';
  return '';
}

/**
 * Types the scheduler works with: its dependencies, new tasks, runners, worktrees and action
 * results.
 */

import * as fs from 'fs';
import type { ScreenChoices } from '../../shared/claude-screen.js';
import type { AutoMergePauseCode, ProjectSettings } from '../../shared/projects.js';
import type { SavingAutoOff } from '../../shared/saving-features.js';
import type { TaskSecurity } from '../../shared/security.js';
import type { TaskBudgetSpec } from '../../shared/task-budget.js';
import type { AgentUsage } from '../../shared/task-metrics.js';
import type {
  TaskAgent,
  TaskGuardBlock,
  TaskHalt,
  TaskIsolation,
  TaskMergePolicy,
  TaskModelTier,
  TaskOrigin,
  TaskProgressMark,
  TaskRecord,
  TaskRiskReview,
  TaskStall,
  TaskStats,
  TaskVerify,
} from '../../shared/tasks.js';
import { run as runCommand } from '../utils/exec-file.js';
import type { AgentSnapshot, SignalLedger } from './agent-events.js';
import type { EventInput } from './event-log.js';
import type { MergeQueue } from './merge-queue.js';
import type { NotificationPayload } from './push-notification-service.js';
import type { AdmissionVerdict } from './resource-monitor.js';
import { gitProgress, type TaskProgress } from './task-handoff.js';
import type { PipelineOptions, PipelineResult, PipelineTask } from './task-merge.js';
import type { TaskMetricsLedger } from './task-metrics-ledger.js';
import type { TaskReviewer } from './task-review.js';
import type { TierOpinion } from './task-router-llm.js';
import {
  type BaseSyncResult,
  branchChanges,
  commitLeftovers,
  commitsAhead,
  createTaskWorktree,
  type DirtyFile,
  hasUncommittedChanges,
  NEVER_COMMITTED,
  type RemoveTaskWorktreeResult,
  type RevertResult,
  refCommit,
  removeTaskWorktree,
  type TaskWorktree,
} from './task-worktree.js';

/** A push written to tasks.json, to be sent (TaskScheduler.post). */
export interface OutboxEntry {
  id: string;
  at: string;
  payload: NotificationPayload;
  /** Sends that threw so far. */
  tries?: number;
}

export type TaskLogKind = 'setup' | 'verify' | 'merge';

/** A runner's limit while it lasts (TaskScheduler.agentLimit). */
export interface AgentLimit {
  until: number;
  task: TaskRecord;
  kind: TaskHalt['kind'];
  message: string;
}

/** A worktree task's progress, read with git. */
export function defaultProgress(task: TaskRecord): Promise<TaskProgress | undefined> {
  if (!task.worktreePath) return Promise.resolve(undefined);
  return gitProgress(task.worktreePath, task.baseSha);
}

export interface NewTask {
  name: string;
  prompt: string;
  workingDir: string;
  command: string[];
  agent: TaskAgent;
  shielded: boolean;
  notify: boolean;
  /** When to run; missing or not in the future = now. */
  runAt?: Date;
  /** Default 'none': the agent runs in `workingDir` itself. */
  isolation?: TaskIsolation;
  /** The repository a worktree task branches from (default: the one `workingDir` is in). */
  repoPath?: string;
  baseBranch?: string;
  origin?: TaskOrigin;
  /** The orchestrator session that made it (`ut task new` from it). */
  orchestratorSessionId?: string;
  /** The session that ran `ut task new`. */
  createdBySessionId?: string;
  mergePolicy?: TaskMergePolicy;
  /** A revert task ("Deshacer"): the merged task it undoes and its commit range. */
  revertOf?: TaskRecord['revertOf'];
  /** A task of the security sweep (security-sweep.ts). */
  security?: TaskRecord['security'];
  /**
   * `--model`: a level (the installation's model for it) or a model of the agent's own; set,
   * the task's prompt is not classified.
   */
  model?: string;
  modelTier?: TaskModelTier;
  /**
   * `--model <id>:<model>`: an external provider (UntetherConfig.modelProviders) and its model;
   * the task runs its Claude Code against the provider, never the user's own Anthropic login.
   */
  modelProvider?: string;
  /** Its own budget over the project's (`ut task new --budget`, shared/task-budget.ts). */
  budget?: TaskBudgetSpec;
  /** `--after`: ids of the tasks it starts after (shared/task-serial.ts). */
  after?: string[];
  /** `--zone`: its zones, on top of the ones its project's rules give it. */
  zones?: string[];
}

/**
 * Who may run a task (config taskFallbacks, else each agent with the user's quick start): a
 * task whose agent hit its usage limit goes on with the first one that is not at a limit.
 */
export interface TaskRunner {
  /** Unique; a plain agent's is the agent ('claude', 'codex'). */
  name: string;
  agent: TaskAgent;
  command: string[];
  /** Its model; unset = the installation's model for the task's level, else the default. */
  model?: string;
}

/** How the project wants its worktrees made (projects.json). */
export interface TaskWorktreeSetup {
  logPath?: string;
  worktreeRoot?: string;
  cloneDirs?: string[];
  setupCommand?: string;
  /** The folder and branch chosen, before they are made (recorded: the worktree step). */
  onPlanned?: (plan: { repoPath: string; branch: string; worktreePath: string }) => void;
}

/** The git side of worktree tasks; tests swap it for a fake. */
export interface TaskWorktrees {
  create(task: TaskRecord, setup: TaskWorktreeSetup): Promise<TaskWorktree>;
  remove(task: TaskRecord, options: { deleteUnmerged: boolean }): Promise<RemoveTaskWorktreeResult>;
  /**
   * Commit what the agent left uncommitted, `exclude` (glob pathspecs, default
   * NEVER_COMMITTED) aside; true when a commit was made. Throws on failure.
   */
  commitLeftovers(task: TaskRecord, exclude?: string[]): Promise<boolean>;
  changes(task: TaskRecord): Promise<{
    files: string[];
    stats: TaskStats;
    /** Renamed files with their old path, so a result naming the old one still agrees. */
    renamed?: { from: string; to: string }[];
  }>;
  /** Commits or uncommitted changes that exist nowhere else. */
  hasUnmergedWork(task: TaskRecord): Promise<boolean>;
}

/** Worktrees made by git on this Mac. */
export const gitTaskWorktrees: TaskWorktrees = {
  create: (task, setup) =>
    createTaskWorktree({
      dir: task.repoPath ?? task.workingDir,
      name: task.name,
      suffix: task.groupIndex !== undefined ? String.fromCharCode(97 + task.groupIndex) : undefined,
      baseBranch: task.baseBranch,
      ...setup,
    }),
  remove: (task, { deleteUnmerged }) =>
    removeTaskWorktree({
      repoPath: task.repoPath ?? task.workingDir,
      worktreePath: task.worktreePath,
      branch: task.branch,
      deleteUnmerged,
    }),
  commitLeftovers: (task, exclude = NEVER_COMMITTED) =>
    task.worktreePath
      ? commitLeftovers(
          task.worktreePath,
          `${task.name}\n\n(uncommitted work, committed by Untether)`,
          exclude
        )
      : Promise.resolve(false),
  // Against the base branch as it is now, not the commit the task started from: once the base
  // was merged into the branch, `baseSha...HEAD` held everything that came with it (2026-11-02:
  // 7e71645c's result "did not name" 27 files of other tasks). The start commit if the branch
  // can't be read.
  changes: async (task) => {
    if (!task.worktreePath || !task.baseSha) {
      return { files: [], stats: { commits: 0, files: 0, insertions: 0, deletions: 0 } };
    }
    const tip = task.baseBranch
      ? await refCommit(task.worktreePath, `refs/heads/${task.baseBranch}`)
      : null;
    return branchChanges(task.worktreePath, tip ?? task.baseSha);
  },
  hasUnmergedWork: async (task) => {
    if (!task.worktreePath || !fs.existsSync(task.worktreePath)) return false;
    if (await hasUncommittedChanges(task.worktreePath)) return true;
    return task.baseSha ? (await commitsAhead(task.worktreePath, task.baseSha)) > 0 : false;
  },
};

/** A session a task's agent was started in, with whether its first message was typed. */
export interface LaunchedSession {
  sessionId: string;
  /** Resolves to whether the first message (the prompt, the resume text) went in. */
  typed?: Promise<boolean>;
  text?: string;
  /** `text` is the task itself (its first session, or one started again with it). */
  brief?: boolean;
}

/** `ut task status`'s live line (TaskScheduler.liveState). */
export interface TaskLiveState {
  status?: string;
  progress?: TaskProgressMark;
  stall?: TaskStall;
}

export interface TaskSchedulerDeps {
  /** JSON file the tasks live in. */
  storePath: string;
  /**
   * Start the task's session with the id `sessionId` (chosen and recorded first, the task
   * journal: a restart finds out whether it was made); the server types `prompt` into it once
   * the agent is ready.
   */
  launch: (task: TaskRecord, prompt: string, sessionId: string) => Promise<LaunchedSession>;
  notify: (payload: NotificationPayload) => void;
  /** Drops pushes still held for being seen that `matches` picks (the service's withdrawHeld). */
  withdrawPush?: (matches: (payload: NotificationPayload) => boolean) => void;
  /**
   * The public event log (event-log.ts, 2026-11-08): each change of a task's state or of
   * what holds it, for `ut events` and scripts. None: not recorded (tests).
   */
  recordEvent?: (event: EventInput) => void;
  /** The session's status, or undefined once it is gone. */
  sessionStatus: (sessionId: string) => string | undefined;
  /**
   * Types a follow-up into a task's session once its agent can take it; resolves to whether it
   * was typed (2026-10-20: it answered yes at once, so a fix typed into a busy agent was lost).
   * A working Claude takes it into its current turn; a menu of its own, or Codex at work, waits.
   */
  deliver?: (
    sessionId: string,
    text: string,
    agent: TaskAgent,
    /**
     * The task's own worktree: its agent's trust dialog is answered (2026-10-23: a Codex brief
     * retried in a loop never got past it, the launch alone answered it).
     */
    options?: { trustFolder?: boolean }
  ) => Promise<boolean> | boolean;
  /** Ends a discarded task's session. */
  stopSession?: (sessionId: string) => Promise<void>;
  /**
   * Reopen a worktree task's Claude conversation in a new session (task-launcher
   * createTaskResumer), for a task whose session died with the server.
   */
  resume?: (
    task: TaskRecord,
    conversationId: string,
    sessionId: string,
    followUp?: string
  ) => Promise<LaunchedSession>;
  /** The Claude conversation last seen in a session (Session.claudeSessionId). */
  claudeConversation?: (sessionId: string) => string | undefined;
  /** The whole last reply of the agent in a session (its report, when it changed nothing). */
  finalReply?: (sessionId: string) => Promise<string | undefined>;
  /**
   * The last rows of the session's screen as text (TerminalManager.getRecentText): a turn that
   * ended on the agent's usage limit, an API error or a lost login pauses the task.
   */
  screenText?: (sessionId: string) => Promise<string | undefined>;
  /**
   * The user's command line for an agent (its quick start), when it can run here: a task held
   * for its agent's usage limit is offered the other one.
   */
  agentCommand?: (agent: TaskAgent) => string[] | undefined;
  /**
   * Model by difficulty (ProjectSettings.modelRouting): the cheap classification of a prompt
   * (task-router-llm.ts createTierClassifier); null = no opinion (capable).
   */
  classifyTier?: (prompt: string) => Promise<TierOpinion | null>;
  /** The installation's model for an agent's level (config taskModels); unset = its default. */
  modelFor?: (agent: TaskAgent, tier: TaskModelTier) => string | undefined;
  /**
   * Who a task may go on with when its agent hits its usage limit, in order of preference
   * (ProjectSettings.agentFallback): only those that can run here.
   */
  runners?: () => Promise<TaskRunner[]> | TaskRunner[];
  /** What a task's worktree holds now (task-handoff.ts gitProgress); tests fake it. */
  progressOf?: (task: TaskRecord) => Promise<TaskProgress | undefined>;
  /**
   * Stops what the agent is doing in a session (Escape), its session and conversation kept:
   * a task that reached its budget (2026-11-01).
   */
  interrupt?: (sessionId: string) => void;
  /**
   * What a task's agent processed per conversation file (agent-usage.ts: tokens by kind,
   * calls, largest context, compactions), given the files already known for it; undefined
   * when there is nothing to read. Its budget counts the tokens, its metrics all of it.
   */
  agentUsage?: (
    task: TaskRecord,
    known: readonly string[]
  ) => Promise<Record<string, AgentUsage> | undefined>;
  /**
   * The task's cost in USD from its tokens so far (model-providers.ts), for a priced provider
   * task's `usd` budget; undefined when the provider is unpriced or not a provider task.
   */
  taskUsd?: (task: TaskRecord) => Promise<number | undefined>;
  /**
   * Finished tasks' metrics per project (task-metrics-ledger.ts): the saving features'
   * comparison and guard read them. None: an in-memory one (tests).
   */
  metricsLedger?: TaskMetricsLedger;
  /** Picks the holdout tasks (savingHoldoutPct); Math.random unset. */
  random?: () => number;
  /** A task is gone for good: its usage reader's state goes too. */
  forgetAgentUsage?: (taskId: string) => void;
  /** How often a working task's tokens are read (BUDGET_TOKENS_EVERY_MS; tests: 0). */
  budgetTokensEveryMs?: number;
  /**
   * When the session last printed something: the fallback for what the agent's events tell
   * (a Codex without a rollout finishes after a quiet spell). A phone redrawing the screen
   * prints too, so it is never the first answer.
   */
  lastOutputAt?: (sessionId: string) => number | undefined;
  /**
   * The agent's state from its own structured events (agent-events.ts: Claude's hooks, Codex's
   * rollout); undefined when there are none for the session. Asked before the screen.
   */
  agentState?: (sessionId: string) => AgentSnapshot | undefined;
  /**
   * When the work in a folder last moved: its newest commit or changed file (task-worktree.ts
   * worktreeActivity, the default); a task's progress besides its agent's events.
   */
  worktreeActivity?: (dir: string) => Promise<{ at: number; by: 'files' | 'commit' } | undefined>;
  /**
   * The API error the last turn of the session's Claude ended on, from its transcript: null
   * when none, undefined when it can't be read (no Claude, no transcript).
   */
  claudeTurnError?: (
    sessionId: string
  ) => Promise<{ error: string; text: string; at?: number } | null | undefined>;
  /** Counts where each decision came from (the screen's share); one of its own by default. */
  signals?: SignalLedger;
  worktrees?: TaskWorktrees;
  /** The project's settings (projects.json); defaults when missing. */
  settings?: {
    get(repoPath: string): ProjectSettings;
    /** Every project with settings of its own: is any limiting its tasks (maxActiveTasks)? */
    list?(): Array<{ repoPath: string; settings: ProjectSettings }>;
    /** The circuit breaker pauses (and clears) a project's auto-merge. */
    update?(
      repoPath: string,
      patch: {
        autoMergePausedUntil?: string | null;
        autoMergePausedReason?: string | null;
        autoMergePausedCode?: AutoMergePauseCode | null;
        autoMergePausedCount?: number | null;
        savingAutoOff?: SavingAutoOff[] | null;
      }
    ): unknown;
  };
  /** The merge pipeline (task-merge.ts); tests swap it for a fake. */
  pipeline?: (task: PipelineTask, options: PipelineOptions) => Promise<PipelineResult>;
  /** The merge queues (merge-queue.ts); default: the server's one. */
  mergeQueue?: MergeQueue;
  /** Finishing a merge already in the base (task-merge-base.ts finishMergedTask); tests fake it. */
  finishMerge?: (task: PipelineTask, options: PipelineOptions) => Promise<PipelineResult | null>;
  /** The AI reviewer the pipeline uses (default: Claude Sonnet via claude -p). */
  reviewer?: TaskReviewer;
  /**
   * The security sweep's adversarial reviewer on a confirmed fix's diff (it closes the hole
   * without opening another) or a bump's (the upgrade is safe): security-sweep.ts reviewFix.
   * None: neither merges on its own.
   */
  securityFixReview?: (task: TaskRecord) => Promise<NonNullable<TaskSecurity['fixReview']>>;
  /**
   * The same reviewer's second, risk-focused look at a risky task (security-sweep.ts
   * reviewRisk, 2026-10-24): the flagged files' diff weakens nothing. None: a risky task
   * waits for the user.
   */
  riskReview?: (task: TaskRecord) => Promise<TaskRiskReview>;
  /** The user's autoApprove setting, read when it matters; none = off. */
  autoApprove?: () => boolean;
  /** STALE_REMIND_MS from config.json (0 = no reminders), read when it matters. */
  staleRemindMs?: () => number;
  /**
   * A note for the project's running orchestrator, about a task that does not report to it
   * (one Untether started, a security sweep's fix): false when the project has none.
   */
  projectNotice?: (repoPath: string, text: string) => boolean;
  /** Folder for per-task logs (`<dir>/<task id>/setup.log`, verify.log, merge.log). */
  logDir?: string;
  /** A task worktree was just made: its folder is marked out of Time Machine (2026-11-02). */
  worktreeMade?: (worktreePath: string) => void;
  /** Undoes a merged task's commits in a revert task's worktree (default: git revert). */
  revertCommits?: (
    worktreePath: string,
    range: { from: string; to: string },
    message: string
  ) => Promise<RevertResult>;
  /**
   * The base branch's checkout has uncommitted work in files the merge of `branch` touches
   * (default: git, baseCheckoutDirty). A task stopped by it (dirty-base) merges once this says no.
   */
  baseDirty?: (repoPath: string, base: string, branch: string) => Promise<boolean>;
  /** The files with uncommitted changes in a checkout, null outside git (default: git). */
  dirtyFiles?: (dir: string) => Promise<DirtyFile[] | null>;
  /**
   * The files a working task's folder touches against its base (default: git,
   * task-worktree.ts worktreeTouched); null when it cannot be read.
   */
  touchedFiles?: (worktreePath: string, baseRef: string) => Promise<string[] | null>;
  /** Brings a working task's branch up to date with its base (default: git, syncWithBase). */
  syncBase?: (
    worktreePath: string,
    baseBranch: string,
    options: { stillFree?: () => boolean; hold?: () => (() => void) | null }
  ) => Promise<BaseSyncResult>;
  /**
   * Holds a task's agent's tool calls back for a moment and returns what lifts the hold
   * (task-guard-setup.ts holdTools); null when they cannot be held. None: no working task's
   * base is merged by Untether (a conflict is still told).
   */
  toolHold?: (taskId: string) => (() => void) | null;
  /** Delays (tests make them short). */
  reviewRetryDelaysMs?: number[];
  /** INTERNAL_RETRY_DELAYS_MS, shorter in tests. */
  internalRetryDelaysMs?: number[];
  /** BASE_WAIT_POLL_MS, shorter in tests. */
  baseWaitPollMs?: number;
  /** The home folder memoryDir 'auto' looks in (task-memory-note.ts); os.homedir() unset. */
  memoryHome?: string;
  inputRetryMs?: number;
  /**
   * How long send/fix wait for the first try at typing before they answer (3 s: typing into
   * a ready agent takes about one, so the answer says whether it went in).
   */
  inputWaitMs?: number;
  /** A message between agents (agent-messages.ts) was typed into its task's agent. */
  messageTyped?: (messageId: string) => void;
  /** One that never will be (its task closed, or its session is gone for good). */
  messageDropped?: (messageId: string, why: string) => void;
  /** One that cannot be typed yet, and why (shown by `ut project messages`, told to its sender). */
  messageWaiting?: (messageId: string, why: string) => void;
  /**
   * The menu on a session's screen (a permission, a question of the agent's own), null when
   * there is none: what a task stopped on a prompt asks (shared/agent-prompt.ts).
   */
  readPrompt?: (sessionId: string) => Promise<ScreenChoices | null>;
  /**
   * Picks `option` (1-based) of that menu, only while it is still the one on screen; resolves
   * once it left the screen ('ok'), or says why it did not.
   */
  answerPrompt?: (
    sessionId: string,
    menu: ScreenChoices,
    option: number
  ) => Promise<'ok' | 'changed' | 'not-delivered' | 'unavailable'>;
  /** PROMPT_ESCALATE_MS, shorter in tests. */
  promptEscalateMs?: number;
  setupRetryMs?: number;
  /** FINISHED_SESSION_GRACE_MS, shorter in tests. */
  finishedSessionGraceMs?: number;
  /** An orchestrator's session: never stopped as a finished task's. */
  isOrchestratorSession?: (sessionId: string) => boolean;
  /** The main checkout of the repository `dir` is in, null outside one (default: git). */
  mainRepo?: (dir: string) => Promise<string | null>;
  /**
   * The Mac's room for one more task, across every project (2026-11-01, resource-monitor.ts):
   * a task due when it says no waits in its project's line (state queued) until it says yes.
   * `started` is told of each task it let in. None: only the projects' maxActiveTasks.
   * `waitedMs`: how long the task waiting longest for that room has waited (2026-11-11).
   */
  admission?: { check(waitedMs?: number): AdmissionVerdict; started(): void };
  /**
   * Whether the task's agent waits for a check slot now (its heavy check, held by
   * check-slots.ts until its turn) and when its last such wait ended (ms): that time counts
   * neither against its budget nor as a stall.
   */
  checkSlotWait?: (taskId: string) => { waiting: boolean; endedAt?: number };
  /** `git worktree repair` after a project folder moved (tests swap it). */
  repairWorktree?: (repoPath: string, worktreePath: string) => Promise<void>;
  /**
   * The command guard's record of what it blocked per task (task-guard-setup.ts): read into
   * TaskRecord.guardBlocks while its agent works and before its review.
   */
  guardLog?: {
    /** Changes whenever the task's log does (null: none). */
    stamp(taskId: string): string | null;
    read(taskId: string): TaskGuardBlock[];
  };
  now?: () => number;
  onError?: (message: string, error?: unknown) => void;
  /**
   * A check failed with the Mac under load and passed on its rerun (verify.flakyUnderLoad,
   * 2026-11-02): the server keeps the tests in the project's list `ut doctor` shows.
   */
  onFlakyUnderLoad?: (task: TaskRecord, verify: TaskVerify) => void;
}

export interface MergeOptions {
  acceptRisk?: boolean;
  /** An orchestrator asked, not the user: no human decided this merge (circuit breaker). */
  byAgent?: boolean;
  /**
   * "Quedarme con este": the other open tasks of its parallel group are discarded once this
   * one is merged (2026-10-20: they went at once, before it had even been checked).
   */
  keep?: boolean;
  /** Merge past the AI review's concerns (the user only). */
  acceptReview?: boolean;
  /** Review again even when this commit was reviewed before (the user only). */
  freshReview?: boolean;
  /** A check-only run that goes on like 'auto' once checked (`ut task verify`). */
  thenAuto?: boolean;
  /** A risky task's countdown ended: only the findings its second review saw are accepted. */
  riskReviewed?: boolean;
}

export type TaskActionResult =
  | { ok: true; task: TaskRecord }
  | {
      ok: false;
      code:
        | 'not-found'
        | 'not-open'
        | 'session-gone'
        | 'needs-confirmation'
        | 'busy'
        | 'not-fixable'
        /** Its project runs as many tasks as it allows (maxActiveTasks): `--force` goes past. */
        | 'limit'
        /** `ut task answer`: no prompt on its screen, or not that option. */
        | 'no-prompt'
        /** `ut task answer`: an answer only the user gives (it deletes, it could not be read). */
        | 'needs-user'
        /** `ut task budget`: the change is not one (shared/task-budget.ts). */
        | 'bad-budget'
        /** `ut task budget`: raised, still short of what it spent: it stays stopped. */
        | 'over-budget';
      message: string;
      /** needs-confirmation: commits the branch has that exist nowhere else. */
      commits?: number;
    };

/** Re-link a worktree and its repository after the repository's folder moved. */
export async function repairWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const result = await runCommand('git', ['worktree', 'repair', worktreePath], repoPath, 30_000);
  if (result.code !== 0) throw new Error(`${result.stdout}\n${result.stderr}`.trim());
}

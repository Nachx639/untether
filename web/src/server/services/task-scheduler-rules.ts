/** The scheduler's constants and pure helpers (no state). */
import type { TaskBudgetKey } from '../../shared/task-budget.js';
import {
  countReview,
  issueBlocks,
  TASK_FINAL_STATES,
  TASK_STATES,
  type TaskAutoFixReason,
  type TaskBlocker,
  type TaskBlockerKind,
  type TaskMergeOk,
  type TaskRecord,
  type TaskReview,
  type TaskRunnerRef,
  type TaskState,
} from '../../shared/tasks.js';
import type { MergePriority } from './merge-queue.js';
import type { NotificationPayload } from './push-notification-service.js';
import type { MergeOptions } from './task-scheduler-types.js';

/** Longest delay setTimeout accepts; farther tasks re-arm when it fires. */
export const MAX_TIMER_MS = 2_147_483_647;
/** Settled tasks (merged, discarded, missed; plain ones done) kept for the list. */
export const HISTORY_LIMIT = 100;
export const STORE_VERSION = 2;
/**
 * What an outbox entry is sent as: its id goes along (data.pushId) and is its notification tag,
 * so a resend after a kill (at least once, see TaskScheduler.post) replaces the first on the
 * phone and is ignored by the orchestrator.
 */
export function outboxPayload(entry: {
  id: string;
  payload: NotificationPayload;
}): NotificationPayload {
  return {
    ...entry.payload,
    tag: `untether-push-${entry.id}`,
    data: { ...entry.payload.data, pushId: entry.id },
  };
}

/** Times a push whose sending throws is tried (one per save) before it is given up. */
export const PUSH_SEND_TRIES = 3;
/** Claude idle this long after working is done (a quick follow-up turn keeps it working). */
export const IDLE_HOLD_MS = 15_000;
/** A Codex task with no output for this long is taken as done (Codex reports no status). */
export const CODEX_IDLE_MS = 90_000;
/**
 * A Codex turn starts a moment after its text is typed; its rollout's clock and ours may be
 * this far apart: a turn starting so long before the last typing is an older one.
 */
export const CODEX_TYPED_SKEW_MS = 5_000;
/**
 * Claude's events say it is still at work although its status file says idle: believed only
 * this long after its last event (a lost Stop must not hold a task forever).
 */
export const EVENTS_BUSY_TRUST_MS = 60_000;
/** A task idle on the first look after a restart is only finished once it ran this long. */
export const RESTART_IDLE_AFTER_MS = 120_000;

/**
 * States a task's session still drives (its agent's status moves the task). A failed check or
 * merge leaves the session open: the agent may fix it and finish again.
 */
export const SESSION_STATES: readonly TaskState[] = [
  'working',
  'needs_you',
  'paused',
  'ready',
  'failed',
];

/** A paused task is sent on this long after the time its agent gave (clocks, rounding). */
export const HALT_RESUME_MARGIN_MS = 2 * 60_000;
/** A paused task that can go on but has no slot of its project looks again this often. */
export const HALT_SLOT_RETRY_MS = 15_000;
/** A paused task whose agent gave no time is sent on after these, one per try. */
export const HALT_RETRY_DELAYS_MS = [5, 15, 30, 60, 120].map((minutes) => minutes * 60_000);
/** Tries in a row before a paused task waits for the user (a limit that keeps coming back). */
export const HALT_MAX_TRIES = 6;
/**
 * A halt this soon after the task was sent on is the same one coming back (review of
 * 2026-11-01: tries added up over a long task cut by several daily limits, and a cut hours
 * later was never told).
 */
export const HALT_STREAK_MS = 30 * 60_000;

/**
 * A working task with no event of its agent and nothing typed into it for this long is looked
 * at for a halt nobody told (TaskScheduler.watchHalts), every HALT_LOOK_EVERY_MS while it
 * stays quiet.
 */
export const HALT_LOOK_QUIET_MS = 2 * 60_000;
export const HALT_LOOK_EVERY_MS = 60_000;

/** Files with uncommitted changes recorded when a task without a worktree starts (startDirty). */
export const START_DIRTY_MAX = 5000;

/** A task without a worktree left ready this long, its session gone, closes at startup. */
export const PLAIN_READY_SWEEP_MS = 24 * 60 * 60 * 1000;

/** Typed into a failed task's reopened conversation by "Reintentar". */
export const TASK_RETRY_TEXT =
  '[untether] The user asked you to try this task again: it had failed. Look at what is already there, finish the task, then report with `ut task done`.';

/**
 * A task whose session is gone this soon after the server started died with the old server
 * (a restart): its conversation is resumed instead of the task finishing half done.
 */
export const RESTART_WINDOW_MS = 60_000;
/**
 * At most this many resumes after restarts per task, so a session that keeps dying ends the
 * task. Reopens the user asked for (send, fix, retry) are counted apart (TaskRecord.reopens).
 */
export const MAX_TASK_RESUMES = 2;
/** Blockers the agent can do something about ("Que lo arregle"). */
export const FIXABLE: readonly TaskBlockerKind[] = [
  'conflict',
  'verify',
  'risk',
  'merge-error',
  'review',
];

/**
 * An unavailable AI review is tried again after these delays, then every hour (2026-10-20:
 * an unavailable review merged the task as if there were no reviewer).
 */
export const REVIEW_RETRY_DELAYS_MS = [5, 15, 30, 60].map((minutes) => minutes * 60_000);
/**
 * A pipeline stopped by an error of Untether's own (TaskBlocker.internal) runs again by itself
 * after these delays; the user hears of it only when it still fails after them (2026-10-23: a
 * server reload with a half edited task-verify.ts left a task needs_you "os is not defined").
 */
export const INTERNAL_RETRY_DELAYS_MS = [60_000, 5 * 60_000];
/** A task waiting on a dirty base checkout (TaskRecord.baseWait) looks at it this often. */
export const BASE_WAIT_POLL_MS = 60_000;
/** … and this long after a run on a clean look still stopped on it. */
export const BASE_WAIT_RERUN_MS = 10 * 60_000;
/** Still unavailable this long after the first try: the user is told, once. */
export const REVIEW_UNAVAILABLE_NOTIFY_MS = 3 * 60 * 60_000;
/**
 * A message the agent's session could not take yet is tried again after this long, doubling
 * up to INPUT_RETRY_MAX_MS (2026-10-20: every 15 s forever, with a log line each time).
 */
export const INPUT_RETRY_MS = 15_000;
export const INPUT_RETRY_MAX_MS = 5 * 60_000;
/** A message whose session is gone (and can't be reopened) is given up after this long. */
export const INPUT_GIVE_UP_MS = 60 * 60_000;
/**
 * A message typed this long after it was sent carries its sending time ("(sent at 11:19, 30 min
 * ago)"), so the agent judges whether it still applies. 2026-10-23: a follow-up held 30 min
 * behind a turn reached an agent that had found the fix meanwhile; it read it as new and
 * investigated again.
 */
export const LATE_INPUT_MS = 2 * 60_000;
/** A message its agent never got back to take is told this late (once). */
export const INPUT_BUSY_NOTICE_MS = 15 * 60_000;
/** A failed setup is tried again once by itself, after this long. */
export const SETUP_RETRY_MS = 30_000;
/**
 * A task a restart cut while it was starting (its worktree half made, or its session never
 * made) starts over by itself this many times in a row; one more cut and it fails, told.
 * 2026-11-02: ecc6e416 failed with "The server stopped while the task was starting" on a night
 * of many merges into Untether (tsx watch restarts the server with each one).
 */
export const TASK_START_CUTS_MAX = 3;
/**
 * A finished task's session is stopped this long after (`ut task done` runs in it and gets its
 * answer, the agent ends its turn); while its agent still works, up to FINISHED_SESSION_BUSY_MS.
 */
export const FINISHED_SESSION_GRACE_MS = 30_000;
export const FINISHED_SESSION_BUSY_MS = 10 * 60_000;
/** The doctor stops a finished task's session still running this long after it finished. */
export const FINISHED_SESSION_LINGER_MS = 15 * 60_000;
/**
 * A task ready or waiting for an answer this long with nobody acting reminds whoever it reports
 * to (config.json staleTaskRemindMinutes, 0 = never), then again after twice as long each time,
 * up to STALE_REMIND_MAX_MS apart (2026-10-31: one sat 3 h "ready" with nothing to merge).
 */
export const STALE_REMIND_MS = 30 * 60_000;
/** A working task's agent tokens are read this often (budgets, 2026-11-01). */
export const BUDGET_TOKENS_EVERY_MS = 60_000;
/** The time counted against budgets is saved at least this often (and at each warning or cut). */
export const BUDGET_SAVE_EVERY_MS = 60_000;
/** What its agent is told when a task stopped by its budget gets more. */
export const BUDGET_CONTINUE_TEXT =
  'Untether stopped you because this task reached its budget; it has more now. Go on where you stopped, and keep to what the task asks.';
export const STALE_REMIND_MAX_MS = 24 * 60 * 60_000;
/** The circuit breaker looks back this far, and pauses auto-merge this long. */
export const BREAKER_WINDOW_MS = 24 * 60 * 60_000;
/** Auto-merged tasks undone within the window that pause the project's auto-merge. */
export const BREAKER_REVERTS = 2;
/** Tasks whose automatic fixes ran out within the window that pause it. */
export const BREAKER_GAVE_UP = 3;

/** The blocker Untether hands back to the agent by itself, if this one is. */
export function autoFixReasonOf(blocker: TaskBlocker | undefined): TaskAutoFixReason | undefined {
  switch (blocker?.kind) {
    case 'review':
    case 'verify':
    case 'conflict':
      return blocker.kind;
    case 'merge-error':
      return blocker.agentFixable ? 'merge-error' : undefined;
    default:
      return undefined;
  }
}

/**
 * How long a runner that hit its usage limit without saying until when is left alone before
 * a task goes back to it (2026-11-01: Claude's and Codex's limits reset within 5 hours).
 */
export const HALT_LIMIT_GUESS_MS = 60 * 60_000;

/** The runner a task runs on: its configured one, else its agent. */
export function runnerOf(task: Pick<TaskRecord, 'agent' | 'runner'>): string {
  return task.runner ?? task.agent;
}

/**
 * Whose usage limit (or login) a task's halt is, and so which tasks it holds back: its runner,
 * or for a task against an external model provider that provider (`provider:<id>`).
 * 2026-11-08 (second review): a provider task out of balance (402) or with a bad key paused as
 * the `claude` runner's limit, so every one of the user's own Claude tasks queued behind a
 * provider's balance, and a provider task waited out Anthropic's limit it never uses.
 */
export function limitKeyOf(task: Pick<TaskRecord, 'agent' | 'runner' | 'modelProvider'>): string {
  return task.modelProvider ? `provider:${task.modelProvider}` : runnerOf(task);
}

/** "Codex (gpt-5)", "claude-work (sonnet)". */
export function runnerLabel(ref: TaskRunnerRef): string {
  const name = ref.runner === ref.agent ? (ref.agent === 'codex' ? 'Codex' : 'Claude') : ref.runner;
  return ref.model ? `${name} (${ref.model})` : name;
}

export const isFinal = (task: TaskRecord) => TASK_FINAL_STATES.includes(task.state);
/**
 * Tasks with a budget: worktree tasks. One without a worktree is a session in the user's own
 * folder (a handoff, a plain session): stopping its agent mid-way would cut the user's work.
 */
export const budgeted = (task: TaskRecord) => task.isolation === 'worktree';
/** A merged or discarded task keeps the sessions that ran it when one is reopened as another. */
export const followsReopenedSessions = (task: TaskRecord) =>
  task.state !== 'merged' && task.state !== 'discarded';

/** Nothing left to clean up or decide: may drop out of the history. */
export function isSettled(task: TaskRecord): boolean {
  if (isFinal(task)) return true;
  return task.isolation === 'none' && (task.state === 'ready' || task.state === 'failed');
}

export function validRecord(task: TaskRecord): boolean {
  return (
    !!task &&
    typeof task.id === 'string' &&
    typeof task.name === 'string' &&
    typeof task.prompt === 'string' &&
    typeof task.workingDir === 'string' &&
    Array.isArray(task.command) &&
    TASK_STATES.includes(task.state) &&
    (task.isolation === 'worktree' || task.isolation === 'none') &&
    Array.isArray(task.followUps) &&
    Array.isArray(task.files) &&
    !Number.isNaN(Date.parse(task.runAt))
  );
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * What the user's "merge it" covers: the risk findings and the AI review as the user saw them
 * when they asked (TaskMergeOk).
 */
/** A risky task's flagged files, short: «web/src/server/routes/sessions.ts, …». */
/**
 * A task stopped only for the user's merge OK, nothing to fix (autoApprove gives it): risky
 * changes, a held security fix, no check, or a review that could not run for hours (its
 * retries go on; `notified`: the user would be told now).
 */
/** Its place among the waiting merges: urgent, the user's own «Fusionar», or unattended. */
export function mergePriorityOf(task: TaskRecord): MergePriority | undefined {
  if (task.urgent) return 'urgent';
  return task.mergeOk && !task.autoApprovedMerge ? 'user' : undefined;
}

export function heldOnlyForMergeOk(task: TaskRecord): boolean {
  switch (task.blocker?.kind) {
    case 'risk':
    case 'security':
    case 'no-check':
      return true;
    case 'review-unavailable':
      return !!task.reviewRetry?.notified;
    default:
      return false;
  }
}

export function riskFilesOf(task: Pick<TaskRecord, 'risk'>): string {
  const files = [...new Set((task.risk ?? []).map((finding) => finding.file).filter(Boolean))];
  return files.slice(0, 3).join(', ') + (files.length > 3 ? ', …' : '');
}

/**
 * What the second review said of this commit when it did not confirm it: its reason, or that
 * it could not run. Undefined when it confirmed, never ran, or read another commit.
 */
export function riskReviewSaid(
  task: Pick<TaskRecord, 'riskReview' | 'headSha'>
): string | undefined {
  const look = task.riskReview;
  if (!look || look.verdict === 'confirmed' || look.headSha !== task.headSha) return undefined;
  return look.verdict === 'dismissed'
    ? `Second review: ${look.reason || 'it does not confirm the change is safe'}`
    : `The second review could not run (${look.reason})`;
}

export function mergeOkOf(task: TaskRecord, merge: MergeOptions, now: number): TaskMergeOk {
  const review = task.review;
  return {
    at: new Date(now).toISOString(),
    ...(merge.acceptRisk
      ? { risk: (task.risk ?? []).map(({ rule, file }) => ({ rule, file })) }
      : {}),
    ...(merge.acceptReview
      ? {
          review: {
            ...(review?.headSha ? { headSha: review.headSha } : {}),
            ...(review?.verdict === 'unavailable' ? { unavailable: true } : {}),
            issues: (review?.verdict === 'unavailable' ? [] : (review?.issues ?? [])).filter(
              issueBlocks
            ),
          },
        }
      : {}),
    ...(merge.keep ? { keep: true } : {}),
  };
}

/** "04:27", or "Nov 2 04:27" when it is not the day of `now` (the server's clock). */
export function clockText(at: number, now: number): string {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

/** States run() starts a task from (scheduled or queued; failed: a retry). */
export const STARTABLE_STATES: readonly TaskState[] = ['scheduled', 'queued', 'failed'];

/** States in which a task holds its project's slot (needs_you: see holdsSlot). */
export const SLOT_STATES: readonly TaskState[] = [
  'preparing',
  'working',
  'verifying',
  'merging',
  'needs_you',
];

/**
 * `count` tasks may start now with `active` of the project's `max` slots held: there is room
 * for all of them, or they are more than the limit and nothing else runs (a parallel group
 * larger than the limit would otherwise wait for good).
 */
export function fitsSlots(count: number, active: number, max: number): boolean {
  return active + count <= max || (count > max && active === 0);
}

/**
 * A task that has waited this long for the Mac's room gets it before the tasks of projects
 * running fewer (2026-11-11: with one task let in every 15 min, each turn went to a newer task
 * of a project with nothing running and one of a project running 2 waited over 5 h).
 */
export const ROOM_WAIT_FIRST_MS = 30 * 60_000;

/**
 * Which waiting entry gets the Mac's room first (one project's head each time): an urgent one,
 * then one that has waited for that room over ROOM_WAIT_FIRST_MS (the longest first),
 * then the project running the fewest tasks now, then the one waiting longest. So a project
 * with ten tasks in line does not keep another's single task waiting, and a project with
 * tasks running is not passed over for good by newer tasks of idle ones (2026-11-11).
 */
export function fairest(
  candidates: TaskRecord[][],
  running: (repo: string) => number,
  now: number = Date.now()
): TaskRecord[] {
  const heads = new Map<string, TaskRecord[]>();
  for (const entry of candidates) {
    const repo = entry[0].queued?.repoPath ?? '';
    if (!heads.has(repo)) heads.set(repo, entry);
  }
  const since = (entry: TaskRecord[]) => Date.parse(entry[0].queued?.since ?? entry[0].createdAt);
  // Infinity: not waiting for room long enough to go first.
  const overdue = (entry: TaskRecord[]) => {
    const from = Date.parse(entry[0].queued?.resources?.since ?? '');
    return now - from >= ROOM_WAIT_FIRST_MS ? from : Number.POSITIVE_INFINITY;
  };
  const byWait = (a: TaskRecord[], b: TaskRecord[]) => {
    const [waitA, waitB] = [overdue(a), overdue(b)];
    return waitA === waitB ? 0 : waitA < waitB ? -1 : 1;
  };
  return [...heads.entries()]
    .sort(
      ([repoA, a], [repoB, b]) =>
        Number(b.some((task) => task.urgent)) - Number(a.some((task) => task.urgent)) ||
        byWait(a, b) ||
        running(repoA) - running(repoB) ||
        since(a) - since(b)
    )
    .map(([, entry]) => entry)[0];
}

/** "40 s", "12 min", "3 h" */
export function clockSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/**
 * The task's latest AI review, its numbers counted in once (2026-11-01: rounds and, per
 * reviewer family, findings fixed against rejected, to compare the reviewers).
 */
export function noteReview(task: TaskRecord, review: TaskReview): void {
  task.review = review;
  const stats = countReview(task.reviewStats, review);
  if (stats) task.reviewStats = stats;
}

/**
 * What to do about a task near or at its budget, by the limits it reached (2026-11-01): the
 * suggestion that comes with the warning and the cut.
 */
export function budgetAdvice(
  task: Pick<TaskRecord, 'agent'>,
  keys: readonly TaskBudgetKey[]
): string {
  const other = task.agent === 'codex' ? 'claude' : 'codex';
  const advice: string[] = [];
  if (keys.includes('rounds')) {
    advice.push(
      'it keeps going back to its agent: say more precisely what done means, or split the task'
    );
  }
  if (keys.includes('tokens')) {
    advice.push(`its agent reads a lot: narrow the prompt to what matters, or try ${other}`);
  }
  if (keys.includes('wall') || keys.includes('agent')) {
    advice.push(
      `big for one task: split it into smaller ones or clarify the prompt; if its agent is stuck, try ${other}`
    );
  }
  return `Suggestion: ${advice.join('; ')}`;
}

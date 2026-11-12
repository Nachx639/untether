/**
 * How a task reads on the home board (pure): its bucket and colour, the pill's words, why it
 * stopped, and which buttons its row offers. The board shows worktree tasks (their own branch,
 * merged back when done); a plain task is only a session started with a prompt and stays a
 * session row.
 *
 *   trabajando  preparing | working | verifying | merging   (accent, pulsing dot)
 *   te necesita needs_you                                   (orange, with the reason)
 *   en pausa    paused (its agent was cut short: usage limit, API error, login; resumes alone)
 *   lista       ready                                       (green)
 *   fusionada   merged                                      (grey, in "Hechas")
 *   falló       failed                                      (red, with the reason)
 */
import { taskActualModel } from '../../shared/agent-models.js';
import { agentConversationTitle } from '../../shared/session-title.js';
import {
  formatBudgetValue,
  TASK_BUDGET_KEYS,
  type TaskBudgetKey,
} from '../../shared/task-budget.js';
import { formatPhaseDuration, summarizeTimings, timingMs } from '../../shared/task-timings.js';
import {
  TASK_BUSY_STATES,
  TASK_FINAL_STATES,
  type TaskAutoFix,
  type TaskAutoFixReason,
  type TaskBlockerKind,
  type TaskPhase,
  type TaskRecord,
  type TaskResourceShortage,
  type TaskRunnerRef,
  type TaskWaitFor,
} from '../../shared/tasks.js';
import type { Session } from '../../shared/types.js';
import { getLocale, type MessageKey, t } from '../i18n/index.js';
import type { TaskActionResult } from '../services/task-store.js';
import { clipLine, firstLine } from './card-line.js';
import { whenText } from './when-text.js';

// The board's names for the shared contract (shared/tasks.ts). They were copies kept "for a
// server newer than the shared types"; client and server ship together, so there is no such
// server (2026-11-10).
export type BoardBlockerKind = TaskBlockerKind;
export type { TaskAutoFix, TaskAutoFixReason };
export type BoardTask = TaskRecord;

export function blockerKindOf(task: Pick<TaskRecord, 'blocker'>): BoardBlockerKind | undefined {
  return task.blocker?.kind;
}

const AUTO_FIX_REASONS: readonly TaskAutoFixReason[] = [
  'review',
  'verify',
  'conflict',
  'merge-error',
];

/**
 * The automatic fix under way, if any: an `autoFix` on a task its agent (or the check, the
 * review, the merge) is busy with, or one stopped on the very blocker being fixed with
 * attempts left. Stopped on anything else (a permission prompt, a question, its session
 * ended), the `autoFix` is stale and the task is the user's (2026-10-20 verify: a task asking
 * for permission read «arreglándose sola», with no button and out of «Te necesita»).
 */
export function activeAutoFix(
  task: Pick<TaskRecord, 'state'> & Partial<Pick<TaskRecord, 'blocker'>> & { autoFix?: unknown }
): TaskAutoFix | undefined {
  const fix = task.autoFix as Partial<TaskAutoFix> | undefined;
  if (!fix || typeof fix !== 'object') return undefined;
  if (typeof fix.attempts !== 'number' || typeof fix.max !== 'number') return undefined;
  if (!AUTO_FIX_REASONS.includes(fix.reason as TaskAutoFixReason)) return undefined;
  if (TASK_FINAL_STATES.includes(task.state) || task.state === 'scheduled') return undefined;
  if (TASK_BUSY_STATES.includes(task.state)) return fix as TaskAutoFix;
  // Stopped: only between attempts on the blocker it fixes (its kinds are named alike).
  if (blockerKindOf(task) !== fix.reason) return undefined;
  if (fix.attempts >= fix.max) return undefined;
  return fix as TaskAutoFix;
}

/**
 * Waits for its base branch's checkout to be clean (2026-10-24): Untether merges it then by
 * itself; nothing for anyone to do («esperando a main»).
 */
export function waitsForBase(
  task: Pick<TaskRecord, 'state' | 'blocker'> & Partial<Pick<TaskRecord, 'baseWait'>>
): boolean {
  return task.state === 'ready' && blockerKindOf(task) === 'dirty-base' && !!task.baseWait;
}

/** Waits only for Untether (its review is retried, or it fixes itself): nothing to tap. */
export function taskHandlesItself(
  task: Pick<TaskRecord, 'state' | 'blocker'> &
    Partial<Pick<TaskRecord, 'baseWait'>> & { autoFix?: unknown }
): boolean {
  if (activeAutoFix(task)) return true;
  if (waitsForBase(task)) return true;
  return task.state === 'ready' && blockerKindOf(task) === 'review-unavailable';
}

/** A merged task can be undone ("Deshacer") for this long after it merged. */
export const REVERT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where undoing a merged task stands: 'none' (never undone, or its undo task discarded),
 * 'pending' (its undo task is open) or 'done' (the undo merged: «deshecha»). Its undo task is
 * looked up in `tasks` (the store's list); one not listed counts as gone, as the server does.
 */
export type RevertState = 'none' | 'pending' | 'done';

export function revertState(
  task: Pick<TaskRecord, 'revertedBy'>,
  tasks: readonly Pick<TaskRecord, 'id' | 'state'>[] = []
): RevertState {
  if (!task.revertedBy) return 'none';
  const undo = tasks.find((entry) => entry.id === task.revertedBy);
  if (!undo || undo.state === 'discarded' || undo.state === 'missed') return 'none';
  return undo.state === 'merged' ? 'done' : 'pending';
}

/**
 * Offer "Deshacer": merged lately, with the exact commit range on record (mergedOnto..
 * mergedSha; without it the server cannot undo it, 2026-10-20 verify), and not being undone
 * already or undone.
 */
export function canRevertTask(
  task: Pick<
    TaskRecord,
    'state' | 'finishedAt' | 'stateSince' | 'mergedSha' | 'mergedOnto' | 'revertedBy'
  >,
  tasks: readonly Pick<TaskRecord, 'id' | 'state'>[] = [],
  now = Date.now()
): boolean {
  if (task.state !== 'merged' || !task.mergedSha || !task.mergedOnto) return false;
  if (revertState(task, tasks) !== 'none') return false;
  const at = Date.parse(task.finishedAt || task.stateSince || '');
  return Number.isFinite(at) && now - at <= REVERT_WINDOW_MS;
}

export type TaskBucket =
  | 'scheduled'
  | 'working'
  | 'needs'
  | 'ready'
  | 'failed'
  | 'merged'
  | 'discarded';

/** Buttons a task row can show. */
export type TaskAction =
  | 'open'
  | 'fix'
  | 'merge'
  | 'mergeRisk'
  /** Merge past the AI review's concerns («Fusionar igualmente»). */
  | 'mergeReview'
  | 'keep'
  | 'discard'
  | 'changes'
  | 'cancel'
  /** Try a failed task again (its conversation reopened, or a fresh start). */
  | 'retry'
  /** Its setup / check / merge log. */
  | 'log'
  /** A merged task: a new task that reverts it (tests and review before it goes in). */
  | 'revert'
  /** A security fix or a reviewed risky task about to merge on its own: it waits («Parar»). */
  | 'hold'
  /** Fast lane: ahead in the merge queue and for a check slot (same check and review). */
  | 'urgent'
  | 'notUrgent'
  /** A task queued for its project's limit: it starts now, past the limit («Empezar ya»). */
  | 'startNow'
  /** A queued task one place up or down in its project's line. */
  | 'moveUp'
  | 'moveDown'
  /** A paused task goes on with the agent its pause offers, in the same worktree. */
  | 'switchAgent'
  /** A task stopped by its budget: +50% of the limits it reached, and it goes on. */
  | 'moreBudget';

export function taskBucket(
  task: Pick<TaskRecord, 'state'> &
    Partial<Pick<TaskRecord, 'blocker' | 'baseWait'>> & { autoFix?: unknown }
): TaskBucket {
  // Fixing itself, or its review retried by itself: in progress, nothing for the user.
  if (taskHandlesItself({ blocker: undefined, ...task })) return 'working';
  switch (task.state) {
    case 'scheduled':
    case 'queued':
      return 'scheduled';
    case 'needs_you':
      return 'needs';
    case 'ready':
      return 'ready';
    case 'failed':
    case 'missed':
      return 'failed';
    case 'merged':
    case 'done':
      return 'merged';
    case 'discarded':
      return 'discarded';
    default:
      return 'working';
  }
}

/** On the board: worktree tasks, while open or in "Hechas" (merged, discarded). */
export function isBoardTask(task: Pick<TaskRecord, 'isolation' | 'state'>): boolean {
  return task.isolation === 'worktree' && task.state !== 'missed';
}

/** In "Hechas": merged, done (no worktree) or discarded. */
export function isDoneTask(task: Pick<TaskRecord, 'state'>): boolean {
  return task.state === 'merged' || task.state === 'done' || task.state === 'discarded';
}

export function isOpenBoardTask(task: Pick<TaskRecord, 'isolation' | 'state'>): boolean {
  return isBoardTask(task) && !isDoneTask(task);
}

/** Waiting for the user: needs_you, or failed (only the user can unblock it). */
export function taskWantsUser(
  task: Pick<TaskRecord, 'state'> & Partial<Pick<TaskRecord, 'blocker'>> & { autoFix?: unknown }
): boolean {
  if (activeAutoFix(task)) return false;
  return task.state === 'needs_you' || task.state === 'failed';
}

const BUCKET_RANK: Record<TaskBucket, number> = {
  needs: 0,
  failed: 1,
  ready: 2,
  working: 3,
  scheduled: 4,
  merged: 5,
  discarded: 5,
};

/**
 * Open tasks in a project: te necesita > falló > lista > trabajando > programada; within a
 * bucket the oldest first (it has waited longest), so a row doesn't jump on every poll.
 */
export function sortBoardTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  const since = (task: TaskRecord) => Date.parse(task.stateSince || task.createdAt) || 0;
  // Queued ones in the order they start (their line can be reordered).
  const place = (task: TaskRecord) => (task.state === 'queued' ? (task.queued?.position ?? 0) : 0);
  return [...tasks].sort(
    (a, b) =>
      BUCKET_RANK[taskBucket(a)] - BUCKET_RANK[taskBucket(b)] ||
      place(a) - place(b) ||
      since(a) - since(b) ||
      a.id.localeCompare(b.id)
  );
}

/** "Hechas": the newest first. */
export function sortDoneTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  const at = (task: TaskRecord) =>
    Date.parse(task.finishedAt || task.stateSince || task.createdAt) || 0;
  return [...tasks].sort((a, b) => at(b) - at(a));
}

/** The pill: «trabajando», «comprobando (en cola)», «te necesita», «lista» … */
export function taskStatusLabel(
  task: BoardTask,
  options: { tasks?: readonly Pick<TaskRecord, 'id' | 'state'>[]; now?: number } = {}
): string {
  if (activeAutoFix(task)) return t('board.state.autoFixing');
  // Its undo task merged: what it changed is gone again.
  if (task.state === 'merged' && revertState(task, options.tasks) === 'done') {
    return t('board.state.reverted');
  }
  if (task.state === 'ready' && blockerKindOf(task) === 'review-unavailable') {
    return t('board.state.reviewPending');
  }
  if (waitsForBase(task)) return t('board.state.baseWait', { base: task.baseBranch || 'main' });
  switch (task.state) {
    case 'scheduled':
      return t('board.state.scheduled', { time: whenText(task.runAt, options.now)?.when ?? '' });
    case 'queued':
      // Started after other tasks (--after, its zone; 2026-11-11): which ones.
      if (task.queued?.waitsFor?.length) {
        return t('board.state.waitsFor', { ids: waitIds(task.queued.waitsFor) });
      }
      // Waiting for room on the Mac (2026-11-01, taskAdmission): what it waits for first.
      if (task.queued?.resources?.short.length && !task.queued.resources.paced) {
        return t('board.state.queuedRoom', {
          what: roomWords(task.queued.resources.short),
          position: task.queued.position ?? 1,
          of: task.queued.of ?? task.queued.position ?? 1,
        });
      }
      return task.queued?.position
        ? t('board.state.queued', {
            position: task.queued.position,
            of: task.queued.of ?? task.queued.position,
          })
        : t('board.state.queuedPlain');
    case 'preparing':
      return t('board.state.preparing');
    case 'verifying':
      if (task.reviewing) return t('board.state.reviewing');
      // Behind another task in its project's merge queue (2026-11-01): no check until its turn.
      if (task.mergeQueue && task.mergeQueue.position > 1) {
        return t('board.state.mergeQueued', {
          position: String(task.mergeQueue.position),
          project: projectName(task.repoPath),
        });
      }
      // 2026-11-01: a check held for a low disk says so (config checkDisk).
      if (task.verify?.waitingDisk) return t('board.state.verifyWaitingDisk');
      return t(task.verify?.queued ? 'board.state.verifyQueued' : 'board.state.verifying');
    case 'merging':
      return t('board.state.merging');
    case 'needs_you':
      return t('board.state.needsYou');
    case 'paused':
      return t('board.state.paused');
    case 'ready':
      return t('board.state.ready');
    case 'merged':
      return t('board.state.merged');
    case 'done':
      return t('board.state.done');
    case 'failed':
    case 'missed':
      return t('board.state.failed');
    case 'discarded':
      return t('board.state.discarded');
    default:
      return t('board.state.working');
  }
}

/**
 * The sidebar's short state (2026-11-08): the pill's words, without a queued task's place in
 * the line or what it waits for («en cola»); the row's tooltip has the whole label.
 */
export function taskStateWord(
  task: BoardTask,
  options: { tasks?: readonly Pick<TaskRecord, 'id' | 'state'>[]; now?: number } = {}
): string {
  if (task.state === 'queued' && !activeAutoFix(task)) return t('board.state.queuedPlain');
  return taskStatusLabel(task, options);
}

const BLOCKER_KEYS: Record<BoardBlockerKind, MessageKey> = {
  question: 'board.blocker.question',
  permission: 'board.blocker.permission',
  conflict: 'board.blocker.conflict',
  verify: 'board.blocker.verify',
  risk: 'board.blocker.risk',
  'dirty-base': 'board.blocker.dirty-base',
  'no-check': 'board.blocker.no-check',
  'no-changes': 'board.blocker.no-changes',
  setup: 'board.blocker.setup',
  'session-exit': 'board.blocker.session-exit',
  'merge-error': 'board.blocker.merge-error',
  review: 'board.blocker.review',
  'review-unavailable': 'board.blocker.review-unavailable',
  security: 'board.blocker.security',
  halted: 'board.blocker.halted',
  budget: 'board.blocker.budget',
  partial: 'board.blocker.partial',
  'result-mismatch': 'board.blocker.result-mismatch',
};

/**
 * Blockers whose message Untether writes for the orchestrator (English, with `ut` commands):
 * the board says them in the user's words instead. 2026-10-23: a no-check card showed
 * "Not merged on its own … Set the project's check with `ut project set …`" on the phone.
 */
const BLOCKER_DETAIL_KEYS: Partial<Record<BoardBlockerKind, MessageKey>> = {
  conflict: 'board.blockerDetail.conflict',
  'dirty-base': 'board.blockerDetail.dirty-base',
  'no-check': 'board.blockerDetail.no-check',
  'no-changes': 'board.blockerDetail.no-changes',
  setup: 'board.blockerDetail.setup',
  'session-exit': 'board.blockerDetail.session-exit',
  'merge-error': 'board.blockerDetail.merge-error',
  budget: 'board.blockerDetail.budget',
  partial: 'board.blockerDetail.partial',
  'result-mismatch': 'board.blockerDetail.result-mismatch',
};

const AUTO_FIX_KEYS: Record<TaskAutoFixReason, MessageKey> = {
  review: 'board.autoFix.review',
  verify: 'board.autoFix.verify',
  conflict: 'board.autoFix.conflict',
  'merge-error': 'board.autoFix.merge-error',
};

/** The words for a risk rule («posible secreto», «borra tests» …); unknown rules as they come. */
export function riskRuleLabel(rule: string): string {
  const key = `board.risk.${rule}` as MessageKey;
  const text = t(key);
  return text && text !== key ? text : rule;
}

/** «intento 2 de 3 · no pasaba la comprobación» for a task fixing itself. */
export function autoFixLine(task: BoardTask): string {
  const fix = activeAutoFix(task);
  if (!fix) return '';
  return t('board.autoFix.attempt', {
    n: Math.max(1, fix.attempts),
    max: fix.max,
    reason: t(AUTO_FIX_KEYS[fix.reason], { base: task.baseBranch || 'main' }),
  });
}

/**
 * «Se reintenta sola a las 14:05» («… mañana a las 14:05») for a review that could not run;
 * «en breve» when its time is not known or already past.
 */
export function reviewRetryLine(task: BoardTask, now = Date.now()): string {
  if (blockerKindOf(task) !== 'review-unavailable') return '';
  const at = task.reviewRetryAt ? Date.parse(task.reviewRetryAt) : Number.NaN;
  const when = Number.isFinite(at) && at > now ? whenText(at, now) : null;
  if (!when) return t('board.reviewRetrySoon');
  return when.today
    ? t('board.reviewRetryAt', { time: when.time })
    : t('board.reviewRetryLater', { when: when.when });
}

/**
 * «Sigue sola a las 04:27» for a paused task (its agent cut short by its usage limit, an API
 * error or a lost login, 2026-11-01); «en pausa: reanúdala o descártala» once its tries ran out.
 */
export function haltResumeLine(task: BoardTask, now = Date.now()): string {
  if (task.state !== 'paused') return '';
  const next = task.halt?.nextTryAt ? Date.parse(task.halt.nextTryAt) : Number.NaN;
  if (task.halt && !task.halt.nextTryAt) return t('board.haltStopped');
  const when = Number.isFinite(next) && next > now ? whenText(next, now) : null;
  if (!when) return t('board.haltResumeSoon');
  return when.today
    ? t('board.haltResumeAt', { time: when.time })
    : t('board.haltResumeLater', { when: when.when });
}

/** Why it stopped, short and in the user's language («pide permiso», «no pasa la comprobación»). */
/**
 * A security task that passed every gate, or a risky task a second review confirmed
 * (2026-10-24), merges on its own soon: when, in the phone's clock ("14:32"); '' otherwise
 * (2026-10-23).
 */
export function autoMergeTime(task: Pick<TaskRecord, 'state' | 'autoMergeAt'>): string {
  if (task.state !== 'ready' || !task.autoMergeAt) return '';
  const at = new Date(task.autoMergeAt);
  return Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
}

/** «memoria, CPU»: what the Mac is short of, in the user's words. */
export function roomWords(short: readonly TaskResourceShortage[]): string {
  return short.map((what) => t(`board.room.${what}`)).join(', ');
}

/** «1a2b3c4d, 5e6f7a8b»: the tasks a queued one waits for. */
function waitIds(waits: readonly TaskWaitFor[]): string {
  return waits.map((wait) => wait.taskId.slice(0, 8)).join(', ');
}

export function taskReason(task: BoardTask): string {
  if (task.state === 'missed') return t('tasks.state.missed');
  if (task.state === 'queued' && task.queued?.waitsFor?.length) {
    const stopped = task.queued.waitsFor.filter((wait) => wait.stopped);
    return stopped.length
      ? t('board.waitsStopped', { ids: waitIds(stopped) })
      : t('board.waitsFor', { ids: waitIds(task.queued.waitsFor) });
  }
  if (task.state === 'queued' && task.queued?.resources?.paced) return t('board.queuedPaced');
  if (task.state === 'queued' && task.queued?.resources?.short.length) {
    return t('board.queuedRoom', { what: roomWords(task.queued.resources.short) });
  }
  if (activeAutoFix(task)) return autoFixLine(task);
  if (autoMergeTime(task)) return t('board.autoMergeAt', { time: autoMergeTime(task) });
  if (!task.blocker || isDoneTask(task)) return '';
  // The pill already says «revisión pendiente»; the detail says when it is retried.
  if (blockerKindOf(task) === 'review-unavailable') return '';
  // The pill says what it waits for; the detail that nobody has to do anything.
  if (waitsForBase(task)) return '';
  const key = BLOCKER_KEYS[blockerKindOf(task) as BoardBlockerKind];
  return key ? t(key, { base: task.baseBranch || 'main' }) : '';
}

/**
 * The line under the pill: the agent's question or what it asks permission for, the failing
 * check's last line, the risky files; else what the agent said it did.
 */
/** A risky task's flagged files, short. */
function riskFiles(task: Pick<TaskRecord, 'risk'>): string {
  const files = [...new Set((task.risk ?? []).map((risk) => risk.file).filter(Boolean))];
  return files.slice(0, 3).join(', ') + (files.length > 3 ? ', …' : '');
}

export function taskDetail(task: BoardTask): string {
  // Waiting for room: the numbers behind it (memory free, swap, load).
  if (task.state === 'queued' && task.queued?.resources?.short.length) {
    return task.queued.resources.detail;
  }
  const blocker = isDoneTask(task) ? undefined : task.blocker;
  // Fixing itself: what it is fixing is in the reason line; the agent's last words here.
  if (activeAutoFix(task)) return task.summary?.trim() ?? '';
  // Merging on its own soon: what it is and what the fix does (the headline).
  if (autoMergeTime(task) && task.security?.headline) return task.security.headline;
  // A risky task merging on its own soon: why it was flagged and that it was reviewed again.
  if (autoMergeTime(task) && !task.security && task.risk?.length) {
    return t('board.riskAutoMerge', { files: riskFiles(task) });
  }
  if (blocker && blockerKindOf(task) === 'review-unavailable') return reviewRetryLine(task);
  // Paused: when it goes on by itself, and the agent's own error.
  if (task.state === 'paused') {
    return [haltResumeLine(task), task.halt?.message].filter(Boolean).join(' · ');
  }
  if (waitsForBase(task)) return t('board.baseWaitDetail', { base: task.baseBranch || 'main' });
  if (blocker) {
    if (blocker.kind === 'verify') {
      const tail = (task.verify?.tail ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      return tail[tail.length - 1] ?? blocker.message;
    }
    if (blocker.kind === 'risk' && task.risk?.length) {
      const files = task.risk
        .map((risk) =>
          risk.file ? `${risk.file} (${riskRuleLabel(risk.rule)})` : riskRuleLabel(risk.rule)
        )
        .join(', ');
      // The second review of this commit did not confirm it: what it said (2026-10-24).
      const look = task.riskReview;
      if (look && look.verdict !== 'confirmed' && look.headSha === task.headSha) {
        const said =
          look.verdict === 'dismissed' && look.reason
            ? t('board.riskReviewRejected', { reason: look.reason })
            : t('board.riskReviewUnavailable');
        return `${files} · ${said}`;
      }
      return files;
    }
    const key = BLOCKER_DETAIL_KEYS[blocker.kind as BoardBlockerKind];
    if (key) {
      const files = blocker.kind === 'conflict' ? (blocker.detail ?? []) : [];
      return t(key, {
        base: task.baseBranch || 'main',
        files: files.slice(0, 3).join(', ') + (files.length > 3 ? ', …' : ''),
      });
    }
    return blocker.message;
  }
  return task.summary?.trim() ?? '';
}

/**
 * The card's one line (2026-11-08, «las tarjetas de inicio son muy verbosas»): what its agent
 * does now (`explain`, the model's line, only while it works), else why it stopped, else the
 * first line of its detail or summary. At most CARD_LINE_MAX characters, never a paragraph.
 */
export function taskGlanceLine(task: BoardTask, explain = ''): string {
  if (explain) return clipLine(explain);
  const reason = taskReason(task);
  if (reason) return clipLine(reason);
  return firstLine(taskDetail(task));
}

/** «4 archivos · +120 −3», or '' before anything was counted. */
/** "Claude", "Codex (gpt-5)", "claude-work (sonnet)": a runner as the card names it. */
export function runnerName(ref: TaskRunnerRef): string {
  const name = ref.runner === ref.agent ? (ref.agent === 'codex' ? 'Codex' : 'Claude') : ref.runner;
  return ref.model ? `${name} (${ref.model})` : name;
}

/**
 * Who runs it, shown only when it says more than the avatar: its model and why («rápido»,
 * «capaz»), each change of agent («Claude → Codex») and the model it really runs with, read
 * from its transcript («modelo: claude-opus-4-8», 2026-11-08: a default nobody saw). Empty for
 * a task on its agent's default that never changed and whose model was not read yet.
 */
export function taskAgentLine(
  task: Pick<TaskRecord, 'agent' | 'runner' | 'model' | 'modelChoice' | 'agentChanges' | 'metrics'>
): string {
  const changes = task.agentChanges ?? [];
  const actual = taskActualModel(task);
  if (!task.model && !task.modelChoice && !changes.length && !actual) return '';
  const current = runnerName({
    agent: task.agent,
    runner: task.runner ?? task.agent,
    ...(task.model ? { model: task.model } : {}),
  });
  const tier = task.modelChoice?.tier;
  const parts = [
    tier
      ? `${current} · ${t(tier === 'fast' ? 'board.agent.fast' : 'board.agent.capable')}`
      : current,
  ];
  for (const change of changes) {
    parts.push(
      t('board.agent.changed', { from: runnerName(change.from), to: runnerName(change.to) })
    );
  }
  if (actual) parts.push(t('board.agent.actual', { model: actual }));
  return parts.join(' · ');
}

export function taskStatsLine(task: TaskRecord): string {
  const stats = task.stats;
  if (!stats || (!stats.files && !stats.insertions && !stats.deletions)) return '';
  return t('board.stats', {
    files: stats.files,
    added: stats.insertions,
    removed: stats.deletions,
  });
}

const PHASE_KEY: Record<TaskPhase, MessageKey> = {
  queue: 'board.timings.phase.queue',
  'merge-queue': 'board.timings.phase.mergeQueue',
  verify: 'board.timings.phase.verify',
  review: 'board.timings.phase.review',
  'risk-review': 'board.timings.phase.riskReview',
  fix: 'board.timings.phase.fix',
  conflict: 'board.timings.phase.conflict',
  merge: 'board.timings.phase.merge',
};

/**
 * Where a task's time went (TaskRecord.timings, 2026-10-31): each phase's total, and the
 * rounds with the time from the first phase to the last. Empty when nothing was timed.
 */
export function taskTimingsLine(
  task: TaskRecord,
  now = Date.now()
): { phases: string; rounds: string } | null {
  const summary = summarizeTimings(task.timings, now);
  if (!summary) return null;
  return {
    phases: summary.phases
      .map((p) => `${t(PHASE_KEY[p.phase])} ${formatPhaseDuration(p.ms)}`)
      .join(' · '),
    rounds: t('board.timings.rounds', {
      count: summary.rounds,
      total: formatPhaseDuration(summary.wallMs),
    }),
  };
}

const BUDGET_KEY: Record<TaskBudgetKey, MessageKey> = {
  wall: 'board.budget.wall',
  agent: 'board.budget.agent',
  rounds: 'board.budget.rounds',
  tokens: 'board.budget.tokens',
  usd: 'board.budget.usd',
};

/**
 * Its budget, spent / limit (2026-11-01): "Presupuesto: tiempo 1h 10m/3h · agente 40m/2h ·
 * vueltas 2/6 · tokens 31M/100M". Only once something was spent; null otherwise.
 */
export function taskBudgetLine(task: TaskRecord): { text: string; near: boolean } | null {
  const budget = task.budget;
  if (!budget || TASK_FINAL_STATES.includes(task.state)) return null;
  const spent = TASK_BUDGET_KEYS.some((key) => budget.spent[key] > 0);
  if (!spent) return null;
  const parts = TASK_BUDGET_KEYS.filter(
    (key) => budget.limits[key] > 0 || budget.spent[key] > 0
  ).map((key) => {
    const limit = budget.limits[key] > 0 ? formatBudgetValue(key, budget.limits[key]) : '∞';
    return `${t(BUDGET_KEY[key])} ${formatBudgetValue(key, budget.spent[key])}/${limit}`;
  });
  const near = TASK_BUDGET_KEYS.some(
    (key) =>
      budget.limits[key] > 0 && (budget.spent[key] / budget.limits[key]) * 100 >= budget.warnPct
  );
  return { text: `${t('board.budget.label')}: ${parts.join(' · ')}`, near };
}

/** Each round's phases in order, for the task's detail: "Ronda 1: check 4m 38s, …". */
export function taskTimingRounds(task: TaskRecord, now = Date.now()): string[] {
  const timings = task.timings ?? [];
  const rounds = [...new Set(timings.map((timing) => timing.round))].sort((a, b) => a - b);
  return rounds.map((round) => {
    const phases = timings
      .filter((timing) => timing.round === round)
      .map((timing) => {
        const ms = timingMs(timing, now);
        const stopped = timing.phase === 'verify' && timing.outcome === 'cancelled';
        return `${t(PHASE_KEY[timing.phase])} ${ms === null ? '?' : formatPhaseDuration(ms)}${
          stopped ? ` ${t('board.timings.checkStopped')}` : ''
        }`;
      });
    return `${t('board.timings.round', { round })}: ${phases.join(', ')}`;
  });
}

/**
 * A task row's title, the way a session row picks it: the name the user gave its session,
 * else the task's own name (the user's words, from the prompt), else the agent's title.
 */
export function taskDisplayTitle(task: TaskRecord, session?: Session): string {
  const own = session?.userTitle?.trim();
  if (own) return own;
  // A task that undoes another: the server names it «Undo: <name>» in English.
  if (task.revertOf) {
    const original = (task.name ?? '').replace(/^Undo:\s*/i, '').trim();
    if (original) return t('board.undoName', { name: original });
  }
  return (
    task.name || (session ? agentConversationTitle(session) : '') || task.prompt.split('\n')[0]
  );
}

export interface TaskActions {
  /** The one filled button, or null (working rows show none: a tap opens the session). */
  primary: TaskAction | null;
  secondary: TaskAction[];
}

/**
 * The buttons of a row. `attempts`: other open tasks of its parallel group (then "Quedarme con
 * este" replaces "Fusionar"). `hasSession`: its session is listed (Abrir works).
 */
export function taskActions(
  task: BoardTask,
  options: TaskActionOptions = { hasSession: false }
): TaskActions {
  const actions = baseTaskActions(task, options);
  // Fast lane (2026-11-01): waiting for a check slot or its turn to merge, it can go first;
  // once marked, it can be unmarked while it is open. Earlier, `ut task priority` marks it.
  if (task.urgent && !TASK_FINAL_STATES.includes(task.state)) {
    actions.secondary = [...actions.secondary, 'notUrgent'];
  } else if (task.state === 'verifying') {
    actions.secondary = [...actions.secondary, 'urgent'];
  }
  return actions;
}

interface TaskActionOptions {
  hasSession: boolean;
  attempts?: number;
  /** The store's tasks: a merged task's undo task is looked up there. */
  tasks?: readonly Pick<TaskRecord, 'id' | 'state'>[];
}

function baseTaskActions(task: BoardTask, options: TaskActionOptions): TaskActions {
  const changes: TaskAction[] = task.worktreePath ? ['changes'] : [];
  const fix = activeAutoFix(task);
  if (fix) {
    // Untether hands it back to the agent by itself: nothing to decide. Its log (a failing
    // check or merge) and Descartar stay; a running check refuses a discard.
    const fixLog: TaskAction[] =
      fix.reason === 'verify' || fix.reason === 'merge-error' || task.state === 'verifying'
        ? ['log']
        : [];
    if (task.state === 'verifying' || task.state === 'merging') {
      return { primary: null, secondary: fixLog };
    }
    return { primary: null, secondary: [...fixLog, ...changes, 'discard'] };
  }
  const merge: TaskAction = options.attempts ? 'keep' : 'merge';
  const blocker = task.blocker?.kind;
  // The server reopens a Claude worktree task's conversation when its session is gone.
  const reopens = task.agent === 'claude' && task.isolation === 'worktree';
  const fixable = Boolean(task.blocker) && (options.hasSession || reopens);
  const log: TaskAction[] =
    blocker === 'setup' || blocker === 'verify' || blocker === 'merge-error' ? ['log'] : [];
  switch (task.state) {
    case 'scheduled':
      return { primary: null, secondary: ['cancel'] };
    case 'queued': {
      // Waiting for a slot of its project: start it now, move it in the line, or drop it.
      const position = task.queued?.position ?? 1;
      const of = task.queued?.of ?? position;
      return {
        primary: 'startNow',
        secondary: [
          ...(position > 1 ? (['moveUp'] as const) : []),
          ...(position < of ? (['moveDown'] as const) : []),
          'discard',
        ],
      };
    }
    case 'needs_you':
      // Stopped by its budget (2026-11-01): more of it sends it on; its work is kept.
      if ((blocker as BoardBlockerKind | undefined) === 'budget') {
        return { primary: 'moreBudget', secondary: [...changes, 'discard'] };
      }
      if (blocker === 'risk') return { primary: 'changes', secondary: ['mergeRisk', 'discard'] };
      if (blocker === 'review') {
        return fixable
          ? { primary: 'fix', secondary: ['mergeReview', ...changes, 'discard'] }
          : { primary: changes[0] ?? null, secondary: ['mergeReview', 'discard'] };
      }
      // A confirmed security fix, checked and reviewed: one tap merges it (2026-10-23).
      if (blocker === 'dirty-base' || blocker === 'no-check' || blocker === 'security') {
        return { primary: merge, secondary: [...changes, 'discard'] };
      }
      // An error of Untether's own that its retries did not get past: nothing for the agent to
      // fix; merging runs the pipeline again.
      if (task.blocker?.internal) {
        return { primary: merge, secondary: [...log, ...changes, 'discard'] };
      }
      if (
        (blocker === 'conflict' || blocker === 'verify' || blocker === 'merge-error') &&
        fixable
      ) {
        return { primary: 'fix', secondary: [...changes, 'discard'] };
      }
      return {
        primary: options.hasSession ? 'open' : null,
        secondary: [...changes, 'discard'],
      };
    case 'ready':
      // Merging on its own in a few minutes: «Parar» first, «Fusionar» merges it now.
      if (autoMergeTime(task))
        return { primary: 'hold', secondary: [merge, ...changes, 'discard'] };
      // The review could not run: Untether retries it by itself. Merging without it is the
      // user's call, never the main button.
      if ((blocker as BoardBlockerKind | undefined) === 'review-unavailable') {
        return { primary: null, secondary: ['mergeReview', ...changes, 'discard'] };
      }
      // It merges by itself once its base is clean: nothing to tap.
      if (waitsForBase(task)) return { primary: null, secondary: [...changes, 'discard'] };
      // Nothing changed (often a question asked as a task): read the answer first; Descartar
      // ends the conversation (2026-10-18 review: it was the main button).
      // Its agent says it is partial, or its result contradicts its branch (2026-11-01): look
      // or tell it what is left first; merging it as it is stays a tap away.
      if (blocker === 'partial' || blocker === 'result-mismatch') {
        return options.hasSession
          ? { primary: 'open', secondary: [merge, ...changes, 'discard'] }
          : { primary: merge, secondary: [...changes, 'discard'] };
      }
      if (blocker === 'no-changes') {
        return options.hasSession
          ? { primary: 'open', secondary: ['discard'] }
          : { primary: 'discard', secondary: [] };
      }
      return { primary: merge, secondary: [...changes, 'discard'] };
    case 'failed':
      if (
        (blocker === 'verify' || blocker === 'merge-error' || blocker === 'conflict') &&
        fixable
      ) {
        return { primary: 'fix', secondary: [...log, ...changes, 'discard'] };
      }
      // Its setup failed or its session ended before anything was done (2026-10-18 review:
      // Descartar was the only way out).
      if (blocker === 'setup' || blocker === 'session-exit') {
        return { primary: 'retry', secondary: [...log, ...changes, 'discard'] };
      }
      return {
        primary: options.hasSession ? 'open' : 'discard',
        secondary: options.hasSession ? [...log, ...changes, 'discard'] : [...log, ...changes],
      };
    case 'paused':
      // Its agent was cut short (usage limit, API error, login): it resumes by itself;
      // «Reintentar» sends it on now.
      // Another agent offered (ProjectSettings.agentFallback): «Seguir con Codex».
      return {
        primary: 'retry',
        secondary: [...(task.halt?.offer ? (['switchAgent'] as const) : []), ...changes, 'discard'],
      };
    case 'working':
      // A tap opens its session; it can still be stopped here (2026-10-18 review: killing its
      // session was the only way, and that sent half-done work on to merge).
      return { primary: null, secondary: ['discard'] };
    case 'preparing':
      // Its worktree and setup command run: a stuck setup could only be waited out (2026-10-20
      // audit). The server drops a task discarded while it is being prepared.
      return { primary: null, secondary: ['log', 'discard'] };
    case 'verifying':
      // The check runs under the merge pipeline, which refuses a discard while busy: its log only.
      return { primary: null, secondary: ['log'] };
    case 'merged':
      return { primary: null, secondary: canRevertTask(task, options.tasks) ? ['revert'] : [] };
    default:
      return { primary: null, secondary: [] };
  }
}

const ACTION_KEYS: Record<TaskAction, MessageKey> = {
  open: 'board.action.open',
  fix: 'board.action.fix',
  merge: 'board.action.merge',
  mergeRisk: 'board.action.merge',
  mergeReview: 'board.action.mergeAnyway',
  keep: 'board.action.keep',
  discard: 'board.action.discard',
  changes: 'board.action.changes',
  cancel: 'board.action.cancel',
  retry: 'board.action.retry',
  log: 'board.action.log',
  revert: 'board.action.revert',
  hold: 'board.action.hold',
  urgent: 'board.action.urgent',
  notUrgent: 'board.action.notUrgent',
  startNow: 'board.action.startNow',
  moveUp: 'board.action.moveUp',
  moveDown: 'board.action.moveDown',
  switchAgent: 'board.action.switchAgent',
  moreBudget: 'board.action.moreBudget',
};

export function taskActionLabel(action: TaskAction): string {
  return t(ACTION_KEYS[action]);
}

/** The avatar's state dot, in the session rows' vocabulary (phone-session-row rowAvatar). */
export function taskRowState(task: TaskRecord): 'working' | 'waiting' | 'idle' | 'exited' {
  switch (taskBucket(task)) {
    case 'working':
      return 'working';
    case 'needs':
    case 'failed':
      return 'waiting';
    case 'ready':
      return 'idle';
    default:
      return 'exited';
  }
}

/** One task, or the open attempts of a parallel group ("Lanzar en paralelo ×N"). */
export type TaskUnit =
  | { kind: 'task'; task: TaskRecord }
  | { kind: 'attempts'; groupId: string; tasks: TaskRecord[] };

/**
 * Tasks as the board shows them: a parallel group with two or more open attempts becomes one
 * card ("N intentos", A, B …) where its first attempt would be; a lone one is a plain row.
 */
export function taskUnits(tasks: readonly TaskRecord[]): TaskUnit[] {
  const groups = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    if (!task.groupId) continue;
    const members = groups.get(task.groupId);
    if (members) members.push(task);
    else groups.set(task.groupId, [task]);
  }
  const units: TaskUnit[] = [];
  const placed = new Set<string>();
  for (const task of tasks) {
    const members = task.groupId ? groups.get(task.groupId) : undefined;
    if (!task.groupId || !members || members.length < 2) {
      units.push({ kind: 'task', task });
      continue;
    }
    if (placed.has(task.groupId)) continue;
    placed.add(task.groupId);
    units.push({
      kind: 'attempts',
      groupId: task.groupId,
      tasks: [...members].sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0)),
    });
  }
  return units;
}

/** An attempt's letter: A, B, C, D (by its place in the group). */
export function attemptLetter(task: Pick<TaskRecord, 'groupIndex'>, fallback = 0): string {
  return String.fromCharCode(65 + Math.max(0, Math.min(25, task.groupIndex ?? fallback)));
}

/** The server's error codes (task-commands.ts) the user is told in their own language. */
const ERROR_KEYS: Record<string, MessageKey> = {
  forbidden: 'board.error.forbidden',
  'not-found': 'board.error.not-found',
  'not-open': 'board.error.not-open',
  'session-gone': 'board.error.session-gone',
  'needs-confirmation': 'board.error.needs-confirmation',
  busy: 'board.error.busy',
  'not-fixable': 'board.error.not-fixable',
  unavailable: 'board.error.unavailable',
};

/** Known English messages answered without a code (routes/tasks.ts). */
const MESSAGE_KEYS: Record<string, MessageKey> = {
  'The task still has its branch: discard it': 'board.error.hasBranch',
  'Tasks are not available yet': 'board.error.unavailable',
  'Tasks are not available on this server': 'board.error.unavailable',
  'Task not found': 'board.error.not-found',
  'No scheduled task with that id': 'board.error.not-found',
};

/**
 * Why a task request failed, in the user's language (2026-10-20 audit: the server's English
 * "The task is busy" showed in a Spanish toast). Validation and server errors keep their own
 * text: it is the only detail there is.
 */
export function taskErrorText(result: TaskActionResult, action?: TaskAction): string {
  if (result.status === 0) return t('board.error.network');
  const code = result.error ?? '';
  // «Nothing to fix» means something else for each button (2026-10-20 verify).
  if (code === 'not-fixable' && action === 'retry') return t('board.error.notFixableRetry');
  if (code === 'not-fixable' && action === 'revert') return t('board.error.notFixableRevert');
  const known = ERROR_KEYS[code] ?? MESSAGE_KEYS[code] ?? MESSAGE_KEYS[result.message ?? ''];
  if (known) return t(known);
  if (result.status === 503) return t('board.error.unavailable');
  return result.message || result.error || String(result.status || '?');
}

/**
 * What an action waiting for the user's OK does («Deshacer esta tarea»), by its kind; a kind
 * this app has no words for (2026-10-20 verify: 'revert' showed «notify.taskConfirmKind.revert»)
 * reads as the generic «Un agente te pide permiso», never as the key.
 */
export function confirmKindText(
  kind: string,
  fallback: MessageKey = 'notify.taskConfirmBody'
): string {
  const key = `notify.taskConfirmKind.${kind}` as MessageKey;
  const text = t(key);
  return text && text !== key ? text : t(fallback);
}

/** The orchestrator service's English answers (orchestrator.ts, routes/projects.ts). */
const ORCHESTRATOR_MESSAGES: Array<[RegExp, MessageKey]> = [
  [/^(A goal is required|repoPath and goal are required)$/, 'orch.error.goal'],
  [/^Not inside a git repository$/, 'orch.error.notRepo'],
  [/^The orchestrator's session ended before it got the goal$/, 'orch.error.sessionEnded'],
  [/^That session is not running Claude$/, 'orch.error.notClaude'],
  [/^That session is not running$/, 'orch.error.sessionGone'],
  [/^A task's session cannot orchestrate$/, 'orch.error.taskSession'],
  [/^That session already orchestrates /, 'orch.error.orchestratesElsewhere'],
  [/^This project already has an orchestrator/, 'orch.error.alreadyRunning'],
  [/^Could not type the brief into that session$/, 'orch.error.briefFailed'],
  [/^Orchestrators are not available here$/, 'board.error.unavailable'],
  [/^Only the signed-in app can /, 'board.error.forbidden'],
];

/** A failed request worded for the user, and the server's own text for the details. */
export interface WordedError {
  text: string;
  /** The raw answer (English, technical): only for a «Detalles» disclosure or the log. */
  raw: string;
}

function rawOf(result: TaskActionResult): string {
  return [result.error, result.message].filter(Boolean).join(': ') || String(result.status || '');
}

/**
 * Why starting or adopting an orchestrator failed, in the user's language (2026-10-20 verify:
 * «No se pudo empezar: This project already has an orchestrator…»). Unknown answers read as
 * a generic sentence; their text goes to the details.
 */
export function orchestratorErrorText(result: TaskActionResult): WordedError {
  const raw = rawOf(result);
  if (result.status === 0) return { text: t('board.error.network'), raw };
  const said = result.message || result.error || '';
  for (const [pattern, key] of ORCHESTRATOR_MESSAGES) {
    if (pattern.test(said) || pattern.test(result.error ?? '')) return { text: t(key), raw };
  }
  const code = result.error ?? '';
  if (ERROR_KEYS[code]) return { text: t(ERROR_KEYS[code]), raw };
  if (result.status === 503) return { text: t('board.error.unavailable'), raw };
  return { text: t('orch.error.generic'), raw };
}

/**
 * Why saving a project's settings failed (PUT /api/projects/settings): a refused value (400,
 * the server's English validation text in the details), no right, not available, offline;
 * else a generic sentence.
 */
export function projectSettingsErrorText(result: TaskActionResult): WordedError {
  const raw = rawOf(result);
  if (result.status === 0) return { text: t('board.error.network'), raw };
  const code = result.error ?? '';
  if (ERROR_KEYS[code]) return { text: t(ERROR_KEYS[code]), raw };
  if (result.status === 400) return { text: t('projectSettings.error.invalid'), raw };
  if (result.status === 403) return { text: t('board.error.forbidden'), raw };
  if (result.status === 503) return { text: t('board.error.unavailable'), raw };
  return { text: t('projectSettings.error.generic'), raw };
}

/** The folder name of a project path ('bakery'). */
function projectName(repoPath: string | undefined): string {
  const parts = (repoPath ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * «Te necesita» (2026-11-08, from Herdr's triage): everything on the home that waits for the
 * user, in ONE list ordered by urgency, each with its reason in one short line and the one tap
 * that moves it on. Pure logic; the section is components/session-list/list-needs-you.ts.
 *
 *   asks    a session or task waiting for an answer or a permission, an action waiting for
 *           the user's OK (it blocks work right now)
 *   failed  a task stopped on a failure only the user unblocks (check, conflict, review, …)
 *   ready   a finished task waiting to be merged
 *   paused  a task whose agent was cut short (usage limit, provider error, login)
 *
 * Within a tier, the one waiting longest comes first. It is a section of its own above the
 * groups: it never reorders them (groupOrder, dragged headers).
 */
import type { TaskConfirmation } from '../../shared/task-confirmations.js';
import type { TaskRecord } from '../../shared/tasks.js';
import type { Session } from '../../shared/types.js';
import { type MessageKey, t } from '../i18n/index.js';
import { claudeWaitingLabel } from './claude-waiting-label.js';
import { deriveSessionStatus, lastActivityAt } from './session-status.js';
import { waitingChoices, waitingFor, waitingSince } from './session-waiting.js';
import {
  autoMergeTime,
  type BoardTask,
  blockerKindOf,
  confirmKindText,
  haltResumeLine,
  isDoneTask,
  taskActions,
  taskDetail,
  taskHandlesItself,
  taskReason,
  taskWantsUser,
} from './task-status.js';

export type NeedsYouTier = 'asks' | 'failed' | 'ready' | 'paused';

/** The item's one button: answer the prompt, merge the task, open it, or see the OK sheet. */
export type NeedsYouAction = 'answer' | 'merge' | 'open' | 'confirm';

interface ItemBase {
  /** Unique across kinds: `session:<id>`, `task:<id>`, `confirm:<id>`. */
  key: string;
  tier: NeedsYouTier;
  /** Epoch ms it has been waiting since (0 when unknown: first in its tier). */
  since: number;
  /** Why, in one short line («pide permiso · rm -rf build», «revisión: 2 problemas»). */
  line: string;
  action: NeedsYouAction;
}

export type NeedsYouItem =
  | (ItemBase & { kind: 'session'; session: Session })
  | (ItemBase & { kind: 'task'; task: TaskRecord; session?: Session })
  | (ItemBase & { kind: 'confirmation'; confirmation: TaskConfirmation });

const TIER_RANK: Record<NeedsYouTier, number> = { asks: 0, failed: 1, ready: 2, paused: 3 };

const HALT_KEYS: Record<string, MessageKey> = {
  'usage-limit': 'needsYou.halt.usage-limit',
  'api-error': 'needsYou.halt.api-error',
  auth: 'needsYou.halt.auth',
  model: 'needsYou.halt.model',
};

function firstLine(text: string | undefined): string {
  return (
    (text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');

/** What a waiting session asks: «Petición de permiso · rm -rf build». */
export function sessionNeedsLine(session: Session): string {
  const what = claudeWaitingLabel(waitingFor(session)) ?? t('sessions.row.needsYou');
  const choices = waitingChoices(session);
  const subject = firstLine(choices?.detail?.[choices.detail.length - 1] ?? choices?.question);
  return join(what, subject);
}

/**
 * Why a task waits, in one line. It starts from the board's reason (taskReason, the card's own
 * words, so the section and the row never disagree) and adds what makes it actionable: the
 * agent's question or permission subject, the failing check's last line, the review's count.
 */
export function taskNeedsLine(task: BoardTask, now = Date.now()): string {
  if (task.state === 'paused') {
    const key = task.halt?.kind ? HALT_KEYS[task.halt.kind] : undefined;
    return join(key ? t(key) : taskReason(task), haltResumeLine(task, now));
  }
  const kind = blockerKindOf(task);
  const reason = taskReason(task);
  if (kind === 'review' && task.review?.issues?.length) {
    return t('needsYou.review', { n: task.review.issues.length });
  }
  if (kind === 'question' || kind === 'permission' || kind === 'verify') {
    return join(reason, firstLine(taskDetail(task)));
  }
  return reason || firstLine(taskDetail(task));
}

function sinceOf(iso: string | undefined): number {
  const ms = Date.parse(iso ?? '');
  return Number.isFinite(ms) ? ms : 0;
}

function asksOnItsSession(task: BoardTask, session: Session | undefined): boolean {
  return task.state !== 'failed' && !!session && deriveSessionStatus(session) === 'needs-input';
}

/** Where a task stands for the user, or null when nothing in it waits for them. */
function taskTier(task: BoardTask, session: Session | undefined): NeedsYouTier | null {
  // Its session asking for an answer or a permission comes before the task's state: a working
  // or ready task whose agent asks blocks work like any session that asks (2026-11-08 review).
  // Not a failed one (2026-11-09): what waits there is the failure, the menu left on its screen
  // is no question of a task that is over.
  if (asksOnItsSession(task, session)) return 'asks';
  if (taskWantsUser(task)) {
    if (task.state === 'failed') return 'failed';
    const kind = blockerKindOf(task);
    return kind === 'question' || kind === 'permission' ? 'asks' : 'failed';
  }
  if (task.state === 'ready') {
    // Untether merges or reviews it by itself (base clean soon, review retried, auto-merge).
    if (taskHandlesItself(task) || autoMergeTime(task)) return null;
    return 'ready';
  }
  if (task.state === 'paused') return 'paused';
  return null;
}

function taskAction(task: BoardTask, session: Session | undefined): NeedsYouAction {
  if (asksOnItsSession(task, session)) return 'answer';
  const primary = taskActions(task, { hasSession: Boolean(session) }).primary;
  return primary === 'merge' || primary === 'keep' ? 'merge' : 'open';
}

export interface NeedsYouInput {
  /** Live sessions (finished ones are ignored). */
  sessions: readonly Session[];
  /** Open board tasks. */
  tasks: readonly TaskRecord[];
  confirmations?: readonly TaskConfirmation[];
  /**
   * Tasks that ended (done, merged, discarded): nothing of theirs waits any more, neither their
   * session, still asking until it is stopped, nor an OK about them (2026-11-09).
   */
  closed?: readonly Pick<TaskRecord, 'id' | 'sessionId'>[];
  now?: number;
}

/** Everything that waits for the user, most urgent first. */
export function needsYouItems(input: NeedsYouInput): NeedsYouItem[] {
  const now = input.now ?? Date.now();
  const byId = new Map(input.sessions.map((session) => [session.id, session]));
  const items: NeedsYouItem[] = [];
  // A task's session is its item: its line is the task's, never a second one.
  const taskSessions = new Set(
    [...input.tasks, ...(input.closed ?? [])].map((task) => task.sessionId).filter(Boolean)
  );
  const closedTasks = new Set((input.closed ?? []).map((task) => task.id));
  for (const confirmation of input.confirmations ?? []) {
    if (confirmation.taskId && closedTasks.has(confirmation.taskId)) continue;
    items.push({
      kind: 'confirmation',
      key: `confirm:${confirmation.id}`,
      tier: 'asks',
      since: sinceOf(confirmation.createdAt),
      line: confirmKindText(confirmation.kind),
      action: 'confirm',
      confirmation,
    });
  }
  for (const task of input.tasks) {
    if (isDoneTask(task)) continue;
    const session = task.sessionId ? byId.get(task.sessionId) : undefined;
    const tier = taskTier(task, session);
    if (!tier) continue;
    items.push({
      kind: 'task',
      key: `task:${task.id}`,
      tier,
      since: sinceOf(task.stateSince || task.createdAt),
      line: taskNeedsLine(task, now),
      action: taskAction(task, session),
      task,
      session,
    });
  }
  for (const session of input.sessions) {
    if (taskSessions.has(session.id) || deriveSessionStatus(session, now) !== 'needs-input') {
      continue;
    }
    items.push({
      kind: 'session',
      key: `session:${session.id}`,
      tier: 'asks',
      since: waitingSince(session) ?? lastActivityAt(session) ?? 0,
      line: sessionNeedsLine(session),
      action: 'answer',
      session,
    });
  }
  return items.sort(
    (a, b) =>
      TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.since - b.since || a.key.localeCompare(b.key)
  );
}

/** Changes whenever the section would show something new (sessions change in place). */
export function needsYouStamp(items: readonly NeedsYouItem[]): string {
  return items.map((item) => `${item.key}|${item.tier}|${item.action}|${item.line}`).join(';');
}

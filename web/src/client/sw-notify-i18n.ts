/**
 * Claude push notifications in the user's language. The server can't know it, and the
 * service worker can't load the i18n bundle, so the app stores these few strings in Cache
 * Storage while online (utils/offline-page.ts) and the worker rebuilds the title and body
 * from the raw fields the server sends (`data.where`, `data.detail`). English otherwise.
 */
import { agentPush, namedForAgent } from '../shared/agent-push.js';
import { type ClaudeWaitingReason, claudeWaitingReason } from '../shared/claude-waiting-reason.js';
import type { ConfirmationKind } from '../shared/task-confirmations.js';
import type { TaskBlockerKind } from '../shared/tasks.js';

export const NOTIFY_STRINGS_URL = '/__untether/notify-strings.json';

export interface NotifyStrings {
  needsYou: string; // "⏳ Claude needs you · {where}"
  finished: string; // "✅ Claude finished · {where}"
  waiting: string; // body when Claude didn't say what it waits for
  yourTurn: string; // body when there's no answer preview
  open: string;
  dismiss: string;
  attention: string; // "🔔 {where} needs attention" (terminal bell)
  bellBody: string;
  commandFailed: string; // "❌ {where} failed" (command error)
  commandFailedBody: string; // "Exit code {code} · {duration}"
  answer: string; // "Answer" button of "Claude needs you"
  previewReady: string; // "👀 Preview ready · {where}" (`ut open`)
  taskMissed: string; // "⚠️ Task not run: {where}"
  taskMissedBody: string;
  taskReady: string; // "✅ Task ready: {where}"
  taskReadyBody: string; // body when there is no summary or reason
  taskNeedsYou: string; // "⏳ Task needs you: {where}"
  taskNeedsYouBody: string;
  taskReview: string; // "🔎 Review: {where}" (the AI review stopped the merge)
  taskReviewUnavailable: string; // added to "merged" when the AI review could not run
  taskFailed: string; // "❌ Task failed: {where}"
  taskFailedBody: string;
  taskMerged: string; // "✅ {where} merged"
  taskMergedBody: string; // "Now in {branch}"
  taskDone: string; // "✅ Task done: {where}" (a task without a worktree finished)
  taskQueued: string; // "🕒 Task queued: {where}" (its project's task limit, 2026-11-01)
  taskQueuedBody: string; // "{position} of {of} in line: {active} of {limit} tasks …"
  /** "{position} of {of} in line: waiting for {what} on the Mac …" (taskAdmission, 2026-11-01). */
  taskQueuedRoomBody: string;
  /** "Waits for {ids}: …" (started after other tasks: --after, its zone; 2026-11-11). */
  taskWaitsBody: string;
  /** "{ids} was discarded or failed: it does not start by itself …". */
  taskWaitsStoppedBody: string;
  /** What the Mac is short of (data.waitingFor), translated: memory, swap, cpu. */
  taskRoomWords: Record<'memory' | 'swap' | 'cpu', string>;
  taskStarted: string; // "▶️ Task started: {where}" (it waited in line)
  taskStartedBody: string;
  taskAgentChanged: string; // "🔀 Other agent: {where}" (its own hit its usage limit)
  taskAgentChangedBody: string; // "{from} hit its limit: {to} carries on…"
  taskBudget: string; // "💸 Task near its budget: {where}" (2026-11-01)
  taskBudgetBody: string; // "{pct} % of its budget spent: …"
  taskStalled: string; // "🐢 Task stalled: {where}" (no progress, 2026-11-02)
  taskStalledBody: string;
  taskStalledEscalatedBody: string; // still no progress after Untether's nudge
  taskLooping: string; // "🔁 Task stuck in a loop: {where}" (the same failure, 2026-11-03)
  taskLoopingBody: string;
  taskPaused: string; // "⏸ Task paused: {where}" (usage limit / API error)
  taskPausedBody: string; // "Untether sends it on by itself at {time}"
  taskConfirm: string; // "🔐 Confirm · {where}" (an agent's action waiting for your OK)
  taskConfirmBody: string;
  /** What the action waiting for the OK does (data.kind), translated. */
  taskConfirmKinds: Partial<Record<ConfirmationKind, string>>;
  /** Why a task stopped (data.blocker), translated; newer kinds ('review-unavailable') too. */
  taskBlockers: Partial<Record<TaskBlockerKind | 'review-unavailable', string>>;
  replied: string; // "💬 Claude replied · {where}" (background agents still running)
  repliedBody: string; // body when there's no reply preview
  /** "Claude needs you" body: what it waits for, translated ("permission prompt" → …). */
  reasons: Partial<Record<ClaudeWaitingReason, string>>;
  /** Body of the stand-in notification shown when a push can't be read. */
  fallbackBody: string;
  /** "Untether had its agent fix it {n} times and it still does not merge", translated. */
  taskGaveUp: string;
  /** "✅ Done without asking · {where}" (the user's autoApprove ran an action, 2026-10-24). */
  taskAutoApproved: string;
  /** "⚠️ Approved without asking, but it failed · {where}". */
  taskAutoApprovedFailed: string;
  /** "Merges at {time} without asking you (auto-approve): {headline}". */
  taskAutoApproveMerge: string;
  /** "Merges on its own at {time}: {headline}" (a security fix counting down, 2026-10-23). */
  taskAutoMerge: string;
  /** "… {headline}. Flagged as risky ({files}) …" (a reviewed risky task counting down). */
  taskRiskAutoMerge: string;
  /** "Risky change not merged. Second review: {reason}" (it did not confirm it). */
  taskRiskRejected: string;
  /** "Risky change not merged: the second review could not run". */
  taskRiskReviewUnavailable: string;
  /** "Not merged on its own: auto-merge is paused for this project", translated. */
  taskReadyPaused: string;
  /** "⏳ Waiting to merge: {where}" (its base checkout still dirty after hours, 2026-10-24). */
  taskBaseWait: string;
  /** "{base} has had uncommitted changes for {hours} h …: nothing to do". */
  taskBaseWaitBody: string;
  /** "Deshacer: {name}" for a task the server named "Undo: <name>". */
  undoName: string;
  /** "⏸️ Automatic merging paused · {where}" (project-paused). */
  projectPaused: string;
  /** "{reason}. For the next 24 hours …" */
  projectPausedBody: string;
  /** The same without a reason (an unknown data.code). */
  projectPausedBodyGeneric: string;
  /** The reason by data.code, with {n} for data.count. */
  projectPausedReasons: Record<'reverts' | 'failures', string>;
  /** "🛡️ Security · {where}" (security-notice: exposure with its fix outside the repository). */
  securityNotice: string;
  /** "🧹 You can remove the old tmux" (tmux-old-permission, once, 2026-10-31). */
  tmuxOldPermission: string;
  /** "… remove the old tmux ({old}) from … Full Disk Access." */
  tmuxOldPermissionBody: string;
  /** "Untether updated itself to {commit}" (app-updated, 2026-11-11). */
  appUpdated: string;
  /** "Untether could not update itself" (app-update-failed); the body says why. */
  appUpdateFailed: string;
  /** "Untether's update is waiting" (app-update-waiting); the body says on what, by name. */
  appUpdateWaiting: string;
  /** Why, by the server's reason code (installed-app-updater.ts AppUpdateFailure). */
  appUpdateReasons: Record<string, string>;
}

/**
 * Every field and its shape: a text, or words by a code. The app and the worker ship together,
 * so a stored set without one of them (another build's) is not this app's and is not used.
 */
const NOTIFY_FIELDS: Record<keyof NotifyStrings, 'text' | 'words'> = {
  needsYou: 'text',
  finished: 'text',
  waiting: 'text',
  yourTurn: 'text',
  open: 'text',
  dismiss: 'text',
  attention: 'text',
  bellBody: 'text',
  commandFailed: 'text',
  commandFailedBody: 'text',
  answer: 'text',
  previewReady: 'text',
  taskMissed: 'text',
  taskMissedBody: 'text',
  taskReady: 'text',
  taskReadyBody: 'text',
  taskNeedsYou: 'text',
  taskNeedsYouBody: 'text',
  taskReview: 'text',
  taskReviewUnavailable: 'text',
  taskFailed: 'text',
  taskFailedBody: 'text',
  taskMerged: 'text',
  taskMergedBody: 'text',
  taskDone: 'text',
  taskQueued: 'text',
  taskQueuedBody: 'text',
  taskQueuedRoomBody: 'text',
  taskWaitsBody: 'text',
  taskWaitsStoppedBody: 'text',
  taskRoomWords: 'words',
  taskStarted: 'text',
  taskStartedBody: 'text',
  taskAgentChanged: 'text',
  taskAgentChangedBody: 'text',
  taskBudget: 'text',
  taskBudgetBody: 'text',
  taskStalled: 'text',
  taskStalledBody: 'text',
  taskStalledEscalatedBody: 'text',
  taskLooping: 'text',
  taskLoopingBody: 'text',
  taskPaused: 'text',
  taskPausedBody: 'text',
  taskConfirm: 'text',
  taskConfirmBody: 'text',
  taskConfirmKinds: 'words',
  taskBlockers: 'words',
  replied: 'text',
  repliedBody: 'text',
  reasons: 'words',
  fallbackBody: 'text',
  taskGaveUp: 'text',
  taskAutoApproved: 'text',
  taskAutoApprovedFailed: 'text',
  taskAutoApproveMerge: 'text',
  taskAutoMerge: 'text',
  taskRiskAutoMerge: 'text',
  taskRiskRejected: 'text',
  taskRiskReviewUnavailable: 'text',
  taskReadyPaused: 'text',
  taskBaseWait: 'text',
  taskBaseWaitBody: 'text',
  undoName: 'text',
  projectPaused: 'text',
  projectPausedBody: 'text',
  projectPausedBodyGeneric: 'text',
  projectPausedReasons: 'words',
  securityNotice: 'text',
  tmuxOldPermission: 'text',
  tmuxOldPermissionBody: 'text',
  appUpdated: 'text',
  appUpdateFailed: 'text',
  appUpdateWaiting: 'text',
  appUpdateReasons: 'words',
};

interface ClaudeNotification {
  title: string;
  body: string;
  actions?: Array<{ action: string; title: string }>;
  data?: {
    type?: string;
    where?: string;
    detail?: string;
    /** app-update-failed: why, as the server's reason code. */
    reason?: string;
    blocker?: string;
    branch?: string;
    /** task-merged: 'unavailable' when the AI review could not run. */
    review?: string;
    /** task-confirm, task-auto-approved: what the action does. */
    kind?: string;
    /** task-auto-approved: approved, but it did not work (why, in English). */
    failed?: string;
    /** task-ready: counting down because the user's autoApprove gave the merge OK. */
    autoApproved?: boolean;
    /** task-ready: waiting for its base branch (`base`) to be clean since then (ISO). */
    baseWaitSince?: string;
    base?: string;
    /** project-paused: why ('reverts' | 'failures') and how many tasks. */
    code?: string;
    count?: number;
    /** A security fix counting down to merging on its own (ISO), and its headline. */
    autoMergeAt?: string;
    headline?: string;
    /** A risky task counting down: its flagged files (2026-10-24). */
    riskFiles?: string;
    /** A risky task the second review did not confirm: 'dismissed' (riskReason) or 'unavailable'. */
    riskReview?: string;
    riskReason?: string;
    /** security-notice: what to do (the finding is `detail`). */
    fix?: string;
    /** task-queued: its place in its project's line, and the slots held of the limit. */
    position?: number;
    of?: number;
    active?: number;
    limit?: number;
    /** task-agent-changed: who stopped and who carries on. */
    fromAgent?: string;
    toAgent?: string;
    toModel?: string;
    /** task-queued: the tasks it waits for (short ids), and whether one of them stopped. */
    waitsOn?: string[];
    waitStopped?: boolean;
    /** What the Mac is short of, for a task waiting for room (taskAdmission). */
    waitingFor?: string[];
    /** task-stalled: Untether's nudge went unanswered. */
    escalated?: boolean;
    /** task-paused: when Untether sends it on by itself (ISO). */
    resumeAt?: string;
    /** task-budget: the highest share of a limit spent, in percent. */
    budgetPct?: number;
  };
}

/** A stored string set is used only whole: every text a string, every word list its strings. */
export function isNotifyStrings(value: unknown): value is NotifyStrings {
  if (!value || typeof value !== 'object') return false;
  const stored = value as Record<string, unknown>;
  return (Object.entries(NOTIFY_FIELDS) as Array<[string, 'text' | 'words']>).every(
    ([field, shape]) => {
      const entry = stored[field];
      if (shape === 'text') return typeof entry === 'string';
      return (
        !!entry &&
        typeof entry === 'object' &&
        Object.values(entry).every((word) => typeof word === 'string')
      );
    }
  );
}

/** The translated reason a task stopped, when the push names one. */
function blockerText(payload: ClaudeNotification, strings: NotifyStrings): string {
  const kind = payload.data?.blocker;
  const text = kind
    ? strings.taskBlockers[kind as TaskBlockerKind | 'review-unavailable']
    : undefined;
  return typeof text === 'string' ? text : '';
}

/** Untether's own English when its automatic fixes ran out (task-scheduler.ts). */
const GAVE_UP =
  /^Untether had its agent fix it (\d+) times and it still does not merge(?::\s*([\s\S]*))?$/;
/** Untether's own English for a ready task of a paused project (task-scheduler.ts pausedNote). */
const PAUSED_NOTE = /^Not merged on its own: auto-merge is paused for this project\b/;

/** split/join, not replace(): a name with "$'" or "$$" is a replacement pattern there. */
function fillIn(template: string, name: string, value: string): string {
  return template.split(`{${name}}`).join(value);
}

/**
 * A task's detail with Untether's own English replaced: the automatic fixes that ran out
 * (what the blocker says follows: the reviewer's own words for a review, else the translated
 * kind) and the paused-project note. Anything else (the agent's words) stays.
 */
function untetherDetail(
  detail: string | undefined,
  payload: ClaudeNotification,
  strings: NotifyStrings
): string | undefined {
  if (!detail) return detail;
  const gaveUp = GAVE_UP.exec(detail);
  if (gaveUp) {
    const head = fillIn(strings.taskGaveUp, 'n', gaveUp[1]);
    const rest =
      payload.data?.blocker === 'review'
        ? (gaveUp[2] ?? '').trim()
        : blockerText(payload, strings) || (gaveUp[2] ?? '').trim();
    return rest ? `${head}: ${rest}` : head;
  }
  if (PAUSED_NOTE.test(detail)) return strings.taskReadyPaused;
  return detail;
}

/** The first letter up («se deshicieron…» opens a sentence). */
function sentence(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

export function localizeClaudeNotification<T extends ClaudeNotification>(
  payload: T,
  strings: NotifyStrings | null
): T {
  const { type, where: rawWhere } = payload.data ?? {};
  if (!strings || rawWhere === undefined) return payload;
  // The server names an undo task «Undo: <name>» in English.
  const undone = /^Undo:\s*/.test(rawWhere) && type?.startsWith('task-');
  const where = undone
    ? fillIn(strings.undoName, 'name', rawWhere.replace(/^Undo:\s*/, ''))
    : rawWhere;
  const detail = type?.startsWith('task-')
    ? untetherDetail(payload.data?.detail, payload, strings)
    : payload.data?.detail;
  // Claude's or Codex's own push: the same words, the agent's name in them.
  const own = agentPush(type);
  const fill = (template: string) => fillIn(namedForAgent(template, own?.agent), 'where', where);
  let title: string;
  let body: string;
  if (own?.kind === 'waiting') {
    title = fill(strings.needsYou);
    const reason = claudeWaitingReason(detail);
    const translated = reason ? strings.reasons[reason] : undefined;
    body = (typeof translated === 'string' && translated) || detail || strings.waiting;
  } else if (own?.kind === 'finished') {
    title = fill(strings.finished);
    body = detail || strings.yourTurn;
  } else if (own?.kind === 'replied') {
    title = fill(strings.replied);
    body = detail || strings.repliedBody;
  } else if (type === 'command-error') {
    title = fill(strings.commandFailed);
    const code = (payload.data as { exitCode?: unknown } | undefined)?.exitCode;
    body = strings.commandFailedBody
      .split('{code}')
      .join(String(code ?? '?'))
      .split('{duration}')
      .join(detail ?? '');
  } else if (type === 'preview-ready') {
    title = fill(strings.previewReady);
    body = payload.body;
  } else if (type === 'task-ready' && payload.data?.baseWaitSince) {
    // Still waiting for its base to be clean: news, nothing to answer.
    title = fill(strings.taskBaseWait);
    const since = Date.parse(payload.data.baseWaitSince);
    const hours = Number.isFinite(since)
      ? Math.max(1, Math.round((Date.now() - since) / 3_600_000))
      : 1;
    body = fillIn(
      fillIn(strings.taskBaseWaitBody, 'base', payload.data.base ?? 'main'),
      'hours',
      `${hours}`
    );
  } else if (type === 'task-ready') {
    title = fill(strings.taskReady);
    body = blockerText(payload, strings) || detail || strings.taskReadyBody;
    // A security fix about to merge on its own: when, in this phone's clock, and what.
    const at = new Date(String(payload.data?.autoMergeAt ?? ''));
    if (!Number.isNaN(at.getTime())) {
      const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const headline = String(payload.data?.headline ?? '');
      const files = payload.data?.riskFiles;
      body =
        payload.data?.autoApproved === true
          ? fillIn(fillIn(strings.taskAutoApproveMerge, 'time', time), 'headline', headline)
          : typeof files === 'string'
            ? fillIn(
                fillIn(fillIn(strings.taskRiskAutoMerge, 'time', time), 'headline', headline),
                'files',
                files
              )
            : fillIn(fillIn(strings.taskAutoMerge, 'time', time), 'headline', headline);
    }
  } else if (type === 'task-needs-you' && payload.data?.blocker === 'review') {
    // The reviewer's own one-line summary (Spanish) says more than the kind.
    title = fill(strings.taskReview);
    body = detail || blockerText(payload, strings) || payload.body;
  } else if (
    type === 'task-needs-you' &&
    payload.data?.blocker === 'risk' &&
    payload.data.riskReview
  ) {
    // A risky change the second review did not confirm: what it said (Spanish), or that it
    // could not run (2026-10-24).
    title = fill(strings.taskNeedsYou);
    const reason = payload.data.riskReason;
    body =
      payload.data.riskReview === 'dismissed' && reason
        ? fillIn(strings.taskRiskRejected, 'reason', reason)
        : strings.taskRiskReviewUnavailable;
  } else if (type === 'task-needs-you') {
    title = fill(strings.taskNeedsYou);
    const kind = payload.data?.blocker;
    // A question or a permission prompt: the agent's own words say more than the kind; a
    // confirmed security fix's headline (how serious, what, the fix) too (2026-10-23).
    const own = kind === 'question' || kind === 'permission' || kind === 'security' ? detail : '';
    body = own || blockerText(payload, strings) || detail || strings.taskNeedsYouBody;
  } else if (type === 'task-failed') {
    title = fill(strings.taskFailed);
    body = blockerText(payload, strings) || detail || strings.taskFailedBody;
  } else if (type === 'task-merged') {
    title = fill(strings.taskMerged);
    const branch = payload.data?.branch;
    const unavailable = payload.data?.review === 'unavailable' ? strings.taskReviewUnavailable : '';
    // The server's English "· AI review unavailable" is replaced by the translated one.
    const strip = (text: string) => text.replace(/( · )?AI review unavailable$/, '');
    const main =
      strip(detail ?? '') ||
      (branch ? fillIn(strings.taskMergedBody, 'branch', branch) : strip(payload.body));
    body = unavailable ? `${main} · ${unavailable}` : main;
  } else if (type === 'task-done') {
    // Its report (Spanish, the agent's words), else the generic body.
    title = fill(strings.taskDone);
    body = detail || strings.taskReadyBody;
  } else if (type === 'task-queued') {
    // Rebuilt from the numbers: the server's sentence is English.
    title = fill(strings.taskQueued);
    const data = payload.data ?? {};
    const waitingFor = Array.isArray(data.waitingFor)
      ? (data.waitingFor as unknown[]).filter((what): what is 'memory' | 'swap' | 'cpu' =>
          ['memory', 'swap', 'cpu'].includes(what as string)
        )
      : [];
    const roomWords = waitingFor.map((what) => strings.taskRoomWords[what]);
    // Started after other tasks: which ones, or that one of them stopped (a decision).
    const waitsOn = Array.isArray(data.waitsOn)
      ? (data.waitsOn as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];
    const waitsBody =
      data.waitStopped === true ? strings.taskWaitsStoppedBody : strings.taskWaitsBody;
    body = waitsOn.length
      ? fillIn(waitsBody, 'ids', waitsOn.join(', '))
      : waitingFor.length && [data.position, data.of].every((n) => typeof n === 'number')
        ? fillIn(
            fillIn(
              fillIn(strings.taskQueuedRoomBody, 'position', String(data.position)),
              'of',
              String(data.of)
            ),
            'what',
            roomWords.join(', ')
          )
        : [data.position, data.of, data.active, data.limit].every((n) => typeof n === 'number')
          ? (['position', 'of', 'active', 'limit'] as const).reduce(
              (text, key) => fillIn(text, key, String(data[key])),
              strings.taskQueuedBody
            )
          : payload.body;
  } else if (type === 'task-budget') {
    // Rebuilt from its number: the server's sentence (with where the time went) is English.
    title = fill(strings.taskBudget);
    const pct = payload.data?.budgetPct;
    body =
      typeof pct === 'number' ? fillIn(strings.taskBudgetBody, 'pct', String(pct)) : payload.body;
  } else if (type === 'task-stalled') {
    // The server's sentence (minutes, what it waits on) is English: a generic one instead.
    title = fill(strings.taskStalled);
    body =
      payload.data?.escalated === true ? strings.taskStalledEscalatedBody : strings.taskStalledBody;
  } else if (type === 'task-looping') {
    // The server's sentence (the command, the error) is English: a generic one instead.
    title = fill(strings.taskLooping);
    body = strings.taskLoopingBody;
  } else if (type === 'task-paused') {
    title = fill(strings.taskPaused);
    const at = new Date(String(payload.data?.resumeAt ?? ''));
    // Without a time (its tries ran out) the server's own sentence stays.
    body = !Number.isNaN(at.getTime())
      ? fillIn(
          strings.taskPausedBody,
          'time',
          at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        )
      : payload.body;
  } else if (type === 'task-started') {
    title = fill(strings.taskStarted);
    body = strings.taskStartedBody;
  } else if (type === 'task-agent-changed') {
    title = fill(strings.taskAgentChanged);
    const data = payload.data ?? {};
    const name = (agent: unknown) => (agent === 'codex' ? 'Codex' : 'Claude');
    const to = data.toModel ? `${name(data.toAgent)} (${data.toModel})` : name(data.toAgent);
    body = data.toAgent
      ? fillIn(fillIn(strings.taskAgentChangedBody, 'from', name(data.fromAgent)), 'to', to)
      : payload.body;
  } else if (type === 'task-confirm') {
    title = fill(strings.taskConfirm);
    const kind = payload.data?.kind;
    const what = kind ? strings.taskConfirmKinds[kind as ConfirmationKind] : undefined;
    body = what || detail || strings.taskConfirmBody;
  } else if (type === 'task-auto-approved') {
    // Nothing to answer: what the user's autoApprove did, in the kind's words.
    const failed = payload.data?.failed;
    title = fill(
      typeof failed === 'string' ? strings.taskAutoApprovedFailed : strings.taskAutoApproved
    );
    const kind = payload.data?.kind;
    const what = kind ? strings.taskConfirmKinds[kind as ConfirmationKind] : undefined;
    const main = what || detail || payload.body;
    body = typeof failed === 'string' && failed ? `${main}: ${failed}` : main;
  } else if (type === 'project-paused') {
    // The server's reason is English: the sentence is rebuilt from data.code and data.count.
    title = fill(strings.projectPaused);
    const { code, count } = payload.data ?? {};
    const template =
      (code === 'reverts' || code === 'failures') && typeof count === 'number' && count > 0
        ? strings.projectPausedReasons[code]
        : undefined;
    const reason = template ? fillIn(template, 'n', String(count)) : '';
    body = reason
      ? fillIn(strings.projectPausedBody, 'reason', sentence(reason))
      : strings.projectPausedBodyGeneric;
  } else if (type === 'security-notice') {
    // What the sweep saw and what to do (its words: the agent's, or Untether's own).
    title = fill(strings.securityNotice);
    const fix = payload.data?.fix;
    body = detail ? (fix ? `${detail}. ${fix}` : detail) : payload.body;
  } else if (type === 'tmux-old-permission') {
    title = strings.tmuxOldPermission;
    body = fillIn(strings.tmuxOldPermissionBody, 'old', detail || 'tmux');
  } else if (type === 'app-updated') {
    title = fillIn(strings.appUpdated, 'commit', detail || '');
    body = '';
  } else if (type === 'app-update-failed') {
    title = strings.appUpdateFailed;
    const reason = payload.data?.reason;
    // A reason without words of its own: the server's sentence stays.
    body = (typeof reason === 'string' && strings.appUpdateReasons[reason]) || payload.body;
  } else if (type === 'app-update-waiting') {
    // What holds it names a task or a session: the server's sentence stays.
    title = strings.appUpdateWaiting;
    body = payload.body;
  } else if (type === 'task-missed') {
    title = fill(strings.taskMissed);
    body = strings.taskMissedBody;
  } else if (type === 'bell') {
    title = fill(strings.attention);
    body = strings.bellBody;
  } else {
    return payload;
  }
  // Untether's own English, translated, says more than the blocker's kind.
  const rewritten = detail !== payload.data?.detail;
  if (
    rewritten &&
    detail &&
    (type === 'task-ready' || type === 'task-needs-you' || type === 'task-failed')
  ) {
    body = detail;
  }
  const actions = localizeActionTitles(payload.actions, strings);
  return { ...payload, title, body, ...(actions ? { actions } : {}) };
}

/** Button titles the server sends in English ("View Session", "Dismiss"…), translated. */
export function localizeActionTitles<A extends { action: string; title: string }>(
  actions: A[] | undefined,
  strings: NotifyStrings | null
): A[] | undefined {
  if (!actions || !strings) return actions;
  return actions.map((action) =>
    action.action === 'view-session' || action.action === 'view-logs'
      ? { ...action, title: strings.open }
      : action.action === 'dismiss'
        ? { ...action, title: strings.dismiss }
        : action.action === 'answer'
          ? { ...action, title: strings.answer }
          : action
  );
}

/** A push as the worker shows it: title and body always strings, data always an object. */
export interface ShownPush {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  data: { type?: string; timestamp?: number | string; [key: string]: unknown };
  actions?: Array<{ action: string; title: string; icon?: string }>;
  tag?: string;
  requireInteraction?: boolean;
}

/**
 * Validate a decoded push payload. Returns null when it can't be shown as sent (not an
 * object, no title), so the worker shows the stand-in instead of nothing.
 */
export function coercePushPayload(raw: unknown): ShownPush | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.title !== 'string' || !value.title) return null;
  const data =
    value.data && typeof value.data === 'object' ? (value.data as ShownPush['data']) : {};
  const actions = Array.isArray(value.actions)
    ? (value.actions as unknown[]).filter(
        (a): a is { action: string; title: string } =>
          !!a &&
          typeof (a as { action?: unknown }).action === 'string' &&
          typeof (a as { title?: unknown }).title === 'string'
      )
    : undefined;
  return {
    title: value.title,
    body: typeof value.body === 'string' ? value.body : '',
    icon: typeof value.icon === 'string' ? value.icon : undefined,
    badge: typeof value.badge === 'string' ? value.badge : undefined,
    data,
    actions,
    tag: typeof value.tag === 'string' ? value.tag : undefined,
    requireInteraction: value.requireInteraction === true,
  };
}

/**
 * The stand-in shown when a push can't be read or shown. iOS revokes the subscription of
 * a web app whose pushes show no notification, so every push must show something.
 * (2026-10-20: a malformed payload returned without a notification.)
 */
export function fallbackPushNotification(strings: NotifyStrings | null): ShownPush {
  return {
    title: 'Untether',
    body: strings?.fallbackBody ?? 'Something new in Untether',
    data: { type: 'fallback' },
    tag: 'untether-fallback',
  };
}

/** The default buttons of a notification type, in the stored language when known. */
export function defaultNotificationActions(
  type: string | undefined,
  strings: NotifyStrings | null
): Array<{ action: string; title: string }> {
  const dismiss = { action: 'dismiss', title: strings?.dismiss ?? 'Dismiss' };
  switch (type) {
    case 'session-exit':
    case 'session-error':
    case 'session-start':
    case 'command-finished':
    case 'command-error':
      return [{ action: 'view-session', title: strings?.open ?? 'View Session' }, dismiss];
    default:
      return [dismiss];
  }
}

/**
 * How a push feels in the hand, by type (Android; iOS ignores `vibrate`): the more it needs
 * the user, the longer. Decision 2026-11-11: applied to every notification.
 */
export function vibrationPattern(notificationType: string): number[] {
  switch (notificationType) {
    case 'session-error':
    case 'command-error':
      return [200, 100, 200, 100, 200]; // urgent
    case 'task-failed':
      return [150, 75, 150, 75, 150]; // something to look at
    case 'claude-waiting':
    case 'codex-waiting':
    case 'task-needs-you':
    case 'task-confirm':
      return [120, 60, 120, 60, 120]; // needs an answer
    case 'session-exit':
      return [100, 50, 100];
    case 'command-finished':
    case 'claude-finished':
    case 'claude-replied':
    case 'codex-finished':
    case 'task-ready':
    case 'task-merged':
    case 'task-done':
    case 'task-auto-approved':
      return [75, 50, 75]; // news
    case 'session-start':
      return [50];
    default:
      return [100];
  }
}

const NOTIFICATION_TAG_PREFIX = 'untether-';

/** What showNotification gets for a push, vibration included (`now` makes an untagged one unique). */
export function notificationOptionsFor(
  payload: ShownPush,
  strings: NotifyStrings | null,
  now: number
): NotificationOptions & { vibrate: number[]; renotify: boolean } {
  const { body, icon, badge, data, actions, tag, requireInteraction } = payload;
  return {
    body,
    icon: icon || '/apple-touch-icon.png',
    badge: badge || '/favicon-32.png',
    data,
    tag: tag || `${NOTIFICATION_TAG_PREFIX}${data.type ?? 'push'}-${now}`,
    requireInteraction: requireInteraction || data.type === 'session-error',
    silent: false,
    renotify: true,
    // No `'vibrate' in navigator` guard: a worker's navigator never has it (checked in a real
    // Chromium worker, 2026-11-10), and the option belongs to the notification, not to it.
    vibrate: vibrationPattern(data.type ?? ''),
    actions: actions?.length ? actions : defaultNotificationActions(data.type, strings),
    timestamp: typeof data.timestamp === 'number' ? data.timestamp : undefined,
  } as NotificationOptions & { vibrate: number[]; renotify: boolean };
}

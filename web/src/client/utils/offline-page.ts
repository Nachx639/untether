/**
 * Stores the service worker's offline page in the user's language. The worker can't load
 * the i18n bundle, so the app renders the page while it's online and leaves it in Cache
 * Storage; the worker falls back to English if it never got one. Static text only.
 */
import { CONFIRMATION_KINDS } from '../../shared/task-confirmations.js';
import { TASK_BLOCKER_KINDS } from '../../shared/tasks.js';
import { getLocale, isRtlLocale, LOCALE_CHANGED_EVENT, type MessageKey, t } from '../i18n/index.js';
import { NOTIFY_STRINGS_URL, type NotifyStrings } from '../sw-notify-i18n.js';
import { OFFLINE_CACHE, OFFLINE_PAGE_URL, renderOfflinePage } from '../sw-offline.js';
import { CLAUDE_WAITING_KEYS } from './claude-waiting-label.js';
import { createLogger } from './logger.js';

const logger = createLogger('offline-page');

/** The notification strings in the current language (stored for the worker, tested per locale). */
export function buildNotifyStrings(): NotifyStrings {
  return {
    needsYou: t('notify.needsYou', { where: '{where}' }),
    finished: t('notify.finished', { where: '{where}' }),
    waiting: t('notify.waiting'),
    yourTurn: t('notify.yourTurn'),
    open: t('notify.open'),
    dismiss: t('notify.dismiss'),
    attention: t('notify.attention', { where: '{where}' }),
    bellBody: t('notify.bellBody'),
    commandFailed: t('notify.commandFailed', { where: '{where}' }),
    commandFailedBody: t('notify.commandFailedBody', { code: '{code}', duration: '{duration}' }),
    answer: t('answerSheet.notifyAction'),
    previewReady: t('preview.notify', { where: '{where}' }),
    taskMissed: t('notify.taskMissed', { where: '{where}' }),
    taskMissedBody: t('notify.taskMissedBody'),
    taskReady: t('notify.taskReady', { where: '{where}' }),
    taskReadyBody: t('notify.taskReadyBody'),
    taskNeedsYou: t('notify.taskNeedsYou', { where: '{where}' }),
    taskNeedsYouBody: t('notify.taskNeedsYouBody'),
    taskReview: t('notify.taskReview', { where: '{where}' }),
    taskReviewUnavailable: t('notify.taskReviewUnavailable'),
    taskFailed: t('notify.taskFailed', { where: '{where}' }),
    taskFailedBody: t('notify.taskFailedBody'),
    taskMerged: t('notify.taskMerged', { where: '{where}' }),
    taskMergedBody: t('notify.taskMergedBody', { branch: '{branch}' }),
    taskDone: t('notify.taskDone', { where: '{where}' }),
    taskQueued: t('notify.taskQueued', { where: '{where}' }),
    taskQueuedBody: t('notify.taskQueuedBody', {
      position: '{position}',
      of: '{of}',
      active: '{active}',
      limit: '{limit}',
    }),
    taskQueuedRoomBody: t('notify.taskQueuedRoomBody', {
      position: '{position}',
      of: '{of}',
      what: '{what}',
    }),
    taskWaitsBody: t('notify.taskWaitsBody', { ids: '{ids}' }),
    taskWaitsStoppedBody: t('notify.taskWaitsStoppedBody', { ids: '{ids}' }),
    taskRoomWords: {
      memory: t('board.room.memory'),
      swap: t('board.room.swap'),
      cpu: t('board.room.cpu'),
    },
    taskStarted: t('notify.taskStarted', { where: '{where}' }),
    taskStartedBody: t('notify.taskStartedBody'),
    taskAgentChanged: t('notify.taskAgentChanged', { where: '{where}' }),
    taskAgentChangedBody: t('notify.taskAgentChangedBody', { from: '{from}', to: '{to}' }),
    taskBudget: t('notify.taskBudget', { where: '{where}' }),
    taskBudgetBody: t('notify.taskBudgetBody', { pct: '{pct}' }),
    taskStalled: t('notify.taskStalled', { where: '{where}' }),
    taskStalledBody: t('notify.taskStalledBody'),
    taskStalledEscalatedBody: t('notify.taskStalledEscalatedBody'),
    taskLooping: t('notify.taskLooping', { where: '{where}' }),
    taskLoopingBody: t('notify.taskLoopingBody'),
    taskPaused: t('notify.taskPaused', { where: '{where}' }),
    taskPausedBody: t('notify.taskPausedBody', { time: '{time}' }),
    taskConfirm: t('notify.taskConfirm', { where: '{where}' }),
    taskConfirmBody: t('notify.taskConfirmBody'),
    // A kind without words in this app ('revert' did, 2026-10-20) reads as the generic body,
    // never as its key.
    taskConfirmKinds: Object.fromEntries(
      CONFIRMATION_KINDS.map((kind) => {
        const key = `notify.taskConfirmKind.${kind}` as MessageKey;
        const text = t(key);
        return [kind, text && text !== key ? text : t('notify.taskConfirmBody')];
      })
    ),
    taskGaveUp: t('notify.taskGaveUp', { n: '{n}' }),
    taskAutoApproved: t('notify.taskAutoApproved', { where: '{where}' }),
    taskAutoApprovedFailed: t('notify.taskAutoApprovedFailed', { where: '{where}' }),
    taskAutoApproveMerge: t('notify.taskAutoApproveMerge', {
      time: '{time}',
      headline: '{headline}',
    }),
    taskAutoMerge: t('notify.taskAutoMerge', { time: '{time}', headline: '{headline}' }),
    taskRiskAutoMerge: t('notify.taskRiskAutoMerge', {
      time: '{time}',
      headline: '{headline}',
      files: '{files}',
    }),
    taskRiskRejected: t('notify.taskRiskRejected', { reason: '{reason}' }),
    taskRiskReviewUnavailable: t('notify.taskRiskReviewUnavailable'),
    taskReadyPaused: t('notify.taskReadyPaused'),
    taskBaseWait: t('notify.taskBaseWait', { where: '{where}' }),
    taskBaseWaitBody: t('notify.taskBaseWaitBody', { base: '{base}', hours: '{hours}' }),
    undoName: t('board.undoName', { name: '{name}' }),
    projectPaused: t('notify.projectPaused', { where: '{where}' }),
    projectPausedBody: t('notify.projectPausedBody', { reason: '{reason}' }),
    projectPausedBodyGeneric: t('notify.projectPausedBodyGeneric'),
    securityNotice: t('notify.securityNotice', { where: '{where}' }),
    tmuxOldPermission: t('notify.tmuxOldPermission'),
    tmuxOldPermissionBody: t('notify.tmuxOldPermissionBody', { old: '{old}' }),
    appUpdated: t('notify.appUpdated', { commit: '{commit}' }),
    appUpdateFailed: t('notify.appUpdateFailed'),
    appUpdateWaiting: t('notify.appUpdateWaiting'),
    appUpdateReasons: {
      build: t('notify.appUpdateReason.build'),
      signing: t('notify.appUpdateReason.signing'),
      keychain: t('notify.appUpdateReason.keychain'),
      signature: t('notify.appUpdateReason.signature'),
      signer: t('notify.appUpdateReason.signer'),
      permission: t('notify.appUpdateReason.permission'),
      'app-did-not-quit': t('notify.appUpdateReason.app-did-not-quit'),
      'no-answer': t('notify.appUpdateReason.no-answer'),
      broken: t('notify.appUpdateReason.broken'),
      'helper-lost': t('notify.appUpdateReason.helper-lost'),
      other: t('notify.appUpdateReason.other'),
    },
    projectPausedReasons: {
      reverts: t('board.pauseReason.reverts', { n: '{n}' }),
      failures: t('board.pauseReason.failures', { n: '{n}' }),
    },
    taskBlockers: Object.fromEntries(
      TASK_BLOCKER_KINDS.map((kind) => [kind, t(`notify.taskBlocker.${kind}` as MessageKey)])
    ),
    replied: t('notify.replied', { where: '{where}' }),
    repliedBody: t('notify.repliedBody'),
    fallbackBody: t('notify.fallbackBody'),
    reasons: Object.fromEntries(
      Object.entries(CLAUDE_WAITING_KEYS).map(([reason, key]) => [reason, t(key)])
    ),
  };
}

async function store(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const html = renderOfflinePage({
    lang: getLocale(),
    dir: isRtlLocale() ? 'rtl' : 'ltr',
    title: t('pwa.offlineTitle'),
    body: t('pwa.offlineBody'),
    retrying: t('pwa.offlineRetrying'),
    retryNow: t('pwa.offlineRetryNow'),
  });
  const cache = await caches.open(OFFLINE_CACHE);
  await cache.put(
    OFFLINE_PAGE_URL,
    new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  );
  // Claude notifications in the same language (see sw-notify-i18n.ts).
  const strings = buildNotifyStrings();
  await cache.put(
    NOTIFY_STRINGS_URL,
    new Response(JSON.stringify(strings), { headers: { 'Content-Type': 'application/json' } })
  );
}

let listening = false;

export function installOfflinePage(): void {
  const run = () => store().catch((error) => logger.debug('offline page not stored:', error));
  run();
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener(LOCALE_CHANGED_EVENT, run);
  }
}

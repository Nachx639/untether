/**
 * "Share with phone" on the phone (shared/mac-share.ts): the server calls, the texts of its
 * errors and reasons, and whether the explainer was shown for an app on this device.
 *
 * The phone only ever sends a Mac session id, a flag and the plan's token: never a path, pid,
 * command or flag.
 */
import type { MacAgentSession } from '../../shared/mac-sessions.js';
import {
  MAC_SHARE_EVENT,
  MAC_SHARE_UNLOCK_WAIT_MIN,
  type MacShareApp,
  type MacShareErrorCode,
  type MacShareFailReason,
  type MacShareJob,
  type MacSharePlan,
  type MacShareSheetDetail,
} from '../../shared/mac-share.js';
import { t } from '../i18n/index.js';
import { MAC_AGENT_NAMES, macAppName, macItemTitle } from './mac-sessions.js';

type AuthHeader = Record<string, string>;

/** An error answer of the share API, or a request that failed (`failed`). */
export class MacShareApiError extends Error {
  constructor(
    readonly code: MacShareErrorCode | 'failed',
    readonly status: number,
    /** unsupported-shell: the tab's shell. */
    readonly shell?: string
  ) {
    super(code);
    this.name = 'MacShareApiError';
  }
}

const CODES: ReadonlySet<string> = new Set<MacShareErrorCode>([
  'bad-id',
  'bad-token',
  'gone',
  'disabled',
  'no-auth',
  'not-shareable',
  'agent-not-supported',
  'unsupported-app',
  'unsupported-shell',
  'not-shell-job',
  'busy',
  'waiting',
  'background-work',
  'draft',
  'no-conversation',
  'cwd-missing',
  'unsafe-value',
  'in-progress',
  'locked',
  'tab-not-found',
  'tab-ambiguous',
  'unresponsive',
  'automation-ask',
  'automation-denied',
  'automation-pending',
  'plan-expired',
  'plan-changed',
]);

async function call<T>(url: string, init: RequestInit, authHeader: AuthHeader): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeader },
    });
  } catch {
    throw new MacShareApiError('failed', 0);
  }
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    shell?: unknown;
  } | null;
  if (!response.ok) {
    const code =
      typeof body?.error === 'string' && CODES.has(body.error)
        ? (body.error as MacShareErrorCode)
        : 'failed';
    const shell =
      typeof body?.shell === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(body.shell)
        ? body.shell
        : undefined;
    throw new MacShareApiError(code, response.status, shell);
  }
  return body as T;
}

/** Checks everything and probes the tab; nothing is changed. */
export function planMacShare(
  id: string,
  options: { allowPrompt: boolean },
  authHeader: AuthHeader
): Promise<MacSharePlan> {
  return call<MacSharePlan>(
    `/api/mac-sessions/${encodeURIComponent(id)}/share/plan`,
    { method: 'POST', body: JSON.stringify({ allowPrompt: options.allowPrompt }) },
    authHeader
  );
}

/** Starts the plan's job: from here it runs on the server, whatever the phone does. */
export async function startMacShare(
  id: string,
  token: string,
  authHeader: AuthHeader
): Promise<string> {
  const body = await call<{ jobId?: unknown }>(
    `/api/mac-sessions/${encodeURIComponent(id)}/share`,
    { method: 'POST', body: JSON.stringify({ token }) },
    authHeader
  );
  if (typeof body?.jobId !== 'string') throw new MacShareApiError('failed', 202);
  return body.jobId;
}

/** Where a job is now. */
export function fetchMacShareJob(jobId: string, authHeader: AuthHeader): Promise<MacShareJob> {
  return call<MacShareJob>(
    `/api/mac-sessions/share/${encodeURIComponent(jobId)}`,
    { method: 'GET' },
    authHeader
  );
}

/** A job that will not change any more. */
export function isMacShareJobFinal(job: Pick<MacShareJob, 'state'>): boolean {
  return (
    job.state === 'shared' ||
    job.state === 'aborted' ||
    job.state === 'still-running' ||
    job.state === 'failed-after-close'
  );
}

/**
 * Names as the texts use them: product and app names are never translated. `window` is the app
 * of a new window (a locked Mac), which may differ from the agent's own app.
 */
export type MacShareNames = { agent: string; app: string; window: string };

export function macShareNames(
  detail: Pick<MacShareSheetDetail, 'agent' | 'app'>,
  windowApp?: MacShareApp
): MacShareNames {
  return {
    agent: MAC_AGENT_NAMES[detail.agent] ?? detail.agent,
    app: macAppName(detail.app),
    window: macAppName(windowApp ?? 'Terminal'),
  };
}

/** The text of an error before anything changed (or of a refused start). */
export function macShareErrorText(
  code: MacShareErrorCode | 'failed',
  names: MacShareNames,
  shell?: string
): string {
  switch (code) {
    case 'locked':
      return t('macShare.error.locked');
    case 'busy':
      return t('macShare.error.busy', names);
    case 'waiting':
      return t('macShare.error.waiting', names);
    case 'background-work':
      return t('macShare.error.backgroundWork', names);
    case 'draft':
      return t('macShare.error.draft', names);
    case 'no-conversation':
      return t('macShare.error.noConversation');
    case 'cwd-missing':
      return t('macShare.error.cwdMissing');
    case 'tab-not-found':
      return t('macShare.error.tabNotFound', names);
    case 'tab-ambiguous':
      return t('macShare.error.tabAmbiguous', names);
    case 'unresponsive':
      return t('macShare.error.unresponsive', names);
    case 'automation-denied':
      return t('macShare.error.automationDenied', names);
    case 'automation-ask':
    case 'automation-pending':
      return t('macShare.error.automationPending');
    case 'unsupported-app':
      return t('macShare.error.unsupportedApp');
    case 'unsupported-shell':
      return shell
        ? t('macShare.error.unsupportedShell', { shell })
        : t('macShare.error.notShellJob');
    case 'not-shell-job':
      return t('macShare.error.notShellJob');
    case 'agent-not-supported':
      return t('macShare.error.agentNotSupported', names);
    case 'not-shareable':
      return t('macShare.error.notShareable');
    case 'unsafe-value':
      return t('macShare.error.unsafeValue');
    case 'in-progress':
      return t('macShare.error.inProgress');
    case 'plan-expired':
    case 'bad-token':
      return t('macShare.error.planExpired');
    case 'plan-changed':
      return t('macShare.error.planChanged');
    case 'disabled':
      return t('macShare.error.disabled');
    case 'no-auth':
      return t('macShare.error.noAuth');
    case 'gone':
    case 'bad-id':
      return t('macSessions.error.gone');
    default:
      return t('macShare.error.failed', { error: code });
  }
}

/** Why it didn't reopen after the close, as `{reason}` of macShare.failed.title. */
export function macShareReasonText(
  reason: MacShareFailReason | undefined,
  names: MacShareNames,
  seconds?: number
): string {
  switch (reason) {
    case 'refused':
      return t('macShare.reason.refused', names);
    case 'timeout':
      return t('macShare.reason.timeout', { seconds: seconds ?? 0 });
    case 'exited':
      return t('macShare.reason.exited');
    case 'not-shared':
      return t('macShare.reason.notShared');
    case 'other-instance':
      return t('macShare.reason.otherInstance');
    case 'transcript':
      return t('macShare.reason.transcript');
    case 'locked':
      return t('macShare.reason.locked', { minutes: MAC_SHARE_UNLOCK_WAIT_MIN });
    case 'tab-gone':
      return t('macShare.reason.tabGone');
    case 'shell-busy':
      return t('macShare.reason.shellBusy');
    case 'denied':
      return t('macShare.reason.denied', names);
    case 'already-open':
      return t('macShare.reason.alreadyOpen');
    case 'unresponsive':
      return t('macShare.reason.unresponsive', names);
    case 'window-failed':
      return t('macShare.reason.windowFailed', names);
    default:
      return t('macShare.reason.unconfirmed');
  }
}

/** The step a running job is at, in words. */
export function macShareStepText(job: Pick<MacShareJob, 'step'>, names: MacShareNames): string {
  switch (job.step) {
    case 'closing':
      return t('macShare.step.closing');
    case 'closed':
      return t('macShare.step.saved');
    case 'waiting-unlock':
      return t('macShare.step.unlock');
    case 'typing':
      return t('macShare.step.reopening');
    case 'opening':
      return t('macShare.step.opening', names);
    case 'starting':
      return t('macShare.step.starting', names);
    case 'trust':
      return t('macShare.step.trusting');
    default:
      return t('macShare.step.checking');
  }
}

const ASKED_KEY = 'ut-mac-share-asked-';

/** Whether this device showed the explainer for `app` (then the plan may make macOS ask). */
export function macShareExplained(app: MacShareApp): boolean {
  try {
    return localStorage.getItem(`${ASKED_KEY}${app}`) === '1';
  } catch {
    return false;
  }
}

export function rememberMacShareExplained(app: MacShareApp): void {
  try {
    localStorage.setItem(`${ASKED_KEY}${app}`, '1');
  } catch {
    // Private mode: the explainer shows again next time.
  }
}

/** The sheet's detail for an agent row that offers the action, else null. */
export function macShareDetail(item: MacAgentSession): MacShareSheetDetail | null {
  const share = item.share;
  if (!share || (item.app !== 'Terminal' && item.app !== 'iTerm')) return null;
  return {
    id: item.id,
    agent: item.agent,
    app: item.app,
    title: macItemTitle(item),
    ...(share.jobId ? { jobId: share.jobId } : {}),
  };
}

/** Asks the app to open the share sheet (app.ts listens on window). */
export function openMacShare(detail: MacShareSheetDetail): void {
  window.dispatchEvent(new CustomEvent(MAC_SHARE_EVENT, { detail }));
}

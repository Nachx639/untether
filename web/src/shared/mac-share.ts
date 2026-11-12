/**
 * Share with phone: an idle Claude Code (Codex later) running in a plain Terminal.app or iTerm2
 * tab, outside tmux and outside `ut`, is closed there with one SIGTERM and reopened in the same
 * tab through ut with `--resume <its id>`, so the same conversation runs on the Mac and on the
 * phone. While the Mac is locked it reopens in a new Terminal window instead (`new-window`),
 * without AppleScript, and the old tab is left at its shell prompt. These are the types of its
 * API, shared by the server and the client:
 *
 * - POST /api/mac-sessions/:id/share/plan → MacSharePlan (nothing is changed yet)
 * - POST /api/mac-sessions/:id/share {token} → 202 {jobId}
 * - GET  /api/mac-sessions/share/:jobId → MacShareJob
 *
 * A client only ever sends a Mac session id (`a-<pid>-<start>`) and the plan's token: never a
 * path, pid, tty, flag, command or script.
 */
import type { MacAgentKind } from './mac-sessions.js';

/** A Claude conversation id or a Codex thread id: what is typed after `--resume`. */
export const MAC_SHARE_CONVERSATION_ID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** Plan tokens and job ids: 128 random bits in base64url. */
export const MAC_SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
export const MAC_SHARE_JOB_ID_RE = MAC_SHARE_TOKEN_RE;

export function isMacShareConversationId(value: unknown): value is string {
  return typeof value === 'string' && MAC_SHARE_CONVERSATION_ID_RE.test(value);
}

export function isMacShareToken(value: unknown): value is string {
  return typeof value === 'string' && MAC_SHARE_TOKEN_RE.test(value);
}

export function isMacShareJobId(value: unknown): value is string {
  return typeof value === 'string' && MAC_SHARE_JOB_ID_RE.test(value);
}

// Characters that render as nothing or reorder text: shown escaped so the command on screen
// can't look different from what is typed (they are typed unchanged).
const INVISIBLE_CHARS =
  /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** A plan's command as the phone shows it: bidi controls and invisible characters escaped. */
export function macShareDisplayCommand(command: string): string {
  return command.replace(INVISIBLE_CHARS, (char) => {
    const hex = (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    return `\\u{${hex}}`;
  });
}

/** The terminal apps whose tabs can be scripted: Mac Sessions' host-app names. */
export type MacShareApp = 'Terminal' | 'iTerm';
export const MAC_SHARE_APPS: readonly MacShareApp[] = ['Terminal', 'iTerm'];

/**
 * What is typed to reopen it. ut: `ut <agent> …` (works without any wrapper). shell: the
 * agent's own command after reloading the shell's startup file, for a shell function that
 * already wraps the agent with ut.
 */
export type MacShareLauncher = 'ut' | 'shell';

/** The shells whose tab can take the relaunch line. */
export type MacShareShell = 'zsh' | 'bash' | 'fish';

/** Why the feature is off for this server (GET /api/mac-sessions `share.reason`). */
export type MacShareOffReason = 'disabled' | 'mac-sessions-off' | 'unsupported' | 'hq' | 'no-auth';

/** Whether an agent row offers the action (MacAgentSession.share). Cheap: no AppleScript. */
export interface MacShareAvailability {
  can: boolean;
  reason?: 'busy' | 'waiting' | 'unsupported-app' | 'in-tmux' | 'agent-off' | 'in-progress';
  /** A share of this agent is running: the row reopens its progress. */
  jobId?: string;
}

/** GET /api/mac-sessions `share`. */
export interface MacShareStatus {
  enabled: boolean;
  reason?: MacShareOffReason;
}

/** Notes for the confirm sheet besides the dropped flags. */
export type MacShareWarning =
  /** Some options weren't carried over (listed in `dropped`). */
  | 'flags-dropped'
  /** Some of them take free text, which `ps` can't give back exactly. */
  | 'argv-inexact';

/**
 * same-tab: the line is typed into the agent's own tab (AppleScript, Mac unlocked).
 * new-window: the Mac is locked, so it reopens in a new window of `windowApp` through
 * LaunchServices; nothing reads or types into the old tab, which stays at its shell prompt.
 */
export type MacShareMode = 'same-tab' | 'new-window';

export interface MacSharePlan {
  /** Single use, valid until expiresAt, bound to this exact plan. */
  token: string;
  expiresAt: string;
  agent: MacAgentKind;
  app: MacShareApp;
  tty: string;
  cwd: string;
  conversationId: string;
  title?: string;
  mode: MacShareMode;
  /** new-window: the app whose new window it reopens in. */
  windowApp?: MacShareApp;
  /** Exactly what will be typed into the tab, or run in the new window. */
  command: string;
  /** Option names carried over, and the ones that are not. */
  kept: string[];
  dropped: string[];
  /** It was started with a message (a positional prompt), which is not typed again. */
  droppedPrompt?: boolean;
  warnings: MacShareWarning[];
}

/** POST /api/mac-sessions/:id/share/plan */
export interface MacSharePlanRequest {
  /** The phone showed the explainer: running osascript may make macOS ask on the Mac. */
  allowPrompt?: boolean;
}

/** POST /api/mac-sessions/:id/share */
export interface MacShareStartRequest {
  token: string;
}

export interface MacShareStartResponse {
  jobId: string;
}

/** Where a running job is, in order. Bracketed ones only happen when needed. */
export type MacShareStep =
  | 'checking'
  | 'probing'
  | 'closing'
  | 'closed'
  | 'waiting-unlock'
  | 'typing'
  /** new-window: the new window is being opened. */
  | 'opening'
  | 'starting'
  | 'trust';

/**
 * running: still going. shared: it reopened here (sessionId). aborted: nothing was changed
 * (error). still-running: SIGTERM was sent and it didn't exit; nothing else was done.
 * failed-after-close: closed and saved but not reopened (reason, resumeCommand).
 * relaunch-unknown: the typing wasn't confirmed; it may still start, and the job keeps
 * watching (resumeCommand).
 */
export type MacShareJobState =
  | 'running'
  | 'shared'
  | 'aborted'
  | 'still-running'
  | 'failed-after-close'
  | 'relaunch-unknown';

/** Errors of the plan and of a job before anything was closed. */
export type MacShareErrorCode =
  | 'bad-id'
  | 'bad-token'
  | 'gone'
  | 'disabled'
  | 'no-auth'
  | 'not-shareable'
  | 'agent-not-supported'
  | 'unsupported-app'
  | 'unsupported-shell'
  | 'not-shell-job'
  | 'busy'
  | 'waiting'
  | 'background-work'
  | 'draft'
  | 'no-conversation'
  | 'cwd-missing'
  | 'unsafe-value'
  | 'in-progress'
  | 'locked'
  | 'tab-not-found'
  | 'tab-ambiguous'
  | 'unresponsive'
  /** The phone hasn't shown the explainer for this app yet: nothing was run. */
  | 'automation-ask'
  | 'automation-denied'
  | 'automation-pending'
  | 'plan-expired'
  | 'plan-changed';

/** Why it didn't reopen after it was closed. */
export type MacShareFailReason =
  /** The app answered with an error to the typing. */
  | 'refused'
  /** Nothing started within macShareStartTimeoutSec. */
  | 'timeout'
  /** It started and closed again. */
  | 'exited'
  /** It reopened on the Mac but not through ut, so not here. */
  | 'not-shared'
  /** It reopened through another Untether instance. */
  | 'other-instance'
  /** The conversation file looked incomplete after the close: nothing was typed. */
  | 'transcript'
  /** The Mac stayed locked for MAC_SHARE_UNLOCK_WAIT_MIN minutes. */
  | 'locked'
  | 'tab-gone'
  | 'shell-busy'
  | 'denied'
  | 'unresponsive'
  /** It was live somewhere else again before typing, so nothing was typed. */
  | 'already-open'
  /** The typing was never confirmed and it never showed up. */
  | 'unconfirmed'
  /** new-window: the app didn't take the file, so nothing was opened. */
  | 'window-failed';

export interface MacShareJob {
  id: string;
  state: MacShareJobState;
  step: MacShareStep;
  /** The agent was closed on the Mac: from here on, resumeCommand is set. */
  closed: boolean;
  agent: MacAgentKind;
  app: MacShareApp;
  /** How it reopens; a same-tab job turns new-window when the Mac locks before the typing. */
  mode: MacShareMode;
  /** new-window: the app whose new window it reopens in. */
  windowApp?: MacShareApp;
  /** shared: the fwd_ session to open. */
  sessionId?: string;
  /** shared, with a dialog the user answers here. */
  needs?: 'trust' | 'answer';
  /** aborted */
  error?: MacShareErrorCode;
  /** failed-after-close */
  reason?: MacShareFailReason;
  /** What to type in that tab to continue by hand. */
  resumeCommand?: string;
  /** With reason 'timeout': the limit that passed. */
  seconds?: number;
  updatedAt: string;
}

/** Body of every error answer of the share API. */
export interface MacShareErrorBody {
  error: MacShareErrorCode;
  /** unsupported-shell: the tab's shell ("tcsh"). */
  shell?: string;
}

/** A plan's token lives this long. */
export const MAC_SHARE_PLAN_TTL_MS = 120_000;
/**
 * After the close, a locked Mac is waited for this long, then the command is shown. Only when
 * a new window can't be opened (a shell with no known path).
 */
export const MAC_SHARE_UNLOCK_WAIT_MIN = 15;
/** Default of macShareStartTimeoutSec. */
export const MAC_SHARE_START_TIMEOUT_SEC = 30;

/** Open the share sheet for an agent row (detail: MacShareSheetDetail). */
export const MAC_SHARE_EVENT = 'ut-open-mac-share';

export interface MacShareSheetDetail {
  id: string;
  agent: MacAgentKind;
  app: MacShareApp;
  title?: string;
  /** Reopen the progress of a running job instead of planning. */
  jobId?: string;
}

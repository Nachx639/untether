/**
 * "On this Mac" on the phone (shared/mac-sessions.ts): the tmux sessions on the user's own tmux
 * servers and the agents running outside Untether, asked from GET /api/mac-sessions, opening
 * a tmux session from there, and the words their rows and section show.
 *
 * Mac items never join the Untether session list: unread counts, pins, Kill all and broadcast
 * all assume Untether ids. Sessions started with ut in a terminal window are Untether
 * sessions (`macWindow`), shown in the same section with their normal row.
 */
import { isForwardedSession } from '../../shared/forwarded-session.js';
import {
  MAC_SESSION_VIEW_EVENT,
  MAC_SESSIONS_CHANGED_EVENT,
  type MacAgent,
  type MacAgentKind,
  type MacOpenRequest,
  type MacOpenResponse,
  type MacSessionItem,
  type MacSessionsErrorCode,
  type MacSessionsResponse,
  type MacSessionsWarning,
  type MacSessionViewDetail,
  type MacTmuxPaneAgent,
  TMUX_MIN_OPEN_VERSION,
} from '../../shared/mac-sessions.js';
import type { Session } from '../../shared/types.js';
import { type MessageKey, t } from '../i18n/index.js';
import { formatActivity, isBackgroundWait } from './claude-activity.js';
import { claudeWaitingLabel } from './claude-waiting-label.js';
import { formatPathForDisplay } from './path-utils.js';

type AuthHeader = Record<string, string>;

/** Product names, never translated. */
export const MAC_AGENT_NAMES: Record<MacAgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
};

// ---- the server's platform -----------------------------------------------------------------

const PLATFORM_KEY = 'ut-mac-sessions-platform';

function readStoredPlatform(): string | null {
  try {
    return localStorage.getItem(PLATFORM_KEY);
  } catch {
    return null;
  }
}

let knownPlatform: string | null = readStoredPlatform();

/**
 * The server's platform ("darwin", "linux"…) from its last Mac sessions answer, kept per device
 * so labels are right before the first answer of a later visit; null until one arrived.
 */
export function macSessionsPlatform(): string | null {
  return knownPlatform;
}

export function rememberMacSessionsPlatform(platform: string): void {
  if (!platform || platform === knownPlatform) return;
  knownPlatform = platform;
  try {
    localStorage.setItem(PLATFORM_KEY, platform);
  } catch {
    // Blocked storage: known for this visit only.
  }
}

/** "Mac" wording only for a server known to run on macOS; "this computer" otherwise. */
export function isMacPlatform(platform: string | null | undefined): boolean {
  return platform === 'darwin';
}

/** The section's heading: "On this Mac", or "On this computer" off macOS. */
export function macSessionsHeading(platform = macSessionsPlatform()): string {
  return t(isMacPlatform(platform) ? 'macSessions.heading.mac' : 'macSessions.heading.computer');
}

// ---- Untether sessions that belong to the Mac -----------------------------------------------

/** A host app as shown: the server says "SSH" for an SSH login. */
export function macAppName(app: string): string {
  return /^ssh$/i.test(app) ? t('macSessions.where.ssh') : app;
}

/** Opened with ut in a terminal window on the computer (the server sets `macWindow`). */
export function isMacWindowSession(session: Pick<Session, 'macWindow'>): boolean {
  return Boolean(session.macWindow);
}

/** "On the Mac · Terminal", "On the Mac" when the app is unknown; "On this computer…" off macOS. */
export function macWindowLabel(
  macWindow: { app: string | null },
  platform = macSessionsPlatform()
): string {
  const app = macWindow.app ? macAppName(macWindow.app) : '';
  if (isMacPlatform(platform)) {
    return app ? t('macSessions.window.onMacApp', { app }) : t('macSessions.window.onMac');
  }
  return app ? t('macSessions.window.onComputerApp', { app }) : t('macSessions.window.onComputer');
}

/** What the 🖥 marker of such a session says (spoken, and as its tooltip). */
export function macWindowMarkerLabel(platform = macSessionsPlatform()): string {
  return t(
    isMacPlatform(platform) ? 'macSessions.window.marker.mac' : 'macSessions.window.marker.computer'
  );
}

/**
 * What a kill confirmation adds for a session opened with ut in a terminal window: killing it
 * ends its program there too, under the user's eyes on the Mac. Empty for any other session.
 */
export function macWindowKillNote(
  session: Pick<Session, 'id'>,
  platform = macSessionsPlatform()
): string {
  if (!isForwardedSession(session)) return '';
  return t(
    isMacPlatform(platform)
      ? 'macSessions.window.killNote.mac'
      : 'macSessions.window.killNote.computer'
  );
}

/**
 * A session whose program is a tmux client of a tmux session outside Untether: opened from
 * "On this Mac" (`multiplexer`) or from the tmux sessions modal (named "tmux: …", like the
 * server's isTmuxAttachment). Ending it disconnects; the tmux session keeps running.
 */
export function isAttachedTmuxSession(session: Pick<Session, 'multiplexer' | 'name'>): boolean {
  return Boolean(session.multiplexer) || (session.name ?? '').startsWith('tmux:');
}

// ---- rows ------------------------------------------------------------------------------------

export type MacRowState = 'waiting' | 'working' | 'idle' | 'shell';

/** The agent a row is about: a tmux session's primary agent (the server puts it first). */
export function macPrimaryAgent(item: MacSessionItem): MacAgent | undefined {
  return item.kind === 'agent' ? item : item.agents[0];
}

export function macItemHasAgents(item: MacSessionItem): boolean {
  return item.kind === 'agent' || item.agents.length > 0;
}

export function macItemState(item: MacSessionItem): MacRowState {
  const agent = macPrimaryAgent(item);
  if (!agent) return 'shell';
  const status = agent.status?.status;
  if (status === 'waiting') return 'waiting';
  // Busy only for background agents: the reply is over, the row rests like an idle one.
  if (status === 'busy') return isBackgroundWait(agent.status) ? 'idle' : 'working';
  return 'idle';
}

export function macAgentTitle(agent: MacAgent): string | undefined {
  return agent.status?.title || agent.title || undefined;
}

function folderName(path: string | undefined): string {
  return path?.split('/').filter(Boolean).pop() ?? '';
}

/**
 * tmux: the primary agent's title, else the pane's title, else the session's name. An agent:
 * its title, else its folder's name, else its own name.
 */
export function macItemTitle(item: MacSessionItem): string {
  if (item.kind === 'tmux') {
    const agent = item.agents[0];
    return (agent && macAgentTitle(agent)) || item.current.title || item.name;
  }
  return macAgentTitle(item) || folderName(item.cwd) || MAC_AGENT_NAMES[item.agent] || item.agent;
}

/** "tmux · work", "tmux (other) · work", or an agent's app ("Terminal", "Other terminal"…). */
export function macItemWhere(item: MacSessionItem): string {
  if (item.kind === 'tmux') {
    return item.server.isDefault || !item.server.label
      ? t('macSessions.where.tmux', { name: item.name })
      : t('macSessions.where.tmuxServer', { server: item.server.label, name: item.name });
  }
  // In a pane of a tmux server that can't be listed: tmux is all that is known.
  if (item.inTmux) return 'tmux';
  return item.app ? macAppName(item.app) : t('macSessions.where.otherTerminal');
}

/** "Also open in Terminal": the apps of the tmux session's other clients. */
export function macAlsoOpenInText(item: MacSessionItem): string {
  if (item.kind !== 'tmux' || !item.alsoOpenIn.length) return '';
  const apps = [...new Set(item.alsoOpenIn.map(macAppName))];
  return t('macSessions.badge.alsoOpenIn', { app: apps.join(', ') });
}

/** "In Untether" or "Watching" for a tmux session open here, "Read-only" for an agent. */
export function macItemBadge(item: MacSessionItem): string {
  if (item.kind === 'agent') return t('macSessions.badge.readOnly');
  if (!item.utSessionId) return '';
  return t(item.utMode === 'watch' ? 'macSessions.badge.watching' : 'macSessions.badge.inUntether');
}

/** "Needs you · permission", "Running: pnpm test", "Working", or the last message. */
export function macAgentStatusText(agent: MacAgent): string {
  const status = agent.status;
  if (status?.status === 'waiting') {
    return [t('sessions.row.needsYou'), claudeWaitingLabel(status.waitingFor)]
      .filter(Boolean)
      .join(' · ');
  }
  const preview = status?.preview;
  const previewText = preview
    ? `${preview.role === 'user' ? t('sessions.row.you') : ''}${preview.text}`
    : '';
  if (isBackgroundWait(status)) {
    return [t('activity.backgroundWait'), previewText].filter(Boolean).join(' · ');
  }
  if (status?.status === 'busy') {
    return status.activity ? formatActivity(status.activity) : t('sessions.row.working');
  }
  return previewText;
}

/** "Claude in window 2": the primary agent isn't in the window an opened client shows. */
export function macAgentWindowText(item: MacSessionItem): string {
  const agent = item.kind === 'tmux' ? item.agents[0] : undefined;
  if (!agent || agent.inCurrentWindow) return '';
  return t('macSessions.agentInWindow', {
    agent: MAC_AGENT_NAMES[agent.agent],
    index: agent.windowIndex,
  });
}

/** A row's status line as text: its agent's status, else the pane's program and folder. */
export function macItemStatusText(item: MacSessionItem): string {
  const agent = macPrimaryAgent(item);
  if (agent) {
    return [macAgentWindowText(item), macAgentStatusText(agent)].filter(Boolean).join(' · ');
  }
  if (item.kind !== 'tmux') return '';
  const { command, cwd } = item.current;
  return [command, cwd && formatPathForDisplay(cwd)].filter(Boolean).join(' · ');
}

/** "+2 more": the tmux session's other agents. */
export function macMoreAgentsText(item: MacSessionItem): string {
  const n = item.kind === 'tmux' ? item.agents.length - 1 : 0;
  return n > 0 ? t('macSessions.moreAgents', { n }) : '';
}

/** When the row's status began, else the tmux session's last activity or the agent's start. */
export function macItemTime(item: MacSessionItem): string | undefined {
  const since = macPrimaryAgent(item)?.status?.since;
  if (since) return new Date(since).toISOString();
  return item.kind === 'tmux' ? item.activityAt || item.createdAt : item.startedAt;
}

/** What a screen reader says for the whole row: "{title}, {where}, {status}". */
export function macRowLabel(item: MacSessionItem, time = ''): string {
  const where = [
    macItemWhere(item),
    item.kind === 'tmux'
      ? t('tmux.windows', { n: item.windows })
      : item.cwd && formatPathForDisplay(item.cwd),
    macAlsoOpenInText(item),
    macItemBadge(item),
  ]
    .filter(Boolean)
    .join(' · ');
  const status = [macItemStatusText(item), macMoreAgentsText(item), time]
    .filter(Boolean)
    .join(' · ');
  const label = t('macSessions.row.label', { title: macItemTitle(item), where, status });
  // Without a status the template would end in its separator.
  return status ? label : label.replace(/[\s,،，、]+$/u, '');
}

/** The search box: title, tmux name, folder, app and agent. */
export function matchesMacQuery(item: MacSessionItem, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  const agents: MacAgent[] = item.kind === 'tmux' ? item.agents : [item];
  const folders = [
    item.kind === 'tmux' ? item.current.cwd : undefined,
    ...agents.map((a) => a.cwd),
  ];
  return [
    macItemTitle(item),
    item.kind === 'tmux' ? item.name : item.app,
    ...(item.kind === 'tmux' ? item.alsoOpenIn : []),
    ...agents.flatMap((agent) => [MAC_AGENT_NAMES[agent.agent], macAgentTitle(agent)]),
    // As stored and as shown ("~/Projects").
    ...folders.flatMap((folder) => (folder ? [folder, formatPathForDisplay(folder)] : [])),
  ].some((field) => field?.toLowerCase().includes(query));
}

const WARNING_KEYS: Record<MacSessionsWarning['code'], MessageKey> = {
  'tmux-unavailable': 'macSessions.warning.tmuxUnavailable',
  'tmux-socket-missing': 'macSessions.warning.socketMissing',
  'tmux-unreachable': 'macSessions.warning.unreachable',
  'scan-partial': 'macSessions.warning.partial',
  truncated: 'macSessions.warning.truncated',
};

/** One line per kind of warning, in the order they came. */
export function macWarningTexts(warnings: readonly MacSessionsWarning[]): string[] {
  const texts = warnings.map((warning) =>
    t(WARNING_KEYS[warning.code] ?? 'macSessions.warning.partial')
  );
  return [...new Set(texts)];
}

// ---- the read-only conversation sheet ----------------------------------------------------------

/** What the sheet needs for an agent row, or for one agent of a tmux row (its primary one). */
export function macSessionViewDetail(
  item: MacSessionItem,
  pane?: MacTmuxPaneAgent
): MacSessionViewDetail | null {
  if (item.kind === 'agent') {
    return {
      chatId: item.chatId,
      kind: 'agent',
      agent: item.agent,
      title: macItemTitle(item),
      app: item.app,
      cwd: item.cwd,
      ...(item.inTmux ? { inTmux: item.inTmux } : {}),
      ...(item.share ? { share: item.share } : {}),
    };
  }
  const agent = pane ?? item.agents[0];
  if (!agent) return null;
  return {
    chatId: agent.chatId,
    kind: 'pane',
    agent: agent.agent,
    title: macAgentTitle(agent),
    cwd: agent.cwd,
    tmuxId: item.id,
    tmuxName: item.name,
    windowIndex: agent.windowIndex,
  };
}

/** Asks the app to open that sheet (app.ts listens on window). */
export function showMacConversation(detail: MacSessionViewDetail): void {
  window.dispatchEvent(new CustomEvent(MAC_SESSION_VIEW_EVENT, { detail }));
}

// ---- server calls ----------------------------------------------------------------------------

/** Something changed the list (open, disconnect, mode change, settings): load it again now. */
export function announceMacSessionsChanged(): void {
  window.dispatchEvent(new CustomEvent(MAC_SESSIONS_CHANGED_EVENT));
}

/** An error answer of the Mac sessions API (`code` from its body), or a failed request. */
export class MacSessionsApiError extends Error {
  readonly code: MacSessionsErrorCode;
  readonly status: number;
  readonly details?: string;

  constructor(code: MacSessionsErrorCode, status: number, details?: string) {
    super(details || code);
    this.name = 'MacSessionsApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const ERROR_CODES: ReadonlySet<string> = new Set<MacSessionsErrorCode>([
  'bad-id',
  'bad-request',
  'gone',
  'disabled',
  'not-openable',
  'tmux-too-old',
  'open-failed',
  'not-attached',
  'client-not-found',
  'mode-failed',
]);

/** The list. Throws when the request fails, so the caller can keep the last list it had. */
export async function fetchMacSessions(
  authHeader: AuthHeader,
  options: { force?: boolean } = {}
): Promise<MacSessionsResponse> {
  const response = await fetch(`/api/mac-sessions${options.force ? '?force=1' : ''}`, {
    headers: authHeader,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as Partial<MacSessionsResponse> | null;
  if (typeof body?.enabled !== 'boolean' || !Array.isArray(body.items)) {
    throw new Error('Unexpected answer');
  }
  if (typeof body.platform === 'string') rememberMacSessionsPlatform(body.platform);
  return {
    ...body,
    platform: body.platform ?? '',
    openMode: body.openMode === 'watch' ? 'watch' : 'control',
    items: body.items,
    warnings: Array.isArray(body.warnings) ? body.warnings : [],
  } as MacSessionsResponse;
}

/**
 * Opens a tmux session of the list in a new Untether session, or answers the one already
 * attached to it (`reused`, in its own mode). Throws a MacSessionsApiError.
 */
export async function openMacSession(
  id: string,
  request: MacOpenRequest,
  authHeader: AuthHeader
): Promise<MacOpenResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/mac-sessions/${encodeURIComponent(id)}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw new MacSessionsApiError(
      'open-failed',
      0,
      error instanceof Error ? error.message : String(error)
    );
  }
  const body = (await response.json().catch(() => ({}))) as {
    sessionId?: unknown;
    reused?: unknown;
    mode?: unknown;
    error?: unknown;
    details?: unknown;
  };
  if (!response.ok || typeof body.sessionId !== 'string' || !body.sessionId) {
    const code =
      typeof body.error === 'string' && ERROR_CODES.has(body.error)
        ? (body.error as MacSessionsErrorCode)
        : 'open-failed';
    const details =
      typeof body.details === 'string' && body.details
        ? body.details
        : response.ok
          ? undefined
          : response.statusText || `HTTP ${response.status}`;
    throw new MacSessionsApiError(code, response.status, details);
  }
  announceMacSessionsChanged();
  return {
    sessionId: body.sessionId,
    reused: body.reused === true,
    mode: body.mode === 'watch' ? 'watch' : 'control',
  };
}

/** The toast for a failed open. */
export function macOpenErrorText(error: unknown): string {
  const code = error instanceof MacSessionsApiError ? error.code : undefined;
  switch (code) {
    case 'gone':
      return t('macSessions.error.gone');
    case 'tmux-too-old':
      return t('macSessions.error.tmuxTooOld', { version: TMUX_MIN_OPEN_VERSION });
    case 'not-openable':
      return t('macSessions.error.notOpenable');
    case 'disabled':
      return t('macSessions.error.disabled');
    default:
      return t('macSessions.error.openFailed', {
        error: error instanceof Error ? error.message : String(error),
      });
  }
}

// ---- the section's collapsed state, per device ---------------------------------------------

const COLLAPSED_KEY = 'ut-mac-section-collapsed';

export function readMacSectionCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeMacSectionCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(COLLAPSED_KEY, '1');
    else localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    // Blocked storage: the section opens expanded next time.
  }
}

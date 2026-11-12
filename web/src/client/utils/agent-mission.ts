/**
 * Mission control (phone /agents view): every running Claude / Codex / Gemini session as a
 * card, the ones that need you first, and one instruction sent to several of them at once.
 * Pure logic here; the view is components/agent-mission.ts.
 */
import { parseScreenChoices } from '../../shared/claude-screen.js';
import type { Session } from '../../shared/types.js';
import { sessionTool } from '../components/phone-session-row.js';
import { isBackgroundWait } from './claude-activity.js';
import { modeSwitchBlocked } from './claude-mode.js';
import { lastActivityAt } from './last-activity.js';
import { isWatching } from './mac-attach-mode.js';

export type AgentKind = 'claude' | 'codex' | 'gemini';
export type AgentState = 'waiting' | 'working' | 'idle';

export interface AgentCard {
  session: Session;
  kind: AgentKind;
  state: AgentState;
  /**
   * Epoch ms, if known: when it began waiting, when the current step began (working), or its
   * last activity (idle, as in the Sessions list).
   */
  since?: number;
}

/** The coding agent running in a session, or null for shells and finished sessions. */
export function agentKind(session: Session): AgentKind | null {
  if (session.status !== 'running') return null;
  if (session.claudeStatus) return 'claude';
  if (session.codexActive) return 'codex';
  if (session.geminiActive) return 'gemini';
  const tool = sessionTool(session);
  return tool === 'claude' || tool === 'codex' || tool === 'gemini' ? tool : null;
}

export function agentState(session: Session): AgentState {
  const claude = session.claudeStatus?.status;
  if (claude === 'waiting') return 'waiting';
  // Busy only for background agents: the reply is over, it waits for the user like an idle one.
  if (claude === 'busy') return isBackgroundWait(session.claudeStatus) ? 'idle' : 'working';
  if (claude) return 'idle';
  // Codex's own state, from its rollout (Session.agentStatus).
  const agent = session.agentStatus?.status;
  if (agent) return agent === 'busy' ? 'working' : agent;
  // Gemini, and a Codex whose rollout says nothing yet, report no status: output in the last
  // moments means it is working.
  return session.activityStatus?.isActive ? 'working' : 'idle';
}

function stateSince(session: Session, state: AgentState): number | undefined {
  const claude = session.claudeStatus;
  // Idle: the last activity, the same moment as the session's row in the Sessions list.
  if (state === 'idle' && !isBackgroundWait(claude)) return lastActivityAt(session);
  if (claude) return (state === 'working' && claude.activity?.since) || claude.since;
  return session.agentStatus?.since;
}

const RANK: Record<AgentState, number> = { waiting: 0, working: 1, idle: 2 };

/**
 * Cards for the running agent sessions: waiting first (longest wait on top), then working,
 * then idle. Within working/idle the order follows start time, so the 1 s poll doesn't
 * shuffle cards under the finger.
 */
export function missionCards(sessions: Session[]): AgentCard[] {
  const cards: AgentCard[] = [];
  for (const session of sessions) {
    const kind = agentKind(session);
    if (!kind) continue;
    const state = agentState(session);
    cards.push({ session, kind, state, since: stateSince(session, state) });
  }
  const started = (card: AgentCard) => Date.parse(card.session.startedAt || '') || 0;
  return cards.sort(
    (a, b) =>
      RANK[a.state] - RANK[b.state] ||
      (a.state === 'waiting' ? (a.since ?? 0) - (b.since ?? 0) : 0) ||
      started(b) - started(a) ||
      a.session.id.localeCompare(b.session.id)
  );
}

/**
 * Changes whenever a card would show something new: the app updates Session objects in place,
 * which alone would not re-render the view.
 */
export function missionStamp(sessions: Session[]): string {
  return sessions
    .map((s) =>
      [
        s.id,
        s.status,
        s.lastModified,
        JSON.stringify(s.claudeStatus ?? null),
        JSON.stringify(s.agentStatus ?? null),
        s.lastLine ?? '',
        s.activityStatus?.isActive ? 1 : 0,
        s.codexActive ? 1 : 0,
        s.geminiActive ? 1 : 0,
      ].join('|')
    )
    .join(';');
}

/** Last lines of a terminal screen (trailing blank rows dropped). */
export function screenTail(text: string, lines = 30): string {
  return text.replace(/\s+$/, '').split('\n').slice(-lines).join('\n');
}

/**
 * Whether typing text into this session now could answer a dialog instead of reaching the
 * prompt: a numbered choice on screen, or (Claude) no mode line, the same check the mode
 * picker uses before pressing Shift+Tab.
 */
export function broadcastBlocked(
  card: Pick<AgentCard, 'kind' | 'session'>,
  screen: string
): boolean {
  if (card.session.claudeStatus?.choices || card.session.agentStatus?.choices) return true;
  const tail = screenTail(screen);
  // Codex marks the selected option with ›, Gemini with ●: read them like Claude's ❯.
  const normalized = tail.replace(/^(\s*)[›●▶>]\s*(?=\d+\.\s)/gm, '$1❯ ');
  if (parseScreenChoices(normalized) !== null) return true;
  return card.kind === 'claude' && modeSwitchBlocked(tail);
}

export type BroadcastOutcome = 'sent' | 'blocked' | 'exited' | 'failed' | 'watchOnly';

export interface BroadcastResult {
  sessionId: string;
  outcome: BroadcastOutcome;
  error?: string;
}

export interface BroadcastIo {
  /** The session's current screen as plain text. */
  readScreen(sessionId: string): Promise<string>;
  /** Type `text` and press Enter. */
  send(sessionId: string, text: string): Promise<void>;
}

/**
 * Send one instruction to several agents, one after another. Each screen is read right
 * before its send; a session in a dialog (or no longer running, or a tmux session opened only
 * to watch) is skipped, never typed into.
 */
export async function broadcast(
  targets: AgentCard[],
  text: string,
  io: BroadcastIo
): Promise<BroadcastResult[]> {
  const results: BroadcastResult[] = [];
  for (const card of targets) {
    const sessionId = card.session.id;
    if (card.session.status !== 'running') {
      results.push({ sessionId, outcome: 'exited' });
      continue;
    }
    // tmux drops what a watching client types: it would say "Sent" for nothing.
    if (isWatching(card.session)) {
      results.push({ sessionId, outcome: 'watchOnly' });
      continue;
    }
    try {
      const screen = await io.readScreen(sessionId);
      if (broadcastBlocked(card, screen)) {
        results.push({ sessionId, outcome: 'blocked' });
        continue;
      }
      await io.send(sessionId, text);
      results.push({ sessionId, outcome: 'sent' });
    } catch (error) {
      results.push({
        sessionId,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** The HTTP version of BroadcastIo. */
export function httpBroadcastIo(authHeader: () => Record<string, string>): BroadcastIo {
  const input = async (sessionId: string, body: { text: string } | { key: string }) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  };
  return {
    async readScreen(sessionId) {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/text`, {
        headers: authHeader(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    async send(sessionId, text) {
      await input(sessionId, { text: text.replace(/[\r\n]+/g, ' ') });
      // Like the chat composer: Enter a moment later, so it isn't taken as part of a paste.
      await new Promise((resolve) => setTimeout(resolve, 60));
      await input(sessionId, { key: 'enter' });
    },
  };
}

// --- Route: /agents shows mission control in the phone list ---------------------------------

export const AGENTS_PATH = '/agents';
export const AGENTS_ROUTE_EVENT = 'ut-agents-route';

export function isAgentsRoute(): boolean {
  return typeof window !== 'undefined' && window.location.pathname === AGENTS_PATH;
}

/** Where "back to the list" goes: mission control if that is the tab last shown. */
let lastListPath = '/';

export function listPath(): string {
  return lastListPath;
}

/** Switch the phone list between sessions ("/") and agents ("/agents"). */
export function showAgentsTab(agents: boolean): void {
  const path = agents ? AGENTS_PATH : '/';
  lastListPath = path;
  if (window.location.pathname !== path) window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(AGENTS_ROUTE_EVENT));
}

/** Keep listPath() in step with the URL (back/forward, reloads on /agents). */
export function syncListPathFromUrl(): void {
  const path = window.location.pathname;
  if (path === AGENTS_PATH || path === '/') lastListPath = path;
}

/**
 * "Unread" Claude conversations, like a messaging app: a session is unread when Claude
 * answered or started waiting for you after you last looked at it. Per browser
 * (localStorage); the first sighting of a session is its baseline, so nothing old is unread.
 */
import type { Session } from '../../shared/types.js';
import { isClaudeWorking } from './claude-activity.js';

const STORAGE_KEY = 'untether-seen';

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function save(map: Record<string, string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Not persisted (private mode); still works for this page.
  }
}

/** What there is to "read": Claude's latest answer, or what it is waiting for. */
function signature(session: Session): string | null {
  const claude = session.claudeStatus;
  if (!claude || session.status !== 'running') return null;
  // `since` tells two prompts with the same text (e.g. two Bash permissions) apart.
  if (claude.status === 'waiting') return `w:${claude.since ?? ''}:${claude.waitingFor ?? ''}`;
  // A reply with only background agents left counts: it is there to read.
  if (!isClaudeWorking(claude) && claude.preview?.role === 'assistant') {
    return `a:${claude.preview.text}`;
  }
  return null;
}

export function markSeen(session: Session): void {
  const current = signature(session);
  if (current === null) return;
  const map = load();
  if (map[session.id] === current) return;
  map[session.id] = current;
  save(map);
}

export function isUnread(session: Session): boolean {
  if (!session.claudeStatus || session.status !== 'running') return false;
  const current = signature(session) ?? '';
  const map = load();
  if (!(session.id in map)) {
    // Baseline on first sighting (even while Claude is working): old news is not unread,
    // but an answer that arrives after this point is.
    map[session.id] = current;
    save(map);
    return false;
  }
  return current !== '' && map[session.id] !== current;
}

/** Forget sessions that no longer exist so storage doesn't grow forever. */
export function pruneSeen(sessions: Session[]): void {
  // An empty list is a server that just restarted, not every session gone (2026-11-10: it
  // wiped the whole map; every session was then seen "for the first time" and the answers
  // waiting to be read stopped showing as unread).
  if (sessions.length === 0) return;
  const map = load();
  const ids = new Set(sessions.map((s) => s.id));
  let changed = false;
  for (const id of Object.keys(map)) {
    if (!ids.has(id)) {
      delete map[id];
      changed = true;
    }
  }
  if (changed) save(map);
}

/** Home-screen icon badge (installed web app): conversations that need a look. */
export function updateAppBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  const result = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
  result?.catch(() => {});
}

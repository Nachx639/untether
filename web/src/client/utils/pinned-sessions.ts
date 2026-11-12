/**
 * Sessions pinned to the top of the phone list. Per device (localStorage): which sessions
 * matter is a choice made on each phone, not something the server needs to know.
 */
import { isFinishedSession } from './session-suspend.js';

const STORAGE_KEY = 'ut-pinned-sessions';

export function loadPinned(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function save(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Not persisted (private mode); still works for this page.
  }
}

/** Pin or unpin a session; returns the new set (a new object, for Lit change detection). */
export function setPinned(sessionId: string, pinned: boolean): Set<string> {
  const ids = loadPinned();
  if (pinned) ids.add(sessionId);
  else ids.delete(sessionId);
  save(ids);
  return new Set(ids);
}

/** What a pin follows across a resume: the session's id and its Claude conversation. */
export interface PinnableSession {
  id: string;
  status?: string;
  claudeSessionId?: string;
  command?: string[];
  /** The session this one resumed or replaced, when the server says so. */
  resumedFrom?: string;
  /** The session that replaced this one, when the server says so. */
  replacedBy?: string;
  /** Suspended by Untether: paused, still the same session (session-suspend.ts). */
  suspended?: unknown;
}

/** The Claude conversation each pinned session last showed (the pin follows it). */
const CONVERSATION_KEY = 'ut-pinned-conversations';

function loadConversations(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONVERSATION_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveConversations(map: Record<string, string>): void {
  try {
    localStorage.setItem(CONVERSATION_KEY, JSON.stringify(map));
  } catch {
    // Not persisted (private mode).
  }
}

/** The conversation a session resumes (`claude --resume <id>`), if any. */
function resumedConversation(command: string[] | undefined): string | undefined {
  if (!Array.isArray(command)) return undefined;
  const at = command.findIndex((arg) => arg === '--resume' || arg === '-r');
  return at >= 0 ? command[at + 1] : undefined;
}

/**
 * The running copy that took over a pinned session (its resume: a new id, the same Claude
 * conversation), or undefined.
 */
function successorOf(
  oldId: string,
  conversation: string | undefined,
  sessions: readonly PinnableSession[]
): PinnableSession | undefined {
  const old = sessions.find((session) => session.id === oldId);
  const live = sessions.filter((session) => session.id !== oldId && !isFinishedSession(session));
  if (old?.replacedBy) {
    const named = sessions.find((session) => session.id === old.replacedBy);
    if (named) return named;
  }
  const declared = live.find((session) => session.resumedFrom === oldId);
  if (declared) return declared;
  // Still listed and running: it has not been replaced.
  if (old && !isFinishedSession(old)) return undefined;
  if (!conversation) return undefined;
  return live.find(
    (session) =>
      session.claudeSessionId === conversation ||
      resumedConversation(session.command) === conversation
  );
}

/**
 * Keep the pins in step with the list: a pinned session replaced by its resumed copy (a new
 * id for the same Claude conversation) hands its pin to the copy (2026-10-20: resuming a
 * pinned session dropped the pin); sessions that no longer exist are forgotten so storage
 * doesn't grow forever. Plain ids are accepted too (no resume to follow). True when the pins
 * changed.
 */
export function prunePinned(existing: Iterable<string | PinnableSession>): boolean {
  const sessions: PinnableSession[] = [...existing].map((entry) =>
    typeof entry === 'string' ? { id: entry } : entry
  );
  const ids = loadPinned();
  const conversations = loadConversations();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  let changed = false;
  let mapChanged = false;
  for (const id of Array.from(ids)) {
    const successor = successorOf(id, byId.get(id)?.claudeSessionId ?? conversations[id], sessions);
    if (successor && !ids.has(successor.id)) {
      ids.delete(id);
      ids.add(successor.id);
      changed = true;
      continue;
    }
    if (!byId.has(id)) {
      ids.delete(id);
      changed = true;
    }
  }
  const next: Record<string, string> = {};
  for (const id of ids) {
    const conversation = byId.get(id)?.claudeSessionId ?? conversations[id];
    if (conversation) next[id] = conversation;
  }
  if (JSON.stringify(next) !== JSON.stringify(conversations)) mapChanged = true;
  if (changed) save(ids);
  if (mapChanged) saveConversations(next);
  return changed;
}

/** Fired on window when prunePinned moved or dropped pins (the list reloads them). */
export const PINS_CHANGED_EVENT = 'ut-pins-changed';

/** Pinned sessions first; each group keeps the order it already had. */
export function pinnedFirst<T extends { id: string }>(sessions: T[], pinned: Set<string>): T[] {
  if (!pinned.size) return sessions;
  return [...sessions].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
}

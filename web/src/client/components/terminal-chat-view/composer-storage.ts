const DRAFT_KEY_PREFIX = 'ut-chat-draft:';

/** The desktop chat's last commands, offered as suggestions on its empty state. */
const RECENT_COMMANDS_KEY = 'untether-chat-recent-commands';
const MAX_RECENT_COMMANDS = 3;

export function loadRecentCommands(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === 'string')
          .slice(0, MAX_RECENT_COMMANDS)
      : [];
  } catch {
    return [];
  }
}

export function rememberRecentCommand(command: string): void {
  const text = command.trim();
  if (!text) return;
  try {
    const next = [text, ...loadRecentCommands().filter((item) => item !== text)].slice(
      0,
      MAX_RECENT_COMMANDS
    );
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: no suggestions, nothing else changes.
  }
}

export function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(DRAFT_KEY_PREFIX + sessionId) ?? '';
  } catch {
    return '';
  }
}

/** Composer drafts survive a session switch or a reload (storage may be blocked: then not). */
export function saveDraft(sessionId: string, text: string) {
  if (!sessionId) return;
  try {
    if (text.trim()) localStorage.setItem(DRAFT_KEY_PREFIX + sessionId, text);
    else localStorage.removeItem(DRAFT_KEY_PREFIX + sessionId);
  } catch {
    // Private mode or storage full: the draft just isn't kept.
  }
}

/** A draft goes only once its session has been missing this long, every time it was looked for. */
export const DRAFT_GONE_AFTER_MS = 10 * 60_000;
const draftMissingSince = new Map<string, number>();

/**
 * Drop the drafts of sessions that no longer exist (2026-11-10: an unsent draft in a session
 * that later died stayed in localStorage for good). Text the user wrote is not thrown away on
 * one list: an empty list is a server that just restarted, and a list can lack a session for a
 * moment (a remote that did not answer), so a draft goes only after its session has been
 * absent from every list for DRAFT_GONE_AFTER_MS.
 */
export function pruneDrafts(liveSessionIds: Iterable<string>, now = Date.now()): void {
  const live = new Set(liveSessionIds);
  if (live.size === 0) return;
  try {
    const stale: string[] = [];
    const missing = new Set<string>();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(DRAFT_KEY_PREFIX) || live.has(key.slice(DRAFT_KEY_PREFIX.length))) {
        continue;
      }
      missing.add(key);
      const since = draftMissingSince.get(key) ?? now;
      draftMissingSince.set(key, since);
      if (now - since >= DRAFT_GONE_AFTER_MS) stale.push(key);
    }
    for (const key of draftMissingSince.keys()) {
      if (!missing.has(key)) draftMissingSince.delete(key);
    }
    for (const key of stale) {
      localStorage.removeItem(key);
      draftMissingSince.delete(key);
    }
  } catch {
    // Storage blocked: nothing to prune.
  }
}

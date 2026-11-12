/**
 * "While you were away": when this browser last showed each session, and which summary the
 * user dismissed. Per-device convenience state in localStorage; every access may throw
 * (private mode, blocked storage), and then the card simply never shows.
 */

export const AWAY_SEEN_STORAGE_KEY = 'ut-away-seen';
/** Shorter absences are not "away": the card would only repeat what was just on screen. */
export const AWAY_MIN_MS = 2 * 60_000;
const MAX_SESSIONS = 200;

interface SeenEntry {
  /** Epoch ms the session was last on screen. */
  seen: number;
  /** lastActivityAt of the summary the user dismissed. */
  dismissed?: string;
}

type SeenMap = Record<string, SeenEntry>;

function load(): SeenMap {
  try {
    const raw = localStorage.getItem(AWAY_SEEN_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as SeenMap) : {};
  } catch {
    return {};
  }
}

function save(map: SeenMap): void {
  const ids = Object.keys(map);
  if (ids.length > MAX_SESSIONS) {
    ids
      .sort((a, b) => (map[a].seen ?? 0) - (map[b].seen ?? 0))
      .slice(0, ids.length - MAX_SESSIONS)
      .forEach((id) => {
        delete map[id];
      });
  }
  try {
    localStorage.setItem(AWAY_SEEN_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // storage unavailable: nothing to remember
  }
}

export function lastSeen(sessionId: string): number | undefined {
  const seen = load()[sessionId]?.seen;
  return typeof seen === 'number' && Number.isFinite(seen) ? seen : undefined;
}

export function markSeen(sessionId: string, at = Date.now()): void {
  const map = load();
  map[sessionId] = { ...map[sessionId], seen: at };
  save(map);
}

export function dismissedActivity(sessionId: string): string | undefined {
  return load()[sessionId]?.dismissed;
}

export function markDismissed(sessionId: string, lastActivityAt: string | undefined): void {
  if (!lastActivityAt) return;
  const map = load();
  map[sessionId] = { seen: map[sessionId]?.seen ?? Date.now(), dismissed: lastActivityAt };
  save(map);
}

/** Whether a summary is worth a card: real activity, a real absence, not dismissed already. */
export function shouldShowAway(
  summary: { available: boolean; toolCalls: number; messages: number; lastActivityAt?: string },
  away: { since: number; now: number; dismissed?: string }
): boolean {
  if (!summary.available || summary.toolCalls + summary.messages < 1) return false;
  if (away.now - away.since < AWAY_MIN_MS) return false;
  if (!summary.lastActivityAt) return false;
  if (away.dismissed && Date.parse(summary.lastActivityAt) <= Date.parse(away.dismissed)) {
    return false;
  }
  return true;
}

import type { Session } from '../../shared/types.js';

/**
 * When a session last did something (epoch ms): the one time both the Sessions list and the
 * agent cards show, so the same session never says "14 min" in one and "14 h" in the other.
 *
 * For Claude idle or waiting, that is when its status last changed (Claude Code writes it):
 * the end of its last turn, or when it started waiting. The terminal's last output isn't:
 * opening or resizing the session redraws the screen, and a Claude idle since last night
 * read "4 min" in the list (2026-10-04, iPhone QA). While it works, and for other programs,
 * the last input or output is the activity.
 */
export function lastActivityAt(
  session: Partial<Pick<Session, 'claudeStatus' | 'activityStatus' | 'lastModified' | 'startedAt'>>
): number | undefined {
  const claude = session.claudeStatus;
  if (claude?.since && claude.status !== 'busy') return claude.since;
  for (const iso of [
    session.activityStatus?.lastActivityAt,
    session.lastModified,
    session.startedAt,
  ]) {
    const at = Date.parse(iso ?? '');
    if (!Number.isNaN(at)) return at;
  }
  return undefined;
}

import type { SessionGroupPin } from './types.js';

/**
 * The title a session shows (list row, agent card, session header, switcher, push): the name
 * the user gave it, else the agent's conversation title, else its own name. The session's
 * `name` ("claude (~/Projects)") is generated, made unique and rewritten by `ut title` and git
 * events, so a rename from the phone is kept apart in `userTitle` (session.json).
 */

/** Longest title a user can give a session; longer ones are cut. */
export const USER_TITLE_MAX_LENGTH = 200;

interface TitledSession {
  userTitle?: string;
  claudeStatus?: { title?: string };
  claudeTitle?: string;
  codexTitle?: string;
  geminiTitle?: string;
}

/** The conversation title Claude, Codex or Gemini gave the session, or ''. */
export function agentConversationTitle(session: TitledSession): string {
  return (
    session.claudeStatus?.title ||
    session.claudeTitle ||
    session.codexTitle ||
    session.geminiTitle ||
    ''
  );
}

/** The user's title, else the agent's conversation title, or '' (callers fall back to the name). */
export function sessionTitle(session: TitledSession): string {
  return session.userTitle?.trim() || agentConversationTitle(session);
}

interface ConversationSession {
  id: string;
  startedAt?: string;
  claudeSessionId?: string;
  codexThreadId?: string;
  userTitle?: string;
  claudeTitle?: string;
  groupPin?: SessionGroupPin;
}

/** What a session continuing a Claude or Codex conversation keeps from the sessions that ran it. */
export interface InheritedTitles {
  userTitle?: string;
  claudeTitle?: string;
  groupPin?: SessionGroupPin;
}

/**
 * The titles a session continuing a conversation (Claude's, or a Codex thread: `conversationId`
 * is either one's id) keeps from the sessions that ran it
 * before (resume, "Blindar", a Mac window reopened with `ut claude --resume`): the user's title
 * of the newest of them (none if the user cleared it there), and the newest conversation title
 * any of them kept, and the group the user anchored the newest of them to (2026-11-04, same
 * rule as its title). `before` leaves out sessions started after the one asking.
 *
 * 2026-10-18 (user report "se pierde el nombre al recuperar una sesión cerrada"): a resumed
 * session started with only the generated name; "TRAVEL DESK", "ATLAS" and "TELEVISIÓN"
 * were lost on resume and typed again by hand.
 */
export function inheritedTitles(
  sessions: readonly ConversationSession[],
  conversationId: string,
  opts: { excludeId?: string; before?: string } = {}
): InheritedTitles {
  const earlier = sessions
    .filter(
      (session) =>
        (session.claudeSessionId === conversationId || session.codexThreadId === conversationId) &&
        session.id !== opts.excludeId &&
        (!opts.before || !session.startedAt || session.startedAt <= opts.before)
    )
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  const userTitle = earlier[0]?.userTitle?.trim();
  const claudeTitle = earlier.find((session) => session.claudeTitle)?.claudeTitle;
  const groupPin = earlier[0]?.groupPin;
  return {
    ...(userTitle ? { userTitle } : {}),
    ...(claudeTitle ? { claudeTitle } : {}),
    ...(groupPin ? { groupPin } : {}),
  };
}

/**
 * A `userTitle` from a request: a trimmed, capped title; null to clear it ('' or null); or
 * undefined when the value is not a title at all.
 */
export function normalizeUserTitle(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const title = value.trim().slice(0, USER_TITLE_MAX_LENGTH).trim();
  return title || null;
}

/**
 * A name the server generated for the session (session-naming.ts `generateSessionName`):
 * "claude (~/Projects/app)", "zsh (~)", "codex (…/web/app)". Not one a user or `ut title`
 * gave it. A phone row drops it as a subtitle: its caption already shows the folder
 * (2026-10-12, phone-spec 3.1). With `command`, the name's program must be one of its words
 * ("zsh" for ["zsh", "-lic", "claude"]).
 */
export function isGeneratedSessionName(name: string | undefined, command?: string[]): boolean {
  const match = /^(\S+) \((?:~|\/|…)[^()]*\)$/.exec(name?.trim() ?? '');
  if (!match) return false;
  if (!command?.length) return true;
  const program = match[1].toLowerCase();
  return command
    .flatMap((word) => word.split(/\s+/))
    .some((word) => (word.split('/').pop() ?? '').toLowerCase() === program);
}

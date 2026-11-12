/**
 * Renaming a session from the phone: the field starts with the title on screen and saves the
 * user's title (`userTitle`); "Use Claude's title" clears it (shared/session-title.ts).
 */
import { agentConversationTitle, sessionTitle } from '../../shared/session-title.js';
import type { Session } from '../../shared/types.js';
import { t } from '../i18n/index.js';

/** The title a session shows: the user's, the agent's conversation title, its name or command. */
export function visibleSessionTitle(session: Session): string {
  const command = Array.isArray(session.command) ? session.command.join(' ') : '';
  return sessionTitle(session) || session.name || command;
}

/** The action that clears the user's title: "Use Claude's title" (or Codex's, Gemini's). */
export function resetTitleLabel(session: Session): string {
  if (session.claudeStatus?.title || session.claudeTitle) {
    return t('sessions.row.useAgentTitle', { agent: 'Claude' });
  }
  if (session.codexTitle) return t('sessions.row.useAgentTitle', { agent: 'Codex' });
  if (session.geminiTitle) return t('sessions.row.useAgentTitle', { agent: 'Gemini' });
  return agentConversationTitle(session)
    ? t('sessions.row.useAgentTitle', { agent: 'Claude' })
    : t('sessions.row.useAutomaticTitle');
}

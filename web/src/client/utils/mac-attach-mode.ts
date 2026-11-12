/**
 * A tmux session opened from "On this Mac" runs, in Untether, a tmux client of the user's own
 * tmux session (Session.multiplexer). In watch mode that client is read-only: tmux drops what
 * it types. Its size is left to the other terminals showing the session (`others`), or follows
 * this screen too (`here`).
 */
import {
  MAC_SESSIONS_CHANGED_EVENT,
  type MacModeRequest,
  type MacModeResponse,
  type MacSessionsErrorBody,
} from '../../shared/mac-sessions.js';
import type { Session, SessionMultiplexer } from '../../shared/types.js';
import { t } from '../i18n/index.js';

/** The tmux session this session is a client of, when it was opened from "On this Mac". */
export function attachedTmux(
  session: Pick<Session, 'multiplexer'> | null | undefined
): SessionMultiplexer | null {
  return session?.multiplexer?.type === 'tmux' ? session.multiplexer : null;
}

/** Opened only to watch: nothing typed here reaches the tmux session. */
export function isWatching(session: Pick<Session, 'multiplexer'> | null | undefined): boolean {
  return attachedTmux(session)?.mode === 'watch';
}

function modeError(status: number, body: Partial<MacSessionsErrorBody>): string {
  if (body.error === 'client-not-found') return t('macSessions.error.clientNotFound');
  if (body.error === 'disabled') return t('macSessions.error.disabled');
  return t('macSessions.error.modeFailed', {
    error: body.details || body.error || `HTTP ${status}`,
  });
}

/**
 * Watch or type, or let this screen set the size (POST
 * /api/mac-sessions/attached/:sessionId/mode). Resolves with what tmux reports afterwards;
 * rejects with the message to show.
 */
export async function changeAttachMode(
  sessionId: string,
  change: MacModeRequest,
  authHeader: Record<string, string>
): Promise<MacModeResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/mac-sessions/attached/${encodeURIComponent(sessionId)}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify(change),
    });
  } catch (error) {
    throw new Error(
      t('macSessions.error.modeFailed', {
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
  const body = (await response.json().catch(() => ({}))) as Partial<
    MacModeResponse & MacSessionsErrorBody
  >;
  if (!response.ok || (body.mode !== 'control' && body.mode !== 'watch')) {
    throw new Error(modeError(response.status, body));
  }
  // The list says which tmux sessions are open here, and which only to watch.
  window.dispatchEvent(new CustomEvent(MAC_SESSIONS_CHANGED_EVENT));
  return { mode: body.mode, sizing: body.sizing === 'here' ? 'here' : 'others' };
}

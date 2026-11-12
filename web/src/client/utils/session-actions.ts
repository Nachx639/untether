/**
 * Session Action Utilities
 *
 * Provides common session operations like termination and cleanup
 * that can be reused across components.
 */

import { HttpMethod } from '../../shared/types.js';
import { t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { createLogger } from './logger.js';

const logger = createLogger('session-actions');

/**
 * Why a session request failed, in the user's language: callers put it after "Couldn't …:".
 * 2026-10-20 audit: the toasts read "No se pudo renombrar la sesión: Rename failed: 400".
 */
export function sessionHttpReason(status: number): string {
  if (status === 401 || status === 403) return t('sessionAction.error.auth');
  if (status === 404) return t('sessionAction.error.notFound');
  return t('sessionAction.error.server', { status: String(status) });
}

/** The reason of a caught request error: a fetch that never reached the server is offline. */
function failureReason(error: unknown): string {
  if (error instanceof TypeError) return t('sessionAction.error.network');
  return error instanceof Error ? error.message : t('worktrees.error.unknown');
}

export interface SessionActionResult {
  success: boolean;
  error?: string;
}

/**
 * Terminates a running session or cleans up an exited session
 * @param sessionId - The ID of the session to terminate/cleanup
 * @param authClient - The auth client for authentication headers
 * @param status - The current status of the session
 * @returns Result indicating success or failure with error message
 */
export async function terminateSession(
  sessionId: string,
  authClient: AuthClient,
  status: 'running' | 'exited'
): Promise<SessionActionResult> {
  const action = status === 'exited' ? 'cleanup' : 'terminate';

  try {
    const response = await fetch(`/api/sessions/${sessionId}`, {
      method: HttpMethod.DELETE,
      headers: {
        ...authClient.getAuthHeader(),
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      logger.error(`Failed to ${action} session`, { errorData, sessionId });
      throw new Error(sessionHttpReason(response.status));
    }

    logger.debug(`Session ${action} successful`, { sessionId });
    return { success: true };
  } catch (error) {
    logger.error(`Failed to ${action} session:`, error);
    return {
      success: false,
      error: failureReason(error),
    };
  }
}

/** Mutes or unmutes a session's notifications (push, in-app toasts, icon badge). */
export async function setSessionMuted(
  sessionId: string,
  muted: boolean,
  authClient: AuthClient | undefined
): Promise<SessionActionResult> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/mute`, {
      method: HttpMethod.POST,
      headers: { 'Content-Type': 'application/json', ...authClient?.getAuthHeader() },
      body: JSON.stringify({ muted }),
    });
    if (!response.ok) throw new Error(sessionHttpReason(response.status));
    return { success: true };
  } catch (error) {
    logger.error('Failed to change session mute:', error);
    return { success: false, error: failureReason(error) };
  }
}

/**
 * Give a session its own title (shown instead of the agent's conversation title), or clear it
 * with null to go back to the automatic one. Stored server-side as `userTitle` in session.json.
 */
export async function setSessionUserTitle(
  sessionId: string,
  userTitle: string | null,
  authClient: Pick<AuthClient, 'getAuthHeader'> | undefined
): Promise<SessionActionResult> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: HttpMethod.PATCH,
      headers: { 'Content-Type': 'application/json', ...authClient?.getAuthHeader() },
      body: JSON.stringify({ userTitle }),
    });
    if (!response.ok) throw new Error(sessionHttpReason(response.status));
    return { success: true };
  } catch (error) {
    logger.error('Failed to set session title:', error);
    return {
      success: false,
      error: failureReason(error),
    };
  }
}

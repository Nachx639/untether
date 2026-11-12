/**
 * Shielded sessions ("Blindar"): the program runs in a private tmux session on the Mac and
 * keeps running while Untether restarts. A running process can't be moved into tmux, so
 * shielding an existing session opens a new shielded one in the same folder (a Claude or Codex
 * session continues its conversation there and the old one closes).
 */
import { isForwardedSession } from '../../shared/forwarded-session.js';
import type { Session } from '../../shared/types.js';
import { t } from '../i18n/index.js';
import { confirmDialog } from './confirm-dialog.js';
import { isAttachedTmuxSession } from './mac-sessions.js';

/** Same rule as the server's shieldReopenPlan: Claude with a known conversation. */
export function shieldContinuesClaude(session: Pick<Session, 'command' | 'claudeSessionId'>) {
  return (
    Boolean(session.claudeSessionId) &&
    /(^|[\s/])claude(\s|$)/.test((session.command ?? []).join(' '))
  );
}

/** Same rule as the server's shieldReopenPlan: Codex started directly, with a known thread. */
export function shieldContinuesCodex(session: Pick<Session, 'command' | 'codexThreadId'>) {
  return (
    Boolean(session.codexThreadId) && (session.command?.[0] ?? '').split('/').pop() === 'codex'
  );
}

/** The question asked before shielding a session. */
export function shieldConfirmText(session: Session, name: string): string {
  if (shieldContinuesClaude(session)) return t('shield.confirmClaude', { name });
  if (shieldContinuesCodex(session)) return t('shield.confirmCodex', { name });
  return t('shield.confirmOther', { name });
}

/**
 * Can this session be shielded from its menu? Not one that runs in a terminal window (ut), nor
 * one attached to a tmux session outside Untether: shielding reopens the program in a new
 * tmux session, which would run a tmux client inside the shield.
 */
export function canShield(session: Session): boolean {
  return (
    session.status === 'running' &&
    !session.shielded &&
    session.source !== 'remote' &&
    !isForwardedSession(session) &&
    !isAttachedTmuxSession(session)
  );
}

/**
 * "Llevar a Untether" (2026-10-25): a Claude session opened with ut in a terminal window on the
 * Mac. Blindar can't reopen it in place, but its conversation can move: Claude closes in the
 * window and goes on in a shielded Untether session (POST /shield, which takes it then).
 */
export function canMoveToUntether(session: Session): boolean {
  return (
    session.status === 'running' &&
    session.source !== 'remote' &&
    isForwardedSession(session) &&
    shieldContinuesClaude(session)
  );
}

/** The server would not interrupt Claude without asking (it works or waits for an answer). */
export class ClaudeBusyError extends Error {}

/** Open the shielded session for `session`; resolves with the new session's id. */
export async function shieldSession(
  sessionId: string,
  authHeader?: Record<string, string>,
  body: { force?: boolean; windowNotice?: string } = {}
): Promise<{ sessionId: string; replaced: boolean }> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/shield`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.sessionId) {
    if (result.error === 'claude-busy') throw new ClaudeBusyError(result.details || result.error);
    throw new Error(result.details || result.error || response.statusText);
  }
  return result;
}

/**
 * Move a `ut` session to Untether (canMoveToUntether), once the user said yes to it. While
 * Claude works or waits for an answer the user is asked again (`confirmBusy`); resolves null
 * when they keep it in its window.
 */
export async function moveToUntether(
  sessionId: string,
  name: string,
  authHeader?: Record<string, string>,
  confirmBusy: () => Promise<boolean> = () =>
    confirmDialog({
      title: t('moveToUntether.action'),
      body: t('moveToUntether.busyConfirm'),
      confirmLabel: t('moveToUntether.moveNow'),
      tone: 'danger',
    })
): Promise<{ sessionId: string; replaced: boolean } | null> {
  const body = { windowNotice: t('moveToUntether.windowNotice', { name }) };
  try {
    return await shieldSession(sessionId, authHeader, body);
  } catch (error) {
    if (!(error instanceof ClaudeBusyError)) throw error;
    if (!(await confirmBusy())) return null;
    return shieldSession(sessionId, authHeader, { ...body, force: true });
  }
}

/**
 * One status per session for every surface (cards, sidebar rows, header, palette), so they
 * never disagree (design spec 3, 2026-10-12). Render it with `.ut-status[data-status]` and a
 * `.ut-dot`; "running" alone is never shown as text, it is the default.
 *
 *   needs-input   Claude or Codex waits for the user (permission, plan, question…)
 *   working       Claude or Codex is busy on a turn, the PTY is active, or output came < 5 s ago
 *   idle          running, nothing happening
 *   exited-ok     ended with code 0 (or no code)
 *   exited-error  ended with a non-zero code
 *   paused        suspended by Untether to free memory; opening it wakes it (2026-10-31)
 */
import type { Session } from '../../shared/types.js';
import { t } from '../i18n/index.js';
import { isBackgroundWait, isClaudeWorking } from './claude-activity.js';
import { claudeWaitingLabel } from './claude-waiting-label.js';
import { lastActivityAt } from './last-activity.js';

export type SessionStatus =
  | 'working'
  | 'needs-input'
  | 'idle'
  | 'exited-ok'
  | 'exited-error'
  | 'paused';

/** Output this recent counts as working even without an activity flag. */
export const RECENT_OUTPUT_MS = 5_000;

type StatusSession = Pick<
  Session,
  | 'status'
  | 'exitCode'
  | 'activityStatus'
  | 'claudeStatus'
  | 'agentStatus'
  | 'lastModified'
  | 'startedAt'
  | 'suspended'
>;

// One clock for every list, label and order (last-activity.ts). This file had its own, which
// only read the terminal's last output: the desktop cards said "Idle · 4m ago" for a Claude the
// phone row dated 14 hours back, and opening a session moved its project up the list (2026-11-10).
export { lastActivityAt };

export function deriveSessionStatus(
  session: Partial<StatusSession>,
  now: number = Date.now()
): SessionStatus {
  if (session.suspended && session.status === 'exited') return 'paused';
  if (session.status === 'exited') {
    return session.exitCode && session.exitCode !== 0 ? 'exited-error' : 'exited-ok';
  }
  const claude = session.claudeStatus;
  if (claude?.status === 'waiting') return 'needs-input';
  // Only background agents still run: the reply is in, nothing to watch.
  if (isBackgroundWait(claude)) return 'idle';
  if (isClaudeWorking(claude)) return 'working';
  // A Claude session that says idle is idle, whatever its terminal redraws.
  if (claude?.status === 'idle') return 'idle';
  // Codex says so itself too (its rollout, Session.agentStatus): a redraw is no work, a quiet
  // command no rest (2026-11-10).
  const agent = claude ? undefined : session.agentStatus;
  if (agent?.status === 'waiting') return 'needs-input';
  if (agent?.status === 'busy') return 'working';
  if (agent?.status === 'idle') return 'idle';
  if (session.activityStatus?.isActive) return 'working';
  const last = session.activityStatus?.lastActivityAt
    ? Date.parse(session.activityStatus.lastActivityAt)
    : Number.NaN;
  if (!Number.isNaN(last) && now - last >= 0 && now - last < RECENT_OUTPUT_MS) return 'working';
  return 'idle';
}

/** "5s ago", "3m ago", "2h ago", "4d ago" in the user's language (time.*Ago keys). */
export function relativeTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t('time.secondsAgo', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { n: hours });
  return t('time.daysAgo', { n: Math.floor(hours / 24) });
}

/** The translated label for a status: "Working", "Idle · 3m ago", "Needs you"… */
export function statusLabel(
  status: SessionStatus,
  session?: Partial<StatusSession>,
  now: number = Date.now()
): string {
  switch (status) {
    case 'working':
      return t('status.working');
    case 'needs-input': {
      const reason = claudeWaitingLabel(
        session?.claudeStatus?.waitingFor ?? session?.agentStatus?.waitingFor
      );
      return reason ? `${t('status.needsInput')} · ${reason}` : t('status.needsInput');
    }
    case 'idle': {
      const last = session ? lastActivityAt(session) : undefined;
      return last === undefined
        ? t('status.idle', { ago: '' }).replace(/\s*·\s*$/, '')
        : t('status.idle', { ago: relativeTime(now - last) });
    }
    case 'exited-ok':
      return t('status.exitedOk');
    case 'exited-error':
      return t('status.exitedCode', { code: String(session?.exitCode ?? '') });
    case 'paused': {
      if (session?.suspended?.resumeError) return t('suspend.wakeFailedShort');
      // Since when (2026-10-31: the "Suspended" section shows how long each one has slept).
      const at = Date.parse(session?.suspended?.at ?? '');
      return Number.isNaN(at)
        ? t('suspend.paused')
        : t('suspend.pausedSince', { ago: relativeTime(now - at) });
    }
  }
}

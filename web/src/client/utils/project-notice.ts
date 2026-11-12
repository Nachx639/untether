/**
 * What the board says about a project from GET /api/projects (pure): where a moved project
 * came from, while the move is recent, and its automatic merges paused, while that lasts.
 */
import { t } from '../i18n/index.js';
import type { ProjectNotice } from '../services/task-store.js';
import { whenText } from './when-text.js';

/** How long after a move the header still says where the project was. */
export const MOVED_NOTE_MS = 3 * 24 * 60 * 60 * 1000;

/** The folder a moved project came from («antes «skylark»»), while the move is recent. */
export function movedFromName(notice: ProjectNotice | undefined, now = Date.now()): string {
  if (!notice?.movedFrom) return '';
  const at = notice.movedAt ? Date.parse(notice.movedAt) : Number.NaN;
  if (Number.isFinite(at) && now - at > MOVED_NOTE_MS) return '';
  return notice.movedFrom.replace(/\/+$/, '').split('/').pop() || '';
}

/**
 * Why automatic merges were paused, in the user's language, from the server's code and count
 * (`autoMergePausedCode` 'reverts' | 'failures', `autoMergePausedCount`). The server's own
 * English reason is never shown (2026-10-20 audit): an unknown or missing code reads as the
 * generic «demasiados problemas recientes».
 */
export function mergePauseReason(
  notice: Pick<ProjectNotice, 'autoMergePausedCode' | 'autoMergePausedCount'> | undefined
): string {
  const code = notice?.autoMergePausedCode;
  const n = notice?.autoMergePausedCount;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
    if (code === 'reverts') return t('board.pauseReason.reverts', { n });
    if (code === 'failures') return t('board.pauseReason.failures', { n });
  }
  return t('board.pauseReason.generic');
}

/** Automatic merges paused, while the pause lasts: its end and why. */
export function mergePause(
  notice: ProjectNotice | undefined,
  now = Date.now()
): { until: string; reason: string } | null {
  if (!notice?.autoMergePausedUntil) return null;
  const until = Date.parse(notice.autoMergePausedUntil);
  if (!Number.isFinite(until) || until <= now) return null;
  return {
    until: notice.autoMergePausedUntil,
    reason: mergePauseReason(notice),
  };
}

/**
 * «Fusión automática en pausa hasta las 14:05: …», or «… hasta mañana a las 14:05: …» when it
 * ends another day.
 */
export function mergePauseText(notice: ProjectNotice | undefined, now = Date.now()): string {
  const pause = mergePause(notice, now);
  if (!pause) return '';
  const when = whenText(pause.until, now);
  if (!when) return '';
  return when.today
    ? t('board.mergePausedWhy', { time: when.time, reason: pause.reason })
    : t('board.mergePausedWhyLater', { when: when.when, reason: pause.reason });
}

import {
  type ClaudeWaitingReason,
  claudeWaitingReason,
} from '../../shared/claude-waiting-reason.js';
import { type MessageKey, t } from '../i18n/index.js';

export const CLAUDE_WAITING_KEYS: Record<ClaudeWaitingReason, MessageKey> = {
  permission: 'claudeWaiting.permission',
  plan: 'claudeWaiting.plan',
  input: 'claudeWaiting.input',
  dialog: 'claudeWaiting.dialog',
  goal: 'claudeWaiting.goal',
  sandbox: 'claudeWaiting.sandbox',
  worker: 'claudeWaiting.worker',
};

/**
 * Claude Code says what it waits for in English ("permission prompt"). Known reasons are shown
 * in the user's language; anything else is shown as Claude wrote it. Every place that shows
 * `waitingFor` goes through here (2026-10-04: the session header said "permission prompt").
 */
export function claudeWaitingLabel(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  const known = claudeWaitingReason(reason);
  return known ? t(CLAUDE_WAITING_KEYS[known]) : reason;
}

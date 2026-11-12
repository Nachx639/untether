/**
 * Whether a push should reach the phone, given what the user's clients show right now.
 *
 * 2026-11-02 (idea from Paseo): ordinary pushes (an agent finished, a task is ready, a bell) are
 * skipped while some client of the user shows their session on a visible, focused page that
 * was touched lately (VIEWING frames, terminal-socket-client.ts isLookedAt). The important ones
 * (a task that needs you, a confirmation, the doctor) used to be skipped the same way, or sent
 * while the user was already reading them. Now they are never dropped just for being on screen:
 * while someone might be looking, they wait ATTENTION_SEEN_MS and go out unless a client
 * reported them as seen meanwhile (SEEN frames from the attention strip) or still shows their
 * session. With no client looking at anything, every push goes out at once, as before.
 */

import { confirmSeenKey, needsYouSeenKey } from '../../shared/ws-v3.js';

/** How long an important push waits for a client to show it before it goes to the phone. */
export const ATTENTION_SEEN_MS = 30_000;

/** Pushes that wait to be seen instead of being skipped while their subject is on screen. */
const URGENT_TYPE = /^(task-needs-you|task-confirm|untether-doctor)$/;

/**
 * Pushes skipped while their session is on screen. "Preview ready" is not among them: it is
 * skipped only while that preview's own view is shown (it deep-links there).
 */
const VIEWED_SUPPRESSIBLE_TYPE =
  /^(claude-|codex-|gemini-|command-|task-(ready|failed|merged|done)$|bell$)/;

export function isUrgentPush(type: string): boolean {
  return URGENT_TYPE.test(type);
}

export interface AttentionPayload {
  type: string;
  data?: Record<string, unknown>;
}

/** What a push is about that a client can show: its SEEN keys. */
export function attentionKeys(payload: AttentionPayload): string[] {
  const data = payload.data ?? {};
  if (payload.type === 'task-confirm' && typeof data.confirmId === 'string') {
    return [confirmSeenKey(data.confirmId)];
  }
  if (payload.type === 'task-needs-you' && typeof data.taskId === 'string') {
    return [needsYouSeenKey(data.taskId)];
  }
  return [];
}

/** What the clients show (ws-v3-hub.ts). */
export interface AttentionView {
  /** Some client shows this session on a visible, focused, recently touched page. */
  isSessionViewed(sessionId: string): boolean;
  /** Some looked-at client showed this key (SEEN frame) at or after `since`. */
  wasSeenSince(key: string, since: number): boolean;
  /** Some client is being looked at now (a fresh VIEWING or SEEN frame). */
  isAnyClientActive(): boolean;
}

export type AttentionDecision =
  | { action: 'send' }
  | { action: 'skip'; why: string }
  | { action: 'hold'; ms: number };

/**
 * The first look at a push. `heldSince` is set when it comes back after its hold: it is then
 * sent unless it was seen in the meantime.
 */
export function decideAttention(
  payload: AttentionPayload,
  view: AttentionView,
  heldSince?: number
): AttentionDecision {
  const sessionId = typeof payload.data?.sessionId === 'string' ? payload.data.sessionId : null;
  if (!isUrgentPush(payload.type)) {
    if (
      sessionId &&
      VIEWED_SUPPRESSIBLE_TYPE.test(payload.type) &&
      view.isSessionViewed(sessionId)
    ) {
      return { action: 'skip', why: `session ${sessionId} is on screen in some client` };
    }
    return { action: 'send' };
  }
  const keys = attentionKeys(payload);
  if (heldSince === undefined) {
    const watched =
      (sessionId !== null && view.isSessionViewed(sessionId)) ||
      (keys.length > 0 && view.isAnyClientActive());
    return watched ? { action: 'hold', ms: ATTENTION_SEEN_MS } : { action: 'send' };
  }
  const seenKey = keys.find((key) => view.wasSeenSince(key, heldSince));
  if (seenKey) return { action: 'skip', why: `${seenKey} was seen in a client` };
  // Shown the whole time on the terminal it is about (it was on screen when held).
  if (sessionId && view.isSessionViewed(sessionId)) {
    return { action: 'skip', why: `session ${sessionId} stayed on screen` };
  }
  return { action: 'send' };
}

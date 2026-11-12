import type { ChatMessage } from './chat-types.js';
import { extractUploadedImages } from './formatting.js';

export type SendState = 'sending' | 'failed' | 'unconfirmed';

/** A sent message shown as the user's bubble until the transcript has it. */
export interface PendingSent {
  id: string;
  text: string;
  words: string;
  images: string[];
  at: number;
  state: SendState;
  /** Order of sending: the messages of later sends came after it. */
  seq: number;
  /** User messages shown when it was sent (ids without an images suffix): none of them is it. */
  shownBefore: Set<string>;
  /**
   * The message of a later send, once the transcript has it: this one never came (or not yet)
   * and stays just before it, instead of below everything said since.
   */
  before?: string;
}

/** No word from the transcript or the composer this long after a send: say so, offer nothing. */
export const SENT_CONFIRM_MS = 30_000;
/** How far the transcript's clock (the Mac's) may be behind the phone's. */
const SENT_CLOCK_SKEW_MS = 10_000;

/** A message's text as compared with what the phone sent: whitespace collapsed, images apart. */
export function sentWords(text: string): { words: string; images: string[] } {
  const { text: rest, images } = extractUploadedImages(text.normalize('NFC'));
  return { words: rest.replace(/\s+/g, ' ').trim(), images: [...new Set(images)].sort() };
}

/**
 * The server marks a message with images logged after its text by a new id, `<id>+<images>`.
 * A message without an id still renders, as it always did.
 */
export const baseMessageId = (id: string | undefined) => (id ?? '').split('+')[0];

/**
 * The transcript's messages that are the sent ones, by sent id. In send order: the first sent
 * takes the first match, so identical texts sent twice match one each. A message counts only if
 * it was not shown at the send, is not older than it (give or take the clocks) and does not
 * already stand for another one (`claimed`).
 */
export function matchSent(
  sent: readonly PendingSent[],
  messages: readonly ChatMessage[],
  claimed: ReadonlySet<string>
) {
  const matches = new Map<string, string>();
  const taken = new Set(claimed);
  const users = messages.filter((m) => m.role === 'user');
  for (const pending of sent) {
    const match = users.find((m) => {
      const id = baseMessageId(m.id);
      if (taken.has(id) || pending.shownBefore.has(id)) return false;
      // A message without a time (NaN) is not ruled out by it.
      if (Date.parse(m.timestamp ?? '') < pending.at - SENT_CLOCK_SKEW_MS) return false;
      const shown = sentWords(m.text);
      if (shown.words !== pending.words) return false;
      // Claude Code logs a message's images just after its text: the text alone is it too.
      return shown.images.length === 0
        ? pending.words !== ''
        : shown.images.join('\n') === pending.images.join('\n');
    });
    if (match) {
      matches.set(pending.id, match.id);
      taken.add(baseMessageId(match.id));
    }
  }
  return matches;
}

/** A sent bubble as the transcript shows the message, so the two look the same. */
export const sentAsMessage = (sent: PendingSent): ChatMessage => ({
  id: sent.id,
  role: 'user',
  text: sent.text,
  timestamp: new Date(sent.at).toISOString(),
});

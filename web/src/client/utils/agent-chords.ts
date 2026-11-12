/**
 * Claude Code's chords for sending while it works (user report, 2026-10-14): Ctrl+X Ctrl+S
 * sends now (chat:sendNow) and Ctrl+X Enter queues (chat:queueSubmit); Ctrl+S alone stashes
 * the prompt. Each key goes in a write of its own, as typed, so the agent reads two keys and
 * never a paste.
 */
export const SEND_NOW_KEYS: readonly string[] = ['\x18', '\x13'];
export const QUEUE_SUBMIT_KEYS: readonly string[] = ['\x18', '\r'];

/** The key toolbar's ⌃ row key for "send now": its key id and what it sends. */
export const CHORD_QUICK_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ['Ctrl+X Ctrl+S', SEND_NOW_KEYS],
]);

/** How long after Ctrl+X the next key still completes the chord here. */
export const CHORD_MS = 3000;

/** Gap between the chord's writes (and after typed text), as the composer's Enter. */
export const CHORD_KEY_GAP_MS = 50;

interface ChordKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** A modifier pressed on its own (Ctrl held for the chord's second key): no key yet. */
export function isModifierOnly(e: Pick<ChordKeyEvent, 'key'>): boolean {
  return MODIFIER_KEYS.has(e.key);
}

/** Ctrl+X, the chords' first key. */
export function isCtrlX(e: ChordKeyEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'x';
}

/** What a key right after Ctrl+X makes: send now (Ctrl+S), queue (Enter), or nothing. */
export function chordAfterCtrlX(e: ChordKeyEvent): readonly string[] | null {
  if (e.metaKey || e.altKey || e.shiftKey) return null;
  if (e.ctrlKey && e.key.toLowerCase() === 's') return SEND_NOW_KEYS;
  if (e.key === 'Enter') return QUEUE_SUBMIT_KEYS;
  return null;
}

/** Writes keys one by one, CHORD_KEY_GAP_MS apart, the first after `delayMs`. */
export function writeKeys(
  send: (data: string) => void,
  keys: readonly string[],
  delayMs = 0
): void {
  keys.forEach((key, i) => {
    const at = delayMs + CHORD_KEY_GAP_MS * i;
    if (at === 0) send(key);
    else setTimeout(() => send(key), at);
  });
}

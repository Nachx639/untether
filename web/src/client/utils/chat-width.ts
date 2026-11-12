/**
 * "Chat width" (Settings → Appearance), per device: how much of a wide desktop window the chat's
 * column takes. 2026-11-11: a fixed 720 px column left more than half of a 2000 px window empty.
 *
 *   full         the whole chat area less a side margin, no ceiling (the default)
 *   comfortable  the 720 px reading column
 *
 * styles/tokens.css turns `data-chat-width` on <html> into --ut-chat-column; no attribute means
 * full. A saved "wide" (removed the same day) reads as the default. Phones and windows whose chat
 * area is under ~1000 px look the same in both.
 * assets/index.html applies the saved choice before the first paint.
 */

export type ChatWidth = 'full' | 'comfortable';

export const CHAT_WIDTHS: ChatWidth[] = ['full', 'comfortable'];
export const CHAT_WIDTH_KEY = 'ut-chat-width';
export const DEFAULT_CHAT_WIDTH: ChatWidth = 'full';

export function readChatWidth(): ChatWidth {
  try {
    const saved = localStorage.getItem(CHAT_WIDTH_KEY) as ChatWidth | null;
    if (saved && CHAT_WIDTHS.includes(saved)) return saved;
  } catch {
    // Storage blocked: the default.
  }
  return DEFAULT_CHAT_WIDTH;
}

/** Sets or clears what tokens.css keys on. */
export function applyChatWidth(width: ChatWidth): void {
  if (width === DEFAULT_CHAT_WIDTH) document.documentElement.removeAttribute('data-chat-width');
  else document.documentElement.setAttribute('data-chat-width', width);
}

export function writeChatWidth(width: ChatWidth): void {
  try {
    if (width === DEFAULT_CHAT_WIDTH) localStorage.removeItem(CHAT_WIDTH_KEY);
    else localStorage.setItem(CHAT_WIDTH_KEY, width);
  } catch {
    // Blocked storage: the choice lasts until the page reloads.
  }
  applyChatWidth(width);
}

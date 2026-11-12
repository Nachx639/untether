import { isKnownClaudeMode } from '../../utils/claude-mode.js';
import type { ChatAgent, ChatMessage } from './chat-types.js';

/**
 * The last transcript shown per conversation, kept for this page load: switching back to a
 * session (a swipe, the switcher) showed a blank "Loading conversation…" for a few frames
 * while the first poll ran, every time (user report, 2026-10-14). Now its last list shows at
 * once and the poll, sent with its fingerprint, only replaces it if it changed.
 */
interface CachedChat {
  messages: ChatMessage[];
  messagesVersion: string | null;
  signature: string;
  title: string;
  agent: ChatAgent;
}
const CHAT_CACHE_MAX = 8;
export const chatCache = new Map<string, CachedChat>();

export function cacheChat(key: string, chat: CachedChat): void {
  chatCache.delete(key);
  chatCache.set(key, chat);
  while (chatCache.size > CHAT_CACHE_MAX) {
    const oldest = chatCache.keys().next().value;
    if (oldest === undefined) break;
    chatCache.delete(oldest);
  }
}

/** Test hook: forget every cached conversation. */
export function clearChatCacheForTest(): void {
  chatCache.clear();
}

const MODE_KEY_PREFIX = 'ut-claude-mode-';

/** Claude's permission mode last read on this session's screen, for this tab. */
export function rememberedMode(sessionId: string): string | null {
  try {
    const mode = sessionStorage.getItem(MODE_KEY_PREFIX + sessionId);
    // Stored before the stricter reading, it could be a workflow's name (user report,
    // 2026-10-14): a name not known waits for the screen instead.
    return mode && isKnownClaudeMode(mode) ? mode : null;
  } catch {
    return null;
  }
}

export function rememberMode(sessionId: string, mode: string | null): void {
  try {
    if (mode) sessionStorage.setItem(MODE_KEY_PREFIX + sessionId, mode);
    else sessionStorage.removeItem(MODE_KEY_PREFIX + sessionId);
  } catch {
    // Storage blocked: the chip just waits for the screen, as before.
  }
}

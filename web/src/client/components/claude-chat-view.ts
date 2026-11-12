/**
 * Claude Chat View
 *
 * Chat mode for agent sessions (Claude Code, Codex, Gemini), on phones and (with `desktop`)
 * in a desktop browser: renders the conversation from the agent's
 * own transcript (served by /api/sessions/:id/claude-chat) as messaging-app bubbles. The
 * terminal only holds Claude Code's visible screen, so it cannot be the source.
 * Sets the `unavailable` attribute (and hides) when the session is not running Claude Code.
 *
 * `readOnly` follows a conversation that can't be typed into from here (an agent running
 * outside Untether, a tmux session opened to watch): no answers, Stop, mode or voice.
 *
 * The view is split over ./claude-chat-view/: chat-view-base.ts (state, polling, sent
 * messages), chat-view-ui.ts (rendering, search, read-aloud, message menu), styles.ts, and
 * the helpers it uses (markdown, prompt dock, formatting, speech, sent-message matching).
 */
import { customElement } from 'lit/decorators.js';
import { ClaudeChatViewUi } from './claude-chat-view/chat-view-ui.js';
import { claudeChatViewStyles } from './claude-chat-view/styles.js';

export { modeSwitchBlocked, parseClaudeMode } from '../utils/claude-mode.js';
export { clearChatCacheForTest } from './claude-chat-view/chat-cache.js';
export type {
  ClaudeChatState,
  SentChatMessage,
  SentChatMessageRef,
} from './claude-chat-view/chat-types.js';
export { extractUploadedImages, toolVerb } from './claude-chat-view/formatting.js';
export { renderChatMarkdown } from './claude-chat-view/markdown.js';
export {
  type PromptDockView,
  promptDockStyles,
  promptT,
  renderPromptDock,
} from './claude-chat-view/prompt-dock.js';
export { resetMacVoiceCheck, speechLang, speechText } from './claude-chat-view/speech.js';

@customElement('claude-chat-view')
export class ClaudeChatView extends ClaudeChatViewUi {
  static styles = claudeChatViewStyles;
}

declare global {
  interface HTMLElementTagNameMap {
    'claude-chat-view': ClaudeChatView;
  }
}

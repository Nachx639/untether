import type { MessageKey } from '../../i18n/index.js';
import type { ClaudeActivity } from '../../utils/claude-activity.js';

/** Notes the server words in English ("[Request interrupted by user]"), in the page's language. */
export const NOTE_KEYS: Record<string, MessageKey> = { Interrupted: 'chat.interrupted' };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'note';
  text: string;
  timestamp?: string;
  tool?: string;
  question?: { text: string; options: string[] };
  detail?: string;
  result?: string;
  isError?: boolean;
  /** Edit/MultiEdit/Write: signed lines ('-', '+', ' '), '#' + a file name, or "…" (skipped). */
  diff?: string[];
  diffMore?: number;
}

export interface ChatResponse {
  available: boolean;
  status?: string;
  waitingFor?: string;
  title?: string;
  activity?: ClaudeActivity;
  /** Busy only because background agents or tasks run: the reply is over. */
  waitingForBackground?: boolean;
  /** Which agent the conversation is from; absent means Claude Code. */
  agent?: ChatAgent;
  /** Left out of the answer when it matches `?have=` (the poll then keeps the list shown). */
  messages: ChatMessage[];
  /** Fingerprint of `messages`, sent back as `?have=`; absent only on {available:false}. */
  messagesVersion?: string;
}

export type ChatAgent = 'claude' | 'codex' | 'gemini';

/** Each agent's name and wording in the chat view. */
export const AGENT_TEXT: Record<
  ChatAgent,
  { name: string; empty: MessageKey; working: MessageKey; finished: MessageKey; stop: MessageKey }
> = {
  claude: {
    name: 'Claude',
    empty: 'chat.empty',
    working: 'chat.working',
    finished: 'a11y.chat.finished',
    stop: 'chat.stopClaude',
  },
  codex: {
    name: 'Codex',
    empty: 'codex.chat.empty',
    working: 'codex.chat.working',
    finished: 'codex.chat.finished',
    stop: 'codex.chat.stop',
  },
  gemini: {
    name: 'Gemini',
    empty: 'gemini.chat.empty',
    working: 'gemini.chat.working',
    finished: 'gemini.chat.finished',
    stop: 'gemini.chat.stop',
  },
};

/** What the phone composer needs to know of the chat above it (claude-chat-state). */
export interface ClaudeChatState {
  sessionId: string;
  busy: boolean;
  asking: boolean;
  /**
   * A phone docks Claude's request (its question, or the waiting note) over the composer: the
   * session view's needs-input strip would say the same twice and squeeze the transcript
   * (2026-10-12 QA), so it can stand down while this is set.
   */
  promptDocked?: boolean;
}

/** A message the phone composer just sent (see ClaudeChatView.addSentMessage). */
export interface SentChatMessage {
  sessionId: string;
  /** The composer's id for it: a retry sends it again under the same id. */
  id: string;
  /** What was sent: uploaded images' paths, then the text. */
  text: string;
  /** Date.now() at the send. */
  at: number;
  /** performance.now() when the composer's send began, for the QA timing line. */
  startedAt: number;
}

/** Which sent message a failure or a retry is about. */
export interface SentChatMessageRef {
  sessionId: string;
  id: string;
}

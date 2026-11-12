/**
 * The agent conversation (Claude Code, Codex or Gemini) running in a local session, in the
 * chat shape. Shared by the phone chat view and the "while you were away" summary.
 */
import { createHash } from 'node:crypto';
import type { SessionInfo } from '../../shared/types.js';
import { type ClaudeChat, readClaudeChat } from './claude-chat.js';
import { isCodexCommand, readCodexChat } from './codex-chat.js';
import { codexSessionRef } from './codex-process.js';
import { isGeminiCommand, readGeminiChat } from './gemini-chat.js';
import { geminiSessionRef } from './gemini-process.js';

type ChatSession = SessionInfo & { pid: number };

/**
 * `programPid`: the program inside tmux for a shielded session, the pane its tmux client shows
 * for an attached one, else the session pid.
 */
export async function readSessionChat(
  session: ChatSession,
  programPid: number
): Promise<ClaudeChat> {
  // An attached session's command is its tmux client: what runs is found from the pane below.
  const command = session.multiplexer ? undefined : session.command;
  // OpenAI Codex: the same chat shape, read from its rollout file.
  if (isCodexCommand(command)) return readCodexChat(session);
  // Gemini CLI: the same chat shape, read from its chat recording.
  if (isGeminiCommand(command)) return readGeminiChat(session);
  const claudeChat = await readClaudeChat(programPid);
  if (!claudeChat.available) {
    // A shell where `codex` was typed: its Codex process gives the rollout.
    const ref = await codexSessionRef({ ...session, pid: programPid });
    if (ref) return readCodexChat(ref);
    // …or `gemini`: its process gives the chat file.
    const geminiRef = await geminiSessionRef({ ...session, pid: programPid });
    if (geminiRef) return readGeminiChat(geminiRef);
  }
  return claudeChat;
}

/**
 * A short fingerprint of a chat's messages. The phone polls the chat every 1.5 s while the
 * agent works, but the messages change only every few seconds; it sends back the fingerprint
 * it has (`?have=`) and an unchanged list is left out of the answer. 2026-10-03: a long
 * conversation was ~200 KB of JSON (~50 KB brotli) on every poll, ~2 MB a minute on the phone.
 */
export function chatMessagesVersion(messages: readonly unknown[]): string {
  return createHash('sha1').update(JSON.stringify(messages)).digest('base64url').slice(0, 16);
}

/** The chat answer for a client that already shows the messages with fingerprint `have`. */
export function chatAnswer<T extends { messages: readonly unknown[] }>(chat: T, have: unknown) {
  const messagesVersion = chatMessagesVersion(chat.messages);
  if (typeof have === 'string' && have === messagesVersion) {
    const { messages: _messages, ...rest } = chat;
    return { ...rest, messagesVersion, messagesUnchanged: true as const };
  }
  return { ...chat, messagesVersion };
}

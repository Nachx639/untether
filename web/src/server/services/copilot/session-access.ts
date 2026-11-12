/**
 * What the voice copilot reads from and does to local sessions. The session routes build it
 * from their own code (routes/sessions.ts), so an order spoken to the copilot goes through the
 * same checks as a tap on the phone: the menu re-read and compared before an answer, one answer
 * per session at a time, read-only tmux clients refused.
 */
import type { Session, SessionInput } from '../../../shared/types.js';
import type { ClaudeChatMessage } from '../claude-chat.js';

export interface MenuChoices {
  question: string;
  options: string[];
  detail?: string[];
  key?: string;
}

export interface PromptState {
  waiting: boolean;
  waitingFor?: string;
  choices: MenuChoices | null;
}

/** A route's answer: 200 and its body, or the status and error it would have sent. */
export interface AccessAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface SessionAccess {
  /** Local sessions as GET /sessions shows them (no Git detection, cached agent titles). */
  snapshot(): Promise<Session[]>;
  /** The agent conversation of a running local session (Claude, Codex or Gemini). */
  chat(sessionId: string): Promise<{ available: boolean; messages: ClaudeChatMessage[] }>;
  /** What is waiting right now (GET /sessions/:id/prompt). */
  prompt(sessionId: string): Promise<AccessAnswer>;
  /** POST /sessions/:id/input, local sessions. */
  input(sessionId: string, input: SessionInput): Promise<AccessAnswer>;
  /** POST /sessions/:id/answer. */
  answer(
    sessionId: string,
    body: { option: number; question: string; options: string[]; key?: string }
  ): Promise<AccessAnswer>;
  /** POST /sessions/:id/reply. */
  reply(
    sessionId: string,
    body: { text: string; question: string | null; options?: string[]; key?: string }
  ): Promise<AccessAnswer>;
}

/** An action the server refused, with the status and error code its route answers. */
export class ActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(`${status} ${code}`);
  }
}

/** The body of a 200 answer, or ActionError. */
export function okBody(answer: AccessAnswer): Record<string, unknown> {
  if (answer.status === 200) return answer.body;
  const error = answer.body.error;
  throw new ActionError(answer.status, typeof error === 'string' ? error : 'failed');
}

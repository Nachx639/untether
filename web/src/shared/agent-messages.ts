/**
 * Messages between agents (2026-11-10): what `ut project tell` and `ut task send` carry. Until
 * now they were bare text typed into a prompt: no id, no thread, no way to tell whether the
 * other agent had read one, and one agent's reply arrived stuck to a message of the user's.
 *
 * Each message has a short id, a sender (a project's orchestrator, a task, the user), who it
 * is for, an optional "in reply to", and a state Untether moves on its own:
 *
 *   queued → delivered (typed into the agent) → attended (the agent started a turn after it)
 *          → answered (a message came back with --reply-to, or the task reported)
 *
 * The ledger lives in services/agent-messages.ts; this file is what both sides share: the
 * record, what counts as open, and the lines the agents read.
 */

export type AgentMessageState = 'queued' | 'delivered' | 'attended' | 'answered';

export type AgentMessageParty =
  /** A project's orchestrator. */
  | { kind: 'project'; repoPath: string }
  /** A task's agent. */
  | { kind: 'task'; taskId: string; name?: string; repoPath?: string }
  /** The user (the app, or `ut` outside any agent's session). */
  | { kind: 'user' }
  /** An agent session that is neither (its send was approved by the user). */
  | { kind: 'session'; sessionId: string };

/** The user's own words, read by Untether from the sender's conversation (never the sender's). */
export interface UserDecisionQuote {
  /** The user's turn, as it stands in the transcript (cut at USER_DECISION_MAX). */
  quote: string;
  /** When the user wrote it (ISO). */
  at: string;
  /** The Untether session it was written in (the sender's). */
  sessionId: string;
}

export interface AgentMessage {
  id: string;
  /** When it was sent (ISO). */
  at: string;
  from: AgentMessageParty;
  to: AgentMessageParty;
  /** The message it answers. */
  replyTo?: string;
  /** The start of its text (the whole text is in the recipient's conversation). */
  preview: string;
  state: AgentMessageState;
  /** False: a notice or a reply, done once attended. */
  expectsReply: boolean;
  deliveredAt?: string;
  attendedAt?: string;
  answeredAt?: string;
  /** The message that answered it, or 'report' (its task reported). */
  answeredBy?: string;
  userDecision?: UserDecisionQuote;
  /**
   * Queued and not typed in yet: why (its recipient is in the middle of a turn, stopped at
   * its usage limit, shows a prompt of its own…), and since when it is known to wait. 2026-11-10:
   * m699vq7 sat «queued (not typed in yet)» for over four hours with nothing saying why.
   */
  waitingWhy?: string;
  waitingSince?: string;
  /** Its sender was told it waits (once). */
  waitingToldAt?: string;
}

/** Not typed in after this long, its sender hears why (once); it still goes in on its own. */
export const MESSAGE_WAIT_NOTICE_MS = 2 * 60_000;

export const MESSAGE_PREVIEW_MAX = 160;
export const USER_DECISION_MAX = 1200;
/** A request between projects unanswered this long is the doctor's to tell. */
export const UNANSWERED_WARN_HOURS = 4;

/** Ids are "m" plus six of these (no vowels, no look-alikes: never a word, easy to retype). */
const ID_ALPHABET = 'bcdfghjkmnpqrstvwxz23456789';
export const MESSAGE_ID = /^m[bcdfghjkmnpqrstvwxz2-9]{6}$/;

export function newMessageId(random: () => number = Math.random): string {
  let id = 'm';
  for (let i = 0; i < 6; i++) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  return id;
}

/**
 * Whether a message still wants something: not typed in yet, not read yet, or a request
 * without its answer. A notice or a reply is done once its agent started a turn after it.
 */
export function isOpenMessage(message: AgentMessage): boolean {
  if (message.state === 'answered') return false;
  if (message.state === 'attended') return message.expectsReply;
  return true;
}

const baseName = (repoPath: string) => repoPath.split('/').filter(Boolean).pop() ?? repoPath;

/** "the orchestrator of "untether"", "task 1a2b3c4d "name"", "the user". */
export function partyLabel(party: AgentMessageParty): string {
  switch (party.kind) {
    case 'project':
      return `the orchestrator of "${baseName(party.repoPath)}"`;
    case 'task':
      return `task ${party.taskId.slice(0, 8)}${party.name ? ` "${party.name}"` : ''}`;
    case 'user':
      return 'the user';
    case 'session':
      return `session ${party.sessionId.slice(0, 8)} (another agent; the user approved sending it)`;
  }
}

/** Short, for a list: "untether", "task 1a2b3c4d", "user". */
export function partyShort(party: AgentMessageParty): string {
  switch (party.kind) {
    case 'project':
      return baseName(party.repoPath);
    case 'task':
      return `task ${party.taskId.slice(0, 8)}`;
    case 'user':
      return 'user';
    case 'session':
      return `session ${party.sessionId.slice(0, 8)}`;
  }
}

export function messagePreview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MESSAGE_PREVIEW_MAX ? `${line.slice(0, MESSAGE_PREVIEW_MAX - 1)}…` : line;
}

/** "3 min", "2 h 5 min", "3 d". */
export function ageText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) {
    const rest = minutes % 60;
    return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
  }
  return `${Math.round(minutes / (24 * 60))} d`;
}

const STATE_TEXT: Record<AgentMessageState, string> = {
  queued: 'queued (not typed in yet)',
  delivered: 'delivered, not read yet',
  attended: 'read',
  answered: 'answered',
};

/** What a message waits for, in the words of `ut project messages`. */
export function messageStateText(message: AgentMessage): string {
  if (message.state === 'attended' && message.expectsReply) return 'read, no answer yet';
  if (message.state === 'answered' && message.answeredBy) {
    return message.answeredBy === 'report'
      ? 'answered (its task reported)'
      : `answered by ${message.answeredBy}`;
  }
  if (message.state === 'queued' && message.waitingWhy) {
    return `queued (not typed in yet: ${message.waitingWhy}; it goes in on its own once it can)`;
  }
  return STATE_TEXT[message.state];
}

/** One line of `ut project messages`. */
export function messageLine(message: AgentMessage, now: number): string {
  const sent = Date.parse(message.at);
  const age = Number.isFinite(sent) ? `${ageText(now - sent)} ago` : message.at;
  const reply = message.replyTo ? ` (reply to ${message.replyTo})` : '';
  const decision = message.userDecision ? ' [user decision quoted]' : '';
  return `${message.id}  ${partyShort(message.from)} → ${partyShort(message.to)}${reply}  ${messageStateText(message)}  ${age}${decision}  ${message.preview}`;
}

/** "in reply to mbcd234 (your message of 12:03: "…")" for the header of a reply. */
export function replyReference(replyTo: AgentMessage, toRecipient: boolean): string {
  const at = new Date(Date.parse(replyTo.at));
  const clock = Number.isFinite(at.getTime())
    ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    : '';
  const whose = toRecipient ? 'your message' : 'the message';
  return `in reply to ${replyTo.id} (${whose}${clock ? ` of ${clock}` : ''})`;
}

/** A turn of a conversation as the server reads it from the agent's transcript. */
export interface ConversationTurn {
  role: string;
  text: string;
  timestamp?: string;
}

/**
 * Whether a user-role turn is the user's own typing. Not theirs: anything Untether typed in
 * (its lines start with "[untether]": task notes, other agents' messages, goals passed on),
 * someone else's quoted text, an orchestrator's brief, and the harness's own notes ("<…>").
 */
export function isUsersOwnTurn(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<')) return false;
  if (trimmed.startsWith('You are the orchestrator of the project "')) return false;
  return !trimmed
    .split('\n')
    .some((line) => /^\s*(\[\s*untether\s*\]|│)/i.test(line) || /^\s*\(sent (on|at) /.test(line));
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The user's most recent own turn holding `words` (any case, any spacing), as Untether quotes
 * it under a message that passes on a decision of theirs; null when there is none.
 */
export function findUserDecision(
  turns: readonly ConversationTurn[],
  words: string,
  sessionId: string
): UserDecisionQuote | null {
  const needle = squash(words);
  if (!needle) return null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role !== 'user' || !turn.timestamp || !isUsersOwnTurn(turn.text)) continue;
    if (!squash(turn.text).includes(needle)) continue;
    const quote = turn.text.trim();
    return {
      quote: quote.length > USER_DECISION_MAX ? `${quote.slice(0, USER_DECISION_MAX - 1)}…` : quote,
      at: turn.timestamp,
      sessionId,
    };
  }
  return null;
}

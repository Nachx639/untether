/**
 * The ledger of messages between agents (2026-11-10, shared/agent-messages.ts): one record per
 * `ut project tell` / `ut task send`, with its thread and how far it got. The queues that carry
 * the text (orchestrator.ts, TaskRecord.pendingInput) stay the source of truth for delivery;
 * they tell the ledger when a message was typed in, and the ledger works out the rest:
 *
 * - attended: its recipient's agent started a turn after it was typed (the Claude status
 *   notifier's "busy", or the agent's own events: turn start, a message taken in).
 * - answered: a message came back with --reply-to from the one it was for, or its task
 *   reported (`ut task done` / `ut task ask`).
 *
 * Kept in messages.json (atomic, 0600): open messages for as long as they are open, closed
 * ones for a week.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  type AgentMessage,
  type AgentMessageParty,
  isOpenMessage,
  MESSAGE_ID,
  MESSAGE_WAIT_NOTICE_MS,
  messagePreview,
  newMessageId,
  type UserDecisionQuote,
} from '../../shared/agent-messages.js';

/** Closed messages are kept this long (their thread may still be cited). */
export const CLOSED_KEPT_MS = 7 * 24 * 60 * 60_000;
/** Never more than this many records; the oldest closed ones go first. */
export const MESSAGES_MAX = 2000;
/**
 * A turn that started this little before the typing was reported done is the one that took it
 * (the typing answers "typed" up to a couple of seconds after its Enter).
 */
export const DELIVERY_SKEW_MS = 3000;

const STATE_VERSION = 1;

export interface MessageLedgerDeps {
  /** The session the party's agent runs in now (an orchestrator's, a task's). */
  sessionOf(party: AgentMessageParty): string | undefined;
  /** When that session's agent last started a turn or took a message in (epoch ms). */
  lastTurnAt?(sessionId: string): number | undefined;
  /** A message that will never be typed in (its recipient went away): its sender hears. */
  undelivered?(message: AgentMessage, why: string): void;
  /**
   * A message that waits to be typed in and why, for its sender (once, after
   * MESSAGE_WAIT_NOTICE_MS); `why` null: it went in after all.
   */
  waitingTold?(message: AgentMessage, why: string | null): void;
  /** MESSAGE_WAIT_NOTICE_MS, shorter in tests. */
  waitNoticeMs?: number;
  statePath?: string;
  now?: () => number;
  random?: () => number;
  log?: (message: string) => void;
}

export interface NewAgentMessage {
  from: AgentMessageParty;
  to: AgentMessageParty;
  text: string;
  replyTo?: string;
  /** Default: a reply expects none, anything else does. */
  expectsReply?: boolean;
  userDecision?: UserDecisionQuote;
}

export type RecordResult =
  | { ok: true; message: AgentMessage; repliedTo?: AgentMessage }
  | { ok: false; message: string };

export function sameParty(a: AgentMessageParty, b: AgentMessageParty): boolean {
  if (a.kind === 'project' && b.kind === 'project') return a.repoPath === b.repoPath;
  if (a.kind === 'task' && b.kind === 'task') return a.taskId === b.taskId;
  if (a.kind === 'session' && b.kind === 'session') return a.sessionId === b.sessionId;
  return a.kind === 'user' && b.kind === 'user';
}

function partyRepo(party: AgentMessageParty): string | undefined {
  return party.kind === 'project' || party.kind === 'task' ? party.repoPath : undefined;
}

export class MessageLedger {
  private messages = new Map<string, AgentMessage>();
  /** Each session's last turn start seen here (a start can come before "typed" does). */
  private readonly turns = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: MessageLedgerDeps) {
    this.now = deps.now ?? Date.now;
    this.load();
  }

  /**
   * A new message, queued. With `replyTo`, that message must exist; when it was for the one
   * replying, it is answered now.
   */
  record(input: NewAgentMessage): RecordResult {
    let repliedTo: AgentMessage | undefined;
    if (input.replyTo !== undefined) {
      repliedTo = MESSAGE_ID.test(input.replyTo) ? this.messages.get(input.replyTo) : undefined;
      if (!repliedTo) {
        return {
          ok: false,
          message: `No message "${input.replyTo}" to reply to (\`ut project messages --all\` lists them)`,
        };
      }
      const partOfIt = sameParty(repliedTo.to, input.from) || sameParty(repliedTo.from, input.from);
      if (!partOfIt) {
        return {
          ok: false,
          message: `Message ${repliedTo.id} was neither for you nor yours: you cannot reply to it`,
        };
      }
    }
    let id = newMessageId(this.deps.random);
    while (this.messages.has(id)) id = newMessageId(this.deps.random);
    const at = new Date(this.now()).toISOString();
    const message: AgentMessage = {
      id,
      at,
      from: input.from,
      to: input.to,
      ...(repliedTo ? { replyTo: repliedTo.id } : {}),
      preview: messagePreview(input.text),
      state: 'queued',
      expectsReply: input.expectsReply ?? !repliedTo,
      ...(input.userDecision ? { userDecision: input.userDecision } : {}),
    };
    this.messages.set(id, message);
    if (repliedTo && sameParty(repliedTo.to, input.from) && repliedTo.state !== 'answered') {
      // Answering it is having read it, whatever was seen of its turn. How far it had got
      // stays in deliveredAt / attendedAt: an answer that never goes out gives it back (unanswer).
      repliedTo.state = 'answered';
      repliedTo.answeredAt = at;
      repliedTo.answeredBy = id;
    }
    this.save();
    return { ok: true, message: { ...message }, ...(repliedTo ? { repliedTo } : {}) };
  }

  get(id: string): AgentMessage | undefined {
    const message = this.messages.get(id);
    return message ? { ...message } : undefined;
  }

  /** It was typed into its recipient's agent. */
  delivered(id: string | undefined): void {
    const message = id ? this.messages.get(id) : undefined;
    if (message?.state === 'answered' && !message.deliveredAt) {
      // Answered before its typing was reported: kept, should that answer never go out.
      message.deliveredAt = new Date(this.now()).toISOString();
      this.save();
      return;
    }
    if (!message || message.state !== 'queued') return;
    const now = this.now();
    message.state = 'delivered';
    message.deliveredAt = new Date(now).toISOString();
    const told = !!message.waitingToldAt;
    delete message.waitingWhy;
    delete message.waitingSince;
    delete message.waitingToldAt;
    // Its sender heard it was waiting: it hears that it went in.
    if (told) this.tell(message, null);
    // Its turn may have been seen starting before the typing was reported done.
    const sessionId = this.deps.sessionOf(message.to);
    const started = sessionId ? this.turns.get(sessionId) : undefined;
    if (started !== undefined && started >= now - DELIVERY_SKEW_MS) this.attend(message, started);
    this.save();
  }

  /**
   * Still queued, and this is why it cannot be typed in now (called by whoever carries it, each
   * time it tries: orchestrator.ts, the tasks' pendingInput). Shown by `ut project messages`;
   * after MESSAGE_WAIT_NOTICE_MS its sender is told, once. It goes in on its own later.
   */
  waiting(id: string | undefined, why: string): void {
    const message = id ? this.messages.get(id) : undefined;
    if (!message || message.state !== 'queued') return;
    const now = this.now();
    let changed = false;
    if (message.waitingWhy !== why) {
      message.waitingWhy = why;
      changed = true;
    }
    if (!message.waitingSince) {
      message.waitingSince = new Date(now).toISOString();
      changed = true;
    }
    const waited = now - Math.min(Date.parse(message.at), Date.parse(message.waitingSince));
    if (!message.waitingToldAt && waited >= (this.deps.waitNoticeMs ?? MESSAGE_WAIT_NOTICE_MS)) {
      message.waitingToldAt = new Date(now).toISOString();
      changed = true;
      this.tell(message, why);
    }
    if (changed) this.save();
  }

  private tell(message: AgentMessage, why: string | null): void {
    try {
      this.deps.waitingTold?.({ ...message }, why);
    } catch (error) {
      this.deps.log?.(`message ${message.id}: its sender could not be told: ${error}`);
    }
  }

  /** It was refused before it was queued anywhere: as if never sent. */
  discard(id: string): void {
    if (!this.messages.delete(id)) return;
    this.unanswer(id);
    this.save();
  }

  /**
   * The answer `replyId` never went out (refused, or its recipient went away): what it had
   * answered is open again, as far as it had got (review 2026-11-10: the request stayed
   * 'answered' by a reply that never existed, gone from the list and from the doctor).
   */
  private unanswer(replyId: string): void {
    for (const message of this.messages.values()) {
      if (message.state !== 'answered' || message.answeredBy !== replyId) continue;
      message.state = message.attendedAt
        ? 'attended'
        : message.deliveredAt
          ? 'delivered'
          : 'queued';
      delete message.answeredAt;
      delete message.answeredBy;
    }
  }

  /** It will never be typed in: forgotten here, its sender told. */
  undeliverable(id: string | undefined, why: string): void {
    const message = id ? this.messages.get(id) : undefined;
    if (!message || message.state !== 'queued') return;
    this.messages.delete(message.id);
    this.unanswer(message.id);
    this.deps.log?.(`message ${message.id} was never delivered: ${why}`);
    this.save();
    try {
      this.deps.undelivered?.({ ...message }, why);
    } catch (error) {
      this.deps.log?.(`message ${message.id}: its sender could not be told: ${error}`);
    }
  }

  /** A session's agent started a turn: what was typed into it before is attended. */
  turnStarted(sessionId: string, at = this.now()): void {
    this.turns.set(sessionId, at);
    let changed = false;
    for (const message of this.messages.values()) {
      if (message.state !== 'delivered') continue;
      if (this.deps.sessionOf(message.to) !== sessionId) continue;
      if (Date.parse(message.deliveredAt ?? '') > at + DELIVERY_SKEW_MS) continue;
      this.attend(message, at);
      changed = true;
    }
    if (changed) this.save();
  }

  sessionEnded(sessionId: string): void {
    this.turns.delete(sessionId);
  }

  /** The task reported (`ut task done`, `ut task ask`): that answers what it was sent. */
  taskReported(taskId: string): void {
    const at = new Date(this.now()).toISOString();
    let changed = false;
    for (const message of this.messages.values()) {
      if (message.to.kind !== 'task' || message.to.taskId !== taskId) continue;
      if (message.state !== 'delivered' && message.state !== 'attended') continue;
      message.state = 'answered';
      message.answeredAt = at;
      message.answeredBy = 'report';
      changed = true;
    }
    if (changed) this.save();
  }

  /**
   * The messages, oldest first. `repoPath`: only those from or to that project (its
   * orchestrator or its tasks). `open`: only the ones still waiting (isOpenMessage).
   */
  list(filter: { repoPath?: string; open?: boolean } = {}): AgentMessage[] {
    this.refresh();
    return [...this.messages.values()]
      .filter((message) => {
        if (filter.open && !isOpenMessage(message)) return false;
        if (filter.repoPath === undefined) return true;
        return (
          partyRepo(message.from) === filter.repoPath || partyRepo(message.to) === filter.repoPath
        );
      })
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((message) => ({ ...message }));
  }

  /**
   * Requests from one project's orchestrator to another's that got no answer in `olderThanMs`
   * (the doctor's check): typed in or not, read or not.
   */
  unanswered(olderThanMs: number): AgentMessage[] {
    const now = this.now();
    return this.list({ open: true }).filter(
      (message) =>
        message.from.kind === 'project' &&
        message.to.kind === 'project' &&
        message.expectsReply &&
        now - Date.parse(message.at) >= olderThanMs
    );
  }

  /** Project folders that moved (ProjectSettingsStore.followedBy): their messages follow. */
  projectsMoved(moved: ReadonlyArray<{ from: string; to: string }>): number {
    let count = 0;
    for (const message of this.messages.values()) {
      for (const party of [message.from, message.to]) {
        if (party.kind !== 'project' && party.kind !== 'task') continue;
        const move = moved.find((entry) => entry.from === party.repoPath);
        if (!move) continue;
        party.repoPath = move.to;
        count++;
      }
    }
    if (count) this.save();
    return count;
  }

  /** What the agents' own events say since: a turn started after a message was typed in. */
  private refresh(): void {
    const deps = this.deps;
    let changed = false;
    for (const message of this.messages.values()) {
      if (message.state !== 'delivered' || !deps.lastTurnAt) continue;
      const sessionId = this.deps.sessionOf(message.to);
      const at = sessionId ? deps.lastTurnAt(sessionId) : undefined;
      const typed = Date.parse(message.deliveredAt ?? '');
      if (at === undefined || !Number.isFinite(typed) || at < typed - DELIVERY_SKEW_MS) continue;
      this.attend(message, at);
      changed = true;
    }
    if (this.prune() || changed) this.save();
  }

  private attend(message: AgentMessage, at: number): void {
    message.state = 'attended';
    message.attendedAt = new Date(
      Math.max(at, Date.parse(message.deliveredAt ?? '') || at)
    ).toISOString();
  }

  private prune(): boolean {
    const now = this.now();
    const before = this.messages.size;
    for (const [id, message] of this.messages) {
      if (isOpenMessage(message)) continue;
      const closedAt = Date.parse(message.answeredAt ?? message.attendedAt ?? message.at);
      if (now - closedAt > CLOSED_KEPT_MS) this.messages.delete(id);
    }
    if (this.messages.size > MESSAGES_MAX) {
      const byAge = [...this.messages.values()].sort((a, b) => a.at.localeCompare(b.at));
      const closedFirst = [
        ...byAge.filter((m) => !isOpenMessage(m)),
        ...byAge.filter(isOpenMessage),
      ];
      for (const message of closedFirst) {
        if (this.messages.size <= MESSAGES_MAX) break;
        this.messages.delete(message.id);
      }
    }
    return this.messages.size !== before;
  }

  private load(): void {
    const file = this.deps.statePath;
    if (!file) return;
    let data: { version?: unknown; messages?: unknown };
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log?.(`messages state unreadable, ignored: ${error}`);
      }
      return;
    }
    if (data?.version !== STATE_VERSION || !Array.isArray(data.messages)) return;
    for (const message of data.messages as AgentMessage[]) {
      if (
        !message ||
        typeof message.id !== 'string' ||
        !MESSAGE_ID.test(message.id) ||
        typeof message.at !== 'string' ||
        !message.from ||
        !message.to ||
        !['queued', 'delivered', 'attended', 'answered'].includes(message.state)
      ) {
        continue;
      }
      this.messages.set(message.id, message);
    }
  }

  private save(): void {
    const file = this.deps.statePath;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      const body = { version: STATE_VERSION, messages: [...this.messages.values()] };
      fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
    } catch (error) {
      this.deps.log?.(`messages state could not be saved: ${error}`);
    }
  }
}

/**
 * Codex's real state for the session list (2026-11-10, audit rows 1 and 10).
 *
 * The list told a Codex session "working" from its terminal's output time, like a shell: a
 * redraw read as work and a quiet command as rest. Its rollout already said the truth (turn
 * started, turn over, cut short by a limit), but only tasks read it, and only for a Codex the
 * session was started with. Here:
 *
 *   CodexSessions       which running sessions hold a Codex right now: started with `codex`,
 *                       or typed in a shell (codexSessionRef finds it in the process tree).
 *                       AgentEventService follows the rollout of each.
 *   codexAgentStatus    that state in the list's words (Session.agentStatus).
 *   CodexMenus          the one thing a rollout never says: Codex waiting on a menu of its
 *                       own (approve a command, trust this folder, update). Read off the
 *                       screen, like Claude's quick answers.
 *   codexSightings      all of it for the status notifier's pushes.
 */
import type { ScreenChoices } from '../../shared/claude-screen.js';
import type { SessionAgentStatus } from '../../shared/types.js';
import type { AgentSnapshot } from './agent-events.js';
import type { AgentSighting } from './claude-status-notifier.js';
import type { CodexSessionRef } from './codex-chat.js';
import { codexSessionRef, type SessionLike } from './codex-process.js';
import { sessionStateOf } from './session-state-events.js';

export interface CodexSessionsDeps {
  /**
   * The sessions to look at, each with the pid its program runs under (the program inside
   * tmux for a shielded one: PtyManager.programRootPid).
   */
  sessions: () => SessionLike[];
  /** codexSessionRef (tests give their own). */
  resolve?: (session: SessionLike) => Promise<CodexSessionRef | null>;
  /**
   * A session's Codex went away or is another one now (`codex` typed again in the same shell):
   * what was known of the old one says nothing about the session any more.
   */
  onGone?: (sessionId: string) => void;
  onError?: (sessionId: string, error: unknown) => void;
}

export class CodexSessions {
  private refs = new Map<string, CodexSessionRef>();
  private refreshing: Promise<void> | null = null;

  constructor(private readonly deps: CodexSessionsDeps) {}

  /** Looks at every session again; calls made meanwhile share the look going on. */
  refresh(): Promise<void> {
    this.refreshing ??= this.look().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async look(): Promise<void> {
    const resolve = this.deps.resolve ?? codexSessionRef;
    const found = new Map<string, CodexSessionRef>();
    for (const session of this.deps.sessions()) {
      if (session.status === 'exited') continue;
      try {
        const ref = await resolve(session);
        if (ref) found.set(session.id, ref);
      } catch (error) {
        // A failed look (ps, lsof) is no news: what was known stays for this round.
        const known = this.refs.get(session.id);
        if (known) found.set(session.id, known);
        this.deps.onError?.(session.id, error);
      }
    }
    for (const [sessionId, ref] of this.refs) {
      if (found.get(sessionId)?.id !== ref.id) this.deps.onGone?.(sessionId);
    }
    this.refs = found;
  }

  /** What to match the session's rollout with, while a Codex runs in it. */
  ref(sessionId: string): CodexSessionRef | undefined {
    return this.refs.get(sessionId);
  }

  /** The sessions a Codex runs in. */
  ids(): string[] {
    return [...this.refs.keys()];
  }
}

/**
 * A Codex's state from its rollout, as the list shows it. Undefined when its events say
 * nothing (none read, or they are another agent's): the list falls back to the output time.
 */
export function codexAgentStatus(
  snapshot: AgentSnapshot | undefined
): SessionAgentStatus | undefined {
  if (!snapshot || snapshot.source !== 'codex-rollout') return undefined;
  const seen = sessionStateOf(snapshot.state);
  if (!seen) return undefined;
  return {
    agent: 'codex',
    status: seen.state,
    since: snapshot.since,
    ...(seen.state === 'waiting' && snapshot.asking ? { waitingFor: snapshot.asking } : {}),
    ...(snapshot.state === 'halted' && snapshot.halt ? { halted: snapshot.halt.kind } : {}),
  };
}

/** A changing screen is read for a menu at most this often. */
export const CODEX_MENU_READ_MS = 2000;
/**
 * A menu gone from the screen and back within this long is the same question (one read that
 * caught it mid-redraw): it keeps its time, so it is no second "needs you".
 */
export const CODEX_MENU_SAME_MS = 10_000;

export interface CodexMenusDeps {
  /** The menu on the session's screen, or null (screen-menu.ts read). */
  read: (sessionId: string) => Promise<ScreenChoices | null>;
  /** False when reading the screen would mean replaying a large output file. */
  canRead?: (sessionId: string) => boolean;
  /** Screen change counter, undefined when unknown: an unchanged screen is not read again. */
  changeCount?: (sessionId: string) => number | undefined;
  now?: () => number;
}

/**
 * Codex waiting on a menu of its own (2026-11-10, audit row 2): its rollout says "working"
 * through an approval and nothing at all through the trust and update dialogs before the
 * first turn, so nobody offered to answer them. Read off the screen while Codex is at work or
 * has had no turn yet. Not once its turn is over: what is on screen then is the user's own
 * doing (`/model`, `/permissions`), and "Codex needs you" for it would be noise.
 */
export class CodexMenus {
  private reads = new Map<
    string,
    { at: number; count: number | undefined; value: ScreenChoices | null }
  >();
  private inFlight = new Map<string, Promise<ScreenChoices | null>>();
  /** Per session, the menu last seen: its key, since when, and when it was last on screen. */
  private asked = new Map<
    string,
    { key: string; since: number; seenAt: number; count: number | undefined }
  >();

  constructor(private readonly deps: CodexMenusDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async menu(sessionId: string): Promise<ScreenChoices | null> {
    const cached = this.reads.get(sessionId);
    if (cached) {
      const count = this.deps.changeCount?.(sessionId);
      if (count !== undefined && count === cached.count) return cached.value;
      if (this.now() - cached.at < CODEX_MENU_READ_MS) return cached.value;
    }
    if (this.deps.canRead && !this.deps.canRead(sessionId)) return cached?.value ?? null;
    let pending = this.inFlight.get(sessionId);
    if (!pending) {
      pending = (async () => {
        const count = this.deps.changeCount?.(sessionId);
        let value: ScreenChoices | null;
        try {
          value = await this.deps.read(sessionId);
        } catch {
          // A failed read is not "the menu left": what was read last stands.
          value = cached?.value ?? null;
        }
        this.reads.delete(sessionId);
        this.reads.set(sessionId, {
          at: this.now(),
          // The counter may only exist once the read created the terminal.
          count: count ?? this.deps.changeCount?.(sessionId),
          value,
        });
        if (this.reads.size > 200) this.reads.delete(this.reads.keys().next().value as string);
        return value;
      })().finally(() => this.inFlight.delete(sessionId));
      this.inFlight.set(sessionId, pending);
    }
    return pending;
  }

  /**
   * `own` (Codex's state from its rollout, undefined before its first turn) with the menu it
   * waits on, if one is on screen: waiting, with the menu's options.
   */
  async status(
    sessionId: string,
    own: SessionAgentStatus | undefined
  ): Promise<SessionAgentStatus | undefined> {
    if (own?.status === 'idle') return own;
    const menu = await this.menu(sessionId);
    if (!menu || menu.options.length < 2) return own;
    const now = this.now();
    const key = menu.key ?? `${menu.question}\n${menu.options.join('\n')}`;
    const before = this.asked.get(sessionId);
    // The same question: seen a moment ago, or on a screen that has not changed since it was
    // (however long nobody looked: a stalled timer must not make it a new one).
    const count = this.deps.changeCount?.(sessionId);
    const same =
      before?.key === key &&
      (now - before.seenAt < CODEX_MENU_SAME_MS || (count !== undefined && count === before.count));
    const since = same ? before.since : now;
    this.asked.delete(sessionId);
    this.asked.set(sessionId, { key, since, seenAt: now, count });
    if (this.asked.size > 200) this.asked.delete(this.asked.keys().next().value as string);
    return {
      agent: 'codex',
      status: 'waiting',
      since,
      ...(own?.waitingFor ? { waitingFor: own.waitingFor } : {}),
      choices: {
        question: menu.question,
        options: menu.options,
        ...(menu.detail ? { detail: menu.detail } : {}),
        ...(menu.key ? { key: menu.key } : {}),
      },
    };
  }

  /** The menu was answered, or the session is gone: the next look reads the screen again. */
  forget(sessionId: string): void {
    this.reads.delete(sessionId);
  }
}

/** A reply or an error as one line of a push (Web Push payloads are small). */
const pushLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);

export interface CodexSightingsDeps {
  /** CodexSessions.ref */
  ref: (sessionId: string) => CodexSessionRef | undefined;
  /** AgentEventService.snapshot: the session's events, read up to now. */
  snapshot: (sessionId: string) => AgentSnapshot | undefined;
  /** The conversation's title (its first prompt), for the push's "where". */
  title?: (ref: CodexSessionRef) => string | undefined;
  /** CodexMenus.status: the state with the menu Codex waits on, if any. */
  withMenu?: (
    sessionId: string,
    own: SessionAgentStatus | undefined
  ) => Promise<SessionAgentStatus | undefined>;
}

/**
 * The Codex sessions for the status notifier (ClaudeStatusNotifier `readAgents`): each one's
 * state in Claude's words, with its last message as the "finished" push's text.
 *
 * A Codex that has not had a turn yet (no rollout, so no state) is seen idle: its first turn is
 * then a change like any other, also when it began and ended between two looks. A menu it
 * waits on (CodexMenus) makes it waiting: "Codex needs you".
 */
export async function codexSightings(
  sessions: ReadonlyArray<{ id: string }>,
  deps: CodexSightingsDeps
): Promise<Map<string, AgentSighting>> {
  const seen = new Map<string, AgentSighting>();
  for (const { id } of sessions) {
    const ref = deps.ref(id);
    if (!ref) continue;
    const snapshot = deps.snapshot(id);
    if (snapshot && snapshot.source !== 'codex-rollout') continue;
    const own = codexAgentStatus(snapshot);
    // Its session ended by itself (no such event in a rollout today): nothing to tell.
    if (snapshot && !own) continue;
    let status = own;
    try {
      status = deps.withMenu ? await deps.withMenu(id, own) : own;
    } catch {
      // A screen that cannot be read: its rollout's state stands.
    }
    // What a menu asks is the push's text ("Trust this folder?").
    const asks = status?.waitingFor ?? status?.choices?.question;
    const said = snapshot?.finalMessage ?? snapshot?.halt?.message;
    let title: string | undefined;
    try {
      title = deps.title?.(ref);
    } catch {
      // The push names the session instead.
    }
    seen.set(id, {
      agent: 'codex',
      program: ref.id,
      status: {
        status: status?.status ?? 'idle',
        ...(status?.since !== undefined ? { since: status.since } : {}),
        ...(asks ? { waitingFor: asks.slice(0, 200) } : {}),
        ...(title ? { title } : {}),
        ...(said ? { preview: { role: 'assistant' as const, text: pushLine(said) } } : {}),
        ...(snapshot?.conversationId ? { sessionId: snapshot.conversationId } : {}),
      },
    });
  }
  return seen;
}

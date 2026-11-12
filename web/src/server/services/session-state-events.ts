/**
 * Agent sessions' busy / waiting / idle / exited for the public event log (event-log.ts),
 * whatever the agent (2026-11-08 review: only Claude's notifier fed it). Each agent from its
 * best source, all through `observe`:
 * - Claude: ClaudeStatusNotifier's transitions (its own status files, kept across restarts);
 * - Codex: its rollout's state (AgentEventService, read every 3 s);
 * - Gemini: its chat file (readGeminiChat, busy or idle only).
 * An event only when a session's state changes from what the log last wrote for it
 * (EventLog.latestSessionState, durable across restarts), or from one still being written; a
 * write that fails is no change, so the next observation tries again. Each event carries the
 * session's repository (`project`), also for a worktree outside it, so `--project` finds it.
 */
import type { AgentStateName } from './agent-events.js';
import type { EventInput, UntetherEvent } from './event-log.js';

export type SessionAgent = 'claude' | 'codex' | 'gemini';
export type SessionState = 'busy' | 'waiting' | 'idle';

export interface SessionStateEventsDeps {
  /** Writes the event; null when it could not (EventLog.record). */
  record: (event: EventInput) => UntetherEvent | null;
  /** The last session.state written for a session (EventLog.latestSessionState). */
  latest: (sessionId: string) => UntetherEvent | undefined;
  /** Name and folder of a session, while the server knows it. */
  session: (sessionId: string) => { name?: string; dir?: string } | undefined;
  /** A folder's repository (a worktree's main one); null outside git. */
  resolveProject: (dir: string) => Promise<string | null>;
  onError?: (message: string) => void;
}

/** A Codex (or hooked) agent's state as the log tells it; undefined: nothing to tell. */
export function sessionStateOf(
  state: AgentStateName
): { state: SessionState; reason?: string } | undefined {
  switch (state) {
    case 'working':
    case 'compacting':
      return { state: 'busy' };
    case 'permission':
    case 'question':
      return { state: 'waiting', reason: state };
    case 'halted':
      return { state: 'idle', reason: 'halted' };
    case 'starting':
    case 'turn-ended':
      return { state: 'idle' };
    case 'ended':
      return undefined;
  }
}

const PROJECT_CACHE_MAX = 500;

interface Told {
  agent: SessionAgent;
  /** state, background and reason: what makes the next observation news. */
  key: string;
  state: string;
}

export class SessionStateEvents {
  /** Observed and not written yet (its project is being resolved). */
  private readonly pending = new Map<string, Told>();
  /** Per session, its events one after the other (its project is resolved first). */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly projects = new Map<string, Promise<string | null>>();

  constructor(private readonly deps: SessionStateEventsDeps) {}

  /** What was last told of a session: the event on its way, else the one written. */
  private told(sessionId: string): Told | undefined {
    const pending = this.pending.get(sessionId);
    if (pending) return pending;
    const event = this.deps.latest(sessionId);
    if (!event) return undefined;
    return {
      agent: (event.agent as SessionAgent) ?? 'claude',
      key: keyOf(String(event.state), event.background === true, event.reason as string),
      state: String(event.state),
    };
  }

  /** What the session's agent is doing now; recorded when it changed. */
  observe(
    sessionId: string,
    agent: SessionAgent,
    state: SessionState,
    extra: { background?: boolean; reason?: string } = {}
  ): void {
    const key = keyOf(state, extra.background === true, extra.reason);
    const before = this.told(sessionId);
    if (before?.key === key) return;
    this.emit(
      sessionId,
      { agent, key, state },
      {
        type: 'session.state',
        sessionId,
        agent,
        state,
        from: before?.state,
        reason: extra.reason,
        background: extra.background ? true : undefined,
      }
    );
  }

  /** The session ended: told once, for sessions whose agent was seen. */
  exited(sessionId: string): void {
    const before = this.told(sessionId);
    if (!before || before.state === 'exited') return;
    this.emit(
      sessionId,
      { agent: before.agent, key: 'exited', state: 'exited' },
      {
        type: 'session.state',
        sessionId,
        agent: before.agent,
        state: 'exited',
        from: before.state,
      }
    );
  }

  /** Resolves once every event observed so far is recorded (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  private emit(sessionId: string, told: Told, event: EventInput): void {
    this.pending.set(sessionId, told);
    // Name and folder now: an exited session may be gone by the time its project is known.
    const info = this.deps.session(sessionId);
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const project = info?.dir ? await this.projectOf(info.dir) : null;
        this.deps.record({
          ...event,
          name: info?.name,
          dir: info?.dir,
          project: project ?? undefined,
        });
      })
      .catch((error) => this.deps.onError?.(`session event not recorded: ${String(error)}`))
      // Written or not, the log now says what was told: a failed write is told again next time.
      .finally(() => {
        if (this.pending.get(sessionId) === told) this.pending.delete(sessionId);
      });
    this.chains.set(sessionId, next);
    void next.finally(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
    });
  }

  private projectOf(dir: string): Promise<string | null> {
    let known = this.projects.get(dir);
    if (!known) {
      known = this.deps.resolveProject(dir).catch(() => null);
      this.projects.set(dir, known);
      if (this.projects.size > PROJECT_CACHE_MAX) {
        this.projects.delete(this.projects.keys().next().value as string);
      }
    }
    return known;
  }
}

function keyOf(state: string, background: boolean, reason: string | undefined): string {
  return `${state}|${background ? 'bg' : ''}|${reason ?? ''}`;
}

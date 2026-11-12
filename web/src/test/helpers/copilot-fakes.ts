/**
 * Fakes for the voice copilot's tests: a session state source fed by hand, scripted brains,
 * and session actions that record what they were asked to do.
 */
import { EventEmitter } from 'events';
import type { Brain, TurnHandle } from '../../server/services/copilot/brain';
import type { TurnRecord } from '../../server/services/copilot/copilot';
import type {
  AccessAnswer,
  MenuChoices,
  SessionAccess,
} from '../../server/services/copilot/session-access';
import type { SessionStateSource } from '../../server/services/copilot/session-source';
import type { Session } from '../../shared/types';

export class FakeSource extends EventEmitter {
  started = false;
  refreshes = 0;
  sessions: Session[] = [];
  firstLookDone = false;
  looks = 0;
  lastLookMs = 0;
  watching = false;
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
  }
  refreshSoon() {
    this.refreshes++;
  }
  current() {
    return this.sessions;
  }
  /** One look with these sessions. */
  push(sessions: Session[]) {
    this.sessions = sessions;
    this.firstLookDone = true;
    this.emit('change', sessions);
  }
  asSource(): SessionStateSource {
    return this as unknown as SessionStateSource;
  }
}

export interface FakeSessionInit {
  id: string;
  workingDir: string;
  status?: 'running' | 'exited';
  claude?: 'idle' | 'busy' | 'waiting';
  title?: string;
  choices?: MenuChoices;
  since?: number;
  userTitle?: string;
  muted?: boolean;
  background?: boolean;
}

export function fakeSession(init: FakeSessionInit): Session {
  return {
    id: init.id,
    name: `claude (${init.workingDir})`,
    command: ['claude'],
    workingDir: init.workingDir,
    status: init.status ?? 'running',
    startedAt: new Date(0).toISOString(),
    lastModified: new Date(0).toISOString(),
    pid: 100,
    userTitle: init.userTitle,
    muted: init.muted,
    claudeStatus: init.claude
      ? {
          status: init.claude,
          title: init.title,
          since: init.since ?? 1,
          ...(init.choices ? { choices: init.choices } : {}),
          ...(init.background ? { waitingForBackground: true } : {}),
        }
      : undefined,
  } as Session;
}

type Script = (content: string) => string | null;

/**
 * A brain that answers each turn with `script(content)` after `delayMs`, streamed in two
 * pieces. `null` from the script fails the turn the way a test that forbids the model wants.
 */
export function fakeBrain(script: Script, delayMs = 5) {
  const calls: string[] = [];
  const remembered: string[] = [];
  let shut = false;
  const brain = {
    model: 'fake',
    state: 'ready',
    problem: null,
    warm: async () => true,
    reset: () => undefined,
    remember: (line: string) => remembered.push(line),
    shutdown: () => {
      shut = true;
    },
    turn(content: string): TurnHandle {
      calls.push(content);
      let fn: (t: string) => void = () => undefined;
      let end: (v: { text: string; totalMs: number; cold: boolean; error?: string }) => void = () =>
        undefined;
      const done = new Promise<{ text: string; totalMs: number; cold: boolean; error?: string }>(
        (r) => {
          end = r;
        }
      );
      const text = script(content);
      const timer = setTimeout(() => {
        if (text === null) {
          end({ text: '', totalMs: delayMs, cold: false, error: 'brain' });
          return;
        }
        const half = Math.floor(text.length / 2);
        fn(text.slice(0, half));
        fn(text.slice(half));
        end({ text, totalMs: delayMs, cold: false });
      }, delayMs);
      return {
        onDelta: (f) => {
          fn = f;
        },
        done,
        cancel: () => {
          clearTimeout(timer);
          end({ text: '', totalMs: 0, cold: false });
        },
      };
    },
  };
  return {
    brain: brain as unknown as Brain,
    calls,
    remembered,
    get shut() {
      return shut;
    },
  };
}

export interface ActionCall {
  kind: 'input' | 'answer' | 'reply' | 'prompt';
  sessionId: string;
  body: unknown;
}

/** Session actions that record calls; `prompt` answers from `menus`, the rest say 200. */
export function fakeActions(
  menus: Map<string, MenuChoices | null> = new Map(),
  answers: Partial<Record<'input' | 'answer' | 'reply', AccessAnswer>> = {}
) {
  const calls: ActionCall[] = [];
  const ok: AccessAnswer = { status: 200, body: { success: true } };
  const access: SessionAccess = {
    snapshot: async () => [],
    chat: async () => ({ available: false, messages: [] }),
    prompt: async (sessionId) => {
      calls.push({ kind: 'prompt', sessionId, body: null });
      const choices = menus.get(sessionId) ?? null;
      return { status: 200, body: { waiting: Boolean(choices), choices } };
    },
    input: async (sessionId, body) => {
      calls.push({ kind: 'input', sessionId, body });
      return answers.input ?? ok;
    },
    answer: async (sessionId, body) => {
      calls.push({ kind: 'answer', sessionId, body });
      return answers.answer ?? ok;
    },
    reply: async (sessionId, body) => {
      calls.push({ kind: 'reply', sessionId, body });
      return answers.reply ?? ok;
    },
  };
  return {
    access,
    calls,
    acted: () => calls.filter((c) => c.kind !== 'prompt'),
  };
}

/** The next turn-end that matches. */
export function nextTurn(
  emitter: EventEmitter,
  match: (r: TurnRecord) => boolean = () => true,
  timeoutMs = 3000
): Promise<TurnRecord> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off('turn-end', on);
      reject(new Error('no turn ended'));
    }, timeoutMs);
    const on = (r: TurnRecord) => {
      if (!match(r)) return;
      clearTimeout(timer);
      emitter.off('turn-end', on);
      resolve(r);
    };
    emitter.on('turn-end', on);
  });
}

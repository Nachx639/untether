/**
 * Session mode («Conversar» opened inside one session's chat): the copilot sees that session
 * only. Its events come through as usual; another session needing the user or failing comes
 * through as an `aside` (at most one short line, «Por cierto, mediguiapp te necesita.»).
 */
import { EventEmitter } from 'events';
import type { CopilotObserver } from './copilot.js';
import type { CopilotEvent, Observer, SessionState } from './observer.js';

export class ScopedObserver extends EventEmitter implements CopilotObserver {
  readonly scopeSid: string;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly inner: Observer,
    readonly sessionId: string
  ) {
    super();
    this.scopeSid = inner.sidFor(sessionId);
    const onEvent = (ev: CopilotEvent) =>
      ev.id === sessionId ? this.emit('event', ev) : this.emit('aside', ev);
    const onActivity = (st: SessionState, kind: string) => {
      if (st.id === sessionId) this.emit('activity', st, kind);
    };
    const onConnection = (ok: boolean) => this.emit('connection', ok);
    const onPoll = () => this.emit('poll');
    inner.on('event', onEvent);
    inner.on('activity', onActivity);
    inner.on('connection', onConnection);
    inner.on('poll', onPoll);
    this.unsubscribe = () => {
      inner.off('event', onEvent);
      inner.off('activity', onActivity);
      inner.off('connection', onConnection);
      inner.off('poll', onPoll);
    };
  }

  get connected() {
    return this.inner.connected;
  }

  get firstPollDone() {
    return this.inner.firstPollDone;
  }

  list(): SessionState[] {
    return this.inner.list().filter((s) => s.id === this.sessionId);
  }

  /** The other sessions: their names are known (the user may say them), nothing else. */
  others(): SessionState[] {
    return this.inner.list().filter((s) => s.id !== this.sessionId && s.running);
  }

  bySid(sid: string): SessionState | undefined {
    const st = this.inner.bySid(sid);
    return st?.id === this.sessionId ? st : undefined;
  }

  /** Only this session's «done» is awaited before speaking (no merging with others). */
  settling(id: string): boolean {
    return id === this.sessionId && this.inner.settling(id);
  }

  hurry(ms?: number): void {
    this.inner.hurry(ms);
  }

  refreshDigest(st: SessionState): Promise<void> {
    return this.inner.refreshDigest(st);
  }

  describeWaiting(st: SessionState): string {
    return this.inner.describeWaiting(st);
  }

  dispose(): void {
    this.unsubscribe();
    this.removeAllListeners();
  }
}

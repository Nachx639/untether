/**
 * Sessions started with `ut <command>` in a terminal window on this computer
 * (isForwardedSession) carry `macWindow: { app }`: the app that window belongs to ("Terminal",
 * "iTerm", "Visual Studio Code", "SSH"…), found above the session's forwarder, or null when it
 * can't be told. The phone shows them under "On this Mac", marked as such.
 *
 * The session list is polled every second or so and never waits for this: each request answers
 * what was found before and starts a lookup in the background, one at a time. hostAppForPid
 * keeps its answer per process, so looking again costs a map lookup in the shared process table.
 */
import { isForwardedSession } from '../../../shared/forwarded-session.js';
import type { SessionInfo } from '../../../shared/types.js';
import { hostAppForPid } from './process-tree.js';

/** Sessions remembered at most; the oldest is forgotten first. */
const MAX_SESSIONS = 500;

type WindowSession = Pick<SessionInfo, 'id' | 'pid' | 'status'>;

export class MacWindowApps {
  /** Session id → the app found for it (kept once its process is gone). */
  private readonly apps = new Map<string, { pid: number; app: string | null }>();
  private looking: Promise<void> | null = null;

  /** `hostApp`: the app above a session's program or forwarder (hostAppForPid unless given). */
  constructor(
    private readonly hostApp: (pid: number) => Promise<string | null> = (pid) => hostAppForPid(pid)
  ) {}

  /** `macWindow` of a session: none unless it was opened with ut in a terminal window. */
  macWindow(session: Pick<SessionInfo, 'id'>): { app: string | null } | undefined {
    if (!isForwardedSession(session)) return undefined;
    return { app: this.apps.get(session.id)?.app ?? null };
  }

  /** Looks up, in the background, the app of each running forwarded session. */
  refresh(sessions: readonly WindowSession[]): void {
    if (this.looking) return;
    const running = sessions.filter(
      (session): session is WindowSession & { pid: number } =>
        isForwardedSession(session) && session.status === 'running' && !!session.pid
    );
    if (running.length === 0) return;
    this.looking = this.lookUp(running).finally(() => {
      this.looking = null;
    });
  }

  /** Resolves once the lookup running now, if any, is done (tests). */
  settled(): Promise<void> {
    return this.looking ?? Promise.resolve();
  }

  private async lookUp(sessions: Array<WindowSession & { pid: number }>): Promise<void> {
    for (const { id, pid } of sessions) {
      let app: string | null;
      try {
        app = await this.hostApp(pid);
      } catch {
        continue;
      }
      const known = this.apps.get(id);
      // Not in the process table yet (just started) says nothing: what was found stays.
      if (known?.pid === pid && app === null) continue;
      this.apps.delete(id);
      this.apps.set(id, { pid, app });
      if (this.apps.size > MAX_SESSIONS) {
        this.apps.delete(this.apps.keys().next().value as string);
      }
    }
  }
}

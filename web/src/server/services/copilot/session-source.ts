/**
 * The voice copilot's view of the local sessions, in-process: no HTTP polling. A new look is
 * taken when Claude Code rewrites a status file (`<claude dir>/sessions/<pid>.json`, watched),
 * when a session starts or exits, when the copilot asks (right after it acted), and on a backup
 * tick that covers missed file events (400 ms while a session works, 1.5 s otherwise).
 *
 * Nothing runs until start(): the server builds this at startup but only a Conversar page
 * starts it, and stop() releases the watcher and the timer.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { Session } from '../../../shared/types.js';
import { claudeConfigDir } from '../../utils/claude-dir.js';
import { loopStep } from '../../utils/periodic-loop.js';
import type { SessionAccess } from './session-access.js';

export interface SessionSourceOptions {
  access: Pick<SessionAccess, 'snapshot'>;
  /** Emits `sessionStarted` / `sessionExited` (PtyManager). */
  sessionEvents?: EventEmitter;
  /** Re-read shielded sessions' program pids before a look (PtyManager.refreshProgramPids). */
  refreshPids?: () => Promise<void>;
  claudeDir?: string;
  busyTickMs?: number;
  idleTickMs?: number;
  debounceMs?: number;
}

/**
 * Emits `change` (Session[]) after every look, `error` (unknown) when a look fails. Looks never
 * overlap: one asked for while another runs follows it.
 */
export class SessionStateSource extends EventEmitter {
  private readonly opts: Required<Omit<SessionSourceOptions, 'sessionEvents' | 'refreshPids'>> &
    Pick<SessionSourceOptions, 'sessionEvents' | 'refreshPids'>;
  private sessions: Session[] = [];
  private running = false;
  private looking: Promise<void> | null = null;
  private again = false;
  private tick?: ReturnType<typeof setTimeout>;
  private debounce?: ReturnType<typeof setTimeout>;
  private watcher: fs.FSWatcher | null = null;
  private watchRetry?: ReturnType<typeof setTimeout>;
  private fastUntil = 0;
  private readonly onSessionEvent = () => this.refreshSoon();
  /** Looks taken (for the status route). */
  looks = 0;
  lastLookMs = 0;
  firstLookDone = false;

  constructor(opts: SessionSourceOptions) {
    super();
    this.opts = {
      claudeDir: claudeConfigDir(),
      busyTickMs: 400,
      idleTickMs: 1500,
      debounceMs: 50,
      ...opts,
    };
  }

  get active(): boolean {
    return this.running;
  }

  current(): Session[] {
    return this.sessions;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.sessionEvents?.on('sessionStarted', this.onSessionEvent);
    this.opts.sessionEvents?.on('sessionExited', this.onSessionEvent);
    this.watch();
    void this.look();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.opts.sessionEvents?.off('sessionStarted', this.onSessionEvent);
    this.opts.sessionEvents?.off('sessionExited', this.onSessionEvent);
    this.watcher?.close();
    this.watcher = null;
    if (this.tick) clearTimeout(this.tick);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.watchRetry) clearTimeout(this.watchRetry);
    this.tick = this.debounce = this.watchRetry = undefined;
  }

  /** Look again shortly, and keep looking fast for `fastMs` (after the copilot acted). */
  refreshSoon(fastMs = 0): void {
    if (!this.running) return;
    if (fastMs) this.fastUntil = Math.max(this.fastUntil, Date.now() + fastMs);
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.look();
    }, this.opts.debounceMs);
    this.debounce.unref?.();
  }

  /** Take a look now (resolves when it, or the one running, is done). */
  look(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.looking) {
      this.again = true;
      return this.looking;
    }
    this.looking = (async () => {
      const t0 = Date.now();
      try {
        await this.opts.refreshPids?.().catch(() => undefined);
        const sessions = await this.opts.access.snapshot();
        if (!this.running) return;
        this.sessions = sessions;
        this.looks++;
        this.lastLookMs = Date.now() - t0;
        this.firstLookDone = true;
        this.emit('change', sessions);
      } catch (error) {
        if (this.running) this.emit('error', error);
      }
    })().finally(() => {
      this.looking = null;
      if (!this.running) return;
      if (this.again) {
        this.again = false;
        void this.look();
      } else this.schedule();
    });
    return this.looking;
  }

  private schedule() {
    if (this.tick) clearTimeout(this.tick);
    const busy = this.sessions.some(
      (s) => s.status === 'running' && s.claudeStatus && s.claudeStatus.status !== 'idle'
    );
    const ms =
      Date.now() < this.fastUntil
        ? Math.min(250, this.opts.busyTickMs)
        : busy
          ? this.opts.busyTickMs
          : this.opts.idleTickMs;
    this.tick = setTimeout(
      loopStep('copilot session source', () => this.look()),
      ms
    );
    this.tick.unref?.();
  }

  /**
   * Claude Code's status files. The folder may not exist yet (no claude has run since the
   * account was made): the backup tick covers that, and the watch is retried every 10 s.
   */
  private watch() {
    const dir = path.join(this.opts.claudeDir, 'sessions');
    try {
      this.watcher = fs.watch(dir, { persistent: false }, () => this.refreshSoon());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
        this.retryWatch();
      });
    } catch {
      this.retryWatch();
    }
  }

  private retryWatch() {
    if (!this.running || this.watchRetry) return;
    this.watchRetry = setTimeout(() => {
      this.watchRetry = undefined;
      if (this.running && !this.watcher) this.watch();
    }, 10_000);
    this.watchRetry.unref?.();
  }

  /** For the status route and tests. */
  get watching(): boolean {
    return this.watcher !== null;
  }
}

/**
 * Live terminal output for one client and one session, grouped before it goes out.
 *
 * 2026-11-02 (idea from Paseo): the cast hub hands every line of a session's cast to the
 * WebSocket hub, which sent each one as its own STDOUT frame. An agent printing fast (a
 * build log, a test run, a diff) meant thousands of frames a second to a phone, and a
 * socket that could not keep up only met MAX_CLIENT_BUFFERED_BYTES (16 MB) before it was
 * dropped. Now:
 * - output goes out at most once per STREAM_COALESCE_MS per session and client (the first
 *   chunk after a quiet spell at once, so typing echoes without delay);
 * - while the socket has more than STREAM_SOFT_BUFFERED_BYTES unsent, output waits here,
 *   still grouped, instead of piling up in the socket;
 * - once more than STREAM_MAX_PENDING_CHARS waits (a flood the client cannot follow), it is
 *   dropped and the client resynced: told how much was skipped, then given a fresh replay
 *   of the recent history (cast-output-hub resync) once its socket drained, a previous
 *   replay included (so replays never pile up).
 * Memory per client and session is bounded by STREAM_MAX_PENDING_CHARS.
 */

/** Most one STDOUT frame per session and client in this window. */
export const STREAM_COALESCE_MS = 50;
/** Live output held for one client and session before it counts as a flood (UTF-16 units). */
export const STREAM_MAX_PENDING_CHARS = 1024 * 1024;
/** A socket this far behind gets no new output until it drains below it. */
export const STREAM_SOFT_BUFFERED_BYTES = 2 * 1024 * 1024;

export interface StreamCoalescerOptions {
  /** Send one STDOUT frame with this output. */
  send: (data: string) => void;
  /** Live bytes still queued in the client's socket (history replay not counted). */
  backlog: () => number;
  /**
   * Everything still queued in the socket, a history replay included. A resync waits until
   * this drained below the soft limit, so replays never stack up behind each other.
   */
  totalBacklog?: () => number;
  /** Drop what was not sent and replay the recent history to the client. */
  resync: (skippedChars: number) => void;
  coalesceMs?: number;
  maxPendingChars?: number;
  softBufferedBytes?: number;
}

export class StreamCoalescer {
  private pending: string[] = [];
  private pendingChars = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  /** A flood was dropped: output is skipped until the resync goes out. */
  private resyncing = false;
  private skippedChars = 0;
  private disposed = false;
  private readonly coalesceMs: number;
  private readonly maxPendingChars: number;
  private readonly softBufferedBytes: number;

  constructor(private readonly options: StreamCoalescerOptions) {
    this.coalesceMs = options.coalesceMs ?? STREAM_COALESCE_MS;
    this.maxPendingChars = options.maxPendingChars ?? STREAM_MAX_PENDING_CHARS;
    this.softBufferedBytes = options.softBufferedBytes ?? STREAM_SOFT_BUFFERED_BYTES;
  }

  /** Live output of the session. */
  push(data: string): void {
    if (this.disposed || !data) return;
    if (this.resyncing) {
      // The replay the client gets once its socket drains already has this.
      this.skippedChars += data.length;
      return;
    }
    this.pending.push(data);
    this.pendingChars += data.length;
    if (this.pendingChars > this.maxPendingChars) {
      this.startResync();
      return;
    }
    if (this.timer) return;
    const wait = this.lastSentAt + this.coalesceMs - Date.now();
    if (wait <= 0) this.flush();
    else this.schedule(wait);
  }

  /**
   * Send what waits now, whatever the socket's backlog: another frame of the session (exit,
   * resize, a replay) goes out next and must come after this output.
   */
  flushNow(): void {
    if (this.disposed || this.resyncing) return;
    this.clearTimer();
    this.sendPending();
  }

  /** Whether output is being skipped until a resync (tests, logs). */
  isResyncing(): boolean {
    return this.resyncing;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.pending = [];
    this.pendingChars = 0;
  }

  private flush(): void {
    this.timer = null;
    if (this.disposed) return;
    if (this.resyncing) {
      this.tryResync();
      return;
    }
    if (!this.pendingChars) return;
    if (this.options.backlog() > this.softBufferedBytes) {
      // The socket is behind: keep grouping here and look again shortly.
      this.schedule(this.coalesceMs);
      return;
    }
    this.sendPending();
  }

  private sendPending(): void {
    if (!this.pendingChars) return;
    const data = this.pending.length === 1 ? this.pending[0] : this.pending.join('');
    this.pending = [];
    this.pendingChars = 0;
    this.lastSentAt = Date.now();
    this.options.send(data);
  }

  private startResync(): void {
    this.resyncing = true;
    this.skippedChars = this.pendingChars;
    this.pending = [];
    this.pendingChars = 0;
    this.clearTimer();
    this.tryResync();
  }

  private tryResync(): void {
    // 2026-11-02 review: a replay bypasses the live limit (it is history), so with steady
    // output and a slow phone every flood queued another full replay before the last one had
    // drained. The next replay waits until the whole socket, history included, has drained.
    const backlog = (this.options.totalBacklog ?? this.options.backlog)();
    if (backlog > this.softBufferedBytes) {
      this.schedule(this.coalesceMs);
      return;
    }
    const skipped = this.skippedChars;
    this.resyncing = false;
    this.skippedChars = 0;
    this.lastSentAt = Date.now();
    this.options.resync(skipped);
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), ms);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

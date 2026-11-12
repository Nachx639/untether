/**
 * A polling loop that a phone can afford to keep open for hours.
 *
 * - One request at a time: the next poll is scheduled only after the previous one settles
 *   (a `setInterval` stacked requests whenever the network was slower than the interval).
 * - Nothing runs while the page is hidden (tab in the background, screen locked); the poll
 *   runs at once when the page becomes visible again, so the user never sees stale data.
 * - The task may report whether its data changed; `nextDelay` gets the number of polls in a
 *   row that changed nothing, so callers can back off while nothing happens.
 */
export interface VisibilityPollerOptions {
  /** One poll. Resolve `false` when nothing changed (anything else counts as a change). */
  task: () => Promise<boolean | undefined> | Promise<void>;
  /** Milliseconds until the next poll, given how many polls in a row changed nothing. */
  nextDelay: (unchangedStreak: number) => number;
}

export class VisibilityPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private running = false;
  private unchangedStreak = 0;

  constructor(private readonly options: VisibilityPollerOptions) {}

  start() {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.schedule();
  }

  stop() {
    this.running = false;
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.clearTimer();
  }

  /** Poll now (joining one already in flight) and restart the fast cadence. */
  pollNow(): Promise<void> {
    this.unchangedStreak = 0;
    return this.run();
  }

  get isRunning() {
    return this.running;
  }

  private readonly handleVisibility = () => {
    if (!this.running) return;
    if (document.visibilityState === 'hidden') {
      this.clearTimer();
    } else {
      void this.pollNow();
    }
  };

  private run(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.clearTimer();
    this.inFlight = (async () => {
      try {
        const changed = await this.options.task();
        this.unchangedStreak = changed === false ? this.unchangedStreak + 1 : 0;
      } catch {
        // The task reports its own errors; keep polling.
      } finally {
        this.inFlight = null;
        this.schedule();
      }
    })();
    return this.inFlight;
  }

  private schedule() {
    this.clearTimer();
    if (!this.running || this.inFlight || document.visibilityState === 'hidden') return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.options.nextDelay(this.unchangedStreak));
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

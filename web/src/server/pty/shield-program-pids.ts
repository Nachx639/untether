/**
 * The pid of the program inside each shielded session (its pane in the shield tmux), which is
 * where Claude's status, chat and pushes look. It was read once, at creation or re-attach: a
 * pane respawned since (`respawn-pane`) left a dead pid there, and the notifier then watched
 * nothing for that session, with nothing in the log (suspected 2026-10-03). `refresh` reads
 * it again.
 */
export class ShieldProgramPids {
  private pids = new Map<string, number>();
  /** Sessions whose pane gave no live pid: asked again only on a full check. */
  private gone = new Set<string>();
  private refreshes = 0;

  constructor(
    private panePid: (sessionId: string) => Promise<number | null>,
    private isAlive: (pid: number) => boolean,
    /** Every this many refreshes, ask tmux for every pane, live pid or not (pid reuse). */
    private fullCheckEvery = 10,
    /**
     * Pane pids of several sessions in one tmux call (missing or null: none). Without it, or
     * for one session, `panePid` is asked per session.
     */
    private panePids?: (sessionIds: string[]) => Promise<Map<string, number | null>>
  ) {}

  get(sessionId: string): number | undefined {
    return this.pids.get(sessionId);
  }

  set(sessionId: string, pid: number): void {
    this.pids.set(sessionId, pid);
    this.gone.delete(sessionId);
  }

  /**
   * Re-read the pane pid of each of `sessionIds` (the running shielded sessions) whose stored
   * pid is missing or dead, and of all of them every `fullCheckEvery` calls: one tmux call per
   * session then, none otherwise. Forgets sessions not listed. Answers the pids that changed.
   */
  async refresh(
    sessionIds: string[]
  ): Promise<Array<{ sessionId: string; from?: number; to: number }>> {
    const full = ++this.refreshes % this.fullCheckEvery === 0;
    const listed = new Set(sessionIds);
    for (const sessionId of this.pids.keys())
      if (!listed.has(sessionId)) this.pids.delete(sessionId);
    for (const sessionId of this.gone) if (!listed.has(sessionId)) this.gone.delete(sessionId);

    const changed: Array<{ sessionId: string; from?: number; to: number }> = [];
    const toAsk = sessionIds.filter((sessionId) => {
      const stored = this.pids.get(sessionId);
      return full || !(this.gone.has(sessionId) || (stored && this.isAlive(stored)));
    });
    // 2026-11-02: one `tmux display-message` per session on every full check (20 a minute with
    // 10 shielded sessions): one `list-panes` answers them all.
    const batch = toAsk.length > 1 && this.panePids ? await this.panePids(toAsk) : null;
    await Promise.all(
      toAsk.map(async (sessionId) => {
        const stored = this.pids.get(sessionId);
        const current = batch ? (batch.get(sessionId) ?? null) : await this.panePid(sessionId);
        if (!current || !this.isAlive(current)) {
          this.gone.add(sessionId);
          return;
        }
        this.gone.delete(sessionId);
        if (current === stored) return;
        this.pids.set(sessionId, current);
        changed.push({ sessionId, from: stored, to: current });
      })
    );
    return changed;
  }
}

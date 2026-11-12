/**
 * The one place every store that keeps a session id follows a session reopened as another:
 * Blindar, "Llevar a Untether" (a `ut` session in a terminal window resumed shielded here) and
 * "Resume Claude" of an ended session. Each store registers with `followedBy`; whoever reopens
 * a session calls `replacing` before the old one ends and `replaced` once the new one runs
 * (null: reopening failed).
 *
 * 2026-10-25: moving bakery's orchestrator out of its Terminal window had to carry its role
 * (orchestrators.json, projects.json), the tasks that report to it, the confirmations it asked
 * for and its share links to the new id. Before, server.ts told the task scheduler and the
 * orchestrator one by one, and any other store keyed by session id stayed on the dead one, the
 * same class of bug as the project moves (ProjectSettingsStore.followedBy).
 *
 * 2026-10-25, first real move (bakery, fwd_1792855096880_909 → 771a8e30): every store
 * followed, yet the doctor "healed replaced-sessions … stores still pointed at fwd_…" 40 s
 * later. Its list of referenced ids was its own (server.ts) and counted merged tasks, which
 * the scheduler rightly leaves on the session that ran them, and it said "healed" without
 * anything moving. Now each store says which ids it follows (`references`, the doctor's list)
 * and how many records it moved (`replaced`), and `replaced` names the stores that moved.
 */
export interface SessionReplacementFollower {
  /** `sessionId` is about to end because it is reopened as another: its end is not its own. */
  replacing?(sessionId: string): void;
  /** It was not reopened and still runs (its program outlived the close): nothing moves. */
  notReplaced?(sessionId: string): void;
  /** It was reopened as `newSessionId` (null: reopening failed); how many records moved. */
  replaced(
    oldSessionId: string,
    newSessionId: string | null,
    options: SessionReplacedOptions
  ): number | Promise<number>;
  /** The session ids it keeps and would move on `replaced` (the doctor looks at these). */
  references(): string[];
}

/** A store that moved records on `replaced`, and how many. */
export interface SessionReplacementMove {
  name: string;
  moved: number;
}

export interface SessionReplacedOptions {
  /** Its Claude conversation was resumed by hand ("Resume Claude" of an ended session). */
  resumed?: boolean;
}

export class SessionReplacements {
  private readonly followers: Array<{ name: string; follower: SessionReplacementFollower }> = [];

  constructor(private readonly log: (message: string) => void = () => {}) {}

  followedBy(name: string, follower: SessionReplacementFollower): void {
    this.followers.push({ name, follower });
  }

  /** The names of the stores that follow (the doctor and tests list them). */
  names(): string[] {
    return this.followers.map(({ name }) => name);
  }

  /** Every session id some store would move, once each. */
  references(): string[] {
    const ids = new Set<string>();
    for (const { name, follower } of this.followers) {
      try {
        for (const id of follower.references()) if (id) ids.add(id);
      } catch (error) {
        this.log(`${name} failed to list the sessions it keeps: ${error}`);
      }
    }
    return [...ids];
  }

  replacing(sessionId: string): void {
    for (const { name, follower } of this.followers) {
      try {
        follower.replacing?.(sessionId);
      } catch (error) {
        this.log(`${name} failed to hold session ${sessionId} being reopened: ${error}`);
      }
    }
  }

  notReplaced(sessionId: string): void {
    for (const { name, follower } of this.followers) {
      try {
        follower.notReplaced?.(sessionId);
      } catch (error) {
        this.log(`${name} failed to release session ${sessionId} left running: ${error}`);
      }
    }
  }

  /** Every follower hears it, whatever another one threw; the stores that moved records. */
  async replaced(
    oldSessionId: string,
    newSessionId: string | null,
    options: SessionReplacedOptions = {}
  ): Promise<SessionReplacementMove[]> {
    const moves: SessionReplacementMove[] = [];
    for (const { name, follower } of this.followers) {
      try {
        const moved = await follower.replaced(oldSessionId, newSessionId, options);
        if (moved > 0) moves.push({ name, moved });
      } catch (error) {
        this.log(
          `${name} failed to follow session ${oldSessionId} reopened as ${newSessionId}: ${error}`
        );
      }
    }
    return moves;
  }
}

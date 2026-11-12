/**
 * Nothing Untether types for an agent ever lands on what the user is writing or has just sent
 * (2026-11-10: another agent's reply arrived stuck to a message of the user's, as one turn). The
 * last stretch of a delivery is still typing into the agent's prompt, so before it types (and
 * again right before the keys go in) the delivery asks here whether the user's own input is
 * in the way:
 *
 * - the user pressed a key in that session in the last USER_TYPING_QUIET_MS: writing now, or
 *   just sent (the agent's status takes a moment to say "busy");
 * - the agent's input box holds text (read off the screen: text in the default colour after
 *   the prompt mark; a placeholder is greyed and does not count);
 * - the agent is at work and the user typed since its turn began: that text waits in the
 *   agent's own queue, and a second message typed now would be merged into the same turn.
 *
 * While any holds, the message stays in Untether's queue (where it was) and is tried again.
 */
import { type BufferCell, CELL_ATTR } from '../../shared/terminal-text-formatter.js';

/** A key this recent is the user writing, or a message just sent. */
export const USER_TYPING_QUIET_MS = 5000;
/** Without the agent's turn events: how long the user's keys count as a message still queued. */
export const USER_QUEUED_FALLBACK_MS = 2 * 60_000;

// One table of bits with the buffer snapshot (CELL_ATTR): DIM is its faint, 0x08. Invisible
// text is no draft either.
const { DIM, INVERSE, INVISIBLE } = CELL_ATTR;
/** The prompt mark of Claude Code (❯) and Codex (› or its block cursor ▌). */
const PROMPT_MARK = /^[❯›▌]$/;
/** Only the bottom of the screen is the input box (older turns show "❯ text" too). */
const INPUT_ROWS = 14;

/**
 * Whether the agent's input box holds text of the user's: on the last prompt line near the
 * bottom, a visible character in the default colour that is neither dimmed nor the cursor
 * (Claude Code and Codex draw their placeholder greyed and their cursor inverted).
 */
export function draftOnScreen(cells: BufferCell[][]): boolean {
  const from = Math.max(0, cells.length - INPUT_ROWS);
  for (let row = cells.length - 1; row >= from; row--) {
    const line = cells[row];
    const mark = line.findIndex((cell) => cell.char.trim() !== '');
    if (mark < 0 || !PROMPT_MARK.test(line[mark].char)) continue;
    return line.slice(mark + 1).some((cell) => {
      if (!cell.char.trim()) return false;
      const attributes = cell.attributes ?? 0;
      return cell.fg === undefined && !(attributes & (DIM | INVERSE | INVISIBLE));
    });
  }
  return false;
}

export interface UserInputState {
  now: number;
  /** The user's last key in the session (PtyManager.lastUserInputAt). */
  lastUserKeyAt?: number;
  /** The agent's last turn start or message taken in (its events), when known. */
  lastTurnAt?: number;
  /** The agent is at work (the text would go into its own queue). */
  busy: boolean;
  /** draftOnScreen; undefined when the screen could not be read. */
  draft?: boolean;
}

/** Why Untether must not type now (logged, shown as what the message waits for), or null. */
export function userInputHold(state: UserInputState): string | null {
  const { now, lastUserKeyAt, lastTurnAt, busy, draft } = state;
  if (lastUserKeyAt !== undefined && now - lastUserKeyAt < USER_TYPING_QUIET_MS) {
    return 'the user is typing or has just sent a message';
  }
  if (draft) return 'the user has unsent text in its input';
  const sinceTurn =
    lastUserKeyAt !== undefined &&
    (lastTurnAt !== undefined
      ? lastUserKeyAt > lastTurnAt
      : now - lastUserKeyAt < USER_QUEUED_FALLBACK_MS);
  if (busy && sinceTurn) return 'a message of the user waits in its queue';
  // A screen that cannot be read may hide a draft: only the user's recent keys say so.
  if (draft === undefined && sinceTurn) return 'the user typed and its screen cannot be read';
  return null;
}

export interface UserHoldDeps {
  /** The user's last key in the session (PtyManager.lastUserInputAt). */
  lastUserKeyAt(sessionId: string): number | undefined;
  /** The agent's own events for the session, when it reports any (agent-events.ts). */
  agentState(
    sessionId: string
  ): { turnStartedAt?: number; turnEndedAt?: number; lastUserInputAt?: number } | undefined;
  /** Claude Code says it is at work (its status file); false for other agents. */
  claudeBusy(sessionId: string): Promise<boolean>;
  /** The session's screen. */
  cells(sessionId: string): Promise<BufferCell[][]>;
  now?: () => number;
}

/** userInputHold for a live session: its keys, its agent's turn and its screen. */
export function createUserHold(deps: UserHoldDeps): (sessionId: string) => Promise<string | null> {
  return async (sessionId) => {
    const events = deps.agentState(sessionId);
    const lastTurnAt = events
      ? Math.max(events.turnStartedAt ?? 0, events.lastUserInputAt ?? 0) || undefined
      : undefined;
    const working =
      events?.turnStartedAt !== undefined && events.turnStartedAt > (events.turnEndedAt ?? 0);
    const busy = working || (await deps.claudeBusy(sessionId).catch(() => false));
    const draft = await deps
      .cells(sessionId)
      .then(draftOnScreen)
      .catch(() => undefined);
    return userInputHold({
      now: (deps.now ?? Date.now)(),
      lastUserKeyAt: deps.lastUserKeyAt(sessionId),
      lastTurnAt,
      busy,
      draft,
    });
  };
}

/**
 * Reading and answering the menu on a session's screen: the list's quick answers and the
 * answer sheet (POST /api/sessions/:id/answer), and "Share with phone" confirming the folder
 * Claude already trusted (services/mac-sessions/share.ts).
 *
 * A menu is read like the phone reads its copy (TerminalManager.getRecentText): the key of a
 * menu read here and on the phone covers the same lines, its dialog's top included where it
 * scrolled out of sight. Its cursor is moved with the arrow keys one at a time, and Enter is
 * only pressed once the screen shows the cursor on the option: one landing before the menu
 * redrew would confirm the option the cursor was on (in the trust-folder dialog, "No, exit").
 */
import {
  looseText,
  parseScreenChoices,
  type ScreenChoices,
  sameShownMenu,
} from '../../shared/claude-screen.js';
import type { SessionInput } from '../../shared/types.js';

/** Lines read for a menu, as the phone's composer reads them: its dialog's top within reach. */
export const MENU_READ_LINES = 60;
/** Between arrow keys sent to a menu, and how long it may take to show the cursor moved. */
export const MENU_KEY_GAP_MS = 80;
export const MENU_REDRAW_WAIT_MS = 2000;
/** How long a menu may stay on screen after the Enter that answered it. */
export const MENU_ANSWER_WAIT_MS = 3000;

export interface ScreenMenuDeps {
  /** TerminalManager.getRecentText */
  recentText(
    sessionId: string,
    lines: number
  ): Promise<{ text: string; cols?: number; rows?: number; wrappedRows?: boolean[] }>;
  /** PtyManager.sendInput */
  sendInput(sessionId: string, input: SessionInput): void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Picks `option` (1-based) of `menu` on a session's screen; says whether it landed. */
export type AnswerScreenMenu = (
  sessionId: string,
  menu: ScreenChoices,
  option: number
) => Promise<'ok' | 'changed' | 'not-delivered'>;

export interface ScreenMenu {
  /** The menu waiting on the session's screen, or null. */
  read(sessionId: string): Promise<ScreenChoices | null>;
  /**
   * Moves the cursor of `menu` to option `target` (0-based) and reports whether the screen then
   * shows it there, in the same menu. Enter is the caller's, and only after a true.
   */
  moveCursor(sessionId: string, menu: ScreenChoices, target: number): Promise<boolean>;
  /**
   * Whether `menu`, just answered, left the screen: true once another menu or none is there,
   * false when it is still up after MENU_ANSWER_WAIT_MS (the answer did not land).
   */
  waitGone(sessionId: string, menu: ScreenChoices): Promise<boolean>;
}

const sameQuestion = (a: ScreenChoices | null, b: ScreenChoices) =>
  looseText(a?.question ?? '') === looseText(b.question);

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createScreenMenu(deps: ScreenMenuDeps): ScreenMenu {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;

  async function read(sessionId: string): Promise<ScreenChoices | null> {
    const recent = await deps.recentText(sessionId, MENU_READ_LINES);
    return parseScreenChoices(recent.text, {
      cols: recent.cols,
      wrappedRows: recent.wrappedRows,
      visibleRows: recent.rows,
    });
  }

  async function moveCursor(
    sessionId: string,
    menu: ScreenChoices,
    target: number
  ): Promise<boolean> {
    const from = menu.cursor ?? 0;
    const key = target > from ? 'arrow_down' : 'arrow_up';
    for (let moved = 0; moved < Math.abs(target - from); moved++) {
      deps.sendInput(sessionId, { key });
      await sleep(MENU_KEY_GAP_MS);
    }
    const options = JSON.stringify(menu.options);
    const deadline = now() + MENU_REDRAW_WAIT_MS;
    for (;;) {
      const current = await read(sessionId);
      if (
        current?.navigate &&
        current.cursor === target &&
        JSON.stringify(current.options) === options
      ) {
        return true;
      }
      if (now() >= deadline) return false;
      await sleep(50);
    }
  }

  async function waitGone(sessionId: string, menu: ScreenChoices): Promise<boolean> {
    const deadline = now() + MENU_ANSWER_WAIT_MS;
    for (;;) {
      const current = await read(sessionId);
      // Yes/no questions have no key and share their options: the question tells them apart.
      if (!sameShownMenu(current, menu) || !sameQuestion(current, menu)) return true;
      if (now() >= deadline) return false;
      await sleep(50);
    }
  }

  return { read, moveCursor, waitGone };
}

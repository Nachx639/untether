/**
 * Where a full-screen app that scrolls its own content stands in its history, for our
 * scrollbar.
 *
 * Claude Code's full screen (alternate screen, a prompt bar pinned at the bottom) and tmux
 * turn on mouse reporting: a scroll goes to them as wheel steps and the terminal's own view
 * never moves, so it has no history to place a scrollbar from. Sessions started from Untether
 * run Claude Code that way, and showed no scrollbar while scrolling where Mac-window sessions
 * (classic mode, local history) did (user report, 2026-10-14).
 *
 * Nothing tells the terminal how far back the app is, so it is measured. After wheel steps are
 * sent, each new screen is compared with the one before: the vertical shift that lines most
 * changed rows up again is how many rows the app moved, whatever its rows per step or its
 * acceleration. Rows that did not change (a pinned bar, blank space) take no part. A repaint
 * that matches no shift counts the steps at the rows per step measured last. Wheel steps up
 * that nothing answers mean the top was reached: from then on the length of the history is
 * known, and before that it is estimated a little beyond the furthest point seen.
 */

/** Rows one wheel step moves until a shift has been measured (Claude Code, tmux). */
const DEFAULT_ROWS_PER_STEP = 3;
/** Rows per step measured lately, the most of which is taken (see shifted). */
const PER_STEP_SAMPLES = 8;
/** A shift on screen this long after a wheel step is that step's answer. */
const ANSWER_WINDOW_MS = 1500;
/** Wheel steps still unanswered this long after the last one: the app is at an end. */
export const APP_SCROLL_SETTLE_MS = 450;
/** A screen no shift explains counts once it stayed as it is this long (ms). */
export const HOLD_MS = 120;

/**
 * The vertical shift from `before` to `after`: + the content moved down (the view went back
 * into the history), − up; 0 nothing that moved changed; null a change no shift explains (a
 * repaint, or screens of different sizes). Rows equal at the same place (a pinned bar, blank
 * space) are left out, and so are rows blank after (maybe not drawn yet); at least half the
 * changed rows must line up again.
 */
export function detectShift(before: readonly string[], after: readonly string[]): number | null {
  const n = before.length;
  if (n === 0 || after.length !== n) return null;
  const changed: number[] = [];
  for (let i = 0; i < n; i++) {
    if (before[i] !== after[i] && before[i].trim() !== '') changed.push(i);
  }
  if (changed.length === 0) {
    // Only rows that were blank changed: something was written, nothing moved.
    return before.every((row, i) => row === after[i]) ? 0 : null;
  }
  let best = 0;
  let bestScore = 0;
  for (let k = 1 - n; k < n; k++) {
    if (k === 0) continue;
    let eligible = 0;
    let score = 0;
    for (const i of changed) {
      const j = i + k;
      // A blank row there may be one not drawn yet (a frame arriving in more than one write).
      if (j < 0 || j >= n || after[j].trim() === '') continue;
      eligible++;
      if (after[j] === before[i]) score++;
    }
    if (score < 2 || score * 2 < eligible) continue;
    if (score > bestScore || (score === bestScore && Math.abs(k) < Math.abs(best))) {
      best = k;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Whether two screens are the same frame: a few rows may differ, as a spinner or a status line
 * keeps changing while the rest stays (a busy Claude Code).
 */
function sameFrame(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const differ = a.filter((row, i) => row !== b[i]).length;
  return differ <= Math.max(2, Math.floor(a.length / 8));
}

export class AppScrollTracker {
  /** Rows the app's view is back from its bottom, as measured. */
  private rowsBack = 0;
  /** Rows of history above the app's bottom view; exact once the top was reached. */
  private historyRows = 0;
  private topKnown = false;
  private furthest = 0;
  private perStep = DEFAULT_ROWS_PER_STEP;
  private perStepSeen: number[] = [];
  /** Wheel steps sent that no shift on screen has answered yet: + up, − down. */
  private unanswered = 0;
  private lastWheelAt = Number.NEGATIVE_INFINITY;
  /** The way the last wheel steps went: 1 up, −1 down. */
  private direction = 0;
  private screen: string[] | null = null;
  /** A screen no shift explains, waiting for the rest of its frame, and since when. */
  private held: { screen: string[]; since: number; steps: number } | null = null;
  private width = 0;
  private scrolled = false;

  /** A wheel was sent since the last reset: the position means something. */
  get active(): boolean {
    return this.scrolled;
  }

  get offset(): number {
    return this.rowsBack;
  }

  /** Whether the next wheel needs a screen to compare the app's answer with. */
  get needsScreen(): boolean {
    return this.screen === null;
  }

  /** Rows of history above the app's bottom view: measured, or estimated until the top. */
  get total(): number {
    if (this.topKnown) return Math.max(this.historyRows, this.rowsBack);
    const seen = Math.max(this.furthest, this.rowsBack);
    // At least a screen more than seen, and more the further it goes: the thumb shrinks as the
    // history uncovers, never claiming a top it has not reached.
    return seen + Math.max(this.screen?.length ?? 24, Math.round(seen / 2));
  }

  /** Where the view will be once the steps on their way are answered. */
  get expectedOffset(): number {
    return Math.max(0, this.rowsBack + this.unanswered * this.perStep);
  }

  /** A screen waits for the rest of its frame: look again in a moment (HOLD_MS). */
  get holding(): boolean {
    return this.held !== null;
  }

  get rowsPerStep(): number {
    return this.perStep;
  }

  reset() {
    this.rowsBack = 0;
    this.historyRows = 0;
    this.topKnown = false;
    this.furthest = 0;
    this.unanswered = 0;
    this.lastWheelAt = Number.NEGATIVE_INFINITY;
    this.direction = 0;
    this.screen = null;
    this.held = null;
    this.scrolled = false;
  }

  /** The screen as it is now, `width` columns wide (a new width: the history reflows). */
  observe(screen: readonly string[], width: number): boolean {
    if (this.screen && (screen.length !== this.screen.length || width !== this.width)) {
      this.reset();
    }
    this.width = width;
    const before = this.screen;
    this.screen = screen.slice();
    return before !== null;
  }

  /** `steps` wheel steps were sent: + up (into the history), − down. */
  wheel(steps: number, now: number) {
    if (steps === 0) return;
    if (Math.sign(steps) !== Math.sign(this.unanswered)) this.unanswered = 0;
    this.unanswered += steps;
    this.direction = Math.sign(steps);
    this.lastWheelAt = now;
    this.scrolled = true;
  }

  /** A new screen from the app. Returns whether the position changed. */
  frame(screen: readonly string[], width: number, now: number): boolean {
    const before = this.screen;
    const sameSize = before !== null && before.length === screen.length && width === this.width;
    this.observe(screen, width);
    if (!before || !sameSize) return false;
    const shift = detectShift(before, screen);
    if (shift !== null) {
      this.held = null;
      return this.shifted(shift, now);
    }
    // Maybe a frame half drawn (its rows arrive in more than one write): the next screen is
    // compared with the last one understood, until this one stays as it is for a moment.
    const held = this.held;
    if (held) {
      const fromHeld = detectShift(held.screen, screen);
      if (fromHeld !== null) {
        // The screen held was a whole frame after all: a repaint, and then this.
        this.held = null;
        const repainted = this.repainted(before, held.screen, now, held.steps);
        return this.shifted(fromHeld, now) || repainted;
      }
      if (now - held.since >= HOLD_MS && sameFrame(held.screen, screen)) {
        this.held = null;
        return this.repainted(before, screen, now, held.steps);
      }
    }
    if (!held || !sameFrame(held.screen, screen)) {
      this.held = { screen: screen.slice(), since: now, steps: this.unanswered };
    }
    this.screen = before.slice();
    return false;
  }

  /** The app's content moved `shift` rows (+ into the history). */
  private shifted(shift: number, now: number): boolean {
    if (shift === 0) return false;
    // Steps answer over several frames (a fling sends some every frame): any shift their way
    // soon after one is theirs, answered or not yet.
    const answering = now - this.lastWheelAt <= ANSWER_WINDOW_MS;
    if (answering && Math.sign(shift) === this.direction) {
      if (this.unanswered !== 0) {
        // A frame may answer only some of the steps on their way, which reads low: the most
        // of the last few is the rows per step.
        this.perStepSeen = [
          ...this.perStepSeen.slice(1 - PER_STEP_SAMPLES),
          Math.max(1, Math.round(Math.abs(shift) / Math.abs(this.unanswered))),
        ];
        this.perStep = Math.max(...this.perStepSeen);
        this.unanswered = 0;
      }
      this.moveBy(shift);
      return true;
    }
    if (!answering && shift < 0 && this.rowsBack > 0) {
      // Back in the history, the app moved toward its bottom by itself (a tap on its "Jump to
      // bottom" a little way up): what took it past the bottom is new output.
      const past = Math.max(0, -shift - this.rowsBack);
      this.moveBy(shift);
      if (this.topKnown) this.historyRows += past;
      return true;
    }
    if (!answering && shift < 0 && this.rowsBack === 0 && this.topKnown) {
      // New output at the bottom pushed the history up: there is that much more of it.
      this.historyRows += -shift;
      return true;
    }
    return false;
  }

  /**
   * A repaint no shift explains. Only one that replaced most of the screen while steps were on
   * their way counts as their answer (not a spinner or a status line); rows only filled in or
   * cleared (a frame finishing, or starting) replaced nothing. It answers the `sent` steps that
   * were on their way when it showed, not the ones sent since (a fling at the top goes on).
   */
  private repainted(
    before: readonly string[],
    after: readonly string[],
    now: number,
    sent: number
  ): boolean {
    const steps =
      Math.sign(sent) === Math.sign(this.unanswered)
        ? Math.sign(sent) * Math.min(Math.abs(sent), Math.abs(this.unanswered))
        : 0;
    const replaced = before.filter(
      (row, i) => row !== after[i] && row.trim() !== '' && after[i].trim() !== ''
    ).length;
    if (replaced * 2 < after.length) return false;
    if (
      steps === 0 &&
      this.unanswered === 0 &&
      this.rowsBack > 0 &&
      now - this.lastWheelAt > APP_SCROLL_SETTLE_MS
    ) {
      // A screen replaced with no scroll on its way, back in the history: a tap on the app's
      // "Jump to bottom" (or a new view of it), which shows its bottom.
      this.rowsBack = 0;
      return true;
    }
    if (steps === 0 || now - this.lastWheelAt > ANSWER_WINDOW_MS) return false;
    this.moveBy(steps * this.perStep);
    this.unanswered -= steps;
    return true;
  }

  /** Steps the app never answered: it was already at that end. Returns whether it moved. */
  settle(now: number): boolean {
    if (this.unanswered === 0 || now - this.lastWheelAt < APP_SCROLL_SETTLE_MS) return false;
    const up = this.unanswered > 0;
    this.unanswered = 0;
    if (up) {
      this.historyRows = this.rowsBack;
      this.topKnown = true;
    } else {
      this.rowsBack = 0;
    }
    return true;
  }

  /** A prompt was sent: the app shows its bottom again. */
  submitted() {
    if (!this.scrolled) return;
    this.rowsBack = 0;
    this.unanswered = 0;
  }

  private moveBy(rows: number) {
    this.rowsBack = Math.max(0, this.rowsBack + rows);
    this.furthest = Math.max(this.furthest, this.rowsBack);
    if (this.topKnown && this.rowsBack > this.historyRows) {
      // The top was a late answer, not the top.
      this.topKnown = false;
    }
  }
}

/**
 * Input diagnostics (2026-11-11): what a device measures about its keyboard and its terminal
 * while the mode is on (Settings → Advanced, or `?kbdebug=1`), sent to the server in batches.
 * Numbers and a few fixed words only: never what was typed, never what the screen shows.
 *
 * The client fills these in (client/utils/input-diagnostics.ts), the server checks them field
 * by field, logs them and keeps them for `ut diag input` (server/services/input-diagnostics.ts).
 */

/** Who was in the session measured: an agent, a plain shell, or no session (the list). */
export const DIAG_AGENTS = ['claude', 'codex', 'gemini', 'shell', 'none'] as const;
export type DiagAgent = (typeof DIAG_AGENTS)[number];

/** What a keyboard sample was taken after. */
export const DIAG_KEYBOARD_SOURCES = [
  'start',
  'vv-resize',
  'vv-scroll',
  'resize',
  'focusin',
  'focusout',
  'orientation',
] as const;
export type DiagKeyboardSource = (typeof DIAG_KEYBOARD_SOURCES)[number];

export const DIAG_SCROLL_PLACES = ['terminal', 'list'] as const;
export type DiagScrollPlace = (typeof DIAG_SCROLL_PLACES)[number];

/** Where a measure was taken: the agent, the network and the interface style. */
export interface DiagContext {
  agent: DiagAgent;
  /** How the device reaches the Mac and, when the browser tells, its connection: "tailscale/4g". */
  net: string;
  /** The interface style (data-look), "original" for the default one. */
  look: string;
}

/**
 * One measure of the soft keyboard. `safari` and `baseline` are the two ways the app has
 * computed its height (innerHeight minus the visual viewport; the same, or the shrink from the
 * tallest viewport seen at this width); `applied` is the height the layout ended up with.
 */
export interface DiagKeyboardRecord {
  kind: 'kbd';
  at: number;
  src: DiagKeyboardSource;
  /** window.innerHeight, visualViewport.height / offsetTop / width. */
  ih: number;
  vvh: number;
  vvt: number;
  w: number;
  /** The tallest visual viewport seen at this width (0: no session open to track it). */
  base: number;
  safari: number;
  baseline: number;
  applied: number;
  /** 1 when something a keyboard could be up for had the focus (a field, a frame), else 0. */
  edit: number;
}

/**
 * A stretch with the keyboard's gap applied and nothing editable focused (2026-11-11: the gap
 * with no keyboard). The two heights of a `kbd` sample can be wrong in the same way; this one
 * does not go by them. The keyboard closing normally leaves short ones (its animation); one
 * longer than DIAG_GAP_STUCK_MS is a gap the user saw with no keyboard.
 */
export interface DiagGapRecord extends DiagContext {
  kind: 'gap';
  /**
   * A random number per stretch: one that leaves in several batches keeps it, so its pieces
   * are added up with each other and with nothing else (two tabs or two phones share a browser).
   */
  id: number;
  /** When it began. */
  at: number;
  /** How long it lasted (so far, for one still there when the batch left: `open` is 1). */
  ms: number;
  /** The tallest gap applied meanwhile. */
  px: number;
  open: number;
}

/** A minute of key presses: ms from the key leaving to the first frame after its echo arrived. */
export interface DiagKeysRecord extends DiagContext {
  kind: 'keys';
  at: number;
  n: number;
  p50: number;
  p95: number;
  max: number;
}

/** A minute of scrolling in one place: frame durations in ms while the gesture lasted. */
export interface DiagScrollRecord extends DiagContext {
  kind: 'scroll';
  at: number;
  where: DiagScrollPlace;
  frames: number;
  p50: number;
  p95: number;
  /** Frames longer than 50 ms. */
  slow: number;
}

/** Opening a session: ms until the first frame after its terminal got output. */
export interface DiagOpenRecord extends DiagContext {
  kind: 'open';
  at: number;
  ms: number;
}

/** The WebSocket came back: ms it was down. */
export interface DiagSocketRecord extends DiagContext {
  kind: 'ws';
  at: number;
  ms: number;
}

export type DiagRecord =
  | DiagKeyboardRecord
  | DiagKeysRecord
  | DiagScrollRecord
  | DiagOpenRecord
  | DiagSocketRecord
  | DiagGapRecord;

export interface DiagBatch {
  /** navigator.userAgent, cut to 300 characters. */
  ua: string;
  records: DiagRecord[];
}

export const DIAG_MAX_RECORDS_PER_BATCH = 400;
export const DIAG_MAX_UA_LENGTH = 300;
/** A gap with nothing editable focused for longer than this is not a keyboard closing. */
export const DIAG_GAP_STUCK_MS = 1500;
/** A frame this long or longer is one the user sees. */
export const DIAG_SLOW_FRAME_MS = 50;

/** The value at a share of a list of numbers (p in 0..1), 0 for an empty one. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

/**
 * Soft keyboard height from viewport sizes. Safari: innerHeight minus the visual viewport.
 * Chrome on iOS shrinks innerHeight too, so compare with the tallest viewport seen at this
 * width; under 150 px that is the browser's own bars collapsing, not a keyboard.
 */
export function estimateKeyboardHeight(
  innerHeight: number,
  viewportHeight: number,
  tallestViewport: number
): number {
  const safari = innerHeight - viewportHeight;
  const shrink = tallestViewport - viewportHeight;
  return Math.max(0, safari, shrink >= 150 ? shrink : 0);
}

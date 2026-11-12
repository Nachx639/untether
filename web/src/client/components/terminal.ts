/**
 * Terminal Component
 *
 * Browser terminal rendering + input via ghostty-web (WASM + canvas).
 *
 * @fires terminal-ready - When terminal is initialized and ready
 * @fires terminal-input - When user types (detail: { text: string, scroll?: true for wheel reports })
 * @fires terminal-resize - When terminal is resized (detail: { cols: number, rows: number, isMobile: boolean, isHeightOnlyChange: boolean, source: string })
 */

import { FitAddon, Terminal as GhosttyTerminal } from 'ghostty-web';
import { html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { serverConfigService } from '../services/server-config-service.js';
import { toast } from '../utils/action-toast.js';
import { KeyboardShortcutLinkProvider } from '../utils/keyboard-shortcut-link-provider.js';
import { createLogger } from '../utils/logger.js';
import {
  arrowKeys,
  type CellPoint,
  findPromptRows,
  type PromptRowCells,
  planPromptCaret,
  promptCharacterSteps,
} from '../utils/prompt-caret.js';
import { ScrollPerfRecorder, scrollPerfRequested } from '../utils/scroll-perf.js';
import { TERMINAL_FONT_FAMILY, TERMINAL_IDS } from '../utils/terminal-constants.js';
import {
  loadTerminalIconFonts,
  onTerminalFontsLoaded,
  waitForTerminalFonts,
} from '../utils/terminal-fonts.js';
import {
  TERMINAL_THEME_CHANGED_EVENT,
  TerminalPreferencesManager,
} from '../utils/terminal-preferences.js';
import { resolveTerminalTheme, type TerminalThemeId } from '../utils/terminal-themes.js';
import { getCurrentTheme } from '../utils/theme-utils.js';
import { icon } from './icons.js';
import { APP_SCROLL_SETTLE_MS, AppScrollTracker, HOLD_MS } from './terminal-app-scroll.js';
import { canvasSizeMismatch, describeCanvas } from './terminal-canvas-health.js';
import { type AppCopyResult, copyPreview, DesktopCopy } from './terminal-clipboard.js';
import { createGhostty } from './terminal-ghostty.js';
import { openEscapeTail, resizeKeepingBottom } from './terminal-grow.js';
import { paintCellRow } from './terminal-peek-row.js';
import { currentPixelRatio, syncRendererPixelRatio } from './terminal-pixel-ratio.js';
import {
  fillFontSize,
  forgetMeasuredAdvances,
  measureAdvance,
  snappedCellWidth,
  TOUCH_SCROLLBAR_WIDTH,
  touchCellWidth,
  touchColsFor,
  touchScrollbarGap,
  touchTextArea,
} from './terminal-touch-cells.js';
import { TouchScroller } from './terminal-touch-scroll.js';
import { TOUCH_SELECT_STYLES, TouchSelection } from './terminal-touch-select.js';

const logger = createLogger('terminal');
/** How long a tap's caret move waits for Claude to redraw the caret on the tapped row. */
const CARET_MOVE_TIMEOUT_MS = 1500;
/**
 * Output quiet time before a tap's caret move reads the cursor. Claude redraws its prompt row by
 * row and only then puts the cursor back on the caret, so a frame split across two writes leaves
 * the cursor for a moment at the end of a drawn row, which may be the tapped one.
 */
const CARET_SETTLE_MS = 40;

/** Hold time for a still finger to start selecting text (phones). */
const LONG_PRESS_MS = 500;

/** How long after a touch ends mouse events count as iOS's emulation of that touch. */
const EMULATED_MOUSE_MS = 1000;

/** Our scrollbar stays this long after the view stops moving. */
const SCROLLBAR_HIDE_MS = 1000;
/** Gap above and below its thumb's travel, and the thumb's least height (CSS px). */
const SCROLLBAR_INSET = 3;
const SCROLLBAR_MIN_THUMB = 24;
/**
 * Longest a history replay holds the paint (holdPaint): 16 MB on a slow phone link takes a
 * while, but a replay whose end never comes must not leave the canvas frozen.
 */
const PAINT_HOLD_MAX_MS = 15000;
/** How long after a replay ends the screen still counts as settling (isScreenSettling). */
const SCREEN_SETTLE_MS = 400;
/** A replay holding the paint longer than this shows "Loading history…" over the terminal. */
const LOADING_HISTORY_AFTER_MS = 300;

/** Smallest type a PTY wider than this screen is shown at (see followPtySize). */
const PTY_FIT_MIN_FONT = 6;
/** Largest type a PTY narrower than this screen is shown at, as a multiple of the user's. */
const PTY_FIT_MAX_SCALE = 1.5;
/** After the terminal is ready, when its canvas is checked and remade (see renewCanvas). */
const CANVAS_SETTLE_MS = 1500;
/** After a held replay is let go, the same. */
const CANVAS_RELEASED_MS = 1000;
/** A canvas mid-gesture (shifted between rows, pinched) is remade this much later. */
const CANVAS_RENEW_RETRY_MS = 500;
/**
 * At most this much buffered output in one ghostty write: on a cold start the whole replay
 * that came before the WASM was ready (up to 16 MB) went in one, and ghostty could not
 * allocate it ("RangeError: Offset should not be negative" from its write, 2026-10-12): the
 * terminal was left half set up, without its resize observer or its ready event.
 */
const PENDING_WRITE_CHUNK = 256 * 1024;
/** The parts of ghostty's CanvasRenderer the touch cells reach (private in ghostty-web 0.4). */
interface CellRenderer {
  metrics?: { width: number; height: number; baseline: number };
  measureFont?: () => { width: number; height: number; baseline: number };
  fontSize?: number;
  devicePixelRatio?: unknown;
}

/** The pixel ratio ghostty sizes its canvas at (the page's where it keeps none). */
function rendererRatio(renderer: CellRenderer | undefined): number {
  const ratio = renderer?.devicePixelRatio;
  return typeof ratio === 'number' && ratio > 0 ? ratio : currentPixelRatio();
}

/** Canvas reports already logged on this page load (see reportCanvas): one of each. */
const canvasReports = new Set<string>();

/**
 * `text` in pieces of at most `size` UTF-16 units, none ending between the two halves of a
 * surrogate pair (each piece is encoded to UTF-8 on its own). Escape sequences may be cut:
 * ghostty's parser carries its state from one write to the next.
 */
export function outputChunks(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** A PTY size in the output's order, kept with output written before ghostty opened. */
type PtySizeMark = { cols: number; rows: number; replaying: boolean } | { replayEnded: true };

type TerminalResizeDetail = {
  cols: number;
  rows: number;
  isMobile: boolean;
  isHeightOnlyChange: boolean;
  source: string;
};

/**
 * What ghostty draws of the cursor: its cell, whether the app shows it, and the blink phase
 * (its renderer's own cursorVisible, toggled every 530 ms; not in its typings).
 */
/**
 * The animation frame a call belongs to, for ?scrollperf's count of frames where the canvas's
 * pixels and its transform both changed (the document timeline's time is the frame's).
 */
function frameKey(): number {
  const time = document.timeline?.currentTime;
  return typeof time === 'number' ? time : performance.now();
}

function cursorKey(term: GhosttyTerminal): string {
  const cursor = term.wasmTerm?.getCursor();
  const blinkOn = (term.renderer as unknown as { cursorVisible?: boolean } | undefined)
    ?.cursorVisible;
  return cursor ? `${cursor.x},${cursor.y},${cursor.visible},${blinkOn}` : 'none';
}

@customElement('ut-terminal')
export class Terminal extends LitElement {
  protected readonly i18n = new LocaleController(this);

  createRenderRoot() {
    return this as unknown as HTMLElement;
  }

  @property({ type: String }) sessionId = '';
  @property({ type: String }) sessionStatus = 'running';
  @property({ type: Number }) cols = 80;
  @property({ type: Number }) rows = 24;
  /**
   * Keep the rows when the container only gets shorter: under the phone's chat view nobody
   * sees the terminal, and the keyboard opening shrank the PTY until Claude Code paged its
   * menus ("↓ 2.", the rest hidden) and neither the phone nor the server could read them
   * (2026-10-03, SE: 10 rows with the keyboard up and a two-line message). Released, it fits.
   */
  @property({ type: Boolean }) holdRows = false;
  @property({ type: Number }) fontSize = 14;
  @property({ type: Boolean }) fitHorizontally = false;
  @property({ type: Number }) maxCols = 0; // 0 = unlimited
  @property({ type: String }) theme: TerminalThemeId = 'auto';
  @property({ type: Boolean }) disableClick = false;
  /**
   * Phone with the soft keyboard down: a transparent textarea covers the terminal so a tap
   * lands on a real field. iOS ignores a scripted focus() once the page lost keyboard focus
   * (after Done, or right after loading), so only a native tap reliably raises the keyboard
   * (2026-10-02, iOS 27). Touches still bubble to the container, so scrolling keeps working.
   */
  @property({ type: Boolean }) keyboardCatcher = false;
  private catcher: HTMLTextAreaElement | null = null;
  @property({ type: Boolean }) hideScrollButton = false;

  private originalFontSize = 14;

  @state() private followCursorEnabled = true;
  /** While a history replay is written, nothing is painted (see holdPaint). */
  private paintHeld = false;
  /** When the last held replay was let go (performance.now()), for isScreenSettling(). */
  private paintReleasedAt = Number.NEGATIVE_INFINITY;
  private paintHoldTimer: number | null = null;
  /** Shown over the terminal while a replay holds the paint for long (see holdPaint). */
  @state() private loadingHistory = false;
  private loadingHistoryTimer: number | null = null;
  /**
   * Output came while the user read back: the view stayed put and the scroll-to-bottom button
   * says "New output" until the view is back at the bottom (by hand or with the button).
   */
  @state() private newOutput = false;

  private container: HTMLElement | null = null;
  private terminal: GhosttyTerminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private pasteInput: HTMLTextAreaElement | null = null;
  private pendingOutput: Array<string | PtySizeMark> = [];
  /**
   * 2026-10-12: the grid laid out at the PTY's size instead of this screen's (followPtySize).
   * The stream's output was always written into the phone's own grid, whatever size Claude Code
   * drew it for: a forwarded session's history from the Mac's 120 columns, each word placed
   * with an absolute column move, landed in 80 and came apart ("e / a / pp" down the left,
   * stray letters on the right edge), and the rows that overflowed stayed in the history once
   * per repaint, so scrolling up showed blocks again and again. `rows` null: this screen's
   * rows (live), else the PTY's (a replay, painted only at its end). `container`: this screen's
   * size when the layout began; a new one (keyboard, rotation) gives the PTY this screen's size
   * again, as before. Null: the grid is this screen's own fit.
   */
  private ptyLayout: {
    cols: number;
    rows: number | null;
    container: string;
    /** The PTY's rows: a live layout never has more (see applyPtyLayout). */
    ptyRows: number;
  } | null = null;
  /** This screen's own size as last reported during a PTY layout (see reportOwnSize). */
  private reportedOwnSize: { cols: number; rows: number } | null = null;
  /** This screen's own fit, measured at the user's type size (see followPtySize). */
  private ownSize: { cols: number; rows: number } | null = null;
  /** The container's width inside its padding when last measured (measureTextWidth). */
  private touchWidth = 0;
  /** Touch screens: the cell width set for the grid, at that type size and pixel ratio. */
  private touchCell: { size: number; ratio: number; width: number } | null = null;
  /** A grid resize for ptyLayout: not this screen's size, never sent to the PTY. */
  private silentResize = false;
  private pendingFollowCursor = true;
  private preservedScrollPosition: number | null = null;
  private touchStartX = 0;
  private touchStartY = 0;
  private lastTouchX = 0;
  private lastTouchY = 0;
  private touchScrolling = false;
  /** The touch scroll in progress goes to the app as wheel events (mouse reporting). */
  private touchScrollsApp = false;
  private readonly touchScroller = new TouchScroller({
    rowHeight: () => this.rowHeight(),
    maxRows: () => this.getMaxScrollPosition(),
    scrolledRows: () => Math.round(this.terminal?.getViewportY() ?? 0),
    viewHeight: () =>
      this.container?.clientHeight || this.rowHeight() * (this.terminal?.rows ?? this.rows),
    reducedMotion: () => this.reducedMotion(),
    show: (rows, offset, overscroll) => this.showScrolled(rows, offset, overscroll),
    wheel: (steps) =>
      this.wheelApp(steps > 0 ? 'up' : 'down', Math.abs(steps), this.lastTouchX, this.lastTouchY),
    settled: () => this.scrollPerf?.end(),
    flung: (px) => this.scrollPerf?.momentumStep(Math.abs(px)),
  });
  /** Selecting text with the finger (phones): handles and a Copy menu over the canvas. */
  private readonly touchSelection = new TouchSelection({
    terminal: () => this.terminal,
    overlayRoot: () => this.querySelector<HTMLElement>('.terminal-root'),
    canvas: () => this.getCanvas(),
    scrollRows: (rows) => this.scrollRowsBy(rows),
    appScrolls: () => this.appHandlesScrolling(),
    paste: () =>
      this.dispatchEvent(
        new CustomEvent('terminal-paste-request', { bubbles: true, composed: true })
      ),
  });
  /** The mouse's selection and copy on a desktop, and apps' copies (terminal-clipboard.ts). */
  private readonly desktopCopy = new DesktopCopy({
    terminal: () => this.terminal,
    canvas: () => this.getCanvas(),
    mouseReport: (button, clientX, clientY, release) =>
      this.mouseReport(button, clientX, clientY, release),
    sendToApp: (text) => this.sendToApp(text),
    isEmulatedMouse: () => this.isEmulatedMouse(),
    onScreen: () =>
      this.isConnected &&
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      this.getClientRects().length > 0,
    notify: (result) => this.notifyAppCopy(result),
  });
  /** This touch stopped a moving scroll: like on iOS, it is not a tap. */
  private touchCaughtScroll = false;
  private motionQuery: MediaQueryList | null = null;
  /** Pixels the text is drawn lower than whole rows by a touch scroll: [0, row height]. */
  private canvasShift = 0;
  /** Pixels the canvas itself is moved down past an end of the history (rubber band). */
  private canvasOverscroll = 0;
  /** Device pixels the text on the canvas is drawn lower now (canvasShift as last painted). */
  private paintedShift = 0;
  /** The transform last given to the canvas (style.transform reads back normalized). */
  private appliedTransform: string | null = null;
  private canvasElement: HTMLCanvasElement | null = null;
  /** What ghostty's canvas shows, as the render hook last painted or a shift last drew it. */
  private canvasRows: { viewportY: number; selection: boolean; cursor?: string } | null = null;
  /** A link hover or a selection changed what is drawn without dirtying a row. */
  private canvasStale = false;
  /** Pending canvas checks and renewals (see scheduleCanvasCheck, renewCanvas). */
  private canvasCheckTimers: number[] = [];
  private renewFrame: number | null = null;
  private pixelRatioQuery: MediaQueryList | null = null;
  /**
   * The background ghostty-web paints its canvas with: the theme it was created with, or the
   * one applyTheme handed its renderer since, so the strip above matches it.
   */
  private canvasBackground = '#1e1e1e';
  /** Where an app that scrolls itself (Claude Code's full screen) is, for our scrollbar. */
  private readonly appScroll = new AppScrollTracker();
  private appScrollFrame: number | null = null;
  private appScrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private appScrollRecheck: ReturnType<typeof setTimeout> | null = null;
  /** Our scrollbar beside the text (see updateScrollbar) and its thumb. */
  private scrollbar: HTMLElement | null = null;
  private scrollbarThumb: HTMLElement | null = null;
  private scrollbarHideTimer: ReturnType<typeof setTimeout> | null = null;
  /** A mouse dragging our scrollbar: which pointer, and where on the thumb it holds it. */
  private scrollbarGrab: { pointerId: number; offset: number } | null = null;
  /** `?scrollperf`: one log line per touch scroll (utils/scroll-perf.ts). */
  private scrollPerf: ScrollPerfRecorder | null = null;
  /** When the server's scrollPerf flag was last asked for (see refreshScrollPerf). */
  private scrollPerfCheckedAt = Number.NEGATIVE_INFINITY;

  private isMobile = false;
  private lastCols = 0;
  private lastRows = 0;

  private pendingResizeSource: string | null = null;
  /** The escape sequence the output ends inside of, if any (terminal-grow.ts). */
  private outputEscapeTail = '';
  private pendingResizePrev: { cols: number; rows: number } | null = null;
  private initializationId = 0;
  private stopWatchingFonts: (() => void) | null = null;
  /** Icon files this terminal asked for (terminal-fonts.ts), so it repaints once each loads. */
  private iconFontParts = new Set<string>();

  connectedCallback() {
    const prefs = TerminalPreferencesManager.getInstance();
    this.theme = prefs.getTheme();
    super.connectedCallback();
    window.addEventListener('untether-accent-changed', this.handleAccentChange);
    window.addEventListener(TERMINAL_THEME_CHANGED_EVENT, this.handleAccentChange);

    this.originalFontSize = this.fontSize;
    // Make host focusable so browser shortcuts (Cmd/Ctrl+V) have a target.
    if (this.tabIndex < 0) this.tabIndex = 0;

    // Watch for system theme changes (only when using auto theme)
    this.themeObserver = new MutationObserver(() => {
      if (this.terminal && this.theme === 'auto') {
        this.applyTheme();
      }
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    if (this.hasUpdated && !this.terminal) {
      this.pasteInput = this.querySelector('.terminal-paste-input') as HTMLTextAreaElement | null;
      this.initializeTerminal();
    }
  }

  disconnectedCallback() {
    window.removeEventListener('untether-accent-changed', this.handleAccentChange);
    window.removeEventListener(TERMINAL_THEME_CHANGED_EVENT, this.handleAccentChange);
    if (this.paintHoldTimer !== null) clearTimeout(this.paintHoldTimer);
    this.paintHoldTimer = null;
    this.paintHeld = false;
    this.endCaretMove(null);
    this.stopLoadingHistory();
    this.cleanup();
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    super.disconnectedCallback();
  }

  firstUpdated() {
    this.pasteInput = this.querySelector('.terminal-paste-input') as HTMLTextAreaElement | null;
    this.initializeTerminal();
  }

  willUpdate(changed: PropertyValues) {
    // Back at the bottom, whatever brought it there: nothing below is new any more.
    if (changed.has('followCursorEnabled') && this.followCursorEnabled) this.newOutput = false;
  }

  updated(changed: PropertyValues) {
    if (changed.has('holdRows') && !this.holdRows) this.requestResize('rows-released');
    if (changed.has('sessionId') && this.sessionId) {
      this.requestResize('session-id-change');
    }

    if (changed.has('fontSize')) {
      if (!this.fitHorizontally) this.originalFontSize = this.fontSize;
      // The row height changes: a touch scroll's pixels between rows no longer fit.
      this.settleOnRow();
      this.applyFontSize();
      this.requestResize('font-size-change');
    }

    if (changed.has('fitHorizontally')) {
      if (!this.fitHorizontally) this.fontSize = this.originalFontSize;
      this.requestResize('fit-mode-change');
    }

    if (changed.has('maxCols') || changed.has('disableClick')) {
      this.requestResize('property-change');
    }

    if (changed.has('disableClick')) {
      this.syncNativeInputFocus();
    }

    if (changed.has('keyboardCatcher')) {
      this.syncKeyboardCatcher();
    }

    if (changed.has('theme')) {
      this.applyTheme();
    }
  }

  /**
   * The width was chosen by hand: fit to it now. (This also kept a flag and one
   * `terminal-width-override-<session>` key in localStorage per session that nothing ever read
   * or removed; gone 2026-11-10.)
   */
  refitToChosenWidth() {
    this.requestResize('user-override-width');
  }

  public handleFitToggle = () => {
    if (!this.fitHorizontally) this.originalFontSize = this.fontSize;
    this.fitHorizontally = !this.fitHorizontally;
    if (!this.fitHorizontally) this.fontSize = this.originalFontSize;
    this.requestResize('fit-toggle');
  };

  public write(data: string, followCursor = true) {
    // Every path that puts text in the terminal comes here: the stream, the snapshot replayed
    // on load (pendingOutput before ghostty opens), cast playback.
    loadTerminalIconFonts(data, this.iconFontParts)?.then((loaded) => {
      if (loaded) this.handleTerminalFontsLoaded();
    });
    if (!this.terminal) {
      this.pendingOutput.push(data);
      this.pendingFollowCursor = this.pendingFollowCursor && followCursor;
      return;
    }

    this.outputEscapeTail = openEscapeTail(this.outputEscapeTail, data);
    const shouldPreserveScroll = !this.followCursorEnabled && this.preservedScrollPosition === null;
    if (shouldPreserveScroll) {
      this.preservedScrollPosition = this.getScrollPosition();
    }

    if (this.preservedScrollPosition !== null) {
      const preservedScrollPosition = this.preservedScrollPosition;
      const anchor = this.historyAnchor(preservedScrollPosition);
      const lengthBefore = this.terminal.buffer.active.length;
      try {
        this.terminal.write(data);
        // ghostty-web scrolls to bottom synchronously during write(), so restore before paint.
        this.scrollToPosition(
          this.anchoredPosition(preservedScrollPosition, anchor, lengthBefore, data)
        );
        this.followCursorEnabled = false;
        this.newOutput = true;
        // The history grew: the thumb is a little shorter and higher.
        this.updateScrollbar(false);
      } finally {
        this.preservedScrollPosition = null;
      }
      if (this.caretMove) this.settleCaretMove();
      this.scheduleAppScrollFrame();
      return;
    }

    // ghostty-web already follows output; another smooth scroll per write queues badly on iOS.
    this.terminal.write(data);
    if (this.caretMove) this.settleCaretMove();
    this.scheduleAppScrollFrame();
  }

  /**
   * Up to 3 non-blank history rows among the top 12 of the view, as [rows below `top`, text]:
   * how write() finds the text the user was reading once the history drops its oldest rows.
   * Only history rows: those never change, and reading them is cheap. None (a blank top of the
   * view) keeps the plain index, as before.
   */
  private historyAnchor(top: number): Array<[number, string]> {
    const anchor: Array<[number, string]> = [];
    const terminal = this.terminal;
    if (!terminal) return anchor;
    const end = Math.min(this.getMaxScrollPosition(), top + Math.min(terminal.rows, 12));
    for (let row = top; row < end && anchor.length < 3; row++) {
      const text = terminal.buffer.active.getLine(row)?.translateToString(true);
      if (text) anchor.push([row - top, text]);
    }
    return anchor;
  }

  /**
   * Where the rows the view showed from `top` are after writing `data`. Usually the same
   * index, but ghostty-web keeps a small history (scrollbackLimit 10000 makes about 2000 rows at
   * 45 columns, 750 at 120) and makes room by dropping its oldest page at once (about 1000
   * rows at 45 columns): every row moves up by that many, and keeping the index jumped the
   * reader that far towards the bottom (2026-10-03). The write can only have dropped between
   * -growth and (rows it could add) - growth rows, so only that window is searched.
   */
  private anchoredPosition(
    top: number,
    anchor: Array<[number, string]>,
    lengthBefore: number,
    data: string
  ): number {
    const terminal = this.terminal;
    if (!terminal || anchor.length === 0) return top;
    const buffer = terminal.buffer.active;
    const grown = buffer.length - lengthBefore;
    // At most one row per line feed and one per wrapped line.
    let feeds = 0;
    for (let i = data.indexOf('\n'); i !== -1; i = data.indexOf('\n', i + 1)) feeds++;
    const added = feeds + Math.ceil(data.length / Math.max(1, terminal.cols));
    const fewest = Math.max(0, -grown);
    const most = Math.min(top, Math.max(fewest, added - grown), fewest + 5000);
    for (let dropped = fewest; dropped <= most; dropped++) {
      const at = top - dropped;
      if (
        anchor.every(
          ([offset, text]) => buffer.getLine(at + offset)?.translateToString(true) === text
        )
      ) {
        return at;
      }
    }
    // The rows being read were dropped as well (even when a burst grew the history): the
    // oldest left are the nearest. If nothing could be dropped, the index stands.
    return most > 0 || fewest > 0 ? 0 : top;
  }

  /**
   * Holds the canvas's paint while a history replay is written, until releasePaint(): the
   * replay (up to 16 MB) arrives over many frames and ghostty painted between them, following
   * the output, so opening a long session showed its history from the top scrolling past at
   * full speed (2026-10-04, iPhone). The canvas keeps what it showed unless the grid or the
   * font changes meanwhile (the PTY's size in the replay): that clears it, and the render hook
   * keeps it sized for the screen's pixel ratio. At most PAINT_HOLD_MAX_MS, in case the end of
   * the replay never comes.
   */
  public holdPaint() {
    this.paintHeld = true;
    if (this.paintHoldTimer !== null) clearTimeout(this.paintHoldTimer);
    this.paintHoldTimer = window.setTimeout(() => this.releasePaint(), PAINT_HOLD_MAX_MS);
    // A replay that takes a while (a long history over a slow link) says so, not a blank.
    if (this.loadingHistoryTimer === null && !this.loadingHistory) {
      this.loadingHistoryTimer = window.setTimeout(() => {
        this.loadingHistoryTimer = null;
        if (this.paintHeld) this.loadingHistory = true;
      }, LOADING_HISTORY_AFTER_MS);
    }
  }

  /**
   * Checks the canvas and remakes it (renewCanvas) `ms` from now: after the terminal is ready
   * and after a held replay is let go, when a cold start has settled. The report goes first,
   * so the log has the canvas as it was.
   */
  private scheduleCanvasCheck(reason: string, ms: number) {
    const timer = window.setTimeout(() => {
      this.canvasCheckTimers = this.canvasCheckTimers.filter((t) => t !== timer);
      this.reportCanvas(reason);
      this.renewCanvas();
    }, ms);
    this.canvasCheckTimers.push(timer);
  }

  /**
   * Logs the canvas as it is now (terminal-canvas-health.ts), once per reason and page load:
   * the first terminal after a cold start came up blurry on the phone (user report,
   * 2026-10-12) and could not be reproduced elsewhere. Its pixels against its CSS size and the
   * ratio say whether the canvas was drawn small; "sharpness" whether what it holds is sharp
   * (text drawn at 3x measured 1.5 to 1.7 in WebKit) or a smaller bitmap stretched (about 1.3); the layers above whether something scales it.
   */
  private reportCanvas(reason: string) {
    if (canvasReports.has(reason)) return;
    const term = this.terminal;
    const canvas = this.getCanvas();
    if (!term || !canvas) return;
    canvasReports.add(reason);
    try {
      const layout = this.ptyLayout;
      const report = describeCanvas({
        canvas,
        cols: term.cols,
        rows: term.rows,
        metrics: term.renderer?.getMetrics() ?? null,
        rendererRatio: (term.renderer as { devicePixelRatio?: unknown } | undefined)
          ?.devicePixelRatio,
        fontSize: term.options.fontSize,
        paintHeld: this.paintHeld,
        followingPty: layout ? `${layout.cols}x${layout.rows ?? 'fit'}` : null,
      });
      logger.warn(`canvas check (${reason}): ${report}`);
    } catch (error) {
      logger.warn(`canvas check (${reason}) failed`, error);
    }
  }

  /**
   * A new backing store and compositing layer for the canvas, as opening another session and
   * coming back gave it: the canvas leaves its layer for a painted frame (no transform), comes
   * back on it, and is sized and drawn again. Against a cold-launched home-screen web view
   * that composites the canvas's layer at a lower scale than the page's, or a canvas left at
   * the wrong size (user report, 2026-10-12: blurry until the session was opened again). Not
   * while a replay holds the paint (letting it go checks it), nor in the middle of a gesture:
   * a canvas shifted between rows or pinched would jump for that frame, so it is tried later.
   */
  private renewCanvas(attempt = 0) {
    const term = this.terminal;
    const canvas = this.getCanvas();
    if (!term?.renderer || !term.wasmTerm || !canvas || this.paintHeld) return;
    if (this.renewFrame !== null) return;
    if (
      this.canvasShift !== 0 ||
      this.canvasOverscroll !== 0 ||
      this.pinchScale !== 1 ||
      this.touchScrolling ||
      this.touchSelection.active
    ) {
      if (attempt >= 6) return;
      const timer = window.setTimeout(() => {
        this.canvasCheckTimers = this.canvasCheckTimers.filter((t) => t !== timer);
        this.renewCanvas(attempt + 1);
      }, CANVAS_RENEW_RETRY_MS);
      this.canvasCheckTimers.push(timer);
      return;
    }
    canvas.style.transform = 'none';
    this.appliedTransform = 'none';
    // Laid out without it now, and painted so in the next frame.
    canvas.getBoundingClientRect();
    this.renewFrame = requestAnimationFrame(() => {
      this.renewFrame = requestAnimationFrame(() => {
        this.renewFrame = null;
        this.applyCanvasTransform();
        const renderer = term.renderer;
        if (this.terminal !== term || !renderer || !term.wasmTerm || this.paintHeld) return;
        renderer.resize(term.cols, term.rows);
        this.canvasStale = true;
        renderer.render(term.wasmTerm, true, term.getViewportY(), term, 0);
      });
    });
  }

  /** What makes the canvas be remade (renewCanvas) besides the timers: see watchCanvas. */
  private handleCanvasVisibility = () => {
    if (document.visibilityState !== 'visible') return;
    this.reportCanvas('visible');
    this.renewCanvas();
  };

  private handleCanvasPageShow = () => {
    this.reportCanvas('pageshow');
    this.renewCanvas();
  };

  private handlePixelRatioChange = () => {
    this.watchPixelRatio();
    this.renewCanvas();
  };

  /** Only reported: remade in the middle of a gesture, the canvas would jump. */
  private handleFirstCanvasTouch = () => {
    this.container?.removeEventListener('touchend', this.handleFirstCanvasTouch);
    this.reportCanvas('first-touch');
  };

  /** A change of the page's pixel ratio (another display, zoom), as a media query says it. */
  private watchPixelRatio() {
    this.pixelRatioQuery?.removeEventListener('change', this.handlePixelRatioChange);
    this.pixelRatioQuery = null;
    if (typeof window.matchMedia !== 'function') return;
    try {
      const query = window.matchMedia(`(resolution: ${currentPixelRatio()}dppx)`);
      query.addEventListener?.('change', this.handlePixelRatioChange);
      this.pixelRatioQuery = query;
    } catch {
      // No such media query here: the render hook still follows the ratio.
    }
  }

  /**
   * The canvas is remade (renewCanvas) when the page comes back on the screen (a home-screen
   * app reopened, a tab shown again) and when the pixel ratio changes; reported at the first
   * touch, when someone is looking at it.
   */
  private watchCanvas() {
    document.addEventListener('visibilitychange', this.handleCanvasVisibility);
    window.addEventListener('pageshow', this.handleCanvasPageShow);
    this.container?.addEventListener('touchend', this.handleFirstCanvasTouch, { passive: true });
    this.watchPixelRatio();
  }

  private unwatchCanvas() {
    for (const timer of this.canvasCheckTimers) clearTimeout(timer);
    this.canvasCheckTimers = [];
    if (this.renewFrame !== null) cancelAnimationFrame(this.renewFrame);
    this.renewFrame = null;
    document.removeEventListener('visibilitychange', this.handleCanvasVisibility);
    window.removeEventListener('pageshow', this.handleCanvasPageShow);
    this.container?.removeEventListener('touchend', this.handleFirstCanvasTouch);
    this.pixelRatioQuery?.removeEventListener('change', this.handlePixelRatioChange);
    this.pixelRatioQuery = null;
  }

  private stopLoadingHistory() {
    if (this.loadingHistoryTimer !== null) clearTimeout(this.loadingHistoryTimer);
    this.loadingHistoryTimer = null;
    this.loadingHistory = false;
  }

  /** Whether a history replay is still being written, its paint held (see holdPaint). */
  public isPaintHeld(): boolean {
    return this.paintHeld;
  }

  /**
   * Whether the buffer may not be the live screen: a replay is being written, or ended less
   * than SCREEN_SETTLE_MS ago (its last size marks still re-flowing the grid). Screen readers
   * (the composer's menu watch, the chat's mode chip) skip it: a replay passes through every
   * old screen of the session, and one held a permission prompt from hours before (user
   * report, 2026-10-14).
   */
  public isScreenSettling(): boolean {
    return this.paintHeld || performance.now() - this.paintReleasedAt < SCREEN_SETTLE_MS;
  }

  /** Ends holdPaint(): one paint, at the bottom unless the reader has scrolled away. */
  public releasePaint() {
    if (this.paintHoldTimer !== null) {
      clearTimeout(this.paintHoldTimer);
      this.paintHoldTimer = null;
    }
    this.stopLoadingHistory();
    if (!this.paintHeld) return;
    this.paintHeld = false;
    this.paintReleasedAt = performance.now();
    const term = this.terminal;
    if (!term) return;
    if (this.followCursorEnabled && term.getViewportY() !== 0) term.scrollToBottom();
    this.canvasStale = true;
    if (term.renderer && term.wasmTerm) {
      // Every row: the frames skipped while held may have left some undrawn.
      term.renderer.render(term.wasmTerm, true, term.getViewportY(), term, 0);
    }
    this.updateScrollbar(false);
    this.scheduleCanvasCheck('released', CANVAS_RELEASED_MS);
  }

  public clear() {
    this.terminal?.clear();
    this.preservedScrollPosition = null;
    this.settleOnRow();
    this.followCursorEnabled = true;
  }

  public setTerminalSize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;

    if (!this.terminal) return;
    this.requestResizeMeta('explicit-set-size');
    this.terminal.resize(cols, rows);
  }

  public scrollToBottom() {
    this.settleOnRow();
    this.terminal?.scrollToBottom();
    this.followCursorEnabled = true;
  }

  /**
   * Whether the viewport is at (or near) the bottom, i.e. auto-following new output.
   * Becomes false when the user scrolls up to read history (incl. touch scroll), so
   * callers can avoid yanking the view back to the bottom while the user is reading.
   */
  public isFollowingCursor(): boolean {
    return this.followCursorEnabled;
  }

  public scrollToPosition(position: number) {
    if (!this.terminal) return;
    const max = this.getMaxScrollPosition();
    const clamped = Math.max(0, Math.min(max, Math.floor(position)));
    this.terminal.scrollToLine(max - clamped);
  }

  /** True when the running app asked for bracketed paste (DECSET 2004). */
  public isBracketedPasteEnabled(): boolean {
    try {
      return this.terminal?.hasBracketedPaste() ?? false;
    } catch {
      return false;
    }
  }

  public getTerminalSize(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  /** The grid's columns and rows as drawn now (a PTY layout's included). */
  public getGridSize(): { cols: number; rows: number } | null {
    const term = this.terminal;
    return term ? { cols: term.cols, rows: term.rows } : null;
  }

  public getMaxScrollPosition(): number {
    if (!this.terminal) return 0;
    return Math.max(0, this.terminal.buffer.active.length - this.terminal.rows);
  }

  public getScrollPosition(): number {
    if (!this.terminal) return 0;
    const max = this.getMaxScrollPosition();
    const viewportFromBottom = this.terminal.getViewportY();
    return Math.round(Math.max(0, Math.min(max, max - viewportFromBottom)));
  }

  /**
   * Text of the last `maxLines` lines with empty cells read as spaces. Apps such as Claude
   * Code position words with cursor moves instead of writing spaces, and
   * translateToString() skips those empty cells ("Doyouwanttoproceed?").
   */
  public getScreenText(maxLines = 30): string {
    if (!this.terminal) return '';
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = Math.max(0, buffer.length - maxLines); row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      let text = '';
      for (let col = 0; col < line.length; col++) {
        const cell = line.getCell(col);
        if (!cell || cell.getWidth() === 0) continue;
        text += cell.getChars() || ' ';
      }
      lines.push(text.trimEnd());
    }
    return lines.join('\n');
  }

  /**
   * Like getScreenText, but the rows the terminal soft-wrapped are joined back into the line
   * that was printed: copying "…largo par" + "a el arranque" gives "…largo para el arranque".
   * A row is joined untrimmed, so a break at a space keeps that space.
   */
  public getScreenLines(maxLines = 30): string {
    if (!this.terminal) return '';
    const length = this.terminal.buffer.active.length;
    return this.readPrintedLines(Math.max(0, length - maxLines), length).text;
  }

  /**
   * Copy mode's text: `maxLines` rows around what is on screen, as getScreenLines reads them,
   * and which of its lines is the top of the screen. Scrolled back into the history, the rows
   * end a little below the screen (the newest output may be left out); at the bottom, they
   * end with it and `topLine` is null (the sheet then opens at the end).
   */
  public getCopyModeText(maxLines: number): { text: string; topLine: number | null } {
    if (!this.terminal) return { text: '', topLine: null };
    const length = this.terminal.buffer.active.length;
    const top = this.getScrollPosition();
    if (top >= this.getMaxScrollPosition()) {
      return { text: this.getScreenLines(maxLines), topLine: null };
    }
    const end = Math.min(length, top + this.terminal.rows + Math.floor(maxLines / 2));
    const start = Math.max(0, end - maxLines);
    const read = this.readPrintedLines(start, end, top);
    return { text: read.text, topLine: read.anchorLine };
  }

  /** Rows start..end-1 with soft-wrapped rows joined; anchorLine is the line holding `anchor`. */
  private readPrintedLines(
    start: number,
    end: number,
    anchor = -1
  ): { text: string; anchorLine: number | null } {
    const buffer = this.terminal?.buffer.active;
    if (!buffer) return { text: '', anchorLine: null };
    const lines: string[] = [];
    let anchorLine: number | null = null;
    for (let row = start; row < end; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      let text = '';
      for (let col = 0; col < line.length; col++) {
        const cell = line.getCell(col);
        if (!cell || cell.getWidth() === 0) continue;
        text += cell.getChars() || ' ';
      }
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
      if (row === anchor) anchorLine = lines.length - 1;
    }
    return { text: lines.map((line) => line.trimEnd()).join('\n'), anchorLine };
  }

  /** Which of getScreenText's lines go on in the next one (the terminal soft-wrapped them). */
  public getScreenWrapped(maxLines = 30): boolean[] {
    if (!this.terminal) return [];
    const buffer = this.terminal.buffer.active;
    const wrapped: boolean[] = [];
    for (let row = Math.max(0, buffer.length - maxLines); row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (line) wrapped.push(line.isWrapped);
    }
    return wrapped;
  }

  // e2e-only debug API (canvas has no textContent)
  public getDebugText(options?: { maxLines?: number; trimRight?: boolean }): string {
    if (!this.terminal) return '';
    const maxLines = options?.maxLines ?? 250;
    const trimRight = options?.trimRight ?? true;

    const buffer = this.terminal.buffer.active;
    const end = buffer.length;
    const start = Math.max(0, end - maxLines);
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const line = buffer.getLine(i);
      lines.push(line ? line.translateToString(trimRight) : '');
    }
    return lines.join('\n');
  }

  // Pinch to zoom the font (phones): the canvas is scaled live with a CSS transform, and the
  // real font size (which refits columns and resizes the PTY) is applied once, on release.
  private pinchStartDistance = 0;
  private pinchStartFont = 0;
  private pinchScale = 1;
  private pinched = false;

  // Long press (one still finger) selects the word under it: the canvas has no iOS selection.
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressed = false;

  private cancelLongPress() {
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
  }

  private touchDistance(touches: TouchList): number {
    const [a, b] = [touches[0], touches[1]];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  private pinchFontSize(scale: number): number {
    return Math.round(Math.max(8, Math.min(32, this.pinchStartFont * scale)));
  }

  private handleTerminalTouchStart = (event: TouchEvent) => {
    this.cancelLongPress();
    if (event.touches.length === 2) {
      this.touchScroller.cancel();
      this.resetTouchScroll();
      this.pinched = true;
      this.pinchStartDistance = this.touchDistance(event.touches);
      this.pinchStartFont = this.fontSize;
      this.pinchScale = 1;
      return;
    }
    if (event.touches.length !== 1) {
      this.touchScroller.cancel();
      this.resetTouchScroll();
      return;
    }
    if (this.pinchStartDistance === 0) this.pinched = false;

    // A fling still running belongs to the scroll before: its measurement ends with this touch.
    this.scrollPerf?.end();
    this.refreshScrollPerf();
    this.touchCaughtScroll = this.touchScroller.grab();

    const touch = event.touches[0];
    this.touchStartX = touch.clientX;
    this.touchStartY = touch.clientY;
    this.lastTouchX = touch.clientX;
    this.lastTouchY = touch.clientY;
    this.touchScrolling = false;
    this.longPressed = false;
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      if (this.touchScrolling || this.pinched) return;
      this.longPressed = true;
      this.touchSelection.beginAt(this.touchStartX, this.touchStartY);
      this.dispatchEvent(new CustomEvent('terminal-long-press', { bubbles: true, composed: true }));
    }, LONG_PRESS_MS);
  };

  private handleTerminalTouchMove = (event: TouchEvent) => {
    const perf = this.scrollPerf;
    if (!perf) {
      this.touchMove(event);
      return;
    }
    const started = performance.now();
    this.touchMove(event);
    if (perf.recording) perf.handler(performance.now() - started);
  };

  private touchMove(event: TouchEvent) {
    if (event.touches.length === 2 && this.pinchStartDistance > 0) {
      if (event.cancelable) event.preventDefault();
      const scale = this.touchDistance(event.touches) / this.pinchStartDistance;
      // Preview within the same bounds the final size will use.
      this.pinchScale = this.pinchFontSize(scale) / this.pinchStartFont;
      this.applyCanvasTransform();
      return;
    }
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    // After a long press the same finger moves the selection's end, as on iOS.
    if (this.longPressed) {
      if (event.cancelable) event.preventDefault();
      this.touchSelection.extendTo(touch.clientX, touch.clientY);
      return;
    }
    const totalX = touch.clientX - this.touchStartX;
    const totalY = touch.clientY - this.touchStartY;
    if (Math.hypot(totalX, totalY) > 10) this.cancelLongPress();

    if (!this.touchScrolling) {
      if (Math.abs(totalY) <= 6 || Math.abs(totalY) <= Math.abs(totalX)) return;
      this.touchScrolling = true;
      this.touchScrollsApp = this.appHandlesScrolling();
      this.touchScroller.start(this.touchScrollsApp);
      this.scrollPerf?.begin(
        this.touchScrollsApp ? 'app' : 'local',
        this.terminal?.rows ?? this.rows
      );
    }

    if (event.cancelable) event.preventDefault();

    const dy = touch.clientY - this.lastTouchY;
    this.lastTouchX = touch.clientX;
    this.lastTouchY = touch.clientY;
    this.touchScroller.drag(dy, this.touchTime(event));
  }

  /**
   * When the touch happened: the event's own time when it is on performance.now()'s clock
   * (WebKit stamps touches when they are sensed), else now. Handler times bunch up when the
   * page is busy, and the fling's speed is measured from them.
   */
  private touchTime(event: Event): number {
    const now = performance.now();
    const stamp = event.timeStamp;
    return Number.isFinite(stamp) && stamp > 0 && Math.abs(now - stamp) < 1000 ? stamp : now;
  }

  private rowHeight(): number {
    return Math.max(1, this.terminal?.renderer?.getMetrics().height ?? this.fontSize * 1.2);
  }

  /** ghostty-web's canvas; it keeps the same one while open. */
  private getCanvas(): HTMLCanvasElement | null {
    if (this.canvasElement?.parentElement !== this.container || !this.container) {
      this.canvasElement = this.container?.querySelector<HTMLCanvasElement>('canvas') ?? null;
      if (this.canvasElement) this.trackCanvasBox(this.canvasElement);
    }
    return this.canvasElement;
  }

  /**
   * The canvas's box, as the code that finds the cell under a point reads it (ghostty's mouse,
   * selection and links; the touch selection, caret taps and mouse reports here): its top is
   * the top of the first row, which a touch scroll draws `paintedShift` device pixels lower on
   * the canvas. When a CSS transform moved the text, the box moved with it by itself.
   */
  private trackCanvasBox(canvas: HTMLCanvasElement) {
    if (Object.getOwnPropertyDescriptor(canvas, 'getBoundingClientRect')) return;
    const box = Element.prototype.getBoundingClientRect;
    Object.defineProperty(canvas, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value: () => {
        const rect = box.call(canvas);
        const down = (this.paintedShift / (window.devicePixelRatio || 1)) * this.pinchScale;
        return down === 0 ? rect : new DOMRect(rect.x, rect.y + down, rect.width, rect.height);
      },
    });
  }

  /** At the live bottom: no rows back and no pixels either. */
  private isAtBottom(): boolean {
    return (this.terminal?.getViewportY() ?? 0) <= 0.5 && this.touchScroller.offset === 0;
  }

  /**
   * A touch scroll step: whole rows to ghostty's viewport, the pixels between (`offset`) drawn
   * that much lower on its canvas, and only the rubber band past an end (`overscroll`) a CSS
   * transform. The pixels between rows were a transform too, and at each row crossing the
   * canvas got its next rows and the transform went back a row in the same callback: iOS showed
   * the new canvas a frame before the new transform, so the text stood a whole row too far for
   * one frame and snapped back, at every row (user report, 2026-10-13: the text jittering up and
   * down while scrolling up; the recording shows +1 row then -1 row at each crossing). Now only
   * the canvas's pixels change while the text moves. They are drawn right here, not left to
   * ghostty's own requestAnimationFrame loop, which may run before this callback in the frame.
   */
  private showScrolled(rows: number, offset: number, overscroll: number) {
    const term = this.terminal;
    if (!term) return;
    this.canvasShift = offset;
    this.canvasOverscroll = overscroll;
    const perf = this.scrollPerf?.recording ? this.scrollPerf : null;
    const from = Math.round(term.getViewportY());
    const shift = this.targetShift();
    if (from !== rows || shift !== this.paintedShift) {
      const started = perf ? performance.now() : 0;
      // The pixels go first: moving the viewport may make ghostty render at once (its
      // scrollbar fade), which then finds the canvas already showing these rows.
      if (this.moveCanvasText(from, rows, shift)) {
        if (from !== rows) term.scrollToLine(rows);
      } else {
        if (from !== rows) term.scrollToLine(rows);
        // Every row, drawn `shift` lower (the render hook).
        this.canvasStale = true;
        this.paintNow();
      }
      if (from !== rows) perf?.crossing(performance.now() - started);
    }
    this.applyCanvasTransform();
    const ratio = window.devicePixelRatio || 1;
    perf?.position(
      rows * this.rowHeight() + (this.paintedShift + Math.round(overscroll * ratio)) / ratio,
      this.touchScroller.frameTime
    );
    this.followCursorEnabled = this.isAtBottom();
    this.updateScrollbar(true);
  }

  /** canvasShift in whole device pixels (by a fraction of one, the text would blur). */
  private targetShift(): number {
    return Math.max(0, Math.round(this.canvasShift * (window.devicePixelRatio || 1)));
  }

  /**
   * Makes ghostty's canvas, which shows the view `from` rows back with its text `paintedShift`
   * device pixels lower, show `to` rows back `shift` pixels lower: moves its pixels and draws
   * only the rows that come in (drawMovedText), where ghostty repaints every row (every cell a
   * font, a color and a fillText: some 2000 cells on a phone, at 3x). Only when the canvas
   * shows exactly `from` with nothing new: no output since (the WASM's dirty state), no
   * selection or link hover; never into or out of the bottom, where ghostty also draws the
   * cursor. Returns whether it did.
   */
  private moveCanvasText(from: number, to: number, shift: number): boolean {
    const term = this.terminal;
    const wasm = term?.wasmTerm;
    const canvas = this.getCanvas();
    const metrics = term?.renderer?.getMetrics();
    if (!term || !wasm || !canvas || !metrics) return false;
    if (this.canvasStale || term.hasSelection() || wasm.isDirty()) return false;
    const painted = this.canvasRows;
    if (painted?.viewportY !== from || painted.selection) return false;
    if ((from === 0) !== (to === 0)) return false;
    if (from === 0 && painted.cursor !== cursorKey(term)) return false;
    // Sized as ghostty sizes it (rows × row height × pixel ratio): mid-resize it is not.
    const ratio = window.devicePixelRatio || 1;
    if (
      Math.abs(canvas.height - term.rows * metrics.height * ratio) > 0.5 ||
      Math.abs(canvas.width - term.cols * metrics.width * ratio) > 0.5
    ) {
      return false;
    }
    const delta = (to - from) * metrics.height * ratio + (shift - this.paintedShift);
    if (Math.abs(delta) >= canvas.height) return false;
    // A row of a fractional number of device pixels (a 2.625x screen): pixels moved by a
    // fraction are resampled, and the blur would add up at every crossing. Drawn again instead.
    if (!Number.isInteger(delta)) return false;
    // At the bottom the rows coming in from below may hold the cursor, which ghostty draws.
    if (to === 0 && delta < 0) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    this.drawMovedText(canvas, ctx, to, delta, shift);
    if (delta !== 0) this.scrollPerf?.canvasDrawn(frameKey());
    this.canvasRows = { viewportY: to, selection: false, cursor: painted.cursor };
    return true;
  }

  /**
   * Moves the canvas's pixels `delta` device pixels down (up when negative) and draws the strip
   * this uncovers: the rows of the view `view` rows back that cross it, with the text `shift`
   * pixels lower, so the row above the first one shows in the gap at the top.
   */
  private drawMovedText(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    view: number,
    delta: number,
    shift: number
  ) {
    const term = this.terminal;
    const wasm = term?.wasmTerm;
    const metrics = term?.renderer?.getMetrics();
    if (!term || !wasm || !metrics) return;
    const ratio = window.devicePixelRatio || 1;
    const rowPx = metrics.height * ratio;
    const width = canvas.width;
    const kept = canvas.height - Math.abs(delta);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (delta > 0) ctx.drawImage(canvas, 0, 0, width, kept, 0, delta, width, kept);
    else if (delta < 0) ctx.drawImage(canvas, 0, -delta, width, kept, 0, 0, width, kept);
    const top = delta >= 0 ? 0 : kept;
    const size = delta >= 0 ? delta : -delta;
    if (size > 0) {
      ctx.beginPath();
      ctx.rect(0, top, width, size);
      ctx.clip();
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      // ghostty's renderer for a view `view` rows back shows history rows above row `view`
      // and the live screen from there; row -1 is the history row above the first one shown.
      const history = term.getScrollbackLength();
      const font = { size: term.options.fontSize, family: term.options.fontFamily };
      const first = Math.max(-1, Math.floor((top - shift) / rowPx));
      const last = Math.min(term.rows - 1, Math.ceil((top + size - shift) / rowPx) - 1);
      for (let row = first; row <= last; row++) {
        const fromHistory = row < view;
        const index = fromHistory ? history - view + row : row - view;
        const cells =
          index < 0 ? [] : fromHistory ? term.getScrollbackLine(index) : wasm.getLine(index);
        ctx.save();
        ctx.translate(0, row * metrics.height + shift / ratio);
        paintCellRow(ctx, cells ?? [], term.cols, metrics, font, this.canvasBackground, (col) =>
          fromHistory
            ? wasm.getScrollbackGraphemeString(index, col)
            : wasm.getGraphemeString(index, col)
        );
        ctx.restore();
      }
    }
    ctx.restore();
    this.paintedShift = shift;
  }

  /**
   * A file of the terminal's font arrived (terminal-fonts.ts): the core after the wait gave up,
   * or an icon file. Cells measured on a fallback are measured again and the rows refitted;
   * otherwise every row is redrawn, so a fallback glyph or tofu does not stay on screen.
   */
  private handleTerminalFontsLoaded = () => {
    const term = this.terminal;
    const renderer = term?.renderer;
    if (!term || !renderer || !term.wasmTerm) return;
    const before = renderer.getMetrics();
    forgetMeasuredAdvances();
    this.touchCell = null;
    renderer.remeasureFont();
    const after = renderer.getMetrics();
    this.canvasStale = true;
    if (
      before.width !== after.width ||
      before.height !== after.height ||
      before.baseline !== after.baseline
    ) {
      // The canvas to the new cells, at the screen's pixel ratio (not ghostty's
      // handleFontChange: it sizes the canvas at 1x), then the rows refitted to the container.
      this.settleOnRow();
      renderer.resize(term.cols, term.rows);
      this.requestResize('font-loaded');
    }
    renderer.render(term.wasmTerm, true, term.getViewportY(), term, 0);
  };

  /**
   * A selection's handle dragged to an edge scrolls by whole rows (positive: into history);
   * where the app scrolls (tmux, Claude Code) the local history is blank, so the app does.
   */
  private scrollRowsBy(rows: number) {
    const term = this.terminal;
    if (!term) return;
    if (this.appHandlesScrolling()) {
      const box = this.getCanvas()?.getBoundingClientRect();
      const x = box ? box.left + box.width / 2 : 0;
      const y = box ? box.top + box.height / 2 : 0;
      this.wheelApp(rows > 0 ? 'up' : 'down', Math.abs(rows), x, y);
      return;
    }
    this.settleOnRow();
    const from = Math.round(term.getViewportY());
    const to = Math.max(0, Math.min(this.getMaxScrollPosition(), from + rows));
    if (to === from) return;
    term.scrollToLine(to);
    this.paintNow();
    this.updateScrollbar(true);
  }

  /** ghostty paints its canvas now, through the render hook (which skips an unchanged frame). */
  private paintNow() {
    const term = this.terminal;
    if (!term?.renderer || !term.wasmTerm) return;
    term.renderer.render(term.wasmTerm, false, term.getViewportY(), term, 0);
  }

  /** Drops a touch scroll's pixels between rows: the view was moved some other way. */
  private settleOnRow() {
    this.touchScroller.reset();
    if (this.canvasShift === 0 && this.canvasOverscroll === 0 && this.paintedShift === 0) return;
    this.canvasShift = 0;
    this.canvasOverscroll = 0;
    this.applyCanvasTransform();
    if (this.paintedShift === 0) return;
    const line = Math.round(this.terminal?.getViewportY() ?? 0);
    if (!this.moveCanvasText(line, line, 0)) {
      this.canvasStale = true;
      this.paintNow();
    }
  }

  /**
   * The canvas moved by the rubber band past an end and scaled by a pinch preview. It keeps a
   * 3D transform at rest too: dropping it at 0 took the canvas off its own compositing layer,
   * and back on at the next step, mid-gesture.
   */
  private applyCanvasTransform() {
    const canvas = this.getCanvas();
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    // On whole device pixels: moved by a fraction of one, the text blurs.
    const shift = Math.round(this.canvasOverscroll * ratio) / ratio;
    const scale = this.pinchScale !== 1 ? ` scale(${this.pinchScale})` : '';
    const transform = `translate3d(0, ${shift}px, 0)${scale}`;
    if (transform !== this.appliedTransform) {
      canvas.style.transformOrigin = '0 0';
      canvas.style.transform = transform;
      this.appliedTransform = transform;
      this.scrollPerf?.transformChanged(frameKey());
    }
    if (this.touchSelection.active) this.touchSelection.layout();
  }

  /**
   * Full-screen apps that turn on mouse reporting (Claude Code, vim with mouse=a, htop)
   * scroll their own content. For them the local scrollback only holds stale copies of
   * earlier repaints, which is why scrolling up showed Claude Code's banner repeated.
   */
  private appHandlesScrolling(): boolean {
    try {
      return this.terminal?.hasMouseTracking() ?? false;
    } catch {
      return false;
    }
  }

  /** Encode a mouse report for the app at the pointer's cell (SGR or legacy X10). */
  private mouseReport(button: number, clientX: number, clientY: number, release = false): string {
    const terminal = this.terminal;
    if (!terminal) return '';
    const rect = this.getCanvas()?.getBoundingClientRect();
    const cell = (offset: number, size: number, count: number) =>
      rect && size > 0 ? Math.min(count, Math.max(1, Math.floor((offset / size) * count) + 1)) : 1;
    const col = cell(clientX - (rect?.left ?? 0), rect?.width ?? 0, terminal.cols);
    const row = cell(clientY - (rect?.top ?? 0), rect?.height ?? 0, terminal.rows);
    // DEC 9 (X10 compatibility) reports presses only.
    if (release && ![1000, 1002, 1003].some((mode) => terminal.getMode(mode))) return '';
    if (terminal.getMode(1006)) return `\x1b[<${button};${col};${row}${release ? 'm' : 'M'}`;
    // X10 has no per-button release: release is button 3. Reports travel as UTF-8 text, so
    // coordinates are capped at 95 to keep each byte below 128.
    const code = release ? 3 : button;
    return `\x1b[M${String.fromCharCode(32 + code, 32 + Math.min(col, 95), 32 + Math.min(row, 95))}`;
  }

  /** `scroll`: wheel reports, which do not take the session's size (InputManager.sendInputText). */
  private sendToApp(text: string, scroll = false) {
    if (!text) return;
    const detail = scroll ? { text, scroll } : { text };
    this.dispatchEvent(new CustomEvent('terminal-input', { detail, bubbles: true }));
  }

  /** Report wheel steps to the app at the pointer's cell. */
  private sendWheel(direction: 'up' | 'down', steps: number, clientX: number, clientY: number) {
    if (steps <= 0) return;
    this.sendToApp(
      this.mouseReport(direction === 'up' ? 64 : 65, clientX, clientY).repeat(steps),
      true
    );
  }

  /** Wheel steps to the app, counted for our scrollbar (terminal-app-scroll.ts), which shows. */
  private wheelApp(direction: 'up' | 'down', steps: number, clientX: number, clientY: number) {
    if (steps <= 0) return;
    const screen = this.appScreen();
    if (screen && this.appScroll.needsScreen)
      this.appScroll.observe(screen, this.terminal?.cols ?? 0);
    this.sendWheel(direction, steps, clientX, clientY);
    this.appScroll.wheel(direction === 'up' ? steps : -steps, performance.now());
    if (this.appScrollSettleTimer) clearTimeout(this.appScrollSettleTimer);
    this.appScrollSettleTimer = setTimeout(() => {
      this.appScrollSettleTimer = null;
      if (this.appScroll.settle(performance.now())) this.updateScrollbar(false);
    }, APP_SCROLL_SETTLE_MS);
    this.updateScrollbar(true);
  }

  /** The rows on screen now, as text (an app's full screen has no history above them). */
  private appScreen(): string[] | null {
    const term = this.terminal;
    if (!term) return null;
    const buffer = term.buffer.active;
    const start = Math.max(0, buffer.length - term.rows);
    const rows: string[] = [];
    for (let row = start; row < buffer.length; row++) {
      rows.push(buffer.getLine(row)?.translateToString(true) ?? '');
    }
    return rows;
  }

  /** Output reached the screen: once a frame, how far it moved the app (terminal-app-scroll.ts). */
  private scheduleAppScrollFrame() {
    if (!this.appScroll.active || this.appScrollFrame !== null) return;
    this.appScrollFrame = requestAnimationFrame(() => {
      this.appScrollFrame = null;
      if (!this.appHandlesScrolling()) {
        // The app let go of the mouse (it quit, or left its full screen).
        this.appScroll.reset();
        this.updateScrollbar(false);
        return;
      }
      try {
        // A synchronized update half written: its frame is not on screen yet.
        if (this.terminal?.getMode(2026)) return;
      } catch {
        // ghostty without the mode: every write is a frame.
      }
      const screen = this.appScreen();
      if (!screen) return;
      if (this.appScroll.frame(screen, this.terminal?.cols ?? 0, performance.now())) {
        this.updateScrollbar(false);
      }
      // A screen half drawn waits for its frame; with no more output, it is looked at again.
      if (this.appScroll.holding && this.appScrollRecheck === null) {
        this.appScrollRecheck = setTimeout(() => {
          this.appScrollRecheck = null;
          this.scheduleAppScrollFrame();
        }, HOLD_MS);
      }
    });
  }

  /**
   * An app in the session asked to put text on the clipboard (OSC 52: Claude Code's mouse
   * selection, vim, tmux with set-clipboard). Live output only (connection-manager.ts); written
   * while this terminal is on screen in the focused page.
   */
  public copyFromApp(request: { text: string } | { tooLong: true }) {
    this.desktopCopy.copyFromApp(request);
  }

  /** The text Cmd+C copies now: the mouse selection, as terminal-clipboard.ts reads it. */
  public getSelectedText(): string {
    return this.desktopCopy.selectedText();
  }

  private notifyAppCopy(result: AppCopyResult) {
    if (result.kind === 'copied') {
      toast({
        kind: 'success',
        text: t('terminal.appCopied', {
          count: result.text.length,
          preview: copyPreview(result.text),
        }),
        key: 'terminal-app-copy',
      });
    } else if (result.kind === 'tooLong') {
      toast({ kind: 'error', text: t('terminal.appCopyTooLong'), key: 'terminal-app-copy' });
    } else {
      // A click copies it: the browser wanted one (Safari, the page lost its focus), or no key
      // or click came just before (output nobody asked for, terminal-clipboard.ts).
      const preview = copyPreview(result.text);
      toast({
        kind: 'attention',
        text: result.unasked
          ? t('terminal.appCopyAsk', { count: result.text.length, preview })
          : t('terminal.appCopyBlocked', { preview }),
        key: 'terminal-app-copy',
        action: {
          label: t('terminalSelect.copy'),
          run: () => {
            void result.retry().then((ok) => {
              toast({
                kind: ok ? 'success' : 'error',
                text: t(ok ? 'copyMode.copied' : 'copyMode.copyFailed'),
                key: 'terminal-app-copy',
              });
            });
          },
        },
        timeoutMs: 0,
      });
    }
  }

  /**
   * A tap or plain click is a left click for apps that track the mouse, so on-screen
   * controls (Claude Code's "Jump to bottom", its input cursor) react where you touched.
   */
  private sendClick(clientX: number, clientY: number) {
    if (!this.appHandlesScrolling()) return;
    this.sendToApp(
      this.mouseReport(0, clientX, clientY) + this.mouseReport(0, clientX, clientY, true)
    );
  }

  /**
   * A tap on Claude Code's classic prompt moved the caret up or down to the tapped row; the
   * presses along that row wait for the cursor to show it got there (prompt-caret.ts).
   */
  private caretMove: {
    target: CellPoint;
    timer: ReturnType<typeof setTimeout>;
    summary: string;
    vertical: string;
  } | null = null;

  private caretSettleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Output arrived during a caret move: look at the cursor once the frame is complete. */
  private settleCaretMove() {
    if (this.caretSettleTimer !== null) clearTimeout(this.caretSettleTimer);
    this.caretSettleTimer = setTimeout(() => {
      this.caretSettleTimer = null;
      this.continueCaretMove();
    }, CARET_SETTLE_MS);
  }

  /** The cell gap under a point: the tapped row, and the column a caret there would sit at. */
  private caretCellAt(clientX: number, clientY: number): CellPoint | null {
    const terminal = this.terminal;
    const rect = this.getCanvas()?.getBoundingClientRect();
    if (!terminal || !rect || rect.width <= 0 || rect.height <= 0) return null;
    const viewRow = Math.floor(((clientY - rect.top) / rect.height) * terminal.rows);
    if (viewRow < 0 || viewRow >= terminal.rows) return null;
    const col = Math.round(((clientX - rect.left) / rect.width) * terminal.cols);
    return {
      row: this.screenTopRow() - Math.max(0, Math.floor(terminal.getViewportY())) + viewRow,
      col: Math.max(0, Math.min(terminal.cols, col)),
    };
  }

  /** The buffer row at the top of the live screen (the cursor's rows count from it). */
  private screenTopRow(): number {
    const terminal = this.terminal;
    return terminal ? Math.max(0, terminal.buffer.active.length - terminal.rows) : 0;
  }

  private cursorCell(): CellPoint | null {
    const buffer = this.terminal?.buffer.active;
    return buffer ? { row: this.screenTopRow() + buffer.cursorY, col: buffer.cursorX } : null;
  }

  /** A row's cells for prompt-caret.ts; dim cells (placeholder, suggestion) read as empty. */
  private promptRowCells = (row: number): PromptRowCells | null => {
    const line = this.terminal?.buffer.active.getLine(row);
    if (!line) return null;
    const cells: PromptRowCells = [];
    for (let col = 0; col < line.length; col++) {
      const cell = line.getCell(col);
      if (!cell) cells.push(' ');
      else if (cell.getWidth() === 0) cells.push('');
      else cells.push(cell.isDim?.() ? ' ' : cell.getChars() || ' ');
    }
    return cells;
  };

  private sendArrows(direction: 'up' | 'down' | 'left' | 'right', count: number) {
    this.sendToApp(arrowKeys(direction, count, this.terminal?.getMode(1) ?? false));
  }

  /**
   * A tap on Claude Code's classic prompt (no mouse reporting there) moves its caret to the
   * tapped character with arrow keys. Anything else on the screen is left as it was. Each tap
   * logs one line of positions (no text) so a phone's log shows what happened.
   */
  private moveCaretToTap(clientX: number, clientY: number) {
    const tap = this.caretCellAt(clientX, clientY);
    const cursor = this.cursorCell();
    if (!tap || !cursor) return;
    this.endCaretMove(null);
    const top = this.screenTopRow();
    const plan = planPromptCaret(this.promptRowCells, cursor, tap);
    const where = `cell ${tap.row - top},${tap.col}, cursor ${cursor.row - top},${cursor.col}, mouse tracking no`;
    if (!plan) {
      const prompt = findPromptRows(this.promptRowCells, cursor);
      const rows = prompt ? `${prompt.first - top}-${prompt.last - top}, tap outside` : 'none';
      logger.log(`terminal caret tap: ${where}, prompt rows ${rows}`);
      return;
    }
    const summary = `${where}, prompt rows ${plan.first - top}-${plan.last - top}`;
    if (plan.rows === 0) {
      this.finishCaretRow(plan.target, cursor, summary, '');
      return;
    }
    this.sendArrows(plan.rows < 0 ? 'up' : 'down', Math.abs(plan.rows));
    const vertical = `${plan.rows < 0 ? '↑' : '↓'}${Math.abs(plan.rows)} `;
    // Claude redraws within a round trip; a cursor that never reaches the row ends the move.
    const timer = setTimeout(
      () => this.endCaretMove(`${summary}, sent ${vertical}(cursor never reached the row)`),
      CARET_MOVE_TIMEOUT_MS
    );
    this.caretMove = { target: plan.target, timer, summary, vertical };
  }

  /** After output: once the cursor is on the tapped row, the presses along it. */
  private continueCaretMove() {
    const move = this.caretMove;
    const cursor = this.cursorCell();
    if (!move || !cursor || cursor.row !== move.target.row) return;
    clearTimeout(move.timer);
    this.caretMove = null;
    this.finishCaretRow(move.target, cursor, move.summary, move.vertical);
  }

  private finishCaretRow(target: CellPoint, cursor: CellPoint, summary: string, vertical: string) {
    const cells = this.promptRowCells(target.row) ?? [];
    const steps = promptCharacterSteps(cells, cursor.col, target.col);
    this.sendArrows(steps < 0 ? 'left' : 'right', Math.abs(steps));
    logger.log(
      `terminal caret tap: ${summary}, sent ${vertical}${steps < 0 ? '←' : '→'}${Math.abs(steps)}`
    );
  }

  private endCaretMove(reason: string | null) {
    if (this.caretSettleTimer !== null) clearTimeout(this.caretSettleTimer);
    this.caretSettleTimer = null;
    if (!this.caretMove) return;
    clearTimeout(this.caretMove.timer);
    this.caretMove = null;
    if (reason) logger.log(`terminal caret tap: ${reason}`);
  }

  private mouseDownAt: { x: number; y: number } | null = null;

  /** When the last touch ended; iOS follows a tap with emulated mouse events at the same spot. */
  private lastTouchEndAt = Number.NEGATIVE_INFINITY;

  private noteTouchEnd = () => {
    this.lastTouchEndAt = performance.now();
  };

  /**
   * 2026-10-03: a tap sent Claude Code two clicks, one from touchend and one from the mouse
   * events iOS emulates right after it. Claude read them as a double click and selected a word,
   * or after two taps a whole line, and its auto-copy said "copied 85 chars to clipboard".
   * The touch already sent its click, so mouse events this soon after a touch are ignored.
   */
  private isEmulatedMouse(): boolean {
    return performance.now() - this.lastTouchEndAt < EMULATED_MOUSE_MS;
  }

  private handleContainerMouseDown = (event: MouseEvent) => {
    this.mouseDownAt =
      event.button === 0 && !this.isEmulatedMouse() ? { x: event.clientX, y: event.clientY } : null;
  };

  private handleContainerMouseUp = (event: MouseEvent) => {
    const start = this.mouseDownAt;
    this.mouseDownAt = null;
    // Drags select text; only a still, unmodified click goes to the app (Shift/Cmd/Ctrl/Alt
    // keep it local, as in native terminals).
    if (!start || Math.abs(event.clientX - start.x) > 3 || Math.abs(event.clientY - start.y) > 3) {
      return;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    this.sendClick(event.clientX, event.clientY);
  };

  private wheelRemainder = 0;

  private handleWheel = (event: WheelEvent): boolean => {
    // Shift+wheel scrolls the local scrollback even when the app tracks the mouse.
    if (event.shiftKey || !this.appHandlesScrolling()) {
      // ghostty scrolls by rows from here: whatever a touch left between rows goes.
      this.settleOnRow();
      return false;
    }
    const rowHeight = this.terminal?.renderer?.getMetrics().height ?? this.fontSize * 1.2;
    const delta =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * rowHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * rowHeight * (this.terminal?.rows ?? 24)
          : event.deltaY;
    this.wheelRemainder += delta;
    const steps = Math.trunc(this.wheelRemainder / rowHeight);
    if (steps !== 0) {
      this.wheelRemainder -= steps * rowHeight;
      this.wheelApp(steps > 0 ? 'down' : 'up', Math.abs(steps), event.clientX, event.clientY);
    }
    return true;
  };

  private resetTouchScroll = () => {
    this.touchScrolling = false;
  };

  /**
   * ?scrollperf in this tab's URL, or "scrollPerf": true in the server's config.json: the
   * installed PWA has no address bar for the flag (2026-10-03, QA on the iPhone). The server
   * is asked when a touch begins, at most once a minute; its answer applies from the next
   * scroll, and turning it off there stops the measuring.
   */
  private refreshScrollPerf() {
    if (scrollPerfRequested()) {
      this.scrollPerf ??= new ScrollPerfRecorder();
      return;
    }
    const now = performance.now();
    if (now - this.scrollPerfCheckedAt < 60_000) return;
    this.scrollPerfCheckedAt = now;
    void serverConfigService.loadConfig().then((config) => {
      if (config.scrollPerf === true) {
        this.scrollPerf ??= new ScrollPerfRecorder();
      } else if (this.scrollPerf && !scrollPerfRequested()) {
        this.scrollPerf.end();
        this.scrollPerf = null;
      }
    });
  }

  private reducedMotion(): boolean {
    try {
      this.motionQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)');
      return this.motionQuery.matches;
    } catch {
      return false;
    }
  }

  /** iOS cancelled the gesture (system swipe, alert): drop any pinch preview, change nothing. */
  private handleTerminalTouchCancel = () => {
    this.cancelLongPress();
    if (this.longPressed) this.touchSelection.release();
    this.longPressed = false;
    this.pinchStartDistance = 0;
    this.pinchScale = 1;
    this.applyCanvasTransform();
    this.pinched = false;
    this.touchCaughtScroll = false;
    this.touchScroller.cancel();
    this.resetTouchScroll();
  };

  private handleTerminalTouchEnd = (event: TouchEvent) => {
    this.cancelLongPress();
    // The last finger lifted: a scroll flings on, springs back from a stretch, or stops.
    if (event.touches.length === 0) {
      const velocity = this.touchScroller.release(this.touchTime(event));
      if (velocity !== null) this.scrollPerf?.release(Math.abs(velocity));
    }
    const caughtScroll = this.touchCaughtScroll && event.touches.length === 0;
    if (event.touches.length === 0) this.touchCaughtScroll = false;
    if (this.pinchStartDistance > 0 && event.touches.length < 2) {
      const size = this.pinchFontSize(this.pinchScale);
      this.pinchScale = 1;
      this.applyCanvasTransform();
      this.pinchStartDistance = 0;
      // The finger still down continues as a scroll from where it is now, not from where it
      // was before the pinch (that made the terminal jump).
      const remaining = event.touches[0];
      if (remaining) {
        this.touchStartX = remaining.clientX;
        this.touchStartY = remaining.clientY;
        this.lastTouchX = remaining.clientX;
        this.lastTouchY = remaining.clientY;
      }
      if (size !== this.pinchStartFont) {
        this.dispatchEvent(
          new CustomEvent('font-size-change', { detail: { size }, bubbles: true, composed: true })
        );
      }
    }
    // The finger still down after a pinch must not count as a tap when it lifts.
    if (this.pinched) {
      if (event.touches.length === 0) this.pinched = false;
      this.resetTouchScroll();
      return;
    }
    // A long press started a selection: no tap, and no synthetic click that would focus the
    // keyboard catcher and raise the keyboard (or let ghostty start a selection of its own).
    if (this.longPressed) {
      if (event.touches.length === 0) {
        this.longPressed = false;
        this.touchSelection.release();
      }
      if (event.cancelable) event.preventDefault();
      this.resetTouchScroll();
      return;
    }
    const touch = event.changedTouches[0];
    const isTap =
      !this.touchScrolling &&
      event.touches.length === 0 &&
      touch !== undefined &&
      Math.abs(touch.clientX - this.touchStartX) < 10 &&
      Math.abs(touch.clientY - this.touchStartY) < 10;
    this.resetTouchScroll();
    // A touch that stopped a fling only stops it (iOS): no click for the app, no keyboard, and
    // no synthetic click that would focus the keyboard catcher.
    if (isTap && caughtScroll) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    // A tap with text selected only ends the selection, as on iOS.
    if (isTap && this.touchSelection.active) {
      if (event.cancelable) event.preventDefault();
      this.touchSelection.clear();
      return;
    }
    if (isTap && touch) {
      // Apps that track the mouse get the click; Claude Code's classic prompt does not track
      // it, so there the tap becomes the arrow keys that put its caret where the finger was.
      if (this.appHandlesScrolling()) this.sendClick(touch.clientX, touch.clientY);
      else this.moveCaretToTap(touch.clientX, touch.clientY);
    }
    if (isTap) {
      // Dispatched synchronously inside touchend so listeners can still open the iOS keyboard.
      // With the catcher up, the tap focuses it natively and that opens the keyboard.
      this.dispatchEvent(
        new CustomEvent('terminal-tap', {
          bubbles: true,
          composed: true,
          detail: { keyboardCatcher: this.keyboardCatcher },
        })
      );
    }
  };

  /**
   * ghostty-web focuses its own textarea on every canvas touchend. When the session view owns
   * the soft keyboard (disableClick: mobile direct-keyboard mode) that opened the iOS keyboard
   * without quick keys, with the form-assistant bar, and with the layout never adjusting.
   */
  private syncNativeInputFocus() {
    // ghostty-web also makes its container contenteditable and focuses it on open: when
    // that happened inside a gesture (swiping to another session) iOS raised its own
    // keyboard for the container.
    const container = this.container;
    if (container) {
      container.setAttribute('contenteditable', this.disableClick ? 'false' : 'true');
      if (this.disableClick && document.activeElement === container) container.blur();
    }
    const textarea = container?.querySelector('textarea');
    if (!textarea) return;
    if (this.disableClick) {
      textarea.readOnly = true;
      textarea.tabIndex = -1;
      textarea.setAttribute('inputmode', 'none');
      textarea.focus = () => {};
      if (document.activeElement === textarea) textarea.blur();
    } else {
      Reflect.deleteProperty(textarea, 'focus');
      textarea.readOnly = false;
      textarea.tabIndex = 0;
      textarea.removeAttribute('inputmode');
    }
  }

  private syncKeyboardCatcher() {
    const container = this.container;
    if (!container) return;
    if (!this.catcher) {
      const catcher = document.createElement('textarea');
      catcher.className = 'keyboard-catcher';
      catcher.rows = 1;
      catcher.tabIndex = -1;
      catcher.setAttribute('aria-hidden', 'true');
      catcher.setAttribute('autocomplete', 'off');
      catcher.setAttribute('autocapitalize', 'none');
      catcher.setAttribute('autocorrect', 'off');
      catcher.setAttribute('spellcheck', 'false');
      catcher.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;outline:none;' +
        'resize:none;opacity:0.01;font-size:16px;color:transparent;background:transparent;' +
        'caret-color:transparent;z-index:2;-webkit-user-select:none;user-select:none;' +
        '-webkit-touch-callout:none;touch-action:pinch-zoom;';
      catcher.addEventListener('focus', () => {
        this.dispatchEvent(
          new CustomEvent('terminal-keyboard-request', { bubbles: true, composed: true })
        );
      });
      this.catcher = catcher;
    }
    if (this.catcher.parentElement !== container) {
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      container.appendChild(this.catcher);
    }
    this.catcher.style.display = this.keyboardCatcher ? 'block' : 'none';
    if (!this.keyboardCatcher && document.activeElement === this.catcher) this.catcher.blur();
  }

  private attachTouchScrollHandlers() {
    this.container?.addEventListener('touchstart', this.handleTerminalTouchStart, {
      passive: true,
    });
    this.container?.addEventListener('touchmove', this.handleTerminalTouchMove, {
      passive: false,
    });
    // Not passive: after a long press, touchend cancels the click iOS would synthesize.
    this.container?.addEventListener('touchend', this.handleTerminalTouchEnd, { passive: false });
    this.container?.addEventListener('touchend', this.noteTouchEnd, { passive: true });
    this.container?.addEventListener('mousedown', this.handleContainerMouseDown);
    this.container?.addEventListener('mouseup', this.handleContainerMouseUp);
    this.container?.addEventListener('touchcancel', this.handleTerminalTouchCancel, {
      passive: true,
    });
  }

  private detachTouchScrollHandlers() {
    this.container?.removeEventListener('touchstart', this.handleTerminalTouchStart);
    this.container?.removeEventListener('touchmove', this.handleTerminalTouchMove);
    this.container?.removeEventListener('touchend', this.handleTerminalTouchEnd);
    this.container?.removeEventListener('touchend', this.noteTouchEnd);
    this.container?.removeEventListener('mousedown', this.handleContainerMouseDown);
    this.container?.removeEventListener('mouseup', this.handleContainerMouseUp);
    this.container?.removeEventListener('touchcancel', this.handleTerminalTouchCancel);
  }

  private cleanup() {
    this.initializationId++;
    this.unwatchCanvas();
    this.stopWatchingFonts?.();
    this.stopWatchingFonts = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.detachTouchScrollHandlers();
    this.cancelLongPress();
    this.touchSelection.dispose();
    this.desktopCopy.detach();
    this.scrollPerf?.end();
    this.touchScroller.reset();
    this.canvasShift = 0;
    this.canvasOverscroll = 0;
    this.paintedShift = 0;
    this.appliedTransform = null;
    if (this.canvasElement) Reflect.deleteProperty(this.canvasElement, 'getBoundingClientRect');
    this.canvasElement = null;
    this.canvasRows = null;
    this.canvasStale = false;
    if (this.scrollbarHideTimer) clearTimeout(this.scrollbarHideTimer);
    this.scrollbarHideTimer = null;
    if (this.appScrollSettleTimer) clearTimeout(this.appScrollSettleTimer);
    this.appScrollSettleTimer = null;
    if (this.appScrollRecheck) clearTimeout(this.appScrollRecheck);
    this.appScrollRecheck = null;
    if (this.appScrollFrame !== null) cancelAnimationFrame(this.appScrollFrame);
    this.appScrollFrame = null;
    this.appScroll.reset();
    this.scrollbar = null;
    this.scrollbarThumb = null;
    this.scrollbarGrab = null;

    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.catcher?.remove();
    this.catcher = null;
    this.container = null;
    this.pasteInput = null;
    this.preservedScrollPosition = null;
    this.outputEscapeTail = '';
  }

  private requestResize(source: string) {
    requestAnimationFrame(() => this.fitTerminal(source));
  }

  private requestResizeMeta(source: string) {
    this.pendingResizeSource = source;
    this.pendingResizePrev = { cols: this.lastCols || this.cols, rows: this.lastRows || this.rows };
  }

  private applyFontSize() {
    if (!this.terminal) return;
    this.terminal.options.fontSize = this.fontSize;
  }

  private getResolvedTheme() {
    const selected = resolveTerminalTheme(
      this.theme,
      getCurrentTheme(),
      TerminalPreferencesManager.getInstance().getAutoThemePair()
    );

    // ghostty-web paints on a canvas, which can't resolve var(--color-*): resolve them here.
    // Every theme carries selection colors: without them a phone selection got ghostty's light
    // grey with white text, hard to read (2026-10-10).
    const colors: Record<string, string> = { ...selected.colors };
    const root = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      Object.entries(colors).map(([key, value]) => {
        const name = typeof value === 'string' ? /^var\((--[\w-]+)\)$/.exec(value)?.[1] : undefined;
        return [key, name ? root.getPropertyValue(name).trim() || value : value];
      })
    ) as typeof colors;
  }

  /** The cursor follows the color theme; Auto's pairing can change under the same theme id. */
  private handleAccentChange = () => this.applyTheme();

  private applyTheme() {
    const term = this.terminal;
    if (!term) return;
    const theme = this.getResolvedTheme();
    // The canvas is a whole number of cells wide; paint the leftover strip in the terminal
    // background instead of the page background.
    if (this.container && theme.background) this.container.style.background = theme.background;

    const current = term.options.theme as Record<string, unknown> | undefined;
    const keys = new Set([...Object.keys(current ?? {}), ...Object.keys(theme)]);
    if (current && [...keys].every((key) => current[key] === theme[key])) return;
    if (!current) {
      term.options.theme = theme;
      return;
    }
    // 2026-10-12: assigning options.theme after open() only made ghostty-web log "theme
    // changes after open() are not yet fully supported" (on every session load, as this ran
    // right after open with an equal theme) and never repainted. Same colors: skipped above.
    // New colors: update the options object in place (no proxy set, no warning) and give
    // the renderer the palette itself, then repaint every row.
    for (const key of Object.keys(current)) delete current[key];
    Object.assign(current, theme);
    // A renderer without setTheme (test doubles) keeps its colors.
    if (typeof term.renderer?.setTheme !== 'function') return;
    term.renderer.setTheme(theme);
    this.canvasBackground = theme.background || '#1e1e1e';
    this.canvasStale = true;
    if (term.wasmTerm) term.renderer.render(term.wasmTerm, true, term.getViewportY(), term, 0);
  }

  private detectMobile() {
    const MOBILE_BREAKPOINT = 768;
    this.isMobile = window.innerWidth < MOBILE_BREAKPOINT;
  }

  private applyHorizontalFit() {
    if (!this.terminal || !this.container) return;
    const renderer = this.terminal.renderer;
    if (!renderer) return;

    const metrics = renderer.getMetrics();
    const charWidth = metrics?.width || renderer.charWidth || 8;
    const containerWidth = this.container.clientWidth || 0;
    if (containerWidth <= 0 || charWidth <= 0 || this.cols <= 0) return;

    const targetCharWidth = containerWidth / this.cols;
    const scale = targetCharWidth / charWidth;
    const newFontSize = Math.max(8, Math.min(32, this.fontSize * scale));
    if (!Number.isFinite(newFontSize)) return;
    this.fontSize = newFontSize;
    this.terminal.options.fontSize = newFontSize;
  }

  private computeConstrainedCols(proposedCols: number): number {
    const calculatedCols = Math.max(20, Math.floor(proposedCols));
    // A Mac-window session (fwd_) is no longer held at its window's width (user report
    // 2026-10-14: a phone left a strip unused, a desktop page a quarter of its width).
    if (this.maxCols > 0) return Math.min(calculatedCols, this.maxCols);
    return calculatedCols;
  }

  /** Whether this is a touch screen, where the cells follow terminal-touch-cells.ts. */
  private isTouchScreen(): boolean {
    return !!window.matchMedia?.('(pointer: coarse)').matches;
  }

  /**
   * On a touch screen, the real width of a letter at `size` (the grid's type size by default),
   * unrounded; null on a mouse/trackpad screen, where ghostty's whole-pixel cells stay.
   */
  private touchAdvance(size?: number): number | null {
    const term = this.terminal;
    if (!term || !this.isTouchScreen()) return null;
    const fontSize = size ?? Number(term.options.fontSize);
    const measured = measureAdvance(fontSize, String(term.options.fontFamily));
    if (measured) return measured;
    // No canvas to measure with: ghostty's (rounded) cell at the grid's type size.
    const width = term.renderer?.getMetrics().width;
    return width && size === undefined ? width : null;
  }

  /** The container's width inside its padding, kept for measures that must not reflow. */
  private measureTextWidth(): number {
    const element = this.container;
    if (!element?.clientWidth) return 0;
    const style = getComputedStyle(element);
    this.touchWidth =
      element.clientWidth -
      (Number.parseInt(style.paddingLeft, 10) || 0) -
      (Number.parseInt(style.paddingRight, 10) || 0);
    return this.touchWidth;
  }

  /**
   * Columns on a touch screen (user report 2026-10-14): as many as fit at the letter's real
   * width, left of a gap about a letter wide and our 3 px scrollbar's lane. FitAddon counts
   * whole-pixel cells and keeps 15 px for a scrollbar: a 440 px phone lost 4 columns to that.
   * Null on a mouse/trackpad screen, where the desktop measure stays as it was.
   */
  private touchCols(): number | null {
    const advance = this.touchAdvance();
    const width = advance ? this.measureTextWidth() : 0;
    if (!advance || !width) return null;
    return touchColsFor(touchTextArea(width, advance), advance);
  }

  /**
   * On a touch screen, the cell width for `cols` columns: they fill the text area exactly
   * (terminal-touch-cells.ts), on whole device pixels. `width` is the container's, measured
   * before (a replay's sizes must not reflow the page). Returns whether the width changed.
   */
  private applyTouchCells(cols: number, width = this.measureTextWidth()): boolean {
    const term = this.terminal;
    const renderer = term?.renderer as CellRenderer | undefined;
    const metrics = renderer?.metrics;
    const advance = this.touchAdvance();
    if (!term || !metrics || !advance || !(width > 0) || !(cols > 0)) {
      this.touchCell = null;
      return false;
    }
    const ratio = rendererRatio(renderer);
    const cell = touchCellWidth(touchTextArea(width, advance), cols, advance, ratio);
    this.touchCell = { size: Number(term.options.fontSize), ratio, width: cell };
    if (metrics.width === cell) return false;
    metrics.width = cell;
    return true;
  }

  /**
   * ghostty measures its cells again on a type size or font change, rounded up to a whole
   * pixel: on a touch screen they keep the width set for the grid (applyTouchCells), or the
   * letter's own snapped to device pixels until the grid is laid out at the new size.
   */
  private keepTouchCells(term: GhosttyTerminal) {
    const renderer = term.renderer as CellRenderer | undefined;
    if (!renderer || typeof renderer.measureFont !== 'function') return;
    const measure = renderer.measureFont.bind(renderer);
    renderer.measureFont = () => {
      const metrics = measure();
      const size = Number(renderer.fontSize);
      const ratio = rendererRatio(renderer);
      const cell = this.touchCell;
      if (cell && cell.size === size && cell.ratio === ratio) {
        metrics.width = cell.width;
        return metrics;
      }
      const advance = this.touchAdvance(size);
      if (advance) metrics.width = snappedCellWidth(advance, ratio);
      return metrics;
    };
  }

  /** The canvas to cells whose width changed with the grid's size unchanged. */
  private resizeCanvasToCells() {
    const term = this.terminal;
    if (!term?.renderer) return;
    term.renderer.resize(term.cols, term.rows);
    this.canvasStale = true;
    this.paintNow();
    this.updateScrollbar(false);
  }

  public fitTerminal(source = 'unknown') {
    if (!this.terminal || !this.fitAddon) return;
    this.detectMobile();

    if (this.fitHorizontally) {
      this.applyHorizontalFit();
    }

    const proposed = this.fitAddon.proposeDimensions();
    if (!proposed) return;

    const cols = this.computeConstrainedCols(this.touchCols() ?? proposed.cols);
    const rows = Math.max(6, Math.floor(proposed.rows));

    if (this.ptyLayout) {
      const layout = this.ptyLayout;
      // This screen changed size (keyboard, rotation) while showing a PTY of another size: it
      // lays that size out for its new area and reports its own size, which the server applies
      // only if this page owns the session's size (server/pty/size-owner.ts). A replay keeps
      // its layout.
      if (layout.rows === null && layout.container !== this.containerKey()) {
        this.relayoutPty();
        if (this.ptyLayout) this.reportOwnSize(source);
      } else this.applyPtyLayout();
      return;
    }

    const prevCols = this.lastCols || this.terminal.cols;
    const prevRows = this.lastRows || this.terminal.rows;

    // Under the chat view the rows never shrink: not with a rotation, nor in a new terminal
    // fitted while the keyboard is up (fifth review of 2026-10-03).
    const fitRows = this.holdRows ? Math.max(rows, prevRows) : rows;
    const recelled = this.applyTouchCells(cols);
    if (cols === prevCols && fitRows === prevRows) {
      if (recelled) this.resizeCanvasToCells();
      return;
    }

    this.requestResizeMeta(source);
    this.resizeGrid(cols, fitRows);
  }

  private containerKey(): string {
    const element = this.container;
    return element ? `${element.clientWidth}x${element.clientHeight}` : '';
  }

  /** This screen's own columns and rows at the user's type size (not a PTY layout's). */
  private measureOwnSize(): { cols: number; rows: number } | null {
    const term = this.terminal;
    const fit = this.fitAddon;
    if (!term || !fit) return null;
    if (term.options.fontSize !== this.fontSize) {
      // Shown smaller for a wider PTY: the measure from before still holds (same container).
      if (this.ownSize) return this.ownSize;
      term.options.fontSize = this.fontSize;
    }
    const proposed = fit.proposeDimensions();
    if (!proposed) return this.ownSize;
    const rows = Math.max(6, Math.floor(proposed.rows));
    this.ownSize = {
      cols: this.computeConstrainedCols(this.touchCols() ?? proposed.cols),
      rows: this.holdRows ? Math.max(rows, this.ownSize?.rows ?? 0) : rows,
    };
    return this.ownSize;
  }

  /**
   * The PTY's size, as the stream says it, in order with the output (connection-manager.ts):
   * the output that follows is laid out at it (see ptyLayout). While a history replay is
   * written, at its columns and rows; live, at its columns when they are not this screen's
   * (another client, the Mac window, has the size), the whole width shown with smaller type.
   * When the PTY has this screen's columns again, the grid is this screen's own fit.
   */
  public followPtySize(cols: number, rows: number, replaying: boolean): void {
    if (!this.terminal || !this.fitAddon) {
      this.pendingOutput.push({ cols, rows, replaying });
      return;
    }
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
    const current = this.ptyLayout;
    if (replaying && current && current.rows !== null) {
      // Another size within the same replay (a Mac window's history has hundreds): the screen
      // was measured at its start, and reading layout after each grid resize forced a reflow
      // of the page (user report 2026-10-14, slow «Cargando historial»).
      this.ptyLayout = { cols, rows, container: current.container, ptyRows: rows };
      this.applyPtyLayout(this.touchWidth);
      return;
    }
    const own = this.measureOwnSize();
    if (!own) return;
    if (replaying) {
      this.ptyLayout = { cols, rows, container: this.containerKey(), ptyRows: rows };
    } else if (cols === own.cols) {
      if (this.ptyLayout) this.endPtyLayout();
      return;
    } else {
      this.ptyLayout = { cols, rows: null, container: this.containerKey(), ptyRows: rows };
    }
    this.applyPtyLayout();
  }

  /** A replay is all written: on to the live layout (see followPtySize). */
  public ptyReplayEnded(): void {
    if (!this.terminal) {
      if (this.pendingOutput.length > 0) this.pendingOutput.push({ replayEnded: true });
      return;
    }
    const layout = this.ptyLayout;
    if (!layout || layout.rows === null) return;
    const own = this.measureOwnSize();
    if (!own) return;
    if (layout.cols === own.cols) {
      this.endPtyLayout();
      return;
    }
    this.ptyLayout = {
      cols: layout.cols,
      rows: null,
      container: this.containerKey(),
      ptyRows: layout.ptyRows,
    };
    this.applyPtyLayout();
  }

  /** Whether the grid is laid out at the PTY's size rather than this screen's. */
  public isFollowingPtySize(): boolean {
    return this.ptyLayout !== null;
  }

  /**
   * This screen's own columns and rows, the size it claims the PTY at, whatever size the grid
   * shows meanwhile (a PTY layout). Null while the terminal has no area (hidden).
   */
  public getOwnSize(): { cols: number; rows: number } | null {
    const term = this.terminal;
    const container = this.container;
    if (!term || !container || container.clientWidth === 0 || container.clientHeight === 0) {
      return null;
    }
    if (!this.ptyLayout) return { cols: term.cols, rows: term.rows };
    return this.measureOwnSize();
  }

  /**
   * During a live PTY layout the grid has the PTY's columns, so ghostty's resize events say
   * nothing about this screen: its own size goes out as a terminal-resize of its own.
   */
  private reportOwnSize(source: string) {
    const own = this.measureOwnSize();
    if (!own) return;
    const prev = this.reportedOwnSize;
    if (prev && prev.cols === own.cols && prev.rows === own.rows) return;
    this.reportedOwnSize = own;
    const detail: TerminalResizeDetail = {
      cols: own.cols,
      rows: own.rows,
      isMobile: this.isMobile,
      isHeightOnlyChange: prev !== null && prev.cols === own.cols,
      source: `own-size:${source}`,
    };
    this.dispatchEvent(new CustomEvent('terminal-resize', { detail, bubbles: true }));
  }

  /**
   * The type size a live PTY layout `cols` wide is shown at: the largest that shows all its
   * columns in this screen's width, up to PTY_FIT_MAX_SCALE times the user's (smaller for a
   * wider PTY, bigger for a narrower one; terminal-touch-cells.ts fillFontSize).
   */
  private ptyLayoutFontSize(cols: number, ownCols: number): number {
    const term = this.terminal;
    const family = String(term?.options.fontFamily);
    const advanceAt = (fontSize: number) => measureAdvance(fontSize, family) ?? 0;
    const width = this.measureTextWidth();
    const max = Math.floor(this.fontSize * PTY_FIT_MAX_SCALE * 4) / 4;
    if (width > 0 && advanceAt(this.fontSize) > 0) {
      return fillFontSize(width, cols, PTY_FIT_MIN_FONT, max, advanceAt, this.isTouchScreen());
    }
    // No canvas to measure with: in proportion to this screen's own columns.
    const scaled = Math.floor(((this.fontSize * ownCols) / cols) * 4) / 4;
    return Math.min(max, Math.max(PTY_FIT_MIN_FONT, scaled));
  }

  private endPtyLayout() {
    this.ptyLayout = null;
    this.reportedOwnSize = null;
    const term = this.terminal;
    if (term && term.options.fontSize !== this.fontSize) term.options.fontSize = this.fontSize;
    // ghostty reflows the wider rows into this screen's width (soft wraps, no fragments).
    this.fitTerminal('pty-layout-end');
  }

  /** The live PTY layout again for a new area: this screen's own size measured afresh. */
  private relayoutPty() {
    const term = this.terminal;
    const layout = this.ptyLayout;
    if (!term || !layout) return;
    if (term.options.fontSize !== this.fontSize) term.options.fontSize = this.fontSize;
    this.ownSize = null;
    const own = this.measureOwnSize();
    if (own && own.cols === layout.cols) {
      this.endPtyLayout();
      return;
    }
    this.ptyLayout = { ...layout, container: this.containerKey() };
    this.applyPtyLayout();
  }

  /**
   * `knownWidth`: the container's width measured before, within one replay (its sizes must
   * not reflow the page).
   */
  private applyPtyLayout(knownWidth?: number) {
    const term = this.terminal;
    const layout = this.ptyLayout;
    if (!term || !layout) return;
    let rows = layout.rows;
    if (rows === null) {
      const own = this.measureOwnSize();
      if (!own) return;
      rows = own.rows;
      // The whole width used: type small enough for a wider PTY's columns, or bigger for a
      // narrower one's, and the rows that fit at it. On a touch screen, the size whose letters
      // fit cells that fill the text area (user report 2026-10-14: 80 columns of whole-pixel
      // cells were 400 px, cut off at 390 px and 34 px short at 440; a phone's 57 columns
      // filled a quarter of a desktop page).
      const size = this.ptyLayoutFontSize(layout.cols, own.cols);
      if (term.options.fontSize !== size) term.options.fontSize = size;
      if (size !== this.fontSize) {
        const proposed = this.fitAddon?.proposeDimensions();
        if (proposed) rows = Math.max(6, Math.floor(proposed.rows));
      }
      // Never more rows than the PTY's: the app addresses its screen from the top (Claude's
      // repaint homes the cursor and clears its rows), and rows below them kept older text
      // under it (a phone showing a desktop's 43 rows in 85).
      rows = Math.min(rows, layout.ptyRows);
    }
    const recelled =
      knownWidth !== undefined && knownWidth > 0
        ? this.applyTouchCells(layout.cols, knownWidth)
        : this.applyTouchCells(layout.cols);
    if (term.cols === layout.cols && term.rows === rows) {
      if (recelled) this.resizeCanvasToCells();
      return;
    }
    // More rows keep the bottom in place, history rows coming down, here too (a replay, a
    // viewer): growing at the top left what a smaller size had pushed into the history there,
    // and the app's repaint for the larger size printed it again (user report 2026-10-14: a
    // phone keyboard's every hide left a copy of the screen in a Mac window's history).
    this.silentResize = true;
    try {
      this.resizeGrid(layout.cols, rows);
    } finally {
      this.silentResize = false;
    }
  }

  /**
   * More rows at the same width (the phone's keyboard going down) keep the bottom in place,
   * history rows coming down from above as in xterm, at once: Claude's prompt and status line
   * stay on the bottom edge while the PTY still has the old size (terminal-grow.ts). Not in the
   * middle of an escape sequence from the stream, which our cursor moves would cut short.
   */
  private resizeGrid(cols: number, rows: number) {
    const term = this.terminal;
    if (!term) return;
    const wasm = term.wasmTerm;
    if (!wasm || cols !== term.cols || rows <= term.rows || this.outputEscapeTail) {
      term.resize(cols, rows);
      return;
    }
    if (resizeKeepingBottom(wasm, rows, () => term.resize(cols, rows)) > 0) this.paintNow();
  }

  private async initializeTerminal() {
    if (this.terminal) return;
    const initializationId = ++this.initializationId;

    const container = this.querySelector(
      `#${TERMINAL_IDS.TERMINAL_CONTAINER}`
    ) as HTMLElement | null;
    if (!container) return;
    this.container = container;

    try {
      // A WASM instance of its own: on one shared instance, a new terminal showed the previous
      // session's text (2026-10-03, see createGhostty). Only the terminal keeps it, so it goes
      // when the terminal is disposed, or right away if this initialization is abandoned.
      // Meanwhile the font: ghostty measures its cells when it opens and a canvas does not wait
      // for a web font, so opening first drew (and sized) the cells with a fallback. At most
      // 1.5 s; a font that comes later is picked up by handleTerminalFontsLoaded.
      const [ghostty] = await Promise.all([createGhostty(), waitForTerminalFonts()]);
      if (
        initializationId !== this.initializationId ||
        !this.isConnected ||
        this.container !== container
      )
        return;

      const theme = this.getResolvedTheme();
      this.canvasBackground = theme.background || '#1e1e1e';
      const term = new GhosttyTerminal({
        cols: this.cols,
        rows: this.rows,
        fontSize: this.fontSize,
        fontFamily: TERMINAL_FONT_FAMILY,
        theme,
        cursorBlink: true,
        smoothScrollDuration: 120,
        disableStdin: true,
        ghostty,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      term.onData((text) => {
        // A prompt sent brings the app back to its bottom.
        if (text.includes('\r') && !text.startsWith('\x1b')) this.appScroll.submitted();
        this.dispatchEvent(new CustomEvent('terminal-input', { detail: { text }, bubbles: true }));
      });

      term.onResize(({ cols, rows }) => {
        if (this.silentResize) {
          // A PTY layout (followPtySize): the PTY already has this size, or another client's.
          this.settleOnRow();
          this.lastCols = cols;
          this.lastRows = rows;
          return;
        }
        const prev = this.pendingResizePrev ?? {
          cols: this.lastCols || cols,
          rows: this.lastRows || rows,
        };
        const source = this.pendingResizeSource ?? 'unknown';
        this.pendingResizePrev = null;
        this.pendingResizeSource = null;

        const isHeightOnlyChange = cols === prev.cols && rows !== prev.rows;
        // The text reflows: a touch scroll's pixels between rows no longer fit.
        this.settleOnRow();

        this.lastCols = cols;
        this.lastRows = rows;
        this.cols = cols;
        this.rows = rows;

        const detail: TerminalResizeDetail = {
          cols,
          rows,
          isMobile: this.isMobile,
          isHeightOnlyChange,
          source,
        };

        this.dispatchEvent(new CustomEvent('terminal-resize', { detail, bubbles: true }));
      });

      term.onScroll(() => {
        if (this.preservedScrollPosition !== null) return;
        this.followCursorEnabled = this.isAtBottom();
        this.updateScrollbar(true);
      });

      // Fresh mount
      container.innerHTML = '';
      term.open(container);
      this.scrollPerf = scrollPerfRequested() ? new ScrollPerfRecorder() : null;
      this.hookRenders(term);
      this.keepTouchCells(term);
      this.dropGhosttyScrollbar(term, container);
      this.desktopCopy.attach(term, container);
      this.createScrollbar(container);
      // The canvas gets its compositing layer now, not in the middle of the first scroll.
      this.applyCanvasTransform();
      term.registerLinkProvider(new KeyboardShortcutLinkProvider(term, this.handleShortcutClick));
      term.attachCustomWheelEventHandler(this.handleWheel);

      this.terminal = term;
      this.fitAddon = fitAddon;
      this.stopWatchingFonts = onTerminalFontsLoaded(this.handleTerminalFontsLoaded);

      // Size first, then initialize every cell. That alone left another session's text in the
      // history; the terminal's own WASM instance (createGhostty) is what keeps it out.
      this.fitTerminal('initial');
      term.clear();

      // ghostty-web does not translate touch pans into scrollback movement.
      this.attachTouchScrollHandlers();
      this.syncNativeInputFocus();
      this.syncKeyboardCatcher();
      this.applyTheme();

      if (this.pendingOutput.length > 0) {
        const segments = this.pendingOutput;
        const followCursor = this.pendingFollowCursor;
        this.pendingOutput = [];
        this.pendingFollowCursor = true;
        // Output and PTY sizes in their order: each stretch at the size it was drawn for.
        // In chunks, each on its own: one that fails loses its text, not the terminal.
        let text: string[] = [];
        const writeText = () => {
          if (text.length === 0) return;
          const pending = text.join('');
          text = [];
          this.outputEscapeTail = openEscapeTail(this.outputEscapeTail, pending);
          for (const chunk of outputChunks(pending, PENDING_WRITE_CHUNK)) {
            try {
              term.write(chunk);
            } catch (error) {
              logger.error(`failed to write ${chunk.length} chars of buffered output`, error);
            }
          }
        };
        try {
          for (const segment of segments) {
            if (typeof segment === 'string') {
              text.push(segment);
              continue;
            }
            writeText();
            if ('replayEnded' in segment) this.ptyReplayEnded();
            else this.followPtySize(segment.cols, segment.rows, segment.replaying);
          }
          writeText();
        } catch (error) {
          logger.error('failed to lay out buffered output', error);
        }
        if (followCursor) {
          requestAnimationFrame(() => {
            if (this.terminal === term && this.followCursorEnabled) term.scrollToBottom();
          });
        }
      }

      this.setAttribute('data-ready', 'true');

      // Follow up after layout settles; this should normally be a no-op.
      this.requestResize('initial');

      this.dispatchEvent(new CustomEvent('terminal-ready', { bubbles: true }));

      // Observe container resizes
      // Fitted in the observer itself, which runs after layout and before paint: the rows
      // follow the container (the keyboard going up or down) in the same frame. Through
      // requestResize they came a frame later. The canvas never outgrows the container, so
      // this cannot loop.
      this.resizeObserver = new ResizeObserver(() => this.fitTerminal('resize-observer'));
      this.resizeObserver.observe(this.container);
      this.watchCanvas();
      this.scheduleCanvasCheck('settled', CANVAS_SETTLE_MS);
    } catch (error) {
      logger.error('failed to initialize ghostty terminal', error);
    }
  }

  /**
   * Wraps ghostty-web's renderer.render, which its requestAnimationFrame loop calls on every
   * frame. ghostty-web 0.4 redraws every row on each call while the view is scrolled back
   * (render() marks all rows dirty when viewportY > 0), even when nothing changed: reading the
   * history kept a phone redrawing rows × cols glyphs 60 times a second, fetching each row from
   * the WASM again, and a touch scroll had to share the main thread with that. A frame
   * identical to the last one painted is skipped: same scrolled-back line, nothing written
   * since (the WASM's dirty state), no selection, no link hover change. ghostty's scrollbar
   * fade loops render on their own every frame for 200 ms: as its scrollbar is never painted
   * (see dropGhosttyScrollbar), those frames are skipped too. At the bottom ghostty only
   * redraws what changed (and the blinking cursor): left alone.
   */
  private hookRenders(term: GhosttyTerminal) {
    const renderer = term.renderer;
    if (!renderer) return;
    const render = renderer.render.bind(renderer);
    this.canvasRows = null;
    // Hovering a link (desktop) or selecting changes what is drawn without dirtying a row.
    const setHoveredHyperlinkId = renderer.setHoveredHyperlinkId.bind(renderer);
    renderer.setHoveredHyperlinkId = (id) => {
      this.canvasStale = true;
      setHoveredHyperlinkId(id);
    };
    const setHoveredLinkRange = renderer.setHoveredLinkRange.bind(renderer);
    renderer.setHoveredLinkRange = (range) => {
      this.canvasStale = true;
      setHoveredLinkRange(range);
    };
    term.onSelectionChange(() => {
      this.canvasStale = true;
    });

    renderer.render = (buffer, forceAllRows, viewportY, scrollback) => {
      let forceAll = forceAllRows;
      // The page's pixel ratio, checked on every frame (ghostty keeps the one from when it
      // opened; see terminal-pixel-ratio.ts): a canvas opened at another one was drawn at a
      // lower resolution and stretched, blurry until the terminal was made again (cold start
      // of the iPhone home-screen app, 2026-10-12). ghostty's render() then sees the canvas at
      // the wrong size and resizes and redraws it at this ratio, here or when the paint is let go.
      const ratio = currentPixelRatio();
      const previousRatio = syncRendererPixelRatio(renderer, ratio);
      if (previousRatio !== null) {
        this.canvasStale = true;
        // Cells on whole device pixels at the new ratio (terminal-touch-cells.ts).
        this.applyTouchCells(term.cols, this.touchWidth);
        logger.warn(
          `pixel ratio ${previousRatio} -> ${ratio}: canvas redrawn at it (${term.cols}x${term.rows})`
        );
      }
      // The canvas's pixels for its cells at this ratio, checked before any frame is skipped:
      // ghostty's resize and font change leave them at the CSS size (1x) and count on their own
      // render to size them back, which a held paint or a skipped frame never let through. The
      // canvas stayed stretched and blurry (cold start of the iPhone home-screen app, user
      // report 2026-10-12; see terminal-canvas-health.ts). Sized again here, then every row.
      const canvas = this.getCanvas();
      if (
        canvas &&
        canvasSizeMismatch(canvas, term.cols, term.rows, renderer.getMetrics(), ratio)
      ) {
        renderer.resize(term.cols, term.rows);
        this.canvasStale = true;
        forceAll = true;
      }
      // A history replay is being written: painted once it is all in (see holdPaint).
      if (this.paintHeld) return;
      const line = viewportY ?? term.getViewportY();
      // A selection ghostty clears says nothing: one more paint after it takes the highlight off.
      const selection = term.hasSelection();
      // At the bottom ghostty draws the cursor, and with cursorBlink it repainted the cursor's
      // row on every frame (reading the whole screen from the WASM for it): in Claude Code's
      // full screen, where a touch scroll only sends wheel steps, the canvas was rendered 190
      // times in 189 frames, 9 ms each at 3x and 74 rows (2026-10-04, iPhone). What it draws
      // only changes with the cursor's place or visibility, or a blink (every 530 ms).
      const cursor = line > 0 ? undefined : cursorKey(term);
      const painted = this.canvasRows;
      if (
        !forceAll &&
        !this.canvasStale &&
        !selection &&
        painted !== null &&
        !painted.selection &&
        painted.viewportY === line &&
        painted.cursor === cursor &&
        term.wasmTerm?.isDirty() === false
      ) {
        return;
      }
      this.canvasStale = false;
      // ?scrollperf: the text moves on the canvas (not only a blink or new output in place).
      const moved = painted?.viewportY !== line || this.paintedShift !== this.targetShift();
      this.canvasRows = { viewportY: line, selection, cursor };
      // Text drawn lower by a touch scroll: ghostty's rows (only the changed ones, at the
      // bottom) would land between them. Every row, then moved down again (drawMovedText).
      if (this.paintedShift !== 0) forceAll = true;
      const perf = this.scrollPerf;
      const started = perf?.recording ? performance.now() : 0;
      // Scrollbar opacity 0: ghostty paints none on the canvas (see dropGhosttyScrollbar).
      const changed = forceAll || term.wasmTerm?.isDirty() !== false;
      render(buffer, forceAll, line, scrollback, 0);
      if (perf?.recording) perf.render(performance.now() - started);
      // The rows moved (scroll, output): the selection's handles go with them.
      if (this.touchSelection.active) this.touchSelection.layout(changed);
      this.paintedShift = 0;
      if (moved) this.scrollPerf?.canvasDrawn(frameKey());
      const shift = this.targetShift();
      if (shift !== 0) {
        try {
          const canvas = this.getCanvas();
          const ctx = canvas?.getContext('2d');
          if (canvas && ctx) this.drawMovedText(canvas, ctx, Math.round(line), shift, shift);
        } catch (error) {
          // Inside ghostty's render loop: a throw would stop it painting for good.
          logger.warn('failed to move the text down between rows', error);
        }
      }
    };
  }

  /**
   * ghostty-web paints its scrollbar on the canvas, over the last columns, after clearing a
   * 14 px strip of them with the background (renderScrollbar): while it showed, the last
   * letters of every row were gone, and it moved with the touch scroll's shift and jumped back
   * at each row (2026-10-03, iPhone). The render hook never lets it paint (opacity 0); its mouse
   * zone goes too (the last 12 px of the canvas, where a click scrolled instead of selecting).
   * Ours stands beside the text instead (updateScrollbar).
   */
  private dropGhosttyScrollbar(term: GhosttyTerminal, container: HTMLElement) {
    const onMouseDown = (term as unknown as { handleMouseDown?: EventListener }).handleMouseDown;
    if (typeof onMouseDown === 'function') {
      container.removeEventListener('mousedown', onMouseDown, { capture: true });
    }
  }

  private createScrollbar(container: HTMLElement) {
    const bar = document.createElement('div');
    bar.className = 'terminal-scrollbar';
    bar.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('div');
    thumb.className = 'terminal-scrollbar-thumb';
    bar.appendChild(thumb);
    bar.addEventListener('pointerdown', this.handleScrollbarPointerDown);
    bar.addEventListener('pointermove', this.handleScrollbarPointerMove);
    bar.addEventListener('pointerup', this.handleScrollbarPointerUp);
    bar.addEventListener('pointercancel', this.handleScrollbarPointerUp);
    container.appendChild(bar);
    this.scrollbar = bar;
    this.scrollbarThumb = thumb;
  }

  /** Where our scrollbar and its thumb go for the view as it is now; null: no history. */
  private scrollbarLayout() {
    const term = this.terminal;
    const metrics = term?.renderer?.getMetrics();
    // An app that scrolls itself: its history as measured (terminal-app-scroll.ts), none
    // before it was scrolled.
    const app = this.appHandlesScrolling();
    const history = app
      ? this.appScroll.active
        ? this.appScroll.total
        : 0
      : this.getMaxScrollPosition();
    if (!term || !metrics || history <= 0) return null;
    const height = term.rows * metrics.height;
    const track = Math.max(0, height - SCROLLBAR_INSET * 2);
    const thumb = Math.min(
      track,
      Math.max(SCROLLBAR_MIN_THUMB, (track * term.rows) / (history + term.rows))
    );
    // How far the top of the view is from the oldest row, the touch scroll's pixels included.
    const fromTop = app
      ? (history - this.appScroll.offset) * metrics.height
      : (history - Math.round(term.getViewportY())) * metrics.height - this.touchScroller.offset;
    const fraction = Math.max(0, Math.min(1, fromTop / (history * metrics.height)));
    const ratio = window.devicePixelRatio || 1;
    // Right of the last column: FitAddon leaves 15 px there when it counts the columns, so the
    // bar showing or not never changes them. On a touch screen, a gap about a letter wide and
    // then its own 3 px lane (touchCols keeps both): never on or against the text.
    // A grid wider than the screen even at the smallest type (cut off on the right): the bar
    // stays in its lane at the screen's edge.
    const advance = this.touchAdvance();
    const left = term.cols * metrics.width + (advance ? touchScrollbarGap(advance) : 0);
    const lane = advance && this.touchWidth > 0 ? this.touchWidth - TOUCH_SCROLLBAR_WIDTH : left;
    return {
      left: Math.min(left, lane),
      height,
      track,
      thumb,
      top: Math.round((SCROLLBAR_INSET + (track - thumb) * fraction) * ratio) / ratio,
      history,
    };
  }

  /** Lays our scrollbar out for the view; `flash` shows it until the view rests a second. */
  private updateScrollbar(flash: boolean) {
    const bar = this.scrollbar;
    const thumb = this.scrollbarThumb;
    if (!bar || !thumb) return;
    const layout = this.scrollbarLayout();
    if (!layout) {
      bar.classList.remove('visible');
      return;
    }
    bar.style.left = `${layout.left}px`;
    bar.style.height = `${layout.height}px`;
    thumb.style.height = `${layout.thumb}px`;
    thumb.style.transform = `translate3d(0, ${layout.top}px, 0)`;
    if (!flash) return;
    bar.classList.add('visible');
    if (this.scrollbarHideTimer) clearTimeout(this.scrollbarHideTimer);
    this.scrollbarHideTimer = setTimeout(() => {
      this.scrollbarHideTimer = null;
      bar.classList.remove('visible');
    }, SCROLLBAR_HIDE_MS);
  }

  /** A mouse drags our scrollbar; it takes no touches (fingers scroll the terminal through it). */
  private handleScrollbarPointerDown = (event: PointerEvent) => {
    const bar = this.scrollbar;
    const layout = this.scrollbarLayout();
    if (!bar || !layout || event.pointerType === 'touch' || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.settleOnRow();
    const y = event.clientY - bar.getBoundingClientRect().top;
    const onThumb = y >= layout.top && y <= layout.top + layout.thumb;
    // Off the thumb, it jumps under the pointer first, as ghostty's did on its track.
    this.scrollbarGrab = {
      pointerId: event.pointerId,
      offset: onThumb ? y - layout.top : layout.thumb / 2,
    };
    bar.setPointerCapture?.(event.pointerId);
    bar.classList.add('dragging');
    if (!onThumb) this.dragScrollbarTo(y);
  };

  private handleScrollbarPointerMove = (event: PointerEvent) => {
    const bar = this.scrollbar;
    if (!bar || this.scrollbarGrab?.pointerId !== event.pointerId) return;
    this.dragScrollbarTo(event.clientY - bar.getBoundingClientRect().top);
  };

  private handleScrollbarPointerUp = (event: PointerEvent) => {
    if (this.scrollbarGrab?.pointerId !== event.pointerId) return;
    this.scrollbarGrab = null;
    this.scrollbar?.classList.remove('dragging');
    this.updateScrollbar(true);
  };

  /** Scrolls so that the point the mouse holds on the thumb sits `y` px down the bar. */
  private dragScrollbarTo(y: number) {
    const layout = this.scrollbarLayout();
    const grab = this.scrollbarGrab;
    if (!layout || !grab || layout.track <= layout.thumb) return;
    const fraction = (y - grab.offset - SCROLLBAR_INSET) / (layout.track - layout.thumb);
    const target = Math.round(Math.max(0, Math.min(1, fraction)) * layout.history);
    if (this.appHandlesScrolling()) {
      // The app scrolls: wheel steps toward the rows back the thumb stands for, counting the
      // steps still on their way so a drag does not send them again.
      const back = layout.history - target;
      const steps = Math.round((back - this.appScroll.expectedOffset) / this.appScroll.rowsPerStep);
      const box = this.getCanvas()?.getBoundingClientRect();
      const x = box ? box.left + box.width / 2 : 0;
      const y0 = box ? box.top + box.height / 2 : 0;
      // A third of a screen at a time at most: a move the app answers within one screen is
      // measured exactly (terminal-app-scroll.ts), a bigger one only estimated.
      const most = Math.max(
        1,
        Math.floor((this.terminal?.rows ?? 24) / 3 / this.appScroll.rowsPerStep)
      );
      this.wheelApp(steps > 0 ? 'up' : 'down', Math.min(Math.abs(steps), most), x, y0);
      return;
    }
    this.scrollToPosition(target);
  }

  private handleScrollToBottom = () => this.scrollToBottom();

  private handleShortcutClick = (controlCharacter: string) => {
    if (this.disableClick) return;

    this.dispatchEvent(
      new CustomEvent('terminal-input', {
        detail: { text: controlCharacter },
        bubbles: true,
      })
    );
  };

  private handleClick = (e: MouseEvent) => {
    if (this.disableClick) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('a[href]')) {
      // Keep native link behavior (especially important on mobile browsers).
      return;
    }
    const selection = document.getSelection();
    if (selection && selection.toString().length > 0) return;
    this.focus();
    this.pasteInput?.focus();
    this.pasteInput?.select();
  };

  private handlePaste = (e: ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) return; // let file/image paste handlers run

    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;

    e.preventDefault();
    e.stopPropagation();

    // Clear hidden textarea so it doesn't accumulate text
    if (this.pasteInput) this.pasteInput.value = '';

    this.dispatchEvent(new CustomEvent('terminal-paste', { detail: { text }, bubbles: true }));
  };

  /**
   * Return the rendered cursor position relative to the session terminal.
   * Desktop IME inputs use this to place the native candidate window at the cursor.
   */
  public getCursorInfo(): { x: number; y: number } | null {
    if (!this.terminal || !this.container) return null;

    try {
      const renderer = this.terminal.renderer;
      if (!renderer) return null;

      const metrics = renderer.getMetrics();
      const charWidth = metrics?.width || renderer.charWidth || 8;
      const charHeight = metrics?.height || renderer.charHeight || this.fontSize * 1.2;
      if (charWidth <= 0 || charHeight <= 0) return null;

      const buffer = this.terminal.buffer.active;
      const terminalRect = this.container.getBoundingClientRect();
      const absoluteX = terminalRect.left + buffer.cursorX * charWidth;
      const absoluteY = terminalRect.top + buffer.cursorY * charHeight;

      const sessionTerminal = document.getElementById(TERMINAL_IDS.SESSION_TERMINAL);
      if (!sessionTerminal) {
        return { x: absoluteX, y: absoluteY };
      }

      const sessionRect = sessionTerminal.getBoundingClientRect();
      return {
        x: absoluteX - sessionRect.left,
        y: absoluteY - sessionRect.top,
      };
    } catch (error) {
      logger.warn('Failed to get terminal cursor position:', error);
      return null;
    }
  }

  /**
   * Get the current input line (text the user has typed on the current line).
   * Used to sync chat mode input with the terminal state.
   */
  public getCurrentInputLine(): string {
    if (!this.terminal) return '';

    try {
      const buffer = this.terminal.buffer.active;
      const lineIndex = buffer.baseY + buffer.cursorY;
      const line = buffer.getLine(lineIndex);
      if (!line) return '';

      const lineText = line.translateToString(true).replace(/\s+$/g, '');
      if (!lineText.trim()) return '';

      const promptMatch = lineText.match(/[>$#%➜❯]\s*([^>$#%➜❯│┃|]*)/);
      if (promptMatch?.[1]) {
        const input = promptMatch[1]
          .replace(/[│┃┆┇┊┋|]/g, '')
          .replace(/\s+$/g, '')
          .trim();
        if (input && this.isPlaceholderText(input)) return '';
        return input;
      }

      return '';
    } catch (error) {
      logger.warn('Failed to get current input line:', error);
      return '';
    }
  }

  private isPlaceholderText(text: string): boolean {
    const lowerText = text.toLowerCase();

    if (
      lowerText.startsWith('type your message') ||
      lowerText.startsWith('type a message') ||
      lowerText.includes('@path/to/file') ||
      lowerText.includes('@path to file')
    ) {
      return true;
    }

    if (lowerText.startsWith('try "') || lowerText.startsWith("try '")) {
      return true;
    }

    if (
      lowerText.startsWith('enter your') ||
      lowerText.startsWith('enter a ') ||
      lowerText.startsWith('press enter') ||
      lowerText.startsWith('type here')
    ) {
      return true;
    }

    return false;
  }

  render() {
    return html`
      <style>
        ut-terminal {
          display: block;
          width: 100%;
          height: 100%;
        }
        .terminal-root {
          position: relative;
          width: 100%;
          height: 100%;
        }
        .terminal-container {
          width: 100%;
          height: 100%;
          overflow: hidden;
          font-family: ${TERMINAL_FONT_FAMILY};
          /* Own one-finger pans for scrollback while retaining two-finger page zoom. */
          touch-action: pinch-zoom;
          -webkit-user-select: text;
          user-select: text;
          /* A long press selects in the terminal (terminal-touch-select.ts), not iOS's callout. */
          -webkit-touch-callout: none;
        }
        /* On touch screens iOS started its own selection of the page beside ours (2026-10-10):
           the terminal's text is selected by terminal-touch-select.ts there. */
        @media (pointer: coarse) {
          .terminal-container {
            -webkit-user-select: none;
            user-select: none;
          }
        }
        ${TOUCH_SELECT_STYLES}
        .terminal-paste-input {
          position: absolute;
          left: -9999px;
          top: 0;
          width: 1px;
          height: 1px;
          opacity: 0;
          pointer-events: none;
        }
        /* Own class: the global .scroll-to-bottom styles (legacy 48px box, text-2xl,
           left-anchored) overflowed this button off the left edge on phones. */
        .terminal-scroll-bottom {
          position: absolute;
          right: 12px;
          bottom: 12px;
          z-index: 20;
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 6px 12px;
          font: 500 13px/1 ${TERMINAL_FONT_FAMILY};
          color: #fff;
          background: rgba(0, 0, 0, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 999px;
          -webkit-user-select: none;
          user-select: none;
          touch-action: manipulation;
        }
        .terminal-scroll-bottom.has-new-output {
          background: var(--color-primary, #ff6a00);
          border-color: transparent;
        }
        .terminal-scroll-bottom > svg {
          display: none;
        }
        /* Touch screens (phone spec 3.9, 2026-10-12): a 36 px pill centred at the bottom with
           44 px of finger, elevated neutral, sans; new output turns it primary. The desktop
           keeps its corner button. */
        @media (pointer: coarse) {
          .terminal-scroll-bottom {
            left: 50%;
            right: auto;
            transform: translateX(-50%);
            gap: 6px;
            height: 36px;
            padding: 0 14px 0 12px;
            /* 2026-10-12 (QA): elevated bg is nearly the terminal's own in both themes and
               the e2 shadow barely shows, so the pill was hard to find without a border. */
            border: 1px solid var(--color-border-strong);
            background: var(--color-bg-elevated);
            box-shadow: var(--shadow-e2);
            color: var(--color-text);
            font: 500 13px/1 var(--font-ui);
            white-space: nowrap;
            -webkit-tap-highlight-color: transparent;
          }
          .terminal-scroll-bottom::before {
            content: '';
            position: absolute;
            inset: -4px -2px;
          }
          .terminal-scroll-bottom > svg {
            display: block;
            width: 16px;
            height: 16px;
            flex: none;
          }
          .terminal-scroll-bottom > .terminal-scroll-glyph {
            display: none;
          }
          .terminal-scroll-bottom.has-new-output {
            border-color: transparent;
            background: var(--color-primary);
            color: var(--color-on-fill);
          }
        }
        /* Beside the text, never over it (see updateScrollbar); fingers scroll through it. */
        .terminal-scrollbar {
          position: absolute;
          top: 0;
          width: 12px;
          z-index: 1;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.3s ease-out;
        }
        .terminal-scrollbar.visible {
          opacity: 1;
          transition: none;
        }
        .terminal-loading-history {
          position: absolute;
          inset: 0;
          z-index: 15;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font: 500 13px/1 ${TERMINAL_FONT_FAMILY};
          color: rgba(255, 255, 255, 0.7);
          pointer-events: none;
        }
        .terminal-loading-history::before {
          content: '';
          width: 14px;
          height: 14px;
          border: 2px solid currentColor;
          border-right-color: transparent;
          border-radius: 50%;
          animation: terminal-loading-spin 0.8s linear infinite;
        }
        @keyframes terminal-loading-spin {
          to {
            transform: rotate(360deg);
          }
        }
        .terminal-scrollbar-thumb {
          position: absolute;
          top: 0;
          left: 4px;
          width: 4px;
          border-radius: 2px;
          background: rgba(128, 128, 128, 0.6);
        }
        /* Touch: a 3 px lane of its own, a letter's width right of the last column (touchCols
           keeps both, terminal-touch-cells.ts). */
        @media (pointer: coarse) {
          .terminal-scrollbar {
            width: 3px;
          }
          .terminal-scrollbar-thumb {
            left: 0;
            width: 3px;
            border-radius: 2px;
          }
        }
        /* A mouse can grab it: the strip beside the last column holds no text. */
        @media (hover: hover) and (pointer: fine) {
          .terminal-scrollbar {
            pointer-events: auto;
          }
          .terminal-scrollbar:hover,
          .terminal-scrollbar.dragging {
            opacity: 1;
            transition: none;
          }
          .terminal-scrollbar:hover .terminal-scrollbar-thumb,
          .terminal-scrollbar.dragging .terminal-scrollbar-thumb {
            left: 3px;
            width: 6px;
            border-radius: 3px;
          }
        }
      </style>

      <div class="terminal-root" @click=${this.handleClick} @paste=${this.handlePaste}>
        <textarea
          id=${TERMINAL_IDS.TERMINAL_INPUT}
          class="terminal-paste-input"
          aria-label=${t('terminal.input')}
          data-testid="terminal-input"
          tabindex="-1"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          @paste=${this.handlePaste}
        ></textarea>
        <div
          id=${TERMINAL_IDS.TERMINAL_CONTAINER}
          class="terminal-container"
          style="view-transition-name: session-${this.sessionId};"
        ></div>

        ${
          this.loadingHistory
            ? html`<div class="terminal-loading-history" role="status" data-testid="terminal-loading-history">
                ${t('terminal.loadingHistory')}
              </div>`
            : null
        }
        ${
          !this.hideScrollButton && !this.followCursorEnabled
            ? html`
              <button
                type="button"
                class="terminal-scroll-bottom ${this.newOutput ? 'has-new-output' : ''}"
                data-testid="terminal-scroll-bottom"
                aria-label=${t(this.newOutput ? 'terminal.scrollToNewOutput' : 'terminal.scrollToBottom')}
                @click=${this.handleScrollToBottom}
              >
<span class="terminal-scroll-glyph" aria-hidden="true">↓ </span>${icon('arrowDown', 16)}${t(this.newOutput ? 'terminal.newOutput' : 'terminal.bottom')}
              </button>
            `
            : null
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ut-terminal': Terminal;
  }
}

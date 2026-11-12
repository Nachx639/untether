/**
 * Untether Terminal Buffer Component
 *
 * The home cards' read-only terminal preview: the last lines of the session's buffer snapshot,
 * kept up to date over the terminal socket (2026-11-10: the full-width mode, with a cursor and
 * a font scaled to the columns, had no user and is gone).
 */
import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { terminalSocketClient } from '../services/terminal-socket-client.js';
import { TERMINAL_IDS } from '../utils/terminal-constants.js';
import {
  TERMINAL_THEME_CHANGED_EVENT,
  TerminalPreferencesManager,
} from '../utils/terminal-preferences.js';
import { type BufferCell, TerminalRenderer } from '../utils/terminal-renderer.js';
import { resolveTerminalTheme, type TerminalThemeId } from '../utils/terminal-themes.js';
import { getCurrentTheme } from '../utils/theme-utils.js';

interface BufferSnapshot {
  cols: number;
  rows: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  cells: BufferCell[][];
}

const TAIL_LINE_HEIGHT = 1.35;

/** Preview font: 10px, 9px on windows narrower than 1280px. */
function tailFontSize(): number {
  return typeof window !== 'undefined' && window.innerWidth < 1280 ? 9 : 10;
}

function isBlankRow(row: BufferCell[] | undefined): boolean {
  return !row || row.every((cell) => !cell.char || cell.char.trim() === '');
}

/**
 * The last `rows` lines of a snapshot, trailing blank rows dropped (the prompt or the spinner
 * is then the bottom line of the card). No cursor: a block in every card is noise.
 */
export function renderTail(cells: BufferCell[][], rows: number, lineHeight: number): string {
  let end = cells.length;
  while (end > 0 && isBlankRow(cells[end - 1])) end--;
  const start = Math.max(0, end - Math.max(1, rows));
  let out = '';
  for (let i = start; i < end; i++) {
    out += `<div class="terminal-line" style="height: ${lineHeight}px; line-height: ${lineHeight}px;">${TerminalRenderer.renderLineFromCells(cells[i], -1)}</div>`;
  }
  return out;
}

@customElement('ut-terminal-buffer')
export class UtTerminalBuffer extends LitElement {
  // Disable shadow DOM for Tailwind compatibility
  createRenderRoot() {
    return this as unknown as HTMLElement;
  }

  @property({ type: String }) sessionId = '';
  @property({ type: String }) theme: TerminalThemeId = 'auto';
  // One way to draw (home cards, 2026-10-12): a fixed small font (10px, 9px under 1280px), only
  // the last lines that fit, bottom-anchored, trailing blank rows trimmed, long lines faded out
  // on the right.
  /**
   * 'dark' paints the snapshot with the dark variant of the user's terminal theme whatever the
   * app appearance (preview wells are always dark), on a transparent background so the well's
   * --color-preview-bg shows. 'auto' follows the app.
   */
  @property({ type: String }) appearance: 'auto' | 'dark' = 'auto';

  @state() protected buffer: BufferSnapshot | null = null;
  @state() private error: string | null = null;
  @state() private displayedFontSize = 16;
  @state() private visibleRows = 0;

  /**
   * Looked up every time: after an error Lit renders the content div anew, and a node kept from
   * the first render would be written to while detached (2026-11-10: the card stayed blank).
   */
  private get container(): HTMLElement | null {
    return this.querySelector<HTMLElement>(`#${TERMINAL_IDS.BUFFER_CONTAINER}`);
  }

  private resizeObserver: ResizeObserver | null = null;
  private observedContainer: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;

  // Adaptive debouncing properties
  private updateTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastTouchTime = 0;
  private isMobileDevice = 'ontouchstart' in window;

  // Moved to render() method above

  disconnectedCallback() {
    this.unsubscribeFromBuffer();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
      this.observedContainer = null;
    }
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = null;
    }
    if (this.isMobileDevice) {
      document.removeEventListener('touchstart', this.handleTouchStart);
    }
    window.removeEventListener(TERMINAL_THEME_CHANGED_EVENT, this.handleThemeInputsChanged);
    this.appearanceObserver?.disconnect();
    this.appearanceObserver = null;
    super.disconnectedCallback();
  }

  firstUpdated() {
    // The subscription is made by updated() (sessionId is "changed" on the first render too).
    this.attachObservers();
  }

  /** Resize and touch tracking: set up on the first render and again after a re-attach. */
  private attachObservers() {
    this.setupResize();
    // Track touch events for adaptive debouncing
    if (this.isMobileDevice) {
      document.addEventListener('touchstart', this.handleTouchStart, { passive: true });
    }
  }

  updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has('sessionId')) {
      this.buffer = null;
      this.error = null;
      this.unsubscribeFromBuffer();
      if (this.sessionId) {
        this.subscribeToBuffer();
      }
    }

    // The content div is a new node after an error: watch the one on screen.
    this.setupResize();

    // Only update buffer content if the buffer itself changed
    // This prevents redundant updates during the update cycle
    // Also when the size changed: the lines carry their height inline.
    if (
      (changedProperties.has('buffer') ||
        changedProperties.has('displayedFontSize') ||
        changedProperties.has('visibleRows')) &&
      this.container &&
      this.buffer
    ) {
      this.updateBufferContent();
    }
  }

  private setupResize() {
    const container = this.container;
    if (!container || container === this.observedContainer) return;
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        this.calculateDimensions();
      });
    }
    if (this.observedContainer) this.resizeObserver.unobserve(this.observedContainer);
    this.resizeObserver.observe(container);
    this.observedContainer = container;
  }

  private calculateDimensions() {
    const container = this.container;
    if (!container) return;
    this.displayedFontSize = tailFontSize();
    this.visibleRows = Math.max(1, Math.floor(container.clientHeight / this.lineHeight()));
  }

  private subscribeToBuffer() {
    if (!this.sessionId) return;

    // Subscribe to buffer snapshots over v3 socket
    this.unsubscribe = terminalSocketClient.subscribe(this.sessionId, {
      snapshots: true,
      onSnapshot: (snapshot) => {
        this.buffer = snapshot;
        this.error = null;

        // Recalculate dimensions now that we have the actual cols
        this.calculateDimensions();

        // Request update which will trigger updated() lifecycle
        this.requestUpdate();
      },
      onError: (message) => {
        this.error = message;
        this.requestUpdate();
      },
    });
  }

  private unsubscribeFromBuffer() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** Auto follows the app's appearance and its pairing: repaint when either changes. */
  private appearanceObserver: MutationObserver | null = null;
  private handleThemeInputsChanged = () => {
    if (this.theme === 'auto') this.requestUpdate();
  };

  connectedCallback() {
    super.connectedCallback();
    // First connection: updated() subscribes. Moved in the DOM (disconnected, connected again):
    // everything disconnectedCallback dropped comes back (2026-11-10: the card stayed frozen).
    if (this.hasUpdated) {
      this.attachObservers();
      if (this.sessionId && !this.unsubscribe) this.subscribeToBuffer();
    }
    window.addEventListener(TERMINAL_THEME_CHANGED_EVENT, this.handleThemeInputsChanged);
    this.appearanceObserver = new MutationObserver(this.handleThemeInputsChanged);
    this.appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }

  private getTerminalTheme() {
    const pair = TerminalPreferencesManager.getInstance().getAutoThemePair();
    if (this.appearance === 'dark') {
      const resolved = resolveTerminalTheme(this.theme, 'dark', pair);
      // A fixed light theme would put dark-on-light text in a dark well: use the house one.
      return resolved.appearance === 'dark'
        ? resolved.colors
        : resolveTerminalTheme('untether', 'dark', pair).colors;
    }
    return resolveTerminalTheme(this.theme, getCurrentTheme(), pair).colors;
  }

  private lineHeight(): number {
    return this.displayedFontSize * TAIL_LINE_HEIGHT;
  }

  render() {
    const lineHeight = this.lineHeight();
    const terminalTheme = this.getTerminalTheme();
    // 2026-10-12: the size used to go into a <style> for every `ut-terminal-buffer
    // .terminal-container`, so the last card to render resized all the others. Inline now.
    const background = this.appearance === 'dark' ? 'transparent' : terminalTheme.background;

    return html`
      <div
        class="relative w-full h-full overflow-hidden"
        style="
          view-transition-name: terminal-${this.sessionId};
          background-color: ${background};
          color: ${terminalTheme.foreground};
        "
      >
        ${
          this.error
            ? html`
              <div class="absolute inset-0 flex items-center justify-center">
                <div class="text-status-error text-sm">${this.error}</div>
              </div>
            `
            : html`
              <div
                id="${TERMINAL_IDS.BUFFER_CONTAINER}"
                class="terminal-container w-full h-full vtb-tail overflow-hidden font-mono antialiased"
                style="font-size: ${this.displayedFontSize}px; line-height: ${lineHeight}px;"
              ></div>
            `
        }
      </div>
    `;
  }

  private handleTouchStart = () => {
    this.lastTouchTime = Date.now();
  };

  private scheduleBufferUpdate() {
    // Clear any existing timeout first
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = null;
    }

    // Calculate adaptive delay based on recent touch activity
    const now = Date.now();
    const timeSinceLastTouch = now - this.lastTouchTime;

    let delay: number;
    if (this.isMobileDevice && timeSinceLastTouch < 1000) {
      // Very conservative during and shortly after touch interaction
      delay = 200;
    } else if (this.isMobileDevice) {
      // Normal mobile delay
      delay = 100;
    } else {
      // Desktop stays fast
      delay = 16;
    }

    // Schedule the update
    this.updateTimeout = setTimeout(() => {
      this.updateTimeout = null;
      // Use the current buffer state directly
      if (this.buffer) {
        this.updateBufferContentImmediate();
      }
    }, delay);
  }

  private updateBufferContent() {
    // Use adaptive debouncing to prevent DOM thrashing on mobile
    this.scheduleBufferUpdate();
  }

  private updateBufferContentImmediate() {
    const container = this.container;
    if (!container || !this.buffer || this.visibleRows === 0) return;
    container.innerHTML = renderTail(this.buffer.cells, this.visibleRows, this.lineHeight());
  }
}

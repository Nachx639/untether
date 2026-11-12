/**
 * Terminal Lifecycle Manager
 *
 * Handles terminal setup, initialization, resizing, and cleanup operations
 * for session view components.
 */

import { isForwardedSession } from '../../../shared/forwarded-session.js';
import type { Session } from '../../../shared/types.js';
import { HttpMethod } from '../../../shared/types.js';
import { authClient } from '../../services/auth-client.js';
import { terminalSocketClient } from '../../services/terminal-socket-client.js';
import { getClientId } from '../../utils/client-id.js';
import { createLogger } from '../../utils/logger.js';
import type { TerminalThemeId } from '../../utils/terminal-themes.js';
import type { Terminal } from '../terminal.js';
import type { ConnectionManager } from './connection-manager.js';
import type { InputManager } from './input-manager.js';
import {
  cancelSizeGiveBack,
  FORWARDED_SIZE_GIVE_BACK_DELAY_MS,
  scheduleSizeGiveBack,
} from './size-give-back.js';

const logger = createLogger('terminal-lifecycle-manager');

/** The wait before a new size goes to the PTY, coalescing the resizes in between. */
export const RESIZE_DEBOUNCE_MS = 250;
/**
 * The same for a phone's soft keyboard going up or down (height only). The terminal already
 * shows the new rows locally, the bottom kept in place (terminal-grow.ts), so this only decides
 * when the app redraws for them: once, after the keyboard's resizes have settled. It was 400 ms,
 * which with the app's round trip left Claude's frame stale ~500 ms after the keyboard went
 * down (2026-10-04, iPhone SE simulator). Any viewport resize meanwhile restarts the wait
 * (keyboardStillMoving), so a keyboard animation still ends in a single resize.
 */
export const KEYBOARD_RESIZE_DEBOUNCE_MS = 150;

/**
 * After a session is opened, the wait before its first size goes to the PTY (and before it
 * claims the size back). User report (2026-10-14): swiping through sessions resized each one
 * passed by; a session only passed through now gets no resize, and the sizes the opening
 * terminal goes through (default, fit, keyboard) end in one.
 */
export const ENTRY_SETTLE_MS = 600;

/** The wait after a key or a tap before claiming the size: a burst of them makes one claim. */
export const CLAIM_DEBOUNCE_MS = 150;

/**
 * Whether the page has been used (a tap or a key anywhere) since it loaded: opening a session
 * then is a deliberate use of it, which claims its size; the session a reload or the home-screen
 * app's restart shows again by itself does not (server/pty/size-owner.ts).
 */
let pageUsed = false;
if (typeof document !== 'undefined') {
  const used = () => {
    pageUsed = true;
  };
  document.addEventListener('pointerdown', used, { capture: true, once: true });
  document.addEventListener('keydown', used, { capture: true, once: true });
}

/** Tests: the page as just loaded (false) or already used (true). */
export function setPageUsedForTests(used: boolean): void {
  pageUsed = used;
}

/**
 * Whether this page may claim the PTY's size from another one (see claimSize). Not where tmux
 * owns the size: a tmux client's follows its sizing mode, so only one set to fit this screen
 * (`here`), and not while it only watches. A Mac-window session's (`ut`, fwd_) yes: the window
 * takes it back when it is typed into (ut-fwd) and gets it back a minute after the owning page
 * left (resetTerminalSize) or a while after it was hidden (a phone locked: the server's
 * sweepSizeOwners); the server keeps one owner (server/pty/size-owner.ts).
 */
export function takesBackPtySize(
  session: Pick<Session, 'id' | 'multiplexer'> | null | undefined
): boolean {
  if (!session) return false;
  if (isForwardedSession(session)) return true;
  const tmux = session.multiplexer?.type === 'tmux' ? session.multiplexer : null;
  if (tmux) return tmux.sizing === 'here' && tmux.mode !== 'watch';
  return true;
}

export interface TerminalEventHandlers {
  handleSessionExit: (e: Event) => void;
  handleTerminalResize: (e: Event) => void;
  handleTerminalPaste: (e: Event) => void;
}

export interface TerminalStateCallbacks {
  updateTerminalDimensions: (cols: number, rows: number) => void;
}

export class TerminalLifecycleManager {
  private session: Session | null = null;
  private terminal: Terminal | null = null;
  private connectionManager: ConnectionManager | null = null;
  private inputManager: InputManager | null = null;
  private connected = false;
  private terminalFontSize = 14;
  private terminalMaxCols = 0;
  private terminalTheme: TerminalThemeId = 'auto';
  private resizeTimeout: number | null = null;
  /** The pending PTY resize, run again later by keyboardStillMoving. */
  private pendingResize: (() => Promise<void>) | null = null;
  private pendingResizeDelay = 0;
  private lastResizeWidth = 0;
  private lastResizeHeight = 0;
  private localSizeDiverged = false;
  private ptySize: { cols: number; rows: number } | null = null;
  /** When this view's session was opened (see ENTRY_SETTLE_MS); 0 before. */
  private enteredAt = 0;
  /**
   * This page last claimed the size the PTY has now: a claim on the next tap is not needed
   * until another client gives the PTY another size.
   */
  private ownsPtySize = false;
  private claimTimer: ReturnType<typeof setTimeout> | null = null;
  private domElement: Element | null = null;
  private eventHandlers: TerminalEventHandlers | null = null;
  private stateCallbacks: TerminalStateCallbacks | null = null;

  setSession(session: Session | null) {
    // Opened (the terminal's first sizes can come before initializeTerminal): see ENTRY_SETTLE_MS.
    if (session && session.id !== this.session?.id) this.enteredAt = Date.now();
    this.session = session;
    // On screen again before its size was given back: it keeps this screen's size.
    if (session) cancelSizeGiveBack(session.id);
  }

  setTerminal(terminal: Terminal | null) {
    this.terminal = terminal;
  }

  setConnectionManager(connectionManager: ConnectionManager | null) {
    this.connectionManager = connectionManager;
  }

  setInputManager(inputManager: InputManager | null) {
    this.inputManager = inputManager;
  }

  setConnected(connected: boolean) {
    this.connected = connected;
  }

  setTerminalFontSize(fontSize: number) {
    this.terminalFontSize = fontSize;
  }

  setTerminalMaxCols(maxCols: number) {
    this.terminalMaxCols = maxCols;
  }

  setTerminalTheme(theme: TerminalThemeId) {
    this.terminalTheme = theme;
  }

  getTerminal(): Terminal | null {
    return this.terminal;
  }

  setDomElement(element: Element | null) {
    this.domElement = element;
  }

  setEventHandlers(handlers: TerminalEventHandlers | null) {
    this.eventHandlers = handlers;
  }

  setStateCallbacks(callbacks: TerminalStateCallbacks | null) {
    this.stateCallbacks = callbacks;
  }

  async initializeTerminal() {
    if (!this.domElement) {
      logger.warn('Cannot initialize terminal - missing DOM element');
      return;
    }

    // First try to find terminal inside terminal-renderer, then fallback to direct query
    const terminalElement = (this.domElement.querySelector('terminal-renderer ut-terminal') ||
      this.domElement.querySelector('ut-terminal')) as Terminal;

    logger.debug('Terminal search results:', {
      hasTerminalRenderer: !!this.domElement.querySelector('terminal-renderer'),
      hasDirectTerminal: !!this.domElement.querySelector('ut-terminal'),
      hasNestedTerminal: !!this.domElement.querySelector('terminal-renderer ut-terminal'),
      foundElement: !!terminalElement,
      sessionId: this.session?.id,
    });

    if (!terminalElement || !this.session) {
      logger.warn(`Cannot initialize terminal - missing element or session`);
      return;
    }

    this.terminal = terminalElement;
    if (!this.enteredAt) this.enteredAt = Date.now();
    // Opened from inside the app (a tap, a key, a swipe): a deliberate use, the size is
    // claimed once the stream says the PTY's (see claimSize). Shown again by a reload, no.
    if (pageUsed) this.claimSize();

    // Update connection manager with terminal reference
    if (this.connectionManager) {
      this.connectionManager.setTerminal(this.terminal);
      this.connectionManager.setSession(this.session);
    }

    // Configure terminal for interactive session
    this.terminal.cols = 80;
    this.terminal.rows = 24;
    this.terminal.fontSize = this.terminalFontSize; // Apply saved font size preference
    this.terminal.fitHorizontally = false; // Allow natural terminal sizing
    this.terminal.maxCols = this.terminalMaxCols; // Apply saved max width preference
    this.terminal.theme = this.terminalTheme;

    if (this.eventHandlers) {
      // Listen for session exit events
      this.terminal.addEventListener(
        'session-exit',
        this.eventHandlers.handleSessionExit as EventListener
      );

      // Listen for terminal resize events to capture dimensions
      this.terminal.addEventListener(
        'terminal-resize',
        this.eventHandlers.handleTerminalResize as unknown as EventListener
      );

      // Listen for paste events from terminal
      this.terminal.addEventListener(
        'terminal-paste',
        this.eventHandlers.handleTerminalPaste as EventListener
      );
    }

    // Connect to stream directly without artificial delays
    // Use setTimeout to ensure we're still connected after all synchronous updates
    setTimeout(() => {
      if (this.connected && this.connectionManager) {
        logger.debug('Connecting to stream for terminal', {
          terminalElement: !!this.terminal,
          sessionId: this.session?.id,
          connected: this.connected,
        });
        this.connectionManager.connectToStream();
      } else {
        logger.warn(`Component disconnected before stream connection`);
      }
    }, 0);
  }

  async handleTerminalResize(event: Event) {
    const customEvent = event as CustomEvent;
    // Update terminal dimensions for display
    const { cols, rows, isMobile, isHeightOnlyChange, source } = customEvent.detail;

    // Debug logging for terminal resize events
    logger.debug('Terminal resize event:', {
      cols,
      rows,
      source,
      sessionId: this.session?.id,
    });

    // Notify the session view to update its state
    if (this.stateCallbacks) {
      this.stateCallbacks.updateTerminalDimensions(cols, rows);
    }

    // Height-only changes on mobile come from the soft keyboard opening/closing. They must
    // reach the PTY: if the client shows fewer rows than the PTY has, full-screen TUIs such
    // as Claude Code draw below the visible area and the overflow piles up on the last row.
    // Each new size restarts the wait, so a keyboard animation makes a single resize.
    const debounceMs = Math.max(
      isMobile && isHeightOnlyChange ? KEYBOARD_RESIZE_DEBOUNCE_MS : RESIZE_DEBOUNCE_MS,
      this.entrySettleLeft()
    );
    logger.debug(`scheduling resize ${cols}x${rows} in ${debounceMs}ms (source: ${source})`);

    // The local terminal may shrink and grow back within the debounce window (keyboard shown
    // and hidden quickly). The PTY never changed size, so the app never redraws, yet the local
    // shrink already pushed rows into scrollback and left the screen mangled.
    if (cols !== this.lastResizeWidth || rows !== this.lastResizeHeight) {
      this.localSizeDiverged = true;
    }

    this.schedulePtyResize(debounceMs, async () => {
      if (!this.session || this.session.status === 'exited') return;

      if (cols === this.lastResizeWidth && rows === this.lastResizeHeight) {
        // 2026-10-12: unless the PTY has another size meanwhile (a Mac window took it back):
        // this screen's own change of size gives the PTY its size again, as the first time.
        const pty = this.ptySize;
        const ptyElsewhere = pty !== null && (pty.cols !== cols || pty.rows !== rows);
        if (!this.localSizeDiverged && !ptyElsewhere) {
          logger.debug(`skipping redundant resize request: ${cols}x${rows}`);
          return;
        }
        // Same final size: a same-size TIOCSWINSZ raises no SIGWINCH, so nudge the height
        // to make the app repaint for the size the client shows.
        if (!ptyElsewhere) {
          logger.debug(`local size diverged and came back to ${cols}x${rows}; forcing a redraw`);
          if (rows > 1 && !(await this.sendResize(cols, rows - 1))) return;
        }
      }

      if (await this.sendResize(cols, rows)) {
        this.localSizeDiverged = false;
      }
    });
  }

  /** What is left of the wait after opening before this view's first resize (ENTRY_SETTLE_MS). */
  private entrySettleLeft(): number {
    if (!this.enteredAt || this.lastResizeWidth > 0) return 0;
    return Math.max(0, this.enteredAt + ENTRY_SETTLE_MS - Date.now());
  }

  /** Runs `send` after `delay` ms, in place of a resize still waiting. */
  private schedulePtyResize(delay: number, send: () => Promise<void>) {
    if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
    this.pendingResize = send;
    this.pendingResizeDelay = delay;
    this.resizeTimeout = window.setTimeout(() => {
      this.resizeTimeout = null;
      this.pendingResize = null;
      window.visualViewport?.removeEventListener('resize', this.keyboardStillMoving);
      void send();
    }, delay) as unknown as number;
    window.visualViewport?.addEventListener('resize', this.keyboardStillMoving);
  }

  /**
   * The visual viewport changed again while a resize waits (the keyboard still animating, at
   * the same row count): the wait starts over, so the app redraws once, for where it lands.
   */
  private keyboardStillMoving = () => {
    if (!this.resizeTimeout || !this.pendingResize) {
      window.visualViewport?.removeEventListener('resize', this.keyboardStillMoving);
      return;
    }
    this.schedulePtyResize(this.pendingResizeDelay, this.pendingResize);
  };

  /**
   * The PTY's size as the stream reports it. A size this page did not send means another
   * client (or the Mac window) has the size now: the next use of this page claims it again.
   */
  handlePtySize(size: { cols: number; rows: number }) {
    const prev = this.ptySize;
    this.ptySize = size;
    const changed = prev !== null && (prev.cols !== size.cols || prev.rows !== size.rows);
    const ours = size.cols === this.lastResizeWidth && size.rows === this.lastResizeHeight;
    if (changed && !ours) this.ownsPtySize = false;
  }

  /**
   * The user used this page on the session: a key, typed or pasted text, a tap (session-view).
   * The PTY gets this screen's size if another client had it (see claimSize).
   */
  noteUserActivity() {
    this.claimSize();
  }

  /**
   * Claims the PTY's size for this page, a moment later (CLAIM_DEBOUNCE_MS, and not before
   * ENTRY_SETTLE_MS after opening): a resize marked as a claim, which makes this page the owner
   * of the size (server/pty/size-owner.ts). Nothing when it already owns the size the PTY has,
   * where tmux owns it (takesBackPtySize), or while the page is hidden. Only deliberate use
   * claims: showing the page again, focus, a rotation or a reconnect never do (user report
   * 2026-10-14: a Mac-window session changed width under a phone that was only being used).
   */
  claimSize() {
    if (this.claimTimer) clearTimeout(this.claimTimer);
    const delay = Math.max(CLAIM_DEBOUNCE_MS, this.entrySettleLeft());
    this.claimTimer = setTimeout(() => {
      this.claimTimer = null;
      void this.sendClaim();
    }, delay);
  }

  /**
   * This client's own size: its terminal's fit, which a PTY of another size does not change
   * (terminal.ts followPtySize), else the size it last sent. Null while the terminal has no
   * area (hidden, as under the desktop's chat view): nothing to claim the PTY for.
   */
  private ownSize(): { cols: number; rows: number } | null {
    const terminal = this.terminal;
    if (terminal && typeof terminal.getOwnSize === 'function') return terminal.getOwnSize();
    const cols = this.lastResizeWidth;
    const rows = this.lastResizeHeight;
    return cols > 0 && rows > 0 ? { cols, rows } : null;
  }

  private async sendClaim() {
    const session = this.session;
    if (!session || session.status === 'exited' || !takesBackPtySize(session)) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // A resize on its way, or the first one after opening: the claim waits for it.
    if (this.resizeTimeout || this.entrySettleLeft() > 0) {
      this.claimSize();
      return;
    }
    const own = this.ownSize();
    if (!own) return;
    const pty = this.ptySize;
    if (this.ownsPtySize && pty && pty.cols === own.cols && pty.rows === own.rows) return;
    logger.log(
      `claiming the size of ${session.id}: ${own.cols}x${own.rows} (PTY ${pty ? `${pty.cols}x${pty.rows}` : 'unknown'})`
    );
    if (await this.sendResize(own.cols, own.rows, true)) this.ownsPtySize = true;
  }

  /**
   * This page's size for the PTY; the server applies it only if this page owns the session's
   * size, or `claim`s it (server/pty/size-owner.ts).
   */
  private async sendResize(cols: number, rows: number, claim = false): Promise<boolean> {
    if (!this.session) return false;
    const sessionId = this.session.id;
    try {
      logger.debug(
        `sending resize request: ${cols}x${rows}${claim ? ' (claim)' : ''} (was ${this.lastResizeWidth}x${this.lastResizeHeight})`
      );
      const sent = terminalSocketClient.resize(sessionId, cols, rows, claim);
      if (!sent) {
        const response = await fetch(`/api/sessions/${sessionId}/resize`, {
          method: HttpMethod.POST,
          headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
          body: JSON.stringify({ cols, rows, claim, clientId: getClientId() }),
        });
        if (!response.ok) {
          logger.warn(`failed to resize session: ${response.status}`);
          return false;
        }
      }
      this.lastResizeWidth = cols;
      this.lastResizeHeight = rows;
      return true;
    } catch (error) {
      logger.warn('failed to send resize request', error);
      return false;
    }
  }

  handleTerminalPaste(e: Event) {
    const customEvent = e as CustomEvent;
    const text = customEvent.detail?.text;
    if (text && this.session && this.inputManager) {
      this.inputManager.sendPastedText(text);
    }
  }

  /**
   * This view is left: a Mac-window session's size goes back to its window a minute later
   * (FORWARDED_SIZE_GIVE_BACK_DELAY_MS) unless the session is opened again meanwhile; the
   * server gives it back only if this page still owns it and no other page shows the session
   * (size-give-back.ts, server/pty/size-owner.ts). Other sessions have no window to give it to.
   */
  resetTerminalSize() {
    const session = this.session;
    if (!session) {
      logger.warn('resetTerminalSize called but no session available');
      return;
    }
    if (!isForwardedSession(session)) return;
    const id = session.id;
    scheduleSizeGiveBack(id, () => void sendSizeGiveBack(id), FORWARDED_SIZE_GIVE_BACK_DELAY_MS);
  }

  cleanup() {
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
      this.resizeTimeout = null;
    }
    this.pendingResize = null;
    window.visualViewport?.removeEventListener('resize', this.keyboardStillMoving);
    if (this.claimTimer) {
      clearTimeout(this.claimTimer);
      this.claimTimer = null;
    }
    this.ptySize = null;
    this.ownsPtySize = false;

    if (this.terminal && this.eventHandlers) {
      this.terminal.removeEventListener(
        'session-exit',
        this.eventHandlers.handleSessionExit as EventListener
      );
      this.terminal.removeEventListener(
        'terminal-resize',
        this.eventHandlers.handleTerminalResize as EventListener
      );
      this.terminal.removeEventListener(
        'terminal-paste',
        this.eventHandlers.handleTerminalPaste as EventListener
      );
    }

    this.terminal = null;
    this.connectionManager?.setTerminal(null);
    this.lastResizeWidth = 0;
    this.lastResizeHeight = 0;
  }
}

/**
 * Asks the server to give `sessionId`'s PTY its terminal's size back: it does only if this page
 * still owns the size and no other page shows the session.
 */
async function sendSizeGiveBack(sessionId: string) {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/reset-size`, {
      method: HttpMethod.POST,
      headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
      body: JSON.stringify({ clientId: getClientId() }),
    });
    if (!response.ok) {
      logger.error('failed to reset terminal size', { status: response.status, sessionId });
      return;
    }
    const result = (await response.json().catch(() => null)) as {
      reset?: boolean;
      reason?: string;
    } | null;
    if (result?.reset === false) logger.debug(`size of ${sessionId} kept: ${result.reason}`);
    else logger.log('terminal size reset successfully for session', sessionId);
  } catch (error) {
    logger.error('error resetting terminal size', { error, sessionId });
  }
}

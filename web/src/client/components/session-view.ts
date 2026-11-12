/**
 * Session View Component
 *
 * Full-screen terminal view for an active session. Handles terminal I/O,
 * streaming updates via WebSocket v3, file browser integration, and mobile overlays.
 *
 * @fires navigate-to-list - When navigating back to session list
 * @fires error - When an error occurs (detail: string)
 * @fires warning - When a warning occurs (detail: string)
 *
 * @listens session-exit - From v3 `EVENT` frames when session exits
 * @listens terminal-ready - From terminal component when ready
 * @listens file-selected - From file browser when file is selected
 * @listens browser-cancel - From file browser when cancelled
 */
import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { ScreenLayout } from '../../shared/claude-screen.js';
import type { MacModeRequest } from '../../shared/mac-sessions.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import './clickable-path.js';
import './session-view/session-header.js';
import './worktree-manager.js';
import { sessionTool } from './phone-session-row.js';
import './terminal-chat-view.js';
import { authClient } from '../services/auth-client.js';
import { GitService } from '../services/git-service.js';
import { terminalSocketClient } from '../services/terminal-socket-client.js';
import { toast } from '../utils/action-toast.js';
import { agentKind } from '../utils/agent-mission.js';
import { resumableAgent, resumeSession } from '../utils/claude-resume.js';
import { Z_INDEX } from '../utils/constants.js';
import { inputDiagnostics } from '../utils/input-diagnostics.js';
import { createLogger } from '../utils/logger.js';
import { attachedTmux, changeAttachMode } from '../utils/mac-attach-mode.js';
import { TERMINAL_IDS } from '../utils/terminal-constants.js';
import type { TerminalThemeId } from '../utils/terminal-themes.js';
// Manager imports
import { ConnectionManager } from './session-view/connection-manager.js';
import {
  type DirectKeyboardCallbacks,
  DirectKeyboardManager,
} from './session-view/direct-keyboard-manager.js';
// New managers
import { FileOperationsManager } from './session-view/file-operations-manager.js';
import { InputManager } from './session-view/input-manager.js';
import type { LifecycleEventManagerCallbacks } from './session-view/interfaces.js';
import { LifecycleEventManager } from './session-view/lifecycle-event-manager.js';
import { LoadingAnimationManager } from './session-view/loading-animation-manager.js';
import { SessionActionsHandler } from './session-view/session-actions-handler.js';
import {
  type TerminalEventHandlers,
  TerminalLifecycleManager,
  type TerminalStateCallbacks,
} from './session-view/terminal-lifecycle-manager.js';
import { TerminalSettingsManager } from './session-view/terminal-settings-manager.js';
import { UIStateManager } from './session-view/ui-state-manager.js';

// Components
import './session-view/terminal-renderer.js';
import './session-view/overlays-container.js';
import './session-view/session-exited-badge.js';
import './mobile-action-bar.js';
import './quick-actions-bar.js';
import './away-summary-card.js';
import './claude-chat-view.js';
import { ShortLandscapeController } from '../utils/short-landscape.js';
import { isShortPane } from '../utils/short-pane.js';
import type { ClaudeChatView, SentChatMessage, SentChatMessageRef } from './claude-chat-view.js';
import { closeChangesSheet, openChangesSheet } from './session-view/changes-sheet.js';
import { COPY_MODE_LINES, closeCopyMode, openCopyMode } from './session-view/copy-mode-sheet.js';
import { closeShareSheet, openShareSheet } from './session-view/share-sheet.js';
import type { Terminal } from './terminal.js';
import type { TerminalChatView } from './terminal-chat-view.js';

// Extend Window interface to include our custom property
declare global {
  interface Window {
    __deviceType?: 'phone' | 'tablet' | 'desktop';
  }
}

const logger = createLogger('session-view');

/** Below this the viewport change is browser chrome (toolbars collapsing), not a keyboard. */
const SOFT_KEYBOARD_MIN_HEIGHT = 50;
/** Between a quick action's text and its Enter (see handleQuickAction). */
const QUICK_ACTION_ENTER_DELAY_MS = 300;

/** Agents whose conversation the chat view reads (sessionTool's names). */
const AGENT_TOOLS = new Set(['claude', 'codex', 'gemini']);

/** Keys that only modify another one. */
function isModifierKey(key: string): boolean {
  return (
    key === 'Shift' ||
    key === 'Control' ||
    key === 'Alt' ||
    key === 'Meta' ||
    key === 'CapsLock' ||
    key === 'Fn' ||
    key === 'AltGraph'
  );
}

/** Most a tap moves (CSS px) and lasts (ms): more is a scroll, a drag or a pinch. */
const TAP_MAX_MOVE_PX = 10;
const TAP_MAX_MS = 500;

/** Whether a pointer that went down at `start` and came up with `end` was a tap. */
export function isTap(
  start: { x: number; y: number; at: number; id: number } | null,
  end: { clientX: number; clientY: number; pointerId: number },
  now = Date.now()
): boolean {
  if (!start || start.id !== end.pointerId) return false;
  if (now - start.at > TAP_MAX_MS) return false;
  return Math.hypot(end.clientX - start.x, end.clientY - start.y) <= TAP_MAX_MOVE_PX;
}

@customElement('session-view')
export class SessionView extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Object }) session: Session | null = null;
  /** All sessions (for the header's live Claude status and session switcher). */
  @property({ type: Array }) sessions: Session[] = [];
  /** The server's platform (GET /api/mac-sessions): 'darwin' names the Mac in the header. */
  @property({ type: String }) serverPlatform = '';
  @property({ type: Boolean }) showBackButton = true;
  @property({ type: Boolean }) showSidebarToggle = false;
  @property({ type: Boolean }) sidebarCollapsed = false;
  @property({ type: Boolean }) disableFocusManagement = false;
  @property({ type: Boolean }) keyboardCaptureActive = true;
  /** The app lost the server: its "Reconnecting…" pill is drawn here, under the header. */
  @property({ type: Boolean }) reconnecting = false;

  // Managers
  private connectionManager!: ConnectionManager;
  private inputManager!: InputManager;
  private directKeyboardManager!: DirectKeyboardManager;
  private terminalLifecycleManager!: TerminalLifecycleManager;
  private lifecycleEventManager!: LifecycleEventManager;
  private loadingAnimationManager = new LoadingAnimationManager();
  private fileOperationsManager = new FileOperationsManager();
  private terminalSettingsManager = new TerminalSettingsManager();
  private sessionActionsHandler = new SessionActionsHandler();
  private uiStateManager = new UIStateManager();

  private gitService = new GitService(authClient);
  private boundHandleOrientationChange?: () => void;

  // Bound terminal event handlers
  private boundHandleTerminalClick = this.handleTerminalClick.bind(this);
  private boundHandleTerminalInput = this.handleTerminalInput.bind(this);
  private boundHandleTerminalResize = this.handleTerminalResize.bind(this);
  private boundHandleTerminalReady = this.handleTerminalReady.bind(this);

  private _updateTerminalTransformTimeout: ReturnType<typeof setTimeout> | null = null;
  private mobileHardwareFocusTimeout: ReturnType<typeof setTimeout> | null = null;
  private terminalInitializationTimeout: ReturnType<typeof setTimeout> | null = null;
  private terminalInitializationFrame: number | null = null;
  // Measured height of the quick-keys bar; fed into --quickkeys-height so the terminal
  // reserves space for it instead of letting it cover the bottom rows.
  private quickKeysHeight = 0;
  private terminalOutputListeners: Set<(data: string) => void> = new Set();

  private createLifecycleEventManagerCallbacks(): LifecycleEventManagerCallbacks {
    return {
      requestUpdate: () => this.requestUpdate(),
      handleBack: () => this.handleBack(),
      switchSession: (direction: 'next' | 'prev') =>
        this.dispatchEvent(
          new CustomEvent('switch-session', {
            detail: { direction },
            bubbles: true,
            composed: true,
          })
        ),
      handleKeyboardInput: (e: KeyboardEvent) => this.handleKeyboardInput(e),
      getIsMobile: () => this.uiStateManager.getState().isMobile,
      getChatMode: () => this.uiStateManager.getState().chatMode,
      getChatCoversTerminal: () =>
        this.uiStateManager.getState().isMobile
          ? this.uiStateManager.getState().chatMode &&
            this.querySelector('claude-chat-view:not([unavailable])') !== null
          : this.desktopAgentChat(),
      typeIntoComposer: (text: string) =>
        (
          this.querySelector('terminal-chat-view[composeronly]') as {
            typeFromKeyboard?: (text: string) => boolean;
          } | null
        )?.typeFromKeyboard?.(text) ?? false,
      setIsMobile: (value: boolean) => {
        this.uiStateManager.setIsMobile(value);
      },
      getDirectKeyboardManager: () => ({
        getShowQuickKeys: () => this.directKeyboardManager.getShowQuickKeys(),
        setShowQuickKeys: (value: boolean) => this.directKeyboardManager.setShowQuickKeys(value),
        ensureHiddenInputVisible: () => this.directKeyboardManager.ensureHiddenInputVisible(),
        cleanup: () => this.directKeyboardManager.cleanup(),
        exitKeyboardMode: () => this.directKeyboardManager.exitKeyboardMode(),
        getKeyboardMode: () => this.directKeyboardManager.getKeyboardMode(),
        isRecentlyEnteredKeyboardMode: () =>
          this.directKeyboardManager.isRecentlyEnteredKeyboardMode(),
      }),
      setShowQuickKeys: (value: boolean) => {
        this.uiStateManager.setShowQuickKeys(value);
        this.updateTerminalTransform();
      },
      setShowFileBrowser: (value: boolean) => {
        this.uiStateManager.setShowFileBrowser(value);
      },
      getInputManager: () => this.inputManager,
      getShowWidthSelector: () => this.uiStateManager.getState().showWidthSelector,
      setShowWidthSelector: (value: boolean) => {
        this.uiStateManager.setShowWidthSelector(value);
      },
      setCustomWidth: (value: string) => {
        this.uiStateManager.setCustomWidth(value);
      },
      querySelector: (selector: string) => this.querySelector(selector),
      setTabIndex: (value: number) => {
        this.tabIndex = value;
      },
      addEventListener: (event: string, handler: EventListener) =>
        this.addEventListener(event, handler),
      removeEventListener: (event: string, handler: EventListener) =>
        this.removeEventListener(event, handler),
      focus: () => this.focus(),
      // 2026-11-11: the file browser over the session counts too. Keys typed with it open
      // (Escape to close it, letters outside a field) were taken first by the terminal's
      // handler and sent to the agent behind it.
      getDisableFocusManagement: () =>
        this.disableFocusManagement || this.uiStateManager.getState().showFileBrowser,
      startLoading: () => this.loadingAnimationManager.startLoading(() => this.requestUpdate()),
      stopLoading: () => this.loadingAnimationManager.stopLoading(),
      setKeyboardHeight: (value: number) => {
        this.uiStateManager.setKeyboardHeight(value);
        this.updateTerminalTransform();
      },
      getTerminalLifecycleManager: () =>
        this.terminalLifecycleManager
          ? {
              resetTerminalSize: () => this.terminalLifecycleManager.resetTerminalSize(),
              cleanup: () => this.terminalLifecycleManager.cleanup(),
            }
          : null,
      getConnectionManager: () =>
        this.connectionManager
          ? {
              setConnected: (connected: boolean) => this.connectionManager.setConnected(connected),
              cleanupStreamConnection: () => this.connectionManager.cleanupStreamConnection(),
            }
          : null,
      setConnected: (connected: boolean) => {
        this.uiStateManager.setConnected(connected);
      },
      getKeyboardCaptureActive: () => this.uiStateManager.getState().keyboardCaptureActive,
    };
  }

  /**
   * The session's pane is short (see isShortPane). The chat then drops its secondary rows
   * (title bar, permission mode, prompt chips) so the conversation still shows; on an iPhone
   * SE they used to fill the whole pane, under a split preview or above the keyboard
   * (2026-10-03).
   */
  @state() private shortPane = false;
  /**
   * A phone on its side (utils/short-landscape.ts): the chat is a centred column and its
   * chrome is reachable without taking rows (claude-chat-view, terminal-chat-view `landscape`).
   */
  private readonly shortLandscape = new ShortLandscapeController(this);
  /** The chat view shows a question with its options; the composer then shows none. */
  @state() private chatAsking = false;
  /** The PTY's width as the stream last said (another client may have changed it). */
  @state() private ptyCols?: number;
  /** The chat view shows this session's conversation, over the terminal. */
  @state() private chatCovers = false;
  /** What the chat view last said about a session: whether it has an agent conversation. */
  @state() private chatAvailability: { sessionId: string; available: boolean } | null = null;
  /** A change of how an opened tmux session is attached, shown while tmux makes it. */
  @state() private attachPending: MacModeRequest | null = null;

  /**
   * Watching a tmux session opened from "On this Mac": tmux drops what this client types, so
   * nothing here offers to type (composer, action bar, quick keys, keyboard, chat answers).
   */
  private get watching(): boolean {
    const tmux = attachedTmux(this.session);
    return tmux !== null && (this.attachPending?.mode ?? tmux.mode) === 'watch';
  }

  /** Take control, watch only, or fit: shown at once, put back with a toast if tmux refuses. */
  private handleAttachChange = async (change: MacModeRequest) => {
    const session = this.session;
    const tmux = attachedTmux(session);
    if (!session || !tmux || this.attachPending) return;
    this.attachPending = change;
    try {
      const result = await changeAttachMode(session.id, change, authClient.getAuthHeader());
      // What tmux reports now, until the next poll brings the same from the server.
      session.multiplexer = { ...tmux, ...result };
    } catch (error) {
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: error instanceof Error ? error.message : String(error),
          bubbles: true,
          composed: true,
        })
      );
    } finally {
      this.attachPending = null;
    }
  };

  private updateShortPane = () => {
    const offset =
      Number.parseFloat(getComputedStyle(document.body).getPropertyValue('--ut-preview-offset')) ||
      0;
    const visible = window.visualViewport?.height ?? window.innerHeight;
    const short = isShortPane(visible, offset);
    if (short !== this.shortPane) this.shortPane = short;
  };

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('font-size-change', this.handlePinchFontSize as EventListener);
    // Deliberate use claims the session's size: a key or a tap (see handleUserActivity). The
    // page shown again, focus or a rotation do not (server/pty/size-owner.ts).
    this.addEventListener('pointerdown', this.handleTapStart, true);
    this.addEventListener('pointerup', this.handleTapEnd, true);
    this.addEventListener('keydown', this.handleKeyActivity, true);
    // The split preview announces size changes with a window resize.
    window.addEventListener('resize', this.updateShortPane);
    window.visualViewport?.addEventListener('resize', this.updateShortPane);
    this.updateShortPane();

    // Initialize UIStateManager callbacks
    this.uiStateManager.setCallbacks({
      requestUpdate: () => this.requestUpdate(),
    });
    this.uiStateManager.loadChatModePreference();

    // Initialize FileOperationsManager callbacks
    this.fileOperationsManager.setCallbacks({
      requestUpdate: () => this.requestUpdate(),
      getSession: () => this.session,
      getInputManager: () => this.inputManager,
      querySelector: (selector: string) => this.querySelector(selector),
      setIsDragOver: (isDragOver: boolean) => this.uiStateManager.setIsDragOver(isDragOver),
      setShowFileBrowser: (value: boolean) => this.uiStateManager.setShowFileBrowser(value),
      setShowImagePicker: (value: boolean) => this.uiStateManager.setShowImagePicker(value),
      getIsMobile: () => this.uiStateManager.getState().isMobile,
      getShowFileBrowser: () => this.uiStateManager.getState().showFileBrowser,
      getShowImagePicker: () => this.uiStateManager.getState().showImagePicker,
      dispatchEvent: (event: Event) => this.dispatchEvent(event),
      insertIntoComposer: (text: string) => {
        const state = this.uiStateManager.getState();
        if (!state.chatMode || !(state.isMobile || this.desktopAgentChat())) return false;
        const composer = this.querySelector('terminal-chat-view[composeronly]') as
          | (HTMLElement & { insertText?: (text: string) => void })
          | null;
        if (!composer?.insertText) return false;
        composer.insertText(text);
        return true;
      },
      attachToComposer: (files: File[]) => {
        const state = this.uiStateManager.getState();
        if (!state.chatMode || !(state.isMobile || this.desktopAgentChat())) return false;
        const composer = this.querySelector('terminal-chat-view[composeronly]') as
          | (HTMLElement & { addAttachments?: (files: File[]) => void })
          | null;
        if (!composer?.addAttachments) return false;
        composer.addAttachments(files);
        return true;
      },
    });

    // Initialize TerminalSettingsManager
    this.terminalSettingsManager.setCallbacks({
      requestUpdate: () => this.requestUpdate(),
      getSession: () => this.session,
      getTerminalElement: () => this.getTerminalElement(),
      setTerminalMaxCols: (cols: number) => this.uiStateManager.setTerminalMaxCols(cols),
      setTerminalFontSize: (size: number) => this.uiStateManager.setTerminalFontSize(size),
      setTerminalTheme: (theme: TerminalThemeId) => this.uiStateManager.setTerminalTheme(theme),
      setShowWidthSelector: (show: boolean) => this.uiStateManager.setShowWidthSelector(show),
      setCustomWidth: (width: string) => this.uiStateManager.setCustomWidth(width),
      getTerminalLifecycleManager: () => this.terminalLifecycleManager,
    });

    // Initialize SessionActionsHandler
    this.sessionActionsHandler.setCallbacks({
      getSession: () => this.session,
      setSession: (session: Session) => {
        this.session = session;
      },
      requestUpdate: () => this.requestUpdate(),
      dispatchEvent: (event: Event) => this.dispatchEvent(event),
      getViewMode: () => this.uiStateManager.getState().viewMode,
      setViewMode: (mode: 'terminal' | 'worktree') => this.uiStateManager.setViewMode(mode),
      handleBack: () => this.handleBack(),
      ensureTerminalInitialized: () => this.ensureTerminalInitialized(),
    });

    // Check initial orientation
    this.checkOrientation();

    // Create bound orientation handler
    this.boundHandleOrientationChange = () => this.handleOrientationChange();

    // Listen for orientation changes
    window.addEventListener('orientationchange', this.boundHandleOrientationChange);
    window.addEventListener('resize', this.boundHandleOrientationChange);

    // Initialize connection manager
    this.connectionManager = new ConnectionManager(
      (sessionId: string) => {
        // Handle session exit
        if (this.session && sessionId === this.session.id) {
          this.session = { ...this.session, status: 'exited' };
          this.requestUpdate();

          // Check if this window should auto-close
          // Only attempt to close if we're on a session-specific URL
          const urlParams = new URLSearchParams(window.location.search);
          const sessionParam = urlParams.get('session');

          if (sessionParam === sessionId) {
            // This window was opened specifically for this session
            logger.log(`Session ${sessionId} exited, attempting to close window`);

            // Try to close the window
            // This will work for:
            // 1. Windows opened via window.open() from JavaScript
            // 2. Windows where the user has granted permission
            // It won't work for regular browser tabs, which is fine
            setTimeout(() => {
              try {
                window.close();

                // If window.close() didn't work (we're still here after 100ms),
                // show a message to the user
                setTimeout(() => {
                  logger.log('Window close failed - likely opened as a regular tab');
                }, 100);
              } catch (e) {
                logger.warn('Failed to close window:', e);
              }
            }, 500); // Give user time to see the "exited" status
          }
        }
      },
      (session: Session) => {
        // Handle session update
        this.session = session;
        this.requestUpdate();
      }
    );
    this.connectionManager.setConnected(true);

    // Set up terminal output callback for chat view
    this.connectionManager.setOnTerminalOutput((data: string) => {
      // Forward output to chat view via event or state
      this.handleTerminalOutput(data);
    });

    // Set connected state in UI state manager
    this.uiStateManager.setConnected(true);

    // Initialize input manager
    this.inputManager = new InputManager();
    this.inputManager.setCallbacks({
      requestUpdate: () => this.requestUpdate(),
      getKeyboardCaptureActive: () => this.uiStateManager.getState().keyboardCaptureActive,
      getTerminalElement: () => this.getTerminalElement(),
      inputSent: () => this.handleUserActivity(),
    });

    // Initialize direct keyboard manager
    this.directKeyboardManager = new DirectKeyboardManager();
    this.directKeyboardManager.setInputManager(this.inputManager);
    this.directKeyboardManager.setSessionViewElement(this);

    // Set up callbacks for direct keyboard manager
    const directKeyboardCallbacks: DirectKeyboardCallbacks = {
      getShowCtrlAlpha: () => this.uiStateManager.getState().showCtrlAlpha,
      getDisableFocusManagement: () => this.disableFocusManagement,
      // One writer of the keyboard height: the lifecycle manager (2026-11-11).
      measureKeyboard: () => this.lifecycleEventManager?.measureKeyboard(),
      getKeyboardHeight: () => this.uiStateManager.getState().keyboardHeight,
      updateShowQuickKeys: (value: boolean) => {
        this.uiStateManager.setShowQuickKeys(value);
        this.requestUpdate();
        // Update terminal transform when quick keys visibility changes
        this.updateTerminalTransform();
      },
      toggleCtrlAlpha: () => {
        this.uiStateManager.toggleCtrlAlpha();
        this.requestUpdate();
      },
      clearCtrlSequence: () => {
        this.uiStateManager.clearCtrlSequence();
        this.requestUpdate();
      },
      getChatMode: () => this.uiStateManager.getState().chatMode,
      // 2026-10-12: re-measure once focus settles (another field may be taking over).
      keyboardDismissed: () => this.lifecycleEventManager?.keyboardDismissed(),
    };
    this.directKeyboardManager.setCallbacks(directKeyboardCallbacks);

    // Initialize terminal lifecycle manager
    this.terminalLifecycleManager = new TerminalLifecycleManager();
    this.terminalLifecycleManager.setConnectionManager(this.connectionManager);
    this.terminalLifecycleManager.setInputManager(this.inputManager);
    this.terminalLifecycleManager.setConnected(this.uiStateManager.getState().connected);
    this.terminalLifecycleManager.setDomElement(this);
    this.connectionManager.setOnPtySize((size) => {
      this.terminalLifecycleManager.handlePtySize(size);
      // The chat and the composer read the menu again at once (see ClaudeChatView.ptyCols).
      this.ptyCols = size.cols;
    });

    // Set up event handlers for terminal lifecycle manager
    const eventHandlers: TerminalEventHandlers = {
      handleSessionExit: this.handleSessionExit.bind(this),
      handleTerminalResize: this.terminalLifecycleManager.handleTerminalResize.bind(
        this.terminalLifecycleManager
      ),
      handleTerminalPaste: this.terminalLifecycleManager.handleTerminalPaste.bind(
        this.terminalLifecycleManager
      ),
    };
    this.terminalLifecycleManager.setEventHandlers(eventHandlers);

    // Set up state callbacks for terminal lifecycle manager
    const stateCallbacks: TerminalStateCallbacks = {
      updateTerminalDimensions: (cols: number, rows: number) => {
        this.uiStateManager.setTerminalDimensions(cols, rows);
        this.requestUpdate();
      },
    };
    this.terminalLifecycleManager.setStateCallbacks(stateCallbacks);

    if (this.session) {
      this.inputManager.setSession(this.session);
      this.terminalLifecycleManager.setSession(this.session);
    }

    // Load terminal preferences
    const maxCols = this.terminalSettingsManager.getMaxCols();
    const fontSize = this.terminalSettingsManager.getFontSize();
    const theme = this.terminalSettingsManager.getTheme();
    this.uiStateManager.setTerminalMaxCols(maxCols);
    this.uiStateManager.setTerminalFontSize(fontSize);
    this.uiStateManager.setTerminalTheme(theme);
    logger.debug('Loaded terminal theme:', theme);
    this.terminalLifecycleManager.setTerminalFontSize(fontSize);
    this.terminalLifecycleManager.setTerminalMaxCols(maxCols);
    this.terminalLifecycleManager.setTerminalTheme(theme);

    // Initialize lifecycle event manager
    this.lifecycleEventManager = new LifecycleEventManager();
    this.lifecycleEventManager.setSessionViewElement(this);
    this.lifecycleEventManager.setCallbacks(this.createLifecycleEventManagerCallbacks());
    this.lifecycleEventManager.setSession(this.session);
    // Input diagnostics (off unless turned on): this view's own keyboard numbers.
    inputDiagnostics.setKeyboardProbe(() => ({
      baseline: this.lifecycleEventManager.keyboardBaseline,
      applied: this.uiStateManager.getState().keyboardHeight,
    }));

    // Session action callbacks will be provided per-call to the service

    // Direct keyboard mode is now always enabled (no preference needed)

    // Set up lifecycle (replaces the extracted lifecycle logic)
    this.lifecycleEventManager.setupLifecycle();

    // Use FileOperationsManager's event setup which includes dragend and global dragover
    this.fileOperationsManager.setupEventListeners(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('resize', this.updateShortPane);
    window.visualViewport?.removeEventListener('resize', this.updateShortPane);
    if (this.session) terminalSocketClient.clearViewingSession(this.session.id);
    inputDiagnostics.setKeyboardProbe(null);
    inputDiagnostics.setAgent('none');
    closeCopyMode();
    closeChangesSheet();
    // The share sheet lives in <body>: leaving the session must not leave its links on top.
    closeShareSheet();
    // The page gets its own background back (--ut-terminal-bg follows the session's terminal).
    this.terminalSettingsManager.dispose();
    this.removeEventListener('font-size-change', this.handlePinchFontSize as EventListener);
    this.removeEventListener('pointerdown', this.handleTapStart, true);
    this.removeEventListener('pointerup', this.handleTapEnd, true);
    this.removeEventListener('keydown', this.handleKeyActivity, true);

    // Remove orientation listeners
    if (this.boundHandleOrientationChange) {
      window.removeEventListener('orientationchange', this.boundHandleOrientationChange);
      window.removeEventListener('resize', this.boundHandleOrientationChange);
    }

    // Remove drag & drop and paste event listeners using FileOperationsManager
    this.fileOperationsManager.removeEventListeners(this);

    // Reset drag state
    this.fileOperationsManager.resetDragState();

    // Clear any pending updateTerminalTransform timeout
    if (this._updateTerminalTransformTimeout) {
      clearTimeout(this._updateTerminalTransformTimeout);
      this._updateTerminalTransformTimeout = null;
    }
    if (this.mobileHardwareFocusTimeout) {
      clearTimeout(this.mobileHardwareFocusTimeout);
      this.mobileHardwareFocusTimeout = null;
    }
    if (this.terminalInitializationTimeout) {
      clearTimeout(this.terminalInitializationTimeout);
      this.terminalInitializationTimeout = null;
    }
    if (this.terminalInitializationFrame !== null) {
      cancelAnimationFrame(this.terminalInitializationFrame);
      this.terminalInitializationFrame = null;
    }

    // Use lifecycle event manager for teardown
    if (this.lifecycleEventManager) {
      this.lifecycleEventManager.teardownLifecycle();
      this.lifecycleEventManager.cleanup();
    }

    if (this.inputManager) {
      this.inputManager.cleanup();
    }

    // Clean up loading animation manager
    this.loadingAnimationManager.cleanup();
  }

  private checkOrientation() {
    // Check if we're in landscape mode
    const isLandscape = window.matchMedia('(orientation: landscape)').matches;
    this.uiStateManager.setIsLandscape(isLandscape);
  }

  /**
   * The phone column is overflow: hidden, but focus and scrollIntoView still scroll it: in
   * landscape it sat 34 px down, the header drawn over the terminal's first rows (2026-10-12).
   */
  private scrollWatchedGrid: HTMLElement | null = null;
  private resetGridScroll = () => {
    const grid = this.querySelector<HTMLElement>('.session-view-grid');
    if (grid?.dataset.mobile === 'true' && grid.scrollTop !== 0) grid.scrollTop = 0;
  };

  private handleOrientationChange() {
    this.checkOrientation();
    this.resetGridScroll();
    // Request update to re-render with new safe area classes
    this.requestUpdate();
    this.updateTerminalTransform();
  }

  private getTerminalElement(): Terminal | null {
    // Look for terminal inside terminal-renderer (no shadow DOM, so direct descendant selector works)
    const terminalRenderer = this.querySelector('terminal-renderer');
    if (terminalRenderer) {
      return terminalRenderer.querySelector('ut-terminal') as Terminal | null;
    }

    // Fallback to direct search (shouldn't happen with new structure)
    return this.querySelector('ut-terminal') as Terminal | null;
  }

  firstUpdated(changedProperties: PropertyValues) {
    super.firstUpdated(changedProperties);

    // Load terminal preferences BEFORE terminal setup to ensure proper initialization
    const terminalTheme = this.terminalSettingsManager.getTerminalTheme();
    logger.debug('Loaded terminal theme from preferences:', terminalTheme);

    // Don't setup terminal here - wait for session data to be available
    // Terminal setup will be triggered in updated() when session becomes available
  }

  /**
   * The polled session list (app.ts) carries no git counts; those arrive on the per-session
   * `git-status-update` stream. When app re-renders (e.g. ⌘B toggling the sidebar) it hands
   * us the polled object, which used to wipe the header's diff counts and Cambios dot until
   * the next session switch (2026-10-12). Carry the counts over for the same session.
   */
  willUpdate(changedProperties: Map<string, unknown>) {
    super.willUpdate(changedProperties);
    if (!changedProperties.has('session')) return;
    const previous = changedProperties.get('session') as Session | null | undefined;
    const next = this.session;
    if (!previous || !next || previous.id !== next.id || previous === next) return;
    let merged: Session | null = null;
    for (const key of SessionView.GIT_COUNT_KEYS) {
      if (next[key] === undefined && previous[key] !== undefined) {
        merged ??= { ...next };
        merged[key] = previous[key];
      }
    }
    if (merged) this.session = merged;
  }

  private static readonly GIT_COUNT_KEYS = [
    'gitModifiedCount',
    'gitUntrackedCount',
    'gitStagedCount',
    'gitAddedCount',
    'gitDeletedCount',
    'gitAheadCount',
    'gitBehindCount',
    'gitInsertionCount',
    'gitDeletionCount',
  ] as const satisfies readonly (keyof Session)[];

  updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);
    const grid = this.querySelector<HTMLElement>('.session-view-grid');
    if (grid && grid !== this.scrollWatchedGrid) {
      this.scrollWatchedGrid?.removeEventListener('scroll', this.resetGridScroll);
      grid.addEventListener('scroll', this.resetGridScroll, { passive: true });
      this.scrollWatchedGrid = grid;
    }

    // If session changed, clean up old stream connection and reset terminal state
    if (changedProperties.has('session')) {
      const oldSession = changedProperties.get('session') as Session | null;
      const sessionChanged = oldSession?.id !== this.session?.id;

      if (sessionChanged && oldSession) {
        logger.log('Session changed, cleaning up old stream connection');
        // Its share sheet (in <body>) listed the old session's links.
        closeShareSheet();
        if (this.connectionManager) {
          this.connectionManager.cleanupStreamConnection();
        }
        // Clean up terminal lifecycle manager for fresh start
        if (this.terminalLifecycleManager) {
          this.terminalLifecycleManager.cleanup();
        }
      }

      // Pushes about the session on screen are held back by the server while it is visible.
      if (sessionChanged) {
        if (oldSession) terminalSocketClient.clearViewingSession(oldSession.id);
        if (this.session) terminalSocketClient.setViewingSession(this.session.id);
        this.attachPending = null;
        if (this.session) inputDiagnostics.sessionOpening(this.session.id);
      }
      inputDiagnostics.setAgent(this.session ? (agentKind(this.session) ?? 'shell') : 'none');

      // Update managers with new session. The connection manager too: it builds the
      // session it hands back on each git-status update from its own copy, which was the
      // one from when the terminal opened, so a session killed (or renamed) from another
      // device snapped back to "running" with its old name on the next git change.
      this.connectionManager?.setSession(this.session ?? null);
      if (this.inputManager) {
        this.inputManager.setSession(this.session);
      }
      if (this.terminalLifecycleManager) {
        this.terminalLifecycleManager.setSession(this.session);
      }
      if (this.lifecycleEventManager) {
        this.lifecycleEventManager.setSession(this.session);
      }

      // Initialize terminal when session first becomes available
      if (this.session && this.uiStateManager.getState().connected && !oldSession) {
        logger.log('Session data now available, initializing terminal');
        this.ensureTerminalInitialized();
      }
    }

    // Stop loading and ensure terminal is initialized when session becomes available
    if (
      changedProperties.has('session') &&
      this.session &&
      this.loadingAnimationManager.isLoading()
    ) {
      this.loadingAnimationManager.stopLoading();
      this.ensureTerminalInitialized();
    }

    // Update UIStateManager when keyboardCaptureActive prop changes
    if (changedProperties.has('keyboardCaptureActive')) {
      this.uiStateManager.setKeyboardCaptureActive(this.keyboardCaptureActive);
      logger.log(`Keyboard capture state updated to: ${this.keyboardCaptureActive}`);
    }

    // Watching from now on: a keyboard still up would type into nothing.
    const watching = this.watching;
    if (watching && !this.wasWatching && this.uiStateManager.getState().isMobile) {
      this.directKeyboardManager?.exitKeyboardMode();
    }
    this.wasWatching = watching;

    // The direct keyboard's input lives on document.body, outside the inert terminal.
    this.directKeyboardManager?.setUnreachable(this.terminalUnderChat());
  }

  /**
   * Phone chat mode with Claude's chat view over the terminal: nobody sees the terminal. It
   * keeps its rows (holdRows), is not painted and is inert, so neither its cursor nor any of
   * its inputs can show or take the focus around the composer (2026-10-03). The direct
   * keyboard's input, on document.body, is made unreachable too (2026-10-04).
   */
  private terminalUnderChat(): boolean {
    const uiState = this.uiStateManager.getState();
    return uiState.isMobile && uiState.chatMode && this.chatCovers;
  }

  private wasWatching = false;

  /**
   * Desktop chat mode on a session with an agent conversation (Claude Code, Codex, Gemini):
   * the agent's chat view and its composer, as on a phone, instead of the chat parsed from the
   * terminal's output, which turned Claude Code's redraws into one bubble of spinner frames
   * (2026-10-12). Until the chat view has answered for this session, the session's command
   * decides.
   */
  private desktopAgentChat(): boolean {
    const uiState = this.uiStateManager.getState();
    const session = this.session;
    if (uiState.isMobile || !uiState.chatMode || uiState.viewMode !== 'terminal' || !session) {
      return false;
    }
    if (this.chatAvailability?.sessionId === session.id) return this.chatAvailability.available;
    return Boolean(session.claudeStatus) || AGENT_TOOLS.has(sessionTool(session));
  }

  private handleChatAvailability = (e: CustomEvent<boolean>) => {
    const view = e.target as ClaudeChatView | null;
    if (view?.sessionId) this.chatAvailability = { sessionId: view.sessionId, available: e.detail };
  };

  /** Watching: say so, with the way to type instead (the chat and keys are hidden). */
  private renderWatchBanner() {
    if (!this.watching || this.session?.status !== 'running') return nothing;
    return html`
      <div
        class="flex items-center gap-3 border-b border-border bg-status-warning/10 text-text text-xs ps-3 pe-1"
        role="status"
        data-testid="watch-banner"
      >
        <span class="flex-1 min-w-0"><span aria-hidden="true">👁 </span>${t('macSessions.watch.banner')}</span>
        <button
          class="ut-surface--control flex-shrink-0 min-h-[44px] px-3 font-semibold text-primary"
          data-testid="watch-take-control"
          @click=${() => this.handleAttachChange({ mode: 'control' })}
        >
          ${t('macSessions.watch.takeControl')}
        </button>
      </div>
    `;
  }

  /**
   * Ensures terminal is properly initialized with current session data.
   * This method is idempotent and can be called multiple times safely.
   */
  private ensureTerminalInitialized() {
    if (!this.session || !this.uiStateManager.getState().connected) {
      logger.log('Cannot initialize terminal: missing session or not connected');
      return;
    }

    // Check if terminal is already initialized
    if (this.terminalLifecycleManager.getTerminal()) {
      logger.log('Terminal already initialized');
      return;
    }

    // Check if terminal element exists in DOM
    const terminalElement = this.getTerminalElement();
    if (!terminalElement) {
      logger.log('Terminal element not found in DOM, deferring initialization');
      if (this.terminalInitializationTimeout || this.terminalInitializationFrame !== null) {
        return;
      }
      // Retry after next render cycle with a small delay to ensure terminal-renderer has rendered
      this.terminalInitializationTimeout = setTimeout(() => {
        this.terminalInitializationTimeout = null;
        this.terminalInitializationFrame = requestAnimationFrame(() => {
          this.terminalInitializationFrame = null;
          if (!this.isConnected) {
            return;
          }
          this.ensureTerminalInitialized();
        });
      }, 100);
      return;
    }

    logger.log('Initializing terminal with session:', this.session.id);

    this.terminalLifecycleManager.initializeTerminal();
  }

  async handleKeyboardInput(e: KeyboardEvent) {
    if (!this.inputManager) return;

    await this.inputManager.handleKeyboardInput(e);

    // Check if session status needs updating after input attempt
    // The input manager will have attempted to send input and may have detected session exit
    if (this.session && this.session.status !== 'exited') {
      // InputManager doesn't directly update session status, so we don't need to handle that here
      // This is handled by the connection manager when it detects connection issues
    }
  }

  handleBack() {
    // Dispatch a custom event that the app can handle with view transitions
    this.dispatchEvent(
      new CustomEvent('navigate-to-list', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleSidebarToggle() {
    // The sidebar covers the terminal; the fixed quick keys would otherwise stay on top of it.
    if (this.uiStateManager.getState().isMobile) this.directKeyboardManager.exitKeyboardMode();
    // Dispatch event to toggle sidebar
    this.dispatchEvent(
      new CustomEvent('toggle-sidebar', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleOpenSettings() {
    // Dispatch event to open settings modal
    this.dispatchEvent(
      new CustomEvent('open-settings', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleSessionExit(e: Event) {
    const customEvent = e as CustomEvent;
    this.sessionActionsHandler.handleSessionExit(
      customEvent.detail.sessionId,
      customEvent.detail.exitCode
    );

    // Switch to snapshot mode - disconnect stream and load final snapshot
    if (this.session && customEvent.detail.sessionId === this.session.id) {
      if (this.connectionManager) {
        this.connectionManager.cleanupStreamConnection();
      }
    }
  }

  private async handleCtrlKey(letter: string) {
    // Add to sequence instead of immediately sending
    this.uiStateManager.addCtrlSequence(letter);
  }

  private async handleSendCtrlSequence() {
    // Send each ctrl key in sequence
    const ctrlSequence = this.uiStateManager.getState().ctrlSequence;
    if (this.inputManager) {
      for (const letter of ctrlSequence) {
        const controlCode = String.fromCharCode(letter.charCodeAt(0) - 64);
        await this.inputManager.sendInputText(controlCode);
      }
    }
    // Clear sequence and close overlay
    this.uiStateManager.clearCtrlSequence();
    this.uiStateManager.setShowCtrlAlpha(false);

    // Refocus the hidden input and restart focus retention
    if (this.directKeyboardManager.shouldRefocusHiddenInput()) {
      // Use a small delay to ensure the modal is fully closed first
      setTimeout(() => {
        this.directKeyboardManager.refocusHiddenInput();
        this.directKeyboardManager.startFocusRetentionPublic();
      }, 50);
    }
  }

  private handleClearCtrlSequence() {
    this.uiStateManager.clearCtrlSequence();
  }

  private handleCtrlAlphaCancel() {
    this.uiStateManager.setShowCtrlAlpha(false);
    this.uiStateManager.clearCtrlSequence();

    // Refocus the hidden input and restart focus retention
    if (this.directKeyboardManager.shouldRefocusHiddenInput()) {
      // Use a small delay to ensure the modal is fully closed first
      setTimeout(() => {
        this.directKeyboardManager.refocusHiddenInput();
        this.directKeyboardManager.startFocusRetentionPublic();
      }, 50);
    }
  }

  /** Paste from the terminal's selection menu: the same path as the quick keys' Paste. */
  private handleTerminalPasteRequest = () => {
    void this.directKeyboardManager.handleQuickKeyPress('Paste');
  };

  /** Copy mode: the terminal's text in a native, selectable sheet (the canvas is not). */
  private handleSelectText = () => {
    const terminal = this.terminalLifecycleManager.getTerminal() ?? this.getTerminalElement();
    // Opens where the terminal is scrolled to, not at the end (2026-10-09: scrolled back to
    // copy an older answer, the sheet showed the newest lines).
    const copy = terminal?.getCopyModeText(COPY_MODE_LINES) ?? { text: '', topLine: null };
    openCopyMode(copy.text, copy.topLine);
  };

  /** Changes: the session folder's uncommitted git diff, reviewable on a phone. */
  private handleShowChanges = () => {
    const dir = this.session?.workingDir || this.session?.gitRepoPath;
    if (dir) openChangesSheet(dir, { sessionId: this.session?.id });
  };

  /** Tapping the composer opens the keyboard: show the latest message, like a chat app. */
  private handleComposerFocus = () => {
    (
      this.querySelector('claude-chat-view') as (HTMLElement & { followLatest?: () => void }) | null
    )?.followLatest?.();
  };

  /** The composer's attach menu: the photo library, or any file from this device. */
  private handleComposerAttach = (e: CustomEvent<{ source?: 'media' | 'device' } | null>) => {
    if (e.detail?.source === 'device') this.fileOperationsManager.selectFiles();
    else this.fileOperationsManager.selectImage();
  };

  /**
   * A message the composer sends shows in the chat at once, until the transcript has it; one
   * that could not be sent says so there, and its Retry goes back to the composer, which knows
   * the way it went.
   */
  private handleChatMessageSent = (e: CustomEvent<SentChatMessage>) => {
    (this.querySelector('claude-chat-view') as ClaudeChatView | null)?.addSentMessage(e.detail);
  };

  private handleChatMessageFailed = (e: CustomEvent<SentChatMessageRef>) => {
    (this.querySelector('claude-chat-view') as ClaudeChatView | null)?.markSendFailed(e.detail);
  };

  private handleChatMessageRetry = (e: CustomEvent<SentChatMessageRef>) => {
    (
      this.querySelector('terminal-chat-view[composeronly]') as TerminalChatView | null
    )?.resendMessage(e.detail);
  };

  private handleToggleChatMode() {
    const currentChatMode = this.uiStateManager.getState().chatMode;
    const enteringChatMode = !currentChatMode;

    // If entering chat mode, blur the hidden input to release keyboard capture
    // This allows the chat input to receive focus and keystrokes
    if (enteringChatMode) {
      this.directKeyboardManager.blurHiddenInput();
    }

    // Toggle the chat mode
    this.uiStateManager.toggleChatMode();
  }
  private handleKeyboardButtonClick() {
    // Show quick keys immediately for visual feedback
    this.uiStateManager.setShowQuickKeys(true);

    // Update terminal transform immediately
    this.updateTerminalTransform();

    // Focus the hidden input synchronously - critical for iOS Safari.
    // forceRecreate=true: the user explicitly tapped TAP to (re)open the keyboard, so
    // recreate the input so iOS reliably reopens it even if the soft keyboard was
    // dismissed while the quick keys stayed open (avoids the intermittent race).
    this.directKeyboardManager.focusHiddenInput(true);

    // Request update after all synchronous operations
    this.requestUpdate();
  }

  private handleTerminalClick(e: Event) {
    const uiState = this.uiStateManager.getState();
    if (uiState.isMobile) {
      const isLinkInteraction = e
        .composedPath()
        .some((target) => target instanceof Element && target.matches('a[href]'));
      if (isLinkInteraction) {
        return;
      }

      // Keep touchend observable by the document-level swipe-back handler.
      if (e.type !== 'touchend') {
        e.stopPropagation();
        e.preventDefault();
      }

      this.scheduleMobileHardwareFocus();
      return;
    }
  }

  /** A tap landed on the terminal's keyboard catcher: iOS is already raising the keyboard. */
  private handleTerminalKeyboardRequest = () => {
    // That tap only closed an open menu: don't raise the keyboard as well. Nor while watching.
    if (Date.now() < this.catcherMutedUntil || this.watching) {
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    this.handleKeyboardButtonClick();
  };

  private catcherMutedUntil = 0;

  /** Mobile: tapping the terminal opens the soft keyboard with the quick keys. */
  private handleTerminalTap = (e?: CustomEvent<{ keyboardCatcher?: boolean }>) => {
    const state = this.uiStateManager.getState();
    if (!state.isMobile || state.chatMode) return;
    // ghostty-web cancels the click that follows a canvas tap, so menus listening for an
    // outside click never closed. Treat the tap as that outside click instead of typing.
    const openMenu = [
      ...document.querySelectorAll<HTMLElement>('[aria-haspopup][aria-expanded="true"]'),
    ].some((toggle) => toggle.getClientRects().length > 0);
    if (openMenu) {
      this.catcherMutedUntil = Date.now() + 800;
      document.body.click();
      return;
    }
    // Soft keyboard already up: leave it alone. Quick keys can stay visible after iOS hides
    // the keyboard (its ✓ / swipe-down), so check the keyboard itself, not the quick keys.
    if (state.showQuickKeys && state.keyboardHeight > 50) return;
    if (this.watching) return;
    // The catcher's own focus opens the keyboard (handleTerminalKeyboardRequest).
    if (e?.detail?.keyboardCatcher) return;
    this.handleKeyboardButtonClick();
  };

  /** Pinch on the terminal: same path as the font size setting (persisted, refits). */
  private handlePinchFontSize = (e: CustomEvent<{ size: number }>) => {
    this.terminalSettingsManager.handleFontSizeChange(e.detail.size);
  };

  /** A resume in flight: a second tap would start a second writer of the conversation. */
  private resumingClaude = false;

  /**
   * As the row's Resume (2026-10-18 review): once at a time, shielded again when it was, and a
   * failure is said, not only logged.
   */
  private async handleResumeClaude() {
    const session = this.session;
    if (!session || !resumableAgent(session) || this.resumingClaude) return;
    this.resumingClaude = true;
    try {
      const { sessionId } = await resumeSession(session, authClient.getAuthHeader());
      this.dispatchEvent(
        new CustomEvent('session-created', { detail: { sessionId }, bubbles: true, composed: true })
      );
    } catch (error) {
      logger.error('Failed to resume the conversation', error);
      toast({ kind: 'error', text: `${t('newChat.failed')}: ${error}` });
    } finally {
      this.resumingClaude = false;
    }
  }

  private async handleTerminalInput(e: CustomEvent) {
    const { text, scroll } = e.detail;
    if (this.inputManager && text) {
      await this.inputManager.sendInputText(text, { scroll: scroll === true });
    }
  }

  private handleTerminalResize(event: CustomEvent<{ cols: number; rows: number }>) {
    logger.log('Terminal resized:', event.detail);
    this.terminalLifecycleManager.handleTerminalResize(event);
  }

  private handleTerminalReady() {
    logger.log('Terminal ready event received');
    // Terminal is ready, ensure it's properly initialized
    this.ensureTerminalInitialized();

    this.scheduleMobileHardwareFocus();
  }

  /** The terminal's buffer is mid-replay, not the live screen (terminal.isScreenSettling). */
  private screenSettling = (): boolean =>
    this.terminalLifecycleManager.getTerminal()?.isScreenSettling?.() ?? false;

  /**
   * How the terminal laid out its last lines, for reading Claude's menus off them, and the
   * width Claude drew them for (the PTY's), which another client may have changed.
   */
  private screenLayout(lines: number): ScreenLayout | undefined {
    const terminal = this.terminalLifecycleManager.getTerminal();
    if (!terminal) return undefined;
    const { cols, rows } = terminal.getTerminalSize();
    return {
      cols,
      visibleRows: rows,
      wrappedRows: terminal.getScreenWrapped(lines),
      ptyCols: this.connectionManager?.getPtySize()?.cols,
    };
  }

  /**
   * A key, a tap, or input sent from this page: the user is using it here, and the session's
   * size goes to this page (terminal-lifecycle-manager claimSize). User report 2026-10-14: the
   * page shown again, focus, a rotation, a scroll or a pinch took the size too, and a Mac-window
   * session changed width under whoever was really using it.
   */
  private handleUserActivity = () => {
    if (document.visibilityState === 'hidden' || this.watching) return;
    this.terminalLifecycleManager?.noteUserActivity();
  };

  /** A key that types something or acts (not a modifier on its own). */
  private handleKeyActivity = (event: KeyboardEvent) => {
    if (isModifierKey(event.key)) return;
    this.handleUserActivity();
  };

  /** Where a pointer went down, to tell a tap from a scroll, a drag or a pinch. */
  private tapStart: { x: number; y: number; at: number; id: number } | null = null;

  private handleTapStart = (event: PointerEvent) => {
    this.tapStart = event.isPrimary
      ? { x: event.clientX, y: event.clientY, at: Date.now(), id: event.pointerId }
      : null;
  };

  /** A tap (up within 10 px and 500 ms of where it went down) on the terminal or quick keys. */
  private handleTapEnd = (event: PointerEvent) => {
    const start = this.tapStart;
    this.tapStart = null;
    if (!isTap(start, event)) return;
    const onTerminal = event
      .composedPath()
      .some(
        (node) =>
          node instanceof HTMLElement &&
          (node.tagName === 'UT-TERMINAL' || node.tagName === 'TERMINAL-QUICK-KEYS')
      );
    if (onTerminal) this.handleUserActivity();
  };

  private scheduleMobileHardwareFocus() {
    // In chat mode the composer takes what is typed (see mobileHardwareKeyboardHandler).
    const state = this.uiStateManager.getState();
    if (!state.isMobile || state.chatMode) {
      return;
    }

    if (this.mobileHardwareFocusTimeout) {
      clearTimeout(this.mobileHardwareFocusTimeout);
    }
    this.mobileHardwareFocusTimeout = setTimeout(() => {
      this.mobileHardwareFocusTimeout = null;
      const activeElement = document.activeElement;
      if (
        this.isConnected &&
        !this.disableFocusManagement &&
        (activeElement === document.body || activeElement === document.documentElement)
      ) {
        this.focus();
      }
    }, 0);
  }

  private handleTerminalOutput(data: string) {
    // Forward terminal output to all registered listeners (e.g., chat view)
    for (const listener of this.terminalOutputListeners) {
      listener(data);
    }
  }

  // Allow components to subscribe to terminal output
  subscribeToTerminalOutput(listener: (data: string) => void): () => void {
    this.terminalOutputListeners.add(listener);
    return () => {
      this.terminalOutputListeners.delete(listener);
    };
  }

  private updateTerminalTransform(): void {
    // Clear any existing timeout to debounce calls
    if (this._updateTerminalTransformTimeout) {
      clearTimeout(this._updateTerminalTransformTimeout);
    }

    const state = this.uiStateManager.getState();

    // On mobile, we don't use transforms anymore - just resize
    if (state.isMobile) {
      this._updateTerminalTransformTimeout = setTimeout(() => {
        logger.log(
          `Mobile terminal updated: quickKeys=${state.showQuickKeys}, keyboardHeight=${state.keyboardHeight}px`
        );

        // Force immediate update
        this.requestUpdate();

        // Notify terminal to resize
        requestAnimationFrame(() => {
          // Reserve space for the quick-keys bar so it stops covering the terminal's
          // bottom rows (which also made the top unreachable). Measure it and set the
          // CSS var synchronously before fitTerminal recomputes the row count.
          const grid = this.querySelector('.session-view-grid') as HTMLElement | null;
          const qkEl = this.querySelector('.terminal-quick-keys-container') as HTMLElement | null;
          const qkH =
            state.showQuickKeys && qkEl ? Math.round(qkEl.getBoundingClientRect().height) : 0;
          this.quickKeysHeight = qkH;
          grid?.style.setProperty('--quickkeys-height', `${qkH}px`);

          const terminal = this.getTerminalElement();
          if (terminal) {
            // Notify terminal of size change
            const terminalElement = terminal as unknown as { fitTerminal?: () => void };
            if (typeof terminalElement.fitTerminal === 'function') {
              terminalElement.fitTerminal();
            }

            // If keyboard is visible, scroll to keep cursor visible.
            // Wait for the iOS keyboard show/hide animation (~300ms) + layout reflow,
            // otherwise the scroll happens before the viewport settles and the cursor
            // stays hidden behind the keyboard.
            if (state.keyboardHeight > 0 || state.showQuickKeys) {
              setTimeout(() => {
                const scrollableTerminal = terminal as unknown as {
                  scrollToBottom?: () => void;
                  isFollowingCursor?: () => boolean;
                };
                if (
                  scrollableTerminal.scrollToBottom &&
                  (scrollableTerminal.isFollowingCursor?.() ?? true)
                ) {
                  scrollableTerminal.scrollToBottom();
                }
              }, 350);
            }
          }
        });
      }, 0);
      return;
    }

    // Desktop: Keep existing transform behavior
    this._updateTerminalTransformTimeout = setTimeout(() => {
      // Log for debugging
      logger.log(
        `Terminal transform updated: quickKeys=${state.showQuickKeys}, keyboardHeight=${state.keyboardHeight}px`
      );

      // Force immediate update to apply CSS variable changes
      this.requestUpdate();

      // Always notify terminal to resize when there's a change
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        const terminal = this.getTerminalElement();
        if (terminal) {
          // Notify terminal of size change
          const terminalElement = terminal as unknown as { fitTerminal?: () => void };
          if (typeof terminalElement.fitTerminal === 'function') {
            terminalElement.fitTerminal();
          }

          // If keyboard is visible, scroll to keep cursor visible — but only if the
          // user is still following output (don't yank them down if they scrolled up).
          if (state.keyboardHeight > 0 || state.showQuickKeys) {
            // Small delay then scroll to bottom to keep cursor visible
            setTimeout(() => {
              const scrollableTerminal = terminal as unknown as {
                scrollToBottom?: () => void;
                isFollowingCursor?: () => boolean;
              };
              if (
                scrollableTerminal.scrollToBottom &&
                (scrollableTerminal.isFollowingCursor?.() ?? true)
              ) {
                scrollableTerminal.scrollToBottom();

                // Also ensure the terminal content is scrolled within its container
                const terminalArea = this.querySelector('.terminal-area');
                if (terminalArea) {
                  terminalArea.scrollTop = terminalArea.scrollHeight;
                }
              }
            }, 50);
          }
        }
      });
    }, 100); // Debounce by 100ms
  }

  // SessionViewInterface methods required by managers
  focusHiddenInput(): void {
    this.directKeyboardManager.focusHiddenInput();
  }

  shouldRefocusHiddenInput(): boolean {
    return this.directKeyboardManager.shouldRefocusHiddenInput();
  }

  refocusHiddenInput(): void {
    this.directKeyboardManager.refocusHiddenInput();
  }

  startFocusRetention(): void {
    this.directKeyboardManager.startFocusRetentionPublic();
  }

  delayedRefocusHiddenInput(): void {
    this.directKeyboardManager.delayedRefocusHiddenInputPublic();
  }

  // Mobile Action Bar Callback Methods
  /** The bar's Paste and the clipboard sheet's chosen text take the same path. */
  private async pasteIntoSession(text: string) {
    await this.inputManager?.sendPastedText(text);
  }

  private async handleClipboardPaste() {
    try {
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text) await this.pasteIntoSession(text);
      }
    } catch (error) {
      logger.error('Failed to paste from clipboard:', error);
    }
  }

  /**
   * A quick action (quick-actions-bar.ts): the prompt, then Enter a moment later. An Enter in
   * the same burst as the text was read by Codex as part of it and left the prompt unsent
   * (2026-10-03, services/claude-initial-input.ts waits 300 ms for Codex too).
   */
  private handleQuickAction = async (prompt: string) => {
    if (!this.inputManager) return;
    if (prompt.includes('\n')) await this.inputManager.sendPastedText(prompt);
    else await this.inputManager.sendInputText(prompt);
    await new Promise((resolve) => setTimeout(resolve, QUICK_ACTION_ENTER_DELAY_MS));
    await this.inputManager.sendInput('enter');
  };

  private handleHapticFeedback(type: 'light' | 'medium' | 'heavy') {
    // Implement haptic feedback for supported devices
    if ('vibrate' in navigator) {
      const patterns = {
        light: [10],
        medium: [20],
        heavy: [50],
      };
      navigator.vibrate(patterns[type]);
    }
  }

  render() {
    if (!this.session) {
      return html`
        <div class="fixed inset-0 bg-bg flex items-center justify-center">
          <div class="text-primary font-mono text-center">
            <div class="text-2xl mb-2">${this.loadingAnimationManager.getLoadingText()}</div>
            <div class="text-sm text-text-muted">${t('session.waiting')}</div>
          </div>
        </div>
      `;
    }

    // Get UI state once for the entire render method
    const uiState = this.uiStateManager.getState();
    const terminalUnderChat = this.terminalUnderChat();
    const desktopAgentChat = this.desktopAgentChat();

    return html`
      <style>
        /* 2026-10-12: this used to strip outline AND box-shadow from every descendant, which
           killed focus rings, menu/popover elevation and the selected accent swatch ring.
           Only the terminal surface (terminal-renderer) keeps the no-outline reset. */
        session-view terminal-renderer,
        session-view terminal-renderer *,
        session-view terminal-renderer *:focus,
        session-view terminal-renderer *:focus-visible {
          outline: none !important;
          box-shadow: none !important;
        }
        session-view:focus {
          outline: 2px solid var(--color-primary) !important;
          outline-offset: -2px;
        }
        
        /* Desktop: Grid layout for stable touch handling */
        @media (min-width: 769px) {
          .session-view-grid {
            display: grid;
            grid-template-areas:
              "header"
              "terminal"
              "quickkeys";
            grid-template-rows: auto 1fr auto;
            /* minmax(0, ...): what is inside can't widen the column. A plain 1fr let the chat
               at 80 columns squeeze the sidebar to a sliver in a 900 px window (2026-10-12). */
            grid-template-columns: minmax(0, 1fr);
            height: 100vh;
            height: 100dvh;
            width: 100%;
            max-width: 100vw;
            position: relative;
            background-color: var(--color-bg);
            /* Chrome is sans (design spec 0.5); the terminal sets its own TERMINAL_FONT_FAMILY. */
            font-family: var(--font-ui);
            overflow: hidden;
            overscroll-behavior: none;
            touch-action: none;
            box-sizing: border-box;
          }
          
          /* Adjust grid when keyboard is visible */
          .session-view-grid[data-keyboard-visible="true"] {
            height: calc(100vh - var(--keyboard-height, 0px) - var(--quickkeys-height, 0px));
            height: calc(100dvh - var(--keyboard-height, 0px) - var(--quickkeys-height, 0px));
            transition: height 0.2s ease-out;
          }
          
          .session-header-area {
            grid-area: header;
            position: sticky;
            position: -webkit-sticky;
            top: 0;
            z-index: 50;
            background-color: var(--ut-session-bar);
            transform: translate3d(0, 0, 0);
            -webkit-transform: translate3d(0, 0, 0);
            display: block;
            /* Apply the notch/safe-area inset on the actually-visible sticky element so
               it's respected when pinned, instead of on an invisible wrapper. */
            padding-top: env(safe-area-inset-top);
          }
          
          .terminal-area {
            grid-area: terminal;
            position: relative;
            overflow: hidden;
            overflow-x: hidden;
            min-height: 0; /* Critical for grid */
            contain: layout style paint; /* Isolate terminal updates */
            touch-action: auto;
            -webkit-overflow-scrolling: touch;
          }
          
          /* Desktop: Terminal fills available space */
          .terminal-area ut-terminal {
            height: 100% !important;
            margin-bottom: 0 !important;
          }
          
          /* The grid reserves quick-key height, so legacy transforms and padding would
             shift the terminal outside its row and clip content. */
          .terminal-area[data-quickkeys-visible="true"] {
            transform: none;
          }

          .terminal-area[data-quickkeys-visible="true"] ut-terminal {
            padding-bottom: 0 !important;
            box-sizing: border-box;
          }
          
          /* Overlay container - spans entire grid */
          .overlay-container {
            grid-area: 1 / 1 / -1 / -1;
            pointer-events: none;
            /* Above the session header (50): the file browser and dialogs inside this
               stacking context were drawn under it, hiding their own header and Back. */
            z-index: 60;
            position: relative;
          }
        }
        
        /* Mobile: Flexbox layout without transforms */
        @media (max-width: 768px) {
          .session-view-grid {
            /* Use mobile-terminal-container styles */
            display: flex !important;
            flex-direction: column !important;
            height: 100vh !important;
            height: var(--app-height, 100dvh) !important;
            width: 100% !important;
            position: relative !important;
            overflow: hidden !important;
            overscroll-behavior: none !important;
            touch-action: none !important;
            background-color: var(--color-bg) !important;
            /* Chrome is sans (design spec 0.5); the terminal sets its own TERMINAL_FONT_FAMILY. */
            font-family: var(--font-ui);
          }


          .session-header-area {
            /* Use mobile-terminal-header styles */
            flex-shrink: 0 !important;
            position: sticky !important;
            top: 0 !important;
            z-index: 50 !important;
            /* The header's own surface (phone spec 3.4; --ut-session-bar), safe area too. */
            background-color: var(--ut-session-bar) !important;
            transform: translate3d(0, 0, 0) !important;
            -webkit-transform: translate3d(0, 0, 0) !important;
            /* Notch/safe-area inset on the visible sticky header (see desktop rule). */
            padding-top: env(safe-area-inset-top) !important;
          }
          
          .terminal-area {
            /* Use mobile-terminal-content styles */
            flex: 1 !important;
            min-height: 0 !important;
            overflow: hidden !important;
            overflow-x: hidden !important;
            position: relative !important;
            contain: layout style paint !important;
            touch-action: auto !important;
            -webkit-overflow-scrolling: touch !important;
            /* Remove ALL transforms */
            transform: none !important;
            transition: none !important;
          }
          
          /* Mobile: Reset terminal sizing */
          .terminal-area ut-terminal {
            height: 100% !important;
            margin-bottom: 0 !important;
            padding-bottom: 0 !important;
          }
          
          /* Mobile: Disable quickkeys transform */
          .terminal-area[data-quickkeys-visible="true"] {
            transform: none !important;
          }
          
          /* Mobile: Overlay positioning */
          .overlay-container {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            pointer-events: none !important;
            z-index: 60 !important;
          }
        }

        /* Phones: pin the session layout to the visible viewport (above the keyboard,
           following any iOS pan). Header, terminal, quick keys and action bar are rows of
           this column, so nothing depends on how iOS reports the keyboard height — on a
           real iPhone that math put the fixed quick keys under the header. Applies in
           landscape too, where phones exceed the 768px breakpoint. */
        .session-view-grid[data-mobile="true"] {
          display: flex !important;
          flex-direction: column !important;
          position: fixed !important;
          top: var(--vv-top, 0px) !important;
          /* Beside an expanded sidebar (touch iPad), never over it: app.ts sets --sidebar-w. */
          left: var(--sidebar-w, 0px) !important;
          right: 0 !important;
          width: auto !important;
          max-width: none !important;
          height: var(--app-height, 100dvh) !important;
          /* Nothing scrolls the column itself: in phone landscape the Keyboard button's 80 px
             tall proxy field overflowed it by 34 px and focusing scrolled the header over the
             terminal (2026-10-12). Scripted scrolls are reset in resetGridScroll(). */
          overflow: hidden !important;
          /* Follows the keyboard in the frame it moves. In landscape a phone is over 768px
             wide and the desktop grid's 0.2 s height transition applied while the keyboard
             or the quick keys were up: the terminal and the chat composer trailed it. */
          transition: none !important;
        }
        .session-view-grid[data-mobile="true"] > .terminal-area {
          flex: 1 1 auto !important;
          min-height: 0 !important;
        }
        .session-view-grid[data-mobile="true"] > terminal-quick-keys,
        .session-view-grid[data-mobile="true"] > quick-actions-bar,
        .session-view-grid[data-mobile="true"] > terminal-chat-view {
          display: block;
          flex-shrink: 0;
        }
        /* Experiment, off unless "chatKeyboardFix" in config.json (2026-10-04): while
           session-view/chat-keyboard-fix.ts puts data-kbfix on the root, the layout follows
           the page iOS scrolled instead of being position: fixed, which WebKit painted
           higher than it laid it out in the home-screen app. Body is --app-height tall and
           would cut it off. */
        :root[data-kbfix] body {
          overflow: visible !important;
        }
        :root[data-kbfix] .session-view-grid[data-mobile="true"] {
          position: absolute !important;
          top: var(--kbfix-top, 0px) !important;
          height: var(--kbfix-height, var(--app-height, 100dvh)) !important;
        }
        /* Experiment, iteration 3, off unless "chatKeyboardFix2" in config.json (2026-10-04):
           between the first tap on the chat composer and the keyboard being up,
           session-view/chat-keyboard-fix2.ts shortens the layout to above the coming
           keyboard, so iOS finds the field visible and does not scroll the page. */
        :root[data-kbfix2] .session-view-grid[data-mobile="true"] {
          height: var(--kbfix2-height, var(--app-height, 100dvh)) !important;
        }
        /* Experiment, iteration 4, off unless "chatKeyboardFix3" in config.json (2026-10-04):
           while the chat composer has the focus, session-view/chat-keyboard-fix3.ts holds the
           whole page as tall as the visible area (this element's own 100dvh and the app root
           kept the document 956 tall on the owner's iPhone with the keyboard up, so iOS had
           353 px to scroll) and keeps its scroll at 0; the layout sits at the visible top. */
        :root[data-kbfix3],
        :root[data-kbfix3] body,
        :root[data-kbfix3] untether-app,
        :root[data-kbfix3] .split-view-root,
        :root[data-kbfix3] session-view {
          height: var(--kbfix3-height) !important;
          min-height: 0 !important;
          max-height: var(--kbfix3-height) !important;
          overflow: hidden !important;
        }
        :root[data-kbfix3] .session-view-grid[data-mobile="true"] {
          top: var(--kbfix3-top, 0px) !important;
          height: var(--kbfix3-height) !important;
          max-height: var(--kbfix3-height) !important;
        }
        /* Chat mode hides the action bar, so the composer is the last row: it clears the home
           indicator itself, but only while the keyboard is down (2026-10-03: nothing did, and
           the composer sat under the home indicator). */
        .session-view-grid[data-mobile="true"] > terminal-chat-view {
          --composer-safe-bottom: env(safe-area-inset-bottom, 0px);
        }
        .session-view-grid[data-mobile="true"][data-soft-keyboard="true"] > terminal-chat-view {
          --composer-safe-bottom: 0px;
        }

        /* <mobile-action-bar> is docked below the terminal and takes real layout space,
           so the terminal fits above it instead of being covered. */
        .session-view-grid[data-mobile="true"] > mobile-action-bar {
          display: block;
          flex-shrink: 0 !important;
        }
        
        .overlay-container > * {
          pointer-events: auto;
          touch-action: manipulation; /* Eliminates 300ms delay */
          -webkit-tap-highlight-color: transparent;
        }
        
        /* Apply touch optimizations to all interactive elements */
        button, [role="button"], .clickable {
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
      </style>
      <!-- Background wrapper to extend header color to status bar -->
      <div class="bg-bg-secondary">
        <div
          class="session-view-grid"
          style="outline: none !important; box-shadow: none !important; --keyboard-height: ${uiState.keyboardHeight}px; --quickkeys-height: ${uiState.showQuickKeys ? this.quickKeysHeight : 0}px;"
          data-mobile="${uiState.isMobile ? 'true' : 'false'}"
          data-keyboard-visible="${uiState.keyboardHeight > 0 || uiState.showQuickKeys ? 'true' : 'false'}"
          data-soft-keyboard="${uiState.keyboardHeight > SOFT_KEYBOARD_MIN_HEIGHT ? 'true' : 'false'}"
          data-short-landscape="${this.shortLandscape.value ? 'true' : 'false'}"
          data-chat-surface="${terminalUnderChat && uiState.viewMode === 'terminal' ? 'true' : 'false'}"
        >
        <!-- Session Header Area -->
        <div class="session-header-area">
          <session-header
            .session=${this.session}
            .sessions=${this.sessions}
            .serverPlatform=${this.serverPlatform}
            .showBackButton=${this.showBackButton}
            .showSidebarToggle=${this.showSidebarToggle}
            .sidebarCollapsed=${this.sidebarCollapsed}
            .keyboardCaptureActive=${uiState.keyboardCaptureActive}
            .isMobile=${uiState.isMobile}
            .widthLabel=${this.terminalSettingsManager.getCurrentWidthLabel()}
            .widthTooltip=${this.terminalSettingsManager.getWidthTooltip()}
            .onBack=${() => this.handleBack()}
            .onSidebarToggle=${() => this.handleSidebarToggle()}
            .onOpenFileBrowser=${() => this.fileOperationsManager.openFileBrowser()}
            .onMaxWidthToggle=${() => this.terminalSettingsManager.handleMaxWidthToggle()}
            .onFitOff=${() => this.terminalSettingsManager.handleFitOff()}
            .onWidthSelect=${(width: number) => this.terminalSettingsManager.handleWidthSelect(width)}
            .onOpenSettings=${() => this.handleOpenSettings()}
            .onTerminateSession=${() => this.sessionActionsHandler.handleTerminateSession()}
            .onShieldSession=${() => void this.sessionActionsHandler.handleShieldSession()}
            .onShareSession=${() => {
              if (this.session)
                openShareSheet(this.session.id, this.session.name || this.session.id);
            }}
            .onClearSession=${() => this.sessionActionsHandler.handleClearSession()}
            .onRestartSession=${() => void this.sessionActionsHandler.handleRestartSession()}
            .onToggleViewMode=${() => this.sessionActionsHandler.handleToggleViewMode()}
            .chatMode=${uiState.chatMode}
            .promptInChat=${uiState.chatMode && this.chatAsking}
            .onToggleChatMode=${() => this.handleToggleChatMode()}
            .onSelectText=${this.handleSelectText}
            .onShowChanges=${this.handleShowChanges}
            @session-retitle=${async (e: CustomEvent) => {
              // Taken: the header's inline rename waits for `done` (it shows the error itself).
              e.preventDefault();
              const { sessionId, userTitle, done } = e.detail;
              const result = await this.sessionActionsHandler.handleSetUserTitle(
                sessionId,
                userTitle,
                { showError: !done }
              );
              done?.(result);
            }}
            @paste-image=${async () => await this.fileOperationsManager.pasteImage()}
            @select-image=${() => this.fileOperationsManager.selectImage()}
            @toggle-view-mode=${() => this.sessionActionsHandler.handleToggleViewMode()}
            @capture-toggled=${(e: CustomEvent) => {
              this.dispatchEvent(
                new CustomEvent('capture-toggled', {
                  detail: e.detail,
                  bubbles: true,
                  composed: true,
                })
              );
            }}
            .hasGitRepo=${!!this.session?.gitRepoPath}
            .viewMode=${uiState.viewMode}
            @attach-mode-change=${(e: CustomEvent<MacModeRequest>) => this.handleAttachChange(e.detail)}
          >
          </session-header>
          ${this.renderWatchBanner()}
        </div>

        <!-- Content Area (Terminal or Worktree) -->
        <div
          class="terminal-area bg-bg ${
            this.session?.status === 'exited' && uiState.viewMode === 'terminal'
              ? 'session-exited opacity-90'
              : ''
          } ${
            // Add safe area padding for landscape mode on mobile to handle notch
            uiState.isMobile && uiState.isLandscape ? 'safe-area-left safe-area-right' : ''
          }"
          data-quickkeys-visible="${uiState.showQuickKeys}"
          data-chat="${uiState.chatMode && uiState.viewMode === 'terminal' ? 'true' : 'false'}"
        >
          ${
            this.loadingAnimationManager.isLoading()
              ? html`
                <!-- Enhanced Loading overlay -->
                <div
                  class="absolute inset-0 bg-bg/90 backdrop-filter backdrop-blur-sm flex items-center justify-center z-10 animate-fade-in"
                >
                  <div class="text-primary font-mono text-center">
                    <div class="text-2xl mb-3 text-primary animate-pulse-primary">${this.loadingAnimationManager.getLoadingText()}</div>
                    <div class="text-sm text-text-muted">${t('session.connecting')}</div>
                  </div>
                </div>
              `
              : ''
          }
          ${
            uiState.viewMode === 'worktree' && this.session?.gitRepoPath
              ? html`
              <worktree-manager
                .gitService=${this.gitService}
                .repoPath=${this.session.gitRepoPath}
                @back=${() => {
                  this.uiStateManager.setViewMode('terminal');
                }}
              ></worktree-manager>
            `
              : uiState.viewMode === 'terminal'
                ? html`
              <!-- Enhanced Terminal Component -->
              <div style="position: relative; height: 100%;">
                <!-- Terminal (hidden in desktop chat mode; phones keep it live above the composer).
                     Always LTR, even when the UI language is RTL. -->
                <terminal-renderer
                  dir="ltr"
                  style="${uiState.chatMode && !uiState.isMobile ? 'display: none;' : terminalUnderChat ? 'visibility: hidden;' : ''}"
                  ?inert=${terminalUnderChat}
                  id="${TERMINAL_IDS.SESSION_TERMINAL}"
                  .session=${this.session}
                  .terminalFontSize=${uiState.terminalFontSize}
                  .terminalMaxCols=${uiState.terminalMaxCols}
                  .terminalTheme=${uiState.terminalTheme}
                  .disableClick=${uiState.isMobile}
                  .hideScrollButton=${uiState.showQuickKeys}
                  .keyboardCatcher=${
                    uiState.isMobile &&
                    !uiState.chatMode &&
                    !this.watching &&
                    !(uiState.showQuickKeys && uiState.keyboardHeight > 50)
                  }
                  .isMobile=${uiState.isMobile}
                  .holdRows=${terminalUnderChat}
                  .showQuickKeys=${uiState.showQuickKeys}
                  .onTerminalClick=${this.boundHandleTerminalClick}
                  .onTerminalInput=${this.boundHandleTerminalInput}
                  .onTerminalResize=${this.boundHandleTerminalResize}
                  .onTerminalReady=${this.boundHandleTerminalReady}
                  @terminal-tap=${this.handleTerminalTap}
                  @terminal-paste-request=${this.handleTerminalPasteRequest}
                  @terminal-keyboard-request=${this.handleTerminalKeyboardRequest}
                ></terminal-renderer>
                
                <!-- "While you were away": what the agent did since this session was last on screen.
                     Not while the chat asks a question: on an iPhone SE it covered the top of the
                     question card, what an answer approves (2026-10-03). Hidden, not removed. -->
                <away-summary-card
                  style="position: absolute; top: 8px; left: 8px; right: 8px; z-index: 6; ${uiState.chatMode && this.chatAsking ? 'display: none;' : ''}"
                  .session=${this.session}
                ></away-summary-card>

                <!-- Phone chat mode: Claude Code conversation as message bubbles over the live
                     terminal (hides itself when the session is not running Claude Code). -->
                ${
                  uiState.isMobile && uiState.chatMode && this.session?.id
                    ? html`
                <!-- Edge to edge: out over the terminal's side inset (session.css) so the chat
                     and its hairlines span the screen like the header and composer. -->
                <claude-chat-view
                  style="position: absolute; inset: 0 calc(-1 * var(--ut-term-inset-right, 0px)) 0 calc(-1 * var(--ut-term-inset-left, 0px)); z-index: 5;"
                  .sessionId=${this.session.id}
                  .compactChrome=${this.shortPane}
                  .landscape=${this.shortLandscape.value}
                  .userTitle=${this.session.userTitle ?? ''}
                  .readOnly=${this.watching}
                  .getScreenTail=${() =>
                    this.terminalLifecycleManager.getTerminal()?.getScreenText(30) ?? ''}
                  .getMenuScreen=${() =>
                    this.terminalLifecycleManager.getTerminal()?.getScreenText(60) ?? ''}
                  .getScreenLayout=${() => this.screenLayout(60)}
                  .screenSettling=${this.screenSettling}
                  .ptyCols=${this.ptyCols}
                  @claude-chat-open-terminal=${() => this.handleToggleChatMode()}
                  @claude-chat-asking=${(e: CustomEvent<boolean>) => {
                    this.chatAsking = e.detail;
                  }}
                  @claude-chat-availability=${(e: CustomEvent<boolean>) => {
                    this.chatCovers = e.detail;
                  }}
                  @claude-chat-input=${(e: CustomEvent<string>) => this.inputManager?.sendInputText(e.detail)}
                  @chat-message-retry=${this.handleChatMessageRetry}
                ></claude-chat-view>
                `
                    : ''
                }

                <!-- Desktop chat mode. A session with an agent conversation shows it (claude-chat-view,
                     as on a phone) with the composer under it, sending the way the phone's does.
                     Only sessions without one (plain shells) get the chat parsed from the
                     terminal's output, rendered always but hidden to keep its history. -->
                ${
                  !uiState.isMobile && uiState.chatMode && this.session?.id
                    ? html`
                <div
                  class="desktop-agent-chat"
                  data-testid="desktop-agent-chat"
                  style="position: absolute; inset: 0; z-index: 5; flex-direction: column; display: ${desktopAgentChat ? 'flex' : 'none'};"
                >
                  <claude-chat-view
                    desktop
                    style="flex: 1 1 auto; min-height: 0; height: auto;"
                    .sessionId=${this.session.id}
                    .userTitle=${this.session.userTitle ?? ''}
                    .readOnly=${this.watching}
                    .getScreenTail=${() =>
                      this.terminalLifecycleManager.getTerminal()?.getScreenText(30) ?? ''}
                    .getMenuScreen=${() =>
                      this.terminalLifecycleManager.getTerminal()?.getScreenText(60) ?? ''}
                    .getScreenLayout=${() => this.screenLayout(60)}
                    .screenSettling=${this.screenSettling}
                    .ptyCols=${this.ptyCols}
                    @claude-chat-open-terminal=${() => this.handleToggleChatMode()}
                    @claude-chat-asking=${(e: CustomEvent<boolean>) => {
                      this.chatAsking = e.detail;
                    }}
                    @claude-chat-availability=${this.handleChatAvailability}
                    @claude-chat-input=${(e: CustomEvent<string>) => this.inputManager?.sendInputText(e.detail)}
                    @chat-message-retry=${this.handleChatMessageRetry}
                  ></claude-chat-view>
                  ${
                    this.watching
                      ? ''
                      : html`<terminal-chat-view
                    composerOnly
                    desktop
                    style="flex: none;"
                    .claudeSession=${Boolean(this.session.claudeStatus) || sessionTool(this.session) === 'claude'}
                    .agent=${sessionTool(this.session)}
                    .getScreenText=${() =>
                      this.terminalLifecycleManager.getTerminal()?.getScreenText(60) ?? ''}
                    .getScreenLayout=${() => this.screenLayout(60)}
                    .screenSettling=${this.screenSettling}
                    .ptyCols=${this.ptyCols}
                    .claudeWaiting=${this.session.claudeStatus?.status === 'waiting'}
                    .menuInChat=${this.chatAsking}
                    @composer-attach=${this.handleComposerAttach}
                    @chat-message-sent=${this.handleChatMessageSent}
                    @chat-message-failed=${this.handleChatMessageFailed}
                    .active=${desktopAgentChat}
                    .sessionId=${this.session.id}
                    .onSend=${(data: string) =>
                      data.includes('\n')
                        ? this.inputManager?.sendPastedText(data)
                        : this.inputManager?.sendInputText(data)}
                    .getTerminalInputLine=${() => this.terminalLifecycleManager.getTerminal()?.getCurrentInputLine() ?? ''}
                  ></terminal-chat-view>`
                  }
                </div>
                `
                    : ''
                }
                ${
                  uiState.isMobile
                    ? ''
                    : html`
                <terminal-chat-view
                  style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; ${uiState.chatMode && !desktopAgentChat ? '' : 'display: none; pointer-events: none;'}"
                  .active=${uiState.chatMode && !desktopAgentChat}
                  .sessionId=${this.session?.id ?? ''}
                  .pendingInput=${this.inputManager?.getPendingInput() ?? ''}
                  .onSend=${(data: string) => this.inputManager?.sendInputText(data)}
                  .onPendingInputChange=${(input: string) => this.inputManager?.setPendingInput(input)}
                  .subscribeToOutput=${(listener: (data: string) => void) => this.subscribeToTerminalOutput(listener)}
                  .getTerminalInputLine=${() => this.terminalLifecycleManager.getTerminal()?.getCurrentInputLine() ?? ''}
                ></terminal-chat-view>
                `
                }
              </div>
            `
                : ''
          }
        </div>

        <!-- Phone chat mode: a native composer (autocorrect, predictions, dictation) under the
             live terminal. Parsing a full-screen TUI's output into chat bubbles produced noise. -->
        ${
          uiState.isMobile && uiState.chatMode && uiState.viewMode === 'terminal' && !this.watching
            ? html`
          <terminal-chat-view
            composerOnly
            .compactChrome=${this.shortPane}
            .landscape=${this.shortLandscape.value}
            .claudeSession=${Boolean(this.session?.claudeStatus) || (this.session ? sessionTool(this.session) === 'claude' : false)}
            .agent=${this.session ? sessionTool(this.session) : undefined}
            .getScreenText=${() =>
              this.terminalLifecycleManager.getTerminal()?.getScreenText(60) ?? ''}
            .getScreenLayout=${() => this.screenLayout(60)}
            .screenSettling=${this.screenSettling}
            .ptyCols=${this.ptyCols}
            .claudeWaiting=${this.session?.claudeStatus?.status === 'waiting'}
            .menuInChat=${this.chatAsking}
            @composer-attach=${this.handleComposerAttach}
            @composer-focus=${this.handleComposerFocus}
            @chat-message-sent=${this.handleChatMessageSent}
            @chat-message-failed=${this.handleChatMessageFailed}
            .active=${true}
            .sessionId=${this.session?.id ?? ''}
            .pendingInput=${this.inputManager?.getPendingInput() ?? ''}
            .onSend=${(data: string) =>
              data.includes('\n')
                ? this.inputManager?.sendPastedText(data)
                : this.inputManager?.sendInputText(data)}
            .onPendingInputChange=${(input: string) => this.inputManager?.setPendingInput(input)}
            .getTerminalInputLine=${() => this.terminalLifecycleManager.getTerminal()?.getCurrentInputLine() ?? ''}
          ></terminal-chat-view>
        `
            : ''
        }

        <!-- Phone quick actions: one-tap prompts above the quick keys / action bar. -->
        ${
          uiState.isMobile
            ? html`
          <quick-actions-bar
            .session=${this.session}
            .visible=${this.session?.status === 'running' && !uiState.chatMode && !this.watching}
            .onSend=${this.handleQuickAction}
            @quick-actions-layout-change=${() => this.updateTerminalTransform()}
          ></quick-actions-bar>
        `
            : ''
        }

        <!-- Phone quick keys: last row of the viewport-pinned layout, so they always sit
             directly above the keyboard however iOS reports its height. -->
        ${
          uiState.isMobile
            ? html`
          <terminal-quick-keys
            docked
            .visible=${uiState.showQuickKeys && !uiState.chatMode && !this.watching}
            .onKeyPress=${(key: string) => this.directKeyboardManager.handleQuickKeyPress(key)}
            @quick-keys-layout-change=${() => this.updateTerminalTransform()}
          ></terminal-quick-keys>
        `
            : ''
        }

        <!-- Mobile Action Bar -->
        ${
          uiState.isMobile
            ? html`
          <mobile-action-bar
            .visible=${!uiState.showQuickKeys && !uiState.chatMode && !this.watching}
            .session=${this.session}
            .keyboardVisible=${uiState.keyboardHeight > SOFT_KEYBOARD_MIN_HEIGHT}
            .callbacks=${(() => {
              const callbacks = {
                // The bar's own buttons. The command palette's callbacks (modes, theme, new
                // session, sidebar…) went with it: no button ever opened it (2026-10-20 audit).
                onPasteFromClipboard: () => this.handleClipboardPaste(),
                // 2026-11-10: the clipboard sheet (long press on Paste) did nothing because
                // this callback was never passed, so choosing its text sent nothing.
                onPaste: (text: string) => void this.pasteIntoSession(text),
                onOpenFileBrowser: () => this.fileOperationsManager.openFileBrowser(),
                onUploadFile: () => this.fileOperationsManager.openFilePicker(),

                // Mobile-specific callbacks
                onShowKeyboard: () => this.handleKeyboardButtonClick(),
                onTriggerHaptic: (type: 'light' | 'medium' | 'heavy') =>
                  this.handleHapticFeedback(type),
              };
              return callbacks;
            })()}
          ></mobile-action-bar>
        `
            : ''
        }

        <!-- Layer under the session header (50), over the terminal, chat and bars: the header's
             menus open over it. In the overlay container (60) "Session ended" covered the ⋮
             menu's "Chat mode", and the app's "Reconnecting…" pill its "New session"
             (2026-10-03). -->
        ${
          this.session?.status === 'exited' || this.reconnecting
            ? html`
          <div
            class="session-under-header-layer"
            style="position: absolute; inset: 0; pointer-events: none; z-index: ${Z_INDEX.SESSION_EXITED_OVERLAY};"
          >
            <session-exited-badge
              .session=${this.session}
              @resume-claude=${() => this.handleResumeClaude()}
            ></session-exited-badge>
            ${
              this.reconnecting
                ? html`<div class="reconnecting-pill" role="status" aria-live="polite">
                    <span class="reconnecting-dot"></span>${t('connection.reconnecting')}
                  </div>`
                : ''
            }
          </div>
        `
            : ''
        }

        <!-- Overlay Container - All overlays go here for stable positioning -->
        <div class="overlay-container">
          <overlays-container
            .session=${this.session}
            .uiState=${uiState}
            .callbacks=${{
              // Ctrl+Alpha callbacks
              onCtrlKey: (letter: string) => this.handleCtrlKey(letter),
              onSendCtrlSequence: () => this.handleSendCtrlSequence(),
              onClearCtrlSequence: () => this.handleClearCtrlSequence(),
              onCtrlAlphaCancel: () => this.handleCtrlAlphaCancel(),

              // Quick keys
              onQuickKeyPress: (key: string) => this.directKeyboardManager.handleQuickKeyPress(key),

              // File browser/picker
              onCloseFileBrowser: () => this.fileOperationsManager.closeFileBrowser(),
              onInsertPath: async (e: CustomEvent) => {
                const { path, type } = e.detail;
                await this.fileOperationsManager.insertPath(path, type);
              },
              onFileSelected: async (e: CustomEvent) => {
                await this.fileOperationsManager.handleFileSelected(e.detail.path);
              },
              onFileError: (e: CustomEvent) => {
                this.fileOperationsManager.handleFileError(e.detail);
              },
              onCloseFilePicker: () => this.fileOperationsManager.closeFilePicker(),

              // Terminal settings
              onWidthSelect: (width: number) =>
                this.terminalSettingsManager.handleWidthSelect(width),
              onFontSizeChange: (size: number) =>
                this.terminalSettingsManager.handleFontSizeChange(size),
              onThemeChange: (theme: TerminalThemeId) =>
                this.terminalSettingsManager.handleThemeChange(theme),
              onCloseWidthSelector: () => {
                this.uiStateManager.setShowWidthSelector(false);
                this.uiStateManager.setCustomWidth('');
              },
            }}
          ></overlays-container>
        </div>
      </div>
      </div>
    `;
  }
}

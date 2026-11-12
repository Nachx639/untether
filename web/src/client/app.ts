// Install crypto polyfill first - must be before any code that uses crypto.randomUUID()
import './utils/crypto-polyfill.js';

import { html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { namedForAgent } from '../shared/agent-push.js';
// Import shared types
import {
  MAC_SESSION_VIEW_EVENT,
  MAC_SESSIONS_CHANGED_EVENT,
  MAC_TMUX_OPEN_EVENT,
  type MacSessionsResponse,
  type MacSessionViewDetail,
  type MacTmuxOpenDetail,
} from '../shared/mac-sessions.js';
import { MAC_SHARE_EVENT, type MacShareSheetDetail } from '../shared/mac-share.js';
import type { Session } from '../shared/types.js';
import { HttpMethod, ServerEventType } from '../shared/types.js';
import type { PromptChoices } from './components/answer-sheet.js';
import { getLocale, LocaleController, t, whenLocaleReady } from './i18n/index.js';
import { listPath } from './utils/agent-mission.js';
import { announce, ensureLiveRegion } from './utils/announce.js';
import { fetchAuthConfig } from './utils/auth-config.js';
import { isBrowserShortcut, matchAppShortcut } from './utils/browser-shortcuts.js';
import { isBackgroundWait } from './utils/claude-activity.js';
// Import utilities
import {
  BREAKPOINTS,
  SHOW_TASK_EVENT,
  SIDEBAR,
  TASK_UNFOLD_EVENT,
  TIMING,
  TRANSITIONS,
  Z_INDEX,
} from './utils/constants.js';
// Import logger
import { createLogger } from './utils/logger.js';
import { isIOS } from './utils/mobile-utils.js';
import { type MediaQueryState, responsiveObserver } from './utils/responsive-utils.js';
import { deriveSessionStatus } from './utils/session-status.js';
import { waitingAgent, waitingChoices, waitingFor } from './utils/session-waiting.js';
import { triggerTerminalResize } from './utils/terminal-utils.js';
import { titleManager } from './utils/title-manager.js';

// Import components. The views the session list doesn't show (the session view, previews, the
// file browser, settings, the sheets) are separate chunks: see utils/lazy-views.ts.
import './components/app-header.js';
import './components/session-quick-switcher.js';
import { isPhoneListLayout } from './components/session-list.js';
import './components/session-card.js';
import './components/notification-status.js';
import './components/auth-login.js';

import type { PaletteAction } from './components/session-quick-switcher.js';
import { preferPhoneChatMode } from './components/session-view/ui-state-manager.js';
import {
  closeWhatsNew,
  isWhatsNewOpen,
  openWhatsNew,
  shouldAutoShowWhatsNew,
  WHATS_NEW_DELAY_MS,
  whatsNewBlocked,
} from './components/whats-new-sheet.js';
import { authClient, isTokenRejection } from './services/auth-client.js';
import { loadAvatarIcons } from './services/model-provider-list.js';
import { pushNotificationService } from './services/push-notification-service.js';
import { serverConfigService } from './services/server-config-service.js';
import { serverEventService } from './services/server-event-service.js';
import { SessionService } from './services/session-service.js';
import { terminalSocketClient } from './services/terminal-socket-client.js';
import { showActionToast, toast } from './utils/action-toast.js';
import { parseCommand } from './utils/command-utils.js';
import { confirmDialog } from './utils/confirm-dialog.js';
import { lockedThemeMode, setServerDefaultLook } from './utils/look.js';
import { isSuspended, wakeSession } from './utils/session-suspend.js';
import { isMacPlatform, formatShortcut as shortcutLabel } from './utils/shortcut-label.js';
import { applyThemeMode } from './utils/theme-mode.js';
import './components/modal-wrapper.js';
import { icon } from './components/icons.js';
import { followRotationsOutsideSession } from './utils/app-height.js';
import { startVersionWatch, userIsTyping } from './utils/app-version.js';
import { inputDiagnostics } from './utils/input-diagnostics.js';
import { type LazyModule, lazyViews, preloadLazyViews } from './utils/lazy-views.js';
import {
  announceMacSessionsChanged,
  fetchMacSessions,
  MAC_AGENT_NAMES,
  MacSessionsApiError,
  macItemHasAgents,
  macOpenErrorText,
  openMacSession,
} from './utils/mac-sessions.js';
import { installOfflinePage } from './utils/offline-page.js';
import { PINS_CHANGED_EVENT, prunePinned } from './utils/pinned-sessions.js';
import {
  fetchPreviews,
  findPreviewByPort,
  highlightPreviewRow,
  PREVIEWS_CHANGED_EVENT,
  type PreviewItem,
  type PreviewRoute,
  parsePreviewViewUrl,
  previewViewPath,
} from './utils/preview-rows.js';
import { watchSystemTextSize } from './utils/system-text-size.js';
import { isUnread, markSeen, pruneSeen, updateAppBadge } from './utils/unread-tracker.js';
import { VisibilityPoller } from './utils/visibility-poller.js';

const logger = createLogger('app');

/** Elements of the views loaded on demand (utils/lazy-views.ts), by tag. */
const LAZY_ELEMENTS = {
  'session-view': lazyViews.sessionView,
  'preview-view': lazyViews.previewView,
  'file-browser': lazyViews.fileBrowser,
  'ut-settings': lazyViews.settings,
  'ssh-key-manager': lazyViews.sshKeyManager,
  'session-create-form': lazyViews.sessionCreateForm,
  'multiplexer-modal': lazyViews.multiplexerModal,
} satisfies Record<string, LazyModule<unknown>>;
/** Previews change rarely: the session poll refreshes them at most this often. */
const PREVIEWS_REFRESH_MS = 4000;
/** How long the open session may be missing from the list before it counts as gone. */
const SESSION_MISSING_GRACE_MS = 10_000;
/**
 * A list request that has not answered by then failed: after a Wi-Fi ↔ cellular switch a
 * request on the old connection could hang forever, and with it every later poll.
 */
const SESSIONS_FETCH_TIMEOUT_MS = 8000;
/** First load: how long the sessions wait for the previews shown above them. */
const FIRST_PREVIEWS_WAIT_MS = 1500;
/** "On this Mac": asked with the session poll, at most this often (the server caches 3 s). */
const MAC_SESSIONS_REFRESH_MS = 4000;
/** While the server has the section turned off, or has no such API. */
const MAC_SESSIONS_OFF_REFRESH_MS = 30_000;
/** How long failing requests keep the last list on screen before the section hides. */
const MAC_SESSIONS_STALE_MS = 60_000;
/** How long a session the user ended here can vanish without a "not found" toast. */
const ENDED_HERE_MS = 15_000;
/**
 * Session list poll cadence: every second while things change, slowing to every 2 s after
 * 10 polls without a change and every 3 s after 30 (about 50 s idle). Any change, a session
 * starting or exiting, or the page coming back to the foreground returns it to 1 s.
 */
export function sessionRefreshDelay(unchangedPolls: number): number {
  if (unchangedPolls < 10) return TIMING.AUTO_REFRESH_INTERVAL;
  if (unchangedPolls < 30) return TIMING.AUTO_REFRESH_INTERVAL * 2;
  return TIMING.AUTO_REFRESH_INTERVAL * 3;
}

/** The Navigation API where the browser has it (Safari 26+, Chrome): keyed history entries. */
interface NavigationLike {
  currentEntry: { key: string; index?: number } | null;
  entries(): Array<{ key: string; url?: string | null }>;
  traverseTo(key: string): { finished: Promise<unknown> };
}

const navigationApi = (): NavigationLike | undefined =>
  (window as unknown as { navigation?: NavigationLike }).navigation;

/**
 * A phone stays mobile on its side. A Pro Max in landscape is 956 pt wide, past the 768 pt
 * breakpoint: the rotation "expanded" the sessions sidebar as on a desktop, but the phone's
 * session view covers the whole screen, so the sidebar stayed hidden under it, and the
 * header's "›" (shown only while it is collapsed) was gone (2026-10-04). As mobile, it
 * stays collapsed and opens over the session, as in portrait.
 */
function phoneMediaState(state: MediaQueryState): MediaQueryState {
  return isPhoneListLayout() ? { isMobile: true, isTablet: false, isDesktop: false } : state;
}

/** A field, editor or terminal input that takes typed characters ('?' must reach it). */
function isEditableTarget(target: EventTarget | null, event?: Event): boolean {
  // Inside a shadow root (the copilot sheet) the event's target is the host: look at the
  // element that really has focus (2026-10-13, review: «?» typed in Conversar opened the sheet).
  const el = ((event?.composedPath?.()[0] as EventTarget | undefined) ??
    target) as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(
    el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
  );
}

@customElement('untether-app')
export class UntetherApp extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  /** Non-English locales load as a separate chunk: don't paint English first. */
  private localeGate: Promise<void> | null = whenLocaleReady();

  protected override async scheduleUpdate(): Promise<void> {
    if (this.localeGate) {
      await this.localeGate;
      this.localeGate = null;
    }
    super.scheduleUpdate();
  }

  /** The error on screen (in the toast stack) until it times out; tests read it. */
  protected errorMessage = '';
  protected readonly i18n = new LocaleController(this);
  // Not @state: no template reads it (2026-11-10), only the toast bookkeeping below.
  private attentionToast: { sessionId: string; text: string; waiting: boolean } | null = null;
  private previousClaudeStatus = new Map<string, string>();
  private attentionToastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Dismisses the attention toast in the shared stack (utils/action-toast.ts). */
  private dismissAttentionToast: (() => void) | null = null;
  /** The '?' keyboard shortcut sheet. */
  @state() private showShortcutSheet = false;
  @state() private sessions: Session[] = [];
  @state() private loading = false;
  private stopVersionWatch?: () => void;
  private stopRotationWatch?: () => void;
  @state() private currentView: 'list' | 'session' | 'auth' | 'file-browser' | 'preview' = 'auth';
  /**
   * The preview shown by the 'preview' view (/preview/<id>), and the session it was opened
   * from (Back returns there; null: Back goes to the list).
   */
  @state() private previewTarget: { id: string; path: string; from: string | null } | null = null;
  /** history.length right after the preview view's entry was pushed (see handlePreviewBack). */
  private previewHistoryLength = 0;
  /** Persistent previews (GET /api/previews): the list's "Vistas previas", the chips. */
  @state() private previews: PreviewItem[] = [];
  private previewsLoadedAt = 0;
  private previewsLoad: Promise<void> | null = null;
  /**
   * "On this Mac" (GET /api/mac-sessions) for the phone list: null until it answers, or from a
   * server without it. Never mixed into `sessions`: unread counts, pins, Kill all and broadcast
   * all assume Untether ids.
   */
  @state() private macSessions: MacSessionsResponse | null = null;
  /** What the shown list says, without its scan time (see showMacSessions). */
  private macSessionsShown = 'null';
  private macSessionsAskedAt = 0;
  /** The last answer said the section is off, or the server has no such API. */
  private macSessionsOff = false;
  private macSessionsFailingSince = 0;
  private macSessionsLoad: Promise<void> | null = null;
  /** Bumped on logout: an answer asked for before it is dropped. */
  private macSessionsGeneration = 0;
  /** tmux sessions being opened from a conversation sheet or the history (their ids). */
  private macTmuxOpening = new Set<string>();
  @state() private selectedSessionId: string | null = null;
  private lastViewed: { id: string; at: number } | null = null;
  private loadFailures = 0;
  private everLoaded = false;
  @state() private reconnecting = false;
  @state() private hideExited = this.loadHideExitedState();
  @state() private showCreateModal = false;
  @state() private createDialogWorkingDir = '';
  @state() private showTmuxModal = false;
  @state() private showQuickSwitcher = false;
  @state() private showSSHKeyManager = false;
  @state() private showSettings = false;
  @state() private isAuthenticated = false;
  @state() private sidebarCollapsed = this.loadSidebarState();
  @state() private sidebarWidth = this.loadSidebarWidth();
  @state() private isResizing = false;
  @state() private mediaState: MediaQueryState = phoneMediaState(
    responsiveObserver.getCurrentState()
  );
  @state() private hasActiveOverlay = false;
  @state() private keyboardCaptureActive = true;
  private initialLoadComplete = false;
  private responsiveObserverInitialized = false;
  private initialRenderComplete = false;
  private sidebarAnimationReady = false;
  private sidebarScrollElement: HTMLElement | null = null;
  private sidebarTouchStartY = 0;
  // Session caching to reduce re-renders
  private _cachedSelectedSession: Session | undefined;
  private _cachedSelectedSessionId: string | null = null;
  private _lastLoggedView: string | null = null;

  private errorTimeoutId: number | null = null;
  /** Polls /api/sessions on the list and session views; paused while the page is hidden. */
  private autoRefresh = new VisibilityPoller({
    task: async () => {
      if (
        this.currentView === 'list' ||
        this.currentView === 'session' ||
        this.currentView === 'preview'
      ) {
        void this.loadPreviews();
        if (this.showsMacSessions()) void this.loadMacSessions();
        return this.loadSessions();
      }
      return false;
    },
    nextDelay: sessionRefreshDelay,
  });
  private unsubscribeSessionEvents: Array<() => void> = [];
  private responsiveUnsubscribe?: () => void;
  private resizeCleanupFunctions: (() => void)[] = [];
  private sessionLoadingState: 'idle' | 'loading' | 'loaded' | 'not-found' = 'idle';
  /** The open session missing from the list since when (a server restart re-attaches it). */
  private missingSince: { id: string; at: number } | null = null;
  /** The open session as last listed: shown through its grace while the list lacks it. */
  private lastListedSession: Session | undefined;

  private isTestEnvironment(): boolean {
    return (
      (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') ||
      window.location.search.includes('test=true') ||
      navigator.userAgent.includes('HeadlessChrome') ||
      navigator.userAgent.includes('Headless') ||
      (window as unknown as { __playwright?: unknown }).__playwright !== undefined ||
      navigator.userAgent.includes('Playwright') ||
      navigator.webdriver === true ||
      window.location.port === '4022'
    );
  }

  connectedCallback() {
    super.connectedCallback();
    // "Use the system text size": re-read Dynamic Type when the page comes back.
    watchSystemTextSize();
    // Safari only announces live regions that existed before their text changed.
    ensureLiveRegion();
    // An installed app never reloads on its own: pick up new builds (see app-version.ts).
    this.stopVersionWatch ??= startVersionWatch({
      isBusy: userIsTyping,
      onStale: () =>
        showActionToast({
          key: 'new-version',
          text: t('app.newVersion'),
          action: t('app.reload'),
          onAction: () => window.location.reload(),
          timeoutMs: 0,
        }),
    });
    // The page height outside a session after a rotation (utils/app-height.ts); a session
    // view tracks its own.
    this.stopRotationWatch ??= followRotationsOutsideSession(() =>
      Boolean(document.querySelector('session-view'))
    );
    this.setupKeyboardShortcuts();
    this.setupNotificationHandlers();
    this.setupResponsiveObserver();
    // Listen for keyboard capture toggle events from input manager
    document.addEventListener('capture-toggled', this.handleCaptureToggled as EventListener);
    // Initialize authentication and routing together
    this.initializeApp();
  }

  firstUpdated() {
    // Mark initial render as complete after a microtask to ensure DOM is settled
    Promise.resolve().then(() => {
      this.initialRenderComplete = true;
      // Enable sidebar animations after a short delay to prevent initial load animations
      setTimeout(() => {
        this.sidebarAnimationReady = true;
      }, 100);
    });
  }

  willUpdate(changedProperties: Map<string, unknown>) {
    // A phone has one list, the home (see handleToggleSidebar): the sidebar never opens over a
    // session, whatever opened it or localStorage says (2026-10-12).
    if (!this.sidebarCollapsed && isPhoneListLayout()) this.sidebarCollapsed = true;
    // "What's new" belongs to the session list: leaving it (a notification opening a
    // session, a 401 back to login) takes the sheet away instead of covering the new screen.
    if (
      isWhatsNewOpen() &&
      (this.currentView !== 'list' || this.selectedSessionId || !this.isAuthenticated)
    ) {
      closeWhatsNew();
    }
    // Update hasActiveOverlay whenever any overlay state changes
    if (
      changedProperties.has('showCreateModal') ||
      changedProperties.has('showTmuxModal') ||
      changedProperties.has('showSSHKeyManager') ||
      changedProperties.has('showSettings') ||
      changedProperties.has('showQuickSwitcher') ||
      changedProperties.has('showShortcutSheet')
    ) {
      // The ⌘K palette and the shortcut sheet count too: without them the session view's
      // keyboard handler sends palette typing to the live terminal (QA 2026-10-12).
      this.hasActiveOverlay =
        this.showCreateModal ||
        this.showTmuxModal ||
        this.showSSHKeyManager ||
        this.showSettings ||
        this.showQuickSwitcher ||
        this.showShortcutSheet;
    }

    // Add/remove body class based on current view to control animations
    if (changedProperties.has('currentView')) {
      if (this.currentView === 'session') {
        document.body.classList.add('in-session-view');
      } else {
        document.body.classList.remove('in-session-view');
      }
    }

    // Re-bind sidebar scroll lock when relevant state changes
    if (
      changedProperties.has('currentView') ||
      changedProperties.has('sidebarCollapsed') ||
      changedProperties.has('mediaState') ||
      changedProperties.has('sessions')
    ) {
      queueMicrotask(() => this.setupSidebarScrollLock());
    }
  }

  updated() {
    // The list is up: fetch the other views in idle time (utils/lazy-views.ts).
    if (this.initialLoadComplete && this.isAuthenticated) {
      preloadLazyViews(() => this.requestUpdate());
    }
    this.maybeScheduleWhatsNew();
    this.syncSidebarWidthVar();
    // The preview belongs to the session on screen.
    const panel = lazyViews.previewPanel.module;
    if (this.currentView !== 'session' && panel?.isPreviewPanelOpen()) panel.closePreviewPanel();
  }

  /**
   * `--sidebar-w` on <html>: how much of the left edge the expanded sessions sidebar (and its
   * 1 px resize handle) takes beside the session view, 0px when it is collapsed or opens over
   * it (phone layout). The touch session view is position: fixed and starts there: on a touch
   * iPad at 820 pt it sat at left: 0 and covered the expanded sidebar (2026-10-12).
   */
  private syncSidebarWidthVar() {
    const width = this.shouldShowResizeHandle ? `${this.sidebarWidth + 1}px` : '0px';
    const root = document.documentElement;
    if (root.style.getPropertyValue('--sidebar-w') !== width) {
      root.style.setProperty('--sidebar-w', width);
    }
  }

  /** The split panel inside a session (the preview view's "show beside the session"). */
  private showPreview(sessionId: string, port?: number, path?: string, mode?: 'split' | 'full') {
    const session = this.sessions.find((s) => s.id === sessionId);
    lazyViews.previewPanel.use((panel) =>
      panel.openPreviewPanel({
        sessionId,
        ports: (session?.previewPorts ?? []).map((entry) => entry.port),
        port,
        path,
        mode,
        authHeader: () => authClient.getAuthHeader(),
      })
    );
  }

  /**
   * Persistent previews (2026-10-03), refreshed with the session poll but at most every few
   * seconds (they change rarely); `force` after `ut open` or a row action.
   */
  private loadPreviews(force = false): Promise<void> {
    if (this.previewsLoad) {
      // A forced load (after a change) must not settle for one that started before it.
      return force ? this.previewsLoad.then(() => this.loadPreviews(true)) : this.previewsLoad;
    }
    if (!force && Date.now() - this.previewsLoadedAt < PREVIEWS_REFRESH_MS)
      return Promise.resolve();
    this.previewsLoad = fetchPreviews(authClient.getAuthHeader())
      .then((items) => {
        if (!items) return;
        this.previewsLoadedAt = Date.now();
        if (JSON.stringify(items) !== JSON.stringify(this.previews)) this.previews = items;
      })
      .finally(() => {
        this.previewsLoad = null;
      });
    return this.previewsLoad;
  }

  private handlePreviewsChanged = () => {
    void this.loadPreviews(true);
  };

  /**
   * A phone showing the session list, or the sidebar opened from a session: the places with
   * "On this Mac". Only then is it asked for (the server scans the Mac for each answer).
   */
  private showsMacSessions(): boolean {
    // A phone never shows the sidebar list over a session (see handleToggleSidebar).
    return isPhoneListLayout() && this.currentView === 'list';
  }

  /**
   * "On this Mac", asked at most every 4 s with the session poll while it shows, every 30 s while
   * the server has it off or doesn't have it; `force` (also past the server's 3 s cache) after
   * an open, a disconnect, a mode change or a settings save. A failed request keeps the last
   * list, until a minute of failures hides the section.
   */
  private loadMacSessions(force = false): Promise<void> {
    if (this.macSessionsLoad) {
      // A forced load (after a change) must not settle for one that started before it.
      return force
        ? this.macSessionsLoad.then(() => this.loadMacSessions(true))
        : this.macSessionsLoad;
    }
    const every = this.macSessionsOff ? MAC_SESSIONS_OFF_REFRESH_MS : MAC_SESSIONS_REFRESH_MS;
    if (!force && Date.now() - this.macSessionsAskedAt < every) return Promise.resolve();
    this.macSessionsAskedAt = Date.now();
    const generation = this.macSessionsGeneration;
    this.macSessionsLoad = fetchMacSessions(authClient.getAuthHeader(), { force })
      .then((response) => {
        if (generation !== this.macSessionsGeneration) return;
        this.macSessionsFailingSince = 0;
        this.macSessionsOff = !response.enabled;
        this.showMacSessions(response);
      })
      .catch(() => {
        if (generation !== this.macSessionsGeneration) return;
        const now = Date.now();
        if (!this.macSessionsFailingSince) this.macSessionsFailingSince = now;
        else if (now - this.macSessionsFailingSince >= MAC_SESSIONS_STALE_MS) {
          this.showMacSessions(null);
        }
      })
      .finally(() => {
        if (generation === this.macSessionsGeneration) this.macSessionsLoad = null;
      });
    return this.macSessionsLoad;
  }

  /** Only a list that says something new re-renders: each scan has a new `scannedAt`. */
  private showMacSessions(response: MacSessionsResponse | null) {
    const shown = JSON.stringify(response && { ...response, scannedAt: undefined });
    if (shown === this.macSessionsShown) return;
    this.macSessionsShown = shown;
    this.macSessions = response;
  }

  private resetMacSessions() {
    this.macSessionsGeneration++;
    this.macSessionsLoad = null;
    this.macSessionsAskedAt = 0;
    this.macSessionsOff = false;
    this.macSessionsFailingSince = 0;
    this.macSessionsShown = 'null';
    this.macSessions = null;
  }

  private handleMacSessionsChanged = () => {
    if (this.isAuthenticated && isPhoneListLayout()) void this.loadMacSessions(true);
  };

  /** A Mac agent's or tmux pane's conversation, read-only (its row, or the history). */
  private handleOpenMacSessionView = (e: CustomEvent<MacSessionViewDetail>) => {
    const detail = e.detail;
    if (detail?.chatId) {
      lazyViews.macSessionView.use((view) => view.openMacSessionView(detail));
    }
  };

  /**
   * "Share with phone" on a Mac agent's row or conversation sheet: its sheet plans, confirms
   * and follows the share; once it reopened through ut, its session opens here (it may not be
   * listed yet), on the dialog to answer when there is one.
   */
  private handleOpenMacShare = (e: CustomEvent<MacShareSheetDetail>) => {
    const detail = e.detail;
    if (!detail?.id) return;
    lazyViews.macShareSheet.use((sheet) => this.openMacShareSheet(sheet, detail));
  };

  private openMacShareSheet(
    sheet: typeof import('./components/mac-share-sheet.js'),
    detail: MacShareSheetDetail
  ) {
    sheet.openMacShareSheet(detail, {
      authHeader: () => authClient.getAuthHeader(),
      onShared: (sessionId, needs) => {
        lazyViews.macSessionView.module?.closeMacSessionView();
        announceMacSessionsChanged();
        if (needs) {
          const agent = MAC_AGENT_NAMES[detail.agent] ?? detail.agent;
          this.showSuccess(
            t(needs === 'trust' ? 'macShare.needs.trust' : 'macShare.needs.answer', { agent })
          );
        }
        preferPhoneChatMode();
        void this.waitForSessionAndSwitch(sessionId);
      },
    });
  }

  private handleOpenMacTmux = (e: CustomEvent<MacTmuxOpenDetail>) => {
    void this.openMacTmux(e.detail);
  };

  /**
   * "Open and control" from a conversation sheet or the history: the tmux session opens in a new
   * Untether session, shown once it is listed, or the one already attached to it is shown.
   */
  private async openMacTmux(detail: MacTmuxOpenDetail | undefined) {
    if (!detail?.id || this.macTmuxOpening.has(detail.id)) return;
    const { id } = detail;
    this.macTmuxOpening.add(id);
    const item = this.macSessions?.items.find((entry) => entry.id === id);
    // A conversation opens in the chat view, as a tmux row with an agent does.
    if (!item || macItemHasAgents(item)) preferPhoneChatMode();
    try {
      const result = await openMacSession(
        id,
        { mode: detail.mode ?? this.macSessions?.openMode ?? 'control' },
        authClient.getAuthHeader()
      );
      if (result.reused) {
        await this.handleNavigateToSession(
          new CustomEvent('navigate-to-session', { detail: { sessionId: result.sessionId } })
        );
      } else {
        await this.waitForSessionAndSwitch(result.sessionId);
      }
    } catch (error) {
      this.showError(macOpenErrorText(error));
      if (error instanceof MacSessionsApiError && error.code === 'gone') {
        void this.loadMacSessions(true);
      }
    } finally {
      this.macTmuxOpening.delete(id);
    }
  }

  /**
   * A preview's own full-screen view (/preview/<id>): its list row, a session's preview
   * chip, `ut open` on a screen showing that session, the push.
   *
   * Back goes where the user came from (2026-10-03, real iPhone): opened inside a session,
   * back to that session; from the list, a push or `ut open`, back to the list. `from` is
   * in the URL (a reload keeps it) and the entry is pushed, so Back is a real history step.
   */
  private openPreviewView(
    id: string,
    path = '/',
    options: { replace?: boolean; from?: string | null } = {}
  ) {
    const panel = lazyViews.previewPanel.module;
    if (panel?.isPreviewPanelOpen()) panel.closePreviewPanel();
    // Where the user is now: the list, a session, or somewhere Back can't simply return to.
    const here =
      this.currentView === 'list'
        ? null
        : this.currentView === 'session'
          ? this.selectedSessionId
          : undefined;
    const from =
      options.from !== undefined
        ? options.from
        : here !== undefined
          ? here
          : this.currentView === 'preview'
            ? (this.previewTarget?.from ?? null)
            : null;
    // Back is one history step only when the entry before this one is where Back goes.
    const backIsPrevious = here !== undefined && here === from;
    const page = path.startsWith('/') ? path : `/${path}`;
    this.previewTarget = { id, path: page, from };
    this.currentView = 'preview';
    const url = previewViewPath(id, page, from);
    if (`${window.location.pathname}${window.location.search}` !== url) {
      if (options.replace) {
        window.history.replaceState(window.history.state, '', url);
      } else {
        // The entry Back returns to, by key where the browser has keys (see handlePreviewBack).
        const fromKey = backIsPrevious ? navigationApi()?.currentEntry?.key : undefined;
        window.history.pushState(
          backIsPrevious ? { utPreviewBack: true, utPreviewFromKey: fromKey } : null,
          '',
          url
        );
        this.previewHistoryLength = window.history.length;
      }
    }
  }

  /**
   * "‹ Sesiones" / "‹ <session>": back to the entry we came from when we pushed the view, else
   * straight there. The previewed site's own pages are entries of the same history, in front
   * of the view's: one step back went back a page inside the preview instead of leaving it
   * (2026-10-03). So the entry is reached by its key (Navigation API, Safari 26+), or by one
   * step only while the preview added none, or else by opening the list or session anew.
   */
  private handlePreviewBack = (e: CustomEvent<{ sessionId: string | null }>) => {
    const sessionId = e.detail?.sessionId ?? null;
    const state = window.history.state as {
      utPreviewBack?: boolean;
      utPreviewFromKey?: string;
    } | null;
    if (state?.utPreviewBack) {
      const navigation = navigationApi();
      const key = state.utPreviewFromKey;
      if (navigation && key && navigation.entries().some((entry) => entry.key === key)) {
        navigation.traverseTo(key).finished.catch(() => this.leavePreview(sessionId));
        return;
      }
      if (window.history.length === this.previewHistoryLength) {
        window.history.back();
        return;
      }
    }
    this.leavePreview(sessionId);
  };

  /** Opens the session the preview came from, or the list. */
  private leavePreview(sessionId: string | null) {
    if (sessionId) {
      void this.handleNavigateToSession(
        new CustomEvent('navigate-to-session', { detail: { sessionId } })
      );
      return;
    }
    this.handleNavigateToList();
  }

  /** The saved preview on this port (that session's own first), fetching the list if needed. */
  private async previewForPort(port: number, sessionId?: string): Promise<PreviewItem | undefined> {
    const found = findPreviewByPort(this.previews, port, sessionId);
    if (found) return found;
    await this.loadPreviews(true);
    return findPreviewByPort(this.previews, port, sessionId);
  }

  /** A route into a preview: `/preview/<id>`. */
  private showPreviewRoute(route: PreviewRoute) {
    this.previewTarget = { id: route.id, path: route.path, from: route.from };
    this.currentView = 'preview';
    void this.loadPreviews(true);
  }

  private handleOpenPreview = (e: CustomEvent<{ sessionId?: string; port?: number }>) => {
    void this.openSessionPreview(e.detail?.sessionId, e.detail?.port);
  };

  /** A session's preview chip / ⋮ menu: its saved preview on that port, else ask for one. */
  private async openSessionPreview(sessionId?: string, requestedPort?: number) {
    if (!sessionId) return;
    const session = this.sessions.find((s) => s.id === sessionId);
    const port = requestedPort ?? session?.previewPorts?.[0]?.port;
    const knownId =
      session?.previewPorts?.find((entry) => entry.port === port)?.id ??
      (port ? findPreviewByPort(this.previews, port, sessionId)?.id : undefined);
    const item = knownId
      ? { id: knownId }
      : port
        ? await this.previewForPort(port, sessionId)
        : undefined;
    if (item) {
      this.openPreviewView(item.id);
      return;
    }
    // No dev server known yet: the panel asks for a port, inside the session.
    if (this.currentView === 'session' && this.selectedSessionId === sessionId) {
      this.showPreview(sessionId);
      return;
    }
    void this.handleNavigateToSession(
      new CustomEvent('navigate-to-session', { detail: { sessionId } })
    ).then(() => this.showPreview(sessionId));
  }

  /** A preview row: from the list (or the sidebar of the session on screen). */
  private handleOpenPreviewView = (e: CustomEvent<{ id?: string; path?: string }>) => {
    const { id, path } = e.detail ?? {};
    if (id) this.openPreviewView(id, path || '/');
  };

  private handlePreviewBackToSession = (e: CustomEvent<{ sessionId: string }>) => {
    void this.handleNavigateToSession(
      new CustomEvent('navigate-to-session', { detail: { sessionId: e.detail.sessionId } })
    );
  };

  private handlePreviewSplit = (
    e: CustomEvent<{ sessionId: string; port: number; path: string }>
  ) => {
    const { sessionId, port, path } = e.detail;
    void this.handleNavigateToSession(
      new CustomEvent('navigate-to-session', { detail: { sessionId } })
    ).then(() => this.showPreview(sessionId, port, path, 'split'));
  };

  private whatsNewTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Phones see the "What's new" sheet once per version, a moment after the session list first
   * shows: never on the login screen, over an open session, or over another sheet. If any of
   * that is in the way when the delay ends, the next update tries again.
   */
  private maybeScheduleWhatsNew() {
    if (this.whatsNewTimer || !this.whatsNewCanShow() || !shouldAutoShowWhatsNew()) return;
    this.whatsNewTimer = setTimeout(() => {
      this.whatsNewTimer = null;
      if (
        this.whatsNewCanShow() &&
        shouldAutoShowWhatsNew() &&
        !isWhatsNewOpen() &&
        !whatsNewBlocked()
      ) {
        openWhatsNew({ onlyNew: true });
      }
    }, WHATS_NEW_DELAY_MS);
  }

  private whatsNewCanShow(): boolean {
    return (
      this.isAuthenticated &&
      this.currentView === 'list' &&
      !this.selectedSessionId &&
      this.initialLoadComplete &&
      !this.loading &&
      !this.hasActiveOverlay
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopVersionWatch?.();
    this.stopVersionWatch = undefined;
    this.stopRotationWatch?.();
    this.stopRotationWatch = undefined;
    if (this.whatsNewTimer) clearTimeout(this.whatsNewTimer);
    // 2026-11-10: these kept running after the app left the DOM.
    if (this.attentionToastTimer) clearTimeout(this.attentionToastTimer);
    this.attentionToastTimer = null;
    if (this.errorTimeoutId !== null) clearTimeout(this.errorTimeoutId);
    this.errorTimeoutId = null;
    if (this.revealTaskTimer !== null) clearTimeout(this.revealTaskTimer);
    this.revealTaskTimer = null;
    this.clearKillRefreshTimers();
    this.removeEventListener('notification-action', this.handleNotificationAction as EventListener);
    window.removeEventListener('ut-open-preview', this.handleOpenPreview as EventListener);
    window.removeEventListener('ut-open-preview-view', this.handleOpenPreviewView as EventListener);
    window.removeEventListener(PREVIEWS_CHANGED_EVENT, this.handlePreviewsChanged);
    window.removeEventListener('ut-open-answer-sheet', this.handleOpenAnswerSheet as EventListener);
    window.removeEventListener('ut-open-task-confirm', this.handleOpenTaskConfirm);
    window.removeEventListener(SHOW_TASK_EVENT, this.handleShowTaskEvent);
    window.removeEventListener(MAC_SESSIONS_CHANGED_EVENT, this.handleMacSessionsChanged);
    window.removeEventListener(
      MAC_SESSION_VIEW_EVENT,
      this.handleOpenMacSessionView as EventListener
    );
    window.removeEventListener(MAC_TMUX_OPEN_EVENT, this.handleOpenMacTmux as EventListener);
    window.removeEventListener(MAC_SHARE_EVENT, this.handleOpenMacShare as EventListener);
    lazyViews.macShareSheet.module?.closeMacShareSheet();
    // Clean up routing listeners
    window.removeEventListener('popstate', this.handlePopState);
    // Clean up keyboard shortcuts
    this.teardownKeyboardShortcuts();
    // Clean up capture toggle listener
    document.removeEventListener('capture-toggled', this.handleCaptureToggled as EventListener);
    // Clean up auto refresh interval
    this.autoRefresh.stop();
    for (const unsubscribe of this.unsubscribeSessionEvents) unsubscribe();
    this.unsubscribeSessionEvents = [];
    this.unsubscribeTokenRejected?.();
    this.unsubscribeTokenRejected = null;
    // Clean up responsive observer
    if (this.responsiveUnsubscribe) {
      this.responsiveUnsubscribe();
    }
    // Clean up any active resize listeners
    this.cleanupResizeListeners();
    this.teardownSidebarScrollLock();
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    const isMacOS = navigator.platform.toLowerCase().includes('mac');

    if (this.handleAppShortcut(e)) return;

    // The palette and the shortcut sheet handle their own keys.
    if (this.showQuickSwitcher || this.showShortcutSheet) {
      return;
    }

    // Check if we're capturing and what the shortcut would do
    const checkCapturedShortcut = (): {
      captured: boolean;
      browserAction?: string;
      terminalAction?: string;
    } => {
      const key = e.key.toLowerCase();

      // Define what shortcuts we capture and their actions
      const capturedShortcuts: Record<
        string,
        { browser: string; terminal: string; check: () => boolean }
      > = {
        'mod+a': {
          browser: 'Select all',
          terminal: 'Line start',
          check: () => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'a',
        },
        'mod+e': {
          browser: 'Search/Extension',
          terminal: 'Line end',
          check: () => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'e',
        },
        'mod+w': {
          browser: 'Close tab',
          terminal: 'Delete word',
          check: () => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'w',
        },
        'mod+r': {
          browser: 'Reload',
          terminal: 'History search',
          check: () => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'r',
        },
        'mod+l': {
          browser: 'Address bar',
          terminal: 'Clear screen',
          check: () => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'l',
        },
        'mod+d': {
          browser: 'Bookmark',
          terminal: 'EOF/Exit',
          check: () => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'd',
        },
        'mod+f': {
          browser: 'Find',
          terminal: 'Forward char',
          check: () => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'f',
        },
        'mod+p': {
          browser: 'Print',
          terminal: 'Previous cmd',
          check: () => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'p',
        },
        'mod+u': {
          browser: 'View source',
          terminal: 'Delete to start',
          check: () => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'u',
        },
        'mod+k': {
          browser: 'Search bar',
          terminal: 'Delete to end',
          check: () => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'k',
        },
        'alt+d': {
          browser: 'Address bar',
          terminal: 'Delete word fwd',
          check: () => e.altKey && !e.ctrlKey && !e.metaKey && key === 'd',
        },
      };

      for (const config of Object.values(capturedShortcuts)) {
        if (config.check()) {
          return {
            captured: true,
            browserAction: config.browser,
            terminalAction: config.terminal,
          };
        }
      }

      return { captured: false };
    };

    // Always allow critical browser shortcuts
    if (isBrowserShortcut(e)) {
      return;
    }

    // In session view with capture active, check if we're capturing this shortcut
    // But don't capture shortcuts if the session has exited
    const isSessionExited = this.selectedSession?.status === 'exited';
    if (this.currentView === 'session' && this.keyboardCaptureActive && !isSessionExited) {
      const { captured, browserAction, terminalAction } = checkCapturedShortcut();
      if (captured) {
        // Dispatch event for indicator animation
        window.dispatchEvent(
          new CustomEvent('shortcut-captured', {
            detail: {
              shortcut: this.formatShortcut(e),
              browserAction,
              terminalAction,
            },
          })
        );
        // Don't prevent default - let terminal handle it
        // The terminal's input manager will capture these
      }
    }

    // Browser shortcut checking for non-session views
    const shouldAllowBrowserShortcut = (): boolean => {
      // If we're not in session view or capture is disabled, use the browser shortcut allow list
      if (this.currentView !== 'session' || !this.keyboardCaptureActive) {
        const key = e.key.toLowerCase();
        const hasModifier = e.ctrlKey || e.metaKey;
        const hasShift = e.shiftKey;
        const hasAlt = e.altKey;

        // Tab management shortcuts
        if (hasModifier && !hasShift && !hasAlt) {
          if (['t', 'w', 'r'].includes(key)) return true;
          if (/^[0-9]$/.test(key)) return true; // Include 0 for tab switching
          if (['l', 'p', 's', 'f', 'd', 'h', 'j'].includes(key)) return true;
        }

        // Ctrl/Cmd + Shift shortcuts
        if (hasModifier && hasShift && !hasAlt) {
          if (['t', 'r', 'n'].includes(key)) return true;
          if (key === 'delete') return true;
          if (key === 'tab') return true;
          if (!isMacOS && key === 'q') return true;
          if (isMacOS && key === 'a') return true;
        }

        // Ctrl/Cmd + Tab
        if (hasModifier && !hasShift && !hasAlt && key === 'tab') {
          return true;
        }

        // Function keys
        if (['f5', 'f6', 'f11'].includes(key)) return true;
      }

      return false;
    };

    // Check if this is a browser shortcut we should not intercept
    if (shouldAllowBrowserShortcut()) {
      return;
    }

    // Untether-specific shortcuts below this line

    // Ctrl+O to open the file browser (list view; ⌘O is an app shortcut above)
    if (e.ctrlKey && !e.metaKey && e.key === 'o' && this.currentView === 'list') {
      e.preventDefault();
      this.handleNavigateToFileBrowser();
      return;
    }

    // Ctrl+B toggles the sidebar off the Mac (⌘B is an app shortcut above)
    if (e.ctrlKey && !e.metaKey && !isMacOS && e.key === 'b') {
      e.preventDefault();
      this.handleToggleSidebar();
      return;
    }

    // Handle Escape to close the session and return to list view. Not while a sheet was
    // open when the key went down: 2026-11-10, Escape on Settings closed it and ALSO left
    // the session (Settings listens on document and runs before this window handler).
    if (
      e.key === 'Escape' &&
      (this.currentView === 'session' || this.currentView === 'file-browser') &&
      !this.escapeStartedOverOverlay
    ) {
      e.preventDefault();
      this.handleNavigateToList();
      return;
    }
  };

  /**
   * Untether's shortcuts (design spec 5.4, 2026-10-12; utils/browser-shortcuts.ts
   * matchAppShortcut): ⌘K palette, ⌘, settings, ⌘O files, ⌘B sidebar, ⌘1–9 session N,
   * ⇧⌘N new session, '?' shortcut sheet. Returns true when the key was ours.
   */
  private handleAppShortcut(e: KeyboardEvent): boolean {
    if (!this.isAuthenticated || e.isComposing) return false;
    if (this.currentView === 'auth') return false;
    // Conversar is a full-screen dialog of its own: no app shortcut acts behind it.
    if (document.querySelector('copilot-sheet')) return false;
    const shortcut = matchAppShortcut(e);
    if (!shortcut) return false;
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    // Another dialog (settings, create, tmux…) is on top: only ⌘K stays live, to toggle.
    const dialogOpen =
      this.showSettings || this.showCreateModal || this.showTmuxModal || this.showSSHKeyManager;
    switch (shortcut.kind) {
      case 'palette':
        take();
        this.showShortcutSheet = false;
        this.showQuickSwitcher = !this.showQuickSwitcher;
        return true;
      case 'help': {
        // '?' is a character: only where nothing takes text (never in the terminal).
        if (this.currentView !== 'list' || dialogOpen || this.showQuickSwitcher) return false;
        if (isEditableTarget(e.target, e)) return false;
        take();
        this.showShortcutSheet = !this.showShortcutSheet;
        return true;
      }
      default:
        break;
    }
    if (dialogOpen || this.showQuickSwitcher) return false;
    switch (shortcut.kind) {
      case 'settings':
        take();
        this.showShortcutSheet = false;
        this.handleOpenSettings();
        return true;
      case 'files':
        if (this.currentView !== 'list' && this.currentView !== 'session') return false;
        take();
        this.showShortcutSheet = false;
        this.handleNavigateToFileBrowser(
          this.currentView === 'session' ? (this.selectedSessionId ?? undefined) : undefined
        );
        return true;
      case 'sidebar':
        if (this.currentView !== 'session') return false;
        take();
        this.handleToggleSidebar();
        return true;
      case 'new-session':
        take();
        this.showShortcutSheet = false;
        this.handleCreateSession();
        return true;
      case 'switch': {
        if (this.currentView !== 'list' && this.currentView !== 'session') return false;
        // Same order as the sidebar's numbers (grouped by repo, then activity), not API order.
        const target = this.numberedSessions()[shortcut.index];
        take();
        if (target) {
          logger.log(`Switching to session ${shortcut.index + 1}: ${target.name}`);
          this.handleNavigateToSession(
            new CustomEvent('navigate-to-session', { detail: { sessionId: target.id } })
          );
        }
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Running sessions in the order the sidebar numbers them. Reads the rendered rows so ⌘N
   * always matches the badge the user sees (QA 2026-10-12: ⌘2 opened the API's 2nd session);
   * falls back to API order when the sidebar isn't on screen.
   */
  private numberedSessions(): Session[] {
    const cards = Array.from(
      this.querySelectorAll<HTMLElement & { session?: Session; sessionNumber?: number }>(
        'session-list compact-session-card'
      )
    )
      .filter((card) => card.session && card.sessionNumber)
      .sort((a, b) => (a.sessionNumber ?? 0) - (b.sessionNumber ?? 0));
    if (cards.length) return cards.map((card) => card.session as Session);
    return this.sessions.filter((session) => session.status === 'running');
  }

  /** body.ut-cmd-held while ⌘ is down: the sidebar shows its ⌘1–9 numbers then. */
  private handleMetaKey = (e: KeyboardEvent) => {
    const held =
      e.type === 'keydown' ? e.key === 'Meta' || e.metaKey : e.metaKey && e.key !== 'Meta';
    document.body.classList.toggle('ut-cmd-held', held);
  };

  /** Whether a sheet or dialog was open when Escape went down (captured before any handler closes it). */
  private escapeStartedOverOverlay = false;

  private captureEscapeOverlay = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    this.escapeStartedOverOverlay =
      this.hasActiveOverlay ||
      this.showCreateModal ||
      isWhatsNewOpen() ||
      !!document.querySelector('copilot-sheet');
  };

  private clearMetaHeld = () => {
    document.body.classList.remove('ut-cmd-held');
  };

  private setupKeyboardShortcuts() {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keydown', this.handleMetaKey, true);
    window.addEventListener('keydown', this.captureEscapeOverlay, true);
    window.addEventListener('keyup', this.handleMetaKey, true);
    window.addEventListener('blur', this.clearMetaHeld);
    document.addEventListener('visibilitychange', this.clearMetaHeld);
  }

  private teardownKeyboardShortcuts() {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keydown', this.handleMetaKey, true);
    window.removeEventListener('keydown', this.captureEscapeOverlay, true);
    window.removeEventListener('keyup', this.handleMetaKey, true);
    window.removeEventListener('blur', this.clearMetaHeld);
    document.removeEventListener('visibilitychange', this.clearMetaHeld);
    this.clearMetaHeld();
  }

  /** A row of the ⌘K palette's Actions section. */
  private handlePaletteAction = (e: CustomEvent<{ action: PaletteAction }>) => {
    this.showQuickSwitcher = false;
    switch (e.detail?.action) {
      case 'new-session':
        this.handleCreateSession();
        break;
      case 'settings':
        this.handleOpenSettings();
        break;
      case 'files':
        this.handleNavigateToFileBrowser();
        break;
      case 'theme': {
        if (lockedThemeMode()) break;
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        const theme = dark ? 'light' : 'dark';
        applyThemeMode(theme);
        window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme } }));
        break;
      }
      case 'history':
        this.handleOpenHistory();
        break;
      case 'kill-all':
        void this.handleKillAll();
        break;
    }
  };

  /**
   * A quick start picked in the palette: a session runs it at once, in the folder of the
   * session on screen, else in the server's repository folder.
   */
  private handlePaletteQuickStart = async (e: CustomEvent<{ command: string }>) => {
    this.showQuickSwitcher = false;
    const command = parseCommand(e.detail?.command?.trim() ?? '');
    if (!command.length) return;
    try {
      const workingDir =
        (this.currentView === 'session' ? this.selectedSession?.workingDir : undefined) ||
        (await serverConfigService.getRepositoryBasePath()) ||
        '~';
      const result = await new SessionService(authClient).createSession({
        command,
        workingDir,
      });
      await this.waitForSessionAndSwitch(result.sessionId);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  };

  private unsubscribeTokenRejected: (() => void) | null = null;

  private async initializeApp() {
    logger.log('🚀 initializeApp() started');

    // The token check made as the page loads can answer after the stored login was taken as
    // good (authClient.onTokenRejected); loginExpired does nothing on the login screen.
    this.unsubscribeTokenRejected?.();
    this.unsubscribeTokenRejected = authClient.onTokenRejected(() => this.loginExpired());

    // First check authentication
    await this.checkAuthenticationStatus();

    logger.log('✅ checkAuthenticationStatus() completed', {
      isAuthenticated: this.isAuthenticated,
      sessionCount: this.sessions.length,
      currentView: this.currentView,
      initialLoadComplete: this.initialLoadComplete,
    });

    // Then setup routing after auth is determined and sessions are loaded
    // For session routes, this ensures sessions are already loaded before routing
    this.setupRouting();

    logger.log('✅ setupRouting() completed');
  }

  private async checkAuthenticationStatus() {
    // Check if no-auth is enabled first
    try {
      const authConfig = await fetchAuthConfig();
      if (authConfig) {
        logger.log('🔧 Auth config:', authConfig);

        if (authConfig.noAuth) {
          logger.log('🔓 No auth required, bypassing authentication');
          this.isAuthenticated = true;
          this.currentView = 'list';
          await this.initializeServices();
          await this.loadSessions(); // Wait for sessions to load
          this.startAutoRefresh();
          this.initialLoadComplete = true;
          return;
        }

        // Check if user is authenticated via Tailscale
        if (authConfig.tailscaleAuth && authConfig.authenticatedUser) {
          logger.log('🔒 Authenticated via Tailscale:', authConfig.authenticatedUser);

          // Fetch JWT token for WebSocket authentication
          try {
            logger.log('🎟️ Fetching WebSocket token for Tailscale user...');
            const tokenResponse = await fetch('/api/auth/tailscale-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            });

            if (tokenResponse.ok) {
              const tokenData = await tokenResponse.json();
              if (tokenData?.token && authConfig.authenticatedUser) {
                // Store token and user data for WebSocket connections
                authClient.setCurrentUserFromToken(
                  authConfig.authenticatedUser,
                  tokenData.token,
                  'tailscale'
                );
                logger.log('✅ WebSocket token stored for Tailscale user');
              } else {
                logger.warn('⚠️ Tailscale token response missing required data');
              }
            } else {
              logger.warn('⚠️ Failed to fetch WebSocket token, sessions may not load properly');
            }
          } catch (tokenError) {
            logger.warn('⚠️ Error fetching WebSocket token:', tokenError);
          }

          this.isAuthenticated = true;
          this.currentView = 'list';
          await this.initializeServices();
          await this.loadSessions(); // Wait for sessions to load
          this.startAutoRefresh();
          this.initialLoadComplete = true;
          return;
        }
      }
    } catch (error) {
      logger.warn('⚠️ Could not fetch auth config:', error);
    }

    this.isAuthenticated = authClient.isAuthenticated();
    logger.log('🔐 Authentication status:', this.isAuthenticated);

    if (this.isAuthenticated) {
      this.currentView = 'list';
      await this.initializeServices();
      await this.loadSessions(); // Wait for sessions to load
      this.startAutoRefresh();
      this.initialLoadComplete = true;
    } else {
      this.currentView = 'auth';
    }
  }

  private async handleAuthSuccess() {
    logger.log('✅ Authentication successful');

    // If already authenticated and past the login screen (e.g. no-auth mode), nothing to do
    if (this.isAuthenticated && this.currentView !== 'auth') {
      logger.debug('Already authenticated, skipping re-initialization');
      return;
    }

    // 2026-10-02: after a 401 (expired token, or a server that started requiring auth while
    // the page was open) handleLogout shows the login screen but services stay initialized.
    // Bailing out on servicesInitialized left the user on the login screen until a reload.
    const reLogin = this.servicesInitialized;
    this.isAuthenticated = true;
    // The list shows before the services and the first /api/sessions are done: without this
    // it said "Nothing running" for seconds right after logging in (2026-10-03, QA on an
    // iPhone 16), as if the sessions were gone.
    if (this.sessions.length === 0) this.loading = true;
    this.currentView = 'list';
    await this.initializeServices();
    // The socket last connected with the old (or no) token: reconnect with the new one.
    if (reLogin) terminalSocketClient.forceReconnect();
    await this.loadSessions();
    this.startAutoRefresh();
    this.initialLoadComplete = true;

    // Check if there was a session ID in the URL that we should navigate to
    const url = new URL(window.location.href);
    const pathParts = url.pathname.split('/').filter(Boolean);

    const previewRoute = parsePreviewViewUrl(url.pathname, url.search);
    if (previewRoute) {
      this.showPreviewRoute(previewRoute);
      return;
    }

    // Check for /session/:id pattern
    if (pathParts.length === 2 && pathParts[0] === 'session') {
      const sessionId = pathParts[1];
      logger.log(`Navigating to session ${sessionId} from URL after auth`);
      this.selectedSessionId = sessionId;
      this.sessionLoadingState = 'idle'; // Reset loading state for new session
      this.currentView = 'session';
    }
    // A push tapped while signed out (/?confirm=<id>, /?task=<id>): act on it now.
    this.handleDeepLinkParams(url);
  }

  /**
   * One-shot deep links from a push (sw-notification-click.ts): `?confirm=<id>` opens the
   * confirm sheet over whatever the URL shows, `?task=<id>` shows the task's row. The
   * parameters go so a reload or Back doesn't act again. Also run right after logging in: a
   * push tapped while signed out lands on the login screen with the parameter still there
   * (2026-10-20: the confirm sheet never came up after logging in).
   */
  private handleDeepLinkParams(url = new URL(window.location.href)) {
    const confirmId = url.searchParams.get('confirm');
    const taskId = url.searchParams.get('task');
    if (!confirmId && !taskId) return;
    url.searchParams.delete('confirm');
    url.searchParams.delete('task');
    window.history.replaceState(window.history.state, '', url.toString());
    if (confirmId) this.showTaskConfirmSheet(confirmId);
    if (taskId) this.showTask(taskId);
  }

  /** How long a task push waits for its row to show up in the list (tasks load async). */
  private static readonly REVEAL_TASK_WAIT_MS = 8000;
  private revealTaskTimer: number | null = null;

  /**
   * A task's push: its row (task-row in the list, with Fusionar / Descartar) scrolled into
   * view and glowing. On a phone the session on screen gives way to the list; on a desktop
   * the sidebar list stays and only shows the row.
   */
  private showTask(taskId: string) {
    if (this.revealTaskTimer !== null) {
      clearTimeout(this.revealTaskTimer);
      this.revealTaskTimer = null;
    }
    const selector = `task-row[data-task="${CSS.escape(taskId)}"]`;
    const findRow = () =>
      this.querySelector<HTMLElement & { reveal?: () => void }>(selector) ??
      document.querySelector<HTMLElement & { reveal?: () => void }>(selector);
    if (!findRow() && this.currentView !== 'list' && this.currentView !== 'auth') {
      this.handleNavigateToList();
    }
    const deadline = Date.now() + UntetherApp.REVEAL_TASK_WAIT_MS;
    const attempt = () => {
      this.revealTaskTimer = null;
      const row = findRow();
      if (row?.reveal) {
        row.reveal();
        return;
      }
      // Not on screen: the list opens what hides it ("Hechas", a search), then it is tried again.
      window.dispatchEvent(new CustomEvent(TASK_UNFOLD_EVENT, { detail: { taskId } }));
      if (Date.now() < deadline) this.revealTaskTimer = window.setTimeout(attempt, 250);
    };
    this.revealTaskTimer = window.setTimeout(attempt, 0);
  }

  private servicesInitialized = false;

  private async initializeServices() {
    if (this.servicesInitialized) {
      logger.debug('Services already initialized, skipping');
      return;
    }

    logger.log('🚀 Initializing services...');
    try {
      // Initialize buffer subscription service for WebSocket connections
      await terminalSocketClient.initialize();
      // The socket's token was refused (close 4401): back to the login, no retry loop.
      terminalSocketClient.onTokenRejected(() => this.loginExpired());
      serverEventService.initialize();
      loadAvatarIcons();
      // The server's default style, when this device has no choice of its own.
      void serverConfigService
        .loadConfig()
        .then((config) => setServerDefaultLook(config.look))
        .catch(() => {});

      // Push notifications set themselves up in the background: they wait for the service
      // worker (navigator.serviceWorker.ready, the push subscription), which can take long or
      // never come, and the session list must not wait for them. 2026-10-03: in the home-screen
      // app the list stayed on "Loading sessions…" after logging in, behind that wait.
      logger.log('Initializing push notification service...');
      // The service worker shows this page (in the user's language) when the Mac is unreachable.
      // Only the Cache API: it never waits for push or the service worker.
      installOfflinePage();
      // Off unless this device keeps it on or the address asks (?kbdebug=1).
      inputDiagnostics.start();
      void pushNotificationService.initialize().then(() => {
        logger.log('Push notification initialization complete:', {
          isSupported: pushNotificationService.isSupported(),
          isSecureContext: window.isSecureContext,
          location: window.location.hostname,
          protocol: window.location.protocol,
        });
      });

      this.servicesInitialized = true;
      logger.log('✅ Services initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize services:', error);
      // Don't fail the whole app if services fail to initialize
      // These are optional features
    }
  }

  /** A logout under way: a second one (a 401 poll and the socket's 4401 together) waits. */
  private loggingOut = false;

  /** The server refused the login (a 401, the socket's 4401): say so once, back to the login. */
  private loginExpired() {
    if (!this.isAuthenticated || this.loggingOut) return;
    this.showError(t('toast.loginExpired'));
    void this.handleLogout();
  }

  private async handleLogout() {
    if (this.loggingOut) return;
    this.loggingOut = true;
    try {
      await this.logOut();
    } finally {
      this.loggingOut = false;
    }
  }

  private async logOut() {
    logger.log('👋 Logging out');
    closeWhatsNew();
    lazyViews.macSessionView.module?.closeMacSessionView();
    this.resetMacSessions();
    this.clearKillRefreshTimers();
    this.recentlyKilled.clear();
    this.recentlyCleared.clear();
    // 2026-10-20: the poller and the session-event subscriptions kept running behind the
    // login screen (401s every poll). A re-login starts them again (startAutoRefresh).
    this.autoRefresh.stop();
    for (const unsubscribe of this.unsubscribeSessionEvents) unsubscribe();
    this.unsubscribeSessionEvents = [];
    if (this.revealTaskTimer !== null) {
      clearTimeout(this.revealTaskTimer);
      this.revealTaskTimer = null;
    }
    lazyViews.taskConfirmSheet.module?.closeTaskConfirmSheet();
    // The socket carried the old token: close it; the re-login connects with the new one.
    terminalSocketClient.disconnect();
    await authClient.logout();
    this.reconnecting = false;
    this.loadFailures = 0;
    this.isAuthenticated = false;
    this.currentView = 'auth';
    this.sessions = [];
  }

  private handleShowSSHKeyManager() {
    this.showSSHKeyManager = true;
  }

  private handleCloseSSHKeyManager() {
    this.showSSHKeyManager = false;
  }

  /**
   * Errors and confirmations go to the one toast stack (utils/action-toast.ts, design spec
   * 5.4, 2026-10-12); errorMessage keeps the error's text for its timeout (tests read it).
   */
  private showError(message: string) {
    if (this.errorTimeoutId !== null) {
      clearTimeout(this.errorTimeoutId);
      this.errorTimeoutId = null;
    }
    this.errorMessage = message;
    announce(message);
    toast({ kind: 'error', text: message, timeoutMs: TIMING.ERROR_MESSAGE_TIMEOUT });
    this.errorTimeoutId = window.setTimeout(() => {
      this.errorMessage = '';
      this.errorTimeoutId = null;
    }, TIMING.ERROR_MESSAGE_TIMEOUT);
  }

  private showSuccess(message: string) {
    announce(message);
    toast({ kind: 'success', text: message, timeoutMs: TIMING.SUCCESS_MESSAGE_TIMEOUT });
  }

  private clearError() {
    // Only clear if there's no active timeout
    if (this.errorTimeoutId === null) {
      this.errorMessage = '';
    }
  }

  private loadSessionsInFlight: Promise<boolean> | null = null;
  private loadSessionsQueued: Promise<boolean> | null = null;

  /**
   * One /api/sessions request at a time. A caller arriving while one is in flight gets a
   * single follow-up load (its data may predate what the caller just did, e.g. a kill).
   */
  private loadSessions(): Promise<boolean> {
    if (!this.loadSessionsInFlight) {
      this.loadSessionsInFlight = this.performLoadSessions().finally(() => {
        this.loadSessionsInFlight = null;
      });
      return this.loadSessionsInFlight;
    }
    if (!this.loadSessionsQueued) {
      this.loadSessionsQueued = this.loadSessionsInFlight.then(() => {
        this.loadSessionsQueued = null;
        return this.loadSessions();
      });
    }
    return this.loadSessionsQueued;
  }

  private lastUnreadKey = '';

  /** Resolves `false` when the list came back identical to what is shown. */
  private async performLoadSessions(): Promise<boolean> {
    let changed = true;
    // Only show loading state on initial load, not on refreshes
    if (!this.initialLoadComplete) {
      this.loading = true;
    }

    const performLoad = async () => {
      try {
        // First load: the previews shown above the sessions are asked for alongside them, not
        // after them (one round trip less before the list shows, 2026-10-04).
        if (!this.initialLoadComplete) void this.loadPreviews();
        const headers = authClient.getAuthHeader();
        // (2026-10-20 review: no timeout, so one hung request froze the poll for good.)
        // `lang`: the cards' one line about each agent comes in the user's language.
        const response = await fetch(`/api/sessions?lang=${encodeURIComponent(getLocale())}`, {
          headers,
          signal: AbortSignal.timeout(SESSIONS_FETCH_TIMEOUT_MS),
        });
        if (response.ok) {
          this.loadFailures = 0;
          this.reconnecting = false;
          this.everLoaded = true;
          const newSessions = (await response.json()) as Session[];

          // Preserve Git information and reuse existing session objects when possible
          // This prevents unnecessary re-renders by maintaining object references
          const updatedSessions = this.applyRecentKills(newSessions).map((newSession) => {
            const existingSession = this.sessions.find((s) => s.id === newSession.id);

            if (existingSession) {
              // Check if the session has actually changed
              const hasChanges =
                existingSession.status !== newSession.status ||
                existingSession.name !== newSession.name ||
                existingSession.workingDir !== newSession.workingDir ||
                existingSession.exitCode !== newSession.exitCode ||
                existingSession.claudeStatus?.status !== newSession.claudeStatus?.status ||
                // Busy for a turn or only for background agents: the row says which.
                existingSession.claudeStatus?.waitingForBackground !==
                  newSession.claudeStatus?.waitingForBackground ||
                existingSession.claudeStatus?.waitingFor !== newSession.claudeStatus?.waitingFor ||
                // A second identical prompt only differs in when it started (unread, toast).
                existingSession.claudeStatus?.since !== newSession.claudeStatus?.since ||
                // The preview trails the status by a poll or two (transcript read throttle):
                // without these the list kept showing Claude's previous message.
                existingSession.claudeStatus?.title !== newSession.claudeStatus?.title ||
                existingSession.claudeStatus?.preview?.text !==
                  newSession.claudeStatus?.preview?.text ||
                JSON.stringify(existingSession.claudeStatus?.choices) !==
                  JSON.stringify(newSession.claudeStatus?.choices) ||
                // Codex's own state (its rollout): the row's dot and line follow it.
                JSON.stringify(existingSession.agentStatus) !==
                  JSON.stringify(newSession.agentStatus) ||
                // Live activity ("Editing app.ts"): each new step has its own start time.
                JSON.stringify(existingSession.claudeStatus?.activity) !==
                  JSON.stringify(newSession.claudeStatus?.activity) ||
                existingSession.claudeTitle !== newSession.claudeTitle ||
                existingSession.userTitle !== newSession.userTitle ||
                existingSession.codexTitle !== newSession.codexTitle ||
                existingSession.codexActive !== newSession.codexActive ||
                existingSession.geminiTitle !== newSession.geminiTitle ||
                existingSession.geminiActive !== newSession.geminiActive ||
                existingSession.claudeResumable !== newSession.claudeResumable ||
                existingSession.codexResumable !== newSession.codexResumable ||
                existingSession.codexThreadId !== newSession.codexThreadId ||
                existingSession.claudeSessionId !== newSession.claudeSessionId ||
                // The provider mark of a Claude found in a terminal (its row's badge).
                existingSession.terminalClaude?.detectedProvider?.id !==
                  newSession.terminalClaude?.detectedProvider?.id ||
                // The project it works in now: its group on the home.
                existingSession.workDir !== newSession.workDir ||
                existingSession.workRepoPath !== newSession.workRepoPath ||
                // The group the user anchored it to (its menu).
                JSON.stringify(existingSession.groupPin) !== JSON.stringify(newSession.groupPin) ||
                existingSession.muted !== newSession.muted ||
                // Where the phone lists it (a terminal window on the Mac), and whether a tmux
                // session opened here only watches.
                JSON.stringify(existingSession.macWindow) !==
                  JSON.stringify(newSession.macWindow) ||
                JSON.stringify(existingSession.multiplexer) !==
                  JSON.stringify(newSession.multiplexer) ||
                // Shell rows: last output line (server re-reads it at most every 2 s).
                existingSession.lastLine !== newSession.lastLine ||
                // The cards' one line about what the agent does (agent-explain.ts).
                existingSession.explain?.text !== newSession.explain?.text ||
                // Check if Git info has been added in the new data
                (!existingSession.gitRepoPath && newSession.gitRepoPath) ||
                // Don't check Git counts here - they are updated by git-status-badge component
                // and we want to preserve those updates, not trigger re-renders
                false;

              if (!hasChanges) {
                // No changes - return the existing object reference
                return existingSession;
              }

              // Changed: always a NEW object, keeping the Git info the badge filled in when
              // the server didn't send it. Mutating the old object in place kept the same
              // reference, so rows/cards holding it never re-rendered: a killed session in a
              // git repo kept showing as running (2026-10-02, user report).
              if (existingSession.gitRepoPath && !newSession.gitRepoPath) {
                const git = Object.fromEntries(
                  Object.entries(existingSession).filter(([key]) => key.startsWith('git'))
                );
                return { ...newSession, ...git } as Session;
              }
            }

            // If newSession has Git data, ensure we create a complete session object
            return newSession;
          });

          this.announceClaudeTransitions(updatedSessions);
          this.clearNotificationsOfEndedSessions(updatedSessions);

          // Unread conversations: the one on screen is read; the icon badge counts the rest.
          // The preview trails the status by a poll or two: keep marking the session you just
          // left as read for a few seconds, or an answer you saw comes back as unread.
          if (this.currentView === 'session' && this.selectedSessionId) {
            this.lastViewed = { id: this.selectedSessionId, at: Date.now() };
            // Its notifications are read too: take them off the lock screen.
            if (document.visibilityState === 'visible') {
              void pushNotificationService.clearSessionNotifications(this.selectedSessionId);
            }
          }
          const recent =
            this.lastViewed && Date.now() - this.lastViewed.at < 6000 ? this.lastViewed.id : null;
          const viewing = updatedSessions.find((session) => session.id === recent);
          if (viewing) markSeen(viewing);
          pruneSeen(updatedSessions);
          // Not on an empty list: a server that just restarted (or a partial poll) answers []
          // for a moment, and that wiped every pin on this device.
          if (updatedSessions.length > 0) {
            // A pinned session resumed as a new one hands its pin over (the list reloads them).
            if (prunePinned(updatedSessions)) {
              window.dispatchEvent(new CustomEvent(PINS_CHANGED_EVENT));
            }
          }
          const unread = updatedSessions.filter((session) => isUnread(session));
          // Muted sessions keep their (quiet) unread dot but don't count on the icon.
          updateAppBadge(unread.filter((session) => !session.muted).length);

          // Re-render only when something shown changed: a new array every poll re-rendered
          // the whole list once a second on a phone that may sit on it for hours. Rows keep
          // their object when unchanged, so identical references mean identical data (an
          // in-place merge above counts as a change).
          const unreadKey = unread.map((session) => session.id).join(',');
          changed =
            unreadKey !== this.lastUnreadKey ||
            updatedSessions.length !== this.sessions.length ||
            updatedSessions.some((session, index) => session !== this.sessions[index]);
          this.lastUnreadKey = unreadKey;
          // First load: the previews sit above the sessions, and coming a moment later they
          // pushed every row down under the finger: a tap meant for a session opened a
          // preview (2026-10-03). Show both at once, waiting a little for the previews.
          if (!this.initialLoadComplete) {
            await Promise.race([
              this.loadPreviews(),
              new Promise((resolve) => setTimeout(resolve, FIRST_PREVIEWS_WAIT_MS)),
            ]);
          }
          if (changed) {
            this.sessions = [...updatedSessions];
            // Clear session cache when sessions update
            this._cachedSelectedSession = undefined;
            this._cachedSelectedSessionId = null;
          }
          this.clearError();

          // Page title: the session on screen (● while Claude waits), else the count.
          if (this.currentView === 'list') {
            const sessionCount = this.sessions.length;
            titleManager.setListTitle(sessionCount);
          } else if (this.currentView === 'session') {
            const shown = this.sessions.find((s) => s.id === this.selectedSessionId);
            if (shown) {
              titleManager.setSessionTitle(
                shown.userTitle || shown.name || shown.command.join(' '),
                { waiting: deriveSessionStatus(shown) === 'needs-input' }
              );
            }
          }

          // Handle session loading state tracking
          if (this.selectedSessionId && this.currentView === 'session') {
            const sessionExists = this.sessions.find((s) => s.id === this.selectedSessionId);

            if (sessionExists) {
              this.missingSince = null;
              // Session found - mark as loaded
              if (this.sessionLoadingState !== 'loaded') {
                this.sessionLoadingState = 'loaded';
                logger.debug(`Session ${this.selectedSessionId} found and loaded`);
              }
            } else if (this.endedHereRecently(this.selectedSessionId)) {
              // The user ended it from this page: back to the list, nothing to report.
              this.sessionLoadingState = 'not-found';
              this.handleNavigateToList();
            } else if (this.sessionLoadingState !== 'not-found') {
              // Missing, whether it was shown already or is only being opened (a URL, Back): right
              // after a server restart a shielded session is back only once it is re-attached, a
              // few seconds later (2026-10-20: "No se encontró la sesión" for a live task
              // session; review: the same for one opened by URL or not listed yet).
              if (this.missingSince?.id !== this.selectedSessionId) {
                this.missingSince = { id: this.selectedSessionId, at: Date.now() };
              }
              // Not gone yet while in its grace: looked at again on the next refresh.
              const inGrace = Date.now() - this.missingSince.at < SESSION_MISSING_GRACE_MS;
              if (inGrace) {
                if (this.sessionLoadingState === 'idle') this.sessionLoadingState = 'loading';
              } else {
                this.missingSince = null;
                logger.warn(
                  `Session ${this.selectedSessionId} missing from the list (state ${this.sessionLoadingState})`
                );
                this.sessionLoadingState = 'not-found';
                this.showError(t('toast.sessionNotFound', { id: this.selectedSessionId }));
                this.handleNavigateToList();
              }
            }
          }
        } else if (response.status === 401 && (await isTokenRejection(response))) {
          // The login expired: told as for the socket's 4401 (2026-10-20 verify: the login
          // screen came back with no word why). Only for the server's token_invalid: a 401
          // from a proxy or a restarting server logged the phone out (2026-10-20 review).
          this.loginExpired();
          return;
        } else {
          changed = false;
          this.noteLoadFailure();
        }
      } catch (error) {
        logger.error('error loading sessions:', error);
        changed = false;
        this.noteLoadFailure();
      } finally {
        this.loading = false;
        this.initialLoadComplete = true;
      }
    };

    // Use view transition for initial load with fade effect
    if (
      !this.initialLoadComplete &&
      !this.isTestEnvironment() &&
      'startViewTransition' in document &&
      typeof document.startViewTransition === 'function'
    ) {
      logger.log('🎨 Using View Transition API for initial session load');
      // Add initial-load class for specific CSS handling
      document.body.classList.add('initial-session-load');

      const transition = document.startViewTransition(async () => {
        await performLoad();
        await this.updateComplete;
      });

      // Log when transition is ready
      transition.ready
        .then(() => {
          logger.log('✨ Initial load view transition ready');
        })
        .catch((err) => {
          // This is expected to fail in browsers that don't support View Transitions
          logger.debug('View transition not supported or failed (this is normal):', err);
        });

      // Clean up the class after transition completes
      transition.finished
        .finally(() => {
          logger.log('✅ Initial load view transition finished');
          document.body.classList.remove('initial-session-load');
        })
        .catch(() => {
          // Ignore errors, just make sure we clean up
          document.body.classList.remove('initial-session-load');
        });
    } else {
      // Regular load without transition
      if (!this.initialLoadComplete) {
        logger.log('🎨 Using CSS animation fallback for initial load');
        document.body.classList.add('initial-session-load');
        await performLoad();
        // Remove class after animation completes
        setTimeout(() => {
          document.body.classList.remove('initial-session-load');
        }, 600);
      } else {
        await performLoad();
      }
    }
    return changed;
  }

  /**
   * Tell the user when Claude Code finishes or starts waiting in a session they are not
   * looking at (system push is unavailable in Chrome on iOS). Tapping the toast opens it.
   */
  private announceClaudeTransitions(sessions: Session[]) {
    const firstSnapshot = this.previousClaudeStatus.size === 0 && !this.initialLoadComplete;
    for (const session of sessions) {
      const claude = session.status === 'running' ? session.claudeStatus : undefined;
      // Codex's own state (its rollout): the same toasts, its name in them.
      const codex = session.status === 'running' && !claude ? session.agentStatus : undefined;
      // Busy only for background agents is its own state: the reply is over.
      const now = isBackgroundWait(claude) ? 'busy:background' : (claude?.status ?? codex?.status);
      const before = this.previousClaudeStatus.get(session.id);
      if (now) this.previousClaudeStatus.set(session.id, now);
      else this.previousClaudeStatus.delete(session.id);
      // Only announce real transitions of a session already known to be running Claude.
      if (firstSnapshot || !now || !before || now === before) continue;

      const viewing =
        (this.currentView === 'session' && this.selectedSessionId === session.id) ||
        window.location.pathname === `/session/${session.id}`;
      if (viewing || session.muted) continue;
      // The user's or the conversation's title tells apart several "claude (~/Projects)" sessions.
      const name =
        session.userTitle ||
        session.claudeStatus?.title ||
        (codex ? session.codexTitle : undefined) ||
        session.name ||
        'Session';
      const say = (key: 'toast.claudeNeedsYou' | 'toast.claudeFinished' | 'toast.claudeReplied') =>
        namedForAgent(t(key, { name: '{name}' }), codex?.agent).replace('{name}', () => name);
      if (now === 'waiting') {
        this.showAttentionToast(session.id, say('toast.claudeNeedsYou'), true);
      } else if (now === 'idle' && (before === 'busy' || before === 'busy:background')) {
        this.showAttentionToast(session.id, say('toast.claudeFinished'), false, 'success');
      } else if (now === 'busy:background' && before === 'busy') {
        this.showAttentionToast(session.id, say('toast.claudeReplied'), false);
      }
    }
  }

  /**
   * A Claude session that ended (killed here or elsewhere, exited, cleared) can't need you
   * any more: its "Claude needs you" stayed on the lock screen (it requires interaction)
   * and kept counting on the closed app's icon badge, and tapping it opened a dead or
   * missing session (2026-10-02).
   */
  private clearNotificationsOfEndedSessions(sessions: Session[]) {
    const running = new Set(
      sessions.filter((session) => session.status === 'running').map((session) => session.id)
    );
    for (const session of this.sessions) {
      if (
        session.status === 'running' &&
        (session.claudeStatus || session.agentStatus) &&
        !running.has(session.id)
      ) {
        void pushNotificationService.clearSessionNotifications(session.id, { claudeOnly: true });
      }
    }
    // Same for the in-app "Claude needs you" toast still on screen.
    if (this.attentionToast && !running.has(this.attentionToast.sessionId)) {
      this.attentionToast = null;
      this.dismissAttentionToast?.();
      this.dismissAttentionToast = null;
    }
  }

  private showAttentionToast(
    sessionId: string,
    text: string,
    waiting: boolean,
    kind: 'attention' | 'success' | 'info' = waiting ? 'attention' : 'info'
  ) {
    this.attentionToast = { sessionId, text, waiting };
    announce(text);
    if (this.attentionToastTimer) clearTimeout(this.attentionToastTimer);
    this.dismissAttentionToast?.();
    this.dismissAttentionToast = toast({
      kind,
      text,
      key: 'claude-attention',
      timeoutMs: 7000,
      action: {
        label: t('notify.open'),
        run: () => {
          this.attentionToast = null;
          this.handleNavigateToSession(
            new CustomEvent('navigate-to-session', { detail: { sessionId } })
          );
        },
      },
    });
    this.attentionToastTimer = setTimeout(() => {
      this.attentionToast = null;
      this.dismissAttentionToast = null;
    }, 7000);
  }

  /**
   * The list polls every second, so a server restart or a network blip used to flash
   * "Failed to load sessions" error toasts. Show a quiet "Reconnecting…" pill instead and
   * let it clear itself when the server answers again.
   */
  private noteLoadFailure() {
    this.loadFailures++;
    // Never loaded yet: say so at once, or a phone shows an empty start screen as if the
    // server simply had no sessions.
    if (this.loadFailures >= 2 || !this.everLoaded) this.reconnecting = true;
  }

  private renderReconnecting() {
    // Only where sessions are polled; the login screen and file browser have their own state.
    if (!this.reconnecting || (this.currentView !== 'list' && this.currentView !== 'session')) {
      return '';
    }
    // An open session draws the pill itself, under its header: up here it covered the ⋮
    // menu's first item (2026-10-03).
    if (this.sessionViewShowsReconnecting) return '';
    return html`<div class="reconnecting-pill" role="status" aria-live="polite">
      <span class="reconnecting-dot"></span>${t('connection.reconnecting')}
    </div>`;
  }

  /** '?' sheet listing the app shortcuts (design spec 5.4, 2026-10-12). */
  private renderShortcutSheet() {
    if (!this.showShortcutSheet) return nothing;
    const rows: Array<[Parameters<typeof t>[0], string[]]> = [
      ['shortcuts.palette', [shortcutLabel('mod+k')]],
      ['shortcuts.newSession', [shortcutLabel('mod+shift+n')]],
      ['shortcuts.settings', [shortcutLabel('mod+,')]],
      ['shortcuts.files', [shortcutLabel('mod+o')]],
      ['shortcuts.sidebar', [shortcutLabel('mod+b')]],
      ['shortcuts.switch', [shortcutLabel('mod+1'), shortcutLabel('mod+9')]],
      ['shortcuts.help', ['?']],
      // The terminal's mouse selection (terminal-clipboard.ts, 2026-10-31).
      ['shortcuts.copy', [shortcutLabel('mod+c')]],
      ['shortcuts.selectInApp', [isMacPlatform() ? '⇧' : 'Shift']],
      ['shortcuts.selectBlock', [isMacPlatform() ? '⌥' : 'Alt']],
    ];
    const close = () => {
      this.showShortcutSheet = false;
    };
    return html`
      <modal-wrapper
        .visible=${true}
        .ariaLabel=${t('shortcuts.title')}
        contentClass="ut-dialog ut-dialog--sm"
        @close=${close}
      >
        <div data-testid="shortcut-sheet">
          <div class="ut-dialog-header">
            <span>${t('shortcuts.title')}</span>
            <button
              class="ut-icon-btn"
              aria-label=${t('common.close')}
              title=${`${t('common.close')} (${shortcutLabel('esc')})`}
              @click=${close}
            >
              ${icon('x')}
            </button>
          </div>
          <dl class="ut-dialog-body ut-shortcuts">
            ${rows.map(
              ([label, keys]) => html`<dt>${t(label)}</dt>
                <dd>${keys.map((key, i) => html`${i ? html`<span class="text-text-dim">–</span>` : nothing}<kbd class="ut-kbd">${key}</kbd>`)}</dd>`
            )}
          </dl>
        </div>
      </modal-wrapper>
    `;
  }

  private startAutoRefresh() {
    // A re-login calls this again; the poller never runs twice. Polls stop while the page
    // is hidden (a phone kept the 1 s poll going with the screen locked) and run at once
    // when it is shown again.
    this.autoRefresh.start();
    // "On this Mac" right away rather than with the first poll.
    if (this.showsMacSessions()) void this.loadMacSessions();
    // The poll slows down while nothing changes; a session starting or ending is pushed
    // by the server, so the list still shows it at once.
    if (this.unsubscribeSessionEvents.length === 0) {
      const refresh = () => void this.autoRefresh.pollNow();
      this.unsubscribeSessionEvents = [
        serverEventService.on(ServerEventType.SessionStart, refresh),
        serverEventService.on(ServerEventType.SessionExit, refresh),
        // `ut open` in the session on screen: show its preview here.
        serverEventService.on(ServerEventType.PreviewOpen, (event) => {
          if (!event.sessionId || !event.port) return;
          const sessionId = event.sessionId;
          const port = event.port;
          const id = event.previewId;
          // Its row comes to the top of the list (newest preview first) and glows a moment.
          void this.loadPreviews(true);
          refresh();
          if (!id) return;
          highlightPreviewRow(id);
          const showingIt =
            (this.currentView === 'session' && this.selectedSessionId === sessionId) ||
            (this.currentView === 'preview' && this.previewTarget?.id === id);
          if (showingIt) {
            this.openPreviewView(id, event.path, { from: null });
            return;
          }
          // Not on screen: a notice to open it, rather than nothing at all.
          const name = this.sessions.find((s) => s.id === sessionId)?.name || `:${port}`;
          showActionToast({
            key: `preview-${id}`,
            text: t('preview.readyToast', { where: name }),
            action: t('preview.openAction'),
            onAction: () => this.openPreviewView(id, event.path, { from: null }),
          });
        }),
      ];
    }
  }

  /** Claude conversation history: open the session running one, or resume it in a new one. */
  private handleOpenHistory = () => {
    lazyViews.claudeHistory.use((history) => this.openClaudeHistory(history));
  };

  private openClaudeHistory(history: typeof import('./components/claude-history-view.js')) {
    history.openClaudeHistory({
      authHeader: () => authClient.getAuthHeader(),
      getSessions: () => this.sessions,
      onOpenSession: (sessionId) =>
        void this.handleNavigateToSession(
          new CustomEvent('navigate-to-session', { detail: { sessionId } })
        ),
      onSessionCreated: (sessionId) => void this.waitForSessionAndSwitch(sessionId),
    });
  }

  private async handleSessionCreated(e: CustomEvent) {
    const sessionId = e.detail.sessionId;
    if (!sessionId) {
      this.showError(t('toast.sessionIdMissing'));
      return;
    }

    // Simply close the modal without animation
    this.showCreateModal = false;

    // A session opened in a Terminal window is switched to as well, once its forwarder registers it.
    await this.waitForSessionAndSwitch(sessionId);
  }

  private async waitForSessionAndSwitch(sessionId: string) {
    console.log('[App] waitForSessionAndSwitch called with:', sessionId);
    const maxAttempts = 10;
    const delay = TIMING.SESSION_SEARCH_DELAY; // Configured delay between attempts

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.loadSessions();

      // Try to find by exact ID match
      const session = this.sessions.find((s) => s.id === sessionId);

      if (session) {
        // Session found, navigate to it using the proper navigation method
        await this.handleNavigateToSession(
          new CustomEvent('navigate-to-session', {
            detail: { sessionId: session.id },
          })
        );
        return;
      }

      // Wait before next attempt
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }

    // If we get here, session creation might have failed
    logger.log('session not found after all attempts');
    this.showError(t('toast.sessionCreatedNotFound'));
  }

  /** Sessions the user just killed (id -> when): shown as exited until the server agrees. */
  private recentlyKilled = new Map<string, number>();

  /**
   * Sessions the user ended from this page (id -> when). Unlike recentlyKilled, a poll doesn't
   * drop them when they leave the list, which is exactly when they are needed.
   */
  private endedHere = new Map<string, number>();

  /**
   * 2026-10-04: Disconnect removes an attached tmux session at once, and the open session then
   * vanished with a "session not found" toast, as if something had gone wrong.
   */
  private endedHereRecently(id: string): boolean {
    const at = this.endedHere.get(id);
    return at !== undefined && Date.now() - at < ENDED_HERE_MS;
  }

  private handleSessionKilled(e: CustomEvent) {
    const detail = e.detail as string | { sessionId?: string } | undefined;
    const id = typeof detail === 'string' ? detail : detail?.sessionId;
    logger.log(`session ${id} killed`);
    if (id) {
      const now = Date.now();
      for (const [ended, at] of this.endedHere) {
        if (now - at >= ENDED_HERE_MS) this.endedHere.delete(ended);
      }
      this.endedHere.set(id, now);
    }
    // Show it as finished right away instead of waiting for the next (possibly backed-off)
    // poll, and look again shortly: the process exits a moment after the kill returns.
    if (id && this.sessions.some((session) => session.id === id && session.status === 'exited')) {
      // "Clear" on a finished session: the server removed it. Drop it now; the list's own
      // filtering was undone by this component's next render, and a poll already in flight
      // brought it back, so the row stayed or flickered back after "Clear" (2026-10-02).
      this.recentlyCleared.set(id, Date.now());
      this.sessions = this.sessions.filter((session) => session.id !== id);
    } else if (id) {
      this.recentlyKilled.set(id, Date.now());
      // Shown as exited from now on, so the next poll won't see it end: clear its Claude
      // notifications here.
      this.clearNotificationsOfEndedSessions(this.sessions.filter((session) => session.id !== id));
      this.sessions = this.sessions.map((session) =>
        session.id === id && session.status === 'running'
          ? { ...session, status: 'exited' as const }
          : session
      );
    }
    this.loadSessions();
    this.clearKillRefreshTimers();
    for (const ms of [800, 2500]) {
      const timer = setTimeout(() => {
        this.killRefreshTimers.delete(timer);
        // Same checks as the poller: a logout (or leaving the list) in the meantime must
        // not fire an unauthenticated /api/sessions and a second logout on its 401.
        if (!this.isAuthenticated) return;
        if (this.currentView !== 'list' && this.currentView !== 'session') return;
        void this.loadSessions();
      }, ms);
      this.killRefreshTimers.add(timer);
    }
  }

  /** Follow-up refreshes after a kill; cleared on logout. */
  private killRefreshTimers = new Set<ReturnType<typeof setTimeout>>();

  private clearKillRefreshTimers() {
    for (const timer of this.killRefreshTimers) clearTimeout(timer);
    this.killRefreshTimers.clear();
  }

  /** Finished sessions just cleared (id -> when): hidden from lists fetched before the clear. */
  private recentlyCleared = new Map<string, number>();

  /** Keep a just-killed session shown as exited while the server catches up; say so if not. */
  private applyRecentKills(sessions: Session[]): Session[] {
    if (this.recentlyCleared.size > 0) {
      const now = Date.now();
      for (const [id, at] of this.recentlyCleared) {
        if (now - at > 5000) this.recentlyCleared.delete(id);
      }
      sessions = sessions.filter((session) => !this.recentlyCleared.has(session.id));
    }
    if (this.recentlyKilled.size === 0) return sessions;
    // A killed session that is gone from the list (cleaned up) will never be seen again.
    const listed = new Set(sessions.map((session) => session.id));
    for (const id of this.recentlyKilled.keys()) {
      if (!listed.has(id)) this.recentlyKilled.delete(id);
    }
    const now = Date.now();
    return sessions.map((session) => {
      const at = this.recentlyKilled.get(session.id);
      if (at === undefined) return session;
      if (session.status !== 'running') {
        this.recentlyKilled.delete(session.id);
        return session;
      }
      if (now - at < 8000) return { ...session, status: 'exited' as const };
      // Still alive 8 s after a kill the server accepted: tell the user instead of
      // silently showing it as running again.
      this.recentlyKilled.delete(session.id);
      this.showError(t('toast.terminateFailed', { error: session.name || session.id }));
      return session;
    });
  }

  private handleRefresh() {
    this.loadSessions();
  }

  private handleError(e: CustomEvent) {
    this.showError(e.detail.message || e.detail);
  }

  private async handleHideExitedChange(e: CustomEvent) {
    logger.log('handleHideExitedChange', {
      currentHideExited: this.hideExited,
      newHideExited: e.detail,
      currentView: this.currentView,
    });

    // Skip animations entirely when in session detail view
    const isInSessionDetailView = this.currentView === 'session';

    if (isInSessionDetailView) {
      // Just update state without any animations
      this.hideExited = e.detail;
      this.saveHideExitedState(this.hideExited);
      await this.updateComplete;
      logger.log('Skipped animations in session detail view');
      return;
    }

    // Don't use View Transitions for hide/show exited toggle
    // as it causes the entire UI to fade. Use CSS animations instead.
    const wasHidingExited = this.hideExited;

    // Capture current scroll position and check if we're near the bottom
    const scrollTop = window.scrollY;
    const scrollHeight = document.documentElement.scrollHeight;
    const clientHeight = window.innerHeight;
    const isNearBottom = scrollTop + clientHeight >= scrollHeight - 100; // Within 100px of bottom

    // Add pre-animation class
    document.body.classList.add('sessions-animating');
    logger.log('Added sessions-animating class');

    // Update state
    this.hideExited = e.detail;
    this.saveHideExitedState(this.hideExited);

    // Wait for render and trigger animations
    await this.updateComplete;
    logger.log('Update complete, scheduling animation');

    requestAnimationFrame(() => {
      // Add specific animation direction
      const animationClass = wasHidingExited ? 'sessions-showing' : 'sessions-hiding';
      document.body.classList.add(animationClass);
      logger.log('Added animation class:', animationClass);

      // Check what elements will be animated
      const cards = document.querySelectorAll('.session-flex-responsive > session-card');
      logger.log('Found session cards to animate:', cards.length);

      // If we were near the bottom, maintain that position
      if (isNearBottom) {
        // Use a small delay to ensure DOM has updated
        requestAnimationFrame(() => {
          window.scrollTo({
            top: document.documentElement.scrollHeight - clientHeight,
            behavior: 'instant',
          });
        });
      }

      // Clean up after animation
      setTimeout(() => {
        document.body.classList.remove('sessions-animating', 'sessions-showing', 'sessions-hiding');
        logger.log('Cleaned up animation classes');

        // Final scroll adjustment after animation completes
        if (isNearBottom) {
          window.scrollTo({
            top: document.documentElement.scrollHeight - clientHeight,
            behavior: 'instant',
          });
        }
      }, 300);
    });
  }

  private handleCreateSession() {
    logger.log('handleCreateSession called');
    // Remove any lingering modal-closing class from previous interactions
    document.body.classList.remove('modal-closing');

    // Clear workingDir when opening from header
    this.createDialogWorkingDir = '';

    // Immediately set the modal to visible
    this.showCreateModal = true;
    logger.log('showCreateModal set to true');

    // Animation disabled - modal appears instantly
  }

  private handleCreateModalClose() {
    // Simply close the modal without animation
    this.showCreateModal = false;
    this.createDialogWorkingDir = '';
  }

  private handleSwitchSession = (e: CustomEvent): void => {
    const direction = (e.detail?.direction as 'next' | 'prev') ?? 'next';
    const running = this.sessions.filter((s) => s.status === 'running');
    if (running.length < 2) return;

    const currentIdx = running.findIndex((s) => s.id === this.selectedSessionId);
    if (currentIdx === -1) return;

    const nextIdx =
      direction === 'next'
        ? (currentIdx + 1) % running.length
        : (currentIdx - 1 + running.length) % running.length;

    const target = running[nextIdx];
    if (target && target.id !== this.selectedSessionId) {
      logger.log(`Swipe switch (${direction}) to session ${target.id}`);
      this.handleNavigateToSession(
        new CustomEvent('navigate-to-session', { detail: { sessionId: target.id } })
      );
    }
  };

  private async handleNavigateToSession(e: CustomEvent): Promise<void> {
    const { sessionId } = e.detail;
    console.log('[App] handleNavigateToSession called with:', sessionId);

    // 2026-10-31: a session Untether suspended to free memory wakes first (same id, its
    // conversation resumed), then opens: one tap. If it cannot wake it stays in the list,
    // suspended with the reason, and the next tap tries again.
    const target = this.sessions.find((s) => s.id === sessionId);
    if (isSuspended(target)) {
      toast({ kind: 'info', text: t('suspend.waking') });
      try {
        await wakeSession(sessionId, authClient.getAuthHeader());
      } catch (error) {
        toast({ kind: 'error', text: t('suspend.wakeFailed', { error: String(error) }) });
        void this.loadSessions();
        return;
      }
      // Open it as the running session it is again (the next poll says the same); a view
      // that already showed it paused connects again from scratch.
      this.sessions = this.sessions.map((s) =>
        s.id === sessionId ? { ...s, status: 'running' as const, suspended: undefined } : s
      );
      if (this.selectedSessionId === sessionId) {
        this.selectedSessionId = null;
        await this.updateComplete;
      }
      void this.loadSessions();
    }

    // Debug: Log current state before navigation
    logger.debug('Navigation to session:', {
      sessionId,
      windowWidth: window.innerWidth,
      mobileBreakpoint: BREAKPOINTS.MOBILE,
      isMobile: this.mediaState.isMobile,
      currentSidebarCollapsed: this.sidebarCollapsed,
      mediaStateIsMobile: this.mediaState.isMobile,
    });

    // View Transitions disabled for session navigation to prevent animations
    // Direct state update for instant navigation
    this.selectedSessionId = sessionId;
    this.sessionLoadingState = 'idle'; // Reset loading state for new session
    this.currentView = 'session';
    this.updateUrl(sessionId);

    // Update page title with session name
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session) {
      const sessionName = session.userTitle || session.name || session.command.join(' ');
      titleManager.setSessionTitle(sessionName, {
        waiting: deriveSessionStatus(session) === 'needs-input',
      });
    }

    // Collapse sidebar on mobile after selecting a session
    if (this.mediaState.isMobile) {
      this.sidebarCollapsed = true;
      this.saveSidebarState(true);
    }

    // Trigger terminal resize after session switch to ensure proper dimensions
    this.updateComplete.then(() => {
      triggerTerminalResize(sessionId, this);
    });
  }

  private handleNavigateToFileBrowser(sessionId?: string): void {
    // Store the session ID for context in file browser
    this.selectedSessionId = sessionId || null;

    // Update document title
    titleManager.setFileBrowserTitle();

    // Navigate to file browser view
    this.currentView = 'file-browser';
    this.updateUrl();
  }

  private handleNavigateToList(): void {
    // Update document title with session count
    const sessionCount = this.sessions.length;
    titleManager.setListTitle(sessionCount);

    // Disable View Transitions when navigating from session detail view
    // to prevent animations when sidebar is involved
    const skipViewTransition = this.currentView === 'session' || this.isTestEnvironment();

    // Check if View Transitions API is supported and should be used
    if (
      !skipViewTransition &&
      'startViewTransition' in document &&
      typeof document.startViewTransition === 'function'
    ) {
      // Use View Transitions API for smooth animation
      document.startViewTransition(() => {
        // Update state which will trigger a re-render
        this.selectedSessionId = null;
        this.currentView = 'list';
        this.updateListUrl();

        // Force update to ensure DOM changes happen within the transition
        return this.updateComplete;
      });
    } else {
      // Fallback for browsers without View Transitions support or when skipping
      this.selectedSessionId = null;
      this.currentView = 'list';
      this.updateListUrl();
    }

    // Ensure list view gets a fresh snapshot after leaving a session view.
    // This avoids stale session state if the PTY exited while we were connected.
    this.loadSessions();
  }

  private async handleKillAll() {
    // Get all running sessions from data instead of DOM elements
    const runningSessions = this.sessions.filter((session) => session.status === 'running');

    if (runningSessions.length === 0) {
      return;
    }
    // One stray tap (the button sits at the bottom of the phone list) would end every
    // session, Claude's work included.
    const n = runningSessions.length;
    const confirmed = await confirmDialog({
      title: t('sessions.killAll.confirmTitle', { n }),
      body: t('sessions.killAllConfirm', { n }),
      confirmLabel: t('sessions.killAll.confirm', { n }),
      tone: 'danger',
      details: runningSessions.map(
        (session) => session.userTitle || session.name || session.command.join(' ')
      ),
    });
    if (!confirmed) return;

    // Kill all running sessions directly via API
    const killPromises = runningSessions.map(async (session) => {
      try {
        const response = await fetch(`/api/sessions/${session.id}`, {
          method: HttpMethod.DELETE,
          headers: {
            ...authClient.getAuthHeader(),
          },
        });

        if (!response.ok) {
          logger.error(`Failed to kill session ${session.id}:`, response.status);
          return false;
        }

        logger.debug(`Successfully killed session ${session.id}`);
        return true;
      } catch (error) {
        logger.error(`Error killing session ${session.id}:`, error);
        return false;
      }
    });

    // Wait for all kill operations to complete
    const results = await Promise.all(killPromises);
    const successCount = results.filter((r) => r).length;

    if (successCount === killPromises.length) {
      this.showSuccess(t('toast.killAllSuccess', { count: successCount }));
    } else if (successCount > 0) {
      this.showError(t('toast.killPartial', { count: successCount, total: killPromises.length }));
    } else {
      this.showError(t('toast.killFailed'));
    }

    // Refresh the session list immediately
    await this.loadSessions();
  }

  /** The header search trigger ("Buscar o saltar a sesión… ⌘K") opens the palette. */
  private handleOpenPalette = () => {
    this.showShortcutSheet = false;
    this.showQuickSwitcher = true;
  };

  /**
   * One list on a phone: the home control center (2026-10-12, user request: back from a terminal must
   * land on the home control center). The phone header's "‹ Sesiones" opened the compact
   * sidebar list over the session instead: a second, almost identical list without the Ask box,
   * the tab bar or the settings, and reaching home meant tapping its title. On a phone (portrait
   * or landscape) every sidebar toggle (header, Ctrl+B, ⌘B, the palette) goes home instead and
   * the sidebar stays closed; switching sessions is the title's switcher sheet. iPad/desktop
   * keep the sidebar.
   */
  private handleToggleSidebar() {
    if (isPhoneListLayout()) {
      this.sidebarCollapsed = true;
      if (this.currentView === 'session') this.handleNavigateToList();
      return;
    }
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.saveSidebarState(this.sidebarCollapsed);
  }

  private formatShortcut(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('Cmd');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push(navigator.platform.toLowerCase().includes('mac') ? 'Option' : 'Alt');
    parts.push(e.key);
    return parts.join('+');
  }

  private handleSessionStatusChanged(e: CustomEvent) {
    logger.log('Session status changed:', e.detail);
    // Immediately refresh the session list to show updated status
    this.loadSessions();
  }

  private handleMobileOverlayClick = (e: Event) => {
    // In portrait mode, dismiss the sidebar
    if (this.isInSidebarDismissMode) {
      e.preventDefault();
      e.stopPropagation();
      this.handleToggleSidebar();
    }
    // In landscape mode, the overlay is transparent and pointer-events-none,
    // so this handler won't be called
  };

  // State persistence methods
  private loadHideExitedState(): boolean {
    try {
      const saved = localStorage.getItem('hideExitedSessions');
      return saved !== null ? saved === 'true' : true; // Default to true if not set
    } catch (error) {
      logger.error('error loading hideExited state:', error);
      return true; // Default to true on error
    }
  }

  private saveHideExitedState(value: boolean): void {
    try {
      localStorage.setItem('hideExitedSessions', String(value));
    } catch (error) {
      logger.error('error saving hideExited state:', error);
    }
  }

  private loadSidebarState(): boolean {
    // On a phone the open sidebar covers the whole session. Restoring it opened the list over
    // the session a reload, a link or a notification tap pointed at (2026-10-03): a phone
    // always starts with it closed; the saved state is for wider screens.
    if (window.innerWidth < BREAKPOINTS.MOBILE || isPhoneListLayout()) return true;
    try {
      const saved = localStorage.getItem('sidebarCollapsed');
      const isMobile = window.innerWidth < BREAKPOINTS.MOBILE;

      // Respect saved state if it exists, otherwise default based on device type
      const result = saved !== null ? saved === 'true' : isMobile;

      logger.debug('Loading sidebar state:', {
        savedValue: saved,
        windowWidth: window.innerWidth,
        mobileBreakpoint: BREAKPOINTS.MOBILE,
        isMobile,
        hasSavedState: saved !== null,
        resultingState: result ? 'collapsed' : 'expanded',
      });

      return result;
    } catch (error) {
      logger.error('error loading sidebar state:', error);
      return window.innerWidth < BREAKPOINTS.MOBILE; // Default based on screen size on error
    }
  }

  private saveSidebarState(value: boolean): void {
    try {
      localStorage.setItem('sidebarCollapsed', String(value));
    } catch (error) {
      logger.error('error saving sidebar state:', error);
    }
  }

  private loadSidebarWidth(): number {
    try {
      const saved = localStorage.getItem('sidebarWidth');
      const width = saved !== null ? Number.parseInt(saved, 10) : SIDEBAR.DEFAULT_WIDTH;
      // Validate width is within bounds
      return Math.max(SIDEBAR.MIN_WIDTH, Math.min(SIDEBAR.MAX_WIDTH, width));
    } catch (error) {
      logger.error('error loading sidebar width:', error);
      return SIDEBAR.DEFAULT_WIDTH;
    }
  }

  private saveSidebarWidth(value: number): void {
    try {
      localStorage.setItem('sidebarWidth', String(value));
    } catch (error) {
      logger.error('error saving sidebar width:', error);
    }
  }

  private setupResponsiveObserver(): void {
    this.responsiveUnsubscribe = responsiveObserver.subscribe((viewportState) => {
      const state = phoneMediaState(viewportState);
      const oldState = this.mediaState;
      this.mediaState = state;

      // Only trigger state changes after initial setup and render
      // This prevents the sidebar from flickering on page load
      if (this.responsiveObserverInitialized && this.initialRenderComplete) {
        // Auto-collapse sidebar when switching to mobile
        if (!oldState.isMobile && state.isMobile && !this.sidebarCollapsed) {
          this.sidebarCollapsed = true;
          this.saveSidebarState(true);
        }
        // Auto-expand sidebar when switching from mobile to desktop
        else if (oldState.isMobile && !state.isMobile && this.sidebarCollapsed) {
          this.sidebarCollapsed = false;
          this.saveSidebarState(false);
        }
      } else if (!this.responsiveObserverInitialized) {
        // Mark as initialized after first callback
        this.responsiveObserverInitialized = true;
      }
    });
  }

  private cleanupResizeListeners(): void {
    this.resizeCleanupFunctions.forEach((cleanup) => {
      cleanup();
    });
    this.resizeCleanupFunctions = [];

    // Reset any global styles that might have been applied
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  private handleResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    this.isResizing = true;

    // Clean up any existing listeners first
    this.cleanupResizeListeners();

    document.addEventListener('mousemove', this.handleResize);
    document.addEventListener('mouseup', this.handleResizeEnd);

    // Store cleanup functions
    this.resizeCleanupFunctions.push(() => {
      document.removeEventListener('mousemove', this.handleResize);
      document.removeEventListener('mouseup', this.handleResizeEnd);
    });

    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  };

  private handleResize = (e: MouseEvent) => {
    if (!this.isResizing) return;

    const newWidth = Math.max(SIDEBAR.MIN_WIDTH, Math.min(SIDEBAR.MAX_WIDTH, e.clientX));
    this.sidebarWidth = newWidth;
    this.saveSidebarWidth(newWidth);
  };

  /** Double-click on the handle: back to the default width. */
  private handleResizeReset = () => {
    this.cleanupResizeListeners();
    this.isResizing = false;
    this.sidebarWidth = SIDEBAR.DEFAULT_WIDTH;
    this.saveSidebarWidth(SIDEBAR.DEFAULT_WIDTH);
  };

  private handleResizeEnd = () => {
    this.isResizing = false;
    this.cleanupResizeListeners();
  };

  // URL Routing methods
  private setupRouting() {
    // Handle browser back/forward navigation
    // The arrow function itself (not a bound copy), so disconnectedCallback removes it.
    window.addEventListener('popstate', this.handlePopState);

    // Parse initial URL and set state
    this.parseUrlAndSetState().catch((error) => logger.error('Error parsing URL:', error));
  }

  private handlePopState = (_event: PopStateEvent) => {
    // Handle browser back/forward navigation
    this.parseUrlAndSetState().catch((error) => logger.error('Error parsing URL:', error));
  };

  private async parseUrlAndSetState() {
    const url = new URL(window.location.href);
    const pathParts = url.pathname.split('/').filter(Boolean);

    logger.log('🔍 parseUrlAndSetState() called', {
      url: url.href,
      pathname: url.pathname,
      pathParts,
      currentView: this.currentView,
      isAuthenticated: this.isAuthenticated,
      sessionCount: this.sessions.length,
    });

    // Check for single-segment paths first
    if (pathParts.length === 1) {
      // Check authentication first
      try {
        const authConfig = await fetchAuthConfig();
        if (authConfig) {
          if (!authConfig.noAuth && !authClient.isAuthenticated()) {
            this.currentView = 'auth';
            this.selectedSessionId = null;
            return;
          }
        } else if (!authClient.isAuthenticated()) {
          this.currentView = 'auth';
          this.selectedSessionId = null;
          return;
        }
      } catch (_error) {
        if (!authClient.isAuthenticated()) {
          this.currentView = 'auth';
          this.selectedSessionId = null;
          return;
        }
      }

      // Route based on the path segment
      if (pathParts[0] === 'file-browser') {
        this.currentView = 'file-browser';
        return;
      }
    }

    // Check for /session/:id pattern
    let sessionId: string | null = null;
    if (pathParts.length === 2 && pathParts[0] === 'session') {
      sessionId = pathParts[1];
    }
    const previewRoute = parsePreviewViewUrl(url.pathname, url.search);

    // Only check authentication if we haven't initialized yet
    // This prevents duplicate auth checks during initial load
    if (!this.initialLoadComplete && !this.isAuthenticated) {
      logger.log('🔐 Not authenticated, redirecting to auth view');
      this.currentView = 'auth';
      this.selectedSessionId = null;
      return;
    }

    this.handleDeepLinkParams(url);

    if (previewRoute) {
      if (this.sessions.length === 0 && this.isAuthenticated) await this.loadSessions();
      this.showPreviewRoute(previewRoute);
      return;
    }

    if (sessionId) {
      // Always navigate to the session view if a session ID is provided
      // The session-view component will handle loading and error cases
      logger.log(`🎯 Navigating to session ${sessionId} from URL`);

      // Load sessions if not already loaded and wait for them
      if (this.sessions.length === 0 && this.isAuthenticated) {
        logger.log('📋 Sessions not loaded yet, loading now...');
        await this.loadSessions();
        logger.log('✅ Sessions loaded', { sessionCount: this.sessions.length });
      }

      // Verify the session exists
      const sessionExists = this.sessions.find((s) => s.id === sessionId);
      logger.log('🔍 Looking for session', {
        sessionId,
        found: !!sessionExists,
        availableSessions: this.sessions.map((s) => ({ id: s.id, status: s.status })),
      });

      if (!sessionExists) {
        // Not listed (yet): during a server restart the list is empty, fails, or lacks a
        // session still being re-attached. Open it as loading and let the poll decide, with
        // the grace a shown session gets (2026-10-20 review: Back during a restart toasted
        // "No se encontró la sesión" and left for the list at once).
        logger.warn(`Session ${sessionId} not listed yet, waiting for the poll`);
        this.selectedSessionId = sessionId;
        if (this.missingSince?.id !== sessionId) {
          this.missingSince = { id: sessionId, at: Date.now() };
        }
        this.sessionLoadingState = 'loading';
        this.currentView = 'session';
        return;
      }

      // Session exists, navigate to it
      logger.log('✅ Session found, navigating to session view', {
        sessionId,
        sessionStatus: sessionExists.status,
      });
      this.selectedSessionId = sessionId;
      this.sessionLoadingState = 'loaded';
      this.currentView = 'session';

      // Opened by its link (the Mac menu, a push) while suspended: opening it wakes it too.
      if (isSuspended(sessionExists)) {
        void this.handleNavigateToSession(
          new CustomEvent('navigate-to-session', { detail: { sessionId } })
        );
      }

      // Opened from a "Claude needs you" push: the answer sheet comes up at once. The
      // parameter goes away so a reload or Back doesn't open it again.
      if (url.searchParams.get('answer') === '1') {
        url.searchParams.delete('answer');
        window.history.replaceState(window.history.state, '', url.toString());
        this.showAnswerSheet(sessionId);
      }

      logger.log('📍 Navigation complete', {
        currentView: this.currentView,
        selectedSessionId: this.selectedSessionId,
        sessionLoadingState: this.sessionLoadingState,
      });
    } else {
      this.selectedSessionId = null;
      this.currentView = 'list';
    }
  }

  /**
   * The list's URL after leaving a session. On a phone, when the entry before this one is the
   * list, step back to it instead of pushing a new "/": otherwise the browser/PWA Back (or the
   * edge swipe) after "‹ Sesiones" went into the session just left (2026-10-12).
   */
  private updateListUrl() {
    const navigation = isPhoneListLayout() ? navigationApi() : undefined;
    const index = navigation?.currentEntry?.index ?? -1;
    if (navigation && index > 0) {
      const entries = navigation.entries();
      const pathOf = (entry: { url?: string | null } | undefined): string | null => {
        try {
          return entry?.url ? new URL(entry.url).pathname : null;
        } catch {
          return null;
        }
      };
      // Walk back over the sessions opened from the switcher (A -> B) to the list they came
      // from, so Back from the home leaves the app instead of reopening B (2026-10-12).
      let target = index - 1;
      while (target > 0 && pathOf(entries[target])?.startsWith('/session/')) target--;
      const home = entries[target];
      if (home && pathOf(home) === listPath()) {
        navigation.traverseTo(home.key).finished.catch(() => {
          if (this.currentView === 'list' && window.location.pathname !== listPath()) {
            this.updateUrl();
          }
        });
        return;
      }
    }
    this.updateUrl();
  }

  private updateUrl(sessionId?: string) {
    const url = new URL(window.location.href);

    // Clear all params
    url.search = '';

    if (this.currentView === 'file-browser') {
      // Use path-based URL for file-browser view
      url.pathname = '/file-browser';
    } else if (sessionId) {
      // Use path-based URL for session view
      url.pathname = `/session/${sessionId}`;
    } else {
      // The list: back to the phone tab last shown ("/" or mission control's "/agents")
      url.pathname = listPath();
    }

    // Update browser URL without triggering page reload
    window.history.pushState(null, '', url.toString());
  }

  private setupNotificationHandlers() {
    // A tapped push notification (forwarded by the service worker) opens its session;
    // "Claude needs you" also opens the answer sheet on top of it.
    this.addEventListener('notification-action', this.handleNotificationAction as EventListener);
    window.addEventListener('ut-open-preview', this.handleOpenPreview as EventListener);
    window.addEventListener('ut-open-preview-view', this.handleOpenPreviewView as EventListener);
    window.addEventListener(PREVIEWS_CHANGED_EVENT, this.handlePreviewsChanged);
    // The "needs you" chip of a phone list row.
    window.addEventListener('ut-open-answer-sheet', this.handleOpenAnswerSheet as EventListener);
    window.addEventListener('ut-open-task-confirm', this.handleOpenTaskConfirm);
    // A row asked to show another task (a revert task just made from "Deshacer").
    window.addEventListener(SHOW_TASK_EVENT, this.handleShowTaskEvent);
    // "On this Mac": its rows, their conversation sheet, Settings and the history.
    window.addEventListener(MAC_SESSIONS_CHANGED_EVENT, this.handleMacSessionsChanged);
    window.addEventListener(MAC_SESSION_VIEW_EVENT, this.handleOpenMacSessionView as EventListener);
    window.addEventListener(MAC_TMUX_OPEN_EVENT, this.handleOpenMacTmux as EventListener);
    window.addEventListener(MAC_SHARE_EVENT, this.handleOpenMacShare as EventListener);
  }

  // 2026-11-10: this was an anonymous listener added in every connectedCallback, so a node
  // moved in the DOM answered each notification tap twice. A named handler is removed on
  // disconnect.
  private handleNotificationAction = (e: CustomEvent) => {
    const { action, data } = e.detail ?? {};
    if (action === 'dismiss') return;
    // An agent's action waiting for the user's OK (task-confirm): the confirm sheet.
    if (
      (action === 'confirm' || data?.type === 'task-confirm') &&
      typeof data?.confirmId === 'string'
    ) {
      this.showTaskConfirmSheet(data.confirmId);
      return;
    }
    // A task's push: its row in the list (Fusionar / Descartar), not its agent's terminal.
    // Also the pushes with no session at all (task-missed, setup failed).
    if (
      typeof data?.taskId === 'string' &&
      data.taskId &&
      (action === 'view-task' ||
        (typeof data.type === 'string' &&
          data.type.startsWith('task-') &&
          (!action || action === 'view-session')))
    ) {
      this.showTask(data.taskId);
      return;
    }
    if (!data?.sessionId) return;
    // "Preview ready": straight into the preview's own view.
    if (data.type === 'preview-ready' && typeof data.id === 'string') {
      this.openPreviewView(data.id, data.path || '/', { from: null });
      return;
    }
    void this.handleNavigateToSession(
      new CustomEvent('navigate-to-session', { detail: { sessionId: data.sessionId } })
    ).then(() => {
      if (action === 'answer') this.showAnswerSheet(data.sessionId, data);
    });
  };

  private handleOpenAnswerSheet = (e: CustomEvent<{ sessionId?: string }>) => {
    if (e.detail?.sessionId) this.showAnswerSheet(e.detail.sessionId);
  };

  /**
   * Claude's waiting prompt for a session, answerable in one tap. `fromPush` is the push
   * data (choices, detail, where), shown until the sheet has read the live prompt.
   */
  private showAnswerSheet(
    sessionId: string,
    fromPush?: { choices?: PromptChoices; detail?: string; where?: string; agent?: string }
  ) {
    lazyViews.answerSheet.use((sheet) => this.openAnswerSheet(sheet, sessionId, fromPush));
  }

  /** The home's "Esperando tu OK" pill (session-list.ts). */
  private handleShowTaskEvent = (e: Event) => {
    const id = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
    if (id) this.showTask(id);
  };

  private handleOpenTaskConfirm = (e: Event) => {
    const id = (e as CustomEvent<{ id?: string }>).detail?.id;
    if (id) this.showTaskConfirmSheet(id);
  };

  /** A task-engine action waiting for the user's OK (components/task-confirm-sheet.ts). */
  private showTaskConfirmSheet(id: string) {
    lazyViews.taskConfirmSheet.use((sheet) =>
      sheet.openTaskConfirmSheet({
        id,
        authHeader: () => authClient.getAuthHeader(),
        onDone: (message, kind) => {
          if (kind === 'error') this.showError(message);
          else if (kind === 'success') this.showSuccess(message);
          else {
            announce(message);
            toast({ kind: 'info', text: message, timeoutMs: TIMING.SUCCESS_MESSAGE_TIMEOUT });
          }
        },
      })
    );
  }

  private openAnswerSheet(
    sheet: typeof import('./components/answer-sheet.js'),
    sessionId: string,
    fromPush?: { choices?: PromptChoices; detail?: string; where?: string; agent?: string }
  ) {
    const session = this.sessions.find((s) => s.id === sessionId);
    const claude = session?.claudeStatus;
    sheet.openAnswerSheet({
      sessionId,
      where:
        fromPush?.where ||
        session?.userTitle ||
        claude?.title ||
        session?.claudeTitle ||
        (session?.agentStatus ? session.codexTitle : undefined) ||
        session?.name,
      detail: fromPush?.detail || (session ? waitingFor(session) : undefined),
      choices: fromPush?.choices ?? (session ? waitingChoices(session) : undefined) ?? null,
      agent:
        fromPush?.agent === 'codex' || fromPush?.agent === 'claude'
          ? fromPush.agent
          : session
            ? waitingAgent(session)
            : undefined,
      authHeader: () => authClient.getAuthHeader(),
      onOpenSession: () => {
        if (this.selectedSessionId === sessionId && this.currentView === 'session') return;
        void this.handleNavigateToSession(
          new CustomEvent('navigate-to-session', { detail: { sessionId } })
        );
      },
      onSent: (message) => this.showSuccess(message),
    });
  }

  private handleOpenSettings = () => {
    this.showSettings = true;
  };

  private handleCloseSettings = () => {
    this.showSettings = false;
  };

  private handleOpenFileBrowser = () => {
    this.handleNavigateToFileBrowser();
  };

  private handleOpenCreateDialog = (e: CustomEvent) => {
    const workingDir = e.detail?.workingDir || '';
    this.createDialogWorkingDir = workingDir;
    this.handleCreateSession();
  };

  private handleOpenTmuxSessions = () => {
    this.showTmuxModal = true;
  };

  private handleCaptureToggled = (e: CustomEvent) => {
    logger.log(`🎯 handleCaptureToggled called with:`, e.detail);
    this.keyboardCaptureActive = e.detail.active;
    logger.log(
      `Keyboard capture ${this.keyboardCaptureActive ? 'enabled' : 'disabled'} via indicator`
    );
  };

  private get showSplitView(): boolean {
    return this.currentView === 'session' && this.selectedSessionId !== null;
  }

  private get selectedSession(): Session | undefined {
    // Use cached value if session ID hasn't changed
    if (this._cachedSelectedSessionId === this.selectedSessionId && this._cachedSelectedSession) {
      // Verify the cached session still exists in the sessions array
      // Note: We're now updating session objects in place, so the reference should remain stable
      const stillExists = this.sessions.find((s) => s.id === this._cachedSelectedSession?.id);
      if (stillExists) {
        // Update cache to point to the current session object (might be the same reference)
        this._cachedSelectedSession = stillExists;
        this.lastListedSession = stillExists;
        return stillExists;
      }
    }

    // Recalculate and cache
    this._cachedSelectedSessionId = this.selectedSessionId;
    this._cachedSelectedSession = this.sessions.find((s) => s.id === this.selectedSessionId);
    if (this._cachedSelectedSession) {
      this.lastListedSession = this._cachedSelectedSession;
      return this._cachedSelectedSession;
    }
    // Missing within its grace (a server restart): keep showing it as last listed. Undefined
    // tore down the view's stream and showed the waiting screen, losing scroll and focus
    // (2026-10-20 review).
    const missing = this.missingSince;
    if (
      missing &&
      missing.id === this.selectedSessionId &&
      this.lastListedSession?.id === missing.id &&
      Date.now() - missing.at < SESSION_MISSING_GRACE_MS
    ) {
      return this.lastListedSession;
    }
    return undefined;
  }

  private get sidebarClasses(): string {
    if (!this.showSplitView) {
      // Main view: its own scroller, sized to the visible screen. html/body are overflow:hidden
      // (no rubber-band), so with a normal document flow nothing below the fold could be reached
      // on a phone: previews, sessions, the finished list (2026-10-03). The list's bottom bar
      // is sticky to this scroller.
      return 'w-full h-full overflow-y-auto flex flex-col main-list-scroll';
    }

    const baseClasses = 'bg-bg-secondary flex flex-col split-view-sidebar';
    // A phone's session fills the screen; its way back is the home, not this list (2026-10-12).
    if (isPhoneListLayout()) return `${baseClasses} hidden`;
    const isMobile = this.mediaState.isMobile;
    // Only apply transition class when animations are ready (not during initial load)
    const transitionClass = this.sidebarAnimationReady && !isMobile ? 'sidebar-transition' : '';
    const mobileClasses = isMobile ? `absolute left-0 top-0 bottom-0 flex` : transitionClass;

    const collapsedClasses = this.sidebarCollapsed
      ? isMobile
        ? 'hidden mobile-sessions-sidebar collapsed'
        : 'sm:overflow-hidden sm:translate-x-0 flex'
      : isMobile
        ? 'overflow-visible sm:translate-x-0 flex mobile-sessions-sidebar expanded'
        : 'overflow-visible sm:translate-x-0 flex';

    return `${baseClasses} ${this.showSplitView ? collapsedClasses : ''} ${this.showSplitView ? mobileClasses : ''}`;
  }

  private get sidebarStyles(): string {
    if (!this.showSplitView) {
      return '';
    }

    const isMobile = this.mediaState.isMobile;

    if (this.sidebarCollapsed) {
      // Hide completely on both desktop and mobile
      return 'width: 0px;';
    }

    // Expanded state
    if (isMobile) {
      return `width: 100vw; z-index: ${Z_INDEX.SIDEBAR_MOBILE};`;
    }

    return `width: ${this.sidebarWidth}px;`;
  }

  /** A loaded session is on screen, not under the phone's sidebar: its view shows the pill. */
  private get sessionViewShowsReconnecting(): boolean {
    return this.showSplitView && !this.shouldShowMobileOverlay && Boolean(this.selectedSession);
  }

  private get shouldShowMobileOverlay(): boolean {
    return this.showSplitView && !this.sidebarCollapsed && this.mediaState.isMobile;
  }

  private get shouldShowResizeHandle(): boolean {
    return this.showSplitView && !this.sidebarCollapsed && !this.mediaState.isMobile;
  }

  /**
   * Prevent rubber-banding in the sidebar when content is shorter than the viewport.
   */
  private setupSidebarScrollLock() {
    this.teardownSidebarScrollLock();

    if (!this.showSplitView || this.sidebarCollapsed) return;

    const el = this.querySelector('.sidebar-scroll-area') as HTMLElement | null;
    if (!el) return;

    const hasTouch =
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0 ||
      'ontouchstart' in document.documentElement;
    if (!hasTouch) return;

    el.addEventListener('touchstart', this.handleSidebarTouchStart, { passive: true });
    el.addEventListener('touchmove', this.handleSidebarTouchMove, { passive: false });
    this.sidebarScrollElement = el;
  }

  private teardownSidebarScrollLock() {
    if (!this.sidebarScrollElement) return;
    this.sidebarScrollElement.removeEventListener('touchstart', this.handleSidebarTouchStart);
    this.sidebarScrollElement.removeEventListener('touchmove', this.handleSidebarTouchMove);
    this.sidebarScrollElement = null;
  }

  private handleSidebarTouchStart = (e: TouchEvent) => {
    this.sidebarTouchStartY = e.touches[0]?.clientY ?? 0;
  };

  private handleSidebarTouchMove = (e: TouchEvent) => {
    const target = this.sidebarScrollElement;
    if (!target) return;

    const scrollTop = target.scrollTop;
    const scrollHeight = target.scrollHeight;
    const clientHeight = target.clientHeight;
    const deltaY = (e.touches[0]?.clientY ?? 0) - this.sidebarTouchStartY;

    const atTop = scrollTop <= 0;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 1; // tolerate rounding
    const scrollingDown = deltaY > 0;
    const scrollingUp = deltaY < 0;
    const notScrollable = scrollHeight <= clientHeight + 1;

    if (notScrollable || (atTop && scrollingDown) || (atBottom && scrollingUp)) {
      // Block rubber-band that would move the parent
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private get mainContainerClasses(): string {
    // In split view, we need strict height control and overflow hidden
    // In main view, we need normal document flow for scrolling
    if (this.showSplitView) {
      // Add iOS-specific class to prevent rubber band scrolling
      const iosClass = isIOS() ? 'ios-split-view' : '';
      return `flex overflow-hidden relative split-view-root ${iosClass}`;
    }
    return 'h-full';
  }

  private get isInSidebarDismissMode(): boolean {
    if (!this.mediaState.isMobile || !this.shouldShowMobileOverlay) return false;

    // Use orientation-based detection for simplicity and reliability
    const isPortrait = window.innerHeight > window.innerWidth;
    return isPortrait;
  }

  /**
   * Whether a lazily loaded element (utils/lazy-views.ts) is defined and can be rendered. A view
   * the screen needs now (`wanted`) is fetched and rendered once it arrives. Never rendered before
   * its definition: properties set on a not-yet-upgraded element can be lost on upgrade.
   */
  private lazyElement(tag: keyof typeof LAZY_ELEMENTS, wanted: boolean): boolean {
    if (customElements.get(tag)) return true;
    if (wanted) {
      void LAZY_ELEMENTS[tag].require().then(
        () => this.requestUpdate(),
        () => {}
      );
    }
    return false;
  }

  /** Where a view goes while its chunk is on its way (normally preloaded long before). */
  private renderViewLoading() {
    return html`
      <div class="h-full w-full flex items-center justify-center bg-bg" data-testid="view-loading">
        <div
          class="w-6 h-6 rounded-pill border-2 border-border border-t-transparent animate-spin"
        ></div>
      </div>
    `;
  }

  render() {
    const showSplitView = this.showSplitView;
    const selectedSession = this.selectedSession;
    // The session a preview was opened from, while it exists (Back returns to it).
    const previewFromId = this.previewTarget?.from;
    const previewFrom = previewFromId
      ? this.sessions.find((session) => session.id === previewFromId)
      : undefined;

    // Reduced logging frequency - only log when view changes
    const shouldLog = this.currentView !== this._lastLoggedView;

    if (shouldLog) {
      logger.log('🎨 App render()', {
        currentView: this.currentView,
        showSplitView,
        selectedSessionId: this.selectedSessionId,
        selectedSession: selectedSession
          ? { id: selectedSession.id, status: selectedSession.status }
          : null,
        isAuthenticated: this.isAuthenticated,
        sessionCount: this.sessions.length,
        cacheHit: this._cachedSelectedSessionId === this.selectedSessionId,
      });
      this._lastLoggedView = this.currentView;
    }

    return html`
      <!-- Main content -->
      ${
        this.currentView === 'auth'
          ? html`
            <auth-login
              .authClient=${authClient}
              @auth-success=${this.handleAuthSuccess}
              @show-ssh-key-manager=${this.handleShowSSHKeyManager}
              @open-settings=${this.handleOpenSettings}
            ></auth-login>
          `
          : this.currentView === 'preview' && this.previewTarget
            ? !this.lazyElement('preview-view', true)
              ? this.renderViewLoading()
              : html`
              <preview-view
                .previewId=${this.previewTarget.id}
                .path=${this.previewTarget.path}
                .item=${this.previews.find((p) => p.id === this.previewTarget?.id) ?? null}
                .fromSessionId=${previewFrom?.id ?? null}
                .fromSessionName=${previewFrom ? previewFrom.name || previewFrom.command?.join(' ') || '' : ''}
                .authClient=${authClient}
                @preview-back=${this.handlePreviewBack}
                @preview-go-to-session=${this.handlePreviewBackToSession}
                @preview-split=${this.handlePreviewSplit}
              ></preview-view>
            `
            : this.currentView === 'file-browser'
              ? !this.lazyElement('file-browser', true)
                ? this.renderViewLoading()
                : html`
              <!-- Full page file browser view -->
              <file-browser
                .visible=${true}
                .mode=${'browse'}
                .session=${this.selectedSession}
                @browser-cancel=${this.handleNavigateToList}
                @insert-path=${this.handleNavigateToList}
              ></file-browser>
            `
              : html`
      <!-- Main content with split view support -->
      <div class="${this.mainContainerClasses}">
        <!-- Mobile overlay when sidebar is open -->
        ${
          this.shouldShowMobileOverlay
            ? html`
              <div
                class="fixed inset-0 sm:hidden transition-all ${
                  this.isInSidebarDismissMode
                    ? 'bg-bg/50 backdrop-blur-sm'
                    : 'bg-transparent pointer-events-none'
                }"
                style="z-index: ${Z_INDEX.MOBILE_OVERLAY}; transition-duration: ${TRANSITIONS.MOBILE_SLIDE}ms;"
                @click=${this.handleMobileOverlayClick}
              ></div>
            `
            : ''
        }

        <!-- Sidebar with session list - always visible on desktop -->
        <div class="${this.sidebarClasses}" style="${this.sidebarStyles}">
          <app-header
            .sessions=${this.sessions}
            .showSplitView=${showSplitView}
            .currentUser=${authClient.getCurrentUser()?.userId || null}
            .authMethod=${authClient.getCurrentUser()?.authMethod || null}
            @create-session=${this.handleCreateSession}
            @kill-all-sessions=${this.handleKillAll}
            @open-file-browser=${this.handleOpenFileBrowser}
            @open-tmux-sessions=${this.handleOpenTmuxSessions}
            @open-settings=${this.handleOpenSettings}
            @open-history=${this.handleOpenHistory}
            @logout=${this.handleLogout}
            @navigate-to-list=${this.handleNavigateToList}
            @toggle-sidebar=${this.handleToggleSidebar}
            @open-palette=${this.handleOpenPalette}
            style="touch-action: none;"
          ></app-header>
          <div class="${this.showSplitView ? 'flex-1 sidebar-scroll-area' : 'flex-1'} bg-bg-secondary ut-list-surface">
            <session-list
              .sessions=${this.sessions}
              .previews=${this.previews}
              .macSessions=${this.macSessions}
              .loading=${this.loading}
              .hideExited=${this.hideExited}
              .selectedSessionId=${this.selectedSessionId}
              .activeSessionId=${this.selectedSessionId}
              .compactMode=${showSplitView}
              .collapsed=${this.sidebarCollapsed}
              .authClient=${authClient}
              @session-killed=${this.handleSessionKilled}
              @refresh=${this.handleRefresh}
              @error=${this.handleError}
              @hide-exited-change=${this.handleHideExitedChange}
              @kill-all-sessions=${this.handleKillAll}
              @navigate-to-session=${this.handleNavigateToSession}
              @open-file-browser=${this.handleOpenFileBrowser}
              @open-create-dialog=${this.handleOpenCreateDialog}
              @session-created=${this.handleSessionCreated}
            ></session-list>
          </div>
        </div>

        <!-- Resize handle for sidebar -->
        ${
          this.shouldShowResizeHandle
            ? html`
              <div
                class="ut-resize-handle ${this.isResizing ? 'is-dragging' : ''}"
                role="separator"
                aria-orientation="vertical"
                aria-label=${t('app.resizeSidebar')}
                data-testid="sidebar-resize-handle"
                @mousedown=${this.handleResizeStart}
                @dblclick=${this.handleResizeReset}
                title=${t('app.resizeSidebar')}
              ></div>
            `
            : ''
        }

        <!-- Main content area -->
        ${
          showSplitView
            ? html`
              <div class="flex-1 relative sm:static transition-none">
                ${
                  !this.lazyElement('session-view', true)
                    ? this.renderViewLoading()
                    : keyed(
                        this.selectedSessionId,
                        html`
                    <session-view
                      .session=${selectedSession}
                      .sessions=${this.sessions}
                      .serverPlatform=${this.macSessions?.platform ?? ''}
                      .showBackButton=${isPhoneListLayout()}
                      .showSidebarToggle=${!isPhoneListLayout() && (this.sidebarCollapsed || this.mediaState.isMobile)}
                      .sidebarCollapsed=${this.sidebarCollapsed}
                      .disableFocusManagement=${this.hasActiveOverlay}
                      .keyboardCaptureActive=${this.keyboardCaptureActive}
                      .reconnecting=${this.reconnecting && this.sessionViewShowsReconnecting}
                      @navigate-to-list=${this.handleNavigateToList}
                      @toggle-sidebar=${this.handleToggleSidebar}
                      @create-session=${this.handleCreateSession}
                      @session-status-changed=${this.handleSessionStatusChanged}
                      @open-settings=${this.handleOpenSettings}
                      @capture-toggled=${this.handleCaptureToggled}
                      @switch-session=${this.handleSwitchSession}
                      @navigate-to-session=${this.handleNavigateToSession}
                      @session-created=${this.handleSessionCreated}
                      @session-killed=${this.handleSessionKilled}
                      @error=${this.handleError}
                    ></session-view>
                  `
                      )
                }
              </div>
            `
            : ''
        }
      </div>
      `
      }


      <!-- Unified Settings Modal -->
      ${
        this.lazyElement('ut-settings', this.showSettings)
          ? html`<ut-settings
        .visible=${this.showSettings}
        .authClient=${authClient}
        @close=${this.handleCloseSettings}
        @notifications-enabled=${() => {
          this.showSuccess(t('toast.notificationsEnabled'));
        }}
        @notifications-disabled=${() => {
          this.showSuccess(t('toast.notificationsDisabled'));
        }}
        @success=${(e: CustomEvent) => this.showSuccess(e.detail)}
        @error=${(e: CustomEvent) => this.showError(e.detail)}
      ></ut-settings>`
          : nothing
      }

      <!-- SSH Key Manager Modal -->
      ${
        this.lazyElement('ssh-key-manager', this.showSSHKeyManager)
          ? html`<ssh-key-manager
        .visible=${this.showSSHKeyManager}
        .sshAgent=${authClient.getSSHAgent()}
        @close=${this.handleCloseSSHKeyManager}
      ></ssh-key-manager>`
          : nothing
      }

      <!-- Session Create Modal -->
      ${
        this.lazyElement('session-create-form', this.showCreateModal)
          ? html`<session-create-form
        .visible=${this.showCreateModal}
        .workingDir=${this.createDialogWorkingDir}
        .authClient=${authClient}
        @session-created=${this.handleSessionCreated}
        @cancel=${this.handleCreateModalClose}
        @error=${this.handleError}
      ></session-create-form>`
          : nothing
      }

      <!-- Multiplexer Modal (tmux/Zellij) -->
      ${
        this.lazyElement('multiplexer-modal', this.showTmuxModal)
          ? html`<multiplexer-modal
        .open=${this.showTmuxModal}
        @close=${() => {
          this.showTmuxModal = false;
        }}
        @navigate-to-session=${this.handleNavigateToSession}
        @create-session=${this.handleCreateSession}
      ></multiplexer-modal>`
          : nothing
      }

      ${this.renderReconnecting()}

      <!-- Session Quick Switcher (Cmd+K) -->
      <session-quick-switcher
        .visible=${this.showQuickSwitcher}
        .sessions=${this.sessions}
        .activeSessionId=${this.currentView === 'session' ? this.selectedSessionId : null}
        @palette-action=${this.handlePaletteAction}
        @palette-quick-start=${this.handlePaletteQuickStart}
        @select-session=${(e: CustomEvent) => {
          this.showQuickSwitcher = false;
          this.handleNavigateToSession(e);
        }}
        @close=${() => {
          this.showQuickSwitcher = false;
        }}
      ></session-quick-switcher>
      ${this.renderShortcutSheet()}
    `;
  }
}

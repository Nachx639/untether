/**
 * Session list: lifecycle — listeners, updates, soft keyboard, bottom chrome,
 * pull-to-search and body classes.
 */
import { state } from 'lit/decorators.js';
import { terminalSocketClient } from '../../services/terminal-socket-client.js';
import { AGENTS_ROUTE_EVENT, syncListPathFromUrl } from '../../utils/agent-mission.js';
import { TASK_UNFOLD_EVENT } from '../../utils/constants.js';
import { COMPACT_LIST_CHANGED_EVENT } from '../../utils/phone-list-layout.js';
import { loadPinned, PINS_CHANGED_EVENT } from '../../utils/pinned-sessions.js';
import { PREVIEW_HIGHLIGHT_MS } from '../../utils/preview-rows.js';
import { softKeyboardTarget, watchSoftKeyboard } from '../../utils/soft-keyboard.js';
import { isDoneTask } from '../../utils/task-status.js';
import { pruneDrafts } from '../terminal-chat-view/composer-storage.js';
import { SessionListDesktop } from './list-desktop.js';
import { KEYBOARD_GAP_PX, logger, SEARCH_PULL_PX } from './list-shared.js';

/** The two landscape columns' styles were checked once on this page (logLandscapeColumns). */
let landscapeColumnsLogged = false;

export abstract class SessionListLifecycle extends SessionListDesktop {
  connectedCallback() {
    super.connectedCallback();
    terminalSocketClient.setSeenSource(this.visibleSeenKeys);
    this.loadShieldDefault();
    window.addEventListener('resize', this.syncKeyboard);
    window.visualViewport?.addEventListener('resize', this.syncKeyboard);
    this.addEventListener('focusin', this.syncKeyboard);
    this.addEventListener('focusout', this.handleFocusOut);
    this.stopKeyboardWatch = watchSoftKeyboard(this.syncKeyboard);
    // Make the component focusable
    this.tabIndex = 0;
    // Add keyboard listener only to this component
    this.addEventListener('keydown', this.handleKeyDown);
    // "/" focuses the desktop search
    window.addEventListener('keydown', this.handleGlobalKeyDown);
    // Phone "Sessions | Agents" switch follows the URL (/agents).
    window.addEventListener('popstate', this.handleListRoute);
    window.addEventListener(AGENTS_ROUTE_EVENT, this.handleListRoute);
    window.addEventListener('ut-preview-highlight', this.handlePreviewHighlight);
    window.addEventListener(COMPACT_LIST_CHANGED_EVENT, this.handleCompactListChanged);
    window.addEventListener(PINS_CHANGED_EVENT, this.handlePinsChanged);
    window.addEventListener(TASK_UNFOLD_EVENT, this.handleTaskUnfold);
    syncListPathFromUrl();
  }

  /** A pin moved to a session's resumed copy (app.ts prunePinned): read them again. */
  protected handlePinsChanged = () => {
    this.pinnedIds = loadPinned();
  };

  /**
   * A task's push is about to reveal its row (app.ts showTask): whatever hides it opens first,
   * "Hechas" for a finished task and a search that leaves it out (2026-10-20: a push for a
   * merged task, or one filtered out by the search, landed on the list with nothing glowing).
   */
  protected handleTaskUnfold = (e: Event) => {
    const taskId = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
    if (!taskId) return;
    const task = this.taskBoard.tasks.find((entry) => entry.id === taskId);
    if (!task) return;
    if (this.phoneQuery && !this.matchesTask(task, this.phoneQuery)) this.phoneQuery = '';
    if (this.desktopQuery && !this.matchesTask(task, this.desktopQuery)) this.desktopQuery = '';
    if (isDoneTask(task)) {
      for (const section of this.querySelectorAll('done-section')) section.expand();
    }
  };

  /** `ut open`: the row glows for a moment (and is already first: newest preview on top). */
  protected handlePreviewHighlight = () => {
    this.requestUpdate();
    setTimeout(() => this.requestUpdate(), PREVIEW_HIGHLIGHT_MS + 50);
  };

  /** Settings switched "Compact list": lay the list out again. */
  protected handleCompactListChanged = () => this.requestUpdate();

  protected handleListRoute = () => {
    syncListPathFromUrl();
    this.requestUpdate();
  };

  updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
    terminalSocketClient.seenMayHaveChanged();
    if (changedProperties.has('loading')) this.syncSkeletonTimer();
    this.watchGrid();
    // The open popover shows list state (worktrees loaded, follow mode): keep it current.
    if (this.listPopover) this.renderPopover();
    this.watchScroller();
    this.watchTabBar();
    this.logLandscapeColumns();
    this.syncEmptyBodyClass();

    // Composer drafts of sessions that are gone would stay in localStorage for good.
    if (changedProperties.has('sessions')) pruneDrafts(this.sessions.map((session) => session.id));

    // Phone rows show no worktree/follow-mode UI: fetching it there cost one /api/worktrees
    // call per repo plus two list re-renders each (2026-10-02).
    if (changedProperties.has('sessions') && !this.usePhoneRows()) {
      // Load follow mode for all repositories
      this.loadFollowModeForAllRepos();
    }
  }

  /** Skeleton cards only when loading lasts more than 150ms (no flash on fast loads). */
  protected syncSkeletonTimer() {
    if (this.skeletonTimer) clearTimeout(this.skeletonTimer);
    this.skeletonTimer = null;
    if (!this.loading) {
      this.showSkeleton = false;
      return;
    }
    this.skeletonTimer = setTimeout(() => {
      this.skeletonTimer = null;
      this.showSkeleton = this.loading;
    }, 150);
  }

  /**
   * Once per page, in the server's log: whether the two landscape columns got their styles. The
   * class comes with the bundle, the grid with styles.css; "grid" is right, anything else means
   * the page runs a stylesheet from another build (2026-10-04 QA: one column on a Pro Max).
   */
  protected logLandscapeColumns() {
    if (landscapeColumnsLogged || !this.querySelector('.phone-landscape')) return;
    landscapeColumnsLogged = true;
    requestAnimationFrame(() => {
      const scroller = this.closest<HTMLElement>('.main-list-scroll');
      const display = scroller ? getComputedStyle(scroller).display : 'no scroller';
      logger.log(`landscape columns: class set, list display ${display} (grid expected)`);
    });
  }

  // ---- Phone bottom chrome, keyboard and pull-to-search (phone-spec 3.3, 2026-10-12) ------

  /**
   * The soft keyboard is up: a field in the list has focus, or the visible viewport is much
   * shorter than the window. The host gets `kbd-open` (list.css hides the tab bar and the
   * strip), and the bar's height leaves --ut-bottom-chrome.
   */
  @state() protected keyboardOpen = false;
  protected stopKeyboardWatch: (() => void) | null = null;

  protected syncKeyboard = () => {
    const active = document.activeElement;
    const typing =
      active instanceof HTMLElement && this.contains(active) && active.matches('input, textarea');
    const viewport = window.visualViewport;
    // A short viewport only counts with a field focused somewhere (soft-keyboard.ts): iOS can
    // leave it at its keyboard-up size after the keyboard went.
    const squeezed =
      viewport && softKeyboardTarget()
        ? viewport.height < window.innerHeight - KEYBOARD_GAP_PX
        : false;
    const open = this.usePhoneRows() && (typing || squeezed);
    if (open !== this.keyboardOpen) this.keyboardOpen = open;
    this.classList.toggle('kbd-open', open);
    this.publishBottomChrome();
  };

  /** Focus leaving a field lands nowhere for a moment: decide once it settled. */
  protected handleFocusOut = () => {
    setTimeout(this.syncKeyboard, 0);
  };

  protected tabBarObserver: ResizeObserver | null = null;
  protected observedTabBar: HTMLElement | null = null;
  /** This list set --ut-bottom-chrome (and must put it back to 0 when its bar goes). */
  protected ownsBottomChrome = false;

  /** Measure the tab bar while it is on screen (toasts read --ut-bottom-chrome). */
  protected watchTabBar() {
    const bar = this.querySelector<HTMLElement>('[data-testid="session-list-footer"]');
    if (bar !== this.observedTabBar) {
      this.tabBarObserver?.disconnect();
      this.observedTabBar = bar;
      if (bar && typeof ResizeObserver !== 'undefined') {
        this.tabBarObserver ??= new ResizeObserver(() => this.publishBottomChrome());
        this.tabBarObserver.observe(bar);
      }
    }
    this.publishBottomChrome();
  }

  protected publishBottomChrome() {
    const bar = this.observedTabBar;
    const height = bar?.isConnected && !this.keyboardOpen ? bar.getBoundingClientRect().height : 0;
    if (height > 0) {
      document.documentElement.style.setProperty('--ut-bottom-chrome', `${Math.round(height)}px`);
      this.ownsBottomChrome = true;
    } else if (this.ownsBottomChrome) {
      document.documentElement.style.setProperty('--ut-bottom-chrome', '0px');
      this.ownsBottomChrome = false;
    }
  }
  protected listScroller: HTMLElement | null = null;
  protected pullStart: { y: number; top: boolean } | null = null;

  /** The list's own scroller (app.ts `main-list-scroll`), or its rows' column on its side. */
  protected watchScroller() {
    const scroller =
      this.querySelector<HTMLElement>('.phone-landscape .pl-main') ??
      this.closest<HTMLElement>('.main-list-scroll');
    if (scroller === this.listScroller) return;
    this.listScroller?.removeEventListener('touchstart', this.handlePullStart);
    this.listScroller?.removeEventListener('touchmove', this.handlePullMove);
    this.listScroller = scroller;
    scroller?.addEventListener('touchstart', this.handlePullStart, { passive: true });
    scroller?.addEventListener('touchmove', this.handlePullMove, { passive: true });
  }

  protected handlePullStart = (e: TouchEvent) => {
    const scroller = this.listScroller;
    this.pullStart =
      scroller && e.touches.length === 1
        ? { y: e.touches[0].clientY, top: scroller.scrollTop <= 0 }
        : null;
  };

  /** iOS rubber-bands past the top; the pull itself reveals the field (no focus, no keyboard). */
  protected handlePullMove = (e: TouchEvent) => {
    const start = this.pullStart;
    if (!start?.top || this.searchRevealed || !this.usePhoneRows()) return;
    if (e.touches[0].clientY - start.y > SEARCH_PULL_PX) {
      this.searchRevealed = true;
      this.pullStart = null;
    }
  };

  /**
   * `body.ut-list-empty` while the desktop home shows the first-run hero, so the layout can
   * turn its header "New session" into a secondary button: one primary per surface (2026-10-12).
   */
  protected syncEmptyBodyClass() {
    const empty =
      !this.compactMode && !this.loading && this.sessions.length === 0 && !this.usePhoneRows();
    document.body.classList.toggle('ut-list-empty', empty);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    terminalSocketClient.setSeenSource(null);
    document.body.classList.remove('ut-list-empty');
    this.tabBarObserver?.disconnect();
    this.tabBarObserver = null;
    this.observedTabBar = null;
    this.publishBottomChrome();
    this.listScroller?.removeEventListener('touchstart', this.handlePullStart);
    this.listScroller?.removeEventListener('touchmove', this.handlePullMove);
    this.listScroller = null;
    window.removeEventListener('resize', this.syncKeyboard);
    this.stopKeyboardWatch?.();
    this.stopKeyboardWatch = null;
    window.visualViewport?.removeEventListener('resize', this.syncKeyboard);
    this.removeEventListener('focusin', this.syncKeyboard);
    this.removeEventListener('focusout', this.handleFocusOut);
    this.classList.remove('kbd-open');
    this.closeSheet();
    this.closeAskFolderPicker();
    this.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keydown', this.handleGlobalKeyDown);
    this.closePopover(false);
    this.gridObserver?.disconnect();
    this.observedGrid = null;
    if (this.skeletonTimer) clearTimeout(this.skeletonTimer);
    window.removeEventListener('popstate', this.handleListRoute);
    window.removeEventListener(AGENTS_ROUTE_EVENT, this.handleListRoute);
    window.removeEventListener('ut-preview-highlight', this.handlePreviewHighlight);
    window.removeEventListener(PINS_CHANGED_EVENT, this.handlePinsChanged);
    window.removeEventListener(TASK_UNFOLD_EVENT, this.handleTaskUnfold);
    window.removeEventListener(COMPACT_LIST_CHANGED_EVENT, this.handleCompactListChanged);
  }
}

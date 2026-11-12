import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { DEFAULT_REPOSITORY_BASE_PATH } from '../../shared/constants.js';
import { LOOKS } from '../../shared/looks.js';
import { MAC_SESSIONS_CHANGED_EVENT, type MacOpenMode } from '../../shared/mac-sessions.js';
import type { MacShareLauncher } from '../../shared/mac-share.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../types/config.js';
import {
  getLocale,
  LOCALE_NAMES,
  LocaleController,
  type MessageKey,
  t,
  tAround,
} from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import {
  type NotificationPreferences,
  type PushSubscription,
  pushNotificationService,
} from '../services/push-notification-service.js';
import { RepositoryService } from '../services/repository-service.js';
import { ServerConfigService, type TmuxSigningInfo } from '../services/server-config-service.js';
import { applyAccent, getAccent } from '../utils/accent-themes.js';
import { showActionToast, toast } from '../utils/action-toast.js';
import { CHAT_WIDTHS, readChatWidth, writeChatWidth } from '../utils/chat-width.js';
import { readChatStatusLinePref, writeChatStatusLinePref } from '../utils/claude-status-line.js';
import { captureOpener, cycleTabWithin, restoreFocusLater } from '../utils/dialog-focus.js';
import { applyEdgeFix, nextEdgeFix, readEdgeFix } from '../utils/edge-fix.js';
import { inputDiagnostics } from '../utils/input-diagnostics.js';
import { iosBrowser, isIOSDevice, isStandaloneApp } from '../utils/ios-install.js';
import { createLogger } from '../utils/logger.js';
import {
  applyLook,
  followServerLook,
  getActiveLook,
  getDeviceLook,
  getServerLook,
  LOOK_CHANGED_EVENT,
  loadLookStylesheet,
} from '../utils/look.js';
import { isMacPlatform, macSessionsPlatform } from '../utils/mac-sessions.js';
import { attachSheetDrag, detectMobile, isPhoneScreen } from '../utils/mobile-utils.js';
import {
  compactListOn,
  currentScreen,
  readCompactListPref,
  writeCompactListPref,
} from '../utils/phone-list-layout.js';
import { quickActionsHidden, setQuickActionsHidden } from '../utils/quick-actions-visibility.js';
import {
  readSystemTextSize,
  systemTextSizeSupported,
  writeSystemTextSize,
} from '../utils/system-text-size.js';
import { TerminalPreferencesManager } from '../utils/terminal-preferences.js';
import { getTerminalTheme } from '../utils/terminal-themes.js';
import { applyThemeMode, getThemeMode, type ThemeMode } from '../utils/theme-mode.js';
import { VERSION } from '../version.js';
import { type IconName, icon } from './icons.js';
import { iosInstallSteps } from './ios-install-steps.js';
import { renderLookPicker } from './look-picker.js';
import { terminalThemeName } from './terminal-theme-picker.js';
import { renderAccentSwatches, renderThemeModes, themeModeLabel } from './theme-toggle.js';
import { openWhatsNew } from './whats-new-sheet.js';
import './language-picker.js';
import './quick-keys-editor.js';
import './terminal-theme-picker.js';

const logger = createLogger('settings');

/** Sections of the two-pane dialog (≥1024 px); the phone sheet stacks them in this order. */
type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'terminal'
  | 'notifications'
  | 'sessions'
  | 'thisMac'
  | 'advanced';

interface SettingsSection {
  id: SettingsSectionId;
  icon: IconName;
  label: MessageKey;
  desc: MessageKey;
}

const SECTIONS: SettingsSection[] = [
  {
    id: 'general',
    icon: 'settings',
    label: 'settings.nav.general',
    desc: 'settings.section.general.desc',
  },
  {
    id: 'appearance',
    icon: 'sun',
    label: 'settings.nav.appearance',
    desc: 'settings.section.appearance.desc',
  },
  {
    id: 'terminal',
    icon: 'terminal',
    label: 'settings.nav.terminal',
    desc: 'settings.section.terminal.desc',
  },
  {
    id: 'notifications',
    icon: 'bell',
    label: 'settings.nav.notifications',
    desc: 'settings.section.notifications.desc',
  },
  {
    id: 'sessions',
    icon: 'list',
    label: 'settings.nav.sessions',
    desc: 'settings.section.sessions.desc',
  },
  {
    id: 'thisMac',
    icon: 'monitor',
    label: 'settings.nav.thisMac',
    desc: 'settings.section.thisMac.desc',
  },
  {
    id: 'advanced',
    icon: 'command',
    label: 'settings.nav.advanced',
    desc: 'settings.section.advanced.desc',
  },
];

/** The last section opened, per device. */
const SECTION_STORAGE_KEY = 'ut-settings-section';
/** Two panes from here; below it the single-column sheet (phones, narrow windows). */
const WIDE_QUERY = '(min-width: 1024px)';

function readSection(): SettingsSectionId {
  try {
    const saved = localStorage.getItem(SECTION_STORAGE_KEY);
    if (SECTIONS.some((section) => section.id === saved)) return saved as SettingsSectionId;
  } catch {
    // Storage blocked: start at General.
  }
  return 'general';
}

/** Phones: the page the settings sheet was on (a section id, or '' for the root list). */
const PHONE_SECTION_STORAGE_KEY = 'ut-settings-phone-section';
/** The CSS phone gate (phone-spec §0.1): touch and a short side under 600 px. */
const PHONE_QUERY =
  '(pointer: coarse) and (max-width: 599px), (pointer: coarse) and (max-height: 599px)';

function readPhoneSection(): SettingsSectionId | null {
  try {
    const saved = localStorage.getItem(PHONE_SECTION_STORAGE_KEY);
    if (SECTIONS.some((section) => section.id === saved)) return saved as SettingsSectionId;
  } catch {
    // Storage blocked: start at the root list.
  }
  return null;
}

function writePhoneSection(id: SettingsSectionId | null) {
  try {
    localStorage.setItem(PHONE_SECTION_STORAGE_KEY, id ?? '');
  } catch {
    // Storage blocked: the page lasts until the settings close.
  }
}

function mediaMatches(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/** One settings row (renderRow): icon, label, description and its control on the right. */
interface SettingsRow {
  icon?: IconName;
  label: string;
  /** id of the field the label names (a <label for>). */
  labelFor?: string;
  /** id on the label, for a control that uses aria-labelledby. */
  labelId?: string;
  desc?: string;
  /** Under the description (a lock note…). */
  extra?: unknown;
  control?: unknown;
  /** Control on its own line under the label (path field, swatches, theme picker). */
  wide?: boolean;
  /**
   * Phones: the control drops under the label, full width (segmented controls). Desktop
   * keeps it on the right.
   */
  stack?: boolean;
  /**
   * The current choice of a <select> control. Phones show it as a value row (label left,
   * value + chevron right) with the native select, transparent, over the whole row.
   */
  value?: string;
  /** Phones: one short line instead of `desc` (the long text goes to a group footer). */
  descShort?: string;
  testId?: string;
}

@customElement('ut-settings')
export class Settings extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) visible = false;
  @property({ type: Object }) authClient?: AuthClient;
  /**
   * The server's platform, from GET /api/mac-sessions: 'darwin' says Mac, else computer. Unset,
   * the platform that list last reported on this device.
   */
  @property({ type: String }) serverPlatform = '';

  // Notification settings state
  @state() private notificationPreferences: NotificationPreferences =
    DEFAULT_NOTIFICATION_PREFERENCES;
  @state() private permission: NotificationPermission = 'default';
  @state() private subscription: PushSubscription | null = null;
  @state() private isLoading = false;
  @state() private testingNotification = false;

  // App settings state
  @state() private repositoryBasePath = DEFAULT_REPOSITORY_BASE_PATH;
  @state() private repositoryCount = 0;
  /** Days before finished sessions are removed by the server; 0 = off (the default). */
  @state() private autoCleanupDays = 0;
  /** New web/phone sessions are shielded (survive restarts); the server's default is on. */
  @state() private shieldNewSessions = true;
  @state() private shieldAvailable = false;
  /** The stable tmux copy (GET /api/tmux-signing); null until loaded or where unsupported. */
  @state() private tmuxSigning: TmuxSigningInfo | null = null;
  /** Nothing waits for the user's OK on the phone (the server's autoApprove; default off). */
  @state() private autoApprove = false;
  /** Idle Claude sessions are restarted on the installed version (server setting; default off). */
  @state() private restartUpdatedClaude = false;
  @state() private autoUpdateInstalledApp = false;
  /** The installed Mac app the server runs under as a development server (else no switch). */
  @state() private installedApp: string | undefined;
  /** The cards' one line about each agent, written by a cheap model (2026-11-08). */
  @state() private agentExplain = true;
  @state() private suspendIdleClaude = false;
  @state() private suspendIdleMinutes = 120;
  /** "On this Mac" in the session list, and what a tap on a tmux session there opens. */
  @state() private macSessions = true;
  @state() private macSessionsOpenMode: MacOpenMode = 'control';
  /** How the server's start forced the switch (shown, not changeable here); null if not. */
  @state() private macSessionsLockedBy: string | null = null;
  /** Older servers, other systems and HQ mode list nothing: no setting then. */
  @state() private macSessionsSupported = false;
  /** "Share with phone" (off by default), how it reopens, and whether it was forced at start. */
  @state() private macShare = false;
  @state() private macShareLauncher: MacShareLauncher = 'ut';
  @state() private macShareLockedBy: string | null = null;
  /** macOS only, never on an HQ: no setting otherwise. */
  @state() private macShareSupported = false;
  /** The server's platform, from its config: "this Mac" or "this computer". */
  @state() private configPlatform = '';
  @state() private isDiscoveringRepositories = false;
  @state() private showQuickKeysEditor = false;
  @state() private quickActionsOn = !quickActionsHidden();

  // Appearance state (shared with the header toggle and the session compact menu)
  @state() private themeMode: ThemeMode = getThemeMode();
  @state() private accent = getAccent();
  @state() private look = getActiveLook().id;
  @state() private looksReady = false;

  /** Two-pane layout (≥1024 px) and the section it shows. */
  @state() private wide = mediaMatches(WIDE_QUERY);
  @state() private section: SettingsSectionId = readSection();
  /** A mouse or trackpad: phone-only settings (quick keys, system text size) are hidden. */
  @state() private finePointer = mediaMatches('(pointer: fine)');
  /**
   * Phones (phone-spec §4.4, 2026-10-12): iOS-style navigation, a root list of the sections
   * and one section pushed at a time (null = the root). Restored on reopen like iOS Settings.
   */
  @state() private phone = mediaMatches(PHONE_QUERY) || isPhoneScreen();
  @state() private phoneSection: SettingsSectionId | null = readPhoneSection();
  private wideQuery?: MediaQueryList;
  private phoneQuery?: MediaQueryList;
  private detachPhoneDrag: (() => void) | null = null;
  private phoneDragSheet: HTMLElement | null = null;

  protected readonly i18n = new LocaleController(this);
  private permissionChangeUnsubscribe?: () => void;
  private subscriptionChangeUnsubscribe?: () => void;
  private repositoryService?: RepositoryService;
  private serverConfigService?: ServerConfigService;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('theme-changed', this.syncAppearance);
    window.addEventListener('untether-accent-changed', this.syncAppearance);
    window.addEventListener(LOOK_CHANGED_EVENT, this.syncAppearance);
    this.syncAppearance();
    if (typeof window.matchMedia === 'function') {
      this.wideQuery = window.matchMedia(WIDE_QUERY);
      this.wideQuery.addEventListener?.('change', this.syncLayout);
      this.phoneQuery = window.matchMedia(PHONE_QUERY);
      this.phoneQuery.addEventListener?.('change', this.syncLayout);
      this.syncLayout();
    }
    this.initializeNotifications();

    // Initialize services
    this.serverConfigService = new ServerConfigService(this.authClient);

    // Initialize repository service if authClient is available
    if (this.authClient) {
      this.repositoryService = new RepositoryService(this.authClient, this.serverConfigService);
    }
    // The first load is updated()'s (when the dialog becomes visible). 2026-11-10: this call
    // used to run before the service existed and did nothing on the first connect; only a
    // dialog re-attached while open needs it, now that the service is there.
    if (this.visible && this.hasUpdated) void this.loadSettings();
  }

  /**
   * Hidden debug switch (utils/edge-fix.ts): a long press on the version cycles how the
   * home-screen app keeps iOS's edge blur off the header, applied at once.
   */
  private edgeFixTimer: ReturnType<typeof setTimeout> | null = null;
  private startEdgeFixPress = () => {
    this.cancelEdgeFixPress();
    this.edgeFixTimer = setTimeout(() => {
      this.edgeFixTimer = null;
      const mode = nextEdgeFix(readEdgeFix());
      applyEdgeFix(mode);
      showActionToast({
        text: `ut-edge-fix: ${mode}`,
        action: 'OK',
        onAction: () => {},
        timeoutMs: 2500,
        key: 'ut-edge-fix',
      });
    }, 700);
  };
  private cancelEdgeFixPress = () => {
    if (this.edgeFixTimer) clearTimeout(this.edgeFixTimer);
    this.edgeFixTimer = null;
  };

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cancelEdgeFixPress();
    window.removeEventListener('theme-changed', this.syncAppearance);
    window.removeEventListener('untether-accent-changed', this.syncAppearance);
    window.removeEventListener(LOOK_CHANGED_EVENT, this.syncAppearance);
    this.wideQuery?.removeEventListener?.('change', this.syncLayout);
    this.phoneQuery?.removeEventListener?.('change', this.syncLayout);
    this.stopPhoneDrag();
    if (this.permissionChangeUnsubscribe) {
      this.permissionChangeUnsubscribe();
    }
    if (this.subscriptionChangeUnsubscribe) {
      this.subscriptionChangeUnsubscribe();
    }
    // Clean up keyboard listener
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  protected willUpdate(changedProperties: PropertyValues) {
    if (changedProperties.has('visible')) {
      if (this.visible) {
        document.addEventListener('keydown', this.handleKeyDown);
        // QA 2026-10-12: focus stayed on the header button behind the scrim, Tab walked the
        // page and Esc left it on <body>. Now: focus moves in, Tab cycles, focus comes back.
        this.restoreFocusTo = captureOpener(this);
        void this.updateComplete.then(() => this.focusInitial());
        // Removed view transition for instant display
        this.requestUpdate();
        // Discover repositories when settings are opened
        this.discoverRepositories();
        // Refresh notification state when dialog opens
        this.refreshNotificationState();
      } else {
        document.removeEventListener('keydown', this.handleKeyDown);
        this.showQuickKeysEditor = false;
        restoreFocusLater(this.restoreFocusTo);
        this.restoreFocusTo = null;
      }
    }

    // Initialize repository service when authClient becomes available
    if (changedProperties.has('authClient') && this.authClient) {
      if (!this.repositoryService && this.serverConfigService) {
        this.repositoryService = new RepositoryService(this.authClient, this.serverConfigService);
      }
      // Update server config service's authClient
      if (this.serverConfigService) {
        this.serverConfigService.setAuthClient(this.authClient);
      }
      // Discover repositories if settings are already visible
      if (this.visible) {
        this.discoverRepositories();
      }
    }
  }

  /** Counts initializeNotifications runs: a stale one (disconnected meanwhile) registers nothing. */
  private notificationsRun = 0;

  private async initializeNotifications(): Promise<void> {
    const run = ++this.notificationsRun;
    // whenInitialized(), not waitForInitialization(): the settings connect before the app
    // starts the push service, and the latter then returned at once, read "no subscription"
    // and forced a resubscribe before the service worker was even registered (a warning on
    // every load; the service's own start found the subscription a moment later).
    await pushNotificationService.whenInitialized();
    if (!this.isConnected) return;

    this.permission = pushNotificationService.getPermission();
    this.subscription = pushNotificationService.getSubscription();
    this.notificationPreferences = await pushNotificationService.loadPreferences();

    // Get detailed subscription status for debugging
    const status = pushNotificationService.getSubscriptionStatus();
    logger.debug('Notification initialization status:', status);

    // If notifications are enabled but no subscription, try to force refresh
    if (this.notificationPreferences.enabled && !this.subscription && status.hasPermission) {
      logger.log('Notifications enabled but no subscription found, attempting to refresh...');
      await pushNotificationService.forceRefreshSubscription();

      // Update state after refresh
      this.subscription = pushNotificationService.getSubscription();
    }

    // 2026-11-10: the awaits above can outlast the component; its subscriptions were then
    // registered after disconnectedCallback had already removed them, and never removed.
    if (!this.isConnected || run !== this.notificationsRun) return;

    // Listen for changes
    this.permissionChangeUnsubscribe = pushNotificationService.onPermissionChange((permission) => {
      this.permission = permission;
      this.requestUpdate();
    });

    this.subscriptionChangeUnsubscribe = pushNotificationService.onSubscriptionChange(
      (subscription) => {
        this.subscription = subscription;
        this.requestUpdate();
      }
    );
  }

  private async refreshNotificationState(): Promise<void> {
    // Refresh current state from the push notification service
    this.permission = pushNotificationService.getPermission();
    this.subscription = pushNotificationService.getSubscription();
    this.notificationPreferences = await pushNotificationService.loadPreferences();

    logger.debug('Refreshed notification state:', {
      permission: this.permission,
      hasSubscription: !!this.subscription,
      preferencesEnabled: this.notificationPreferences.enabled,
    });
  }

  private async loadSettings() {
    try {
      // Fetch server configuration - force refresh when dialog opens
      if (this.serverConfigService) {
        try {
          const serverConfig = await this.serverConfigService.loadConfig(this.visible);
          // Always use server's repository base path
          this.repositoryBasePath = serverConfig.repositoryBasePath || DEFAULT_REPOSITORY_BASE_PATH;
          logger.debug('Loaded repository base path:', this.repositoryBasePath);
          this.autoCleanupDays = serverConfig.autoCleanupExitedAfterDays ?? 0;
          this.shieldNewSessions = serverConfig.shieldNewSessions !== false;
          this.shieldAvailable = serverConfig.shieldAvailable === true;
          if (this.shieldAvailable && serverConfig.platform === 'darwin') {
            void this.loadTmuxSigning();
          }
          this.autoApprove = serverConfig.autoApprove === true;
          this.restartUpdatedClaude = serverConfig.restartUpdatedClaude === true;
          this.autoUpdateInstalledApp = serverConfig.autoUpdateInstalledApp === true;
          this.installedApp = serverConfig.installedApp;
          this.agentExplain = serverConfig.agentExplain !== false;
          this.suspendIdleClaude = serverConfig.suspendIdleClaude === true;
          this.suspendIdleMinutes = serverConfig.suspendIdleMinutes ?? 120;
          this.macSessions = serverConfig.macSessions !== false;
          this.macSessionsOpenMode =
            serverConfig.macSessionsOpenMode === 'watch' ? 'watch' : 'control';
          this.macSessionsLockedBy = serverConfig.macSessionsLocked
            ? (serverConfig.macSessionsLockedBy ?? '')
            : null;
          this.macSessionsSupported = serverConfig.macSessionsSupported === true;
          this.macShare = serverConfig.macShare === true;
          this.macShareLauncher = serverConfig.macShareLauncher === 'shell' ? 'shell' : 'ut';
          this.macShareLockedBy = serverConfig.macShareLocked
            ? (serverConfig.macShareLockedBy ?? '')
            : null;
          this.macShareSupported = serverConfig.macShareSupported === true;
          this.configPlatform = serverConfig.platform ?? '';
          // Force update to ensure UI reflects the loaded value
          this.requestUpdate();
        } catch (error) {
          logger.warn('Failed to fetch server config', error);
        }
      }

      // Discover repositories after preferences are loaded if visible
      if (this.visible && this.repositoryService) {
        this.discoverRepositories();
      }
    } catch (error) {
      logger.error('Failed to load settings', error);
    }
  }

  private async discoverRepositories() {
    if (!this.repositoryService || this.isDiscoveringRepositories) {
      return;
    }

    this.isDiscoveringRepositories = true;
    try {
      // Add a small delay to ensure preferences are loaded
      await new Promise((resolve) => setTimeout(resolve, 100));

      const repositories = await this.repositoryService.discoverRepositories();
      this.repositoryCount = repositories.length;
      logger.log(`Discovered ${this.repositoryCount} repositories in ${this.repositoryBasePath}`);
    } catch (error) {
      logger.error('Failed to discover repositories', error);
      this.repositoryCount = 0;
    } finally {
      this.isDiscoveringRepositories = false;
    }
  }

  private syncLayout = () => {
    this.wide = mediaMatches(WIDE_QUERY);
    this.finePointer = mediaMatches('(pointer: fine)');
    this.phone = !this.wide && (mediaMatches(PHONE_QUERY) || isPhoneScreen());
  };

  protected updated(changed: PropertyValues) {
    super.updated(changed);
    // When dialog becomes visible, refresh the config to ensure sync
    if (changed.has('visible') && this.visible) {
      this.loadSettings();
    }
    this.syncPhoneDrag();
  }

  /** Phone sheet: swipe down (from the grabber or the top of the list) closes it. */
  private syncPhoneDrag() {
    const sheet =
      this.visible && this.phone && !this.wide
        ? this.querySelector<HTMLElement>('.st-phone')
        : null;
    if (sheet === this.phoneDragSheet) return;
    this.stopPhoneDrag();
    if (!sheet) return;
    this.phoneDragSheet = sheet;
    this.detachPhoneDrag = attachSheetDrag(sheet, {
      scroller: sheet.querySelector<HTMLElement>('[data-testid="settings-body"]'),
      onDismiss: () => this.handleClose(),
    });
  }

  private stopPhoneDrag() {
    this.detachPhoneDrag?.();
    this.detachPhoneDrag = null;
    this.phoneDragSheet = null;
  }

  /** Picks up theme/color changes made from the header or the session menu. */
  private syncAppearance = () => {
    this.themeMode = getThemeMode();
    this.accent = getAccent();
    this.look = getActiveLook().id;
    this.requestUpdate();
  };

  private selectThemeMode(mode: ThemeMode) {
    this.themeMode = mode;
    applyThemeMode(mode);
    this.dispatchEvent(
      new CustomEvent('theme-changed', { detail: { theme: mode }, bubbles: true, composed: true })
    );
  }

  private selectAccent(id: string) {
    this.accent = id;
    applyAccent(id);
  }

  /** Where focus was when the dialog opened; it goes back there on close. */
  private restoreFocusTo: HTMLElement | null = null;

  /** Panes: the current section's nav item. Sheet: the dialog itself (it has no first field). */
  private focusInitial() {
    if (!this.visible) return;
    const sheet = this.querySelector<HTMLElement>('[data-testid="settings-sheet"]');
    if (!sheet || sheet.contains(document.activeElement)) return;
    const nav = sheet.querySelector<HTMLElement>(`[data-settings-nav="${this.activeSection}"]`);
    if (nav) {
      nav.focus();
    } else {
      sheet.focus();
    }
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.visible) return;
    if (e.key === 'Escape') {
      this.handleClose();
    } else if (e.key === 'Tab' && !this.showQuickKeysEditor) {
      const sheet = this.querySelector<HTMLElement>('[data-testid="settings-sheet"]');
      if (sheet) cycleTabWithin(sheet, e);
    }
  };

  private handleClose() {
    // Closing while the path is still being typed: iOS fires no change for a field that is
    // removed while focused, so commit the edit here.
    const pathInput = this.querySelector<HTMLInputElement>('[data-testid="settings-repo-path"]');
    if (pathInput && pathInput.value.trim() !== this.repositoryBasePath) {
      void this.handleRepositoryBasePathChange(pathInput);
    }
    this.dispatchEvent(new CustomEvent('close'));
  }

  private handleBackdropClick(e: Event) {
    if (e.target === e.currentTarget) {
      this.handleClose();
    }
  }

  /**
   * Notifications are on *on this device*: the shared `enabled` setting plus this
   * browser's permission. A TV or desktop without permission shows "Off" and offers to turn
   * them on here, instead of mirroring the iPhone. (2026-10-20)
   */
  private get notificationsOnHere(): boolean {
    return this.notificationPreferences.enabled && this.permission === 'granted';
  }

  private async handleToggleNotifications() {
    if (this.isLoading) return;

    this.isLoading = true;
    try {
      if (this.notificationsOnHere) {
        // Disable notifications
        await pushNotificationService.unsubscribe();
        this.notificationPreferences = { ...this.notificationPreferences, enabled: false };
        await pushNotificationService.savePreferences(this.notificationPreferences);
        this.dispatchEvent(new CustomEvent('notifications-disabled'));
      } else {
        // Enable notifications
        const permission = await pushNotificationService.requestPermission();
        if (permission === 'granted') {
          // Check if this is the first time enabling notifications
          const currentPrefs = await pushNotificationService.loadPreferences();
          if (!currentPrefs.enabled) {
            // First time enabling - use recommended defaults
            this.notificationPreferences = pushNotificationService.getRecommendedPreferences();
            logger.log('Using recommended notification preferences for first-time enable');
          } else {
            // Already enabled before - just toggle the enabled state
            this.notificationPreferences = { ...this.notificationPreferences, enabled: true };
          }

          const subscription = await pushNotificationService.subscribe();
          if (subscription) {
            await pushNotificationService.savePreferences(this.notificationPreferences);

            // Show welcome notification
            await this.showWelcomeNotification();

            this.dispatchEvent(new CustomEvent('notifications-enabled'));
          } else {
            this.dispatchEvent(
              new CustomEvent('error', {
                detail: t('settings.error.subscribe'),
              })
            );
          }
        } else {
          this.dispatchEvent(
            new CustomEvent('error', {
              detail: t('settings.error.permissionDenied'),
            })
          );
        }
      }
    } catch (error) {
      logger.error('Failed to toggle notifications:', error);
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: t('settings.error.toggle'),
        })
      );
    } finally {
      this.isLoading = false;
    }
  }

  private async handleForceRefresh() {
    try {
      await pushNotificationService.forceRefreshSubscription();

      // Update state after refresh
      this.subscription = pushNotificationService.getSubscription();
      this.notificationPreferences = await pushNotificationService.loadPreferences();

      logger.log('Force refresh completed');
    } catch (error) {
      logger.error('Force refresh failed:', error);
    }
  }

  private async handleTestNotification() {
    if (this.testingNotification) return;

    this.testingNotification = true;
    try {
      logger.log('🧪 Starting test notification...');

      // Step 1: Check service worker
      logger.debug('Step 1: Checking service worker registration');
      if (!pushNotificationService.isSupported()) {
        throw new Error('Push notifications not supported in this browser');
      }

      // Step 2: Check permissions
      logger.debug('Step 2: Checking notification permissions');
      const permission = pushNotificationService.getPermission();
      if (permission !== 'granted') {
        throw new Error(`Notification permission is ${permission}, not granted`);
      }

      // Step 3: Check subscription
      logger.debug('Step 3: Checking push subscription');
      const subscription = pushNotificationService.getSubscription();
      if (!subscription) {
        throw new Error('No active push subscription found');
      }

      // Step 4: Check server status
      logger.debug('Step 4: Checking server push notification status');
      const serverStatus = await pushNotificationService.getServerStatus();
      if (!serverStatus.enabled) {
        throw new Error('Push notifications disabled on server');
      }

      if (!serverStatus.configured) {
        throw new Error('VAPID keys not configured on server');
      }

      // Step 5: Send test notification
      logger.debug('Step 5: Sending test notification');
      await pushNotificationService.sendTestNotification(t('settings.testNotification.body'));

      logger.log('✅ Test notification sent successfully');
      this.dispatchEvent(
        new CustomEvent('success', {
          detail: t('settings.testNotification.sent'),
        })
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('❌ Test notification failed:', errorMessage);

      // Provide specific guidance based on error
      let guidance = '';
      if (errorMessage.includes('permission')) {
        guidance = t('settings.guidance.permission');
      } else if (errorMessage.includes('subscription')) {
        guidance = t('settings.guidance.subscription');
      } else if (errorMessage.includes('server')) {
        guidance = t('settings.guidance.server');
      } else if (errorMessage.includes('VAPID')) {
        guidance = t('settings.guidance.vapid');
      } else {
        guidance = t('settings.guidance.console');
      }

      this.dispatchEvent(
        new CustomEvent('error', {
          detail: t('settings.testNotification.failed', { error: errorMessage, guidance }),
        })
      );
    } finally {
      this.testingNotification = false;
    }
  }

  private async handleNotificationPreferenceChange(
    key: keyof NotificationPreferences,
    value: boolean
  ) {
    const previous = this.notificationPreferences;
    this.notificationPreferences = { ...previous, [key]: value };
    try {
      await pushNotificationService.savePreferences(this.notificationPreferences);
    } catch (error) {
      // The switch must not claim a state the server never stored. (2026-10-20: a failed
      // PUT left the switch flipped with no message.)
      logger.error('Failed to save notification preference:', error);
      if (this.notificationPreferences[key] === value) {
        this.notificationPreferences = { ...this.notificationPreferences, [key]: previous[key] };
      }
      toast({ kind: 'error', text: t('settings.notify.saveFailed') });
    }
  }

  private async showWelcomeNotification(): Promise<void> {
    // Check if we have a service worker registration
    const registration = await navigator.serviceWorker.ready;
    if (!registration) {
      return;
    }

    try {
      // Show notification directly
      await registration.showNotification(t('settings.welcomeNotification.title'), {
        body: t('settings.welcomeNotification.body'),
        icon: '/apple-touch-icon.png',
        badge: '/favicon-32.png',
        tag: 'untether-settings-welcome',
        requireInteraction: false,
        silent: false,
      });
      logger.log('Settings welcome notification displayed');
    } catch (error) {
      logger.error('Failed to show settings welcome notification:', error);
    }
  }

  /**
   * Saves once the field is committed (blur / Return), not on every keystroke:
   * per-keystroke saves raced each other and could leave a half-typed path on the server.
   */
  private async handleRepositoryBasePathChange(input: HTMLInputElement) {
    const value = input.value.trim();
    if (!this.serverConfigService || !value || value === this.repositoryBasePath) {
      input.value = this.repositoryBasePath;
      return;
    }
    try {
      await this.serverConfigService.updateConfig({ repositoryBasePath: value });
      this.repositoryBasePath = value;
      this.discoverRepositories();
    } catch (error) {
      logger.error('Failed to update repository base path:', error);
      input.value = this.repositoryBasePath;
    }
  }

  private async handleAutoCleanupChange(select: HTMLSelectElement) {
    const days = Number(select.value);
    const previous = this.autoCleanupDays;
    if (!this.serverConfigService || !Number.isInteger(days) || days === previous) return;
    this.autoCleanupDays = days;
    try {
      await this.serverConfigService.updateConfig({ autoCleanupExitedAfterDays: days });
    } catch (error) {
      logger.error('Failed to update finished-session cleanup:', error);
      this.autoCleanupDays = previous;
      select.value = String(previous);
      this.dispatchEvent(new CustomEvent('error', { detail: t('cleanup.saveFailed') }));
    }
  }

  private async handleShieldNewSessionsToggle() {
    if (!this.serverConfigService) return;
    const next = !this.shieldNewSessions;
    this.shieldNewSessions = next;
    try {
      await this.serverConfigService.updateConfig({ shieldNewSessions: next });
    } catch (error) {
      logger.error('Failed to update shielding of new sessions:', error);
      this.shieldNewSessions = !next;
      this.dispatchEvent(new CustomEvent('error', { detail: t('shield.settingSaveFailed') }));
    }
  }

  private async handleAgentExplainToggle() {
    if (!this.serverConfigService) return;
    const next = !this.agentExplain;
    this.agentExplain = next;
    try {
      await this.serverConfigService.updateConfig({ agentExplain: next });
    } catch (error) {
      logger.error('Failed to update agentExplain:', error);
      this.agentExplain = !next;
      this.dispatchEvent(new CustomEvent('error', { detail: t('agentExplain.saveFailed') }));
    }
  }

  private async handleRestartUpdatedClaudeToggle() {
    if (!this.serverConfigService) return;
    const next = !this.restartUpdatedClaude;
    this.restartUpdatedClaude = next;
    try {
      await this.serverConfigService.updateConfig({ restartUpdatedClaude: next });
    } catch (error) {
      logger.error('Failed to update restartUpdatedClaude:', error);
      this.restartUpdatedClaude = !next;
      this.dispatchEvent(new CustomEvent('error', { detail: t('claudeUpdate.saveFailed') }));
    }
  }

  private async handleAutoUpdateInstalledAppToggle() {
    if (!this.serverConfigService) return;
    const next = !this.autoUpdateInstalledApp;
    this.autoUpdateInstalledApp = next;
    try {
      await this.serverConfigService.updateConfig({ autoUpdateInstalledApp: next });
    } catch (error) {
      logger.error('Failed to update autoUpdateInstalledApp:', error);
      this.autoUpdateInstalledApp = !next;
      this.dispatchEvent(new CustomEvent('error', { detail: t('appUpdate.saveFailed') }));
    }
  }

  private async handleSuspendIdleToggle() {
    if (!this.serverConfigService) return;
    const next = !this.suspendIdleClaude;
    this.suspendIdleClaude = next;
    try {
      await this.serverConfigService.updateConfig({ suspendIdleClaude: next });
    } catch (error) {
      logger.error('Failed to update suspendIdleClaude:', error);
      this.suspendIdleClaude = !next;
      this.dispatchEvent(new CustomEvent('error', { detail: t('suspend.saveFailed') }));
    }
  }

  private async handleSuspendMinutesChange(select: HTMLSelectElement) {
    const minutes = Number(select.value);
    const previous = this.suspendIdleMinutes;
    if (!this.serverConfigService || !Number.isInteger(minutes) || minutes === previous) return;
    this.suspendIdleMinutes = minutes;
    try {
      await this.serverConfigService.updateConfig({ suspendIdleMinutes: minutes });
    } catch (error) {
      logger.error('Failed to update suspendIdleMinutes:', error);
      this.suspendIdleMinutes = previous;
      select.value = String(previous);
      this.dispatchEvent(new CustomEvent('error', { detail: t('suspend.saveFailed') }));
    }
  }

  /** "Suspend idle Claude sessions" and, when on, after how long (2026-10-31). */
  private renderSuspendIdle() {
    const choices = [30, 60, 120, 240, 480, 1440];
    if (!choices.includes(this.suspendIdleMinutes)) {
      choices.push(this.suspendIdleMinutes);
      choices.sort((a, b) => a - b);
    }
    const label = (minutes: number) =>
      minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
    return html`
      ${this.renderRow({
        icon: 'pause',
        label: t('suspend.label'),
        desc: t('suspend.description'),
        descShort: t('suspend.descShort'),
        testId: 'settings-suspend-idle',
        control: this.renderSwitch({
          on: this.suspendIdleClaude,
          label: t('suspend.label'),
          testId: 'settings-suspend-idle-toggle',
          onToggle: () => this.handleSuspendIdleToggle(),
        }),
      })}
      ${
        this.suspendIdleClaude
          ? this.renderRow({
              icon: 'clock',
              label: t('suspend.minutes'),
              labelFor: 'suspend-minutes-select',
              value: label(this.suspendIdleMinutes),
              testId: 'settings-suspend-minutes',
              control: html`<select
                id="suspend-minutes-select"
                class="ut-field ut-select w-auto"
                data-testid="settings-suspend-minutes-select"
                @change=${(e: Event) => this.handleSuspendMinutesChange(e.target as HTMLSelectElement)}
              >
                ${choices.map(
                  (minutes) => html`
                    <option value=${String(minutes)} ?selected=${minutes === this.suspendIdleMinutes}>
                      ${label(minutes)}
                    </option>
                  `
                )}
              </select>`,
            })
          : nothing
      }
    `;
  }

  private async loadTmuxSigning() {
    if (!this.serverConfigService) return;
    try {
      const info = await this.serverConfigService.getTmuxSigning();
      this.tmuxSigning = info.supported ? info : null;
    } catch (error) {
      logger.warn('Failed to load the tmux signature setting', error);
    }
  }

  private async handleTmuxSigningChange(select: HTMLSelectElement) {
    if (!this.serverConfigService || !this.tmuxSigning) return;
    const previous = this.tmuxSigning.identity ?? null;
    const next = select.value || null;
    if (next === previous) return;
    this.tmuxSigning = { ...this.tmuxSigning, identity: next };
    try {
      await this.serverConfigService.updateConfig({ tmuxSigningIdentity: next });
      // The copy is made in the background; show how it went shortly after.
      setTimeout(() => void this.loadTmuxSigning(), 3000);
    } catch (error) {
      logger.error('Failed to update the tmux signature:', error);
      this.tmuxSigning = { ...this.tmuxSigning, identity: previous };
      select.value = previous ?? '';
      this.dispatchEvent(new CustomEvent('error', { detail: t('shield.tmuxSigning.saveFailed') }));
    }
  }

  private renderTmuxSigning() {
    const info = this.tmuxSigning;
    if (!info) return nothing;
    const identities = info.identities ?? [];
    const chosen = info.identity ?? '';
    const chosenName = identities.find((identity) => identity.hash === chosen)?.name ?? chosen;
    const status = info.status;
    const statusText =
      chosen && status?.state === 'failed' && status.error
        ? t('shield.tmuxSigning.failed', { error: status.error })
        : chosen && status?.version && status.state !== 'off'
          ? t('shield.tmuxSigning.current', { version: status.version })
          : '';
    return this.renderRow({
      icon: 'shield',
      label: t('shield.tmuxSigning.label'),
      labelFor: 'tmux-signing-select',
      value: chosen ? chosenName : t('shield.tmuxSigning.none'),
      desc: t('shield.tmuxSigning.description'),
      testId: 'settings-tmux-signing',
      extra: statusText
        ? html`<p class="ut-row-desc" data-testid="settings-tmux-signing-status">${statusText}</p>`
        : undefined,
      control: html`<select
        id="tmux-signing-select"
        class="ut-field ut-select w-auto"
        data-testid="settings-tmux-signing-select"
        @change=${(e: Event) => this.handleTmuxSigningChange(e.target as HTMLSelectElement)}
      >
        <option value="" ?selected=${!chosen}>${t('shield.tmuxSigning.none')}</option>
        ${identities.map(
          (identity) => html`
            <option value=${identity.hash} ?selected=${identity.hash === chosen}>
              ${identity.name}
            </option>
          `
        )}
        ${
          chosen && !identities.some((identity) => identity.hash === chosen)
            ? html`<option value=${chosen} selected>${chosen}</option>`
            : nothing
        }
      </select>`,
    });
  }

  /** From the app itself no OK is asked: the switch is the user's own tap. */
  private async handleAutoApproveToggle() {
    if (!this.serverConfigService) return;
    const next = !this.autoApprove;
    this.autoApprove = next;
    try {
      await this.serverConfigService.setAutoApprove(next);
    } catch (error) {
      logger.error('Failed to update autoApprove:', error);
      this.autoApprove = !next;
      this.dispatchEvent(new CustomEvent('error', { detail: t('autoApprove.saveFailed') }));
    }
  }

  /** Saved: the list reloads now instead of waiting out its config cache. */
  private async saveMacSessions(update: {
    macSessions?: boolean;
    macSessionsOpenMode?: MacOpenMode;
    macShare?: boolean;
    macShareLauncher?: MacShareLauncher;
  }) {
    if (!this.serverConfigService) throw new Error('no server config');
    await this.serverConfigService.updateConfig(update);
    window.dispatchEvent(new CustomEvent(MAC_SESSIONS_CHANGED_EVENT));
  }

  private async handleMacSessionsToggle() {
    if (this.macSessionsLockedBy !== null) return;
    const next = !this.macSessions;
    this.macSessions = next;
    try {
      await this.saveMacSessions({ macSessions: next });
    } catch (error) {
      logger.error('Failed to update Mac sessions:', error);
      this.macSessions = !next;
      this.dispatchEvent(new CustomEvent('error', { detail: t('macSessions.setting.saveFailed') }));
    }
  }

  private async handleMacOpenModeChange(select: HTMLSelectElement) {
    const mode: MacOpenMode = select.value === 'watch' ? 'watch' : 'control';
    const previous = this.macSessionsOpenMode;
    if (mode === previous) return;
    this.macSessionsOpenMode = mode;
    try {
      await this.saveMacSessions({ macSessionsOpenMode: mode });
    } catch (error) {
      logger.error('Failed to update how tmux sessions open:', error);
      this.macSessionsOpenMode = previous;
      select.value = previous;
      this.dispatchEvent(new CustomEvent('error', { detail: t('macSessions.setting.saveFailed') }));
    }
  }

  private async handleMacShareToggle() {
    if (this.macShareLockedBy !== null) return;
    const next = !this.macShare;
    this.macShare = next;
    try {
      await this.saveMacSessions({ macShare: next });
    } catch (error) {
      logger.error('Failed to update Share with phone:', error);
      this.macShare = !next;
      this.dispatchEvent(new CustomEvent('error', { detail: t('macSessions.setting.saveFailed') }));
    }
  }

  private async handleMacShareLauncherChange(select: HTMLSelectElement) {
    const launcher: MacShareLauncher = select.value === 'shell' ? 'shell' : 'ut';
    const previous = this.macShareLauncher;
    if (launcher === previous) return;
    this.macShareLauncher = launcher;
    try {
      await this.saveMacSessions({ macShareLauncher: launcher });
    } catch (error) {
      logger.error('Failed to update how a shared agent reopens:', error);
      this.macShareLauncher = previous;
      select.value = previous;
      this.dispatchEvent(new CustomEvent('error', { detail: t('macSessions.setting.saveFailed') }));
    }
  }

  /**
   * How the switch was forced: a command-line flag or an env variable, laid out left to right
   * on its own (in Arabic the dashes of "--no-mac-sessions" would move to its end).
   */
  private renderLock(lockedBy: string | null, testId: string) {
    const [before, how, after] = tAround(
      'macSessions.setting.locked',
      { name: lockedBy ?? '' },
      'name'
    );
    return html`<p class="ut-row-desc" data-testid=${testId}>${before}<span dir="ltr">${how}</span>${after}</p>`;
  }

  /** "Compact list" for the phone session list (utils/phone-list-layout.ts). */
  @state() private compactList = compactListOn(currentScreen(), readCompactListPref());

  private handleCompactListToggle = () => {
    this.compactList = !this.compactList;
    // An explicit choice: it sticks, whatever the screen.
    writeCompactListPref(this.compactList ? 'on' : 'off');
  };

  /** "Claude's status line in chat" (utils/claude-status-line.ts): this device only. */
  @state() private chatStatusLine = readChatStatusLinePref();

  private handleChatStatusLineToggle = () => {
    this.chatStatusLine = !this.chatStatusLine;
    writeChatStatusLinePref(this.chatStatusLine);
  };

  /** "Use the system text size" (utils/system-text-size.ts): iPhone and iPad only. */
  @state() private systemTextSize = readSystemTextSize();
  @state() private chatWidth = readChatWidth();

  private handleSystemTextSizeToggle = () => {
    this.systemTextSize = !this.systemTextSize;
    writeSystemTextSize(this.systemTextSize);
  };

  private get isNotificationsSupported(): boolean {
    return pushNotificationService.isSupported();
  }

  // ---------------------------------------------------------------------------------------
  // Building blocks (design spec 5.3, 2026-10-12): every setting is a .ut-row inside a
  // .ut-group, built by renderRow(); every on/off is the one .ut-switch.
  // ---------------------------------------------------------------------------------------

  private renderRow(row: SettingsRow) {
    const desc = this.phone && row.descShort !== undefined ? row.descShort : row.desc;
    const classes = [
      'ut-row',
      row.wide ? 'st-row--wide' : '',
      row.stack ? 'st-row--stack' : '',
      row.value !== undefined ? 'st-row--select' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return html`
      <div class=${classes} data-testid=${row.testId ?? nothing}>
        <div class="flex items-start gap-3 min-w-0">
          ${row.icon ? html`<span class="st-row-icon">${icon(row.icon)}</span>` : nothing}
          <div class="min-w-0">
            <div class="ut-row-label" id=${row.labelId ?? nothing}>
              ${row.labelFor ? html`<label for=${row.labelFor}>${row.label}</label>` : row.label}
            </div>
            ${desc ? html`<p class="ut-row-desc">${desc}</p>` : nothing}
            ${row.extra ?? nothing}
          </div>
        </div>
        ${
          row.control
            ? html`<div class="st-row-control">
                ${
                  row.value !== undefined
                    ? html`<span class="st-value" aria-hidden="true"
                        ><span class="st-value-text ut-text-action">${row.value}</span>${icon('chevronRight', 16)}</span
                      >`
                    : nothing
                }
                ${row.control}
              </div>`
            : nothing
        }
      </div>
    `;
  }

  /** Phones: the detail that used to be each row's long description, under its group. */
  private renderFooter(text: string | undefined) {
    if (!this.phone || !text) return nothing;
    return html`<p class="st-group-footer">${text}</p>`;
  }

  /** Phones: an eyebrow over a group (.ut-section-label). */
  private renderGroupLabel(text: string) {
    if (!this.phone) return nothing;
    return html`<p class="ut-section-label st-group-label">${text}</p>`;
  }

  private renderSwitch(options: {
    on: boolean;
    label?: string;
    labelledBy?: string;
    testId?: string;
    disabled?: boolean;
    onToggle: () => void;
  }) {
    return html`<button
      type="button"
      class="ut-switch"
      role="switch"
      aria-checked=${options.on ? 'true' : 'false'}
      aria-label=${options.label ?? nothing}
      aria-labelledby=${options.labelledBy ?? nothing}
      ?disabled=${options.disabled ?? false}
      data-testid=${options.testId ?? nothing}
      @click=${options.onToggle}
    ></button>`;
  }

  /** The sections this device and server have something to show in. */
  private visibleSections(): SettingsSection[] {
    return SECTIONS.filter((section) => section.id !== 'thisMac' || this.macSessionsSupported);
  }

  private get activeSection(): SettingsSectionId {
    const sections = this.visibleSections();
    return sections.some((section) => section.id === this.section) ? this.section : 'general';
  }

  private selectSection(id: SettingsSectionId) {
    this.section = id;
    try {
      localStorage.setItem(SECTION_STORAGE_KEY, id);
    } catch {
      // Storage blocked: the choice lasts until the page reloads.
    }
    if (this.phone) {
      this.phoneSection = id;
      writePhoneSection(id);
    }
    const body = this.querySelector<HTMLElement>('[data-testid="settings-body"]');
    if (body) body.scrollTop = 0;
  }

  /** Phones: back from a section to the root list. */
  private phoneBack() {
    const from = this.phoneSection;
    this.phoneSection = null;
    writePhoneSection(null);
    void this.updateComplete.then(() => {
      const body = this.querySelector<HTMLElement>('[data-testid="settings-body"]');
      if (body) body.scrollTop = 0;
      // Keyboard and screen reader users land on the row they came from.
      if (from) this.querySelector<HTMLElement>(`[data-settings-root="${from}"]`)?.focus();
    });
  }

  private handleNavKeydown(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const sections = this.visibleSections();
    const index = sections.findIndex((section) => section.id === this.activeSection);
    const next =
      sections[(index + (e.key === 'ArrowDown' ? 1 : -1) + sections.length) % sections.length];
    e.preventDefault();
    this.selectSection(next.id);
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>(`[data-settings-nav="${next.id}"]`)?.focus()
    );
  }

  private renderSectionContent(id: SettingsSectionId) {
    switch (id) {
      case 'general':
        return this.renderGeneral();
      case 'appearance':
        return this.renderAppearance();
      case 'terminal':
        return this.renderTerminal();
      case 'notifications':
        return this.renderNotificationSettings();
      case 'sessions':
        return this.renderSessions();
      case 'thisMac':
        return this.renderMacSessions();
      case 'advanced':
        return this.renderAdvanced();
    }
  }

  render() {
    if (!this.visible) return html``;
    return html`
      ${this.wide ? this.renderPanes() : this.phone ? this.renderPhone() : this.renderSheet()}
      <quick-keys-editor
        .visible=${this.showQuickKeysEditor}
        @close=${() => {
          this.showQuickKeysEditor = false;
        }}
      ></quick-keys-editor>
    `;
  }

  private renderCloseButton(extraClass = '') {
    return html`<button
      type="button"
      class="ut-icon-btn ${extraClass}"
      @click=${this.handleClose}
      title=${`${t('common.close')} (⎋)`}
      aria-label=${t('settings.close')}
      data-testid="settings-close"
    >
      ${icon('x')}
    </button>`;
  }

  private renderVersion(extraClass: string) {
    return html`<button
      type="button"
      class=${extraClass}
      data-testid="settings-version"
      title=${t('settings.version.whatsNew', { version: VERSION })}
      @click=${() => openWhatsNew()}
      @pointerdown=${this.startEdgeFixPress}
      @pointerup=${this.cancelEdgeFixPress}
      @pointercancel=${this.cancelEdgeFixPress}
      @pointerleave=${this.cancelEdgeFixPress}
      @contextmenu=${(e: Event) => e.preventDefault()}
    >
      Untether <span class="tnum">${VERSION}</span>
    </button>`;
  }

  /** ≥1024 px: a 920×640 dialog, section nav on the left, one section on the right. */
  private renderPanes() {
    const sections = this.visibleSections();
    const active = this.activeSection;
    const current = sections.find((section) => section.id === active) ?? sections[0];
    return html`
      <div class="modal-backdrop flex items-center justify-center p-4" @click=${this.handleBackdropClick}>
        <div
          class="ut-dialog ut-dialog--lg st-panes ut-surface--material"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          tabindex="-1"
          data-testid="settings-sheet"
        >
          <nav class="st-nav ut-surface--panel ut-surface--material" aria-label=${t('common.settings')} @keydown=${this.handleNavKeydown}>
            <h2 id="settings-title" class="st-nav-title">${t('common.settings')}</h2>
            ${sections.map(
              (section, index) => html`
                <button
                  type="button"
                  class="st-nav-item ut-surface--control"
                  aria-current=${section.id === active ? 'page' : nothing}
                  tabindex=${section.id === active ? '0' : '-1'}
                  data-settings-nav=${section.id}
                  data-testid="settings-nav-${section.id}"
                  @click=${() => this.selectSection(section.id)}
                >
                  <span class="st-nav-icon ut-surface--${['working', 'selected', 'ready', 'needs'][index % 4]}" aria-hidden="true">${icon(section.icon)}</span>
                  <span class="truncate">${t(section.label)}</span>
                </button>
              `
            )}
            <div class="flex-1"></div>
            ${this.renderVersion('st-version')}
          </nav>
          <div class="st-main">
            ${this.renderCloseButton('st-close')}
            <div class="st-scroll" data-testid="settings-body">
              <h3 class="st-title">${t(current.label)}</h3>
              <p class="st-subtitle">${t(current.desc)}</p>
              <div class="st-section" data-testid="settings-section-${current.id}">
                ${this.renderSectionContent(current.id)}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /** Phones and narrow windows: the single-column sheet, every section one under another. */
  private renderSheet() {
    return html`
      <div
        class="modal-backdrop flex items-stretch sm:items-center justify-center"
        @click=${this.handleBackdropClick}
      >
        <!-- Phones: full-height sheet. Larger screens: centered dialog. -->
        <div
          class="modal-content font-ui text-ui w-full h-full sm:h-auto rounded-none sm:rounded-xl border-0 sm:border sm:max-w-md lg:max-w-2xl sm:mx-4 sm:max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] overflow-hidden flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          tabindex="-1"
          style="padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px);"
          data-testid="settings-sheet"
        >
          <!-- Header (stays put while the body scrolls) -->
          <div class="ut-chrome flex items-center justify-between gap-2 pl-4 pr-2 py-2 sm:py-3 border-b border-border flex-shrink-0">
            <h2 id="settings-title" class="text-title font-semibold text-text-bright">${t('common.settings')}</h2>
            ${this.renderCloseButton('w-11 h-11')}
          </div>

          <!-- Content -->
          <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain p-4 space-y-6" data-testid="settings-body">
            ${this.visibleSections().map(
              (section) => html`
                <section class="space-y-3" data-testid="settings-section-${section.id}">
                  <h3 class="text-title font-semibold text-text-bright">${t(section.label)}</h3>
                  ${this.renderSectionContent(section.id)}
                </section>
              `
            )}
          </div>

          <!-- Footer -->
          <div class="ut-chrome px-4 py-1 border-t border-border flex-shrink-0">
            <div class="flex items-center justify-between text-caption">
              ${this.renderVersion('text-text-dim select-none min-h-[44px]')}
              <a href="/logs" class="inline-flex items-center min-h-[44px] text-primary hover:underline" target="_blank" rel="noopener">
                ${t('settings.viewLogs')}
              </a>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /** Phones: what each root row shows on its right (the current choice), if anything. */
  private rootValue(id: SettingsSectionId): string {
    switch (id) {
      case 'general':
        return LOCALE_NAMES[getLocale()];
      case 'appearance':
        return themeModeLabel(this.themeMode);
      case 'terminal': {
        const theme = TerminalPreferencesManager.getInstance().getTheme();
        if (theme === 'auto') return t('settings.themes.auto');
        const found = getTerminalTheme(theme);
        return found ? terminalThemeName(found) : '';
      }
      case 'notifications':
        if (isIOSDevice() && !isStandaloneApp()) return '';
        if (!this.isNotificationsSupported) return '';
        return this.notificationsOnHere
          ? t('settings.notifications.on')
          : t('settings.notifications.off');
      case 'sessions':
        return this.cleanupLabel(this.autoCleanupDays);
      case 'advanced':
        return VERSION;
      default:
        return '';
    }
  }

  private cleanupLabel(days: number): string {
    return days === 0
      ? t('cleanup.off')
      : days === 1
        ? t('cleanup.oneDay')
        : t('cleanup.days', { n: days });
  }

  /**
   * Phones (phone-spec §4.4, 2026-10-12): a bottom sheet with iOS navigation. The root is the
   * large title and one inset group of the sections (icon, label, current value, chevron); a
   * tap pushes that section with "‹ Ajustes" to go back. "Listo" closes, so does a swipe down
   * from the grabber. The sheet's own background covers both safe areas.
   */
  private renderPhone() {
    const sections = this.visibleSections();
    const current = this.phoneSection
      ? sections.find((section) => section.id === this.phoneSection)
      : undefined;
    return html`
      <div class="p-sheet-backdrop st-phone-backdrop" @click=${this.handleBackdropClick}></div>
      <div
        class="p-sheet open st-phone ut-surface--floating ut-surface--material ut-surface--fixed"
        role="dialog"
        aria-modal="true"
        aria-labelledby=${current ? 'settings-section-title' : 'settings-title'}
        tabindex="-1"
        data-testid="settings-sheet"
        data-page=${current?.id ?? 'root'}
      >
        <div class="ut-grabber" data-sheet-handle aria-hidden="true"></div>
        <div class="p-sheet-header st-phone-header" data-sheet-handle>
          ${
            current
              ? html`<button
                  type="button"
                  class="p-sheet-text-btn p-sheet-text-btn--start st-phone-back ut-text-action"
                  data-testid="settings-back"
                  @click=${() => this.phoneBack()}
                >
                  ${icon('chevronLeft', 22)}<span>${t('phone.settings.back')}</span>
                </button>`
              : html`<span></span>`
          }
          ${
            current
              ? html`<h2 id="settings-section-title" class="p-sheet-title">${t(current.label)}</h2>`
              : html`<span></span>`
          }
          <button
            type="button"
            class="p-sheet-text-btn p-sheet-text-btn--end ut-text-action"
            data-testid="settings-close"
            @click=${this.handleClose}
          >
            ${t('phone.settings.done')}
          </button>
        </div>
        <div class="p-sheet-body st-phone-body" data-testid="settings-body">
          ${
            current
              ? html`<div class="st-section st-phone-section" data-testid="settings-section-${current.id}">
                  ${this.renderSectionContent(current.id)}
                  ${current.id === 'advanced' ? this.renderPhoneAbout() : nothing}
                </div>`
              : html`
                  <h2 id="settings-title" class="st-large-title">${t('common.settings')}</h2>
                  <div class="ut-group st-root" data-testid="settings-root">
                    ${sections.map((section, index) => {
                      const value = this.rootValue(section.id);
                      return html`<button
                        type="button"
                        class="st-root-row ut-surface--panel ut-surface--material"
                        data-settings-root=${section.id}
                        data-testid="settings-nav-${section.id}"
                        @click=${() => this.selectSection(section.id)}
                      >
                        <span class="st-root-icon ut-surface--${['working', 'selected', 'ready', 'needs'][index % 4]}" aria-hidden="true">${icon(section.icon, 18)}</span>
                        <span class="st-root-label">${t(section.label)}</span>
                        ${value ? html`<span class="st-root-value">${value}</span>` : nothing}
                        <span class="st-root-chevron" aria-hidden="true">${icon('chevronRight', 16)}</span>
                      </button>`;
                    })}
                  </div>
                `
          }
        </div>
      </div>
    `;
  }

  /** Phones: the version (opens What's new) and the logs, at the end of Advanced. */
  private renderPhoneAbout() {
    return html`
      <div class="ut-group st-about">
        <button
          type="button"
          class="ut-row st-row--value st-about-row ut-surface--panel ut-surface--material"
          data-testid="settings-version"
          @click=${() => openWhatsNew()}
          @pointerdown=${this.startEdgeFixPress}
          @pointerup=${this.cancelEdgeFixPress}
          @pointercancel=${this.cancelEdgeFixPress}
          @pointerleave=${this.cancelEdgeFixPress}
          @contextmenu=${(e: Event) => e.preventDefault()}
        >
          <span class="flex items-center gap-3 min-w-0">
            <span class="st-row-icon">${icon('sparkles')}</span>
            <span class="ut-row-label">${t('phone.settings.version')}</span>
          </span>
          <span class="st-value"
            ><span class="st-value-text tnum ut-text-action">${VERSION}</span>${icon('chevronRight', 16)}</span
          >
        </button>
        <a
          href="/logs"
          target="_blank"
          rel="noopener"
          class="ut-row st-row--value st-about-row ut-surface--panel ut-surface--material"
          data-testid="settings-logs"
        >
          <span class="flex items-center gap-3 min-w-0">
            <span class="st-row-icon">${icon('fileText')}</span>
            <span class="ut-row-label">${t('settings.viewLogs')}</span>
          </span>
          <span class="st-value st-value--short">${icon('external', 16)}</span>
        </a>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------------------

  private renderGeneral() {
    return html`
      <div class="ut-group">
        ${this.renderRow({
          icon: 'chat',
          label: t('language.label'),
          labelFor: 'language-picker',
          desc: t('language.description'),
          descShort: '',
          value: LOCALE_NAMES[getLocale()],
          control: html`<language-picker></language-picker>`,
        })}
        ${this.renderRow({
          icon: 'folder',
          label: t('settings.repoBasePath'),
          desc: t('settings.repoBasePath.description'),
          descShort: t('settings.repoBasePath.descShort'),
          wide: true,
          control: html`
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <input
                type="text"
                .value=${this.repositoryBasePath}
                @change=${(e: Event) => this.handleRepositoryBasePathChange(e.target as HTMLInputElement)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                autocapitalize="off"
                autocorrect="off"
                spellcheck="false"
                enterkeyhint="done"
                dir="ltr"
                data-testid="settings-repo-path"
                aria-label=${t('settings.repoBasePath')}
                placeholder="~/"
                class="ut-field ut-field--mono flex-1 basis-60 min-w-0"
              />
              <span id="repository-status" class="text-caption text-text-dim tnum whitespace-nowrap">
                ${
                  this.isDiscoveringRepositories
                    ? t('settings.repoScanning')
                    : t('settings.repoCount', { count: this.repositoryCount })
                }
              </span>
              <button
                type="button"
                class="ut-icon-btn"
                @click=${() => this.discoverRepositories()}
                ?disabled=${this.isDiscoveringRepositories}
                title=${t('settings.repoRefresh')}
                aria-label=${t('settings.repoRefresh')}
              >
                ${icon('restart')}
              </button>
            </div>
          `,
        })}
      </div>
      ${this.renderFooter(t('settings.repoBasePath.description'))}
    `;
  }

  private async selectLook(id: string) {
    if ((await applyLook(id)) === 'failed') {
      this.dispatchEvent(new CustomEvent('error', { detail: t('look.loadFailed') }));
    }
  }

  /** The miniatures show live tokens: the sheets of all styles, loaded when the section opens. */
  private loadLookSheets(): boolean {
    if (!this.looksSheetsAsked) {
      this.looksSheetsAsked = true;
      void Promise.all(LOOKS.map((look) => loadLookStylesheet(look.id))).then(() => {
        this.looksReady = true;
      });
    }
    return this.looksReady;
  }
  private looksSheetsAsked = false;

  private renderAppearance() {
    const modeIcon: Record<ThemeMode, IconName> = { light: 'sun', dark: 'moon', system: 'monitor' };
    const textSize = this.renderSystemTextSize();
    return html`
      <div class="ut-group" data-testid="settings-appearance">
        ${this.renderRow({
          // Phones: a fixed icon, the mode shows in the control itself (phone-spec,
          // 2026-10-12). Desktop keeps the icon of the current mode.
          icon: this.phone ? 'sunMoon' : modeIcon[this.themeMode],
          label: t('terminalSettings.theme'),
          stack: true,
          control: renderThemeModes({
            mode: this.themeMode,
            testIdPrefix: 'settings-theme-',
            onSelect: (mode) => this.selectThemeMode(mode),
          }),
        })}
        ${this.renderRow({
          icon: this.phone ? 'palette' : 'sparkles',
          label: t('settings.accent'),
          wide: true,
          control: renderAccentSwatches({
            accent: this.accent,
            testIdPrefix: 'settings-accent-',
            onSelect: (id) => this.selectAccent(id),
          }),
        })}
        ${textSize}
        ${this.renderChatWidth()}
      </div>
      ${textSize === nothing ? nothing : this.renderFooter(t('appearance.systemTextSize.description'))}
      ${renderLookPicker({
        active: this.look,
        deviceChoice: getDeviceLook(),
        serverLook: getServerLook(),
        onSelect: (id) => void this.selectLook(id),
        onFollowServer: () => void followServerLook(),
        ready: this.loadLookSheets(),
      })}
    `;
  }

  /** "Chat width" (utils/chat-width.ts): only where the desktop chat shows, never on touch. */
  private renderChatWidth() {
    if (this.phone || detectMobile()) return nothing;
    return this.renderRow({
      icon: 'messageSquare',
      label: t('appearance.chatWidth'),
      desc: t('appearance.chatWidth.description'),
      stack: true,
      testId: 'settings-chat-width',
      control: html`<div class="ut-segmented" role="group" aria-label=${t('appearance.chatWidth')}>
        ${CHAT_WIDTHS.map(
          (width) => html`
            <button
              type="button"
              aria-pressed=${this.chatWidth === width ? 'true' : 'false'}
              data-testid="settings-chat-width-${width}"
              @click=${() => {
                this.chatWidth = width;
                writeChatWidth(width);
              }}
            >
              ${t(`appearance.chatWidth.${width}`)}
            </button>
          `
        )}
      </div>`,
    });
  }

  private renderSystemTextSize() {
    // iPhone/iPad only, and never with a mouse.
    if (!systemTextSizeSupported() || this.finePointer) return nothing;
    return this.renderRow({
      icon: 'fileText',
      label: t('appearance.systemTextSize'),
      labelId: 'settings-system-text-size-label',
      desc: t('appearance.systemTextSize.description'),
      descShort: t('appearance.systemTextSize.descShort'),
      testId: 'settings-system-text-size',
      control: this.renderSwitch({
        on: this.systemTextSize,
        labelledBy: 'settings-system-text-size-label',
        testId: 'settings-system-text-size-toggle',
        onToggle: this.handleSystemTextSizeToggle,
      }),
    });
  }

  private renderTerminal() {
    return html`
      ${this.renderGroupLabel(t('phone.settings.terminalColors'))}
      <terminal-theme-picker
        id="settings-terminal-theme"
        data-testid="settings-terminal-theme"
        .label=${t('terminalSettings.terminalTheme')}
      ></terminal-theme-picker>
      ${
        this.finePointer
          ? nothing
          : this.phone
            ? html`<div class="ut-group st-quick-keys">
                <button
                  type="button"
                  class="ut-row st-row--value st-about-row ut-surface--panel ut-surface--material"
                  data-testid="settings-quick-keys"
                  @click=${() => {
                    this.showQuickKeysEditor = true;
                  }}
                >
                  <span class="flex items-center gap-3 min-w-0">
                    <span class="st-row-icon">${icon('keyboard')}</span>
                    <span class="min-w-0">
                      <span class="ut-row-label block">${t('settings.quickKeys')}</span>
                      <span class="ut-row-desc block">${t('settings.quickKeys.descShort')}</span>
                    </span>
                  </span>
                  <span class="st-value st-value--short"
                    ><span class="st-value-text ut-text-action">${t('phone.settings.quickKeysValue')}</span
                    >${icon('chevronRight', 16)}</span
                  >
                </button>
              </div>`
            : html`<div class="ut-group mt-6">
              ${this.renderRow({
                icon: 'keyboard',
                label: t('settings.quickKeys'),
                desc: t('settings.quickKeys.description'),
                control: html`<button
                  type="button"
                  class="ut-btn ut-btn--secondary"
                  @click=${() => {
                    this.showQuickKeysEditor = true;
                  }}
                >
                  ${t('settings.quickKeys.customize')}
                </button>`,
              })}
            </div>`
      }
      ${
        // Same devices that get the strip: session-view renders <quick-actions-bar> whenever
        // uiState.isMobile (any touch device, iPads included), so the switch can't be
        // phone-only. (2026-10-20: an iPad showed the strip's slot but could never turn it on.)
        this.phone || detectMobile()
          ? html`<div class="ut-group mt-6">
              ${this.renderRow({
                icon: 'sparkles',
                label: t('settings.quickActions'),
                labelId: 'settings-quick-actions-label',
                desc: t('settings.quickActions.desc'),
                control: this.renderSwitch({
                  on: this.quickActionsOn,
                  labelledBy: 'settings-quick-actions-label',
                  testId: 'settings-quick-actions',
                  onToggle: () => {
                    this.quickActionsOn = !this.quickActionsOn;
                    setQuickActionsHidden(!this.quickActionsOn);
                  },
                }),
              })}
            </div>`
          : nothing
      }
    `;
  }

  private renderSessions() {
    const choices = [0, 1, 3, 7, 30];
    // A value set elsewhere (e.g. config.json) still shows instead of silently reading "Off".
    if (!choices.includes(this.autoCleanupDays)) choices.push(this.autoCleanupDays);
    const label = (days: number) => this.cleanupLabel(days);
    // Compact list and Claude's chat status line belong to the phone UI.
    const phone = detectMobile();
    return html`
      <div class="ut-group">
        ${this.renderRow({
          icon: 'trash',
          label: t('cleanup.label'),
          labelFor: 'auto-cleanup-select',
          desc: t('cleanup.description'),
          descShort: t('cleanup.descShort'),
          value: label(this.autoCleanupDays),
          testId: 'settings-auto-cleanup',
          control: html`<select
            id="auto-cleanup-select"
            class="ut-field ut-select w-auto"
            data-testid="settings-auto-cleanup-select"
            @change=${(e: Event) => this.handleAutoCleanupChange(e.target as HTMLSelectElement)}
          >
            ${choices.map(
              (days) => html`
                <option value=${String(days)} ?selected=${days === this.autoCleanupDays}>
                  ${label(days)}
                </option>
              `
            )}
          </select>`,
        })}
        ${
          this.shieldAvailable
            ? this.renderRow({
                icon: 'shield',
                label: t('shield.settingLabel'),
                desc: t('shield.settingDescription'),
                descShort: t('shield.settingDescShort'),
                testId: 'settings-shield-new',
                control: this.renderSwitch({
                  on: this.shieldNewSessions,
                  label: t('shield.settingLabel'),
                  testId: 'settings-shield-new-toggle',
                  onToggle: () => this.handleShieldNewSessionsToggle(),
                }),
              })
            : nothing
        }
        ${this.shieldAvailable ? this.renderTmuxSigning() : nothing}
        ${this.renderRow({
          icon: 'restart',
          label: t('claudeUpdate.label'),
          desc: t('claudeUpdate.description'),
          descShort: t('claudeUpdate.descShort'),
          testId: 'settings-restart-updated-claude',
          control: this.renderSwitch({
            on: this.restartUpdatedClaude,
            label: t('claudeUpdate.label'),
            testId: 'settings-restart-updated-claude-toggle',
            onToggle: () => this.handleRestartUpdatedClaudeToggle(),
          }),
        })}
        ${
          this.installedApp
            ? this.renderRow({
                icon: 'restart',
                label: t('appUpdate.label'),
                desc: t('appUpdate.description', { app: this.installedApp }),
                descShort: t('appUpdate.descShort'),
                testId: 'settings-auto-update-installed-app',
                control: this.renderSwitch({
                  on: this.autoUpdateInstalledApp,
                  label: t('appUpdate.label'),
                  testId: 'settings-auto-update-installed-app-toggle',
                  onToggle: () => this.handleAutoUpdateInstalledAppToggle(),
                }),
              })
            : nothing
        }
        ${this.shieldAvailable ? this.renderSuspendIdle() : nothing}
        ${this.renderRow({
          icon: 'sparkles',
          label: t('agentExplain.label'),
          desc: t('agentExplain.description'),
          descShort: t('agentExplain.descShort'),
          testId: 'settings-agent-explain',
          control: this.renderSwitch({
            on: this.agentExplain,
            label: t('agentExplain.label'),
            testId: 'settings-agent-explain-toggle',
            onToggle: () => this.handleAgentExplainToggle(),
          }),
        })}
        ${
          phone
            ? this.renderRow({
                icon: 'list',
                label: t('settings.compactList'),
                desc: t('settings.compactList.description'),
                descShort: t('settings.compactList.descShort'),
                testId: 'settings-compact-list',
                control: this.renderSwitch({
                  on: this.compactList,
                  label: t('settings.compactList'),
                  testId: 'settings-compact-list-toggle',
                  onToggle: this.handleCompactListToggle,
                }),
              })
            : nothing
        }
        ${
          phone
            ? this.renderRow({
                icon: 'chat',
                label: t('settings.chatStatusLine'),
                desc: t('settings.chatStatusLine.description'),
                descShort: t('settings.chatStatusLine.descShort'),
                testId: 'settings-chat-status-line',
                control: this.renderSwitch({
                  on: this.chatStatusLine,
                  label: t('settings.chatStatusLine'),
                  testId: 'settings-chat-status-line-toggle',
                  onToggle: this.handleChatStatusLineToggle,
                }),
              })
            : nothing
        }
      </div>
      ${this.renderFooter(t('cleanup.description'))}
      <div class="ut-group mt-6">
        ${this.renderRow({
          icon: 'circleCheck',
          label: t('autoApprove.label'),
          desc: t('autoApprove.description'),
          descShort: t('autoApprove.descShort'),
          testId: 'settings-auto-approve',
          control: this.renderSwitch({
            on: this.autoApprove,
            label: t('autoApprove.label'),
            testId: 'settings-auto-approve-toggle',
            onToggle: () => this.handleAutoApproveToggle(),
          }),
        })}
      </div>
      ${this.renderFooter(t('autoApprove.description'))}
    `;
  }

  /**
   * "Show sessions from this Mac": tmux sessions and agents running outside Untether in the
   * session list, how a tmux session opens, and "Share with phone" under it (macOS only).
   * Locked, with the reason, when the server was started with it forced.
   */
  private renderMacSessions() {
    if (!this.macSessionsSupported) return nothing;
    const on = this.macSessions;
    const locked = this.macSessionsLockedBy !== null;
    // Also right on a desktop, or before the phone's list ever answered.
    const platform = this.serverPlatform || this.configPlatform || macSessionsPlatform();
    const label = isMacPlatform(platform)
      ? t('macSessions.setting.label.mac')
      : t('macSessions.setting.label.computer');
    const shareLocked = this.macShareLockedBy !== null;
    return html`
      <div class="ut-group" data-testid="settings-mac-sessions">
        ${this.renderRow({
          icon: 'monitor',
          label,
          desc: t('macSessions.setting.description'),
          descShort: t('macSessions.setting.descShort'),
          extra: locked
            ? this.renderLock(this.macSessionsLockedBy, 'settings-mac-sessions-locked')
            : undefined,
          control: this.renderSwitch({
            on,
            label,
            disabled: locked,
            testId: 'settings-mac-sessions-toggle',
            onToggle: () => this.handleMacSessionsToggle(),
          }),
        })}
        ${
          on
            ? this.renderRow({
                icon: 'terminalStack',
                label: t('macSessions.setting.openMode'),
                labelFor: 'mac-open-mode-select',
                desc: t('macSessions.setting.openMode.description'),
                descShort: t('macSessions.setting.openMode.descShort'),
                value:
                  this.macSessionsOpenMode === 'watch'
                    ? t('macSessions.setting.openMode.watch')
                    : t('macSessions.setting.openMode.control'),
                control: html`<select
                  id="mac-open-mode-select"
                  class="ut-field ut-select w-auto"
                  data-testid="settings-mac-open-mode"
                  @change=${(e: Event) => this.handleMacOpenModeChange(e.target as HTMLSelectElement)}
                >
                  <option value="control" ?selected=${this.macSessionsOpenMode === 'control'}>
                    ${t('macSessions.setting.openMode.control')}
                  </option>
                  <option value="watch" ?selected=${this.macSessionsOpenMode === 'watch'}>
                    ${t('macSessions.setting.openMode.watch')}
                  </option>
                </select>`,
              })
            : nothing
        }
        ${
          on && this.macShareSupported
            ? this.renderRow({
                icon: 'external',
                label: t('macShare.setting.label'),
                desc: t('macShare.setting.description'),
                descShort: t('macShare.setting.descShort'),
                testId: 'settings-mac-share',
                extra: shareLocked
                  ? this.renderLock(this.macShareLockedBy, 'settings-mac-share-locked')
                  : undefined,
                control: this.renderSwitch({
                  on: this.macShare,
                  label: t('macShare.setting.label'),
                  disabled: shareLocked,
                  testId: 'settings-mac-share-toggle',
                  onToggle: () => this.handleMacShareToggle(),
                }),
              })
            : nothing
        }
        ${
          on && this.macShareSupported && this.macShare
            ? this.renderRow({
                icon: 'restart',
                label: t('macShare.setting.launcher'),
                labelFor: 'mac-share-launcher-select',
                value:
                  this.macShareLauncher === 'shell'
                    ? t('macShare.setting.launcher.shell')
                    : t('macShare.setting.launcher.ut'),
                extra: html`<p class="ut-row-desc" data-testid="settings-mac-share-launcher-hint">
                  ${t('macShare.setting.launcher.shellHint')}
                </p>`,
                control: html`<select
                  id="mac-share-launcher-select"
                  class="ut-field ut-select w-auto"
                  data-testid="settings-mac-share-launcher"
                  @change=${(e: Event) => this.handleMacShareLauncherChange(e.target as HTMLSelectElement)}
                >
                  <option value="ut" ?selected=${this.macShareLauncher === 'ut'}>
                    ${t('macShare.setting.launcher.ut')}
                  </option>
                  <option value="shell" ?selected=${this.macShareLauncher === 'shell'}>
                    ${t('macShare.setting.launcher.shell')}
                  </option>
                </select>`,
              })
            : nothing
        }
      </div>
      ${this.renderFooter(t('macSessions.setting.description'))}
    `;
  }

  private renderAdvanced() {
    const subscribed = !!this.subscription || pushNotificationService.isSubscribed();
    return html`
      <div class="ut-group">
        ${
          this.wide
            ? this.renderRow({
                icon: 'fileText',
                label: t('settings.logs'),
                desc: t('settings.logs.description'),
                control: html`<a
                  href="/logs"
                  target="_blank"
                  rel="noopener"
                  class="ut-btn ut-btn--secondary"
                  data-testid="settings-logs"
                >
                  ${t('settings.viewLogs')} ${icon('external')}
                </a>`,
              })
            : nothing
        }
        ${this.renderRow({
          icon: 'bell',
          label: t('settings.debug.title'),
          desc: t('settings.debug.description', {
            // QA 2026-10-12: the raw browser value ("default") and mid-sentence "Desactivadas".
            permission: t(
              this.permission === 'granted'
                ? 'settings.debug.permission.granted'
                : this.permission === 'denied'
                  ? 'settings.debug.permission.denied'
                  : 'settings.debug.permission.default'
            ),
            subscription: subscribed ? t('settings.debug.active') : t('settings.debug.none'),
            preference: this.notificationPreferences.enabled
              ? t('settings.debug.prefOn')
              : t('settings.debug.prefOff'),
          }),
          testId: 'settings-notification-debug',
          stack: true,
          control: html`<button
            type="button"
            class="ut-btn ut-btn--secondary"
            ?disabled=${!this.isNotificationsSupported}
            @click=${() => this.handleForceRefresh()}
          >
            ${t('settings.debug.forceRefresh')}
          </button>`,
        })}
      </div>
      <div class="ut-group">
        ${this.renderRow({
          icon: 'keyboard',
          label: t('settings.inputDiag.title'),
          labelId: 'settings-input-diag-label',
          desc: t('settings.inputDiag.description'),
          descShort: t('settings.inputDiag.descriptionShort'),
          testId: 'settings-input-diag',
          control: this.renderSwitch({
            on: inputDiagnostics.isLive,
            labelledBy: 'settings-input-diag-label',
            testId: 'settings-input-diag-switch',
            onToggle: () => {
              inputDiagnostics.setLive(!inputDiagnostics.isLive);
              this.requestUpdate();
            },
          }),
        })}
        ${this.renderRow({
          icon: 'clock',
          label: t('settings.inputDiag.keep'),
          labelId: 'settings-input-diag-keep-label',
          desc: t('settings.inputDiag.keepDescription'),
          descShort: t('settings.inputDiag.keepDescriptionShort'),
          testId: 'settings-input-diag-keep',
          control: this.renderSwitch({
            on: inputDiagnostics.isKept,
            labelledBy: 'settings-input-diag-keep-label',
            testId: 'settings-input-diag-keep-switch',
            onToggle: () => {
              inputDiagnostics.setKept(!inputDiagnostics.isKept);
              this.requestUpdate();
            },
          }),
        })}
      </div>
      ${this.renderFooter(t('settings.inputDiag.footer'))}
    `;
  }

  // ---------------------------------------------------------------------------------------
  // Notifications: one hero row (status + the one action that matters now), then the types.
  // ---------------------------------------------------------------------------------------

  private renderNotificationSettings() {
    // Any iOS browser tab (Safari, Chrome, Firefox, Edge, iPadOS desktop mode): push only
    // works once Untether is on the Home Screen, whatever isSupported() says. Chrome on
    // iOS showed "not supported" with no way forward (2026-10-02).
    if (isIOSDevice() && !isStandaloneApp()) return this.renderIOSInstallSteps();
    if (!this.isNotificationsSupported) return this.renderUnsupported();

    const on = this.notificationsOnHere;
    const blocked = this.permission === 'denied';
    const canTest = this.permission === 'granted' && !!this.subscription;
    let action: unknown;
    if (blocked) {
      action = html`<button
        type="button"
        class="ut-btn ut-btn--primary"
        data-testid="settings-notifications-action"
        @click=${() => toast({ kind: 'info', text: t('settings.notifications.blocked') })}
      >
        ${t('settings.notifications.openBrowser')}
      </button>`;
    } else if (on) {
      action = html`
        <button
          type="button"
          class="ut-btn ut-btn--ghost"
          data-testid="settings-notifications-disable"
          ?disabled=${this.isLoading}
          @click=${this.handleToggleNotifications}
        >
          ${t('settings.notifications.disable')}
        </button>
        <button
          type="button"
          class="ut-btn ut-btn--primary"
          data-testid="settings-notifications-action"
          title=${t('settings.testNotification.hint')}
          ?disabled=${this.testingNotification || !canTest}
          @click=${this.handleTestNotification}
        >
          ${this.testingNotification ? t('settings.testNotification.testing') : t('settings.notifications.test')}
        </button>
      `;
    } else {
      action = html`<button
        type="button"
        class="ut-btn ut-btn--primary"
        data-testid="settings-notifications-action"
        ?disabled=${this.isLoading}
        @click=${this.handleToggleNotifications}
      >
        ${t('settings.notifications.enable')}
      </button>`;
    }
    const status = on && !blocked;
    return html`
      <div class="ut-group">
        <div class="ut-row st-hero ut-surface--panel ut-surface--material" data-testid="settings-notifications-hero">
          <div class="flex items-center gap-3 min-w-0">
            <span class="st-hero-icon">${icon('bell', 20)}</span>
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="ut-row-label">${t('settings.notifications')}</span>
                <span class="st-pill ut-surface--badge" data-on=${status ? 'true' : 'false'} data-testid="settings-notifications-status">
                  <span class="ut-dot"></span>
                  ${status ? t('settings.notifications.on') : t('settings.notifications.off')}
                </span>
              </div>
              <p class="ut-row-desc">
                ${blocked ? t('settings.notifications.blocked') : t('settings.enableNotifications.description')}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2">${action}</div>
        </div>
      </div>
      ${
        on && !blocked
          ? html`
            <div class="ut-section-label st-group-label">${t('settings.notifications.types')}</div>
            <div class="ut-group">
              ${this.renderNotificationToggle('sessionExit', t('settings.notify.sessionExit'), t('settings.notify.sessionExit.description'), t('settings.notify.sessionExit.descShort'))}
              ${this.renderNotificationToggle('sessionStart', t('settings.notify.sessionStart'), t('settings.notify.sessionStart.description'), t('settings.notify.sessionStart.descShort'))}
              ${this.renderNotificationToggle('commandError', t('settings.notify.commandError'), t('settings.notify.commandError.description'), t('settings.notify.commandError.descShort'))}
              ${this.renderNotificationToggle('commandCompletion', t('settings.notify.commandCompletion'), t('settings.notify.commandCompletion.description'), t('settings.notify.commandCompletion.descShort'))}
              ${this.renderNotificationToggle('bell', t('settings.notify.bell'), t('settings.notify.bell.description'), t('settings.notify.bell.descShort'))}
            </div>
            ${this.renderFooter(t('settings.footer.notifyTypes'))}
            <div class="ut-section-label st-group-label">${t('settings.notificationBehavior')}</div>
            <div class="ut-group">
              ${this.renderNotificationToggle('soundEnabled', t('settings.notify.sound'), t('settings.notify.sound.description'), t('settings.notify.sound.descShort'))}
              ${this.renderNotificationToggle('vibrationEnabled', t('settings.notify.vibration'), t('settings.notify.vibration.description'), t('settings.notify.vibration.descShort'))}
            </div>
          `
          : nothing
      }
    `;
  }

  /** No push here: an insecure address (with the addresses that work) or a browser without it. */
  private renderUnsupported() {
    const { protocol, hostname, port } = window.location;
    const portPart = port ? `:${port}` : '';
    const addresses = [
      `https://${hostname}${portPart}`,
      `http://localhost${portPart}`,
      `http://127.0.0.1${portPart}`,
    ];
    return html`
      <div class="st-callout ut-surface--panel ut-surface--material" role="note" data-testid="settings-notifications-unsupported">
        <span class="st-callout-icon">${icon('info')}</span>
        <div class="min-w-0">
          ${
            window.isSecureContext
              ? html`<p class="ut-row-label">${t('settings.unsupported')}</p>`
              : html`
                <p class="ut-row-label">${t('settings.secure.required')}</p>
                <p class="ut-row-desc">
                  ${t('settings.secure.accessingVia', { origin: `${protocol}//${hostname}` })}
                  ${t('settings.secure.useInstead')}
                </p>
                <ul class="st-callout-list" dir="ltr">
                  ${addresses.map((address) => html`<li class="ut-data">${address}</li>`)}
                </ul>
              `
          }
        </div>
      </div>
    `;
  }

  /** iPhone/iPad in a browser tab: push only works once Untether is on the Home Screen. */
  private renderIOSInstallSteps() {
    const browser = iosBrowser();
    const steps = iosInstallSteps(browser, 'settings');
    return html`
      <div class="ut-group p-4" data-testid="settings-ios-install">
        <p class="ut-row-label mb-3">${t('settings.ios.installRequired')}</p>
        <ol class="space-y-3">
          ${steps.map(
            (step, index) => html`
              <li class="flex items-center gap-3">
                <span
                  class="flex-shrink-0 w-6 h-6 rounded-pill bg-bg-tertiary text-text text-caption font-semibold flex items-center justify-center"
                  aria-hidden="true"
                  >${index + 1}</span
                >
                <svg class="w-6 h-6 flex-shrink-0 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  ${step.icon}
                </svg>
                <span class="text-ui text-text min-w-0">${step.text}</span>
              </li>
            `
          )}
        </ol>
        <app-address-copy class="block mt-4" .browser=${browser}></app-address-copy>
      </div>
    `;
  }

  private renderNotificationToggle(
    key: keyof NotificationPreferences,
    label: string,
    description: string,
    short?: string
  ) {
    return this.renderRow({
      label,
      desc: description,
      descShort: short,
      control: this.renderSwitch({
        on: !!this.notificationPreferences[key],
        label,
        testId: `settings-notify-${key}`,
        onToggle: () =>
          this.handleNotificationPreferenceChange(key, !this.notificationPreferences[key]),
      }),
    });
  }
}

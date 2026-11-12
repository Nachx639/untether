/**
 * Full Header Component
 *
 * Full-width header for list view with horizontal layout
 */
import { html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { pushNotificationService } from '../services/push-notification-service.js';
import { toast } from '../utils/action-toast.js';
import { lockedThemeMode } from '../utils/look.js';
import { detectMobile } from '../utils/mobile-utils.js';
import { type ActionSheetItem, openActionSheet } from '../utils/phone-action-sheet.js';
import { menuKeyboard, positionPopover } from '../utils/popover-position.js';
import { prefersReducedMotion } from '../utils/reduced-motion.js';
import { formatShortcut } from '../utils/shortcut-label.js';
import { applyThemeMode, getThemeMode, type ThemeMode } from '../utils/theme-mode.js';
import { HeaderBase } from './header-base.js';
import { type IconName, icon } from './icons.js';
import { lookLockText } from './theme-toggle.js';
import './terminal-icon.js';
import './notification-status.js';
import './theme-toggle-icon.js';
import { openWhatsNew } from './whats-new-sheet.js';

/** The phone header's height (px) for what sticks under it (session-list's "Te necesita" strip). */
export const PHONE_HEADER_HEIGHT_VAR = '--ut-phone-header-h';

@customElement('full-header')
export class FullHeader extends HeaderBase {
  protected readonly i18n = new LocaleController(this);

  private get authMethodLabel(): string {
    switch (this.authMethod) {
      case 'password':
        return t('header.auth.password');
      case 'ssh-key':
        return t('header.auth.sshKey');
      case 'tailscale':
        return 'Tailscale';
      default:
        return t('header.auth.authenticated');
    }
  }

  render() {
    return this.isPhone() ? this.renderPhoneHeader() : this.renderDesktopHeader();
  }

  /**
   * The phone header (phone-spec 3.4, 2026-10-12): 52 px, sticky (list.css), translucent with a
   * blur, the top safe area inside its own background. The logo tile and "Untether" (no count,
   * no orange, no mono); one ⋯ that opens the action sheet. A tap on the title scrolls the list
   * to the top. The new-session "+" lives in the bottom tab bar (session-list.ts).
   */
  private renderPhoneHeader() {
    return html`
      <header
        class="app-header ut-chrome bg-bg-secondary/90 ut-phone-header ut-surface--material ut-surface--bar"
        data-testid="phone-header"
      >
        <button
          class="ut-phone-brand"
          data-testid="phone-header-title"
          aria-label=${`Untether, ${t('phone.scrollTop')}`}
          title=${t('phone.scrollTop')}
          @click=${this.scrollListToTop}
        >
          <terminal-icon size="28" aria-hidden="true"></terminal-icon>
          <span class="ut-phone-wordmark">Untether</span>
        </button>
        <button
          class="ut-icon-btn ut-phone-more"
          data-testid="phone-header-more"
          aria-label=${t('header.more')}
          aria-haspopup="dialog"
          @click=${this.openPhoneMenu}
        >
          ${icon('more', 20)}
        </button>
      </header>
    `;
  }

  /** The list back at its top: the page's scroller, and both columns of a phone on its side. */
  private scrollListToTop = () => {
    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
    const scrollers = [
      this.closest<HTMLElement>('.main-list-scroll'),
      ...document.querySelectorAll<HTMLElement>(
        '.phone-landscape .pl-main, .phone-landscape .pl-side'
      ),
    ];
    for (const scroller of scrollers) scroller?.scrollTo({ top: 0, behavior });
  };

  /** ⋯: one action sheet; "Cerrar todas" asks first (app.ts confirmDialog). */
  private openPhoneMenu = (e: Event) => {
    const opener = e.currentTarget as HTMLElement;
    const running = this.runningSessions.length;
    const groups: ActionSheetItem[][] = [
      [
        {
          label: t('appearance.title'),
          icon: 'sunMoon',
          testId: 'phone-menu-appearance',
          run: () => this.openAppearance(opener),
        },
        {
          label: t('common.settings'),
          icon: 'settings',
          testId: 'phone-menu-settings',
          run: () => this.dispatchEvent(new CustomEvent('open-settings')),
        },
        {
          label: t('history.menuItem'),
          icon: 'history',
          testId: 'phone-menu-history',
          run: () => this.dispatchEvent(new CustomEvent('open-history')),
        },
        {
          label: t('menu.browseFiles'),
          icon: 'files',
          testId: 'phone-menu-files',
          run: () => this.dispatchEvent(new CustomEvent('open-file-browser')),
        },
        {
          label: t('header.tmuxSessions'),
          icon: 'terminalStack',
          testId: 'phone-menu-tmux',
          run: () => this.handleOpenTmuxSessions(),
        },
        {
          label: t('whatsNew.menuItem'),
          icon: 'sparkles',
          testId: 'phone-menu-whats-new',
          run: () => openWhatsNew(),
        },
        ...(pushNotificationService.isSubscribed()
          ? [
              {
                label: t('notifyBanner.test.menuItem'),
                icon: 'bell' as const,
                run: () => void this.sendTestNotification(),
              },
            ]
          : []),
      ],
      this.currentUser
        ? [
            {
              label: t('header.logout'),
              icon: 'external',
              testId: 'phone-menu-logout',
              run: () => this.handleLogout(),
            },
          ]
        : [],
      running
        ? [
            {
              label: t('sessions.killAll'),
              icon: 'x',
              destructive: true,
              testId: 'kill-all-button',
              run: () => this.handleKillAll(),
            },
          ]
        : [],
    ];
    openActionSheet({
      label: t('header.more'),
      title: this.currentUser ? `${this.currentUser} · ${this.authMethodLabel}` : undefined,
      testId: 'phone-header-menu',
      opener,
      groups,
    });
  };

  /** Apariencia from the ⋯: light / dark / system (the color themes are in Settings). */
  private openAppearance(opener: HTMLElement) {
    const current = getThemeMode();
    const locked = lockedThemeMode();
    const choose = (mode: ThemeMode) => {
      applyThemeMode(mode);
      this.currentTheme = mode;
      window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: mode } }));
    };
    openActionSheet({
      label: t('appearance.title'),
      title: t('appearance.title'),
      testId: 'phone-appearance-sheet',
      opener,
      groups: [
        (
          [
            ['light', t('appearance.light'), 'sun'],
            ['dark', t('appearance.dark'), 'moon'],
            ['system', t('appearance.auto'), 'monitor'],
          ] as const
        ).map(([mode, label, name]) => ({
          label,
          icon: name,
          checked: (locked ?? current) === mode,
          testId: `phone-appearance-${mode}`,
          disabled: locked !== undefined,
          note: locked ? lookLockText(locked) : undefined,
          run: () => choose(mode),
        })),
      ],
    });
  }

  private headerObserver: ResizeObserver | null = null;
  private observedHeader: Element | null = null;

  updated(changed: Map<string | number | symbol, unknown>) {
    super.updated(changed);
    this.trackHeaderHeight();
  }

  /** --ut-phone-header-h on <html>: the strip under the header sticks below it. */
  private trackHeaderHeight() {
    const header = this.querySelector('[data-testid="phone-header"]');
    if (header === this.observedHeader) return;
    this.headerObserver?.disconnect();
    this.observedHeader = header;
    if (!header) {
      document.documentElement.style.removeProperty(PHONE_HEADER_HEIGHT_VAR);
      return;
    }
    if (typeof ResizeObserver === 'undefined') return;
    this.headerObserver ??= new ResizeObserver(() => {
      const height = this.observedHeader?.getBoundingClientRect().height ?? 0;
      document.documentElement.style.setProperty(
        PHONE_HEADER_HEIGHT_VAR,
        `${Math.round(height)}px`
      );
    });
    this.headerObserver.observe(header);
  }

  /**
   * Desktop home header (design spec 5.4, 2026-10-12): 52 px, translucent, hairline below.
   * Logo + wordmark, a search trigger for the ⌘K palette, one borderless icon group, the one
   * primary action, and the account behind an avatar. No container clips overflow, so focus
   * rings and menus are never cut.
   */
  private renderDesktopHeader() {
    return html`
      <header
        class="app-header ut-chrome ut-home-header ut-surface--material ut-surface--bar"
        data-testid="home-header"
      >
        <button
          class="ut-brand"
          title=${t('header.goHome')}
          aria-label=${t('header.goHome')}
          @click=${this.handleHomeClick}
        >
          <terminal-icon size="22" aria-hidden="true"></terminal-icon>
          <span class="ut-brand-name">Untether</span>
        </button>
        <button
          class="ut-search-trigger"
          data-testid="header-search"
          aria-label=${t('header.search')}
          title=${`${t('header.search')} (${formatShortcut('mod+k')})`}
          @click=${() => this.dispatchEvent(new CustomEvent('open-palette'))}
        >
          ${icon('search', 14)}
          <span class="ut-search-trigger-text">${t('header.search')}</span>
          <kbd class="ut-kbd">${formatShortcut('mod+k')}</kbd>
        </button>
        <span class="flex-1"></span>
        ${this.renderActions()}
      </header>
    `;
  }

  /** Phones get the phone header (a touch screen whose short side is under 600). */
  private isPhone(): boolean {
    return detectMobile() && Math.min(window.innerWidth, window.innerHeight) < 600;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this.closeAccountMenu, true);
    this.stopMenuKeyboard?.();
    this.headerObserver?.disconnect();
    this.headerObserver = null;
    this.observedHeader = null;
    document.documentElement.style.removeProperty(PHONE_HEADER_HEIGHT_VAR);
  }

  /** Sends a push through the server (POST /api/push/test), as Settings' test button does. */
  private async sendTestNotification() {
    try {
      await pushNotificationService.sendTestNotification(t('settings.testNotification.body'));
      toast({ kind: 'success', text: t('notifyBanner.test.sent') });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({ kind: 'error', text: t('notifyBanner.test.failed', { error: message }) });
    }
  }

  private renderActions() {
    return html`
      <div class="ut-toolbar" role="toolbar" aria-label=${t('header.more')}>
        ${this.iconButton({
          name: 'files',
          label: t('header.files'),
          shortcut: 'mod+o',
          testId: 'file-browser-button',
          onClick: () => this.dispatchEvent(new CustomEvent('open-file-browser')),
        })}
        ${this.iconButton({
          name: 'terminalStack',
          label: t('header.tmuxSessions'),
          testId: 'tmux-button',
          onClick: () => this.handleOpenTmuxSessions(),
        })}
        ${this.iconButton({
          name: 'history',
          label: t('header.history'),
          testId: 'history-button',
          onClick: () => this.dispatchEvent(new CustomEvent('open-history')),
        })}
        <theme-toggle-icon
          .theme=${this.currentTheme}
          @theme-changed=${(e: CustomEvent) => {
            this.currentTheme = e.detail.theme;
          }}
        ></theme-toggle-icon>
        <notification-status
          @open-settings=${() => this.dispatchEvent(new CustomEvent('open-settings'))}
        ></notification-status>
        <span class="ut-toolbar-sep" aria-hidden="true"></span>
        <button
          class="ut-btn ut-btn--primary ut-create-button"
          @click=${this.handleCreateSession}
          title=${`${t('header.newSession')} (${formatShortcut('mod+shift+n')})`}
          data-testid="create-session-button"
        >
          ${icon('plus')}<span>${t('header.newSession')}</span>
        </button>
        ${this.renderUserMenu()}
      </div>
    `;
  }

  private closeAccountMenu = (e: Event) => {
    if (!e.composedPath().some((el) => (el as HTMLElement).dataset?.accountMenu !== undefined)) {
      this.setAccountMenu(false);
    }
  };

  private stopMenuKeyboard: (() => void) | null = null;

  private setAccountMenu(open: boolean, fromKeyboard = false) {
    this.showUserMenu = open;
    document.removeEventListener('click', this.closeAccountMenu, true);
    this.stopMenuKeyboard?.();
    this.stopMenuKeyboard = null;
    if (!open) return;
    document.addEventListener('click', this.closeAccountMenu, true);
    void this.updateComplete.then(() => {
      const anchor = this.querySelector<HTMLElement>('[data-testid="account-button"]');
      const menu = this.querySelector<HTMLElement>('[data-testid="account-menu"]');
      if (!anchor || !menu) return;
      positionPopover(anchor, menu, { placement: 'bottom-end' });
      const close = () => {
        this.setAccountMenu(false);
        anchor.focus();
      };
      const stopKeys = menuKeyboard(menu, { focusFirst: fromKeyboard, onClose: close });
      const stopEscape = this.escapeCloses(close);
      this.stopMenuKeyboard = () => {
        stopKeys();
        stopEscape();
      };
    });
  }

  private accountItem(label: string, name: IconName, action: () => void, danger = false) {
    return html`<button
      class="ut-menu-item ${danger ? 'ut-menu-item--danger' : ''}"
      role="menuitem"
      tabindex="-1"
      @click=${() => {
        this.setAccountMenu(false);
        action();
      }}
    >
      ${icon(name)}<span>${label}</span>
    </button>`;
  }

  private renderUserMenu() {
    const user = this.currentUser;
    const initial = user ? user.trim().charAt(0).toUpperCase() : '';
    return html`
      <div class="user-menu-container ut-account" data-account-menu>
        <button
          class="ut-avatar"
          data-testid="account-button"
          aria-haspopup="menu"
          aria-expanded=${this.showUserMenu ? 'true' : 'false'}
          aria-label=${t('header.userMenu')}
          title=${user ? `${user} · ${this.authMethodLabel}` : t('header.userMenu')}
          @click=${(e: MouseEvent) => this.setAccountMenu(!this.showUserMenu, e.detail === 0)}
        >
          ${
            initial
              ? html`<span aria-hidden="true">${initial}</span>`
              : html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>`
          }
        </button>
        ${
          this.showUserMenu
            ? html`
              <div class="ut-menu" role="menu" data-testid="account-menu" data-account-menu>
                ${
                  user
                    ? html`
                      <div class="ut-account-who">
                        <div class="ut-account-name">${user}</div>
                        <div class="ut-account-method" data-testid="auth-method-label">
                          ${this.authMethodLabel}
                        </div>
                      </div>
                      <div class="ut-menu-sep"></div>
                    `
                    : ''
                }
                ${this.accountItem(t('whatsNew.menuItem'), 'sparkles', () => openWhatsNew())}
                ${
                  pushNotificationService.isSubscribed()
                    ? this.accountItem(t('notifyBanner.test.menuItem'), 'bell', () => {
                        void this.sendTestNotification();
                      })
                    : ''
                }
                ${
                  user
                    ? html`<div class="ut-menu-sep"></div>
                      ${this.accountItem(t('header.logout'), 'external', () => this.handleLogout(), true)}`
                    : ''
                }
              </div>
            `
            : ''
        }
      </div>
    `;
  }
}

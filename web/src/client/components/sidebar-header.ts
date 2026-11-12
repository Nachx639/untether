/**
 * Sidebar Header Component
 *
 * Compact header above the session list in split view (design spec 5.4, 2026-10-12): 44 px,
 * sidebar toggle at the far left, logo + "Untether" with the session count below, then
 * borderless [+] and [⋯]. The ⋯ menu holds Home, tmux and Close all (app.ts confirms that
 * one with confirmDialog before killing anything).
 */
import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { menuKeyboard, positionPopover } from '../utils/popover-position.js';
import { HeaderBase } from './header-base.js';
import { type IconName, icon } from './icons.js';
import './terminal-icon.js';

@customElement('sidebar-header')
export class SidebarHeader extends HeaderBase {
  protected readonly i18n = new LocaleController(this);

  @state() private menuOpen = false;
  private stopMenuKeyboard: (() => void) | null = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this.closeOnOutside, true);
    this.stopMenuKeyboard?.();
  }

  private closeOnOutside = (e: Event) => {
    if (!e.composedPath().some((el) => (el as HTMLElement).dataset?.sidebarMenu !== undefined)) {
      this.setMenu(false);
    }
  };

  private setMenu(open: boolean, fromKeyboard = false) {
    this.menuOpen = open;
    document.removeEventListener('click', this.closeOnOutside, true);
    this.stopMenuKeyboard?.();
    this.stopMenuKeyboard = null;
    if (!open) return;
    document.addEventListener('click', this.closeOnOutside, true);
    void this.updateComplete.then(() => {
      const anchor = this.querySelector<HTMLElement>('[data-testid="sidebar-more-button"]');
      const menu = this.querySelector<HTMLElement>('[data-testid="sidebar-more-menu"]');
      if (!anchor || !menu) return;
      positionPopover(anchor, menu, { placement: 'bottom-end' });
      const close = () => {
        this.setMenu(false);
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

  private menuItem(label: string, name: IconName, action: () => void, danger = false) {
    return html`<button
      class="ut-menu-item ${danger ? 'ut-menu-item--danger' : ''}"
      role="menuitem"
      tabindex="-1"
      @click=${() => {
        this.setMenu(false);
        action();
      }}
    >
      ${icon(name)}<span>${label}</span>
    </button>`;
  }

  render() {
    const running = this.runningSessions.length;
    return html`
      <div class="app-header sidebar-header ut-chrome ut-sidebar-header ut-surface--material ut-surface--bar">
        ${this.iconButton({
          name: 'sidebar',
          label: t('sidebar.collapse'),
          shortcut: 'mod+b',
          buttonId: 'toggle-sidebar',
          expanded: true,
          onClick: () => this.dispatchEvent(new CustomEvent('toggle-sidebar')),
        })}
        <button
          class="ut-brand ut-brand--sidebar"
          title=${t('header.goHome')}
          aria-label=${t('header.goHome')}
          @click=${this.handleHomeClick}
        >
          <terminal-icon size="20" aria-hidden="true"></terminal-icon>
          <span class="ut-brand-text">
            <span class="ut-brand-name">Untether</span>
            <span class="ut-brand-count" title=${t('sidebar.sessionCount', { n: running })}>
              <span class="ut-brand-count-full">${t('sidebar.sessionCount', { n: running })}</span>
              <span class="ut-brand-count-short tnum" aria-hidden="true">${running}</span>
            </span>
          </span>
        </button>
        <div class="ut-toolbar">
          ${this.iconButton({
            name: 'plus',
            label: t('header.newSession'),
            shortcut: 'mod+shift+n',
            testId: 'create-session-button',
            onClick: (e) => this.handleCreateSession(e),
          })}
          <div class="ut-account" data-sidebar-menu>
            ${this.iconButton({
              name: 'more',
              label: t('header.more'),
              testId: 'sidebar-more-button',
              hasPopup: true,
              expanded: this.menuOpen,
              onClick: (e) => this.setMenu(!this.menuOpen, e.detail === 0),
            })}
            ${
              this.menuOpen
                ? html`
                  <div class="ut-menu" role="menu" data-testid="sidebar-more-menu" data-sidebar-menu>
                    ${this.menuItem(t('header.goHome'), 'grid', () => this.handleHomeClick())}
                    ${this.menuItem(t('header.tmuxSessions'), 'terminalStack', () =>
                      this.handleOpenTmuxSessions()
                    )}
                    ${
                      this.currentUser
                        ? html`<div class="ut-menu-sep"></div>
                          <div class="ut-menu-label">${this.currentUser}</div>
                          ${this.menuItem(t('header.logout'), 'external', () => this.handleLogout())}`
                        : ''
                    }
                    ${
                      running > 0
                        ? html`<div class="ut-menu-sep"></div>
                          ${this.menuItem(t('sessions.killAll'), 'x', () => this.handleKillAll(), true)}`
                        : ''
                    }
                  </div>
                `
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }
}

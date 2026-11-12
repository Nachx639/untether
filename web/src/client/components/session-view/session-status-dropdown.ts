/**
 * Session Status Dropdown Component
 *
 * The status chip of an exited session with its actions: Reopen and Clear. The header renders
 * it only for exited sessions (the status dot by the title says the rest, 2026-10-12).
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Session } from '../../../shared/types.js';
import { LocaleController, t } from '../../i18n/index.js';
import { Z_INDEX } from '../../utils/constants.js';
import { deriveSessionStatus, statusLabel } from '../../utils/session-status.js';
import { icon } from '../icons.js';

@customElement('session-status-dropdown')
export class SessionStatusDropdown extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) session: Session | null = null;
  @property({ type: Function }) onClear?: () => void;
  /** Exited sessions: run it again (session-actions-handler handleRestartSession). */
  @property({ type: Function }) onRestart?: () => void;

  @state() private showMenu = false;
  @state() private focusedIndex = -1;
  protected readonly i18n = new LocaleController(this);

  private toggleMenu(e: Event) {
    e.stopPropagation();
    this.showMenu = !this.showMenu;
    if (!this.showMenu) {
      this.focusedIndex = -1;
    }
  }

  private handleAction(callback?: () => void) {
    if (callback) {
      // Close menu immediately
      this.showMenu = false;
      this.focusedIndex = -1;
      // Call the callback after a brief delay to ensure menu is closed
      setTimeout(() => {
        callback();
      }, 50);
    }
  }

  connectedCallback() {
    super.connectedCallback();
    // Close menu when clicking outside
    document.addEventListener('click', this.handleOutsideClick);
    // Add keyboard support
    document.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this.handleOutsideClick);
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  private handleOutsideClick = (e: MouseEvent) => {
    const path = e.composedPath();
    if (!path.includes(this)) {
      this.showMenu = false;
      this.focusedIndex = -1;
    }
  };

  private handleKeyDown = (e: KeyboardEvent) => {
    // Only handle if menu is open
    if (!this.showMenu) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      this.showMenu = false;
      this.focusedIndex = -1;
      // Focus the menu button
      const button = this.querySelector('button[data-menu-button]') as HTMLButtonElement;
      button?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.navigateMenu(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && this.focusedIndex >= 0) {
      e.preventDefault();
      this.selectFocusedItem();
    }
  };

  private navigateMenu(direction: number) {
    const menuItems = this.getMenuItems();
    if (menuItems.length === 0) return;

    // Calculate new index
    let newIndex = this.focusedIndex + direction;

    // Handle wrapping
    if (newIndex < 0) {
      newIndex = menuItems.length - 1;
    } else if (newIndex >= menuItems.length) {
      newIndex = 0;
    }

    this.focusedIndex = newIndex;

    // Focus the element
    const focusedItem = menuItems[newIndex];
    if (focusedItem) {
      focusedItem.focus();
    }
  }

  private getMenuItems(): HTMLButtonElement[] {
    if (!this.showMenu) return [];

    // Find all menu buttons
    const buttons = Array.from(this.querySelectorAll('button[data-action]')) as HTMLButtonElement[];
    return buttons.filter((btn) => btn.tagName === 'BUTTON');
  }

  private selectFocusedItem() {
    const menuItems = this.getMenuItems();
    const focusedItem = menuItems[this.focusedIndex];
    if (focusedItem) {
      focusedItem.click();
    }
  }

  private handleMenuButtonKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' && this.showMenu) {
      e.preventDefault();
      // Focus first menu item when pressing down on the menu button
      this.focusedIndex = 0;
      const menuItems = this.getMenuItems();
      if (menuItems[0]) {
        menuItems[0].focus();
      }
    }
  };

  render() {
    if (!this.session) return null;
    const status = deriveSessionStatus(this.session);
    const label = statusLabel(status, this.session);
    // A sentence-case chip (no uppercase labels), the dot from the shared status.
    return html`
      <div class="relative">
        <button
          type="button"
          class="ut-chip ut-status-chip h-6 px-2 gap-1.5 text-caption cursor-pointer border-0 ${this.showMenu ? 'is-open' : ''}"
          data-status=${status}
          @click=${this.toggleMenu}
          @keydown=${this.handleMenuButtonKeyDown}
          title=${t('status.exitedHint')}
          aria-label=${t('status.menu')}
          data-menu-button
          data-testid="session-status-chip"
          aria-haspopup="menu"
          aria-expanded=${this.showMenu ? 'true' : 'false'}
        >
          <span class="ut-dot" data-status=${status}></span>
          <span class="truncate">${label}</span>
          ${icon('chevronDown', 12)}
        </button>
        ${this.showMenu ? this.renderDropdown() : nothing}
      </div>
    `;
  }

  private renderDropdown() {
    const item = (
      action: string,
      iconName: Parameters<typeof icon>[0],
      label: string,
      callback?: () => void
    ) =>
      callback
        ? html`<button
            type="button"
            role="menuitem"
            class="ut-menu-item"
            @click=${() => this.handleAction(callback)}
            data-action=${action}
            tabindex=${this.showMenu ? '0' : '-1'}
          >
            ${icon(iconName)}<span class="truncate">${label}</span>
          </button>`
        : nothing;
    return html`
      <div
        class="ut-menu absolute right-0 top-full mt-1.5 w-max min-w-[180px]"
        role="menu"
        style="z-index: ${Z_INDEX.WIDTH_SELECTOR_DROPDOWN};"
      >
        ${item('restart', 'restart', t('status.reopen'), this.onRestart)}
        ${item('clear', 'trash', t('menu.clearSession'), this.onClear)}
      </div>
    `;
  }
}

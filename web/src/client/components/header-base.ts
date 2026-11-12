/**
 * Base functionality for header components.
 *
 * Desktop headers (full-header, sidebar-header) share one button treatment (design spec 5.4,
 * 2026-10-12): borderless `.ut-icon-btn` with the shortcut in the tooltip, sans-serif, no
 * bordered boxes and no font-mono. Use `iconButton()` so both headers stay identical. The
 * phone header keeps its own markup.
 */
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { Session } from '../../shared/types.js';
import { TIMING } from '../utils/constants.js';
import { isSuspended } from '../utils/session-suspend.js';
import { formatShortcut } from '../utils/shortcut-label.js';
import { type IconName, icon } from './icons.js';

export interface HeaderIconButton {
  name: IconName;
  label: string;
  /** e.g. 'mod+o': shown in the tooltip as ⌘O / Ctrl+O. */
  shortcut?: string;
  testId?: string;
  onClick: (e: MouseEvent) => void;
  /** Extra attributes for toggles and menus. */
  expanded?: boolean;
  hasPopup?: boolean;
  buttonId?: string;
}

export abstract class HeaderBase extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) sessions: Session[] = [];
  @property({ type: String }) currentUser: string | null = null;
  @property({ type: String }) authMethod: string | null = null;
  @property({ type: String }) currentTheme = 'system';
  @state() protected killingAll = false;
  @state() protected showUserMenu = false;

  /** One borderless header icon button (aria-label + tooltip with its shortcut). */
  protected iconButton(opts: HeaderIconButton): TemplateResult {
    const title = opts.shortcut ? `${opts.label} (${formatShortcut(opts.shortcut)})` : opts.label;
    return html`<button
      type="button"
      class="ut-icon-btn"
      aria-label=${opts.label}
      title=${title}
      data-testid=${opts.testId ?? nothing}
      data-button-id=${opts.buttonId ?? nothing}
      aria-haspopup=${opts.hasPopup ? 'menu' : nothing}
      aria-expanded=${opts.expanded === undefined ? nothing : String(opts.expanded)}
      @click=${opts.onClick}
    >
      ${icon(opts.name)}
    </button>`;
  }

  /**
   * Esc closes an open header menu wherever focus is. menuKeyboard only hears keys inside the
   * menu, and a mouse-opened menu leaves focus on the trigger (QA 2026-10-12: Esc ignored).
   * Returns the detach function.
   */
  protected escapeCloses(onClose: () => void): () => void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }

  protected get runningSessions(): Session[] {
    return this.sessions.filter((session) => session.status === 'running' || isSuspended(session));
  }

  protected handleCreateSession(e: MouseEvent) {
    // Capture button position for view transition
    const button = e.currentTarget as HTMLButtonElement;
    const rect = button.getBoundingClientRect();

    // Store position in CSS custom properties for the transition
    document.documentElement.style.setProperty('--ut-button-x', `${rect.left + rect.width / 2}px`);
    document.documentElement.style.setProperty('--ut-button-y', `${rect.top + rect.height / 2}px`);
    document.documentElement.style.setProperty('--ut-button-width', `${rect.width}px`);
    document.documentElement.style.setProperty('--ut-button-height', `${rect.height}px`);

    this.dispatchEvent(new CustomEvent('create-session'));
  }

  protected handleKillAll() {
    if (this.killingAll) return;

    this.killingAll = true;
    this.requestUpdate();

    this.dispatchEvent(new CustomEvent('kill-all-sessions'));

    // Reset after a delay to prevent multiple clicks
    window.setTimeout(() => {
      this.killingAll = false;
    }, TIMING.KILL_ALL_BUTTON_DISABLE_DURATION);
  }

  protected handleOpenTmuxSessions() {
    this.dispatchEvent(new CustomEvent('open-tmux-sessions'));
  }

  protected handleLogout() {
    this.showUserMenu = false;
    this.dispatchEvent(new CustomEvent('logout'));
  }

  protected handleHomeClick() {
    this.dispatchEvent(new CustomEvent('navigate-to-list'));
  }

  protected handleClickOutside = (e: Event) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.user-menu-container')) {
      this.showUserMenu = false;
    }
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('click', this.handleClickOutside);
    // Load saved theme preference
    const saved = localStorage.getItem('untether-theme');
    this.currentTheme = (saved as 'light' | 'dark' | 'system') || 'system';
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this.handleClickOutside);
  }
}

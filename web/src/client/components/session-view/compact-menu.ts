/**
 * Compact Menu Component
 *
 * The session header's ⋯ menu. Phones (2026-10-12, phone spec 4.2): a bottom action sheet in
 * <body> with a grabber and swipe-down, grouped [files, preview, changes, image] [select
 * text, chat/terminal, fit to screen] [share, shield] [terminate] [cancel]; also opened by
 * the action bar's ⋯ (OPEN_SESSION_MENU_EVENT). Desktop
 * (`desktop`, design spec 5.2, 2026-10-12): a 280 px .ut-menu with grouped labels (View /
 * Session / Appearance / Settings… / Terminate), positioned and clamped to the viewport with
 * positionPopover and arrow-key navigable with menuKeyboard.
 */
import { html, LitElement, nothing, render, svg, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import '../git-status-badge.js';
import type { MacModeRequest } from '../../../shared/mac-sessions.js';
import type { Session } from '../../../shared/types.js';
import { LocaleController, type MessageKey, t } from '../../i18n/index.js';
import { authClient } from '../../services/auth-client.js';
import { ACCENT_THEMES, applyAccent, getAccent } from '../../utils/accent-themes.js';
import { Z_INDEX } from '../../utils/constants.js';
import { accentFixedByLook, lockedThemeMode } from '../../utils/look.js';
import { attachedTmux } from '../../utils/mac-attach-mode.js';
import { isAttachedTmuxSession } from '../../utils/mac-sessions.js';
import { menuKeyboard, positionPopover } from '../../utils/popover-position.js';
import { canSuspend, suspendWithFeedback } from '../../utils/session-suspend.js';
import { holdSheetFocus } from '../../utils/sheet-a11y.js';
import { canMoveToUntether, canShield } from '../../utils/shield.js';
import { formatShortcut } from '../../utils/shortcut-label.js';
import { applyThemeMode } from '../../utils/theme-mode.js';
import { type IconName, icon } from '../icons.js';
import { lookLockText } from '../theme-toggle.js';
import type { Theme } from '../theme-toggle-icon.js';
import { attachSheetDrag, SHEET_GRABBER } from './session-switcher-sheet.js';

/** The action bar's ⋯ asks the header's menu to open its sheet (phones). */
export const OPEN_SESSION_MENU_EVENT = 'ut-open-session-menu';

/** Icons the shared set (components/icons.ts) lacks, drawn the same way (Lucide, 1.75). */
const localIcon = (paths: ReturnType<typeof svg>) =>
  html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const IMAGE_ICON = localIcon(
  svg`<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>`
);
const CLIPBOARD_ICON = localIcon(
  svg`<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>`
);
const WIDTH_ICON = localIcon(svg`<path d="m18 8 4 4-4 4M6 8l-4 4 4 4M2 12h20"/>`);
const SHARE_ICON = localIcon(
  svg`<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>`
);

@customElement('compact-menu')
export class CompactMenu extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) session: Session | null = null;
  @property({ type: String }) widthLabel = '';
  @property({ type: String }) widthTooltip = '';
  @property({ type: Function }) onOpenFileBrowser?: () => void;
  @property({ type: Function }) onUploadImage?: () => void;
  @property({ type: Function }) onMaxWidthToggle?: () => void;
  /** "Ajustar a la ventana" turned off: back to the width used before (else the width list). */
  @property({ type: Function }) onFitOff?: () => void;
  @property({ type: Function }) onOpenSettings?: () => void;
  @property({ type: String }) currentTheme: Theme = 'system';
  @state() private accent = getAccent();
  private handleAccentChanged = () => {
    this.accent = getAccent();
  };
  @property({ type: Function }) onTerminateSession?: () => void;
  @property({ type: Function }) onClearSession?: () => void;
  @property({ type: Boolean }) hasGitRepo = false;
  @property({ type: String }) viewMode: 'terminal' | 'worktree' = 'terminal';
  @property({ type: Function }) onToggleViewMode?: () => void;
  @property({ type: Boolean }) chatMode = false;
  @property({ type: Function }) onToggleChatMode?: () => void;
  @property({ type: Function }) onSelectText?: () => void;
  @property({ type: Function }) onShieldSession?: () => void;
  @property({ type: Function }) onShareSession?: () => void;
  @property({ type: Function }) onShowChanges?: () => void;
  /**
   * «Conversar» about this session (2026-10-13, review: the terminal view had no way in). Called
   * inside the tap itself: iOS only gives the microphone and audio there.
   */
  @property({ type: Function }) onTalk?: () => void;
  /** The desktop menu (session-header renderDesktop); phones keep the full-width list. */
  @property({ type: Boolean, reflect: true }) desktop = false;
  @property({ type: Function }) onPasteImage?: () => void;
  @property({ type: Function }) onRename?: () => void;
  /** Phones: pick a width (0 = fit the screen), for the "fit to screen" switch. */
  @property({ type: Function }) onWidthSelect?: (width: number) => void;
  /** Phones: the header shows its own Chat/Terminal toggle, so the sheet leaves it out. */
  @property({ type: Boolean }) chatToggleInHeader = false;
  /**
   * Desktop: the header's line had no room for all of the branch, the worktree chip or the
   * counts (session-header.ts fitDesktopBar), so the menu shows them, whole.
   */
  @property({ type: Boolean }) gitFolded = false;

  @state() private showMenu = false;
  private detachMenuKeys?: () => void;
  private openedFromKeyboard = false;
  protected readonly i18n = new LocaleController(this);

  private toggleMenu(e: Event) {
    e.stopPropagation();
    this.showMenu = !this.showMenu;
  }

  /** The session view asks tmux for the change (POST …/attached/:id/mode). */
  private changeAttach(change: MacModeRequest) {
    this.handleAction(() =>
      this.dispatchEvent(
        new CustomEvent<MacModeRequest>('attach-mode-change', {
          detail: change,
          bubbles: true,
          composed: true,
        })
      )
    );
  }

  /**
   * A tmux session opened from "On this Mac": watch it or type into it, and while typing,
   * which screen sets the window's size.
   */
  private renderAttachItems() {
    const tmux = this.session?.status === 'running' ? attachedTmux(this.session) : null;
    if (!tmux) return nothing;
    const item = (
      testId: string,
      icon: TemplateResult,
      label: TemplateResult | string,
      change: MacModeRequest
    ) => {
      if (this.desktop) {
        return html`<button
          type="button"
          role="menuitem"
          class="ut-menu-item"
          @click=${() => this.changeAttach(change)}
          data-testid=${testId}
        >
          ${icon}<span class="truncate">${label}</span>
        </button>`;
      }
      return this.sheetItem(testId, icon, label, () => this.changeAttach(change), {
        keepOpen: true,
      });
    };
    const size = this.desktop ? 16 : 20;
    const eye = icon('eye', size);
    if (tmux.mode === 'watch') {
      const keys = icon('keyboard', size);
      return item('compact-attach-control', keys, t('macSessions.watch.takeControl'), {
        mode: 'control',
      });
    }
    const fit = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>`;
    return html`
      ${item('compact-attach-watch', eye, t('macSessions.action.watch'), { mode: 'watch' })}
      ${
        tmux.sizing === 'here'
          ? item('compact-attach-fit', fit, t('macSessions.fit.others'), { sizing: 'others' })
          : item(
              'compact-attach-fit',
              fit,
              html`<span class="flex-1 flex flex-col">
                <span>${t('macSessions.fit.here')}</span>
                <span class="text-xs text-text-muted">${t('macSessions.fit.hereHint')}</span>
              </span>`,
              { sizing: 'here' }
            )
      }
    `;
  }

  private openPreview() {
    if (!this.session) return;
    window.dispatchEvent(
      new CustomEvent('ut-open-preview', { detail: { sessionId: this.session.id } })
    );
  }

  private handleAction(callback?: () => void) {
    if (callback && (callback === this.onUploadImage || callback === this.onPasteImage)) {
      // The file picker and the clipboard need the tap's user gesture: iOS refuses
      // input.click() / clipboard.read() run from a timer after it.
      this.showMenu = false;
      callback();
      return;
    }
    if (callback) {
      // Close menu immediately to ensure it doesn't block modals
      this.showMenu = false;
      // Call the callback after a brief delay to ensure menu is closed
      setTimeout(() => {
        callback();
      }, 50);
    }
  }

  /** Light / dark / system, picked in place: the menu stays open to compare. */
  private handleThemeChange(newTheme: Theme) {
    this.currentTheme = newTheme;
    applyThemeMode(newTheme);

    // Dispatch event
    this.dispatchEvent(
      new CustomEvent('theme-changed', {
        detail: { theme: newTheme },
        bubbles: true,
        composed: true,
      })
    );
  }

  private getThemeLabel() {
    if (this.currentTheme === 'light') return t('theme.light');
    if (this.currentTheme === 'dark') return t('theme.dark');
    return t('theme.system');
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('untether-accent-changed', this.handleAccentChanged);
    // Close menu when clicking outside
    document.addEventListener('click', this.handleOutsideClick);
    window.addEventListener(OPEN_SESSION_MENU_EVENT, this.handleOpenFromBar);
    // Load saved theme preference
    const saved = localStorage.getItem('untether-theme') as Theme | null;
    this.currentTheme = saved || 'system';
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('untether-accent-changed', this.handleAccentChanged);
    document.removeEventListener('click', this.handleOutsideClick);
    window.removeEventListener(OPEN_SESSION_MENU_EVENT, this.handleOpenFromBar);
    this.showMenu = false;
    this.removeSheet();
    this.teardownDesktopMenu();
  }

  private handleOutsideClick = (e: MouseEvent) => {
    const path = e.composedPath();
    if (!path.includes(this) && !(this.sheetHost && path.includes(this.sheetHost))) {
      this.showMenu = false;
    }
  };

  /**
   * The phone sheet lives in <body>: the session header area is transformed (sticky on iOS),
   * which would make it the containing block of a position: fixed sheet.
   */
  private sheetHost: HTMLElement | null = null;
  private releaseSheet: (() => void) | null = null;
  private sheetOpenedAt = 0;

  protected updated(): void {
    // 2026-11-03: Lit updates a removed element too. A late update of an open menu attached a
    // resize listener (desktop) or put the sheet back in <body> (phone) that nothing removed,
    // and after a test file's teardown it threw on the missing window. Removed, it stays closed
    // (disconnectedCallback) and touches nothing.
    if (!this.isConnected) return;
    if (this.desktop) {
      this.syncDesktopMenu();
      return;
    }
    if (this.showMenu) this.drawSheet();
    else this.removeSheet();
  }

  private handleOpenFromBar = () => {
    if (this.desktop || !this.isConnected) return;
    this.showMenu = true;
  };

  private closeSheet = () => {
    this.showMenu = false;
  };

  private removeSheet() {
    if (!this.sheetHost) return;
    render(nothing, this.sheetHost);
    this.sheetHost.remove();
    this.sheetHost = null;
    this.releaseSheet?.();
    this.releaseSheet = null;
  }

  private drawSheet() {
    const first = !this.sheetHost;
    if (first) {
      this.sheetHost = document.createElement('div');
      this.sheetHost.dataset.testid = 'session-menu-sheet';
      document.body.appendChild(this.sheetHost);
      this.sheetOpenedAt = Date.now();
    }
    const host = this.sheetHost as HTMLElement;
    render(this.renderSheet(), host);
    if (!first) return;
    const sheet = host.querySelector<HTMLElement>('.psr-sheet');
    if (!sheet) return;
    const trigger = this.querySelector('button[data-menu-button]');
    const releaseFocus = holdSheetFocus(sheet, this.closeSheet, trigger);
    const releaseDrag = attachSheetDrag(
      sheet,
      this.closeSheet,
      host.querySelector<HTMLElement>('.ut-session-sheet-scroll')
    );
    this.releaseSheet = () => {
      releaseFocus();
      releaseDrag();
    };
    requestAnimationFrame(() => sheet.classList.add('open'));
  }

  render() {
    if (this.desktop) return this.renderDesktop();
    return html`
      <button
        type="button"
        class="ut-icon-btn ut-ph-icon ut-surface--control"
        @click=${this.toggleMenu}
        title=${t('actionBar.moreActions')}
        aria-label=${t('menu.moreActionsMenu')}
        aria-haspopup="dialog"
        data-menu-button
        aria-expanded=${this.showMenu ? 'true' : 'false'}
      >
        ${icon('more', 20)}
      </button>
    `;
  }

  /** One 56 px sheet row: 20 px muted icon, 17 px label, optional trailing text or switch. */
  private sheetItem(
    testId: string,
    iconName: IconName | TemplateResult,
    label: string | TemplateResult,
    action: (() => void) | undefined,
    options: {
      trail?: string | TemplateResult;
      danger?: boolean;
      disabled?: boolean;
      title?: string;
      sub?: string;
      keepOpen?: boolean;
      role?: string;
      checked?: boolean;
      id?: string;
    } = {}
  ) {
    return html`<button
      type="button"
      id=${options.id ?? nothing}
      class="ut-sheet-item ${options.danger ? 'destructive' : ''} ut-surface--control"
      data-testid=${testId}
      title=${options.title ?? nothing}
      role=${options.role ?? nothing}
      aria-checked=${options.checked === undefined ? nothing : options.checked ? 'true' : 'false'}
      aria-disabled=${options.disabled ? 'true' : nothing}
      @click=${(e: Event) => {
        e.stopPropagation();
        if (options.disabled || !action) return;
        if (options.keepOpen) action();
        else this.handleAction(action);
      }}
    >
      <span class="ut-sheet-item-icon">${typeof iconName === 'string' ? icon(iconName, 20) : iconName}</span>
      <span class="ut-sheet-item-label"
        >${label}${options.sub ? html`<span class="ut-sheet-item-sub">${options.sub}</span>` : nothing}</span
      >
      ${options.trail === undefined ? nothing : html`<span class="ut-sheet-item-trail">${options.trail}</span>`}
    </button>`;
  }

  private renderSheet() {
    const session = this.session;
    const running = session?.status === 'running';
    const changes = this.changedFileCount();
    const tmux = running && session ? attachedTmux(session) : null;
    const fits = !this.widthLabel || this.widthLabel === '∞';
    const shielded = Boolean(session?.shielded) && running;
    const canShieldIt =
      !shielded && Boolean(this.onShieldSession) && !!session && canShield(session);
    const share = this.onShareSession && running && session?.source !== 'remote';
    const sw = (on: boolean) =>
      html`<span class="ut-switch" aria-hidden="true" aria-checked=${on ? 'true' : 'false'}></span>`;
    // A `ut` session in a Mac window: Llevar a Untether (2026-10-25).
    const canMoveIt = Boolean(this.onShieldSession) && !!session && canMoveToUntether(session);
    const suspendable = !!session && canSuspend(session);
    const group3 = share || shielded || canShieldIt || canMoveIt || suspendable;
    return html`
      <div
        class="psr-sheet-backdrop"
        @click=${() => {
          // The click finishing the tap that opened the sheet can land on the new backdrop.
          if (Date.now() - this.sheetOpenedAt > 400) this.closeSheet();
        }}
      ></div>
      <div
        class="psr-sheet ut-session-sheet"
        role="dialog"
        aria-modal="true"
        aria-label=${t('actionBar.moreActions')}
        id="compact-menu-panel"
      >
        <div class="ut-session-sheet-scroll">
          <div class="psr-sheet-group ut-surface--floating ut-surface--material">
            ${SHEET_GRABBER}
            ${
              this.onTalk && running
                ? this.sheetItem(
                    'voice-copilot-menu-button',
                    'mic',
                    t('copilot.open'),
                    () => {
                      this.showMenu = false;
                      this.onTalk?.();
                    },
                    { keepOpen: true, id: 'voice-copilot-menu-button' }
                  )
                : nothing
            }
            ${this.sheetItem('compact-file-browser', 'files', t('header.files'), this.onOpenFileBrowser)}
            ${
              session
                ? this.sheetItem(
                    'compact-preview',
                    'eye',
                    t('preview.title'),
                    () => this.openPreview(),
                    session.previewPorts?.length
                      ? { trail: html`<span dir="ltr">:${session.previewPorts[0].port}</span>` }
                      : {}
                  )
                : nothing
            }
            ${
              this.onShowChanges
                ? this.hasGitRepo
                  ? this.sheetItem(
                      'compact-changes',
                      'fileText',
                      t('header.changes'),
                      this.onShowChanges,
                      changes > 0
                        ? {
                            trail: html`<span
                              class="tnum"
                              data-testid="compact-changes-badge"
                              aria-label=${t('changes.badge', { count: changes })}
                              >${changes}</span
                            >`,
                          }
                        : {}
                    )
                  : this.sheetItem(
                      'compact-changes-unavailable',
                      'fileText',
                      t('header.changes'),
                      undefined,
                      { disabled: true, sub: t('changes.notARepo') }
                    )
                : nothing
            }
            ${running ? this.sheetItem('compact-upload-image', 'image', t('menu.uploadImage'), this.onUploadImage) : nothing}
            ${
              this.hasGitRepo
                ? this.sheetItem(
                    'compact-worktree-toggle',
                    'gitBranch',
                    this.viewMode === 'terminal'
                      ? t('header.showWorktrees')
                      : t('header.showTerminal'),
                    this.onToggleViewMode
                  )
                : nothing
            }
          </div>
          <div class="psr-sheet-group ut-surface--floating ut-surface--material">
            ${
              this.onSelectText
                ? this.sheetItem(
                    'compact-select-text',
                    'copy',
                    t('copyMode.menuItem'),
                    this.onSelectText
                  )
                : nothing
            }
            ${
              this.chatToggleInHeader
                ? nothing
                : this.sheetItem(
                    'compact-chat-mode-toggle',
                    this.chatMode ? 'terminal' : 'chat',
                    this.chatMode ? t('menu.terminalMode') : t('menu.chatMode'),
                    this.onToggleChatMode
                  )
            }
            ${this.sheetItem(
              'compact-fit-width',
              WIDTH_ICON,
              t('terminalSettings.fitToWindow'),
              () => (fits ? (this.onFitOff ?? this.onMaxWidthToggle)?.() : this.onWidthSelect?.(0)),
              {
                trail: sw(fits),
                role: 'switch',
                checked: fits,
                title: this.widthTooltip || undefined,
              }
            )}
            ${tmux ? this.renderAttachItems() : nothing}
          </div>
          ${
            session && group3
              ? html`<div class="psr-sheet-group ut-surface--floating ut-surface--material">
                  ${share ? this.sheetItem('compact-share-session', SHARE_ICON, t('share.menu'), this.onShareSession) : nothing}
                  ${
                    shielded || canShieldIt
                      ? this.sheetItem(
                          shielded ? 'compact-shield-info' : 'compact-shield-session',
                          'shield',
                          t('shield.shield'),
                          canShieldIt ? this.onShieldSession : undefined,
                          {
                            trail: sw(shielded),
                            role: 'switch',
                            checked: shielded,
                            disabled: shielded,
                            sub: shielded ? t('shield.info') : t('menu.shieldHelp'),
                          }
                        )
                      : nothing
                  }
                  ${
                    canMoveIt
                      ? this.sheetItem(
                          'compact-move-to-untether',
                          'shield',
                          t('moveToUntether.action'),
                          this.onShieldSession,
                          { sub: t('moveToUntether.help') }
                        )
                      : nothing
                  }
                  ${
                    suspendable
                      ? this.sheetItem(
                          'compact-suspend-session',
                          'pause',
                          t('suspend.now'),
                          () => this.suspendNow(),
                          { sub: t('suspend.nowHelp') }
                        )
                      : nothing
                  }
                </div>`
              : nothing
          }
          ${
            session
              ? html`<div class="psr-sheet-group ut-surface--floating ut-surface--material">
                  ${
                    running
                      ? this.sheetItem(
                          'compact-terminate-session',
                          'x',
                          // Only Untether's tmux client ends: the tmux session keeps running.
                          isAttachedTmuxSession(session)
                            ? t('sessions.row.disconnect')
                            : t('menu.terminateSession'),
                          this.onTerminateSession,
                          { danger: true }
                        )
                      : this.sheetItem(
                          'compact-clear-session',
                          'trash',
                          t('menu.clearSession'),
                          this.onClearSession
                        )
                  }
                </div>`
              : nothing
          }
        </div>
        <button
          type="button"
          class="psr-sheet-cancel ut-surface--floating ut-surface--material"
          data-testid="compact-menu-cancel"
          @click=${this.closeSheet}
        >
          ${t('common.cancel')}
        </button>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------------------
  // Desktop menu

  private closeDesktopMenu(focusTrigger = false) {
    this.showMenu = false;
    if (focusTrigger) this.querySelector<HTMLButtonElement>('button[data-menu-button]')?.focus();
  }

  private repositionDesktopMenu = () => {
    const panel = this.querySelector<HTMLElement>('#compact-menu-panel');
    const trigger = this.querySelector('button[data-menu-button]');
    if (!panel || !trigger) return;
    const wanted = positionPopover(trigger, panel, { placement: 'bottom-end' });
    // The session header area is transformed (sticky on iOS), which makes it the containing
    // block of position: fixed: correct by however far the menu actually landed from where
    // positionPopover put it in viewport terms (it opened off-screen to the right, 2026-10-12).
    const rect = panel.getBoundingClientRect();
    const dx = rect.left - wanted.left;
    const dy = rect.top - wanted.top;
    if (Math.abs(dx) > 0.5) panel.style.left = `${wanted.left - dx}px`;
    if (Math.abs(dy) > 0.5) panel.style.top = `${wanted.top - dy}px`;
  };

  /** While open: placed under the button (flipped/clamped), keys attached, follows resizes. */
  private syncDesktopMenu() {
    const panel = this.querySelector<HTMLElement>('#compact-menu-panel');
    if (!this.showMenu || !panel) {
      this.teardownDesktopMenu();
      return;
    }
    this.repositionDesktopMenu();
    if (this.detachMenuKeys) return;
    this.detachMenuKeys = menuKeyboard(panel, {
      focusFirst: this.openedFromKeyboard,
      onClose: () => this.closeDesktopMenu(true),
    });
    if (!this.openedFromKeyboard) panel.focus({ preventScroll: true });
    window.addEventListener('resize', this.repositionDesktopMenu);
  }

  private teardownDesktopMenu() {
    this.detachMenuKeys?.();
    this.detachMenuKeys = undefined;
    window.removeEventListener('resize', this.repositionDesktopMenu);
  }

  private openDesktopFromKeyboard = (e: KeyboardEvent) => {
    if (this.showMenu || !['ArrowDown', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    this.openedFromKeyboard = true;
    this.showMenu = true;
  };

  private renderDesktop() {
    return html`
      <div class="relative flex-shrink-0">
        <button
          type="button"
          class="ut-icon-btn ut-session-menu-trigger"
          @click=${(e: Event) => {
            this.openedFromKeyboard = false;
            this.toggleMenu(e);
          }}
          @keydown=${this.openDesktopFromKeyboard}
          title=${t('actionBar.moreActions')}
          aria-label=${t('menu.moreActionsMenu')}
          aria-haspopup="menu"
          data-menu-button
          aria-controls="compact-menu-panel"
          aria-expanded=${this.showMenu ? 'true' : 'false'}
        >
          ${icon('more')}
        </button>
        ${this.showMenu ? this.renderDesktopMenu() : nothing}
      </div>
    `;
  }

  private item(
    testId: string,
    iconName: IconName | TemplateResult,
    label: string | TemplateResult,
    action: (() => void) | undefined,
    trail: string | TemplateResult | typeof nothing = nothing,
    extra = ''
  ) {
    return html`<button
      type="button"
      role="menuitem"
      class="ut-menu-item ${extra}"
      data-testid=${testId}
      @click=${() => this.handleAction(action)}
    >
      ${typeof iconName === 'string' ? icon(iconName) : iconName}
      <span class="truncate">${label}</span>
      ${trail === nothing ? nothing : html`<span class="ut-menu-trail">${trail}</span>`}
    </button>`;
  }

  private renderDesktopMenu() {
    const session = this.session;
    const running = session?.status === 'running';
    const changes = this.changedFileCount();
    const tmux = running && session ? attachedTmux(session) : null;
    return html`
      <div
        id="compact-menu-panel"
        class="ut-content ut-menu ut-session-menu"
        role="menu"
        tabindex="-1"
        aria-label=${t('actionBar.moreActions')}
        style="z-index: ${Z_INDEX.WIDTH_SELECTOR_DROPDOWN};"
        @click=${(e: Event) => e.stopPropagation()}
      >
        ${
          this.gitFolded && session?.gitRepoPath
            ? html`<div class="ut-session-menu-git" role="none" data-testid="compact-git-summary">
                  <git-status-badge class="text-caption" .session=${session}></git-status-badge>
                </div>
                <div class="ut-menu-sep" role="separator"></div>`
            : nothing
        }
        <div class="ut-menu-label">${t('menu.group.view')}</div>
        <div class="ut-session-menu-row" role="none">
          ${icon(this.chatMode ? 'chat' : 'terminal')}
          <div class="ut-segmented flex-1" role="group" aria-label=${`${t('header.view.chat')} / ${t('header.view.terminal')}`}>
            ${(['chat', 'terminal'] as const).map((mode) => {
              const on = (mode === 'chat') === this.chatMode;
              return html`<button
                type="button"
                role="menuitemradio"
                class="flex-1"
                aria-checked=${on ? 'true' : 'false'}
                aria-pressed=${on ? 'true' : 'false'}
                data-testid="compact-view-${mode}"
                @click=${() => {
                  if (!on) this.handleAction(this.onToggleChatMode);
                }}
              >
                ${t(mode === 'chat' ? 'header.view.chat' : 'header.view.terminal')}
              </button>`;
            })}
          </div>
        </div>
        ${this.item(
          'compact-file-browser',
          'files',
          t('header.files'),
          this.onOpenFileBrowser,
          formatShortcut('mod+o')
        )}
        ${
          // «Conversar» was phone-only: the desktop ⋯ had no way to it.
          this.onTalk && running
            ? this.item('voice-copilot-menu-button', 'mic', t('copilot.open'), this.onTalk)
            : nothing
        }
        ${
          session
            ? this.item(
                'compact-preview',
                'monitor',
                t('preview.title'),
                () => this.openPreview(),
                session.previewPorts?.length
                  ? html`<span dir="ltr">:${session.previewPorts[0].port}</span>`
                  : nothing
              )
            : nothing
        }
        ${
          this.onShowChanges
            ? this.hasGitRepo
              ? this.item(
                  'compact-changes',
                  'fileText',
                  t('header.changes'),
                  this.onShowChanges,
                  changes > 0
                    ? html`<span
                        class="tnum"
                        data-testid="compact-changes-badge"
                        aria-label=${t('changes.badge', { count: changes })}
                        >${changes}</span
                      >`
                    : nothing
                )
              : html`<button
                  type="button"
                  role="menuitem"
                  class="ut-menu-item"
                  disabled
                  aria-disabled="true"
                  title=${t('changes.notARepo')}
                  data-testid="compact-changes-unavailable"
                >
                  ${icon('fileText')}<span class="truncate">${t('header.changes')}</span>
                </button>`
            : nothing
        }
        ${
          this.hasGitRepo
            ? this.item(
                'compact-worktree-toggle',
                'gitBranch',
                this.viewMode === 'terminal' ? t('header.showWorktrees') : t('header.showTerminal'),
                this.onToggleViewMode
              )
            : nothing
        }

        ${
          session
            ? html`
          <div class="ut-menu-sep" role="separator"></div>
          <div class="ut-menu-label">${t('menu.group.session')}</div>
          ${
            this.onRename
              ? this.item('compact-rename', 'pencil', t('sessions.row.rename'), this.onRename, 'F2')
              : nothing
          }
          ${
            this.onSelectText
              ? this.item('compact-select-text', 'copy', t('copyMode.menuItem'), this.onSelectText)
              : nothing
          }
          ${tmux ? this.renderAttachItems() : nothing}
          ${
            running
              ? this.item(
                  'compact-upload-image',
                  IMAGE_ICON,
                  t('menu.uploadImage'),
                  this.onUploadImage
                )
              : nothing
          }
          ${
            running && this.onPasteImage
              ? this.item(
                  'compact-paste-image',
                  CLIPBOARD_ICON,
                  t('upload.paste'),
                  this.onPasteImage
                )
              : nothing
          }
          ${this.item(
            'compact-width-settings',
            WIDTH_ICON,
            t('terminalSettings.width'),
            this.onMaxWidthToggle,
            this.widthLabel || '∞'
          )}
          ${
            this.onShareSession && running && session.source !== 'remote'
              ? this.item('compact-share-session', SHARE_ICON, t('share.menu'), this.onShareSession)
              : nothing
          }
          ${this.renderShieldRow(session)}
          ${
            canSuspend(session)
              ? this.item('compact-suspend-session', 'pause', t('suspend.now'), () =>
                  this.suspendNow()
                )
              : nothing
          }
        `
            : nothing
        }

        <div class="ut-menu-sep" role="separator"></div>
        <div class="ut-menu-label">${t('menu.group.appearance')}</div>
        <div class="ut-session-menu-row" role="none">
          ${icon(this.currentTheme === 'light' ? 'sun' : this.currentTheme === 'dark' ? 'moon' : 'monitor')}
          <div class="ut-segmented flex-1" role="group" aria-label=${t('menu.theme', { theme: this.getThemeLabel() })} data-testid="compact-theme-toggle">
            ${(['light', 'dark', 'system'] as Theme[]).map(
              (mode) => html`<button
                type="button"
                role="menuitemradio"
                class="flex-1"
                aria-checked=${(lockedThemeMode() ?? this.currentTheme) === mode ? 'true' : 'false'}
                aria-pressed=${(lockedThemeMode() ?? this.currentTheme) === mode ? 'true' : 'false'}
                ?disabled=${lockedThemeMode() !== undefined}
                title=${lockedThemeMode() ? lookLockText(lockedThemeMode() as 'light' | 'dark') : nothing}
                data-testid="compact-theme-${mode}"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this.handleThemeChange(mode);
                }}
              >
                ${t(`theme.${mode}` as MessageKey)}
              </button>`
            )}
          </div>
        </div>
        <div class="ut-session-menu-caption">${t('settings.accent')}</div>
        <div class="ut-session-menu-swatches" role="group" aria-label=${t('settings.accent')}>
          ${ACCENT_THEMES.map(
            (accent) => html`<button
              type="button"
              class="ut-session-menu-swatch"
              style="background: ${accent.color}"
              title=${t(`theme.${accent.id}` as MessageKey)}
              aria-label=${t(`theme.${accent.id}` as MessageKey)}
              aria-pressed=${this.accent === accent.id ? 'true' : 'false'}
              ?disabled=${accentFixedByLook()}
              data-testid="compact-accent-${accent.id}"
              @click=${(e: Event) => {
                e.stopPropagation();
                this.accent = accent.id;
                applyAccent(accent.id);
              }}
            ></button>`
          )}
        </div>

        <div class="ut-menu-sep" role="separator"></div>
        ${this.item(
          'compact-settings',
          'settings',
          t('menu.settings'),
          this.onOpenSettings,
          formatShortcut('mod+,')
        )}
        ${
          session
            ? html`<div class="ut-menu-sep" role="separator"></div>
              ${
                running
                  ? this.item(
                      'compact-terminate-session',
                      'x',
                      // Only Untether's tmux client ends: the tmux session keeps running.
                      isAttachedTmuxSession(session)
                        ? t('sessions.row.disconnect')
                        : t('menu.terminateSession'),
                      this.onTerminateSession,
                      nothing,
                      'ut-menu-item--danger'
                    )
                  : this.item(
                      'compact-clear-session',
                      'trash',
                      t('menu.clearSession'),
                      this.onClearSession
                    )
              }`
            : nothing
        }
      </div>
    `;
  }

  /**
   * Shield as a switch row: on (and fixed) for a shielded session, off and actionable when it
   * can be shielded. What it does is in the tooltip, not another line.
   */
  private renderShieldRow(session: Session) {
    if (this.onShieldSession && canMoveToUntether(session)) {
      return html`<button
        type="button"
        role="menuitem"
        class="ut-menu-item"
        title=${t('moveToUntether.help')}
        data-testid="compact-move-to-untether"
        @click=${() => this.handleAction(this.onShieldSession)}
      >
        ${icon('shield')}
        <span class="truncate">${t('moveToUntether.action')}</span>
      </button>`;
    }
    const shielded = Boolean(session.shielded) && session.status === 'running';
    const can = !shielded && Boolean(this.onShieldSession) && canShield(session);
    if (!shielded && !can) return nothing;
    return html`<button
      type="button"
      role="menuitemcheckbox"
      class="ut-menu-item"
      aria-checked=${shielded ? 'true' : 'false'}
      aria-disabled=${shielded ? 'true' : 'false'}
      title=${shielded ? t('shield.info') : t('menu.shieldHelp')}
      data-testid=${shielded ? 'compact-shield-info' : 'compact-shield-session'}
      @click=${() => {
        if (can) this.handleAction(this.onShieldSession);
      }}
    >
      ${icon('shield')}
      <span class="truncate">${t('shield.shield')}</span>
      <span class="ut-switch ut-menu-trail" aria-hidden="true" aria-checked=${shielded ? 'true' : 'false'}></span>
    </button>`;
  }

  /**
   * Suspend by hand (2026-10-31): the server suspends it only when nothing keeps it awake and
   * otherwise says why (a toast in the user's language). The view then shows its paused badge.
   */
  private suspendNow() {
    const session = this.session;
    if (session) void suspendWithFeedback(session, authClient.getAuthHeader());
  }

  /** Changed files as the session's git status watcher counts them (no extra request). */
  private changedFileCount(): number {
    const s = this.session;
    return (s?.gitModifiedCount ?? 0) + (s?.gitAddedCount ?? 0) + (s?.gitDeletedCount ?? 0);
  }
}

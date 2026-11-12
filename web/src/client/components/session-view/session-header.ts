/**
 * Session Header Component
 *
 * Header bar for session view with navigation, session info, status, and controls.
 * Includes back button, sidebar toggle, session details, and terminal controls.
 */
import { html, LitElement, nothing, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sessionProviderMarker } from '../../../shared/model-providers.js';
import { sessionTitle } from '../../../shared/session-title.js';
import type { Session } from '../../../shared/types.js';
import { LocaleController, t } from '../../i18n/index.js';
import { visibleSessionTitle } from '../../utils/session-title.js';
import '../clickable-path.js';
import '../inline-edit.js';
import '../notification-status.js';
import '../keyboard-capture-indicator.js';
import '../git-status-badge.js';
import { authClient } from '../../services/auth-client.js';
import { TaskStoreController } from '../../services/task-store.js';
import { toast } from '../../utils/action-toast.js';
import { isAIAssistantSession, sendAIPrompt } from '../../utils/ai-sessions.js';
import { formatActivity, sessionActivity } from '../../utils/claude-activity.js';
import { claudeWaitingLabel } from '../../utils/claude-waiting-label.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { createLogger } from '../../utils/logger.js';
import {
  macSessionsPlatform,
  macWindowLabel,
  macWindowMarkerLabel,
} from '../../utils/mac-sessions.js';
import { endsADrag } from '../../utils/pointer-drag.js';
import { deriveSessionStatus, statusLabel } from '../../utils/session-status.js';
import { ShortLandscapeController } from '../../utils/short-landscape.js';
import { formatShortcut } from '../../utils/shortcut-label.js';
import { confirmKindText } from '../../utils/task-status.js';
import { isUnread } from '../../utils/unread-tracker.js';
import { openCopilot } from '../copilot-sheet.js';
import { icon } from '../icons.js';
import { rowState } from '../phone-session-row.js';
import { closeSessionSwitcher, openSessionSwitcher } from './session-switcher-sheet.js';
import './compact-menu.js';
import '../theme-toggle-icon.js';
import './session-status-dropdown.js';

const logger = createLogger('session-header');
/** Stand-in for {kind} that splits the strip's template into its words and the reason. */
const KIND_SLOT = '\u0000';

/** Changes (a file with + and −), drawn like components/icons.ts (Lucide geometry). */
const DIFF_ICON = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M9 10h6M12 7v6M9 17h6"/>`}</svg>`;

/** The room the desktop title keeps, in em of the bar's type, before the controls fold. */
const DESKTOP_TITLE_MIN_EM = 18;
const DESKTOP_FOLD_MAX = 2;

@customElement('session-header')
export class SessionHeader extends LitElement {
  // Disable shadow DOM to use Tailwind
  /** Actions waiting for the user's OK (shown in the header, counted on the way back). */
  private readonly taskBoard = new TaskStoreController(this);

  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) session: Session | null = null;
  /**
   * Every session, as the app polls them. The app updates Session objects in place, so the
   * `session` binding alone never re-renders the header when Claude's status changes; this
   * new array each poll does.
   */
  @property({ type: Array }) sessions: Session[] = [];
  /**
   * The server's platform: a session in a terminal window is "On the Mac" on 'darwin'. Unset,
   * the platform the Mac sessions list last reported is used, so the header and the row agree.
   */
  @property({ type: String }) serverPlatform = '';
  @property({ type: Boolean }) showBackButton = true;
  @property({ type: Boolean }) showSidebarToggle = false;
  @property({ type: Boolean }) sidebarCollapsed = false;
  @property({ type: String }) widthLabel = '';
  @property({ type: String }) widthTooltip = '';
  @property({ type: Function }) onBack?: () => void;
  @property({ type: Function }) onSidebarToggle?: () => void;
  @property({ type: Function }) onOpenFileBrowser?: () => void;
  @property({ type: Function }) onMaxWidthToggle?: () => void;
  @property({ type: Function }) onFitOff?: () => void;
  @property({ type: Function }) onWidthSelect?: (width: number) => void;
  @property({ type: Function }) onOpenSettings?: () => void;
  @property({ type: String }) currentTheme = 'system';
  @property({ type: Boolean }) keyboardCaptureActive = true;
  @property({ type: Boolean }) isMobile = false;
  @property({ type: Function }) onTerminateSession?: () => void;
  @property({ type: Function }) onClearSession?: () => void;
  @property({ type: Function }) onRestartSession?: () => void;
  @property({ type: Boolean }) hasGitRepo = false;
  @property({ type: String }) viewMode: 'terminal' | 'worktree' = 'terminal';
  @property({ type: Function }) onToggleViewMode?: () => void;
  @property({ type: Boolean }) chatMode = false;
  /** The chat already docks the question card with its own eyebrow: no strip on top of it. */
  @property({ type: Boolean }) promptInChat = false;
  @property({ type: Function }) onToggleChatMode?: () => void;
  @property({ type: Function }) onSelectText?: () => void;
  @property({ type: Function }) onShieldSession?: () => void;
  @property({ type: Function }) onShareSession?: () => void;
  @property({ type: Function }) onShowChanges?: () => void;
  /** Phones: the Chat/Terminal toggle sits in the header (the ⋯ sheet then leaves it out). */
  @property({ type: Boolean }) showChatToggle = true;
  @state() private isHovered = false;
  protected readonly i18n = new LocaleController(this);
  /** A phone on its side (utils/short-landscape.ts): the header is one line. */
  private readonly shortLandscape = new ShortLandscapeController(this);

  /**
   * One line on a phone on its side (2026-10-04): title, subtitle and the folder row took three
   * lines on a Pro Max in landscape, leaving the chat about a third of the height. The title
   * keeps the folder and branch inline; the subtitle and the folder row go.
   */
  private get oneLine(): boolean {
    return this.isMobile && this.shortLandscape.value;
  }
  connectedCallback() {
    super.connectedCallback();
    // Load saved theme preference
    const saved = localStorage.getItem('untether-theme');
    this.currentTheme = (saved as 'light' | 'dark' | 'system') || 'system';
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    closeSessionSwitcher();
    this.barWidths?.disconnect();
    this.barWidths = undefined;
    this.fittedBar = null;
  }

  /** The line under the title lost part of its git pieces: the ⋯ menu shows them. */
  @state() private gitFolded = false;
  private barWidths?: ResizeObserver;
  private fittedBar: HTMLElement | null = null;

  protected updated() {
    const bar = this.isMobile ? null : this.querySelector<HTMLElement>('.ut-session-header');
    if (bar !== this.fittedBar) {
      if (this.fittedBar) this.barWidths?.unobserve(this.fittedBar);
      this.fittedBar = bar;
      if (bar && typeof ResizeObserver !== 'undefined') {
        this.barWidths ??= new ResizeObserver(() => this.fitDesktopBar());
        this.barWidths.observe(bar);
      }
    }
    this.fitDesktopBar();
  }

  /**
   * What the desktop toolbar folds when its title has no room (2026-11-12: in a task's session
   * beside the open sidebar the controls left the title a stub and its pieces painted one over
   * another). Measured on the bar itself, whatever the window, the sidebar or the style's type
   * size: `data-fold="1"` leaves the view switch and the preview as icons and takes the capture
   * toggle out; `data-fold="2"` leaves what the ⋯ menu also offers (files, changes, preview) to
   * the menu. The same controls stay in the DOM; styles/session.css hides them. And what the
   * second line could not show of its git pieces is shown, whole, at the top of the ⋯ menu.
   */
  private fitDesktopBar() {
    const bar = this.fittedBar;
    const title = bar?.querySelector<HTMLElement>('.ut-session-header-title');
    if (!bar || !title || !bar.clientWidth) return;
    const least = DESKTOP_TITLE_MIN_EM * (Number.parseFloat(getComputedStyle(bar).fontSize) || 13);
    for (let fold = 0; ; fold++) {
      if (fold) bar.dataset.fold = String(fold);
      else delete bar.dataset.fold;
      if (fold === DESKTOP_FOLD_MAX || title.clientWidth >= least) break;
    }
    // What the line could not show of the branch, the worktree chip and the counts goes to
    // the ⋯ menu (2026-11-12 review: they left the line and were nowhere).
    const line = bar.querySelector<HTMLElement>('.ut-session-header-line2');
    const pieces = line ? [...line.querySelectorAll<HTMLElement>('git-status-badge > *')] : [];
    const box = line?.getBoundingClientRect();
    const bottom = box?.height ? box.bottom : Number.POSITIVE_INFINITY;
    const cut = (el: Element | null) => !!el && el.scrollWidth > el.clientWidth + 1;
    this.gitFolded = pieces.some(
      (piece) =>
        piece.getBoundingClientRect().top >= bottom ||
        cut(piece.querySelector('.ut-mid-start')) ||
        cut(piece.querySelector('.ut-mid'))
    );
  }

  /** Other sessions waiting for you or with a reply you have not read. */
  private othersNeedingYou(): { count: number; waiting: boolean } {
    const currentId = this.session?.id;
    let count = 0;
    let waiting = false;
    for (const other of this.sessions) {
      if (other.id === currentId) continue;
      const isWaiting = rowState(other) === 'waiting';
      if (isWaiting || isUnread(other)) count++;
      waiting ||= isWaiting;
    }
    // An OK an agent waits for needs the user like a question does.
    const confirmations = this.taskBoard.confirmations.length;
    return { count: count + confirmations, waiting: waiting || confirmations > 0 };
  }

  /**
   * Badge for the way back to the list: how many other sessions need a look. Drawn inside
   * the button's corner: the title row clips anything that sticks out.
   */
  private renderNavBadge() {
    const { count, waiting } = this.othersNeedingYou();
    if (!count) return nothing;
    return html`<span
      class="ut-ph-badge ut-surface--badge"
      ?data-waiting=${waiting}
      data-testid="header-nav-badge"
      aria-hidden="true"
      >${count > 9 ? '9+' : count}</span
    >`;
  }

  private navLabel(base: string): string {
    const { count } = this.othersNeedingYou();
    return count ? `${base} (${t('header.othersNeedYou', { n: count })})` : base;
  }

  /** The given platform, else the one the Mac sessions list last reported on this device. */
  private get platform(): string | null {
    return this.serverPlatform || macSessionsPlatform();
  }

  /**
   * Opened with ut in a terminal window on this computer: where it runs ("On the Mac ·
   * Terminal"), worded as its row in the list. It is controlled here like any session, but
   * lives in that window.
   */
  private macWindowLabel(session: Session): string | null {
    return session.macWindow ? macWindowLabel(session.macWindow, this.platform) : null;
  }

  private renderMacWindowMarker(session: Session, className = '') {
    if (!session.macWindow) return nothing;
    const label = macWindowMarkerLabel(this.platform);
    return html`<span
      class=${className}
      data-testid="header-mac-window-badge"
      role="img"
      aria-label=${label}
      title=${label}
      >🖥 </span
    >`;
  }

  /**
   * Phone title (phone spec 3.4, 2026-10-12): the title the user gave it, else Claude's
   * conversation title (the session name is often just "claude (~/Projects)"), 17/600 sans on
   * one line, and under it one status caption (13 px): the status dot from
   * deriveSessionStatus and what Claude is doing, what it waits for (attention), or where it
   * runs. Short landscape and keyboard-up drop the caption (CSS). Tap: the session switcher.
   */
  /**
   * An orchestrator's project icon next to its title (2026-10-20), in the terminal and the chat
   * alike: the same header shows both. None for other sessions, or until the icon has loaded.
   */
  private renderProjectIcon(session: Session) {
    const repoPath = this.taskBoard.orchestrators.find(
      (entry) => entry.sessionId === session.id
    )?.repoPath;
    const url = repoPath ? this.taskBoard.iconFor(repoPath) : null;
    if (!url) return nothing;
    return html`<img
      class="ut-ph-title-icon"
      src=${url}
      alt=""
      aria-hidden="true"
      data-testid="header-project-icon"
    />`;
  }

  private renderPhoneTitle(session: Session) {
    const status = deriveSessionStatus(session);
    const command = Array.isArray(session.command) ? session.command.join(' ') : '';
    const conversation = sessionTitle(session);
    const title = conversation || session.name || command;
    const name = session.name || command;
    const where = this.macWindowLabel(session);
    let caption: unknown = statusLabel(status, session);
    if (status === 'needs-input') {
      // What it waits for is spelled out in the strip under the header.
      caption = t('status.needsInput');
    } else if (status === 'working') {
      const activity = sessionActivity(session);
      if (activity) {
        caption = html`<bdi>${formatActivity(activity)}</bdi>${
          activity.since
            ? html` · <claude-activity-elapsed since=${activity.since}></claude-activity-elapsed>`
            : nothing
        }`;
      }
    } else if (status === 'idle' && where) {
      caption = html`<span data-testid="header-mac-window">${where}</span>`;
    } else if (status === 'idle' && conversation && name && name !== conversation) {
      caption = name;
    }
    const label = statusLabel(status, session);
    return html`
      <button
        type="button"
        class="ut-ph-title"
        data-testid="header-phone-title"
        aria-haspopup="dialog"
        aria-label=${`${where ? `${title}, ${where}` : title}, ${label} — ${t('switcher.title')}`}
        @click=${() => this.openSwitcher(session)}
      >
        <span class="ut-ph-title-line">
          ${this.renderProjectIcon(session)}
          <span
            class="ut-dot ut-ph-title-dot"
            data-status=${status}
            data-testid="header-status-dot"
            aria-hidden="true"
          ></span>
          ${
            session.macWindow
              ? html`<span
                  class="ut-ph-title-flag"
                  data-testid="header-mac-window-badge"
                  role="img"
                  aria-label=${macWindowMarkerLabel(this.platform)}
                  title=${macWindowMarkerLabel(this.platform)}
                  >${icon('monitor', 14)}</span
                >`
              : nothing
          }
          <span class="ut-ph-title-text" title=${title}><bdi>${title}</bdi></span>
          ${
            session.shielded
              ? html`<span
                  class="ut-ph-title-flag ut-ph-shield"
                  data-testid="header-shield-badge"
                  role="img"
                  aria-label=${t('shield.badge')}
                  title=${t('shield.info')}
                  >${icon('shield', 14)}</span
                >`
              : nothing
          }
          <span class="ut-ph-title-chevron" aria-hidden="true">${icon('chevronDown', 14)}</span>
        </span>
        <span
          class="ut-ph-caption"
          data-status=${status}
          data-testid=${status === 'needs-input' || status === 'working' ? 'header-claude-status' : nothing}
          ><bdi>${caption}</bdi></span
        >
      </button>
    `;
  }

  /**
   * Waiting for an answer: a full-width 44 px amber strip under the header with what Claude
   * asks and Responder, which opens the reply sheet (the same event the list rows use).
   */
  private renderNeedsYouStrip(session: Session) {
    if (deriveSessionStatus(session) !== 'needs-input') return nothing;
    // 2026-10-12 (QA móvil): the strip repeated "Claude te necesita" right above the chat's
    // docked prompt card; the header caption still says "Te necesita".
    if (this.promptInChat) return nothing;
    const reason = claudeWaitingLabel(session.claudeStatus?.waitingFor);
    // 2026-10-12 (QA): on 320-393 pt the strip cut off the reason ("Claude te necesita ·
    // Petició…") although the header caption already says "Te necesita". The template's words
    // around {kind} are affixes that a narrow strip hides (container query in session.css).
    const [before = '', after = ''] = reason
      ? t('phone.prompt.eyebrow', { kind: KIND_SLOT }).split(KIND_SLOT)
      : [];
    const text = reason
      ? html`<span class="ut-ph-strip-affix">${before}</span>${reason}<span
            class="ut-ph-strip-affix"
            >${after}</span
          >`
      : t('phone.needsYouBanner');
    const open = () =>
      window.dispatchEvent(
        new CustomEvent('ut-open-answer-sheet', { detail: { sessionId: session.id } })
      );
    return html`<div class="ut-ph-strip ut-surface--panel ut-surface--material" role="status" data-testid="header-needs-you-strip">
      <span class="ut-ph-strip-text"><bdi>${text}</bdi></span>
      <button
        type="button"
        class="ut-ph-strip-btn ut-surface--control"
        data-testid="header-needs-you-reply"
        @click=${open}
      >
        ${t('phone.reply')}
      </button>
    </div>`;
  }

  /** Jump to another running session without going back to the list; rename lives here too. */
  private openSwitcher(session: Session) {
    openSessionSwitcher({
      current: session,
      sessions: this.sessions.length ? this.sessions : [session],
      onSelect: (target) =>
        this.dispatchEvent(
          new CustomEvent('navigate-to-session', {
            detail: { sessionId: target.id },
            bubbles: true,
            composed: true,
          })
        ),
      rename:
        session.status === 'exited'
          ? undefined
          : { value: visibleSessionTitle(session), save: (name) => this.saveTitle(name) },
      onResetTitle:
        session.status !== 'exited' && session.userTitle
          ? () => this.handleRetitle(null)
          : undefined,
      onUpdateTitle:
        session.status !== 'exited' && isAIAssistantSession(session)
          ? () => this.handleMagicButton()
          : undefined,
    });
  }

  /**
   * Phones rename in the switcher sheet, inline: the inline editor's pencil is too small to
   * hit. It renames the title on screen (the user's title over Claude's), not the generated
   * session name. Resolves to the error to show in the field, if the save failed.
   */
  private saveTitle(name: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const taken = this.handleRetitle(name, (result) =>
        resolve(
          result.success || !result.error
            ? undefined
            : t('toast.renameFailed', { error: result.error })
        )
      );
      if (!taken) resolve(undefined);
    });
  }

  /**
   * Ask the session view to save the user's title (null: back to the automatic one). With
   * `done`, the caller shows the outcome itself (the view then shows no error toast). Returns
   * whether a listener took the request (it cancels the event), so `done` will be called.
   */
  private handleRetitle(
    userTitle: string | null,
    done?: (result: { success: boolean; error?: string }) => void
  ): boolean {
    if (!this.session) return false;
    const event = new CustomEvent('session-retitle', {
      detail: { sessionId: this.session.id, userTitle, done },
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    this.dispatchEvent(event);
    return event.defaultPrevented;
  }

  private previewTouchedAt = 0;

  private renderPreviewChip() {
    const ports = this.session?.previewPorts;
    if (!this.session || !ports?.length) return nothing;
    const sessionId = this.session.id;
    const open = () =>
      window.dispatchEvent(
        new CustomEvent('ut-open-preview', { detail: { sessionId, port: ports[0].port } })
      );
    return html`<button
      class="ut-preview-chip flex-shrink-0 ut-surface--control"
      data-testid="preview-chip"
      aria-label=${t('preview.title')}
      title=${`${t('preview.title')} · localhost:${ports[0].port}`}
      @pointerup=${(e: PointerEvent) => {
        if (e.pointerType === 'mouse') return;
        // A drag that started on the chip ends here too: not a tap.
        if (endsADrag(e)) return;
        this.previewTouchedAt = Date.now();
        swallowNextClick();
        open();
      }}
      @click=${() => {
        if (Date.now() - this.previewTouchedAt < 700) return;
        open();
      }}
    >
      <svg class="ut-preview-chip-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" />
      </svg>
      <span class="ut-preview-chip-label">${t('preview.title')}</span>
    </button>`;
  }

  render() {
    if (!this.session) return null;
    if (!this.isMobile) return this.renderDesktop(this.session);

    const session = this.session;
    // The way back to the list. A phone has one list, the home: the app passes showBackButton
    // and no sidebar toggle, so "‹ Sesiones" goes home (2026-10-12, user request: back from a terminal
    // must land on the home control center). A narrow non-phone window (a small iPad split)
    // still opens the sidebar over the session.
    const toList =
      this.showSidebarToggle && this.sidebarCollapsed
        ? () => this.onSidebarToggle?.()
        : this.showBackButton
          ? () => this.onBack?.()
          : null;
    const backLabel = t('phone.back.sessions');
    return html`
      <div
        class="ut-ph-header session-header-container ut-chrome ut-surface--material ut-surface--bar"
        data-testid="session-header-bar"
        ?data-one-line=${this.oneLine}
      >
        ${
          toList
            ? html`<button
                type="button"
                class="ut-ph-back"
                @click=${toList}
                title=${backLabel}
                aria-label=${this.navLabel(backLabel)}
                aria-expanded=${this.showSidebarToggle && this.sidebarCollapsed ? 'false' : nothing}
                aria-controls=${this.showSidebarToggle && this.sidebarCollapsed ? 'sidebar' : nothing}
                data-testid=${this.showSidebarToggle && this.sidebarCollapsed ? 'session-sidebar-toggle' : 'session-back-button'}
              >
                ${icon('chevronLeft', 22)}
                <span class="ut-ph-back-label" aria-hidden="true">${backLabel}</span>
                ${this.renderNavBadge()}
              </button>`
            : nothing
        }
        <div class="ut-ph-title-wrap" data-testid="session-title-container">
          ${this.renderPhoneTitle(session)}
        </div>
        <div class="ut-ph-actions">
          ${this.renderPreviewChip()}
          ${
            this.showChatToggle
              ? html`<button
                  type="button"
                  class="ut-icon-btn ut-ph-icon ut-surface--control"
                  aria-pressed=${this.chatMode ? 'true' : 'false'}
                  @click=${() => this.onToggleChatMode?.()}
                  title=${this.chatMode ? t('header.switchToTerminal') : t('header.switchToChat')}
                  aria-label=${t('header.view.chat')}
                  data-testid="chat-mode-toggle-button-compact"
                >
                  ${icon('chat', 20)}
                </button>`
              : nothing
          }
          <compact-menu
            .session=${session}
            .widthLabel=${this.widthLabel}
            .widthTooltip=${this.widthTooltip}
            .onOpenFileBrowser=${this.onOpenFileBrowser}
            .onUploadImage=${() => this.handleMobileUploadImage()}
            .onMaxWidthToggle=${this.onMaxWidthToggle}
            .onFitOff=${this.onFitOff}
            .onWidthSelect=${this.onWidthSelect}
            .onOpenSettings=${this.onOpenSettings}
            .currentTheme=${this.currentTheme}
            .onTerminateSession=${this.onTerminateSession}
            .onClearSession=${this.onClearSession}
            .hasGitRepo=${this.hasGitRepo}
            .viewMode=${this.viewMode}
            .onToggleViewMode=${() => this.dispatchEvent(new CustomEvent('toggle-view-mode'))}
            .chatMode=${this.chatMode}
            .chatToggleInHeader=${this.showChatToggle}
            .onTalk=${() => openCopilot({ mode: 'session', sessionId: session.id })}
            .onToggleChatMode=${this.onToggleChatMode}
            .onSelectText=${this.onSelectText}
            .onShieldSession=${this.onShieldSession}
            .onShareSession=${this.onShareSession}
            .onShowChanges=${this.onShowChanges}
            @theme-changed=${(e: CustomEvent) => {
              this.currentTheme = e.detail.theme;
            }}
          ></compact-menu>
        </div>
      </div>
      ${this.renderNeedsYouStrip(session)} ${this.renderConfirmStrip()}
    `;
  }

  /**
   * An action an agent asked the user's OK for, wherever the user is (2026-10-20: inside the
   * orchestrator's own session nothing showed it; only its push and the list's top strip did).
   */
  private renderConfirmStrip() {
    const confirmations = this.taskBoard.confirmations;
    if (!confirmations.length) return nothing;
    // The newest first: it is the one the agent is talking about.
    const newest = confirmations.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    const more = confirmations.length > 1 ? ` (+${confirmations.length - 1})` : '';
    const open = () =>
      window.dispatchEvent(new CustomEvent('ut-open-task-confirm', { detail: { id: newest.id } }));
    return html`<div class="ut-ph-strip ut-surface--panel ut-surface--material" role="status" data-testid="header-confirm-strip">
      <span class="ut-ph-strip-text"
        ><bdi
          >${t('board.confirmPill', { where: newest.where })} ·
          ${confirmKindText(newest.kind)}${more}</bdi
        ></span
      >
      <button
        type="button"
        class="ut-ph-strip-btn ut-surface--control"
        data-testid="header-confirm-open"
        @click=${open}
      >
        ${t('notify.open')}
      </button>
    </div>`;
  }

  /** Opens the ⋯ menu's rename: the inline editor in the title (F2 also works there). */
  private startRename() {
    const editor = this.querySelector('inline-edit') as
      | (HTMLElement & { startEdit?: () => void })
      | null;
    editor?.startEdit?.();
  }

  /**
   * The desktop toolbar (design spec 5.2, 2026-10-12): one 44 px row at every width, on
   * --ut-session-bar with a hairline under it. Left: sidebar toggle, status dot, title,
   * shield, what the agent waits for; under it the path, branch chip and diff counts. Right:
   * Chat | Terminal, files, changes, then ⋯ with everything else. No bordered boxes, no
   * orange text, no status pill: the dot and the title say it. Phones keep their own header.
   */
  private renderDesktop(session: Session) {
    const status = deriveSessionStatus(session);
    const label = statusLabel(status, session);
    const waiting = status === 'needs-input';
    const waitingFor = waiting
      ? claudeWaitingLabel(session.claudeStatus?.waitingFor) || t('status.needsInput')
      : '';
    const provider = sessionProviderMarker(session);
    const command = Array.isArray(session.command) ? session.command.join(' ') : session.command;
    const sidebarShortcut = formatShortcut('mod+b');
    const filesShortcut = formatShortcut('mod+o');
    const changes = this.changedFileCount();
    return html`
      <div
        class="ut-session-header session-header-container ut-chrome ut-surface--material ut-surface--bar"
        data-testid="session-header-bar"
      >
        ${
          this.showSidebarToggle
            ? html`<button
                type="button"
                class="ut-icon-btn"
                @click=${() => this.onSidebarToggle?.()}
                title=${`${t('header.toggleSidebar')} (${sidebarShortcut})`}
                aria-label=${this.navLabel(t('header.toggleSidebar'))}
                aria-expanded=${this.sidebarCollapsed ? 'false' : 'true'}
                aria-controls="sidebar"
                data-testid="session-sidebar-toggle"
              >
                ${icon('sidebar')}
                ${this.othersNeedingYou().count ? html`<span class="ut-badge-dot ut-session-header-nav-dot" data-testid="header-nav-badge" aria-hidden="true"></span>` : nothing}
              </button>`
            : nothing
        }
        ${
          this.showBackButton
            ? html`<button
                type="button"
                class="ut-icon-btn"
                @click=${() => this.onBack?.()}
                title=${t('header.back')}
                aria-label=${this.navLabel(t('header.back'))}
                data-testid="session-back-button"
              >
                ${icon('chevronLeft')}
              </button>`
            : nothing
        }
        <div class="ut-session-header-title" data-testid="session-title-container">
          <div
            class="ut-session-header-line1"
            @mouseenter=${this.handleMouseEnter}
            @mouseleave=${this.handleMouseLeave}
          >
            <span
              class="ut-dot"
              data-status=${status}
              data-testid="header-status-dot"
              role="img"
              aria-label=${label}
              title=${label}
            ></span>
            ${this.renderMacWindowMarker(session, 'flex-shrink-0 text-caption')}
            <inline-edit
              class="ut-session-header-name"
              .value=${visibleSessionTitle(session)}
              .placeholder=${command}
              .onSave=${(newName: string) => this.handleRetitle(newName.trim() || null)}
            ></inline-edit>
            ${
              session.shielded
                ? html`<span
                    class="ut-session-header-shield"
                    data-testid="header-shield-badge"
                    role="img"
                    aria-label=${t('shield.badge')}
                    title=${t('shield.info')}
                    >${icon('shield', 14)}</span
                  >`
                : nothing
            }
            ${
              provider
                ? html`<span
                    class="ut-chip ut-chip--mono"
                    data-testid="header-provider-badge"
                    title=${`${provider.id} · ${provider.model}`}
                    ><span class="truncate min-w-0">${provider.id} · ${provider.model}</span></span
                  >`
                : nothing
            }
            ${
              waiting
                ? html`<span
                    class="ut-session-header-waiting"
                    data-testid="header-claude-status"
                    title=${label}
                    >· ${waitingFor}</span
                  >`
                : nothing
            }
            ${
              isAIAssistantSession(session)
                ? html`<button
                    type="button"
                    class="ut-icon-btn ut-icon-btn--sm magic-button ${this.isHovered ? 'is-visible' : ''}"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      this.handleMagicButton();
                    }}
                    title=${t('header.updateTitle')}
                    aria-label=${t('header.updateTitle')}
                  >
                    ${icon('sparkles', 14)}
                  </button>`
                : nothing
            }
          </div>
          <div class="ut-session-header-line2" data-testid="session-details">
            <clickable-path
              class="ut-session-header-path"
              variant="middle"
              .path=${session.workingDir}
              .iconSize=${12}
            ></clickable-path>
            ${
              session.gitRepoPath
                ? html`<git-status-badge
                    class="text-caption"
                    .session=${session}
                    .detailed=${false}
                  ></git-status-badge>`
                : nothing
            }
          </div>
        </div>
        <div class="ut-session-header-actions">
          ${
            session.status === 'exited'
              ? html`<session-status-dropdown
                  .session=${session}
                  .onClear=${this.onClearSession}
                  .onRestart=${this.onRestartSession}
                ></session-status-dropdown>`
              : nothing
          }
          ${this.renderPreviewChip()}
          <keyboard-capture-indicator
            .active=${this.keyboardCaptureActive}
            .isMobile=${false}
            @capture-toggled=${(e: CustomEvent) => {
              this.dispatchEvent(
                new CustomEvent('capture-toggled', {
                  detail: e.detail,
                  bubbles: true,
                  composed: true,
                })
              );
            }}
          ></keyboard-capture-indicator>
          <div class="ut-segmented" role="group" aria-label=${`${t('header.view.chat')} / ${t('header.view.terminal')}`} data-testid="header-view-switch">
            <button
              type="button"
              aria-pressed=${this.chatMode ? 'true' : 'false'}
              title=${t('header.switchToChat')}
              data-testid="chat-mode-toggle-button"
              @click=${() => {
                if (!this.chatMode) this.onToggleChatMode?.();
              }}
            >
              ${icon('chat')}${t('header.view.chat')}
            </button>
            <button
              type="button"
              aria-pressed=${this.chatMode ? 'false' : 'true'}
              title=${t('header.switchToTerminal')}
              data-testid="terminal-mode-button"
              @click=${() => {
                if (this.chatMode) this.onToggleChatMode?.();
              }}
            >
              ${icon('terminal')}${t('header.view.terminal')}
            </button>
          </div>
          <button
            type="button"
            class="ut-icon-btn"
            @click=${() => this.onOpenFileBrowser?.()}
            title=${`${t('header.files')} (${filesShortcut})`}
            aria-label=${t('header.files')}
            data-testid="header-files-button"
          >
            ${icon('files')}
          </button>
          ${
            this.hasGitRepo && this.onShowChanges
              ? html`<button
                  type="button"
                  class="ut-icon-btn"
                  @click=${() => this.onShowChanges?.()}
                  title=${changes ? `${t('header.changes')} · ${t('changes.badge', { count: changes })}` : t('header.changes')}
                  aria-label=${changes ? `${t('header.changes')}, ${t('changes.badge', { count: changes })}` : t('header.changes')}
                  data-testid="header-changes-button"
                >
                  ${DIFF_ICON}
                  ${changes ? html`<span class="ut-badge-dot ut-session-header-changes-dot" aria-hidden="true"></span>` : nothing}
                </button>`
              : nothing
          }
          <span class="ut-session-header-divider" aria-hidden="true"></span>
          <compact-menu
            desktop
            .session=${session}
            .gitFolded=${this.gitFolded}
            .widthLabel=${this.widthLabel}
            .widthTooltip=${this.widthTooltip}
            .onOpenFileBrowser=${this.onOpenFileBrowser}
            .onUploadImage=${() => this.handleSelectImage()}
            .onPasteImage=${() => this.handlePasteImage()}
            .onMaxWidthToggle=${this.onMaxWidthToggle}
            .onOpenSettings=${this.onOpenSettings}
            .onRename=${session.status === 'exited' ? undefined : () => this.startRename()}
            .currentTheme=${this.currentTheme}
            .onTerminateSession=${this.onTerminateSession}
            .onClearSession=${this.onClearSession}
            .hasGitRepo=${this.hasGitRepo}
            .viewMode=${this.viewMode}
            .onToggleViewMode=${() => this.onToggleViewMode?.()}
            .chatMode=${this.chatMode}
            .onTalk=${() => openCopilot({ mode: 'session', sessionId: session.id })}
            .onToggleChatMode=${this.onToggleChatMode}
            .onSelectText=${this.onSelectText}
            .onShieldSession=${this.onShieldSession}
            .onShareSession=${this.onShareSession}
            .onShowChanges=${this.onShowChanges}
            @theme-changed=${(e: CustomEvent) => {
              this.currentTheme = e.detail.theme;
            }}
          ></compact-menu>
        </div>
      </div>
    `;
  }

  /** Changed files as the session's git status watcher counts them. */
  private changedFileCount(): number {
    const s = this.session;
    return (s?.gitModifiedCount ?? 0) + (s?.gitAddedCount ?? 0) + (s?.gitDeletedCount ?? 0);
  }

  private handleMagicButton() {
    if (!this.session) return;

    logger.log('Magic button clicked for session', this.session.id);

    sendAIPrompt(this.session.id, authClient).catch((error) => {
      logger.error('Failed to send AI prompt', error);
      // It used to fail only in the console: the tap seemed to do nothing.
      toast({ kind: 'error', text: t('toast.updateTitleFailed') });
    });
  }

  private handleMouseEnter = () => {
    this.isHovered = true;
  };

  private handleMouseLeave = () => {
    this.isHovered = false;
  };

  private handlePasteImage() {
    // Dispatch event to session-view to handle paste
    this.dispatchEvent(
      new CustomEvent('paste-image', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleSelectImage() {
    // Always dispatch select-image event to trigger the OS picker directly
    this.dispatchEvent(
      new CustomEvent('select-image', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleMobileUploadImage() {
    // Directly trigger the OS image picker
    this.dispatchEvent(
      new CustomEvent('select-image', {
        bubbles: true,
        composed: true,
      })
    );
  }
}

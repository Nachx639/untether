/**
 * Session Card Component
 *
 * One session on the desktop home (design spec 5.1, 2026-10-12; 2026-11-08 «las tarjetas de
 * inicio son muy verbosas»): a 40px header (agent glyph, name, needs-you pill, last activity,
 * hover actions) and a 32px line (its state and what the agent does, «Más»). «Más» opens the
 * terminal's last lines, the command, branch, folder and diff. `layout="row"` is the same
 * session as one 40px line (list view).
 *
 * Phones never render it: they use phone-session-row.
 *
 * @fires session-select - When card is clicked (detail: Session)
 * @fires session-killed - When session is successfully killed (detail: { sessionId: string, session: Session })
 * @fires session-kill-error - When kill operation fails (detail: { sessionId: string, error: string })
 * @fires session-renamed - After a rename (detail: { sessionId, userTitle })
 * @fires session-created - After "Reopen" started it again (detail: { sessionId })
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sessionTitle } from '../../shared/session-title.js';
import type { Session } from '../../shared/types.js';
import { HttpMethod } from '../../shared/types.js';
import type { AuthClient } from '../services/auth-client.js';
import { sessionActionService } from '../services/session-action-service.js';
import { toast } from '../utils/action-toast.js';
import { explainLine } from '../utils/card-line.js';
import { resumableAgent, resumeSession } from '../utils/claude-resume.js';
import { confirmDialog } from '../utils/confirm-dialog.js';
import { createLogger } from '../utils/logger.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import type { GroupMenu } from '../utils/project-groups.js';
import { setSessionMuted, setSessionUserTitle } from '../utils/session-actions.js';
import { applyGroupPin, openGroupPinSheet } from '../utils/session-group-pin.js';
import {
  deriveSessionStatus,
  lastActivityAt,
  relativeTime,
  type SessionStatus,
  statusLabel,
} from '../utils/session-status.js';
import {
  canMoveToUntether,
  canShield,
  moveToUntether,
  shieldConfirmText,
  shieldSession,
} from '../utils/shield.js';
import { formatShortcut } from '../utils/shortcut-label.js';
import { TerminalPreferencesManager } from '../utils/terminal-preferences.js';
import type { TerminalThemeId } from '../utils/terminal-themes.js';
import { agentKind, icon } from './icons.js';

const logger = createLogger('session-card');

import './ut-terminal-buffer.js';
import { sessionProviderMarker } from '../../shared/model-providers.js';
import './clickable-path.js';
import { LocaleController, t } from '../i18n/index.js';
import { canSuspend, isFinishedSession, suspendWithFeedback } from '../utils/session-suspend.js';
import { agentAvatar } from './agent-avatar.js';
import './provider-badge.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** What a card calls the session: the user's or the agent's title, else its name or command. */
export function sessionDisplayName(session: Session): string {
  return sessionTitle(session) || session.name || session.command?.join(' ') || '';
}

/** The command a session runs, ANSI stripped, first word as a basename. */
export function sessionCommandLine(session: Pick<Session, 'command'>): string {
  const [first = '', ...rest] = session.command ?? [];
  const base = first.split('/').pop() ?? first;
  return [base, ...rest].join(' ').replace(ANSI_RE, '').trim();
}

@customElement('session-card')
export class SessionCard extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Object }) session!: Session;
  @property({ type: Object }) authClient!: AuthClient;
  @property({ type: Boolean }) selected = false;
  /** 'card' (grid) or 'row' (list view: one 40px line). */
  @property({ type: String }) layout: 'card' | 'row' = 'card';
  /** The one card of the list reachable with Tab (roving tabindex, session-list). */
  @property({ type: Boolean }) tabStop = false;
  /** Its project's orchestrator: an "Orquestador" badge, as on the phone (2026-10-18 review). */
  @property({ type: Boolean }) orchestrator = false;
  /**
   * The orchestrator's project app icon (TaskStore.iconFor): it fills the avatar with the
   * agent's mark small in a corner, as on the phone (2026-10-24). One that can't load is dropped.
   */
  @property({ attribute: false }) projectIcon: string | null = null;
  /** The home's groups and where each session is (its group menu, 2026-11-04). */
  @property({ attribute: false }) groupMenu: GroupMenu | null = null;
  @state() private brokenIcon: string | null = null;
  /**
   * «Más» opened: the terminal preview, the command, branch, folder and diff. By default a
   * card is its title, state, one line and time (2026-11-08, user report: the home cards said too
   * much).
   */
  @state() private expanded = false;
  @state() private killing = false;
  @state() private renaming = false;
  @state() private reopening = false;
  @state() private terminalTheme: TerminalThemeId = 'auto';

  private storageListener: ((e: StorageEvent) => void) | null = null;
  private themeChangeListener: ((e: CustomEvent) => void) | null = null;
  private preferencesManager = TerminalPreferencesManager.getInstance();

  connectedCallback() {
    super.connectedCallback();
    this.loadThemeFromStorage();
    // Cross-tab theme changes
    this.storageListener = (e: StorageEvent) => {
      if (e.key === 'untether_terminal_preferences') this.loadThemeFromStorage();
    };
    window.addEventListener('storage', this.storageListener);
    // Same-tab theme changes
    this.themeChangeListener = (e: CustomEvent) => {
      this.terminalTheme = e.detail as TerminalThemeId;
    };
    window.addEventListener('terminal-theme-changed', this.themeChangeListener as EventListener);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.storageListener) {
      window.removeEventListener('storage', this.storageListener);
      this.storageListener = null;
    }
    if (this.themeChangeListener) {
      window.removeEventListener(
        'terminal-theme-changed',
        this.themeChangeListener as EventListener
      );
      this.themeChangeListener = null;
    }
  }

  private loadThemeFromStorage() {
    this.terminalTheme = this.preferencesManager.getTheme();
  }

  /** The focusable root (role=link), for the list's keyboard navigation. */
  get focusTarget(): HTMLElement | null {
    return this.querySelector<HTMLElement>('[data-testid="session-card"]');
  }

  private handleCardClick() {
    if (this.renaming) return;
    this.dispatchEvent(
      new CustomEvent('session-select', {
        detail: this.session,
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleKillClick(e: Event) {
    e.stopPropagation();
    e.preventDefault();
    void this.confirmKill();
  }

  /** Kill a running session after asking (exited ones are just removed). */
  public async confirmKill(): Promise<boolean> {
    if (this.killing) return false;
    if (this.session.status === 'running') {
      const ok = await confirmDialog({
        title: t('sessions.kill.confirmTitle', { name: sessionDisplayName(this.session) }),
        body: t('sessions.kill.confirmBody'),
        confirmLabel: t('sessions.row.kill'),
        tone: 'danger',
      });
      if (!ok) return false;
    }
    return this.kill();
  }

  /** Kill the session (or clean up an exited one) without asking. */
  public async kill(): Promise<boolean> {
    if (this.killing) return false;
    if (this.session.status !== 'running' && this.session.status !== 'exited') return false;

    const isCleanup = this.session.status === 'exited';
    this.killing = true;

    // Never stay stuck in "Closing…"
    const killingTimeout = setTimeout(() => {
      logger.warn(`Kill operation timed out for session ${this.session.id}`);
      this.killing = false;
      this.dispatchEvent(
        new CustomEvent('session-kill-error', {
          detail: {
            sessionId: this.session.id,
            error: t(isCleanup ? 'toast.clearFailed' : 'toast.terminateFailed', {
              error: t('sessionAction.error.timeout'),
            }),
          },
          bubbles: true,
          composed: true,
        })
      );
    }, 10000);

    if (isCleanup) {
      this.classList.add('black-hole-collapsing');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const result = await sessionActionService.deleteSession(this.session, {
      authClient: this.authClient,
      callbacks: {
        onError: (errorMessage) => {
          logger.error('Error killing session', {
            error: errorMessage,
            sessionId: this.session.id,
          });
          this.dispatchEvent(
            new CustomEvent('session-kill-error', {
              detail: { sessionId: this.session.id, error: errorMessage },
              bubbles: true,
              composed: true,
            })
          );
          clearTimeout(killingTimeout);
        },
        onSuccess: () => {
          this.dispatchEvent(
            new CustomEvent('session-killed', {
              detail: { sessionId: this.session.id, session: this.session },
              bubbles: true,
              composed: true,
            })
          );
          logger.log(`Session ${this.session.id} ${isCleanup ? 'cleaned up' : 'killed'}`);
          clearTimeout(killingTimeout);
        },
      },
    });

    this.killing = false;
    clearTimeout(killingTimeout);
    // A failed remove leaves the card as it was: collapsed, it stayed inert (2026-10-20 audit).
    if (!result.success) this.classList.remove('black-hole-collapsing');
    return result.success;
  }

  /** F2 / pencil / double-click on the name: edit the title in place. */
  public startRename() {
    this.renaming = true;
    void this.updateComplete.then(() => {
      const input = this.querySelector<HTMLInputElement>('[data-testid="session-rename-input"]');
      input?.focus();
      input?.select();
    });
  }

  private async commitRename(value: string) {
    if (!this.renaming) return;
    this.renaming = false;
    const next = value.trim();
    if (next === sessionDisplayName(this.session).trim()) {
      this.focusTarget?.focus();
      return;
    }
    const userTitle = next || null;
    const result = await setSessionUserTitle(this.session.id, userTitle, this.authClient);
    if (result.success) {
      this.session = { ...this.session, userTitle: userTitle ?? undefined };
      this.dispatchEvent(
        new CustomEvent('session-renamed', {
          detail: { sessionId: this.session.id, newName: next, userTitle },
          bubbles: true,
          composed: true,
        })
      );
    } else {
      this.dispatchEvent(
        new CustomEvent('session-rename-error', {
          detail: { sessionId: this.session.id, error: result.error || 'Unknown error' },
          bubbles: true,
          composed: true,
        })
      );
    }
    this.focusTarget?.focus();
  }

  private handleRenameKey(e: KeyboardEvent) {
    e.stopPropagation();
    const input = e.target as HTMLInputElement;
    if (e.key === 'Enter') {
      e.preventDefault();
      void this.commitRename(input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.renaming = false;
      this.focusTarget?.focus();
    }
  }

  /**
   * "Reopen" a finished session: a Claude conversation continues (`claude --resume`) and so
   * does a Codex thread (`codex resume`), anything else runs its command again in the same
   * folder.
   */
  private async reopen(e: Event) {
    e.stopPropagation();
    if (this.reopening) return;
    this.reopening = true;
    const { command, workingDir, name } = this.session;
    try {
      let sessionId: string | undefined;
      if (resumableAgent(this.session)) {
        const result = await resumeSession(this.session, this.authClient?.getAuthHeader());
        sessionId = result.sessionId;
      } else {
        const response = await fetch('/api/sessions', {
          method: HttpMethod.POST,
          headers: { 'Content-Type': 'application/json', ...this.authClient?.getAuthHeader() },
          body: JSON.stringify({ command, workingDir, name }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        sessionId = (await response.json()).sessionId;
      }
      this.dispatchEvent(
        new CustomEvent('session-created', {
          detail: { sessionId },
          bubbles: true,
          composed: true,
        })
      );
    } catch (error) {
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: `${t('newChat.failed')}: ${error}`,
          bubbles: true,
          composed: true,
        })
      );
    } finally {
      this.reopening = false;
    }
  }

  /** Mute its notifications (the phone row's menu has it; 2026-10-18 review: desktop too). */
  private async toggleMute() {
    const session = this.session;
    const muted = !session.muted;
    const result = await setSessionMuted(session.id, muted, this.authClient);
    if (!result.success) {
      toast({ kind: 'error', text: t('organize.muteFailed') });
      return;
    }
    session.muted = muted;
    this.requestUpdate();
    if (muted) toast({ kind: 'success', text: t('organize.muted') });
  }

  /** Its group on the home: anchor it, move it, or back to automatic (session-group-pin.ts). */
  private openGroupMenu(e: Event) {
    const label = sessionTitle(this.session) || this.session.name || '';
    const sheet = openGroupPinSheet({
      label,
      opener: e.currentTarget as Element | null,
      session: this.session,
      menu: this.groupMenu,
      apply: (groupPin) => {
        sheet.close();
        void applyGroupPin(this, this.session, groupPin, this.authClient).then(() =>
          this.requestUpdate()
        );
      },
    });
  }

  /** "Blindar", after the same question as on the phone. */
  private async shield() {
    const ok = await confirmDialog({
      title: t('shield.shield'),
      body: shieldConfirmText(this.session, sessionTitle(this.session) || this.session.name || ''),
      confirmLabel: t('shield.shield'),
    });
    if (!ok) return;
    try {
      const result = await shieldSession(this.session.id, this.authClient?.getAuthHeader());
      this.dispatchEvent(
        new CustomEvent('session-created', { detail: result, bubbles: true, composed: true })
      );
    } catch (error) {
      toast({
        kind: 'error',
        text: t('shield.failed', { error: error instanceof Error ? error.message : String(error) }),
      });
    }
  }

  /** "Llevar a Untether": a `ut` session leaves its Mac window (2026-10-25). */
  private async moveToUntether() {
    const name = sessionTitle(this.session) || this.session.name || '';
    const ok = await confirmDialog({
      title: t('moveToUntether.action'),
      body: t('moveToUntether.confirm', { name }),
      confirmLabel: t('moveToUntether.action'),
    });
    if (!ok) return;
    try {
      const result = await moveToUntether(this.session.id, name, this.authClient?.getAuthHeader());
      if (!result) return;
      this.dispatchEvent(
        new CustomEvent('session-created', { detail: result, bubbles: true, composed: true })
      );
    } catch (error) {
      toast({
        kind: 'error',
        text: t('moveToUntether.failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }

  private renderName(name: string) {
    if (this.renaming) {
      return html`<input
        class="ut-field ut-card-rename"
        data-testid="session-rename-input"
        .value=${name}
        aria-label=${t('sessions.row.rename')}
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${this.handleRenameKey}
        @blur=${(e: Event) => void this.commitRename((e.target as HTMLInputElement).value)}
      />`;
    }
    return html`<span
      class="ut-card-name"
      title=${name}
      @dblclick=${(e: Event) => {
        e.stopPropagation();
        this.startRename();
      }}
      >${name}</span
    >`;
  }

  private renderActions() {
    // Suspended: paused, not finished (a click on the card wakes it; Kill ends it).
    const exited = isFinishedSession(this.session);
    if (this.killing) {
      return html`<span class="ut-card-killing" role="status">${t('status.killingSession')}</span>`;
    }
    const stop = (fn: (e: Event) => void) => (e: Event) => {
      e.stopPropagation();
      fn(e);
    };
    // Its group on the home, finished or not (2026-11-04 review).
    const groupButton = html`<button
              class="ut-icon-btn ut-icon-btn--sm"
              tabindex="-1"
              data-testid="group-pin-session-button"
              title=${t('groupPin.menu')}
              aria-label=${t('groupPin.menu')}
              aria-haspopup="dialog"
              aria-pressed=${this.session.groupPin ? 'true' : 'false'}
              @click=${stop((e) => this.openGroupMenu(e))}
            >
              ${icon(this.session.groupPin ? 'pin' : 'folder')}
            </button>`;
    return html`<div class="ut-card-actions">
      ${groupButton}
      ${
        exited
          ? html`
            <button
              class="ut-icon-btn ut-icon-btn--sm"
              tabindex="-1"
              data-testid="reopen-session-button"
              title=${t('status.reopen')}
              aria-label=${t('status.reopen')}
              ?disabled=${this.reopening}
              @click=${(e: Event) => void this.reopen(e)}
            >
              ${icon('restart')}
            </button>
            <button
              class="ut-icon-btn ut-icon-btn--sm ut-card-kill"
              id="session-kill-button"
              tabindex="-1"
              data-testid="kill-session-button"
              title=${t('status.remove')}
              aria-label=${t('status.remove')}
              @click=${this.handleKillClick}
            >
              ${icon('trash')}
            </button>
          `
          : html`
            <button
              class="ut-icon-btn ut-icon-btn--sm"
              tabindex="-1"
              data-testid="mute-session-button"
              title=${t(this.session.muted ? 'organize.unmute' : 'organize.mute')}
              aria-label=${t(this.session.muted ? 'organize.unmute' : 'organize.mute')}
              aria-pressed=${this.session.muted ? 'true' : 'false'}
              @click=${stop(() => void this.toggleMute())}
            >
              ${icon(this.session.muted ? 'bell' : 'bellOff')}
            </button>
            ${
              canShield(this.session)
                ? html`<button
                    class="ut-icon-btn ut-icon-btn--sm"
                    tabindex="-1"
                    data-testid="shield-session-button"
                    title=${t('shield.shield')}
                    aria-label=${t('shield.shield')}
                    @click=${stop(() => void this.shield())}
                  >
                    ${icon('shield')}
                  </button>`
                : canMoveToUntether(this.session)
                  ? html`<button
                      class="ut-icon-btn ut-icon-btn--sm"
                      tabindex="-1"
                      data-testid="move-to-untether-button"
                      title=${t('moveToUntether.help')}
                      aria-label=${t('moveToUntether.action')}
                      @click=${stop(() => void this.moveToUntether())}
                    >
                      ${icon('shield')}
                    </button>`
                  : nothing
            }
            ${
              canSuspend(this.session)
                ? html`<button
                    class="ut-icon-btn ut-icon-btn--sm"
                    tabindex="-1"
                    data-testid="suspend-session-button"
                    title=${t('suspend.nowHelp')}
                    aria-label=${t('suspend.now')}
                    @click=${stop(
                      () => void suspendWithFeedback(this.session, this.authClient?.getAuthHeader())
                    )}
                  >
                    ${icon('pause')}
                  </button>`
                : nothing
            }
            <button
              class="ut-icon-btn ut-icon-btn--sm"
              tabindex="-1"
              data-testid="rename-session-button"
              title=${`${t('sessions.row.rename')} (F2)`}
              aria-label=${t('sessions.row.rename')}
              @click=${stop(() => this.startRename())}
            >
              ${icon('pencil')}
            </button>
            <button
              class="ut-icon-btn ut-icon-btn--sm ut-card-kill"
              id="session-kill-button"
              tabindex="-1"
              data-testid="kill-session-button"
              title=${`${t('sessions.row.kill')} (${formatShortcut('mod+backspace')})`}
              aria-label=${t('sessions.row.kill')}
              @click=${this.handleKillClick}
            >
              ${icon('x')}
            </button>
          `
      }
    </div>`;
  }

  /**
   * The state and the one line: the model's line about what the agent does (card-line.ts),
   * else the short status of always ("Trabajando", "Inactiva · hace 9 min").
   */
  private renderStatus(status: SessionStatus, line = '') {
    return html`<span
      class="ut-status"
      data-status=${status}
      data-testid="session-status"
      >${
        status === 'exited-ok' ? icon('check', 12) : html`<span class="ut-dot"></span>`
      }<span class="truncate"
        >${
          // Idle without its "· 9 min ago": the header already shows the time (2026-10-12).
          line || statusLabel(status, status === 'idle' ? undefined : this.session)
        }</span
      ></span
    >`;
  }

  /** «Más» / «Menos» (the card's details: command, branch, folder, diff). */
  private renderMore() {
    return html`<button
      type="button"
      class="ut-card-more"
      tabindex="-1"
      data-testid="session-card-more"
      aria-expanded=${this.expanded ? 'true' : 'false'}
      @click=${(e: Event) => {
        e.stopPropagation();
        this.expanded = !this.expanded;
      }}
    >
      ${this.expanded ? t('card.less') : t('card.more')}
    </button>`;
  }

  /**
   * What «Más» shows: the terminal's last lines, the command, branch, folder and diff. None of
   * it on the closed card (2026-11-08 review: the preview was several lines of output too).
   */
  private renderDetails(command: string) {
    const session = this.session;
    return html`<div class="ut-card-preview session-preview">
        <ut-terminal-buffer
          .sessionId=${session.id}
          .theme=${this.terminalTheme}
          .appearance=${'dark'}
          class="w-full h-full"
          style="pointer-events: none;"
        ></ut-terminal-buffer>
      </div>
      <div class="ut-card-details" data-testid="session-card-details">
      ${command ? html`<div class="ut-card-command" title=${command}>${command}</div>` : nothing}
      ${this.renderBranch()}
      <clickable-path
        class="ut-card-path"
        .path=${this.session.workingDir}
        .variant=${'middle'}
      ></clickable-path>
      ${this.renderDiff()}
    </div>`;
  }

  private renderDiff() {
    const ins = this.session.gitInsertionCount ?? 0;
    const del = this.session.gitDeletionCount ?? 0;
    if (!ins && !del) return nothing;
    return html`<span class="ut-card-diff tnum" data-testid="session-diff"
      ><span class="text-status-success">+${ins}</span>
      <span class="text-text-dim">−${del}</span></span
    >`;
  }

  private renderBranch() {
    const branch = this.session.gitBranch;
    if (!branch) return nothing;
    const detached = branch === 'HEAD' || /^[0-9a-f]{7,40}$/.test(branch);
    return html`<span
      class="ut-chip ut-chip--mono ut-card-branch"
      title=${detached ? t('git.detached') : branch}
      >${icon('gitBranch', 12)}<span class="truncate">${detached ? branch.slice(0, 7) : branch}</span></span
    >`;
  }

  render() {
    const session = this.session;
    const status = deriveSessionStatus(session);
    const name = sessionDisplayName(session);
    const provider = sessionProviderMarker(session);
    const command = sessionCommandLine(session);
    const last = lastActivityAt(session);
    const ago = last === undefined ? '' : relativeTime(Date.now() - last);
    const line = explainLine(session);
    const where = [formatPathForDisplay(session.workingDir), session.gitBranch]
      .filter(Boolean)
      .join(' · ');
    const label = [name, statusLabel(status, session), line, where].filter(Boolean).join(', ');
    const exited = isFinishedSession(session);
    const needsInput = status === 'needs-input';
    const rootClass = [
      this.layout === 'row' ? 'ut-srow' : 'ut-card',
      `ut-surface--material ut-surface--${status}`,
      'group',
      exited ? 'is-exited' : '',
      needsInput ? 'is-attention' : '',
      this.selected ? 'is-selected' : '',
      this.killing ? 'is-killing' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const root = (content: unknown) => html`<div
      class=${rootClass}
      role="link"
      tabindex=${this.tabStop ? '0' : '-1'}
      aria-label=${label}
      style="view-transition-name: session-${session.id}; --session-id: session-${session.id}"
      data-session-id=${session.id}
      data-testid="session-card"
      data-session-status=${session.status}
      data-status=${status}
      data-is-killing=${this.killing}
      @click=${this.handleCardClick}
    >
      ${content}
    </div>`;

    const appIcon =
      this.orchestrator && this.projectIcon && this.projectIcon !== this.brokenIcon
        ? this.projectIcon
        : null;
    const avatarOptions = {
      kind: agentKind(session),
      provider,
      projectIcon: appIcon,
      iconTestId: 'card-project-icon',
      onIconError: () => {
        this.brokenIcon = appIcon;
      },
    };
    const glyph = agentAvatar({ ...avatarOptions, variant: 'inline' });
    const time = ago
      ? html`<time class="ut-card-time tnum" title=${new Date(last ?? 0).toLocaleString()}
          >${ago}</time
        >`
      : nothing;

    if (this.layout === 'row') {
      return root(html`
        <span class="ut-dot" data-status=${status}></span>
        ${glyph}
        <span class="ut-srow-name">${this.renderName(name)}</span>
        ${needsInput ? this.renderStatus(status) : nothing}
        <span class="ut-srow-line" data-testid="session-line" title=${where}
          >${line || (needsInput ? '' : statusLabel(status, status === 'idle' ? undefined : session))}</span
        >
        ${time} ${this.renderActions()}
      `);
    }

    const showCommand = command && command !== name ? command : '';
    // Live in colour, finished in grey (2026-10-12): list.css tints this tile and its dot from
    // the card's data-status (accent while live, amber when it needs you, grey once exited).
    const avatar = agentAvatar({ ...avatarOptions, variant: 'card' });
    return root(html`
      <div class="ut-card-head">
        ${avatar}
        <div class="ut-card-title">${this.renderName(name)}</div>
        ${
          this.orchestrator
            ? html`<span class="prj-orch-badge ut-card-orch" data-testid="card-orchestrator-badge"
                >${icon('sparkles', 12)}<span>${t('board.orchestrator')}</span></span
              >`
            : nothing
        }
        ${
          provider
            ? html`<ut-provider-badge
                data-testid="card-provider-badge"
                .besideLogo=${true}
                .providerId=${provider.id}
                .model=${provider.model}
              ></ut-provider-badge>`
            : nothing
        }
        ${
          needsInput
            ? html`<span class="ut-status" data-status="needs-input"
                ><span class="ut-dot"></span>${t('status.needsInput')}</span
              >`
            : nothing
        }
        ${time} ${this.renderActions()}
      </div>
      ${this.expanded ? this.renderDetails(showCommand) : nothing}
      <div class="ut-card-meta">
        ${
          needsInput
            ? line
              ? html`<span class="ut-card-line truncate" data-testid="session-line" title=${line}
                  >${line}</span
                >`
              : html`<span class="ut-card-line"></span>`
            : this.renderStatus(status, line)
        }
        ${this.renderMore()}
      </div>
    `);
  }
}

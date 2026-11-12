/**
 * Compact Session Card Component
 *
 * A session in the split-view sidebar (design spec 5.2, 2026-10-12): a borderless 44px row with
 * the status dot, name over path, and the last activity; on hover the ⌘N shortcut and a close
 * button. The selected row gets --color-selected and a 2px primary bar. Index numbers show only
 * while ⌘ is held (body.ut-cmd-held, set by the app). Its project's orchestrator has the sparkles
 * on its tile and "Orquestador" before its path (2026-10-24: the sidebar did not say which one it
 * was, as the cards and the phone do). With its project's app icon (`projectIcon`), the icon fills
 * that tile and the sparkles sit small in a corner, as on the phone (2026-10-24). Its group on the
 * home (anclar, mover, quitar ancla) from a hover button or a right click, the same menu as the
 * desktop card (2026-11-07: the user could not take a session out of a group from the sidebar).
 *
 * @fires session-select - When the row is clicked (detail: Session)
 * @fires session-delete - When a running session was killed (detail: { sessionId: string })
 * @fires session-cleanup - When an exited session was removed (detail: { sessionId: string })
 * @fires session-group-pinned - Its group anchor changed (detail: { sessionId, groupPin })
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sessionProviderMarker } from '../../../shared/model-providers.js';
import type { Session } from '../../../shared/types.js';
import { LocaleController, t } from '../../i18n/index.js';
import type { AuthClient } from '../../services/auth-client.js';
import { sessionActionService } from '../../services/session-action-service.js';
import { midCutTitle } from '../../utils/card-line.js';
import { confirmDialog } from '../../utils/confirm-dialog.js';
import { formatPathForDisplay } from '../../utils/path-utils.js';
import type { GroupMenu } from '../../utils/project-groups.js';
import { applyGroupPin, openGroupPinSheet } from '../../utils/session-group-pin.js';
import {
  deriveSessionStatus,
  lastActivityAt,
  relativeTime,
  statusLabel,
} from '../../utils/session-status.js';
import {
  canSuspend,
  isFinishedSession,
  suspendedAt,
  suspendWithFeedback,
} from '../../utils/session-suspend.js';
import { formatShortcut } from '../../utils/shortcut-label.js';
import { agentAvatar } from '../agent-avatar.js';
import { agentKind, icon } from '../icons.js';
import '../provider-badge.js';
import { sessionDisplayName } from '../session-card.js';

@customElement('compact-session-card')
export class CompactSessionCard extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Object }) session!: Session;
  @property({ type: Object }) authClient!: AuthClient;
  @property({ type: Boolean }) selected = false;
  @property({ type: Number }) sessionNumber?: number;
  /** Its project's orchestrator. */
  @property({ type: Boolean }) orchestrator = false;
  /** The orchestrator's project app icon (TaskStore.iconFor), null until it loads. */
  @property({ attribute: false }) projectIcon: string | null = null;
  /** The home's groups and where each session is (SessionListSections.groupMenu). */
  @property({ attribute: false }) groupMenu: GroupMenu | null = null;
  /** The icon URL that failed to load: the plain tile comes back. */
  @state() private brokenIcon: string | null = null;

  private handleClick() {
    this.dispatchEvent(
      new CustomEvent('session-select', {
        detail: this.session,
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault();
      this.handleClick();
    }
  }

  /** Its group on the home: anchor it, move it, or back to automatic (session-group-pin.ts). */
  private openGroupMenu(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    const sheet = openGroupPinSheet({
      label: sessionDisplayName(this.session),
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

  /** A remove is on its way: a double click sent two DELETEs (2026-10-20 audit). */
  private deleting = false;

  private async handleDelete(e: Event) {
    e.stopPropagation();
    if (this.deleting) return;
    this.deleting = true;
    try {
      await this.deleteSession();
    } finally {
      this.deleting = false;
    }
  }

  private async deleteSession() {
    if (this.session.status === 'running') {
      const ok = await confirmDialog({
        title: t('sessions.kill.confirmTitle', { name: sessionDisplayName(this.session) }),
        body: t('sessions.kill.confirmBody'),
        confirmLabel: t('sessions.row.kill'),
        tone: 'danger',
      });
      if (!ok) return;
    }
    await sessionActionService.deleteSession(this.session, {
      authClient: this.authClient,
      callbacks: {
        onSuccess: () => {
          // Only after the server confirmed it
          const eventType = this.session.status === 'exited' ? 'session-cleanup' : 'session-delete';
          this.dispatchEvent(
            new CustomEvent(eventType, {
              detail: { sessionId: this.session.id },
              bubbles: true,
              composed: true,
            })
          );
        },
        onError: (error: string) => {
          this.dispatchEvent(
            new CustomEvent('session-kill-error', {
              detail: { sessionId: this.session.id, error },
              bubbles: true,
              composed: true,
            })
          );
        },
      },
    });
  }

  render() {
    const session = this.session;
    // Suspended: paused, not finished (a click wakes it).
    const exited = isFinishedSession(session);
    const status = deriveSessionStatus(session);
    const name = sessionDisplayName(session);
    const provider = sessionProviderMarker(session);
    // Suspended: the time it has been paused (2026-10-31, the "Suspended" section).
    const last = suspendedAt(session) ?? lastActivityAt(session);
    const removeLabel = exited ? t('status.remove') : t('sessions.row.kill');
    const shortcut =
      this.sessionNumber && this.sessionNumber <= 9
        ? formatShortcut(`mod+${this.sessionNumber}`)
        : '';
    const appIcon =
      this.orchestrator && this.projectIcon && this.projectIcon !== this.brokenIcon
        ? this.projectIcon
        : null;
    return html`
      <div
        class="ut-side-row ut-surface--material ut-surface--${status} ${this.selected ? 'is-selected ut-surface--selected-row' : ''} ${exited ? 'is-exited' : ''}"
        role="link"
        tabindex="0"
        aria-current=${this.selected ? 'page' : nothing}
        aria-label=${
          this.orchestrator
            ? `${name}, ${t('board.orchestrator')}, ${statusLabel(status, session)}`
            : `${name}, ${statusLabel(status, session)}`
        }
        data-testid="compact-session-card"
        data-session-id=${session.id}
        @click=${this.handleClick}
        @keydown=${this.handleKeyDown}
        @contextmenu=${(e: Event) => this.openGroupMenu(e)}
      >
        ${
          this.sessionNumber
            ? html`<span class="ut-side-index tnum">${this.sessionNumber}</span>`
            : nothing
        }
        ${agentAvatar({
          variant: 'side',
          kind: agentKind(session),
          status,
          title: statusLabel(status, session),
          orchestrator: this.orchestrator,
          provider,
          projectIcon: appIcon,
          iconTestId: 'compact-project-icon',
          onIconError: () => {
            this.brokenIcon = appIcon;
          },
        })}
        <span class="ut-side-text">
          <span class="ut-side-name ut-mid" dir="auto" title=${name}>${midCutTitle(name)}</span>
          <span class="ut-side-path">${
            this.orchestrator
              ? html`<span class="ut-side-orch" data-testid="compact-orchestrator-badge"
                  >${icon('sparkles', 10)}${t('board.orchestrator')}</span
                >`
              : nothing
          }${
            provider
              ? html`<ut-provider-badge
                  data-testid="compact-provider-badge"
                  .besideLogo=${true}
                  .providerId=${provider.id}
                  .model=${provider.model}
                ></ut-provider-badge>`
              : nothing
          }${formatPathForDisplay(session.workingDir)}</span>
        </span>
        <span class="ut-side-right">
          ${
            last === undefined
              ? nothing
              : html`<span class="ut-side-time">${relativeTime(Date.now() - last)}</span>`
          }
          <span class="ut-side-hover">
            ${shortcut ? html`<span class="ut-kbd">${shortcut}</span>` : nothing}
            <button
              class="ut-icon-btn ut-icon-btn--sm"
              tabindex="-1"
              data-testid="compact-group-pin-button"
              title=${t('groupPin.menu')}
              aria-label=${t('groupPin.menu')}
              aria-haspopup="dialog"
              aria-pressed=${session.groupPin ? 'true' : 'false'}
              @click=${(e: Event) => this.openGroupMenu(e)}
            >
              ${icon(session.groupPin ? 'pin' : 'folder')}
            </button>
            ${
              canSuspend(session)
                ? html`<button
                    class="ut-icon-btn ut-icon-btn--sm"
                    tabindex="-1"
                    data-testid="compact-suspend-button"
                    title=${t('suspend.nowHelp')}
                    aria-label=${t('suspend.now')}
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      void suspendWithFeedback(session, this.authClient?.getAuthHeader());
                    }}
                  >
                    ${icon('pause')}
                  </button>`
                : nothing
            }
            <button
              class="ut-icon-btn ut-icon-btn--sm ut-card-kill"
              tabindex="-1"
              data-testid="compact-kill-button"
              title=${removeLabel}
              aria-label=${removeLabel}
              @click=${this.handleDelete}
            >
              ${icon(exited ? 'trash' : 'x')}
            </button>
          </span>
        </span>
      </div>
    `;
  }
}

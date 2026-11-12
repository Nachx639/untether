/**
 * SessionExitedBadge Component
 *
 * "Session ended" badge floating over an exited session, with the button that resumes its
 * Claude conversation when there is one. session-view.ts renders it in a layer under the
 * session header: in the overlays container it was drawn over the ⋮ menu (2026-10-03).
 */
import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Session } from '../../../shared/types.js';
import { LocaleController, t } from '../../i18n/index.js';
import { resumableAgent } from '../../utils/claude-resume.js';

@customElement('session-exited-badge')
export class SessionExitedBadge extends LitElement {
  // Disable shadow DOM to use parent styles
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);
  @property({ type: Object }) session: Session | null = null;
  /**
   * When the badge appeared. 2026-10-18: approving a task merge ended its session and the
   * same tap landed on "Resume Claude", drawn under the finger a moment later.
   */
  private shownAt = 0;

  private resume() {
    if (Date.now() - this.shownAt < SessionExitedBadge.ARM_MS) return;
    this.dispatchEvent(new CustomEvent('resume-claude', { bubbles: true, composed: true }));
  }

  static ARM_MS = 1000;

  /** Suspended (2026-10-31): the same session wakes, through the app's open path. */
  private wake() {
    if (Date.now() - this.shownAt < SessionExitedBadge.ARM_MS || !this.session) return;
    this.dispatchEvent(
      new CustomEvent('navigate-to-session', {
        detail: { sessionId: this.session.id },
        bubbles: true,
        composed: true,
      })
    );
  }

  private renderPaused() {
    const error = this.session?.suspended?.resumeError;
    return html`
      <div
        class="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2"
        style="pointer-events: none !important;"
        data-testid="session-paused-badge"
      >
        <div
          class="bg-elevated border border-border text-text-muted font-medium text-sm tracking-wide px-6 py-3 rounded-lg shadow-elevated animate-scale-in"
          style="pointer-events: none !important;"
        >
          ${error ? t('suspend.wakeFailedShort') : t('suspend.overlay')}
        </div>
        <button
          class="ut-surface--control mt-3 w-full px-4 py-2.5 rounded-lg bg-primary text-on-fill text-sm font-medium shadow-elevated"
          style="pointer-events: auto;"
          data-testid="session-wake-button"
          @click=${() => this.wake()}
        >
          ${t('suspend.resume')}
        </button>
      </div>
    `;
  }

  render() {
    if (this.session?.suspended && this.session.status === 'exited') {
      if (!this.shownAt) this.shownAt = Date.now();
      return this.renderPaused();
    }
    if (this.session?.status !== 'exited') {
      this.shownAt = 0;
      return html``;
    }
    if (!this.shownAt) this.shownAt = Date.now();

    return html`
      <div
        class="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2"
        style="pointer-events: none !important;"
      >
        <div
          class="bg-elevated border border-status-warning text-status-warning font-medium text-sm tracking-wide px-6 py-3 rounded-lg shadow-elevated animate-scale-in"
          style="pointer-events: none !important;"
        >
          <span class="flex items-center gap-2 uppercase">
            <span class="w-2 h-2 rounded-pill bg-status-warning"></span>
            ${t('session.exitedOverlay')}
          </span>
        </div>
        ${
          // Only when the server said it can be resumed, as Reopen and the list rows decide
          // (2026-10-20 audit: undefined showed "Resume" here but Reopen started a new one).
          resumableAgent(this.session)
            ? html`<button
                class="ut-surface--control mt-3 w-full px-4 py-2.5 rounded-lg bg-primary text-on-fill text-sm font-medium shadow-elevated"
                style="pointer-events: auto;"
                @click=${() => this.resume()}
              >
                ${t(
                  resumableAgent(this.session) === 'codex'
                    ? 'session.resumeCodex'
                    : 'session.resumeClaude'
                )}
              </button>`
            : ''
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-exited-badge': SessionExitedBadge;
  }
}

/**
 * Form Options Section Component
 *
 * The new-session form's "Options" disclosure (design spec 5.3, 2026-10-12):
 * - Session name (fires session-name-changed)
 * - Spawn window toggle (when Mac app is connected)
 * - Terminal title mode selector
 * - Follow mode toggle (for Git repositories)
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { TitleMode } from '../../../shared/types.js';
import { LocaleController, t } from '../../i18n/index.js';
import type { GitRepoInfo } from '../../services/git-service.js';
import { getTitleModeDescription } from '../../utils/title-mode-utils.js';
import { icon } from '../icons.js';

@customElement('form-options-section')
export class FormOptionsSection extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) macAppConnected = false;
  @property({ type: Boolean }) spawnWindow = false;
  @property({ type: String }) titleMode = TitleMode.STATIC;
  @property({ type: Object }) gitRepoInfo: GitRepoInfo | null = null;
  @property({ type: Boolean }) followMode = false;
  @property({ type: String }) followBranch: string | null = null;
  @property({ type: Boolean }) showFollowMode = false;
  @property({ type: String }) selectedWorktree?: string;
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) isCreating = false;
  @property({ type: String }) sessionName = '';

  @state() private expanded = false;
  protected readonly i18n = new LocaleController(this);

  private handleToggle() {
    this.expanded = !this.expanded;
  }

  private handleSessionNameInput(e: Event) {
    this.dispatchEvent(
      new CustomEvent('session-name-changed', {
        detail: { name: (e.target as HTMLInputElement).value },
        bubbles: true,
        composed: true,
      })
    );
  }

  private renderSwitchRow(options: {
    label: string;
    description: string;
    on: boolean;
    disabled: boolean;
    testId: string;
    onToggle: () => void;
  }) {
    return html`
      <div class="ut-row ut-surface--panel ut-surface--material">
        <div class="min-w-0">
          <div class="ut-row-label">${options.label}</div>
          <p class="ut-row-desc">${options.description}</p>
        </div>
        <button
          type="button"
          class="ut-switch"
          role="switch"
          aria-checked=${options.on ? 'true' : 'false'}
          aria-label=${options.label}
          ?disabled=${options.disabled}
          data-testid=${options.testId}
          @click=${options.onToggle}
        ></button>
      </div>
    `;
  }

  private handleSpawnWindowToggle() {
    this.dispatchEvent(
      new CustomEvent('spawn-window-changed', {
        detail: { enabled: !this.spawnWindow },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleTitleModeChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    this.dispatchEvent(
      new CustomEvent('title-mode-changed', {
        detail: { mode: select.value },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleFollowModeToggle() {
    this.dispatchEvent(
      new CustomEvent('follow-mode-changed', {
        detail: { enabled: !this.showFollowMode },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    const busy = this.disabled || this.isCreating;
    const showFollow =
      this.gitRepoInfo?.isGitRepo && this.selectedWorktree && this.selectedWorktree !== 'none';
    return html`
      <div class="mt-4">
        <button
          id="session-options-button"
          @click=${this.handleToggle}
          class="ut-surface--control cf-disclosure"
          type="button"
          aria-expanded="${this.expanded}"
          aria-controls="session-options-panel"
        >
          <span class="cf-disclosure-chevron" style="transform: rotate(${this.expanded ? 90 : 0}deg)">
            ${icon('chevronRight', 14)}
          </span>
          ${t('create.options')}
        </button>

        ${
          this.expanded
            ? html`
            <div id="session-options-panel" class="mt-3 space-y-4">
              <div>
                <label class="ut-label" for="session-name-input">${t('create.sessionName')}</label>
                <input
                  id="session-name-input"
                  type="text"
                  class="ut-field"
                  .value=${this.sessionName}
                  @input=${this.handleSessionNameInput}
                  placeholder=${t('create.sessionNamePlaceholder')}
                  ?disabled=${busy}
                  data-testid="session-name-input"
                />
              </div>
              <!-- Phones flatten this group (no bordered card inside the sheet, dialogs.css). -->
              <div class="ut-group cf-options-group">
                <div class="ut-row ut-surface--panel ut-surface--material">
                  <div class="min-w-0">
                    <label class="ut-row-label" for="session-title-mode">${t('create.titleMode')}</label>
                    <p class="ut-row-desc">${getTitleModeDescription(this.titleMode)}</p>
                  </div>
                  <select
                    id="session-title-mode"
                    .value=${this.titleMode}
                    @change=${this.handleTitleModeChange}
                    class="ut-field ut-select w-auto"
                    ?disabled=${busy}
                    data-testid="title-mode-select"
                  >
                    <option value="${TitleMode.NONE}" ?selected=${this.titleMode === TitleMode.NONE}>${t('create.titleMode.none')}</option>
                    <option value="${TitleMode.FILTER}" ?selected=${this.titleMode === TitleMode.FILTER}>${t('create.titleMode.filter')}</option>
                    <option value="${TitleMode.STATIC}" ?selected=${this.titleMode === TitleMode.STATIC}>${t('create.titleMode.static')}</option>
                  </select>
                </div>
                ${
                  this.macAppConnected
                    ? this.renderSwitchRow({
                        label: t('create.spawnWindow'),
                        description: t('create.spawnWindow.description'),
                        on: this.spawnWindow,
                        disabled: busy,
                        testId: 'spawn-window-toggle',
                        onToggle: () => this.handleSpawnWindowToggle(),
                      })
                    : nothing
                }
                ${
                  showFollow
                    ? this.renderSwitchRow({
                        label: t('create.followMode'),
                        description: this.followMode
                          ? t('create.followMode.following', {
                              branch: this.followBranch || t('create.followMode.unknown'),
                            })
                          : t('create.followMode.description'),
                        on: this.showFollowMode,
                        disabled: busy || this.followMode,
                        testId: 'follow-mode-toggle',
                        onToggle: () => this.handleFollowModeToggle(),
                      })
                    : nothing
                }
              </div>
            </div>
          `
            : nothing
        }
      </div>
    `;
  }
}

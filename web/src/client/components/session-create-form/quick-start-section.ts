/**
 * Quick Start Section Component
 *
 * The new-session form's agent row (design spec 5.3, 2026-10-12): one pill per quick start
 * (agent glyph + name, no emoji), plus the editor for customizing them. Quick starts whose
 * program is not on the Mac collapse into a "+N not installed" menu; picking one there says so
 * instead of selecting it.
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { quickStartProgram } from '../../../shared/quick-start.js';
import type { Session } from '../../../shared/types.js';
import type { QuickStartCommand } from '../../../types/config.js';
import { LocaleController, t } from '../../i18n/index.js';
import {
  isQuickStartAvailable,
  type QuickStartAvailability,
} from '../../services/quick-start-availability.js';
import { isAIAssistantSession } from '../../utils/ai-sessions.js';
import { announce } from '../../utils/announce.js';
import { parseCommand } from '../../utils/command-utils.js';
import { agentLogo } from '../agent-avatar.js';
import { agentKind, icon } from '../icons.js';
import '../quick-start-editor.js';

export interface QuickStartItem {
  label: string;
  command: string;
}

@customElement('quick-start-section')
export class QuickStartSection extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) commands: QuickStartItem[] = [];
  @property({ type: String }) selectedCommand = '';
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) isCreating = false;
  /** Programs known to be missing on the Mac ({ gemini: false }); {} while unknown. */
  @property({ type: Object }) availability: QuickStartAvailability = {};

  @state() private editMode = false;
  /** The missing program last tapped, explained under the buttons. */
  @state() private unavailableProgram = '';
  /** The "+N not installed" menu. */
  @state() private showMissing = false;
  protected readonly i18n = new LocaleController(this);

  private handleQuickStartClick(command: string) {
    if (!isQuickStartAvailable(this.availability, command)) {
      this.unavailableProgram = quickStartProgram(command);
      announce(t('quickStart.notInstalledOnMac', { name: this.unavailableProgram }));
      return;
    }
    this.unavailableProgram = '';
    this.dispatchEvent(
      new CustomEvent('quick-start-selected', {
        detail: { command },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleQuickStartChanged(e: CustomEvent<QuickStartCommand[]>) {
    this.dispatchEvent(
      new CustomEvent('quick-start-changed', {
        detail: e.detail,
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleEditingChanged(e: CustomEvent) {
    this.editMode = e.detail.editing;
  }

  private closeMissingOnOutside = (e: Event) => {
    if (!this.contains(e.target as Node)) this.showMissing = false;
  };

  /** Whether the "+N not installed" menu is open (the form's Esc closes it first). */
  get missingOpen(): boolean {
    return this.showMissing;
  }

  /**
   * Closes the "+N not installed" menu. QA 2026-10-12: Esc in that menu used to reach the
   * form's document-level handler and dismiss the whole New session dialog.
   */
  closeMissing(returnFocus = true) {
    if (!this.showMissing) return;
    this.showMissing = false;
    if (returnFocus) {
      this.querySelector<HTMLElement>('[data-testid="quick-start-missing"]')?.focus();
    }
  }

  updated() {
    if (this.showMissing) document.addEventListener('pointerdown', this.closeMissingOnOutside);
    else document.removeEventListener('pointerdown', this.closeMissingOnOutside);
  }

  /** Opens / closes the "+N not installed" menu; opening focuses its first item. */
  private toggleMissing() {
    this.showMissing = !this.showMissing;
    if (this.showMissing) {
      void this.updateComplete.then(() =>
        this.querySelector<HTMLElement>('.cf-missing-item')?.focus()
      );
    }
  }

  /**
   * ↑ ↓ (wrapping), Home, End and Esc in the menu (spec 3: every .ut-menu). Not menuKeyboard():
   * its items skip aria-disabled ones, and every item here is aria-disabled (not installed;
   * picking one explains why) yet still reachable.
   */
  private handleMissingKeydown = (e: KeyboardEvent) => {
    const items = [...this.querySelectorAll<HTMLElement>('.cf-missing-item')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    switch (e.key) {
      case 'ArrowDown':
        next = (index + 1) % items.length;
        break;
      case 'ArrowUp':
        next = index <= 0 ? items.length - 1 : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      case 'Escape':
        this.closeMissing();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    items[next]?.focus();
  };

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('pointerdown', this.closeMissingOnOutside);
  }

  /** The label without emoji or sparkles a server config may still carry ("✨ claude"). */
  private cleanLabel(label: string): string {
    return label.replace(/\p{Extended_Pictographic}|\uFE0F/gu, '').trim() || label;
  }

  private glyph(command: string) {
    const words = parseCommand(command);
    const session = { command: words } as unknown as Session;
    const kind = agentKind(session);
    if (kind === 'shell' && isAIAssistantSession(session)) return icon('sparkles');
    return agentLogo(kind, undefined, 16);
  }

  private renderEditor(editing: boolean) {
    return html`<quick-start-editor
      .commands=${this.commands.map((cmd) => ({
        name: cmd.label === cmd.command ? undefined : cmd.label,
        command: cmd.command,
      }))}
      .editing=${editing}
      @quick-start-changed=${this.handleQuickStartChanged}
      @editing-changed=${this.handleEditingChanged}
    ></quick-start-editor>`;
  }

  render() {
    if (this.editMode) {
      return html`<div class="mt-4 -mx-5">${this.renderEditor(true)}</div>`;
    }
    const available = this.commands.filter((cmd) =>
      isQuickStartAvailable(this.availability, cmd.command)
    );
    const missing = this.commands.filter(
      (cmd) => !isQuickStartAvailable(this.availability, cmd.command)
    );
    const busy = this.disabled || this.isCreating;
    return html`
      <div class="mb-4">
        <div class="flex items-center justify-between mb-1.5">
          <span class="ut-label mb-0" id="quick-start-label">${t('create.agent')}</span>
          ${this.renderEditor(false)}
        </div>
        <div class="cf-agents" role="group" aria-labelledby="quick-start-label" data-testid="quick-start-pills">
          ${available.map(
            ({ label, command }) => html`
              <button
                type="button"
                class="ut-surface--badge cf-agent"
                aria-pressed=${this.selectedCommand === command ? 'true' : 'false'}
                title=${command}
                ?disabled=${busy}
                @click=${() => this.handleQuickStartClick(command)}
              >
                ${this.glyph(command)}
                <span class="truncate">${this.cleanLabel(label)}</span>
              </button>
            `
          )}
          ${
            missing.length
              ? html`
                <div class="relative">
                  <button
                    type="button"
                    class="ut-surface--badge cf-agent cf-agent--more"
                    aria-haspopup="menu"
                    aria-expanded=${this.showMissing ? 'true' : 'false'}
                    data-testid="quick-start-missing"
                    ?disabled=${busy}
                    @click=${() => this.toggleMissing()}
                  >
                    ${t('create.notInstalledMore', { n: missing.length })}
                    ${icon('chevronDown', 14)}
                  </button>
                  ${
                    this.showMissing
                      ? html`
                        <div
                          class="ut-menu cf-missing-menu"
                          role="menu"
                          @keydown=${this.handleMissingKeydown}
                        >
                          <div class="ut-menu-label">${t('quickStart.notInstalled')}</div>
                          ${missing.map(
                            ({ label, command }) => html`
                              <button
                                type="button"
                                role="menuitem"
                                class="ut-surface--control ut-menu-item cf-missing-item"
                                aria-disabled="true"
                                @click=${() => {
                                  this.showMissing = false;
                                  this.handleQuickStartClick(command);
                                }}
                              >
                                ${this.glyph(command)}
                                <span class="truncate">${this.cleanLabel(label)}</span>
                              </button>
                            `
                          )}
                        </div>
                      `
                      : nothing
                  }
                </div>
              `
              : nothing
          }
        </div>
        ${
          this.unavailableProgram
            ? html`<p id="quick-start-unavailable-notice" class="mt-2 text-caption text-text-muted">
                ${t('quickStart.notInstalledOnMac', { name: this.unavailableProgram })}
              </p>`
            : nothing
        }
      </div>
    `;
  }
}

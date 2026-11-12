/**
 * Quick actions strip (phone): a horizontally scrolling row of one-tap prompts docked above
 * the session's bottom bar (quick keys or action bar), from the project's
 * `.untether/quick-actions.json` or the defaults for the session's agent
 * (shared/quick-actions.ts). A tap types the prompt into the session and presses Enter; an
 * action with `confirm` asks first, in the strip itself. The ✎ button opens a minimal editor
 * (add, delete, reorder) that saves the project's file. Docked in the session view's flex
 * column, so the terminal fits above it and its input line is never covered; it can be hidden
 * from the ⋯ menu (a per-browser preference).
 */
import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  newQuickActionId,
  QUICK_ACTION_LIMITS,
  type QuickAction,
  type QuickActionAgent,
  type QuickActionsResponse,
  quickActionsFor,
} from '../../shared/quick-actions.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, type MessageKey, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { agentKind } from '../utils/agent-mission.js';
import { createLogger } from '../utils/logger.js';
import {
  QUICK_ACTIONS_VISIBILITY_EVENT,
  quickActionsHidden,
} from '../utils/quick-actions-visibility.js';
import { icon } from './icons.js';
import './modal-wrapper.js';

const logger = createLogger('quick-actions-bar');

/** Default actions show in the interface language (the file's own text is shown as written). */
const DEFAULT_TEXT: Record<string, { label: MessageKey; prompt?: MessageKey }> = {
  status: { label: 'quickActions.default.status', prompt: 'quickActions.default.statusPrompt' },
  'next-steps': {
    label: 'quickActions.default.nextSteps',
    prompt: 'quickActions.default.nextStepsPrompt',
  },
  'run-tests': {
    label: 'quickActions.default.runTests',
    prompt: 'quickActions.default.runTestsPrompt',
  },
  'summarize-changes': {
    label: 'quickActions.default.summarize',
    prompt: 'quickActions.default.summarizePrompt',
  },
  // `/compact` is a command, the same in every language.
  compact: { label: 'quickActions.default.compact' },
};

function localizedDefaults(actions: QuickAction[]): QuickAction[] {
  return actions.map((action) => {
    const text = DEFAULT_TEXT[action.id];
    if (!text) return action;
    return {
      ...action,
      label: t(text.label),
      prompt: text.prompt ? t(text.prompt) : action.prompt,
    };
  });
}

/** The schema's agent for a session: Claude, Codex, or null (a shell, Gemini…). */
export function quickActionAgent(session: Session | null): QuickActionAgent | null {
  const kind = session ? agentKind(session) : null;
  return kind === 'claude' || kind === 'codex' ? kind : null;
}

interface Draft {
  emoji: string;
  label: string;
  prompt: string;
  confirm: boolean;
  agents: QuickActionAgent[];
}

const EMPTY_DRAFT: Draft = { emoji: '⚡', label: '', prompt: '', confirm: false, agents: [] };

@customElement('quick-actions-bar')
export class QuickActionsBar extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) session: Session | null = null;
  @property({ type: Boolean }) visible = true;
  /** Types the prompt into the session and presses Enter. */
  @property({ type: Function }) onSend?: (prompt: string) => void | Promise<void>;

  @state() private actions: QuickAction[] = [];
  @state() private source: QuickActionsResponse['source'] = 'default';
  @state() private filePath = '';
  @state() private userHidden = quickActionsHidden();
  @state() private pending: QuickAction | null = null;
  @state() private editing = false;
  @state() private editList: QuickAction[] = [];
  @state() private draft: Draft = { ...EMPTY_DRAFT };
  @state() private saving = false;
  @state() private error = '';
  /** The list came back from the server (an empty one included). */
  @state() private loaded = false;

  protected readonly i18n = new LocaleController(this);
  private loadedFor = '';
  private wasShown = false;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(QUICK_ACTIONS_VISIBILITY_EVENT, this.handleVisibility);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(QUICK_ACTIONS_VISIBILITY_EVENT, this.handleVisibility);
  }

  private handleVisibility = (e: Event) => {
    this.userHidden = Boolean((e as CustomEvent<{ hidden: boolean }>).detail?.hidden);
    this.pending = null;
  };

  protected willUpdate(changed: PropertyValues<this>) {
    const id = this.session?.id ?? '';
    if (changed.has('session') && id && id !== this.loadedFor) {
      this.loadedFor = id;
      this.pending = null;
      this.loaded = false;
      void this.load(id);
    }
  }

  protected updated() {
    // The session view refits the terminal when the strip appears or goes.
    const shown = this.stripShown();
    if (shown !== this.wasShown) {
      this.wasShown = shown;
      this.dispatchEvent(
        new CustomEvent('quick-actions-layout-change', { bubbles: true, composed: true })
      );
    }
  }

  private async load(sessionId: string) {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/quick-actions`, {
        headers: authClient.getAuthHeader(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.apply(sessionId, (await response.json()) as QuickActionsResponse);
    } catch (error) {
      logger.warn(`could not load quick actions for ${sessionId}:`, error);
    }
  }

  /** Unless the view moved to another session meanwhile. */
  private apply(sessionId: string, data: QuickActionsResponse) {
    if (sessionId !== this.session?.id) return;
    this.source = data.source;
    this.filePath = data.path;
    this.actions = data.source === 'default' ? localizedDefaults(data.actions) : data.actions;
    this.loaded = true;
    for (const warning of data.warnings) logger.warn(`quick actions: ${warning}`);
  }

  private shownActions(): QuickAction[] {
    if (!this.visible || this.userHidden) return [];
    return quickActionsFor(this.actions, quickActionAgent(this.session));
  }

  /**
   * The strip shows once the list loaded even when it is empty for this agent: an empty list
   * used to hide the strip and its pencil for good, leaving no way back to the editor.
   */
  private stripShown(): boolean {
    return this.visible && !this.userHidden && this.loaded;
  }

  // pointerdown's default would move focus off the terminal's hidden input and close the
  // soft keyboard; the tap still clicks, and a scroll of the strip still scrolls.
  private keepFocus = (e: Event) => e.preventDefault();

  private tap(action: QuickAction, e: Event) {
    // session-view's click handler would steal the focus (closing the keyboard).
    e.stopPropagation();
    if (action.confirm) {
      this.pending = action;
      return;
    }
    void this.send(action);
  }

  private async send(action: QuickAction) {
    this.pending = null;
    if ('vibrate' in navigator) navigator.vibrate(10);
    logger.debug(`quick action ${action.id}`);
    await this.onSend?.(action.prompt);
  }

  private openEditor(e: Event) {
    e.stopPropagation();
    this.pending = null;
    this.editList = this.actions.map((a) => ({ ...a }));
    this.draft = { ...EMPTY_DRAFT, agents: [] };
    this.error = '';
    this.editing = true;
  }

  private closeEditor = () => {
    this.editing = false;
    this.error = '';
  };

  private move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= this.editList.length) return;
    const list = [...this.editList];
    [list[index], list[target]] = [list[target], list[index]];
    this.editList = list;
  }

  private removeAt(index: number) {
    this.editList = this.editList.filter((_, i) => i !== index);
  }

  private addDraft() {
    const { emoji, label, prompt, confirm, agents } = this.draft;
    if (!emoji.trim() || !label.trim() || !prompt.trim()) {
      this.error = t('quickActions.editor.required');
      return;
    }
    const action: QuickAction = {
      id: newQuickActionId(label, this.editList),
      emoji: emoji.trim(),
      label: label.trim(),
      prompt,
    };
    if (confirm) action.confirm = true;
    if (agents.length) action.agents = [...agents];
    this.editList = [...this.editList, action];
    this.draft = { ...EMPTY_DRAFT, agents: [] };
    this.error = '';
  }

  private toggleDraftAgent(agent: QuickActionAgent, on: boolean) {
    const agents = this.draft.agents.filter((a) => a !== agent);
    this.draft = { ...this.draft, agents: on ? [...agents, agent] : agents };
  }

  private async save() {
    const sessionId = this.session?.id;
    if (!sessionId || this.saving) return;
    this.saving = true;
    this.error = '';
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/quick-actions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
        body: JSON.stringify({ actions: this.editList }),
      });
      const body = (await response.json().catch(() => ({}))) as
        | QuickActionsResponse
        | { error?: string };
      if (!response.ok) {
        this.error = ('error' in body && body.error) || t('quickActions.editor.saveFailed');
        return;
      }
      this.apply(sessionId, body as QuickActionsResponse);
      this.editing = false;
    } catch (error) {
      logger.error('could not save quick actions:', error);
      this.error = t('quickActions.editor.saveFailed');
    } finally {
      this.saving = false;
    }
  }

  private renderConfirm(action: QuickAction) {
    return html`
      <div class="ut-qa-confirm" role="alertdialog" aria-label=${t('quickActions.confirmTitle')}>
        <span class="ut-qa-confirm-text">
          ${action.emoji} ${t('quickActions.confirm', { label: action.label })}
        </span>
        <button
          type="button"
          class="ut-btn ut-btn--ghost ut-qa-confirm-btn"
          data-testid="quick-action-cancel"
          @pointerdown=${this.keepFocus}
          @click=${(e: Event) => {
            e.stopPropagation();
            this.pending = null;
          }}
        >
          ${t('common.cancel')}
        </button>
        <button
          type="button"
          class="ut-btn ut-btn--primary ut-qa-confirm-btn"
          data-testid="quick-action-confirm"
          @pointerdown=${this.keepFocus}
          @click=${(e: Event) => {
            e.stopPropagation();
            void this.send(action);
          }}
        >
          ${t('quickActions.send')}
        </button>
      </div>
    `;
  }

  private renderEditor() {
    const agentLabel = (agent: QuickActionAgent) =>
      agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : agent;
    return html`
      <modal-wrapper
        .visible=${this.editing}
        .closeOnBackdrop=${true}
        .closeOnEscape=${true}
        .contentClass=${'ut-dialog ut-dialog--md ssh-dialog'}
        .ariaLabel=${t('quickActions.editor.title')}
        placement="sheet"
        @close=${this.closeEditor}
      >
        <div data-testid="quick-actions-editor">
          <div class="ut-dialog-header">
            <div class="flex items-center justify-between gap-2 min-w-0">
              <h2 class="m-0 text-title font-semibold text-text-bright truncate">
                ${t('quickActions.editor.title')}
              </h2>
              <button
                type="button"
                class="ut-icon-btn"
                data-modal-close
                @click=${this.closeEditor}
                aria-label=${t('common.close')}
              >
                ${icon('x')}
              </button>
            </div>
            <p class="m-0 mt-1 text-caption text-text-muted break-all">
              ${this.source === 'default' ? t('quickActions.editor.defaultsNote') : nothing}
              ${this.filePath}
            </p>
          </div>
          <div class="ssh-body">
            <ul class="ut-qa-edit-list" aria-label=${t('quickActions.title')}>
              ${this.editList.map(
                (action, index) => html`
                  <li class="ut-qa-edit-row" data-testid="quick-action-edit-row">
                    <span class="ut-qa-edit-emoji" aria-hidden="true">${action.emoji}</span>
                    <span class="ut-qa-edit-text">
                      <span class="ut-qa-edit-label">${action.label}</span>
                      <span class="ut-qa-edit-prompt">${action.prompt}</span>
                      ${
                        action.agents || action.confirm
                          ? html`<span class="ut-qa-edit-meta">
                            ${action.agents ? action.agents.map(agentLabel).join(' · ') : nothing}
                            ${action.confirm ? html` · ${t('quickActions.editor.confirmTag')}` : nothing}
                          </span>`
                          : nothing
                      }
                    </span>
                    <button
                      type="button"
                      class="ut-icon-btn ut-qa-edit-btn"
                      aria-label=${t('quickActions.editor.moveUp', { label: action.label })}
                      ?disabled=${index === 0}
                      @click=${() => this.move(index, -1)}
                    >
                      ${html`<span class="ut-qa-up">${icon('chevronDown', 18)}</span>`}
                    </button>
                    <button
                      type="button"
                      class="ut-icon-btn ut-qa-edit-btn"
                      aria-label=${t('quickActions.editor.moveDown', { label: action.label })}
                      ?disabled=${index === this.editList.length - 1}
                      @click=${() => this.move(index, 1)}
                    >
                      ${icon('chevronDown', 18)}
                    </button>
                    <button
                      type="button"
                      class="ut-icon-btn ut-qa-edit-btn"
                      data-testid="quick-action-delete"
                      aria-label=${t('quickActions.editor.delete', { label: action.label })}
                      @click=${() => this.removeAt(index)}
                    >
                      ${icon('trash', 18)}
                    </button>
                  </li>
                `
              )}
            </ul>

            <fieldset class="ut-qa-add">
              <legend class="text-caption font-medium text-text-muted">
                ${t('quickActions.editor.add')}
              </legend>
              <div class="flex gap-2">
                <input
                  class="ut-field ut-qa-emoji-field"
                  aria-label=${t('quickActions.editor.emoji')}
                  maxlength=${QUICK_ACTION_LIMITS.emoji}
                  .value=${this.draft.emoji}
                  @input=${(e: Event) => {
                    this.draft = { ...this.draft, emoji: (e.target as HTMLInputElement).value };
                  }}
                />
                <input
                  class="ut-field flex-1 min-w-0"
                  data-testid="quick-action-new-label"
                  placeholder=${t('quickActions.editor.label')}
                  aria-label=${t('quickActions.editor.label')}
                  maxlength=${QUICK_ACTION_LIMITS.label}
                  .value=${this.draft.label}
                  @input=${(e: Event) => {
                    this.draft = { ...this.draft, label: (e.target as HTMLInputElement).value };
                  }}
                />
              </div>
              <textarea
                class="ut-field ut-qa-prompt-field"
                data-testid="quick-action-new-prompt"
                rows="3"
                placeholder=${t('quickActions.editor.prompt')}
                aria-label=${t('quickActions.editor.prompt')}
                maxlength=${QUICK_ACTION_LIMITS.prompt}
                .value=${this.draft.prompt}
                @input=${(e: Event) => {
                  this.draft = { ...this.draft, prompt: (e.target as HTMLTextAreaElement).value };
                }}
              ></textarea>
              <div class="ut-qa-add-options">
                <label class="ut-qa-check">
                  <input
                    type="checkbox"
                    .checked=${this.draft.confirm}
                    @change=${(e: Event) => {
                      this.draft = {
                        ...this.draft,
                        confirm: (e.target as HTMLInputElement).checked,
                      };
                    }}
                  />
                  ${t('quickActions.editor.askFirst')}
                </label>
                ${(['claude', 'codex'] as const).map(
                  (agent) => html`<label class="ut-qa-check">
                    <input
                      type="checkbox"
                      .checked=${this.draft.agents.includes(agent)}
                      @change=${(e: Event) =>
                        this.toggleDraftAgent(agent, (e.target as HTMLInputElement).checked)}
                    />
                    ${t('quickActions.editor.onlyFor', { agent: agentLabel(agent) })}
                  </label>`
                )}
              </div>
              <button
                type="button"
                class="ut-btn ut-btn--secondary"
                data-testid="quick-action-add"
                @click=${() => this.addDraft()}
              >
                ${icon('plus', 16)} ${t('quickActions.editor.addButton')}
              </button>
            </fieldset>
            ${this.error ? html`<p class="text-status-error text-caption mt-2" role="alert">${this.error}</p>` : nothing}
          </div>
          <div class="ut-dialog-footer">
            <button type="button" class="ut-btn ut-btn--ghost" @click=${this.closeEditor}>
              ${t('common.cancel')}
            </button>
            <button
              type="button"
              class="ut-btn ut-btn--primary"
              data-testid="quick-actions-save"
              ?disabled=${this.saving}
              @click=${() => this.save()}
            >
              ${t('quickActions.editor.save')}
            </button>
          </div>
        </div>
      </modal-wrapper>
    `;
  }

  render() {
    const shown = this.shownActions();
    const editor = this.editing ? this.renderEditor() : nothing;
    if (!this.stripShown()) return editor;
    return html`
      <div
        class="ut-quick-actions"
        role="toolbar"
        aria-label=${t('quickActions.title')}
        data-testid="quick-actions-bar"
      >
        ${
          this.pending
            ? this.renderConfirm(this.pending)
            : html`
              <div class="ut-qa-scroll">
                ${shown.map(
                  (action) => html`
                    <button
                      type="button"
                      class="ut-qa-btn"
                      data-testid=${`quick-action-${action.id}`}
                      title=${action.prompt}
                      @pointerdown=${this.keepFocus}
                      @click=${(e: Event) => this.tap(action, e)}
                    >
                      <span class="ut-qa-emoji" aria-hidden="true">${action.emoji}</span>
                      <span class="ut-qa-label">${action.label}</span>
                    </button>
                  `
                )}
                ${
                  shown.length
                    ? nothing
                    : html`
                      <button
                        type="button"
                        class="ut-qa-btn"
                        data-testid="quick-actions-add"
                        @pointerdown=${this.keepFocus}
                        @click=${(e: Event) => this.openEditor(e)}
                      >
                        <span class="ut-qa-emoji" aria-hidden="true">＋</span>
                        <span class="ut-qa-label">${t('quickActions.editor.add')}</span>
                      </button>
                    `
                }
              </div>
              <button
                type="button"
                class="ut-qa-btn ut-qa-edit"
                data-testid="quick-actions-edit"
                aria-label=${t('quickActions.edit')}
                title=${t('quickActions.edit')}
                @pointerdown=${this.keepFocus}
                @click=${(e: Event) => this.openEditor(e)}
              >
                ${icon('pencil', 18)}
              </button>
            `
        }
      </div>
      ${editor}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'quick-actions-bar': QuickActionsBar;
  }
}

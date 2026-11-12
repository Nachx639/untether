import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { Z_INDEX } from '../utils/constants.js';
import {
  DEFAULT_QUICK_KEYS_LAYOUT,
  getHiddenQuickKeys,
  getQuickKeyDefinition,
  getQuickKeyDescription,
  getQuickKeyDisplayLabel,
  getQuickKeysPresetName,
  loadQuickKeysLayout,
  QUICK_KEYS_PRESETS,
  type QuickKeyId,
  type QuickKeysLayout,
  saveQuickKeysLayout,
} from '../utils/quick-keys-layout.js';

const MAX_KEYS_PER_ROW = 12;

@customElement('quick-keys-editor')
export class QuickKeysEditor extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Boolean }) visible = false;

  @state() private draftLayout: QuickKeysLayout = [];
  @state() private selectedKey: QuickKeyId | null = null;
  @state() private saveError = false;

  protected willUpdate(changedProperties: PropertyValues) {
    if (changedProperties.has('visible') && this.visible) {
      this.draftLayout = loadQuickKeysLayout();
      this.selectedKey = this.draftLayout[0]?.[0] ?? null;
      this.saveError = false;
    }
  }

  private handleClose() {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private applyPreset(layout: QuickKeysLayout) {
    this.draftLayout = layout.map((row) => [...row]);
    this.selectedKey = this.draftLayout[0]?.[0] ?? null;
    this.saveError = false;
  }

  private getSelectedPosition(): { row: number; index: number } | null {
    if (!this.selectedKey) return null;

    for (let row = 0; row < this.draftLayout.length; row++) {
      const index = this.draftLayout[row].indexOf(this.selectedKey);
      if (index >= 0) {
        return { row, index };
      }
    }
    return null;
  }

  private moveSelectedWithinRow(offset: -1 | 1) {
    const position = this.getSelectedPosition();
    if (!position) return;

    const targetIndex = position.index + offset;
    const sourceRow = this.draftLayout[position.row];
    if (targetIndex < 0 || targetIndex >= sourceRow.length) return;

    const nextLayout = this.draftLayout.map((row) => [...row]);
    const [key] = nextLayout[position.row].splice(position.index, 1);
    nextLayout[position.row].splice(targetIndex, 0, key);
    this.draftLayout = nextLayout;
  }

  private moveSelectedToRow(targetRow: number) {
    if (!this.selectedKey || !this.draftLayout[targetRow]) return;
    if (this.draftLayout[targetRow].length >= MAX_KEYS_PER_ROW) return;

    const position = this.getSelectedPosition();
    const nextLayout = this.draftLayout.map((row) => [...row]);

    if (position) {
      if (position.row === targetRow || nextLayout[position.row].length === 1) return;
      nextLayout[position.row].splice(position.index, 1);
    }

    nextLayout[targetRow].push(this.selectedKey);
    this.draftLayout = nextLayout;
  }

  private hideSelected() {
    const position = this.getSelectedPosition();
    if (!position || this.draftLayout[position.row].length === 1) return;

    const nextLayout = this.draftLayout.map((row) => [...row]);
    nextLayout[position.row].splice(position.index, 1);
    this.draftLayout = nextLayout;
  }

  private addRow() {
    if (this.draftLayout.length >= 3) return;

    const hiddenKey = getHiddenQuickKeys(this.draftLayout)[0]?.key;
    if (hiddenKey) {
      this.draftLayout = [...this.draftLayout.map((row) => [...row]), [hiddenKey]];
      this.selectedKey = hiddenKey;
      return;
    }

    const sourceRow = this.draftLayout.findIndex((row) => row.length > 1);
    if (sourceRow < 0) return;

    const nextLayout = this.draftLayout.map((row) => [...row]);
    const key = nextLayout[sourceRow].pop();
    if (!key) return;

    nextLayout.push([key]);
    this.draftLayout = nextLayout;
    this.selectedKey = key;
  }

  private removeThirdRow() {
    if (this.draftLayout.length !== 3) return;

    const nextLayout = this.draftLayout.slice(0, 2).map((row) => [...row]);
    for (const key of this.draftLayout[2]) {
      const targetRow = nextLayout[0].length <= nextLayout[1].length ? 0 : 1;
      if (nextLayout[targetRow].length >= MAX_KEYS_PER_ROW) return;
      nextLayout[targetRow].push(key);
    }

    this.draftLayout = nextLayout;
  }

  private handleSave() {
    if (!saveQuickKeysLayout(this.draftLayout)) {
      this.saveError = true;
      return;
    }

    this.handleClose();
  }

  private renderKey(key: QuickKeyId, rowIndex?: number) {
    const definition = getQuickKeyDefinition(key);
    const selected = this.selectedKey === key;
    const location =
      rowIndex === undefined
        ? t('quickKeys.editor.hidden')
        : t('quickKeys.editor.row', { n: rowIndex + 1 });
    const label = getQuickKeyDisplayLabel(key, definition.label);
    const description = getQuickKeyDescription(key);

    return html`
      <button
        type="button"
        class="ut-surface--control min-h-11 min-w-11 px-2 py-2 rounded-rem border font-mono text-xs transition-colors ${
          selected
            ? 'border-primary bg-primary/20 text-primary'
            : 'border-border bg-bg-tertiary text-text-muted hover:border-primary/60 hover:text-primary'
        }"
        aria-pressed=${selected ? 'true' : 'false'}
        aria-label="${description ?? label}, ${location}"
        title=${description ?? nothing}
        data-key=${key}
        @click=${() => {
          this.selectedKey = key;
          this.saveError = false;
        }}
      >
        ${label}
      </button>
    `;
  }

  private renderSelectedControls() {
    if (!this.selectedKey) return html``;

    const position = this.getSelectedPosition();
    if (!position) {
      return html`
        <div class="flex flex-wrap gap-2" aria-label=${t('quickKeys.editor.addSelected')}>
          ${this.draftLayout.map(
            (row, rowIndex) => html`
              <button
                type="button"
                class="ut-btn ut-btn--secondary text-xs px-3 py-2"
                ?disabled=${row.length >= MAX_KEYS_PER_ROW}
                @click=${() => this.moveSelectedToRow(rowIndex)}
              >
                ${t('quickKeys.editor.addToRow', { n: rowIndex + 1 })}
              </button>
            `
          )}
        </div>
      `;
    }

    const row = this.draftLayout[position.row];
    return html`
      <div class="flex flex-wrap gap-2" aria-label=${t('quickKeys.editor.reorderSelected')}>
        <button
          type="button"
          class="ut-btn ut-btn--secondary text-xs px-3 py-2"
          ?disabled=${position.index === 0}
          @click=${() => this.moveSelectedWithinRow(-1)}
        >
          ${t('quickKeys.editor.moveEarlier')}
        </button>
        <button
          type="button"
          class="ut-btn ut-btn--secondary text-xs px-3 py-2"
          ?disabled=${position.index === row.length - 1}
          @click=${() => this.moveSelectedWithinRow(1)}
        >
          ${t('quickKeys.editor.moveLater')}
        </button>
        ${this.draftLayout.map((target, rowIndex) =>
          rowIndex === position.row
            ? ''
            : html`
                <button
                  type="button"
                  class="ut-btn ut-btn--secondary text-xs px-3 py-2"
                  ?disabled=${row.length === 1 || target.length >= MAX_KEYS_PER_ROW}
                  @click=${() => this.moveSelectedToRow(rowIndex)}
                >
                  ${t('quickKeys.editor.moveToRow', { n: rowIndex + 1 })}
                </button>
              `
        )}
        <button
          type="button"
          class="ut-btn ut-btn--secondary text-xs px-3 py-2 text-status-error"
          ?disabled=${row.length === 1}
          @click=${this.hideSelected}
        >
          ${t('quickKeys.editor.hide')}
        </button>
      </div>
    `;
  }

  render() {
    if (!this.visible) return html``;

    const hiddenKeys = getHiddenQuickKeys(this.draftLayout);
    const selectedDefinition = this.selectedKey
      ? getQuickKeyDefinition(this.selectedKey)
      : undefined;

    return html`
      <div
        class="fixed inset-0 bg-bg/90 flex items-center justify-center p-2 sm:p-4"
        style="z-index: ${Z_INDEX.SHEET_EDITOR}"
        @click=${(event: Event) => {
          event.stopPropagation();
          if (event.target === event.currentTarget) {
            this.handleClose();
          }
        }}
      >
        <div
          class="ut-surface--floating ut-surface--material bg-bg-secondary border border-border rounded-xl shadow-drop-2xl w-full max-w-2xl max-h-[calc(100dvh-1rem)] overflow-hidden flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-labelledby="quick-keys-editor-title"
          @click=${(event: Event) => event.stopPropagation()}
        >
          <div class="p-4 border-b border-border/50 flex items-center justify-between">
            <div>
              <h2 id="quick-keys-editor-title" class="text-primary text-lg font-bold">
                ${t('settings.quickKeys')}
              </h2>
              <p class="text-muted text-xs mt-1">
                ${t('quickKeys.editor.subtitle', { done: t('quickKeys.done') })}
              </p>
            </div>
            <button
              type="button"
              class="ut-surface--control min-h-11 min-w-11 text-text-muted hover:text-primary"
              aria-label=${t('quickKeys.editor.close')}
              @click=${this.handleClose}
            >
              ✕
            </button>
          </div>

          <div class="flex-1 overflow-y-auto p-4 space-y-5">
            <div>
              <h3 class="text-sm font-medium text-primary mb-2">${t('quickKeys.editor.presets')}</h3>
              <div class="flex flex-wrap gap-2">
                ${QUICK_KEYS_PRESETS.map(
                  (preset) => html`
                    <button
                      type="button"
                      class="ut-btn ut-btn--secondary text-xs px-3 py-2"
                      @click=${() => this.applyPreset(preset.layout.map((row) => [...row]))}
                    >
                      ${getQuickKeysPresetName(preset)}
                    </button>
                  `
                )}
              </div>
            </div>

            <div class="space-y-3">
              ${this.draftLayout.map(
                (row, rowIndex) => html`
                  <section class="p-3 bg-bg rounded-lg border border-border/50">
                    <div class="flex items-center justify-between mb-2">
                      <h3 class="text-sm font-medium text-primary">${t('quickKeys.editor.row', { n: rowIndex + 1 })}</h3>
                      <span class="text-xs text-muted">${row.length}/${MAX_KEYS_PER_ROW}</span>
                    </div>
                    <div class="flex flex-wrap gap-1.5">
                      ${row.map((key) => this.renderKey(key, rowIndex))}
                      ${
                        rowIndex === 1
                          ? html`<span
                            class="min-h-11 px-3 py-2 rounded-rem border border-dashed border-border text-xs text-muted flex items-center"
                            >${t('quickKeys.done')}</span
                          >`
                          : ''
                      }
                    </div>
                  </section>
                `
              )}
              <div class="flex flex-wrap gap-2">
                ${
                  this.draftLayout.length < 3
                    ? html`
                      <button
                        type="button"
                        class="ut-btn ut-btn--secondary text-xs px-3 py-2"
                        @click=${this.addRow}
                      >
                        ${t('quickKeys.editor.addRow')}
                      </button>
                    `
                    : html`
                      <button
                        type="button"
                        class="ut-btn ut-btn--secondary text-xs px-3 py-2"
                        @click=${this.removeThirdRow}
                      >
                        ${t('quickKeys.editor.removeRow')}
                      </button>
                    `
                }
              </div>
            </div>

            <div class="p-3 bg-bg rounded-lg border border-border/50">
              <h3 class="text-sm font-medium text-primary mb-2">
                ${
                  selectedDefinition
                    ? html`${t('quickKeys.editor.selected')} <span class="font-mono">${getQuickKeyDisplayLabel(selectedDefinition.key, selectedDefinition.label)}</span>`
                    : t('quickKeys.editor.selectKey')
                }
              </h3>
              ${
                selectedDefinition && getQuickKeyDescription(selectedDefinition.key)
                  ? html`<p class="text-xs text-text-muted mb-2" data-testid="quick-key-description">
                      ${getQuickKeyDescription(selectedDefinition.key)}
                    </p>`
                  : nothing
              }
              ${this.renderSelectedControls()}
            </div>

            <div>
              <h3 class="text-sm font-medium text-primary mb-2">${t('quickKeys.editor.hiddenKeys')}</h3>
              <div class="flex flex-wrap gap-1.5 min-h-11">
                ${
                  hiddenKeys.length > 0
                    ? hiddenKeys.map(({ key }) => this.renderKey(key))
                    : html`<span class="text-xs text-muted">${t('quickKeys.editor.allVisible')}</span>`
                }
              </div>
            </div>

            ${
              this.saveError
                ? html`
                  <p class="text-sm text-status-error" role="alert">
                    ${t('quickKeys.editor.saveError')}
                  </p>
                `
                : ''
            }
          </div>

          <div class="p-4 border-t border-border/50 flex items-center justify-between gap-3">
            <button
              type="button"
              class="ut-btn ut-btn--secondary text-xs px-3 py-2"
              @click=${() => this.applyPreset(DEFAULT_QUICK_KEYS_LAYOUT)}
            >
              ${t('quickKeys.editor.resetDraft')}
            </button>
            <div class="flex gap-2">
              <button
                type="button"
                class="ut-btn ut-btn--secondary text-xs px-3 py-2"
                @click=${this.handleClose}
              >
                ${t('common.cancel')}
              </button>
              <button
                type="button"
                class="ut-surface--control btn-primary text-xs px-4 py-2"
                @click=${this.handleSave}
              >
                ${t('quickKeys.editor.apply')}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

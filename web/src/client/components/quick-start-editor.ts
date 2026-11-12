/**
 * Quick Start Editor Component
 *
 * Inline editor for managing quick start commands within the session create dialog.
 * Allows adding, editing, removing, and reordering quick start commands.
 *
 * @fires quick-start-changed - When commands are modified (detail: QuickStartCommand[])
 * @fires cancel - When editing is cancelled
 */
import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { DEFAULT_QUICK_START_COMMANDS, type QuickStartCommand } from '../../types/config.js';
import { LocaleController, t } from '../i18n/index.js';

@customElement('quick-start-editor')
export class QuickStartEditor extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Array }) commands: QuickStartCommand[] = [];
  @property({ type: Boolean }) editing = false;

  @state() private editableCommands: QuickStartCommand[] = [];
  @state() private draggedIndex: number | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.editableCommands = [...this.commands];
  }

  willUpdate(changedProperties: Map<string | number | symbol, unknown>) {
    // 2026-11-10: the section passes a new array on every render, so a re-render while the
    // user typed (an availability answer, say) wiped the rows being edited.
    // 2026-11-11: an editor that starts already editing took its rows on connecting only, so
    // one created before its chunk had loaded (its properties arrive after it connects) came
    // up with no rows. The rows follow the commands until the editing starts, that update included.
    if (changedProperties.has('commands') && (!this.editing || changedProperties.has('editing'))) {
      this.editableCommands = [...this.commands];
    }
  }

  private handleStartEdit() {
    this.editing = true;
    this.editableCommands = [...this.commands];
    this.dispatchEvent(
      new CustomEvent('editing-changed', {
        detail: { editing: true },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleSave() {
    // Filter out empty commands
    const validCommands = this.editableCommands.filter((cmd) => cmd.command.trim());

    this.dispatchEvent(
      new CustomEvent('quick-start-changed', {
        detail: validCommands,
        bubbles: true,
        composed: true,
      })
    );

    this.editing = false;
    this.dispatchEvent(
      new CustomEvent('editing-changed', {
        detail: { editing: false },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleCancel() {
    this.editableCommands = [...this.commands];
    this.editing = false;
    this.dispatchEvent(new CustomEvent('cancel'));
    this.dispatchEvent(
      new CustomEvent('editing-changed', {
        detail: { editing: false },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleNameChange(index: number, value: string) {
    this.editableCommands = [...this.editableCommands];
    this.editableCommands[index] = {
      ...this.editableCommands[index],
      name: value || undefined,
    };
    this.requestUpdate();
  }

  private handleCommandChange(index: number, value: string) {
    this.editableCommands = [...this.editableCommands];
    this.editableCommands[index] = {
      ...this.editableCommands[index],
      command: value,
    };
    this.requestUpdate();
  }

  private handleAddCommand() {
    this.editableCommands = [...this.editableCommands, { command: '' }];
    this.requestUpdate();

    // Focus the new command input after render
    setTimeout(() => {
      const inputs = this.querySelectorAll('input[data-command-input]');
      const lastInput = inputs[inputs.length - 1] as HTMLInputElement;
      lastInput?.focus();
    }, 0);
  }

  private handleResetToDefaults() {
    this.editableCommands = [...DEFAULT_QUICK_START_COMMANDS];
    this.requestUpdate();
  }

  private handleRemoveCommand(index: number) {
    this.editableCommands = this.editableCommands.filter((_, i) => i !== index);
    this.requestUpdate();
  }

  private handleDragStart(e: DragEvent, index: number) {
    this.draggedIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/html', ''); // Required for Firefox
    }

    // Add dragging class
    const target = e.target as HTMLElement;
    target.classList.add('opacity-50');
  }

  private handleDragEnd(e: DragEvent) {
    const target = e.target as HTMLElement;
    target.classList.remove('opacity-50');
    this.draggedIndex = null;
  }

  private handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }

  private handleDrop(e: DragEvent, dropIndex: number) {
    e.preventDefault();

    if (this.draggedIndex === null || this.draggedIndex === dropIndex) return;

    const commands = [...this.editableCommands];
    const draggedCommand = commands[this.draggedIndex];

    // Remove from old position
    commands.splice(this.draggedIndex, 1);

    // Insert at new position
    const adjustedIndex = this.draggedIndex < dropIndex ? dropIndex - 1 : dropIndex;
    commands.splice(adjustedIndex, 0, draggedCommand);

    this.editableCommands = commands;
    this.requestUpdate();
  }

  render() {
    if (!this.editing) {
      return html`
        <button
          id="quick-start-edit-button"
          @click=${this.handleStartEdit}
          class="ut-text-action text-primary hover:text-primary-hover text-[10px] sm:text-xs transition-colors duration-200 flex items-center gap-1"
          title=${t('quickStartEditor.editTitle')}
        >
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          ${t('quickStartEditor.edit')}
        </button>
      `;
    }

    return html`
      <div class="ut-surface--panel ut-surface--material w-full px-3 sm:px-4 lg:px-6 bg-bg-elevated py-3 sm:py-4">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-xs font-medium text-text-muted">${t('quickStartEditor.description')}</h3>
          <div class="flex gap-2">
            <button
              id="quick-start-cancel-button"
              @click=${this.handleCancel}
              class="ut-surface--control text-text-muted hover:text-text text-[10px] transition-colors duration-200"
            >
              ${t('common.cancel')}
            </button>
            <button
              id="quick-start-save-button"
              @click=${this.handleSave}
              class="ut-surface--control text-primary hover:text-primary-hover text-[10px] font-medium transition-colors duration-200"
            >
              ${t('common.save')}
            </button>
          </div>
        </div>
        
        <div class="space-y-2 max-h-48 overflow-y-auto">
          ${this.editableCommands.map(
            (cmd, index) => html`
            <div 
              id=${`quick-start-command-item-${index}`}
              draggable="true"
              @dragstart=${(e: DragEvent) => this.handleDragStart(e, index)}
              @dragend=${this.handleDragEnd}
              @dragover=${this.handleDragOver}
              @drop=${(e: DragEvent) => this.handleDrop(e, index)}
              class="ut-surface--panel flex items-center gap-2 p-2 bg-bg-secondary/50 border border-border/30 rounded-lg cursor-move hover:border-border/50 transition-colors duration-200"
            >
              <svg class="w-3 h-3 text-text-muted flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
              </svg>
              
              <input
                id=${`quick-start-name-input-${index}`}
                type="text"
                .value=${cmd.name || ''}
                @input=${(e: Event) => this.handleNameChange(index, (e.target as HTMLInputElement).value)}
                placeholder=${t('quickStartEditor.namePlaceholder')}
                class="ut-surface--inset flex-1 min-w-0 bg-bg-secondary border border-border/30 rounded-rem px-2 py-1 text-[10px] text-text focus:border-primary focus:outline-none"
              />
              
              <input
                id=${`quick-start-command-input-${index}`}
                type="text"
                .value=${cmd.command}
                @input=${(e: Event) => this.handleCommandChange(index, (e.target as HTMLInputElement).value)}
                placeholder=${t('quickStartEditor.commandPlaceholder')}
                data-command-input
                class="ut-surface--inset flex-1 min-w-0 bg-bg-secondary border border-border/30 rounded-rem px-2 py-1 text-[10px] text-text font-mono focus:border-primary focus:outline-none"
              />
              
              <button
                id=${`quick-start-remove-command-${index}`}
                @click=${() => this.handleRemoveCommand(index)}
                class="ut-surface--control text-text-muted hover:text-error transition-colors duration-200 p-1"
                title=${t('quickStartEditor.remove')}
              >
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          `
          )}
        </div>
        
        <!-- Bottom actions -->
        <div class="flex justify-between items-center mt-4">
          <button
            id="quick-start-reset-button"
            @click=${this.handleResetToDefaults}
            class="ut-surface--control text-primary hover:text-primary-hover text-[10px] transition-colors duration-200"
            title=${t('quickStartEditor.resetTitle')}
          >
            ${t('quickStartEditor.reset')}
          </button>
          
          <div class="flex gap-4 items-center">
            <button
              id="quick-start-delete-all-button"
              @click=${() => {
                this.editableCommands = [];
                this.requestUpdate();
              }}
              class="ut-text-action text-error hover:text-error-hover text-xs transition-colors duration-200"
            >
              ${t('quickStartEditor.deleteAll')}
            </button>
            
            <button
              id="quick-start-add-command-button"
              @click=${this.handleAddCommand}
              class="ut-surface--control bg-bg-secondary hover:bg-hover text-text-muted hover:text-primary px-3 py-1.5 rounded-md transition-colors duration-200 text-xs font-medium flex items-center gap-1.5"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v12m6-6H6" />
              </svg>
              ${t('quickStartEditor.add')}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

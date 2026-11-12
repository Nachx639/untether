import { html, nothing } from 'lit';
import { t } from '../../i18n/index.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { endsADrag } from '../../utils/pointer-drag.js';
import {
  defaultQuickPrompts,
  type QuickPrompt,
  saveQuickPrompts,
  templateText,
} from '../../utils/quick-prompts.js';
import { icon } from '../icons.js';
import { saveDraft } from './composer-storage.js';
import { TerminalChatScreenMenu } from './screen-menu.js';

/** Quick replies: the chips over the composer and their editor. */
export abstract class TerminalChatQuickPrompts extends TerminalChatScreenMenu {
  /** Whether quick prompts make sense now, room aside. */
  protected quickPromptsOffered(): boolean {
    // Not while Claude waits on a menu: "Sí" or "Continúa" are not answers to it.
    // Nor while Claude works or the mic is on: the busy strip or the recording takes the slot.
    if (
      !this.composerOnly ||
      this.desktop ||
      !this.composerEmpty ||
      this.screenMenu ||
      this.claudeWaiting ||
      this.chatBusy ||
      this.dictation !== 'idle'
    ) {
      return false;
    }
    // Quick prompts are for coding agents (Claude Code, Codex, Gemini), not plain shells.
    // (Their defaults are generic; `/compact` is also a Gemini alias of /compress.)
    return this.claudeSession !== false || this.agent === 'codex' || this.agent === 'gemini';
  }

  /** The chips are hidden for room, but the composer's button opens them (`landscape`). */
  protected get promptsOnRequest(): boolean {
    return this.compactChrome && this.landscape;
  }

  /** Portrait, keyboard up, room for one slim row of replies over the field. */
  protected get slimRowWithKeyboard(): boolean {
    if (!this.compactChrome || this.landscape || !this.keyboardUp) return false;
    const visible = window.visualViewport?.height ?? window.innerHeight;
    return visible >= 300;
  }

  protected renderQuickPrompts() {
    if (!this.quickPromptsOffered()) return nothing;
    const kbdRow = this.slimRowWithKeyboard;
    const slim = this.promptsOnRequest || kbdRow;
    if (this.compactChrome && !kbdRow && !(this.promptsOnRequest && this.promptsOpen))
      return nothing;
    const prompts = this.customPrompts ?? defaultQuickPrompts();
    return html`<div
      class="quick-prompts ${slim ? 'slim' : ''}"
      id="quick-prompts-row"
      data-testid="quick-prompts"
      data-no-swipe
      role="toolbar"
      aria-label=${t('prompts.rowLabel')}
      @click=${(e: Event) => e.stopPropagation()}
    >
      <div class="qp-scroller">
        ${prompts.map(
          (prompt) =>
            html`<button
              class="ut-surface--badge quick-prompt"
              dir="auto"
              title=${prompt.text}
              @pointerdown=${this.quickPromptPress}
              @pointercancel=${this.cancelLongPress}
              @mousedown=${(e: Event) => e.preventDefault()}
              @contextmenu=${(e: Event) => e.preventDefault()}
              @pointerup=${this.quickPromptTap(() => this.runQuickPrompt(prompt))}
              @click=${this.quickPromptTap(() => this.runQuickPrompt(prompt))}
            >
              ${prompt.label}
            </button>`
        )}
      </div>
      <button
        class="ut-surface--badge quick-prompt edit"
        data-testid="edit-quick-prompts"
        title=${t('prompts.edit')}
        aria-label=${t('prompts.edit')}
        @pointerdown=${(e: Event) => e.preventDefault()}
        @mousedown=${(e: Event) => e.preventDefault()}
        @pointerup=${this.quickPromptTap(this.openPromptEditor)}
        @click=${this.quickPromptTap(this.openPromptEditor)}
      >
        ${icon('pencil', 18)}
      </button>
    </div>`;
  }

  protected openPromptEditor = () => {
    this.editingPrompts = (this.customPrompts ?? defaultQuickPrompts()).map((p) => ({ ...p }));
  };

  protected closePromptEditor = () => {
    this.closeDialog(this.shadowRoot?.querySelector<HTMLDialogElement>('.prompt-editor'));
    this.editingPrompts = null;
  };

  protected savePromptEditor = () => {
    const prompts = (this.editingPrompts ?? [])
      .map((p) => ({ label: p.label.trim() || p.text.trim(), text: p.text.trim() }))
      .filter((p) => p.text);
    saveQuickPrompts(prompts);
    this.customPrompts = prompts;
    this.closePromptEditor();
  };

  protected resetPromptEditor = () => {
    saveQuickPrompts(null);
    this.customPrompts = null;
    this.closePromptEditor();
  };

  protected movePrompt(index: number, delta: number) {
    const prompts = [...(this.editingPrompts ?? [])];
    const target = index + delta;
    if (target < 0 || target >= prompts.length) return;
    [prompts[index], prompts[target]] = [prompts[target], prompts[index]];
    this.editingPrompts = prompts;
  }

  /**
   * The quick reply editor as a bottom sheet (phone-spec §3.7): rows of drag handle · label
   * over text · delete, "Añadir" at the end, and a footer that stays in sight (Restaurar ·
   * Cancelar · Guardar). The handle also moves its row with ↑ ↓.
   */
  protected renderPromptEditor() {
    const prompts = this.editingPrompts;
    if (!prompts) return nothing;
    return html`<dialog
      class="prompt-editor sheet"
      aria-label=${t('prompts.edit')}
      tabindex="-1"
      @cancel=${(e: Event) => {
        e.preventDefault();
        this.closePromptEditor();
      }}
      @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
      @click=${(e: Event) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) this.closePromptEditor();
      }}
    >
      <div class="sheet-grabber" data-sheet-handle aria-hidden="true"></div>
      <h2 data-sheet-handle>${t('prompts.edit')}</h2>
      <p>${t('prompts.hint')}</p>
      <ol>
        ${prompts.map(
          (prompt, index) => html`<li class=${this.draggingPrompt === index ? 'dragging' : ''}>
            <button
              class="ut-surface--badge prompt-handle"
              data-no-sheet-drag
              aria-label=${t('phone.dragToReorder')}
              title=${t('phone.dragToReorder')}
              @pointerdown=${(e: PointerEvent) => this.startPromptDrag(e, index)}
              @pointermove=${this.movePromptDrag}
              @pointerup=${this.endPromptDrag}
              @pointercancel=${this.endPromptDrag}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  this.movePrompt(index, e.key === 'ArrowUp' ? -1 : 1);
                  void this.updateComplete.then(() =>
                    this.shadowRoot
                      ?.querySelectorAll<HTMLElement>('.prompt-handle')
                      [index + (e.key === 'ArrowUp' ? -1 : 1)]?.focus()
                  );
                }
              }}
            >
              ${icon('grip', 18)}
            </button>
            <input
              class="prompt-label"
              dir="auto"
              enterkeyhint="next"
              placeholder=${t('prompts.label')}
              aria-label=${t('prompts.label')}
              .value=${prompt.label}
              @input=${(e: Event) => {
                prompt.label = (e.target as HTMLInputElement).value;
              }}
            />
            <input
              class="prompt-text"
              dir="auto"
              enterkeyhint="done"
              placeholder=${t('prompts.text')}
              aria-label=${t('prompts.text')}
              .value=${prompt.text}
              @input=${(e: Event) => {
                prompt.text = (e.target as HTMLInputElement).value;
              }}
            />
            <button
              class="ut-surface--badge prompt-remove"
              aria-label=${t('prompts.remove')}
              title=${t('prompts.remove')}
              @click=${() => {
                this.editingPrompts = prompts.filter((_, i) => i !== index);
              }}
            >
              ${icon('trash', 18)}
            </button>
          </li>`
        )}
        <li class="add-row">
          <button
            class="ut-surface--badge prompt-add"
            @click=${() => {
              this.editingPrompts = [...prompts, { label: '', text: '' }];
            }}
          >
            ${icon('plus', 18)}${t('prompts.add')}
          </button>
        </li>
      </ol>
      <footer>
        <button class="ut-surface--badge prompt-reset" @click=${this.resetPromptEditor}>${t('phone.restore')}</button>
        <span class="spacer"></span>
        <button class="ut-surface--badge prompt-cancel" @click=${this.closePromptEditor}>${t('common.cancel')}</button>
        <button class="ut-surface--badge save" @click=${this.savePromptEditor}>${t('common.save')}</button>
      </footer>
    </dialog>`;
  }

  /** A drag on a row's handle moves the row to where the finger is (live). */
  protected startPromptDrag(e: PointerEvent, index: number) {
    if (e.button > 0) return;
    this.draggingPrompt = index;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  protected movePromptDrag = (e: PointerEvent) => {
    const from = this.draggingPrompt;
    if (from === null) return;
    const rows = Array.from(
      this.shadowRoot?.querySelectorAll<HTMLElement>('.prompt-editor li:not(.add-row)') ?? []
    );
    const to = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return e.clientY >= rect.top && e.clientY < rect.bottom;
    });
    if (to < 0 || to === from) return;
    const prompts = [...(this.editingPrompts ?? [])];
    const [moved] = prompts.splice(from, 1);
    prompts.splice(to, 0, moved);
    this.editingPrompts = prompts;
    this.draggingPrompt = to;
  };

  protected endPromptDrag = () => {
    this.draggingPrompt = null;
    this.requestUpdate();
  };

  /** Keeps focus (and the keyboard) on the message field. */
  protected quickPromptPress = (e: PointerEvent) => {
    e.preventDefault();
    // Holding a chip opens the editor.
    this.cancelLongPress();
    this.longPressed = false;
    this.longPressTimer = setTimeout(() => {
      this.longPressed = true;
      this.openPromptEditor();
    }, 500);
  };

  protected cancelLongPress = () => {
    clearTimeout(this.longPressTimer);
    this.longPressTimer = undefined;
  };

  /**
   * Touch acts on pointerup: on iOS the first tap on a button could be taken as a hover and
   * produce no click. The click that may still follow is ignored; mouse and keyboard use it.
   * Any button that cancels pointerdown (to keep the field focused) must act through this:
   * WebKit then sends no click for a touch at all (+, Enter and slash items were dead on
   * iPhone, 2026-10-12). `opensOver`: the action opens a sheet under the finger.
   */
  protected quickPromptTap(action: () => void, opensOver = false) {
    return (e: Event) => {
      if (e.type === 'pointerup') this.cancelLongPress();
      if (this.longPressed && e.type === 'pointerup') {
        // The press already opened the editor: neither its release nor its click is a tap.
        this.longPressed = false;
        this.quickPromptAt = Date.now();
        swallowNextClick();
        return;
      }
      if (e.type === 'pointerup') {
        const pointer = e as PointerEvent;
        if (pointer.pointerType === 'mouse') return;
        // A drag is not a tap: one that scrolled the row, or began on the pencil or a menu option.
        if (endsADrag(pointer)) return;
        this.quickPromptAt = Date.now();
        // A sheet opened over the finger: a click that may still come lands on its backdrop
        // and closed it at once (2026-10-12, + on a WebKit touch).
        if (opensOver) swallowNextClick();
      } else if (Date.now() - this.quickPromptAt < 700) {
        return;
      }
      action();
    };
  }

  /** Send the prompt as if typed and sent; a "…" template goes into the field instead. */
  protected runQuickPrompt(prompt: QuickPrompt) {
    const input = this.inputElement;
    if (!input) return;
    // The slim row opened for this prompt has done its job.
    this.promptsOpen = false;
    const template = templateText(prompt.text);
    if (template !== null) {
      input.value = template;
      if (input instanceof HTMLTextAreaElement) this.autoSize(input);
      saveDraft(this.sessionId, input.value);
      this.syncComposerEmpty();
      input.focus();
      return;
    }
    input.value = prompt.text;
    this.handleSend();
  }
}

import { css, html, nothing, type TemplateResult } from 'lit';
import type { PromptTranslate } from '../../../shared/claude-prompt-text.js';
import { t } from '../../i18n/index.js';

/** `t` narrowed for the prompt translator (shared code takes its wording as a function). */
export const promptT: PromptTranslate = (key, params) => t(key, params);

/**
 * One anatomy for a prompt's options on a phone (phone-spec §3.6, 2026-10-12): the chat's
 * docked prompt and the composer's screen menu draw it with this, the reply sheet copies it.
 * Attention eyebrow, the detail (label over the command, three lines, tap for the rest), the
 * question, then 48 px numbered rows: option 1 is the surface's primary, "No…" stays neutral.
 */
export const promptDockStyles = css`
  .pd {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: min(62vh, 440px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 10px max(16px, env(safe-area-inset-right, 0px)) 12px
      calc(max(16px, env(safe-area-inset-left, 0px)) - 3px);
    border-top: 1px solid var(--color-border);
    border-left: 3px solid var(--color-attention);
    background: linear-gradient(var(--color-attention-muted), var(--color-attention-muted)),
      var(--color-bg);
    font-family: var(--font-ui, system-ui, sans-serif);
    color: var(--color-text);
    text-align: start;
  }
  .pd-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 20px;
  }
  .pd-eyebrow {
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    line-height: 16px;
    font-weight: var(--ut-fw-semibold);
    color: var(--color-attention-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pd-link {
    position: relative;
    flex: none;
    padding: 0 2px;
    border: none;
    background: none;
    color: var(--color-text-muted);
    font: inherit;
    font-size: 0.8125rem;
    line-height: 18px;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .pd-link::after {
    content: '';
    position: absolute;
    inset: -13px -8px;
  }
  .pd-note {
    font-size: 0.8125rem;
    line-height: 18px;
    color: var(--color-attention-text);
  }
  .pd-detail {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: start;
  }
  .pd-detail-label {
    font-size: 0.75rem;
    line-height: 16px;
    font-weight: var(--ut-fw-semibold);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-dim);
  }
  .pd-cmd {
    display: -webkit-box;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    border-radius: var(--ut-r-md);
    background: var(--color-bg-tertiary);
    color: var(--color-text);
    font: 0.8125rem/1.125rem var(--font-mono, ui-monospace, monospace);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    direction: ltr;
    text-align: left;
  }
  .pd-cmd.open {
    display: block;
  }
  .pd-question {
    font-size: 0.9375rem;
    line-height: 20px;
    font-weight: var(--ut-fw-semibold);
    color: var(--color-text-bright, var(--color-text));
  }
  .pd-options {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .pd-option {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 48px;
    box-sizing: border-box;
    padding: 6px 12px 6px 8px;
    border: 1px solid var(--color-border-strong, var(--color-border));
    border-radius: var(--ut-r-12);
    background: var(--color-bg-elevated);
    color: var(--color-text);
    font: inherit;
    font-size: 1rem;
    line-height: 21px;
    text-align: start;
    overflow-wrap: anywhere;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .pd-option:active {
    background: var(--color-surface-hover);
  }
  .pd-option.primary {
    border-color: transparent;
    background: var(--color-primary);
    color: var(--color-on-fill);
    font-weight: var(--ut-fw-semibold);
  }
  .pd-option.primary:active {
    filter: brightness(0.95);
  }
  .pd-option:disabled {
    opacity: 0.55;
  }
  .pd-num {
    flex: none;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: var(--ut-r-md);
    background: var(--color-bg-tertiary);
    color: var(--color-text-muted);
    font-size: 0.75rem;
    font-weight: var(--ut-fw-semibold);
    font-variant-numeric: tabular-nums;
  }
  .pd-option.primary .pd-num {
    background: color-mix(in srgb, var(--color-on-fill) 14%, transparent);
    color: var(--color-on-fill);
  }
  .pd-label {
    flex: 1;
    min-width: 0;
  }
  /* A phone on its side has ~190 pt for the chat: options two by two, the dock half of it. */
  @media (max-height: 500px) {
    .pd {
      max-height: 58vh;
      gap: 6px;
      padding-top: 8px;
      padding-bottom: 8px;
    }
    .pd-options {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .pd-option {
      min-height: 44px;
    }
  }
  .pd, .pd-detail, .pd-option {
    background-image: var(--ut-piece-grain);
    background-size: var(--ut-piece-grain-size);
    background-blend-mode: var(--ut-piece-grain-blend);
  }
  .pd { box-shadow: var(--ut-piece-raised); }
  .pd-detail { box-shadow: var(--ut-piece-inset); }
  .pd-option { box-shadow: var(--ut-piece-control); }
`;

/** What a docked prompt shows and does (see renderPromptDock). */
export interface PromptDockView {
  /** The eyebrow's kind ("Permiso"): what Claude waits for. */
  kind: string;
  question: string;
  detail?: string[];
  /** The menu's own options (what an answer sends) and, index for index, how they read. */
  options: string[];
  shown: string[];
  disabled?: boolean;
  note?: string;
  readOnly?: TemplateResult;
  detailOpen: boolean;
  onToggleDetail: () => void;
  /** Event handlers for an option (pointerup/click pairs for iOS, or a plain click). */
  pick: (index: number) => { pointerup?: (e: PointerEvent) => void; click: (e: Event) => void };
  onOpenTerminal?: () => void;
  testId?: string;
  /** Test ids for the note and the detail, and extra classes for options and the question. */
  ids?: { note?: string; detail?: string };
  classes?: { option?: string; question?: string };
}

export function renderPromptDock(view: PromptDockView): TemplateResult {
  const detail = view.detail ?? [];
  const label = detail.length > 1 ? detail[0] : '';
  const command = (label ? detail.slice(1) : detail).join('\n');
  return html`<section
    class="pd"
    role="group"
    aria-label=${view.question || t('screenMenu.label')}
    data-testid=${view.testId ?? 'prompt-dock'}
  >
    <div class="pd-head">
      <div class="pd-eyebrow" dir="auto">${t('phone.prompt.eyebrow', { kind: view.kind })}</div>
      ${
        view.onOpenTerminal
          ? html`<button class="ut-surface--badge pd-link" type="button" @click=${view.onOpenTerminal}>
              ${t('chat.openTerminal')}
            </button>`
          : nothing
      }
    </div>
    ${
      view.note
        ? html`<div class="pd-note" role="alert" data-testid=${view.ids?.note ?? 'prompt-note'}>
            ${view.note}
          </div>`
        : nothing
    }
    ${
      command
        ? html`<button
            class="ut-surface--badge pd-detail"
            type="button"
            aria-expanded=${String(view.detailOpen)}
            data-testid=${view.ids?.detail ?? 'prompt-detail'}
            @click=${view.onToggleDetail}
          >
            ${label ? html`<span class="pd-detail-label" dir="auto">${label}</span>` : nothing}
            <span class="pd-cmd ${view.detailOpen ? 'open' : ''}" dir="ltr">${command}</span>
          </button>`
        : nothing
    }
    ${
      view.question
        ? html`<div class="pd-question ${view.classes?.question ?? ''}" dir="auto">${view.question}</div>`
        : nothing
    }
    ${
      view.readOnly ??
      html`<div class="pd-options">
        ${view.options.map((option, index) => {
          const handlers = view.pick(index);
          return html`<button
            class="ut-surface--badge pd-option ${view.classes?.option ?? ''} ${index === 0 ? 'primary' : ''}"
            type="button"
            title=${option}
            ?disabled=${view.disabled}
            @mousedown=${(e: Event) => e.preventDefault()}
            @contextmenu=${(e: Event) => e.preventDefault()}
            @pointerup=${handlers.pointerup ?? nothing}
            @click=${handlers.click}
          >
            <span class="pd-num" aria-hidden="true">${index + 1}</span>
            <span class="pd-label" dir="auto">${view.shown[index] ?? option}</span>
          </button>`;
        })}
      </div>`
    }
  </section>`;
}

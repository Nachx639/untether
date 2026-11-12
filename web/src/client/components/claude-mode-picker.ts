/**
 * Claude mode picker (phone chat): tapping the mode chip lists Claude Code's permission
 * modes; picking one presses Shift+Tab until the status line shows it. Claude Code only
 * cycles (its order depends on whether bypass is enabled), so availability is learned by
 * watching the cycle and remembered per session for this page load.
 *
 * Rendered into <body>: position:fixed inside a transformed ancestor (the session view)
 * would be fixed to that ancestor instead of the screen.
 */

import { html, nothing, render } from 'lit';
import { type MessageKey, t } from '../i18n/index.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';

/** Names as parseClaudeMode() returns them, in the order the sheet lists them. */
const KNOWN_MODES: Record<string, { name: MessageKey; desc: MessageKey }> = {
  'Default mode': { name: 'mode.name.default', desc: 'mode.desc.default' },
  'Accept edits': { name: 'mode.name.acceptEdits', desc: 'mode.desc.acceptEdits' },
  'Plan mode': { name: 'mode.name.plan', desc: 'mode.desc.plan' },
  'Auto mode': { name: 'mode.name.auto', desc: 'mode.desc.auto' },
  'Manual mode': { name: 'mode.name.manual', desc: 'mode.desc.manual' },
  'Bypass permissions': { name: 'mode.name.bypass', desc: 'mode.desc.bypass' },
};
const ORDER = Object.keys(KNOWN_MODES);
/** Listed before a full cycle has shown what this session really offers. */
const ASSUMED = ['Default mode', 'Accept edits', 'Plan mode', 'Bypass permissions'];

export const MODE_POLL_MS = 150;
export const MODE_MAX_PRESSES = 8;
export const MODE_TIMEOUT_MS = 3000;
const OPEN_GUARD_MS = 500;
const TAP_SLOP_PX = 10;

export interface ModeCycleIo {
  readMode(): string | null;
  sendShiftTab(): void;
  /** True while Claude waits on a dialog (or the view moved to another session). */
  isBlocked(): boolean;
}

export type ModeCycleResult = {
  outcome: 'reached' | 'unreachable' | 'blocked' | 'timeout';
  /** Modes seen on the status line, the starting one first. */
  seen: string[];
  /** The cycle came back to where it started, so `seen` is every mode on offer. */
  complete: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Press Shift+Tab until `target` shows, waiting for the status line to change after each
 * press. Stops after one full cycle, MODE_MAX_PRESSES presses or MODE_TIMEOUT_MS.
 */
export async function cycleToMode(io: ModeCycleIo, target: string): Promise<ModeCycleResult> {
  const start = io.readMode();
  const seen = start ? [start] : [];
  if (start === target) return { outcome: 'reached', seen, complete: false };
  if (io.isBlocked() || !start) {
    return { outcome: start ? 'blocked' : 'timeout', seen, complete: false };
  }
  const deadline = Date.now() + MODE_TIMEOUT_MS;
  let current = start;
  for (let presses = 0; presses < MODE_MAX_PRESSES; presses++) {
    // Right before each press: the screen must still show the mode we last saw.
    if (io.isBlocked() || io.readMode() !== current) {
      return { outcome: 'blocked', seen, complete: false };
    }
    io.sendShiftTab();
    let next: string | null = null;
    while (Date.now() < deadline) {
      await sleep(MODE_POLL_MS);
      const mode = io.readMode();
      if (mode && mode !== current) {
        next = mode;
        break;
      }
    }
    if (!next) return { outcome: 'timeout', seen, complete: false };
    current = next;
    if (current === target) {
      seen.push(current);
      return { outcome: 'reached', seen, complete: false };
    }
    if (current === start) return { outcome: 'unreachable', seen, complete: true };
    if (!seen.includes(current)) seen.push(current);
  }
  return { outcome: 'unreachable', seen, complete: false };
}

const known = new Map<string, { seen: Set<string>; complete: boolean }>();

export function resetModeCacheForTests(): void {
  known.clear();
}

/** Remember what a cycle showed about a session's modes. */
export function recordModes(sessionId: string, result: Pick<ModeCycleResult, 'seen' | 'complete'>) {
  const entry = known.get(sessionId) ?? { seen: new Set<string>(), complete: false };
  if (result.complete) {
    known.set(sessionId, { seen: new Set(result.seen), complete: true });
    return;
  }
  for (const mode of result.seen) entry.seen.add(mode);
  known.set(sessionId, entry);
}

/** The modes to list: what a full cycle showed, or the usual ones plus anything seen. */
export function availableModes(sessionId: string, current: string | null): string[] {
  const entry = known.get(sessionId);
  const modes = new Set(entry?.complete ? entry.seen : [...ASSUMED, ...(entry?.seen ?? [])]);
  if (current) modes.add(current);
  const rank = (mode: string) => {
    const index = ORDER.indexOf(mode);
    return index < 0 ? ORDER.length : index;
  };
  return [...modes].sort((a, b) => rank(a) - rank(b));
}

export function modeLabel(mode: string): string {
  const keys = KNOWN_MODES[mode];
  return keys ? t(keys.name) : mode;
}

export interface ModePickerOptions extends ModeCycleIo {
  sessionId: string;
  /** Called after a pick changed the mode, so the chip can update at once. */
  onModeChange?: (mode: string | null) => void;
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let cycling = false;

export function closeClaudeModePicker(): void {
  if (!openHost) return;
  render(nothing, openHost);
  openHost.remove();
  openHost = null;
  releaseFocus?.();
  releaseFocus = null;
}

export function isClaudeModePickerOpen(): boolean {
  return openHost !== null;
}

export function openClaudeModePicker(options: ModePickerOptions): void {
  closeClaudeModePicker();
  const host = document.createElement('div');
  host.dataset.testid = 'claude-mode-picker';
  document.body.appendChild(host);
  openHost = host;
  const openedAt = Date.now();
  let busyTarget: string | null = null;
  let message = '';

  // Touch acts on pointerup (iOS can take the first tap on fresh buttons as a hover); the
  // click that follows is ignored. Nothing acts in the first moments after opening.
  let touchActedAt = 0;
  let down: { x: number; y: number } | null = null;
  const act = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (e.type === 'pointerdown') {
        const p = e as PointerEvent;
        down = { x: p.clientX, y: p.clientY };
        return;
      }
      if (Date.now() - openedAt < OPEN_GUARD_MS) return;
      if (e.type === 'pointerup') {
        const p = e as PointerEvent;
        if (p.pointerType === 'mouse') return;
        const moved = down && Math.hypot(p.clientX - down.x, p.clientY - down.y) > TAP_SLOP_PX;
        down = null;
        if (moved) return;
        touchActedAt = Date.now();
        swallowNextClick();
      } else if (Date.now() - touchActedAt < 700) {
        return;
      }
      if (cycling) return;
      fn();
    },
  });

  const pick = async (mode: string) => {
    const current = options.readMode();
    if (mode === current) {
      closeClaudeModePicker();
      return;
    }
    if (options.isBlocked()) {
      message = t('mode.blocked');
      draw();
      return;
    }
    cycling = true;
    busyTarget = mode;
    message = '';
    draw();
    let result: ModeCycleResult;
    try {
      result = await cycleToMode(options, mode);
    } finally {
      cycling = false;
      busyTarget = null;
    }
    recordModes(options.sessionId, result);
    options.onModeChange?.(options.readMode());
    if (result.outcome === 'reached') {
      closeClaudeModePicker();
      return;
    }
    message =
      result.outcome === 'blocked'
        ? t('mode.blocked')
        : result.outcome === 'timeout'
          ? t('mode.noResponse')
          : t('mode.unavailable', { mode: modeLabel(mode) });
    draw();
  };

  const close = act(closeClaudeModePicker);

  const draw = () => {
    if (openHost !== host) return;
    const current = options.readMode();
    const modes = availableModes(options.sessionId, current);
    render(
      html`
        <style>
          .psr-sheet-group button.ut-mode-item {
            display: flex;
            align-items: center;
            gap: 12px;
            min-height: 56px;
            padding: 10px 16px;
            text-align: start;
            font-size: 1rem;
            color: var(--color-text);
          }
          .ut-mode-check {
            width: 18px;
            flex-shrink: 0;
            color: var(--color-primary-text);
            font-weight: var(--ut-fw-bold);
          }
          .ut-mode-body {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 2px;
          }
          .ut-mode-name {
            font-weight: var(--ut-fw-semibold);
          }
          .ut-mode-desc {
            font-size: 0.8125rem;
            color: var(--color-text-muted);
          }
          .ut-mode-spinner {
            width: 18px;
            height: 18px;
            flex-shrink: 0;
            border: 2px solid var(--color-border);
            border-top-color: var(--color-primary);
            border-radius: var(--ut-r-circle);
            animation: ut-mode-spin 0.8s linear infinite;
          }
          @keyframes ut-mode-spin {
            to {
              transform: rotate(360deg);
            }
          }
          .ut-mode-message {
            padding: 10px 16px;
            font-size: 0.875rem;
            text-align: center;
            color: var(--color-status-warning-text);
            border-top: 1px solid var(--color-border-light);
          }
        </style>
        <div
          class="psr-sheet-backdrop"
          @click=${() => {
            if (!cycling && Date.now() - openedAt > 400) closeClaudeModePicker();
          }}
        ></div>
        <div class="psr-sheet" role="dialog" aria-modal="true" aria-label=${t('mode.title')}>
          <div class="psr-sheet-group ut-surface--floating ut-surface--material">
            <div class="psr-sheet-title">${t('mode.title')}</div>
            ${modes.map((mode) => {
              const handler = act(() => void pick(mode));
              const desc = KNOWN_MODES[mode]?.desc;
              return html`<button
                class="ut-mode-item"
                data-testid="mode-item"
                data-mode=${mode}
                aria-pressed=${mode === current ? 'true' : 'false'}
                aria-busy=${busyTarget === mode ? 'true' : 'false'}
                @pointerdown=${handler}
                @pointerup=${handler}
                @click=${handler}
              >
                <span class="ut-mode-check" aria-hidden="true">${mode === current ? '✓' : ''}</span>
                <span class="ut-mode-body">
                  <span class="ut-mode-name">${modeLabel(mode)}</span>
                  ${desc ? html`<span class="ut-mode-desc">${t(desc)}</span>` : nothing}
                </span>
                ${
                  busyTarget === mode
                    ? html`<span class="ut-mode-spinner" role="img" aria-label=${t('mode.switching')}></span>`
                    : nothing
                }
              </button>`;
            })}
            ${
              message
                ? html`<div class="ut-mode-message" role="status" data-testid="mode-message">${message}</div>`
                : nothing
            }
          </div>
          <button
            class="psr-sheet-cancel ut-surface--floating ut-surface--material"
            data-testid="mode-close"
            @pointerdown=${close}
            @pointerup=${close}
            @click=${close}
          >
            ${t('common.cancel')}
          </button>
        </div>
      `,
      host
    );
  };

  draw();
  releaseFocus = holdSheetFocus(host.querySelector<HTMLElement>('.psr-sheet'), () => {
    if (!cycling) closeClaudeModePicker();
  });
  requestAnimationFrame(() => host.querySelector('.psr-sheet')?.classList.add('open'));
}

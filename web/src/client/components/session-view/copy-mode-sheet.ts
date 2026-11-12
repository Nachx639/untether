/**
 * Copy mode (phones): the terminal is a <canvas>, so iOS cannot select its text. This sheet
 * shows the screen plus recent scrollback as plain text in a native <pre>, where touch and
 * hold brings up the system selection handles and the Copy menu. URLs are tappable links.
 *
 * Rendered into <body>: position:fixed inside a transformed ancestor (the session view) would
 * be fixed to that ancestor instead of the screen.
 */

import { html, nothing, render } from 'lit';
import { t } from '../../i18n/index.js';
import { Z_INDEX } from '../../utils/constants.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { copyToClipboard } from '../../utils/path-utils.js';
import { holdSheetFocus } from '../../utils/sheet-a11y.js';

/** Lines of scrollback (including the visible screen) shown in the sheet. */
export const COPY_MODE_LINES = 500;

/** The click that finishes the gesture that opened the sheet must not hit its buttons. */
const OPEN_GUARD_MS = 500;
const TAP_SLOP_PX = 10;

// CSI, OSC (BEL or ST terminated), and two-byte escapes; then any other C0 control but tab
// and newline, and DEL.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: see above
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Plain text only: no escapes or controls, no trailing spaces, no trailing blank lines. */
export function cleanTerminalText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_RE, '')
    .replace(CONTROL_RE, '')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

export type TextPart = { text: string; url?: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;

/** Splits text into plain runs and http(s) URLs (trailing punctuation stays outside). */
export function linkifyText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0];
    // "see https://x.dev/a." or "(https://x.dev/a)": the closing mark is not part of the URL.
    while (/[.,;:!?'"\]}>]$/.test(url) || (url.endsWith(')') && !url.includes('('))) {
      url = url.slice(0, -1);
    }
    const start = match.index ?? 0;
    if (url.length <= 'https://'.length) continue;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;

export function closeCopyMode(): void {
  if (!openHost) return;
  render(nothing, openHost);
  openHost.remove();
  openHost = null;
  releaseFocus?.();
  releaseFocus = null;
}

export function isCopyModeOpen(): boolean {
  return openHost !== null;
}

/**
 * `topLine`: the line that was at the top of the terminal's screen; the sheet opens with it at
 * the top. Null (the terminal was at the bottom): it opens at the end.
 */
export function openCopyMode(rawText: string, topLine: number | null = null): void {
  closeCopyMode();
  // Reading, not typing: drop the soft keyboard so the text gets the whole screen.
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable]')) {
    active.blur();
  }

  const text = cleanTerminalText(rawText);
  const host = document.createElement('div');
  host.dataset.testid = 'copy-mode';
  document.body.appendChild(host);
  openHost = host;
  const openedAt = Date.now();
  let status: 'idle' | 'copied' | 'failed' = 'idle';

  // Touch acts on pointerup: on iOS the first tap on freshly shown buttons is often taken
  // as a hover and produces no click. The click that may still follow is ignored; mouse and
  // keyboard use the click. Nothing acts in the first moments after opening.
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
      fn();
    },
  });

  const copyAll = act(async () => {
    const ok = await copyToClipboard(text);
    status = ok ? 'copied' : 'failed';
    draw();
  });
  const close = act(closeCopyMode);

  const lines = text.split('\n');
  const body = lines.map((line, i) => {
    const parts = linkifyText(line).map((part) =>
      part.url
        ? html`<a href=${part.url} target="_blank" rel="noopener noreferrer">${part.text}</a>`
        : part.text
    );
    const content = i < lines.length - 1 ? [parts, '\n'] : parts;
    return i === topLine ? html`<span data-copy-anchor>${content}</span>` : content;
  });

  const draw = () => {
    if (openHost !== host) return;
    const copyLabel =
      status === 'copied'
        ? t('copyMode.copied')
        : status === 'failed'
          ? t('copyMode.copyFailed')
          : t('copyMode.copyAll');
    render(
      html`
        <style>
          .ut-copy-mode {
            position: fixed;
            inset: 0;
            display: flex;
            flex-direction: column;
            background: var(--color-bg);
            color: var(--color-text);
            padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
          }
          .ut-copy-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            border-bottom: 1px solid var(--color-border);
            background: var(--color-bg-secondary);
          }
          .ut-copy-title {
            flex: 1;
            min-width: 0;
            font-weight: var(--ut-fw-semibold);
            font-size: 15px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .ut-copy-bar button {
            min-height: 40px;
            padding: 0 14px;
            border-radius: var(--ut-r-8);
            font-size: 14px;
            border: 1px solid var(--color-border);
            color: var(--color-text);
            background: var(--color-bg-tertiary);
            touch-action: manipulation;
          }
          .ut-copy-bar button.ut-copy-primary {
            background: var(--color-primary);
            border-color: var(--color-primary);
            color: var(--color-bg);
          }
          .ut-copy-hint {
            padding: 6px 12px;
            font-size: 12px;
            color: var(--color-text-muted);
          }
          .ut-copy-text {
            flex: 1;
            margin: 0;
            padding: 8px 12px calc(16px + env(safe-area-inset-bottom));
            overflow: auto;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
            font-family: var(--ut-font-mono-system);
            font-size: 13px;
            line-height: 1.4;
            /* Lines fit the screen: a terminal line wider than the phone used to run off its
               right edge. The text is the printed lines (soft wraps joined), so a copy has no
               line breaks the terminal added. */
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            user-select: text;
            -webkit-user-select: text;
            -webkit-touch-callout: default;
          }
          .ut-copy-text a {
            color: var(--color-primary);
            text-decoration: underline;
          }
          .ut-copy-empty {
            padding: 24px 16px;
            text-align: center;
            color: var(--color-text-dim);
          }
        </style>
        <div
          class="ut-copy-mode"
          role="dialog"
          aria-modal="true"
          aria-label=${t('copyMode.title')}
          style="z-index: ${Z_INDEX.MODAL};"
        >
          <div class="ut-copy-bar ut-surface--bar">
            <div class="ut-copy-title">${t('copyMode.title')}</div>
            <button
              class="ut-copy-primary ut-surface--control ut-surface--primary"
              data-testid="copy-mode-copy-all"
              ?disabled=${!text}
              @pointerdown=${copyAll}
              @pointerup=${copyAll}
              @click=${copyAll}
            >
              ${copyLabel}
            </button>
            <button
              data-testid="copy-mode-close"
              @pointerdown=${close}
              @pointerup=${close}
              @click=${close}
            >
              ${t('copyMode.close')}
            </button>
          </div>
          ${
            text
              ? html`<div class="ut-copy-hint">${t('copyMode.hint')}</div>
                  <pre class="ut-copy-text" dir="ltr" data-testid="copy-mode-text">${body}</pre>`
              : html`<div class="ut-copy-empty ut-surface--panel">${t('copyMode.empty')}</div>`
          }
        </div>
      `,
      host
    );
  };

  draw();
  const pre = host.querySelector<HTMLElement>('.ut-copy-text');
  const anchor = pre?.querySelector<HTMLElement>('[data-copy-anchor]');
  if (pre && anchor) {
    pre.scrollTop = anchor.getBoundingClientRect().top - pre.getBoundingClientRect().top - 8;
  } else if (pre) {
    pre.scrollTop = pre.scrollHeight;
  }
  releaseFocus = holdSheetFocus(host.querySelector<HTMLElement>('.ut-copy-mode'), closeCopyMode);
}

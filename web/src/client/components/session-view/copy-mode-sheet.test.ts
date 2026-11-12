// @vitest-environment happy-dom

import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copyToClipboard = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock('../../utils/path-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/path-utils.js')>()),
  copyToClipboard,
}));

import type { CompactMenu } from './compact-menu.js';
import {
  cleanTerminalText,
  closeCopyMode,
  isCopyModeOpen,
  linkifyText,
  openCopyMode,
} from './copy-mode-sheet.js';
import './compact-menu.js';

function pointer(type: string, target: Element, pointerType = 'touch') {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerType, clientX: 10, clientY: 10 })
  );
}

describe('copy mode text', () => {
  it('keeps only text: no escapes, no trailing spaces or blank lines, wide characters intact', () => {
    expect(
      cleanTerminalText('\x1b[1;32mok\x1b[0m done   \r\n\x1b]0;title\x07日本語 ✓  \n\n  \n')
    ).toBe('ok done\n日本語 ✓');
  });

  it('finds http(s) URLs and leaves closing punctuation out', () => {
    expect(linkifyText('see https://x.dev/a?b=1. (http://y.io/p) ftp://no')).toEqual([
      { text: 'see ' },
      { text: 'https://x.dev/a?b=1', url: 'https://x.dev/a?b=1' },
      { text: '. (' },
      { text: 'http://y.io/p', url: 'http://y.io/p' },
      { text: ') ftp://no' },
    ]);
  });
});

describe('copy mode sheet', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T10:00:00Z'));
    copyToClipboard.mockClear();
  });

  afterEach(() => {
    closeCopyMode();
    vi.useRealTimers();
  });

  const sheet = () => document.querySelector('[data-testid="copy-mode"]');

  it('shows the terminal text as selectable plain text with tappable links', () => {
    openCopyMode('$ echo <b>hi</b>  \nopen https://example.com/x now\n');

    const pre = sheet()?.querySelector('[data-testid="copy-mode-text"]') as HTMLElement;
    expect(pre.textContent).toBe('$ echo <b>hi</b>\nopen https://example.com/x now');
    expect(pre.querySelector('b')).toBeNull();
    const link = pre.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://example.com/x');
    expect(link.textContent).toBe('https://example.com/x');
  });

  it('ignores taps right after opening, then copies everything on a touch tap', async () => {
    openCopyMode('line one\nline two');
    const copy = sheet()?.querySelector('[data-testid="copy-mode-copy-all"]') as HTMLElement;

    // The click finishing the gesture that opened the sheet.
    copy.click();
    expect(copyToClipboard).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 600);
    pointer('pointerdown', copy);
    pointer('pointerup', copy);
    copy.click(); // iOS's trailing click must not copy twice
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenCalledWith('line one\nline two');
    await Promise.resolve();
    await Promise.resolve();
    expect(copy.textContent?.trim()).toBe('Copied');
  });

  it('opens at the line that was at the top of the terminal, or at the end', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    openCopyMode(text, 12);
    const anchor = document.querySelector('[data-copy-anchor]');
    expect(anchor?.textContent).toBe('line 12\n');
    closeCopyMode();
    openCopyMode(text);
    expect(document.querySelector('[data-copy-anchor]')).toBeNull();
  });

  it('closes from the Close button', () => {
    openCopyMode('x');
    vi.setSystemTime(Date.now() + 600);
    (sheet()?.querySelector('[data-testid="copy-mode-close"]') as HTMLElement | null)?.click();
    expect(isCopyModeOpen()).toBe(false);
    expect(sheet()).toBeNull();
  });
});

// Phones: the ⋯ menu is a bottom sheet rendered into <body> (compact-menu.ts, 2026-10-12).
describe('compact menu Select text item', () => {
  it('opens copy mode through the session view callback', async () => {
    vi.useFakeTimers();
    const onSelectText = vi.fn();
    const menu = await fixture<CompactMenu>(
      html`<compact-menu .onSelectText=${onSelectText}></compact-menu>`
    );
    (menu.querySelector('button[data-menu-button]') as HTMLElement).click();
    await menu.updateComplete;
    const item = document.body.querySelector(
      '[data-testid="session-menu-sheet"] [data-testid="compact-select-text"]'
    ) as HTMLElement;
    expect(item.textContent?.trim()).toBe('Select text');
    item.click();
    vi.advanceTimersByTime(60);
    expect(onSelectText).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    menu.remove();
  });
});

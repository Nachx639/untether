/**
 * @vitest-environment happy-dom
 */
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipboardManager, ClipboardManagerCallbacks } from './clipboard-manager.js';
import './clipboard-manager.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mockClipboard(clipboard: Partial<Clipboard>) {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

async function openSheet(callbacks: ClipboardManagerCallbacks) {
  const sheet = await fixture<ClipboardManager>(
    html`<clipboard-manager .callbacks=${callbacks}></clipboard-manager>`
  );
  sheet.visible = true;
  await sheet.updateComplete;
  await flush();
  await sheet.updateComplete;
  return sheet;
}

const pasteButton = (sheet: ClipboardManager) =>
  sheet.querySelector<HTMLButtonElement>('#clipboard-paste-current-button');

describe('ClipboardManager', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReturnValue(null);
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('pastes the current clipboard text through onPaste and closes', async () => {
    mockClipboard({ readText: vi.fn().mockResolvedValue('hello') });
    const onPaste = vi.fn();
    const sheet = await openSheet({ onPaste });
    const onClose = vi.fn();
    sheet.addEventListener('close', onClose);

    pasteButton(sheet)?.click();

    expect(onPaste).toHaveBeenCalledWith('hello');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not offer the old text when the clipboard can no longer be read (2026-11-10)', async () => {
    const readText = vi.fn().mockResolvedValueOnce('old text');
    mockClipboard({ readText });
    const onPaste = vi.fn();
    const sheet = await openSheet({ onPaste });
    expect(pasteButton(sheet)).toBeTruthy();

    // Closed, then opened again with the permission denied (or an image on the clipboard).
    sheet.visible = false;
    await sheet.updateComplete;
    readText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    sheet.visible = true;
    await sheet.updateComplete;
    await flush();
    await sheet.updateComplete;

    expect(pasteButton(sheet)).toBeNull();
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('says images from the history cannot be pasted instead of doing nothing', async () => {
    vi.mocked(localStorage.getItem).mockReturnValue(
      JSON.stringify([
        { id: 'a', content: 'image/png', type: 'image', timestamp: Date.now(), preview: 'image' },
      ])
    );
    mockClipboard({ readText: vi.fn().mockResolvedValue('') });
    const onPaste = vi.fn();
    const sheet = await openSheet({ onPaste });
    sheet.showHistory = true;
    await sheet.updateComplete;

    sheet.querySelector<HTMLButtonElement>('[data-testid="clipboard-history-paste"]')?.click();
    await sheet.updateComplete;

    expect(onPaste).not.toHaveBeenCalled();
    // The English text of clipboard.imageHistoryUnsupported.
    expect(sheet.textContent).toMatch(/image/i);
  });
});

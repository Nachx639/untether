// @vitest-environment happy-dom

// User report: attaching from the phone only offered the phone's own files, so a PDF in the
// Mac's Downloads could not be attached. «Archivo del Mac» picks it from the Mac instead.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldName,
  MAC_PICKER_PLACES,
  type MacFilePicker,
  type MacPickedFile,
} from './mac-file-picker.js';
import './mac-file-picker.js';

const HOME = '/Users/example';

const listings: Record<string, { fullPath: string; files: unknown[] }> = {
  [`${HOME}/Downloads`]: {
    fullPath: `${HOME}/Downloads`,
    files: [
      { name: 'old.zip', type: 'file', size: 10, modified: '2026-01-01T10:00:00Z' },
      { name: 'Report.pdf', type: 'file', size: 2_400_000, modified: '2026-10-13T10:00:00Z' },
      { name: 'Invoices', type: 'directory', size: 0, modified: '2026-05-01T10:00:00Z' },
    ],
  },
  [`${HOME}/Downloads/Invoices`]: {
    fullPath: `${HOME}/Downloads/Invoices`,
    files: [{ name: 'march.pdf', type: 'file', size: 900, modified: '2026-03-01T10:00:00Z' }],
  },
  [`${HOME}/Documents`]: {
    fullPath: `${HOME}/Documents`,
    files: [{ name: 'notes.txt', type: 'file', size: 12, modified: '2026-09-01T10:00:00Z' }],
  },
};

function resolvePath(path: string): string {
  if (path === '~') return HOME;
  return path.startsWith('~/') ? `${HOME}${path.slice(1)}` : path;
}

describe('mac-file-picker', () => {
  let picker: MacFilePicker;
  let requested: string[];

  const $ = <T extends Element>(selector: string) =>
    picker.shadowRoot?.querySelector<T>(selector) ?? null;
  const names = () =>
    [...(picker.shadowRoot?.querySelectorAll('[data-testid="mac-picker-entry"]') ?? [])].map(
      (row) => row.getAttribute('data-name')
    );
  const entry = (name: string) =>
    $<HTMLButtonElement>(`[data-testid="mac-picker-entry"][data-name="${name}"]`);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await picker.updateComplete;
    }
  };

  beforeEach(async () => {
    localStorage.clear();
    requested = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname !== '/api/fs/browse') return new Response('{}', { status: 404 });
      const path = resolvePath(url.searchParams.get('path') ?? '');
      requested.push(path);
      const listing = listings[path];
      return listing
        ? new Response(JSON.stringify({ path, ...listing }))
        : new Response(JSON.stringify({ error: 'Directory not found' }), { status: 404 });
    });
    picker = document.createElement('mac-file-picker');
    document.body.append(picker);
    await picker.updateComplete;
  });

  afterEach(() => {
    picker.remove();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('opens in Downloads, newest first, with the usual places as shortcuts', async () => {
    await picker.show();
    await settle();
    expect(requested[0]).toBe(`${HOME}/Downloads`);
    expect($('dialog')?.open).toBe(true);
    expect($('#mac-picker-title')?.textContent).toContain('Downloads');
    expect(names()).toEqual(['Report.pdf', 'Invoices', 'old.zip']);
    expect(MAC_PICKER_PLACES.map((p) => p.id)).toEqual([
      'downloads',
      'documents',
      'desktop',
      'icloud',
      'home',
    ]);
    expect($('#mac-picker-place-downloads')?.getAttribute('aria-pressed')).toBe('true');
    expect($('#mac-picker-place-icloud')).not.toBeNull();
    expect($<HTMLButtonElement>('#mac-picker-attach')?.disabled).toBe(true);
  });

  it('ticks files across folders and hands back their absolute paths', async () => {
    const picked: MacPickedFile[][] = [];
    picker.addEventListener('mac-files-picked', (e) =>
      picked.push((e as CustomEvent<{ files: MacPickedFile[] }>).detail.files)
    );
    await picker.show();
    await settle();
    entry('Report.pdf')?.click();
    await picker.updateComplete;
    expect(entry('Report.pdf')?.getAttribute('aria-checked')).toBe('true');
    expect($<HTMLButtonElement>('#mac-picker-attach')?.disabled).toBe(false);

    entry('Invoices')?.click();
    await settle();
    expect(names()).toEqual(['march.pdf']);
    entry('march.pdf')?.click();
    await picker.updateComplete;
    expect($('#mac-picker-attach')?.textContent).toContain('2');

    $<HTMLButtonElement>('#mac-picker-attach')?.click();
    await picker.updateComplete;
    expect(picked).toEqual([
      [
        { path: `${HOME}/Downloads/Report.pdf`, name: 'Report.pdf', size: 2_400_000 },
        { path: `${HOME}/Downloads/Invoices/march.pdf`, name: 'march.pdf', size: 900 },
      ],
    ]);
    expect($('dialog')?.open).toBe(false);
    // Next time it opens where the files were picked.
    expect(localStorage.setItem).toHaveBeenCalledWith(
      'untether.macPicker.lastFolder',
      `${HOME}/Downloads/Invoices`
    );
    vi.mocked(localStorage.getItem).mockReturnValueOnce(`${HOME}/Downloads/Invoices`);
    await picker.show();
    await settle();
    expect(requested.at(-1)).toBe(`${HOME}/Downloads/Invoices`);
  });

  it('a tapped file unticks on a second tap; the up row goes to the parent', async () => {
    await picker.show();
    await settle();
    entry('Report.pdf')?.click();
    await picker.updateComplete;
    entry('Report.pdf')?.click();
    await picker.updateComplete;
    expect(entry('Report.pdf')?.getAttribute('aria-checked')).toBe('false');
    expect($<HTMLButtonElement>('#mac-picker-attach')?.disabled).toBe(true);

    entry('Invoices')?.click();
    await settle();
    $<HTMLButtonElement>('#mac-picker-up')?.click();
    await settle();
    expect(requested.at(-1)).toBe(`${HOME}/Downloads`);
  });

  it('jumps to a place, filters by name, and says when a folder cannot be opened', async () => {
    await picker.show();
    await settle();
    $<HTMLButtonElement>('#mac-picker-place-documents')?.click();
    await settle();
    expect(names()).toEqual(['notes.txt']);
    // Up from Documents is the home folder, named as such rather than by the account name.
    expect($('#mac-picker-up')?.textContent).toContain('Home');
    expect($('#mac-picker-place-documents')?.getAttribute('aria-pressed')).toBe('true');

    $<HTMLButtonElement>('#mac-picker-place-downloads')?.click();
    await settle();
    const filter = $<HTMLInputElement>('#mac-picker-filter');
    if (!filter) throw new Error('no filter');
    filter.value = 'REP';
    filter.dispatchEvent(new Event('input'));
    await picker.updateComplete;
    expect(names()).toEqual(['Report.pdf']);

    $<HTMLButtonElement>('#mac-picker-place-icloud')?.click();
    await settle();
    expect(names()).toEqual([]);
    expect($('.list .state')?.textContent).toContain("can't be opened");
  });

  it('a click on the sheet itself stays open; only the backdrop dismisses it', async () => {
    // QA 2026-10-14: the tap that opened the picker landed on the sheet while it loaded.
    const cancelled = vi.fn();
    picker.addEventListener('mac-picker-cancel', cancelled);
    await picker.show();
    await settle();
    const dialog = $<HTMLDialogElement>('dialog');
    if (!dialog) throw new Error('no dialog');
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 24, width: 390, height: 820 })
    );
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 195, clientY: 500 }));
    expect(cancelled).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 195, clientY: 10 }));
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('keeps one list element while a folder loads (the sheet drag holds it as its scroller)', async () => {
    // Verifier 2026-10-14: the loading state replaced the list, so the drag kept a detached
    // scroller and a pull down on a scrolled list dismissed the sheet instead of scrolling.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = globalThis.fetch;
    vi.mocked(globalThis.fetch).mockImplementationOnce(async (input) => {
      await gate;
      return original(input);
    });
    const shown = picker.show();
    await picker.updateComplete;
    const list = $('.list');
    expect(list).not.toBeNull();
    await settle();
    expect($('.list .state')?.textContent).toContain('Loading');
    release?.();
    await shown;
    await settle();
    expect(names()).toContain('Report.pdf');
    expect($('.list')).toBe(list);
  });

  it('the name filter ignores case and accents, also in decomposed Mac names', () => {
    const macName = 'Informe Cafe\u0301.pdf'; // as the Mac stores «Informe Café.pdf»
    expect(foldName(macName).includes(foldName('café'))).toBe(true);
    expect(foldName(macName).includes(foldName('INFORME cafe'))).toBe(true);
  });

  it('Cancel closes without picking anything', async () => {
    const picked = vi.fn();
    const cancelled = vi.fn();
    picker.addEventListener('mac-files-picked', picked);
    picker.addEventListener('mac-picker-cancel', cancelled);
    await picker.show();
    await settle();
    entry('Report.pdf')?.click();
    $<HTMLButtonElement>('#mac-picker-cancel')?.click();
    await picker.updateComplete;
    expect(picked).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
    expect($('dialog')?.open).toBe(false);
  });
});

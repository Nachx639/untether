// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewItem } from '../../shared/types.js';
import { PREVIEWS_CHANGED_EVENT } from '../utils/preview-rows.js';
import './preview-row.js';
import type { PreviewRowElement } from './preview-row.js';

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
/** A finger on a plain button: its pointerdown ends the ghost-click guard, then the click. */
const press = (el: Element | null | undefined) => {
  el?.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  (el as HTMLElement | null | undefined)?.click();
};
const tap = (el: Element | null | undefined) => {
  el?.dispatchEvent(
    new PointerEvent('pointerdown', {
      pointerType: 'touch',
      bubbles: true,
      clientX: 10,
      clientY: 10,
    })
  );
  el?.dispatchEvent(
    new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true, clientX: 10, clientY: 10 })
  );
};
/** iOS ends a scroll that began on a button with a pointerup on it, far from where it began. */
const scroll = (el: Element | null | undefined) => {
  el?.dispatchEvent(
    new PointerEvent('pointerdown', {
      pointerType: 'touch',
      bubbles: true,
      clientX: 10,
      clientY: 300,
    })
  );
  el?.dispatchEvent(
    new PointerEvent('pointerup', {
      pointerType: 'touch',
      bubbles: true,
      clientX: 10,
      clientY: 200,
    })
  );
};

describe('preview row', () => {
  let el: PreviewRowElement;
  let now = 1_000_000;
  const item: PreviewItem = {
    id: 'pshop123',
    port: 5173,
    path: '/',
    createdAt: 1,
    lastOpenedAt: Date.now(),
    sessionId: 's1',
    sessionName: 'web',
    sessionAlive: true,
    pinned: false,
    source: 'ut-open',
    state: 'down',
  };
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'DELETE'
      ? Response.json({ deleted: true })
      : Response.json({ preview: { ...item, ...JSON.parse(String(init?.body ?? '{}')) } })
  );
  const changed = vi.fn();

  const mount = async (over: Partial<PreviewItem> = {}) => {
    el = document.createElement('preview-row');
    el.item = { ...item, ...over };
    el.authClient = { getAuthHeader: () => ({ Authorization: 'Bearer t' }) } as never;
    document.body.appendChild(el);
    await el.updateComplete;
  };
  const sheetButton = (id: string) => document.querySelector(`[data-testid="${id}"]`);
  const openSheet = async () => {
    tap(el.querySelector('[data-testid="preview-row-menu"]'));
    await flush();
    now += 600; // taps right after the sheet opens are ignored
  };

  beforeEach(async () => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock.mockClear();
    changed.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    window.addEventListener(PREVIEWS_CHANGED_EVENT, changed);
    await mount();
  });
  afterEach(() => {
    el.remove();
    for (const node of document.querySelectorAll('.psr-sheet')) node.parentElement?.remove();
    window.removeEventListener(PREVIEWS_CHANGED_EVENT, changed);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the app, the session it came from and a dimmed "down" state', () => {
    const rowEl = el.querySelector('[data-testid="preview-row"]');
    expect(rowEl?.textContent).toContain('localhost:5173');
    expect(rowEl?.textContent).toContain('web');
    expect(rowEl?.getAttribute('data-state')).toBe('down');
    expect(rowEl?.classList.contains('pvr-down')).toBe(true);
    expect(el.querySelector('[data-testid="pvr-pinned"]')).toBeNull();
  });

  it('a tap opens its preview view by id', () => {
    const opened = vi.fn();
    window.addEventListener('ut-open-preview-view', opened);
    tap(el.querySelector('[data-testid="preview-row"]'));
    window.removeEventListener('ut-open-preview-view', opened);
    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 'pshop123' });
  });

  it('"de: <session>" goes to that session while it exists, and is plain text once it is gone', async () => {
    const navigate = vi.fn();
    const opened = vi.fn();
    el.addEventListener('navigate-to-session', navigate);
    window.addEventListener('ut-open-preview-view', opened);
    tap(el.querySelector('[data-testid="pvr-session-link"]'));
    expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 's1' });
    expect(opened).not.toHaveBeenCalled();

    el.item = { ...item, sessionAlive: false };
    await el.updateComplete;
    expect(el.querySelector('[data-testid="pvr-session-link"]')).toBeNull();
    expect(el.textContent).toContain('web');
    window.removeEventListener('ut-open-preview-view', opened);
  });

  it('⋯ sheet: pin shows 📌 and saves it on the server', async () => {
    await openSheet();
    tap(sheetButton('pvr-sheet-pin'));
    await flush();
    await el.updateComplete;
    expect(fetchMock).toHaveBeenCalledWith('/api/previews/pshop123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ pinned: true }),
    });
    expect(el.querySelector('[data-testid="pvr-pinned"]')).not.toBeNull();
    expect(changed).toHaveBeenCalled();
    expect(sheetButton('pvr-sheet')).toBeNull();
  });

  it('⋯ sheet: rename in place, empty goes back to the page title, a failure says so', async () => {
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    await openSheet();
    tap(sheetButton('pvr-sheet-rename'));
    await vi.waitFor(() => expect(sheetButton('rename-input')).not.toBeNull());
    const input = sheetButton('rename-input') as unknown as HTMLInputElement;
    // No name and no page title yet (the row says localhost:5173): the field starts empty.
    expect(input.value).toBe('');
    input.value = 'Mi tienda';
    press(sheetButton('rename-ok'));
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify({ customName: 'Mi tienda' }))
    );
    await vi.waitFor(() => expect(el.querySelector('.psr-title')?.textContent).toBe('Mi tienda'));
    expect(sheetButton('pvr-sheet')).toBeNull();
    expect(prompt).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await openSheet();
    tap(sheetButton('pvr-sheet-rename'));
    await vi.waitFor(() => expect(sheetButton('rename-input')).not.toBeNull());
    (sheetButton('rename-input') as unknown as HTMLInputElement).value = '';
    press(sheetButton('rename-ok'));
    await vi.waitFor(() =>
      expect(sheetButton('rename-error')?.textContent?.trim()).toBe("Couldn't rename the preview")
    );
    expect(fetchMock.mock.calls.at(-1)?.[1]?.body).toBe(JSON.stringify({ customName: '' }));
  });

  it('⋯ sheet: go to the session, and delete', async () => {
    const navigate = vi.fn();
    const deleted = vi.fn();
    el.addEventListener('navigate-to-session', navigate);
    el.addEventListener('preview-deleted', deleted);
    await openSheet();
    tap(sheetButton('pvr-sheet-session'));
    expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 's1' });

    await openSheet();
    tap(sheetButton('pvr-sheet-delete'));
    await flush();
    expect(fetchMock).toHaveBeenCalledWith('/api/previews/pshop123', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it('no "go to the session" once that session is gone', async () => {
    el.item = { ...item, sessionAlive: false };
    await el.updateComplete;
    await openSheet();
    expect(sheetButton('pvr-sheet-open')).not.toBeNull();
    expect(sheetButton('pvr-sheet-session')).toBeNull();
  });

  it('a scroll that starts on ⋯, the session link or a sheet button does nothing', async () => {
    const navigate = vi.fn();
    el.addEventListener('navigate-to-session', navigate);
    scroll(el.querySelector('[data-testid="preview-row-menu"]'));
    scroll(el.querySelector('[data-testid="pvr-session-link"]'));
    await flush();
    expect(sheetButton('pvr-sheet')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    await openSheet();
    scroll(sheetButton('pvr-sheet-delete'));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sheetButton('pvr-sheet')).not.toBeNull();
  });

  it('ignores the tap that opened the sheet landing on one of its buttons', async () => {
    tap(el.querySelector('[data-testid="preview-row-menu"]'));
    await flush();
    tap(sheetButton('pvr-sheet-delete'));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sheetButton('pvr-sheet')).not.toBeNull();
  });

  it('swipe left shows Pin and Delete', async () => {
    const row = el.querySelector('[data-testid="preview-row"]');
    const at = (type: string, x: number) =>
      row?.dispatchEvent(
        new PointerEvent(type, { pointerType: 'touch', bubbles: true, clientX: x, clientY: 10 })
      );
    at('pointerdown', 300);
    at('pointermove', 250);
    at('pointermove', 100);
    at('pointerup', 100);
    await el.updateComplete;
    expect(row?.getAttribute('style')).toContain('translateX(-168px)');
    scroll(el.querySelector('[data-testid="pvr-swipe-delete"]'));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    tap(el.querySelector('[data-testid="pvr-swipe-delete"]'));
    await flush();
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
  });

  it('a highlighted row (just opened with `ut open`) glows', async () => {
    el.highlighted = true;
    await el.updateComplete;
    expect(el.querySelector('.pvr-highlight')).not.toBeNull();
  });
});

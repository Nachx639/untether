// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewItem } from '../../shared/types.js';
import { terminalSocketClient } from '../services/terminal-socket-client.js';
import { PREVIEW_OPEN_GUARD_MS } from './preview-panel.js';
import './preview-view.js';
import type { PreviewView } from './preview-view.js';

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const tap = (el: Element | null | undefined) => {
  el?.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  el?.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
};
/** iOS ends a drag that began on a button with a pointerup on it, far from where it began. */
const drag = (el: Element | null | undefined) => {
  const at = (y: number) => ({ pointerType: 'touch', pointerId: 7, clientY: y, bubbles: true });
  el?.dispatchEvent(new PointerEvent('pointerdown', at(20)));
  el?.dispatchEvent(new PointerEvent('pointerup', at(120)));
};

const item = (over: Partial<PreviewItem> = {}): PreviewItem => ({
  id: 'pshop123',
  port: 5173,
  path: '/',
  createdAt: 1,
  lastOpenedAt: 1,
  sessionId: 's1',
  sessionName: 'tienda',
  sessionAlive: true,
  pinned: false,
  source: 'ut-open',
  ...over,
});

describe('preview view (/preview/<id>)', () => {
  let now = 1_000_000;
  let el: PreviewView;
  let checkState = 'down';
  const viewing = vi.fn();
  const cleared = vi.fn();
  const tickets: unknown[] = [];

  beforeEach(() => {
    now = 1_000_000;
    tickets.length = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(terminalSocketClient, 'setViewingSession').mockImplementation(viewing);
    vi.spyOn(terminalSocketClient, 'clearViewingSession').mockImplementation(cleared);
    viewing.mockClear();
    cleared.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/preview/config') {
          return Response.json({ enabled: true, port: 4021, origin: null });
        }
        if (url === '/api/preview/ticket') {
          const body = JSON.parse(String(init?.body));
          tickets.push(body);
          return Response.json({
            loginOrigin: 'http://ut-preview-5173.localhost:4021',
            loginPath: `/__ut_preview_login?ticket=t&next=/preview/5173${body.path}`,
          });
        }
        if (url === '/api/previews/pshop123/check') return Response.json({ state: checkState });
        return new Response('{}', { status: 404 });
      })
    );
  });
  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const mount = async (
    over: Partial<PreviewItem> = {},
    from: { id: string; name: string } | null = null
  ) => {
    el = document.createElement('preview-view');
    el.previewId = 'pshop123';
    el.path = '/cart';
    el.item = item(over);
    el.fromSessionId = from?.id ?? null;
    el.fromSessionName = from?.name ?? '';
    document.body.appendChild(el);
    await el.updateComplete;
    await flush();
    await el.updateComplete;
    now += PREVIEW_OPEN_GUARD_MS + 1;
  };
  const $ = (id: string) => el.querySelector(`[data-testid="${id}"]`);

  it('loads the saved preview by id and says it is viewing it (no push for it)', async () => {
    await mount({ state: 'live' });
    const src = $('preview-frame')?.getAttribute('src') ?? '';
    expect(src).toContain('http://ut-preview-5173.localhost:4021/__ut_preview_login');
    expect(tickets).toEqual([{ id: 'pshop123', path: '/cart' }]);
    expect(viewing).toHaveBeenCalledWith('preview:pshop123');
    el.remove();
    expect(cleared).toHaveBeenCalledWith('preview:pshop123');
  });

  it('loads even when its session is long gone', async () => {
    await mount({ state: 'live', sessionAlive: false });
    expect($('preview-frame')).not.toBeNull();
    expect($('preview-split')).toBeNull();
    expect($('preview-go-session')).toBeNull();
  });

  it('opened from the list: "‹ Sesiones" goes back to the list; "go to the session" is apart', async () => {
    await mount({ state: 'live' });
    const back = $('preview-view-back');
    expect(back?.textContent).toContain('Sessions');
    const handler = vi.fn();
    el.addEventListener('preview-back', handler);
    drag(back);
    expect(handler).not.toHaveBeenCalled();
    tap(back);
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: null });

    const go = vi.fn();
    el.addEventListener('preview-go-to-session', go);
    now += 1000;
    tap($('preview-go-session'));
    expect((go.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 's1' });
  });

  it('keeps the page and where it was opened from in the URL as the app navigates', async () => {
    await mount({ state: 'live' }, { id: 's1', name: 'tienda' });
    const frame = $('preview-frame') as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'ut-preview-location', path: '/about' },
        origin: 'http://ut-preview-5173.localhost:4021',
        source: frame.contentWindow,
      })
    );
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      '/preview/pshop123?from=s1&path=%2Fabout'
    );
  });

  it('opened from a session: "‹ <session>" goes back to it', async () => {
    await mount({ state: 'live' }, { id: 's1', name: 'tienda' });
    const back = $('preview-view-back');
    expect(back?.textContent).toContain('tienda');
    expect($('preview-go-session')).toBeNull(); // Back already goes there
    const handler = vi.fn();
    el.addEventListener('preview-back', handler);
    tap(back);
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 's1' });
  });

  it('a preview the server no longer has says so instead of a blank frame', async () => {
    const real = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) =>
        url === '/api/preview/ticket'
          ? Response.json({ error: 'Preview not found' }, { status: 404 })
          : real(url, init)
      )
    );
    await mount({ state: 'live' });
    expect($('preview-frame')).toBeNull();
    expect($('preview-missing')?.textContent).toContain('no longer in the list');
  });

  it('a stopped dev server shows a friendly notice; Retry checks again and reloads it', async () => {
    await mount({ state: 'down' });
    expect($('preview-frame')).toBeNull();
    expect($('preview-down')?.textContent).toContain('dev server');
    checkState = 'down';
    tap($('preview-retry'));
    await flush();
    await el.updateComplete;
    expect($('preview-down')).not.toBeNull();

    checkState = 'live';
    now += 1000;
    tap($('preview-retry'));
    await flush();
    await el.updateComplete;
    expect($('preview-down')).toBeNull();
    expect($('preview-frame')).not.toBeNull();
  });
});

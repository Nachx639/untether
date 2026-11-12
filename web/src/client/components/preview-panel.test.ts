// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closePreviewPanel,
  isPreviewPanelOpen,
  openPreviewPanel,
  PREVIEW_OPEN_GUARD_MS,
  previewOriginFor,
  previewUrl,
  resetKeyboardTrackingForTests,
} from './preview-panel';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const PREVIEW_ORIGIN = 'http://ut-preview-5173.localhost:4021';
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
const $ = <T extends Element = HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`);

describe('preview panel', () => {
  let now = 1_000_000;
  let calls: Array<{ url: string; init?: RequestInit }>;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === '/api/preview/config') {
          return Response.json({ enabled: true, port: 4021, origin: null });
        }
        if (url === '/api/preview/ticket') {
          const { port, path } = JSON.parse(String(init?.body));
          const n = calls.length;
          return Response.json({
            loginOrigin: `http://ut-preview-${port}.localhost:4021`,
            loginPath: `/__ut_preview_login?ticket=t${n}&next=${encodeURIComponent(`/preview/${port}${path}`)}`,
          });
        }
        return new Response('{}', { status: 404 });
      })
    );
  });
  afterEach(() => {
    closePreviewPanel();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const frameSrc = () => $<HTMLIFrameElement>('preview-frame')?.getAttribute('src') ?? '';
  const frameTarget = () => {
    const url = new URL(frameSrc());
    return { origin: url.origin, path: url.pathname, next: url.searchParams.get('next') };
  };

  it('trades the bearer token for a ticket and frames the preview origin', async () => {
    openPreviewPanel({
      sessionId: 's1',
      ports: [5173],
      authHeader: () => ({ Authorization: 'Bearer t' }),
    });
    expect($('preview-frame')).toBeNull(); // not before the ticket arrives
    await flush();
    expect(calls.map((call) => call.url)).toEqual(['/api/preview/config', '/api/preview/ticket']);
    const ticket = calls[1].init;
    expect(ticket?.method).toBe('POST');
    expect(new Headers(ticket?.headers).get('authorization')).toBe('Bearer t');
    expect(JSON.parse(String(ticket?.body))).toEqual({ port: 5173, path: '/' });
    expect(frameTarget()).toEqual({
      origin: PREVIEW_ORIGIN,
      path: '/__ut_preview_login',
      next: '/preview/5173/',
    });
    expect($('preview-frame')?.getAttribute('sandbox')).not.toMatch(/allow-top-navigation/);
    expect($<HTMLInputElement>('preview-address')?.value).toBe('/');
  });

  it('derives the preview origin from the page: same scheme and host, preview port', () => {
    const config = { enabled: true, port: 4021 };
    expect(previewOriginFor('https://mac.tail.ts.net:4020/session/x', config)).toBe(
      'https://mac.tail.ts.net:4021'
    );
    expect(previewOriginFor('http://127.0.0.1:4030/', { enabled: true, port: 4031 })).toBe(
      'http://127.0.0.1:4031'
    );
    expect(
      previewOriginFor('https://mac.ts.net/', { ...config, origin: 'https://p.example' })
    ).toBe('https://p.example');
    expect(previewOriginFor('http://127.0.0.1:4030/', { enabled: false, port: null })).toBeNull();
  });

  it('only listens to the preview origin and drives history by message', async () => {
    openPreviewPanel({ sessionId: 's1', ports: [5173] });
    await flush();
    // happy-dom gives the unloaded frame no window: stand one in.
    const post = vi.fn();
    const win = { postMessage: post } as unknown as Window;
    const iframe = $<HTMLIFrameElement>('preview-frame');
    if (iframe) Object.defineProperty(iframe, 'contentWindow', { value: win });
    const report = (origin: string) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin,
          source: win,
          data: { type: 'ut-preview-location', path: '/about' },
        })
      );
    report(window.location.origin);
    expect($<HTMLInputElement>('preview-address')?.value).toBe('/');
    report(PREVIEW_ORIGIN);
    expect($<HTMLInputElement>('preview-address')?.value).toBe('/about');
    now += PREVIEW_OPEN_GUARD_MS + 1;
    tap($('preview-back'));
    expect(post).toHaveBeenCalledWith(
      { type: 'ut-preview-history', direction: 'back' },
      PREVIEW_ORIGIN
    );
  });

  it('shows the sign-in error instead of a broken frame', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 }))
    );
    // (no config, no ticket)
    openPreviewPanel({ sessionId: 's1', ports: [5173] });
    await flush();
    expect($('preview-frame')).toBeNull();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('asks for a port when none is known', async () => {
    openPreviewPanel({ sessionId: 's1', ports: [] });
    await flush();
    const input = $<HTMLInputElement>('preview-port-input');
    expect(input).not.toBeNull();
    if (!input) return;
    input.value = '3000';
    input.dispatchEvent(new Event('input'));
    input.form?.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(frameTarget().next).toBe('/preview/3000/');
  });

  it('opening again for the same session navigates (ut open)', async () => {
    openPreviewPanel({ sessionId: 's1', ports: [5173] });
    await flush();
    const before = frameSrc();
    openPreviewPanel({ sessionId: 's1', ports: [], port: 3000, path: '/about' });
    await flush();
    expect(frameTarget().next).toBe('/preview/3000/about');
    expect(frameSrc()).not.toBe(before);
  });

  it('ignores the tap that opened it, then closes on a tap', async () => {
    openPreviewPanel({ sessionId: 's1', ports: [5173] });
    await flush();
    tap($('preview-close'));
    expect(isPreviewPanelOpen()).toBe(true);
    now += PREVIEW_OPEN_GUARD_MS + 1;
    drag($('preview-close'));
    expect(isPreviewPanelOpen()).toBe(true);
    tap($('preview-close'));
    expect(isPreviewPanelOpen()).toBe(false);
  });

  it('offers "Open in Safari" in the installed app too (the preview has its own origin)', async () => {
    openPreviewPanel({ sessionId: 's1', ports: [5173] });
    await flush();
    expect($('preview-open-safari')).not.toBeNull();
    closePreviewPanel();

    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('standalone'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    openPreviewPanel({ sessionId: 's1', ports: [5173] });
    await flush();
    expect($('preview-open-safari')).not.toBeNull();
    expect($('preview-close')?.textContent).toContain('Session');
  });

  it('closes when its bar is swiped down', async () => {
    openPreviewPanel({ sessionId: 's1', ports: [5173] });
    await flush();
    const bar = document.querySelector('.pv-bar') as HTMLElement;
    const touch = (y: number) => ({ clientY: y }) as Touch;
    bar.dispatchEvent(Object.assign(new Event('touchstart'), { touches: [touch(80)] }));
    bar.dispatchEvent(Object.assign(new Event('touchend'), { changedTouches: [touch(200)] }));
    expect(isPreviewPanelOpen()).toBe(false);
  });

  it('builds preview URLs under the prefix', () => {
    expect(previewUrl(5173)).toBe('/preview/5173/');
    expect(previewUrl(5173, 'a?b=1')).toBe('/preview/5173/a?b=1');
  });

  it('split: the keyboard for the session hides the preview pane, and closing it brings it back', async () => {
    const vv = Object.assign(new EventTarget(), { height: 800 });
    vi.stubGlobal('visualViewport', vv);
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    openPreviewPanel({ sessionId: 's1', ports: [5173], mode: 'split' });
    await flush();
    const panel = () => $('preview-panel');
    expect(panel()?.classList.contains('pv-split')).toBe(true);
    expect(document.body.classList.contains('preview-split-open')).toBe(true);

    vv.height = 450; // keyboard up, typing in the session
    vv.dispatchEvent(new Event('resize'));
    expect(panel()?.classList.contains('pv-kbd-hidden')).toBe(true);
    expect(document.body.classList.contains('preview-split-open')).toBe(false);

    vv.height = 800;
    vv.dispatchEvent(new Event('resize'));
    expect(panel()?.classList.contains('pv-kbd-hidden')).toBe(false);
    expect(document.body.classList.contains('preview-split-open')).toBe(true);
  });

  it('split: also gives way when iOS shrinks the layout viewport with the keyboard (resizes-content)', async () => {
    resetKeyboardTrackingForTests();
    const vv = Object.assign(new EventTarget(), { height: 600 });
    vi.stubGlobal('visualViewport', vv);
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    openPreviewPanel({ sessionId: 's1', ports: [5173], mode: 'split' });
    await flush();
    expect(document.body.classList.contains('preview-split-open')).toBe(true);
    const sizeBefore = document.body.style.getPropertyValue('--ut-preview-offset');

    // iPhone SE, iOS 27: both heights drop together when the keyboard comes up.
    vv.height = 300;
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true });
    vv.dispatchEvent(new Event('resize'));
    expect($('preview-panel')?.classList.contains('pv-kbd-hidden')).toBe(true);
    expect(document.body.classList.contains('preview-split-open')).toBe(false);

    vv.height = 600;
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    vv.dispatchEvent(new Event('resize'));
    expect(document.body.classList.contains('preview-split-open')).toBe(true);
    // Back to the size it had: the short screen while typing must not shrink it for good.
    expect(document.body.style.getPropertyValue('--ut-preview-offset')).toBe(sizeBefore);
  });

  it('split: dragging the divider is its own gesture and always leaves room for the session (header, messages, composer)', async () => {
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { height: 700 }));
    openPreviewPanel({ sessionId: 's1', ports: [5173], mode: 'split' });
    await flush();
    const divider = document.querySelector<HTMLElement>('.pv-divider');
    const down = new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, cancelable: true });
    const outside = vi.fn();
    document.body.addEventListener('pointerdown', outside);
    divider?.dispatchEvent(down);
    document.body.removeEventListener('pointerdown', outside);
    expect(down.defaultPrevented).toBe(true);
    expect(outside).not.toHaveBeenCalled();
    divider?.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientY: 690, bubbles: true })
    );
    const host = document.querySelector<HTMLElement>('.pv-host');
    expect(host?.style.getPropertyValue('--pv-split')).toBe('400px'); // 700 - 300
  });

  it('split in chat mode: the conversation jumps to its latest message in the space left', async () => {
    const chat = document.createElement('claude-chat-view') as HTMLElement & {
      followLatest?: () => void;
    };
    chat.followLatest = vi.fn();
    document.body.appendChild(chat);
    openPreviewPanel({ sessionId: 's1', ports: [5173], mode: 'split' });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await flush();
    expect(chat.followLatest).toHaveBeenCalled();
    chat.remove();
  });
});

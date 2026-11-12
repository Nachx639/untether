/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ClaudeChatView } from './claude-chat-view.js';
import './claude-chat-view.js';

vi.mock('../services/auth-client.js', () => ({
  authClient: { getAuthHeader: () => ({ Authorization: 'Bearer t' }) },
}));

const upload = '/Users/n/.untether/control/uploads/0b5e-photo.jpg';

describe('ClaudeChatView sent images', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('shows an uploaded image path as a thumbnail that opens full screen', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.startsWith('/api/files/')
        ? { ok: true, blob: async () => new Blob(['img'], { type: 'image/jpeg' }) }
        : {
            ok: true,
            json: async () => ({
              available: true,
              status: 'idle',
              messages: [{ id: 'm1', role: 'user', text: `${upload}\n¿qué flores son?` }],
            }),
          }
    );
    vi.stubGlobal('fetch', fetchMock);
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);

    const img = await vi.waitFor(() => {
      const found = view.shadowRoot?.querySelector<HTMLImageElement>('.row.user img.attachment');
      if (!found) throw new Error('no thumbnail yet');
      return found;
    });
    const fileCall = fetchMock.mock.calls.find(([url]) => url.startsWith('/api/files/'));
    expect(fileCall?.[0]).toBe('/api/files/0b5e-photo.jpg');
    expect((fileCall?.[1]?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer t'
    );

    const bubble = view.shadowRoot?.querySelector('.row.user .bubble');
    expect(bubble?.textContent).toContain('¿qué flores son?');
    expect(bubble?.textContent).not.toContain('/uploads/');

    // iOS ends a scroll of the conversation that began on the image with a pointerup on it.
    const touch = (dy: number) => {
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 200,
        clientY: y,
        bubbles: true,
        composed: true,
      });
      img.dispatchEvent(new PointerEvent('pointerdown', at(400)));
      img.dispatchEvent(new PointerEvent('pointerup', at(400 + dy)));
    };
    touch(-100);
    expect(document.querySelector('image-lightbox')).toBeNull();
    touch(2);
    img.click();
    const box = document.querySelector('image-lightbox');
    expect(box?.src).toBe(img.getAttribute('src'));
  });

  it('fetches an image again a few seconds after a failed load (2026-10-20 review)', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let imageOk = false;
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/files/')
        ? imageOk
          ? { ok: true, blob: async () => new Blob(['img'], { type: 'image/jpeg' }) }
          : { ok: false, blob: async () => new Blob() }
        : {
            ok: true,
            json: async () => ({
              available: true,
              status: 'idle',
              messages: [{ id: 'm1', role: 'user', text: `${upload}\nmira` }],
            }),
          }
    );
    vi.stubGlobal('fetch', fetchMock);
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    const imageCalls = () =>
      fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/files/')).length;
    await vi.advanceTimersByTimeAsync(100);
    expect(imageCalls()).toBe(1);
    expect(view.shadowRoot?.querySelector('.row.user img.attachment')).toBeNull();

    imageOk = true;
    await vi.advanceTimersByTimeAsync(3100);
    expect(imageCalls()).toBe(2);
    expect(view.shadowRoot?.querySelector('.row.user img.attachment')).toBeTruthy();
  });

  it('shows an image file Claude read when its chip is opened, not before', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.startsWith('/api/fs/raw')
        ? { ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) }
        : {
            ok: true,
            json: async () => ({
              available: true,
              status: 'idle',
              messages: [
                { id: 'm1', role: 'user', text: 'haz una captura' },
                {
                  id: 't1',
                  role: 'tool',
                  tool: 'Read',
                  text: 'shot.png',
                  detail: '/tmp/qa/shot.png',
                  result: '',
                },
                { id: 't2', role: 'tool', tool: 'Read', text: 'a.ts', detail: '/tmp/qa/a.ts' },
              ],
            }),
          }
    );
    vi.stubGlobal('fetch', fetchMock);
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() =>
      expect(view.shadowRoot?.querySelectorAll('button.tool')).toHaveLength(2)
    );
    const rawCalls = () => fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/fs/raw'));
    expect(rawCalls()).toHaveLength(0);

    const revealed: string[] = [];
    const realScrollIntoView = HTMLElement.prototype.scrollIntoView;
    onTestFinished(() => {
      HTMLElement.prototype.scrollIntoView = realScrollIntoView;
    });
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      if (this.dataset.toolId) revealed.push(this.dataset.toolId);
    };
    const [imageChip, codeChip] =
      view.shadowRoot?.querySelectorAll<HTMLButtonElement>('button.tool') ?? [];
    codeChip.click();
    imageChip.click();
    const img = await vi.waitFor(() => {
      const found = view.shadowRoot?.querySelector<HTMLImageElement>('.tool-detail img.read-image');
      if (!found) throw new Error('no image yet');
      return found;
    });
    expect(rawCalls().map(([url]) => url)).toEqual(['/api/fs/raw?path=%2Ftmp%2Fqa%2Fshot.png']);
    // The opened chip is brought into view, and an image has no "(no output)" under it.
    expect(revealed).toContain('t1');
    expect(img.closest('.tool-detail')?.querySelector('pre.out')).toBeNull();
    img.click();
    expect(document.querySelector('image-lightbox')?.src).toBe(img.getAttribute('src'));
  });
});

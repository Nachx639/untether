// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewItem } from '../../shared/types.js';
import {
  addPreview,
  fetchPreviewCandidates,
  findPreviewByPort,
  highlightPreviewRow,
  isPreviewRowHighlighted,
  parsePreviewViewUrl,
  previewCandidateLabel,
  previewLabel,
  previewViewPath,
  sortPreviews,
} from './preview-rows.js';

const item = (id: string, over: Partial<PreviewItem> = {}): PreviewItem => ({
  id,
  port: 5173,
  path: '/',
  createdAt: 1,
  lastOpenedAt: 1,
  pinned: false,
  source: 'ut-open',
  ...over,
});

describe('preview items', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('name: the one given, else the page title, else localhost:<port>', () => {
    expect(previewLabel(item('pa', { customName: 'Tienda', title: 'Shop' }))).toBe('Tienda');
    expect(previewLabel(item('pa', { title: 'Shop' }))).toBe('Shop');
    expect(previewLabel(item('pa', { port: 8080 }))).toBe('localhost:8080');
  });

  it('pinned first, then the most recently opened', () => {
    const sorted = sortPreviews([
      item('pold', { lastOpenedAt: 1 }),
      item('pnew', { lastOpenedAt: 3 }),
      item('ppin', { lastOpenedAt: 2, pinned: true }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(['ppin', 'pnew', 'pold']);
  });

  it("a session's chip finds the preview on its port, its own first", () => {
    const items = [
      item('pother', { port: 5173, sessionId: 's2' }),
      item('pmine', { port: 5173, sessionId: 's1' }),
      item('papi', { port: 3000 }),
    ];
    expect(findPreviewByPort(items, 5173, 's1')?.id).toBe('pmine');
    expect(findPreviewByPort(items, 5173, 'gone')?.id).toBe('pother');
    expect(findPreviewByPort(items, 4000)).toBeUndefined();
  });

  it('the view URL is /preview/<id>, with its page and where it was opened from', () => {
    expect(previewViewPath('pshop123')).toBe('/preview/pshop123');
    const url = new URL(previewViewPath('pshop123', '/cart?x=1', 's1'), 'http://ut');
    expect(url.pathname).toBe('/preview/pshop123');
    expect(parsePreviewViewUrl(url.pathname, url.search)).toEqual({
      id: 'pshop123',
      path: '/cart?x=1',
      from: 's1',
    });
    expect(parsePreviewViewUrl('/preview/pshop123')).toEqual({
      id: 'pshop123',
      path: '/',
      from: null,
    });
    // 2026-11-11: /preview/<session>/<port>, from before previews had ids, is no route any more.
    expect(parsePreviewViewUrl('/preview/s%201/5173/')).toBeNull();
    expect(parsePreviewViewUrl('/session/s1')).toBeNull();
    expect(parsePreviewViewUrl('/preview/5173/main.js')).toBeNull();
  });

  it('adds by port or by URL', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ preview: item('pnew') }, { status: 201 })
    );
    vi.stubGlobal('fetch', fetchMock);
    expect((await addPreview(' 5173 ', {})).preview?.id).toBe('pnew');
    await addPreview('localhost:3000/about', {});
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([{ port: 5173 }, { url: 'localhost:3000/about' }]);
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ error: 'Preview not allowed: port out of range' }, { status: 403 })
    );
    expect(await addPreview('80', {})).toEqual({ error: 'Preview not allowed: port out of range' });
  });

  it('a server on the Mac is one line: port, its folder or process, then its page title', () => {
    const label = previewCandidateLabel;
    expect(label({ port: 5173, title: 'Vite App', process: 'node', folder: 'shop' })).toBe(
      ':5173 · shop — Vite App'
    );
    expect(label({ port: 5180, title: 'Inicio', process: 'Python' })).toBe(
      ':5180 · Python — Inicio'
    );
    expect(label({ port: 3000, process: 'node', folder: 'api' })).toBe(':3000 · api · node');
    expect(label({ port: 8000, title: 'Docs' })).toBe(':8000 — Docs');
    expect(label({ port: 9000 })).toBe(':9000');
  });

  it("asks for the Mac's servers; null when the server can't say in time", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ candidates: [{ port: 5173 }] })
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchPreviewCandidates({ Authorization: 'Bearer t' })).toEqual([{ port: 5173 }]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/previews/candidates');
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer t' });

    fetchMock.mockImplementationOnce(async () => Response.json({ error: 'auth' }, { status: 401 }));
    expect(await fetchPreviewCandidates({})).toBeNull();
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Load failed');
    });
    expect(await fetchPreviewCandidates({})).toBeNull();
    // A server that never answers: given up on after the timeout.
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        )
    );
    expect(await fetchPreviewCandidates({}, 20)).toBeNull();
  });

  it('`ut open` highlights its row for a moment', () => {
    highlightPreviewRow('pshop123', 1000);
    expect(isPreviewRowHighlighted('pshop123', 2000)).toBe(true);
    expect(isPreviewRowHighlighted('pshop123', 10_000)).toBe(false);
    expect(isPreviewRowHighlighted('papi4567', 2000)).toBe(false);
  });
});

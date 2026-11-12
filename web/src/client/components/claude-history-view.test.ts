// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAC_SESSION_VIEW_EVENT, MAC_TMUX_OPEN_EVENT } from '../../shared/mac-sessions.js';
import type { Session } from '../../shared/types.js';
import {
  type ClaudeConversation,
  type ClaudeHistoryOptions,
  type ClaudeHistoryView,
  closeClaudeHistory,
  openClaudeHistory,
} from './claude-history-view.js';

const conversation = (id: string, extra: Partial<ClaudeConversation> = {}): ClaudeConversation => ({
  id,
  cwd: `/work/${id}`,
  title: `Title ${id}`,
  lastMessageAt: new Date().toISOString(),
  messageCount: 4,
  preview: `Reply ${id}`,
  ...extra,
});

const page = (conversations: ClaudeConversation[], hasMore = false) =>
  new Response(JSON.stringify({ conversations, hasMore }), { status: 200 });

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  await view()?.updateComplete;
};
const view = () => document.querySelector<ClaudeHistoryView>('claude-history-view');
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="history-row"]')];
/** Taps happen well after opening (the open guard ignores the opening gesture's click). */
const tap = (element: Element) => {
  (view() as unknown as { openedAt: number }).openedAt = 0;
  (element as HTMLElement).click();
};

describe('claude-history-view', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let pages: Response[];
  let created: Response;
  /** Calls this view made (other modules may fetch their own config). */
  const calls = () =>
    fetchMock.mock.calls.filter(([url]) => /^\/api\/(claude|sessions)/.test(String(url)));
  let sessions: Session[];
  let options: ClaudeHistoryOptions;

  beforeEach(() => {
    pages = [];
    created = new Response('{}', { status: 500 });
    fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/claude/conversations')
        ? (pages.shift() ?? page([]))
        : url === '/api/sessions'
          ? created
          : new Response('{}', { status: 404 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    sessions = [];
    options = {
      authHeader: () => ({ Authorization: 'Bearer x' }),
      getSessions: () => sessions,
      onOpenSession: vi.fn(),
      onSessionCreated: vi.fn(),
    };
  });

  afterEach(() => {
    closeClaudeHistory();
    vi.unstubAllGlobals();
  });

  it('lists conversations with folder and preview, and pages with Load more', async () => {
    pages = [page([conversation('a'), conversation('b')], true), page([conversation('c')])];
    openClaudeHistory(options);
    await flush();

    expect(calls()[0][0]).toBe('/api/claude/conversations?limit=50&offset=0');
    expect(calls()[0][1].headers).toEqual({ Authorization: 'Bearer x' });
    expect(rows().map((row) => row.querySelector('.ut-history-title')?.textContent)).toEqual([
      'Title a',
      'Title b',
    ]);
    expect(rows()[0].textContent).toContain('/work/a');
    expect(rows()[0].textContent).toContain('Reply a');

    tap(document.querySelector('[data-testid="history-load-more"]') as Element);
    await flush();
    expect(calls()[1][0]).toBe('/api/claude/conversations?limit=50&offset=2');
    expect(rows()).toHaveLength(3);
    expect(document.querySelector('[data-testid="history-load-more"]')).toBeNull();
  });

  it('searches after typing stops', async () => {
    openClaudeHistory(options);
    await flush();
    const input = document.querySelector<HTMLInputElement>('[data-testid="history-search"]');
    if (!input) throw new Error('no search box');
    for (const value of ['lo', 'login']) {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
    // One search, for what was left in the box once typing stopped (never one per letter).
    await vi.waitFor(() => expect(calls()).toHaveLength(2));
    await flush();
    expect(calls()).toHaveLength(2);
    expect(calls()[1][0]).toContain('query=login');
    expect(document.querySelector('.ut-history-empty')?.textContent).toContain('login');
  });

  it('opens the session already running a conversation instead of resuming it again', async () => {
    sessions = [
      { id: 'live-1', status: 'running', claudeSessionId: 'a', command: [] } as unknown as Session,
    ];
    pages = [page([conversation('a')])];
    openClaudeHistory(options);
    await flush();
    expect(rows()[0].textContent).toContain('Open now');

    tap(rows()[0]);
    await flush();
    expect(options.onOpenSession).toHaveBeenCalledWith('live-1');
    expect(calls()).toHaveLength(1);
    expect(view()).toBeNull();
  });

  it('resumes a finished conversation in its folder and ignores the opening tap', async () => {
    pages = [page([conversation('b')])];
    created = new Response(JSON.stringify({ sessionId: 'new-1' }), { status: 200 });
    openClaudeHistory(options);
    await flush();

    rows()[0].click(); // right after opening: the gesture that opened the view
    await flush();
    expect(calls()).toHaveLength(1);

    tap(rows()[0]);
    await flush();
    const [url, init] = calls()[1];
    expect(url).toBe('/api/sessions');
    expect(JSON.parse(init.body)).toMatchObject({
      command: ['claude', '--resume', 'b'],
      workingDir: '/work/b',
    });
    expect(options.onSessionCreated).toHaveBeenCalledWith('new-1');
    expect(view()).toBeNull();
  });

  describe('a conversation running outside Untether', () => {
    const notice = () => document.querySelector('[data-testid="history-live"]');
    const readHere = () => document.querySelector('[data-testid="history-read-here"]');
    const openTmux = () => document.querySelector('[data-testid="history-open-tmux"]');
    /** Details of the window events the view sends, while `run` runs. */
    async function sent(event: string, run: () => Promise<void>) {
      const details: unknown[] = [];
      const listener = (e: Event) => details.push((e as CustomEvent).detail);
      window.addEventListener(event, listener);
      try {
        await run();
      } finally {
        window.removeEventListener(event, listener);
      }
      return details;
    }

    it('is never resumed from a tmux pane: it says so, and reads or opens it instead', async () => {
      const live = {
        where: 'tmux' as const,
        chatId: 'p-600-1759480000-0',
        tmuxId: 't-600-1759480000-0',
        tmuxName: 'work',
        windowIndex: 1,
      };
      pages = [page([conversation('a', { live })]), page([conversation('a', { live })])];
      openClaudeHistory(options);
      await flush();
      expect(rows()[0].textContent).toContain('Open now');

      tap(rows()[0]);
      await flush();
      expect(calls()).toHaveLength(1);
      expect(notice()?.textContent).toContain(
        'Running in tmux right now. Open it from the list to continue.'
      );

      const views = await sent(MAC_SESSION_VIEW_EVENT, async () => {
        tap(readHere() as Element);
        await flush();
      });
      expect(views).toEqual([
        {
          chatId: live.chatId,
          kind: 'pane',
          agent: 'claude',
          title: 'Title a',
          cwd: '/work/a',
          tmuxId: live.tmuxId,
          tmuxName: 'work',
          windowIndex: 1,
        },
      ]);
      expect(view()).toBeNull();

      openClaudeHistory(options);
      await flush();
      tap(rows()[0]);
      await flush();
      const opens = await sent(MAC_TMUX_OPEN_EVENT, async () => {
        tap(openTmux() as Element);
        await flush();
      });
      expect(opens).toEqual([{ id: live.tmuxId, mode: 'control' }]);
      expect(view()).toBeNull();
      expect(calls().filter(([url]) => url === '/api/sessions')).toEqual([]);
    });

    it('names the app it runs in, and only reads one outside tmux', async () => {
      const live = { where: 'terminal' as const, app: 'Terminal', chatId: 'a-530-1759395600' };
      pages = [page([conversation('a', { live })])];
      openClaudeHistory(options);
      await flush();
      tap(rows()[0]);
      await flush();
      expect(notice()?.textContent).toContain(
        'Open in Terminal right now. Close it there to continue here.'
      );
      expect(openTmux()).toBeNull();
      const views = await sent(MAC_SESSION_VIEW_EVENT, async () => {
        tap(readHere() as Element);
        await flush();
      });
      expect(views).toEqual([
        {
          chatId: live.chatId,
          kind: 'agent',
          agent: 'claude',
          title: 'Title a',
          cwd: '/work/a',
          app: 'Terminal',
        },
      ]);
    });

    it('reads one under a tmux server that can’t be listed as in tmux, with nothing to open', async () => {
      const live = { where: 'tmux' as const, chatId: 'a-720-1759395600' };
      pages = [page([conversation('a', { live })])];
      openClaudeHistory(options);
      await flush();
      tap(rows()[0]);
      await flush();
      expect(openTmux()).toBeNull();
      const views = await sent(MAC_SESSION_VIEW_EVENT, async () => {
        tap(readHere() as Element);
        await flush();
      });
      expect(views).toEqual([
        {
          chatId: live.chatId,
          kind: 'agent',
          agent: 'claude',
          title: 'Title a',
          cwd: '/work/a',
          inTmux: { server: '' },
        },
      ]);
    });

    it('offers nothing to tap while "On this Mac" doesn’t list it', async () => {
      pages = [page([conversation('a', { live: { where: 'tmux' } })])];
      openClaudeHistory(options);
      await flush();
      tap(rows()[0]);
      await flush();
      expect(notice()?.textContent).toContain('Running in tmux right now.');
      expect(readHere()).toBeNull();
      expect(openTmux()).toBeNull();
      expect(calls()).toHaveLength(1);
    });

    it('says where it runs when it started there after the list loaded', async () => {
      pages = [page([conversation('b')])];
      created = new Response(
        JSON.stringify({ error: 'live-elsewhere', live: { where: 'terminal' } }),
        { status: 409 }
      );
      openClaudeHistory(options);
      await flush();
      tap(rows()[0]);
      await flush();

      expect(calls()[1][0]).toBe('/api/sessions');
      expect(notice()?.textContent).toContain(
        'Running outside Untether right now. Close it there to continue here.'
      );
      expect(document.querySelector('.ut-history-error')).toBeNull();
      expect(rows()[0].textContent).toContain('Open now');
      expect(options.onSessionCreated).not.toHaveBeenCalled();
      expect(view()).not.toBeNull();
    });
  });
});

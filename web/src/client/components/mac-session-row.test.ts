// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAC_SESSION_VIEW_EVENT,
  MAC_SESSIONS_CHANGED_EVENT,
  type MacAgentSession,
  type MacSessionItem,
  type MacTmuxPaneAgent,
  type MacTmuxSession,
} from '../../shared/mac-sessions.js';
import { MAC_SHARE_EVENT } from '../../shared/mac-share.js';
import './mac-session-row.js';
import { setLocale } from '../i18n/index.js';
import type { MacSessionRow } from './mac-session-row.js';

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
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

const pane = (over: Partial<MacTmuxPaneAgent> = {}): MacTmuxPaneAgent => ({
  agent: 'claude',
  chatId: 'p-4100-1759490000-3',
  windowIndex: 1,
  windowName: 'zsh',
  inCurrentWindow: true,
  activePane: true,
  cwd: '/Users/u/project',
  ...over,
});

const tmux = (over: Partial<MacTmuxSession> = {}): MacTmuxSession => ({
  kind: 'tmux',
  id: 't-4100-1759490000-0',
  name: 'work',
  server: { label: '', isDefault: true },
  windows: 2,
  activityAt: new Date().toISOString(),
  current: {
    windowIndex: 1,
    windowName: 'zsh',
    command: 'claude',
    cwd: '/Users/u/project',
    width: 80,
    height: 24,
  },
  agents: [pane({ status: { status: 'idle', title: 'Refactor parser' } })],
  alsoOpenIn: [],
  canOpen: true,
  ...over,
});

const agent = (over: Partial<MacAgentSession> = {}): MacAgentSession => ({
  kind: 'agent',
  id: 'a-20085-1759500000',
  chatId: 'a-20085-1759500000',
  agent: 'claude',
  app: 'Terminal',
  tty: 'ttys007',
  cwd: '/Users/u/docs',
  startedAt: new Date().toISOString(),
  status: { status: 'idle', title: 'Docs pass', preview: { role: 'assistant', text: 'Done.' } },
  ...over,
});

describe('mac session row', () => {
  let el: MacSessionRow;
  let now = 1_000_000;
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ sessionId: 'vt1', reused: false, mode: 'control' })
  );
  const selected = vi.fn();

  const mount = async (item: MacSessionItem, props: Partial<MacSessionRow> = {}) => {
    el = document.createElement('mac-session-row');
    el.item = item;
    el.authClient = { getAuthHeader: () => ({ Authorization: 'Bearer t' }) } as never;
    Object.assign(el, props);
    document.body.appendChild(el);
    await el.updateComplete;
  };
  const row = () => el.querySelector('[data-testid="mac-session-row"]');
  const sheet = () => document.querySelector<HTMLElement>('[data-testid="msr-sheet"]');
  const sheetButton = (id: string) => document.querySelector(`[data-testid="${id}"]`);
  const openSheet = async () => {
    tap(el.querySelector('[data-testid="msr-menu"]'));
    await flush();
    now += 600; // taps right after the sheet opens are ignored
  };
  const listen = (target: EventTarget, type: string) => {
    const handler = vi.fn();
    target.addEventListener(type, handler);
    return handler;
  };

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock.mockClear();
    vi.mocked(localStorage.setItem).mockClear();
    vi.stubGlobal('fetch', fetchMock);
    selected.mockClear();
    document.addEventListener('session-select', selected);
  });
  afterEach(() => {
    el?.remove();
    for (const node of document.querySelectorAll('.psr-sheet')) node.parentElement?.remove();
    document.removeEventListener('session-select', selected);
    // A Mac id is never an Untether session to select.
    expect(selected).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads a tmux session as one button: title, where it runs, what it does', async () => {
    await mount(
      tmux({
        alsoOpenIn: ['Terminal'],
        utSessionId: 's1',
        utMode: 'watch',
        agents: [
          pane({
            status: {
              status: 'waiting',
              waitingFor: 'permission prompt',
              title: 'Refactor parser',
            },
          }),
          pane({ agent: 'codex', chatId: 'p-4100-1759490000-4', windowIndex: 3 }),
        ],
      })
    );
    const main = el.querySelector('.psr-main') as HTMLElement;
    expect(main.getAttribute('role')).toBe('button');
    expect(main.getAttribute('aria-label')).toBe(
      'Refactor parser, tmux · work · 2 windows · Also open in Terminal · Watching, Needs you · Permission request · +1 more · now'
    );
    expect(el.querySelector('.psr-title')?.textContent).toBe('Refactor parser');
    expect(el.querySelector('[data-testid="msr-open-here"]')?.textContent).toBe('Watching');
    expect(el.querySelector('[data-testid="msr-also-open"]')?.textContent).toBe(
      'Also open in Terminal'
    );
    expect(el.querySelector('[data-testid="msr-status"]')?.textContent).toContain('+1 more');
    expect(el.querySelector('.psr-avatar-claude')).not.toBeNull();
    expect(row()?.getAttribute('data-state')).toBe('waiting');
    // Live in colour (2026-10-12): the shared avatar carries the state list.css tints it by.
    expect(el.querySelector('.psr-avatar')?.getAttribute('data-state')).toBe('waiting');
    expect(el.querySelector('.psr-dot-waiting')).not.toBeNull();
    expect(el.querySelector('[data-testid="msr-menu"]')?.getAttribute('aria-label')).toBe(
      'More actions for Refactor parser'
    );
    // The row's button holds no other button: ⋯ sits beside it.
    expect(main.querySelector('button')).toBeNull();
  });

  it('reads an agent outside tmux: its app, its folder, read-only', async () => {
    await mount(agent());
    expect(el.querySelector('.psr-main')?.getAttribute('aria-label')).toBe(
      'Docs pass, Terminal · ~/docs · Read-only, Done. · now'
    );
    expect(el.querySelector('.msr-path')?.getAttribute('dir')).toBe('ltr');
    expect(el.querySelector('[data-testid="msr-read-only"]')?.textContent).toBe('Read-only');
    expect(el.querySelector('[data-testid="msr-open-here"]')).toBeNull();
    // A tmux session without an agent: the terminal glyph (no letter), live, its program and folder.
    await mount(tmux({ agents: [], current: { ...tmux().current, command: 'npm' } }));
    expect(el.querySelector('.psr-initial')).toBeNull();
    expect(el.querySelector('.psr-avatar-terminal')?.getAttribute('data-state')).toBe('shell');
    expect(el.querySelector('.psr-dot-shell')).not.toBeNull();
    expect(el.querySelector('[data-testid="msr-status"]')?.textContent?.trim()).toBe(
      'npm · ~/project'
    );
  });

  it('says a Claude busy only for background agents waits for them, not "Working"', async () => {
    await setLocale('es');
    try {
      await mount(
        agent({
          status: {
            status: 'busy',
            waitingForBackground: true,
            title: 'Docs pass',
            preview: { role: 'assistant', text: 'Lanzado.' },
          },
        })
      );
      expect(row()?.getAttribute('data-state')).toBe('idle');
      expect(el.querySelector('[data-testid="msr-background"]')?.textContent).toBe(
        'Esperando a agentes en segundo plano'
      );
      expect(el.querySelector('.psr-working')).toBeNull();
      expect(el.querySelector('.psr-main')?.getAttribute('aria-label')).toContain(
        'Esperando a agentes en segundo plano · Lanzado.'
      );
    } finally {
      await setLocale('en');
    }
  });

  it('words the window of an agent off screen in the page direction, also in Arabic', async () => {
    const offScreen = tmux({
      agents: [pane({ windowIndex: 2, inCurrentWindow: false, status: { status: 'idle' } })],
    });
    await mount(offScreen);
    expect(el.querySelector('[data-testid="msr-window"]')?.textContent).toBe('Claude in window 2');
    // Idle with nothing said yet: no separator left hanging after the window.
    expect(el.querySelector('[data-testid="msr-status"]')?.textContent?.trim()).toBe(
      'Claude in window 2'
    );

    await setLocale('ar');
    try {
      await mount(offScreen);
      const phrase = el.querySelector('[data-testid="msr-window"]');
      expect(phrase?.textContent).toBe('Claude في النافذة 2');
      // A <bdi> would lay it out left to right from "Claude": "في النافذة 2 Claude".
      expect(phrase?.closest('bdi')).toBeNull();
      expect(phrase?.querySelector('bdi')).toBeNull();
    } finally {
      await setLocale('en');
    }
  });

  it('a tap opens the tmux session in the chosen mode, once, then goes to it', async () => {
    let answer: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    await mount(tmux(), { openMode: 'watch' });
    const created = listen(el, 'session-created');
    const changed = listen(window, MAC_SESSIONS_CHANGED_EVENT);
    tap(row());
    await el.updateComplete;
    expect(el.querySelector('[data-testid="msr-pending"]')?.textContent).toBe('Opening…');
    now += 1000;
    tap(row()); // a second tap while it opens
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/mac-sessions/t-4100-1759490000-0/open');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ mode: 'watch' });
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer t',
    });
    // An agent runs in it: it opens in the chat view.
    expect(localStorage.setItem).toHaveBeenCalledWith(
      'untether_app_preferences',
      JSON.stringify({ chatMode: true })
    );

    answer(Response.json({ sessionId: 'vt1', reused: false, mode: 'watch' }));
    await flush();
    expect(created).toHaveBeenCalledTimes(1);
    expect((created.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'vt1' });
    expect(changed).toHaveBeenCalled();
    await el.updateComplete;
    expect(el.querySelector('[data-testid="msr-pending"]')?.textContent).toBe('');
    window.removeEventListener(MAC_SESSIONS_CHANGED_EVENT, changed);
  });

  it('goes to the session already attached to it', async () => {
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ sessionId: 'vt7', reused: true, mode: 'control' })
    );
    await mount(tmux());
    const navigate = listen(el, 'navigate-to-session');
    const created = listen(el, 'session-created');
    tap(row());
    await flush();
    expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'vt7' });
    expect(created).not.toHaveBeenCalled();

    // Known to be open here: no need to ask the server.
    fetchMock.mockClear();
    await mount(tmux({ utSessionId: 'vt7', utMode: 'control' }));
    const navigateAgain = listen(el, 'navigate-to-session');
    now += 1000;
    tap(row());
    expect((navigateAgain.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'vt7' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a tap on an agent opens its conversation, read-only', async () => {
    await mount(agent());
    const opened = listen(window, MAC_SESSION_VIEW_EVENT);
    tap(row());
    window.removeEventListener(MAC_SESSION_VIEW_EVENT, opened);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      chatId: 'a-20085-1759500000',
      kind: 'agent',
      agent: 'claude',
      title: 'Docs pass',
      app: 'Terminal',
      cwd: '/Users/u/docs',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says why an open failed, and reloads the list when the session is gone', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ error: 'gone' }, { status: 404 }));
    await mount(tmux());
    const failed = listen(el, 'error');
    const changed = listen(window, MAC_SESSIONS_CHANGED_EVENT);
    tap(row());
    await flush();
    window.removeEventListener(MAC_SESSIONS_CHANGED_EVENT, changed);
    expect((failed.mock.calls[0][0] as CustomEvent).detail).toBe(
      'That session is no longer running.'
    );
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('a scroll that starts on the row or on ⋯ does nothing', async () => {
    await mount(tmux());
    scroll(row());
    scroll(el.querySelector('[data-testid="msr-menu"]'));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it('a long press offers the actions instead of opening', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await mount(tmux());
      const target = row() as HTMLElement;
      target.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          bubbles: true,
          clientX: 10,
          clientY: 10,
        })
      );
      vi.advanceTimersByTime(600);
      expect(sheet()?.getAttribute('data-mode')).toBe('actions');
      target.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerType: 'touch',
          bubbles: true,
          clientX: 10,
          clientY: 10,
        })
      );
      target.click();
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sheet()).not.toBeNull();
  });

  it('⋯ offers open, watch only and each agent to read', async () => {
    await mount(
      tmux({
        agents: [
          pane({ status: { status: 'busy', title: 'Refactor parser' } }),
          pane({ agent: 'codex', chatId: 'p-4100-1759490000-4', windowIndex: 3 }),
        ],
      })
    );
    await openSheet();
    const dialog = sheet() as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Refactor parser'
    );
    expect(sheetButton('msr-sheet-open')?.textContent?.trim()).toBe('Open and control');
    expect(sheetButton('msr-sheet-read-1')?.textContent?.trim()).toBe('Read Codex (window 3)');
    expect(sheetButton('msr-sheet-goto')).toBeNull();
    expect(sheetButton('msr-sheet-disconnect')).toBeNull();

    const opened = listen(window, MAC_SESSION_VIEW_EVENT);
    tap(sheetButton('msr-sheet-read-1'));
    window.removeEventListener(MAC_SESSION_VIEW_EVENT, opened);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      chatId: 'p-4100-1759490000-4',
      kind: 'pane',
      agent: 'codex',
      tmuxId: 't-4100-1759490000-0',
      tmuxName: 'work',
      windowIndex: 3,
    });
    expect(sheet()).toBeNull();

    await openSheet();
    tap(sheetButton('msr-sheet-watch'));
    await flush();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ mode: 'watch' });
  });

  it('⋯ on an idle agent offers Share with phone above Read; only while the feature is on', async () => {
    await mount(agent({ share: { can: true } }));
    await openSheet();
    const buttons = [...(sheet()?.querySelectorAll('.psr-sheet-group button') ?? [])];
    expect(buttons.map((button) => button.getAttribute('data-testid'))).toEqual([
      'msr-sheet-share',
      'msr-sheet-read',
    ]);
    expect(sheetButton('msr-sheet-share')?.textContent?.trim()).toBe('Share with phone');
    const opened = listen(window, MAC_SHARE_EVENT);
    tap(sheetButton('msr-sheet-share'));
    window.removeEventListener(MAC_SHARE_EVENT, opened);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      id: 'a-20085-1759500000',
      agent: 'claude',
      app: 'Terminal',
      title: 'Docs pass',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    el.remove();
    for (const node of document.querySelectorAll('.psr-sheet')) node.parentElement?.remove();

    await mount(agent());
    await openSheet();
    expect(sheetButton('msr-sheet-share')).toBeNull();
  });

  it('a busy agent shows the action disabled, with why', async () => {
    await mount(agent({ share: { can: false, reason: 'busy' }, status: { status: 'busy' } }));
    await openSheet();
    const button = sheetButton('msr-sheet-share') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(sheetButton('msr-sheet-share-why')?.textContent?.trim()).toBe(
      'Available when Claude finishes its turn.'
    );
    const opened = listen(window, MAC_SHARE_EVENT);
    tap(button);
    window.removeEventListener(MAC_SHARE_EVENT, opened);
    expect(opened).not.toHaveBeenCalled();
  });

  it('never on an agent in another app', async () => {
    await mount(
      agent({ app: 'Visual Studio Code', share: { can: false, reason: 'unsupported-app' } })
    );
    await openSheet();
    expect(sheetButton('msr-sheet-share')).toBeNull();
  });

  it('while a share runs the row says so, and a tap reopens its progress', async () => {
    const jobId = 'j'.repeat(22);
    await mount(agent({ share: { can: false, reason: 'in-progress', jobId } }));
    expect(el.querySelector('[data-testid="msr-pending"]')?.textContent?.trim()).toBe('Sharing…');
    const opened = listen(window, MAC_SHARE_EVENT);
    const read = listen(window, MAC_SESSION_VIEW_EVENT);
    tap(row());
    window.removeEventListener(MAC_SHARE_EVENT, opened);
    window.removeEventListener(MAC_SESSION_VIEW_EVENT, read);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ jobId });
    expect(read).not.toHaveBeenCalled();
  });

  it("explains a tmux session that can't be opened, and offers to read it", async () => {
    await mount(tmux({ canOpen: false, cannotOpenReason: 'tmux-too-old' }));
    tap(row());
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sheet()?.getAttribute('data-mode')).toBe('cannot-open');
    expect(sheetButton('msr-sheet-reason')?.textContent).toBe(
      'Opening tmux sessions needs tmux 3.2 or newer.'
    );
    now += 600;
    const opened = listen(window, MAC_SESSION_VIEW_EVENT);
    tap(sheetButton('msr-sheet-read'));
    window.removeEventListener(MAC_SESSION_VIEW_EVENT, opened);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ kind: 'pane' });

    // ⋯ says the same.
    now += 1000;
    await openSheet();
    expect(sheet()?.getAttribute('data-mode')).toBe('cannot-open');
  });

  it('disconnects Untether after asking, and the tmux session keeps running', async () => {
    fetchMock.mockImplementation(async () => Response.json({ success: true }));
    await mount(tmux({ utSessionId: 's9', utMode: 'control', utClient: true }));
    const killed = listen(el, 'session-killed');
    await openSheet();
    expect(sheetButton('msr-sheet-open')).toBeNull();
    expect(sheetButton('msr-sheet-goto')?.textContent?.trim()).toBe('Go to the open session');
    tap(sheetButton('msr-sheet-disconnect'));
    expect(sheet()?.getAttribute('data-mode')).toBe('confirm-disconnect');
    expect(sheet()?.getAttribute('role')).toBe('alertdialog');
    expect(document.querySelector('.psr-sheet-title')?.textContent?.trim()).toBe(
      'Disconnect from “Refactor parser”? It keeps running in tmux.'
    );
    // The tap that asked can't also confirm.
    tap(sheetButton('msr-disconnect-confirm'));
    expect(fetchMock).not.toHaveBeenCalled();
    now += 600;
    tap(sheetButton('msr-disconnect-confirm'));
    await flush();
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s9', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect((killed.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 's9' });
    expect(sheet()).toBeNull();
  });

  it('never offers to disconnect a session whose shell or terminal window runs the client', async () => {
    // `tmux attach` typed in an Untether shell, or a ut in a Mac terminal window: ending that
    // session would end the shell or what runs in the window, not detach a client.
    await mount(tmux({ utSessionId: 'web-1', utMode: 'control', utClient: false }));
    await openSheet();
    expect(sheetButton('msr-sheet-goto')?.textContent?.trim()).toBe('Go to the open session');
    expect(sheetButton('msr-sheet-read-0')).not.toBeNull();
    expect(sheetButton('msr-sheet-disconnect')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says when a disconnect failed', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }));
    await mount(tmux({ utSessionId: 's9', utMode: 'control', utClient: true }));
    const failed = listen(el, 'error');
    await openSheet();
    tap(sheetButton('msr-sheet-disconnect'));
    now += 600;
    tap(sheetButton('msr-disconnect-confirm'));
    await flush();
    expect((failed.mock.calls[0][0] as CustomEvent).detail).toBe(
      'Couldn’t disconnect: server error (500)'
    );
  });

  it('Escape closes the sheet and gives focus back to ⋯', async () => {
    await mount(agent());
    const menu = el.querySelector('[data-testid="msr-menu"]') as HTMLButtonElement;
    menu.focus();
    tap(menu);
    await flush();
    expect(sheetButton('msr-sheet-read')?.textContent?.trim()).toBe('Read the conversation');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(menu);
  });
});

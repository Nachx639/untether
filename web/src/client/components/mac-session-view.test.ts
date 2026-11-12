// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAC_TMUX_OPEN_EVENT, type MacSessionViewDetail } from '../../shared/mac-sessions.js';
import { MAC_SHARE_EVENT } from '../../shared/mac-share.js';
import { setLocale } from '../i18n/index.js';
import type { ClaudeChatView } from './claude-chat-view.js';
import {
  closeMacSessionView,
  type MacSessionView,
  openMacSessionView,
} from './mac-session-view.js';

const agent: MacSessionViewDetail = {
  chatId: 'a-20085-1759500000',
  kind: 'agent',
  agent: 'claude',
  title: 'Docs pass',
  app: 'Terminal',
  cwd: '/Users/u/project',
};

const pane: MacSessionViewDetail = {
  chatId: 'p-15674-1727426400-3',
  kind: 'pane',
  agent: 'codex',
  title: 'Refactor parser',
  cwd: '/Users/u/project',
  tmuxId: 't-15674-1727426400-0',
  tmuxName: 'qa café: 1',
  windowIndex: 2,
};

const sheet = () => document.querySelector<MacSessionView>('mac-session-view');
const find = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const chat = () => document.querySelector<ClaudeChatView>('mac-session-view claude-chat-view');

/** Taps come well after opening: the sheet ignores the click of the tap that opened it. */
function tapLater(element: Element | null) {
  const later = Date.now() + 1000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  (element as HTMLElement).click();
  vi.mocked(Date.now).mockRestore();
}

describe('mac-session-view', () => {
  let answer: () => Response;

  beforeEach(() => {
    answer = () =>
      Response.json({
        available: true,
        status: 'idle',
        messages: [{ id: '1', role: 'assistant', text: 'Hecho.' }],
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith('/api/mac-sessions/') ? answer() : Response.json({})
      )
    );
  });

  afterEach(() => {
    closeMacSessionView();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  async function open(detail: MacSessionViewDetail) {
    openMacSessionView(detail);
    await sheet()?.updateComplete;
  }

  it("reads an agent's conversation from its own address, read-only, and says where it runs", async () => {
    await open(agent);
    const dialog = find('mac-session-view');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '');
    expect(title?.querySelector('bdi')?.textContent).toBe('Docs pass');
    expect(find('mac-view-where')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Terminal · ~/project'
    );
    expect(find('mac-view-where')?.querySelector('span[dir="ltr"]')?.textContent).toBe('~/project');
    expect(find('mac-view-read-only')?.textContent?.trim()).toBe('Read-only');

    const view = chat();
    expect(view?.sessionId).toBe('mac:a-20085-1759500000');
    expect(view?.chatUrl).toBe('/api/mac-sessions/a-20085-1759500000/chat');
    expect(view?.readOnly).toBe(true);
    await vi.waitFor(() => expect(view?.shadowRoot?.textContent).toContain('Hecho.'));

    expect(dialog?.textContent).toContain('Running in Terminal, outside Untether.');
    expect(find('mac-view-why')?.querySelector('summary')?.textContent).toContain(
      'Why can’t I type here?'
    );
    expect(find('mac-view-open')).toBeNull();
  });

  it('offers Share with phone in the footer for an idle agent in Terminal', async () => {
    await open({ ...agent, share: { can: true } });
    const button = find('mac-view-share');
    expect(button?.textContent?.trim()).toBe('Share with phone');
    const opened = vi.fn();
    window.addEventListener(MAC_SHARE_EVENT, opened);
    tapLater(button);
    window.removeEventListener(MAC_SHARE_EVENT, opened);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      id: 'a-20085-1759500000',
      agent: 'claude',
      app: 'Terminal',
      title: 'Docs pass',
    });
  });

  it('says when sharing is possible while the agent works, and nothing while it is off', async () => {
    await open({ ...agent, share: { can: false, reason: 'busy' } });
    expect(find('mac-view-share')).toBeNull();
    expect(find('mac-view-share-why')?.textContent?.trim()).toBe(
      'Available when Claude finishes its turn.'
    );
    closeMacSessionView();
    await open(agent);
    expect(find('mac-view-share')).toBeNull();
    expect(find('mac-view-share-why')).toBeNull();
    closeMacSessionView();
    await open({ ...agent, app: 'Visual Studio Code', share: { can: true } });
    expect(find('mac-view-share')).toBeNull();
  });

  it('names a pane by its tmux window and opens its tmux session to type into it', async () => {
    const opened = vi.fn();
    window.addEventListener(MAC_TMUX_OPEN_EVENT, opened);
    try {
      await open(pane);
      expect(find('mac-view-where')?.textContent?.trim()).toBe('tmux · qa café: 1 · window 2');
      expect(find('mac-session-view')?.textContent).toContain(
        'Running in tmux · qa café: 1, window 2.'
      );
      expect(find('mac-view-why')).toBeNull();

      tapLater(find('mac-view-open'));
      expect(opened).toHaveBeenCalledTimes(1);
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
        id: 't-15674-1727426400-0',
        mode: 'control',
      });
      expect(sheet()).toBeNull();
    } finally {
      window.removeEventListener(MAC_TMUX_OPEN_EVENT, opened);
    }
  });

  it("isolates only the tmux session's name, so Arabic reads the pane's place in order", async () => {
    await setLocale('ar');
    try {
      await open(pane);
      const where = find('mac-view-where');
      expect(where?.textContent?.trim()).toBe('tmux · qa café: 1 · النافذة 2');
      // A <bdi> around it all would take the direction of "tmux": "النافذة 2 · qa café: 1 · tmux".
      expect([...(where?.querySelectorAll('bdi') ?? [])].map((bdi) => bdi.textContent)).toEqual([
        'qa café: 1',
      ]);
      const running = document.querySelector('.ut-mac-view-running');
      expect(running?.textContent?.trim()).toBe('تعمل في tmux · qa café: 1، النافذة 2.');
      expect([...(running?.querySelectorAll('bdi') ?? [])].map((bdi) => bdi.textContent)).toEqual([
        'qa café: 1',
      ]);
    } finally {
      await setLocale('en');
    }
  });

  it('falls back to the folder, then the agent, for a title, and "Other terminal" for no app', async () => {
    await open({ chatId: 'a-1-2', kind: 'agent', agent: 'gemini', cwd: '/srv/api/' });
    expect(document.getElementById('ut-mac-view-title')?.textContent).toBe('api');
    expect(find('mac-view-where')?.textContent).toContain('Other terminal');
    expect(find('mac-session-view')?.textContent).toContain('Running outside Untether.');
    closeMacSessionView();

    await open({ chatId: 'a-1-3', kind: 'agent', agent: 'codex' });
    expect(document.getElementById('ut-mac-view-title')?.textContent).toBe('Codex');
  });

  it('says tmux, as its row does, for an agent under a tmux server that can’t be listed', async () => {
    await open({ ...agent, app: undefined, inTmux: { server: '' } });
    expect(find('mac-view-where')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'tmux · ~/project'
    );
    const dialog = find('mac-session-view');
    expect(dialog?.textContent).toContain('Running in tmux, outside Untether.');
    // Why it can't be typed into: its server, not where it was started.
    const why = find('mac-view-why')?.querySelector('p')?.textContent;
    expect(why).toBe('This tmux server can’t be reached right now.');
    expect(dialog?.textContent).not.toContain('Start sessions inside tmux');
  });

  it('names an SSH login as its row in the list does', async () => {
    await open({ ...agent, app: 'SSH' });
    expect(find('mac-view-where')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'SSH session · ~/project'
    );
    expect(find('mac-session-view')?.textContent).toContain(
      'Running in SSH session, outside Untether.'
    );
  });

  it("says when the conversation can't be read, and keeps checking", async () => {
    answer = () => Response.json({ available: false, messages: [] });
    await open(agent);
    await vi.waitFor(() => expect(find('mac-view-unavailable')).not.toBeNull());
    expect(find('mac-view-unavailable')?.textContent?.trim()).toBe(
      'This conversation can’t be read right now.'
    );
    expect(chat()).not.toBeNull();
  });

  it('says the session ended when its agent is gone, and closes from there', async () => {
    answer = () => Response.json({ error: 'gone' }, { status: 404 });
    await open(agent);
    await vi.waitFor(() => expect(find('mac-view-ended')).not.toBeNull());
    expect(find('mac-view-ended')?.textContent).toContain('This session has ended.');
    // No more reading a conversation that is gone.
    expect(chat()).toBeNull();
    expect(find('mac-session-view')?.textContent).not.toContain('outside Untether');

    tapLater(find('mac-view-ended-close'));
    expect(sheet()).toBeNull();
  });

  it('holds focus while open; Escape closes it and gives focus back to what opened it', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    await open(agent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(find('mac-session-view')?.contains(document.activeElement)).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes from its close button, but not with the click of the tap that opened it', async () => {
    await open(agent);
    find('mac-view-close')?.click();
    expect(sheet()).not.toBeNull();
    tapLater(find('mac-view-close'));
    expect(sheet()).toBeNull();
  });
});

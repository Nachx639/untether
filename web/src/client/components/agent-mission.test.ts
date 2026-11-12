/**
 * @vitest-environment happy-dom
 */
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { setLocale } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import type { BroadcastIo } from '../utils/agent-mission.js';
import { AGENTS_INTRO_DISMISSED_KEY, type AgentMission, cardTitle } from './agent-mission.js';
import { SessionList } from './session-list.js';

const session = (id: string, overrides: Partial<Session> = {}): Session =>
  ({
    id,
    name: id,
    command: ['claude'],
    workingDir: '/Users/x/Projects/app',
    status: 'running',
    startedAt: '2026-10-02T10:00:00.000Z',
    lastModified: '2026-10-02T10:00:00.000Z',
    ...overrides,
  }) as Session;

const sessions = () => [
  session('idle', {
    claudeStatus: { status: 'idle', title: 'Refactor', since: Date.now() - 5000 },
  }),
  session('shell', { command: ['zsh'] }),
  session('busy', {
    claudeStatus: {
      status: 'busy',
      title: 'Tests',
      since: Date.now() - 60_000,
      activity: { kind: 'tool', tool: 'Bash', target: 'pnpm test', since: Date.now() - 20_000 },
    },
  }),
  session('wait', {
    claudeStatus: {
      status: 'waiting',
      title: 'Deploy',
      waitingFor: 'Bash',
      since: Date.now() - 1000,
      choices: { question: 'Do you want to proceed?', options: ['Yes', 'No'] },
    },
  }),
  session('codex', { codexActive: true, codexTitle: 'Port CLI', lastLine: 'Ran cargo build' }),
];

async function mount(list = sessions(), io?: BroadcastIo) {
  return fixture<AgentMission>(html`<agent-mission .sessions=${list} .io=${io}></agent-mission>`);
}

const at = (y: number) => ({
  pointerType: 'touch',
  pointerId: 7,
  clientX: 40,
  clientY: y,
  bubbles: true,
});
/** A finger down on `el` and up `dy` px away: iOS ends a scroll that began on it with a pointerup. */
function touch(el: Element, dy: number) {
  el.dispatchEvent(new PointerEvent('pointerdown', at(300)));
  el.dispatchEvent(new PointerEvent('pointerup', at(300 + dy)));
}

describe('agent-mission', () => {
  afterEach(async () => {
    await setLocale('en');
    vi.restoreAllMocks();
    for (const el of document.body.querySelectorAll('[data-testid="broadcast-sheet"]')) el.remove();
    fixtureCleanup();
  });

  it('an idle card says how long ago it last did something, in words, not a bare time', async () => {
    const el = await mount([
      session('idle', {
        lastModified: new Date().toISOString(),
        claudeStatus: { status: 'idle', since: Date.now() - (14 * 60 + 2) * 60_000 - 5000 },
      }),
    ]);
    const card = el.querySelector('[data-session-id="idle"]');
    expect(card?.querySelector('[data-testid="agent-doing"]')?.textContent?.trim()).toBe(
      'Idle for 14h 2m'
    );
    expect(card?.getAttribute('aria-label')).toContain('Idle for 14h 2m');
    expect(card?.querySelector('.vtm-elapsed')).toBeNull();
  });

  it('shows agent cards, the one that needs you first, with what each is doing', async () => {
    await setLocale('es');
    const view = await mount();
    const cards = [...view.querySelectorAll<HTMLElement>('[data-testid="agent-card"]')];
    expect(cards.map((card) => card.dataset.sessionId)).toEqual(['wait', 'busy', 'codex', 'idle']);
    expect(cards[0].dataset.state).toBe('waiting');
    expect(cards[0].querySelector('[data-testid="agent-doing"]')?.textContent).toContain(
      'Te necesita'
    );
    expect(cards[1].querySelector('[data-testid="agent-doing"]')?.textContent).toContain(
      'pnpm test'
    );
    expect(cards[1].querySelector('claude-activity-elapsed')).not.toBeNull();
    expect(cards[2].dataset.kind).toBe('codex');
    // An idle agent's status line is its last line, as in the Sessions tab (2026-10-12).
    expect(cards[2].querySelector('[data-testid="agent-doing"]')?.textContent).toContain(
      'Ran cargo build'
    );
    // The Sessions row anatomy: avatar with one dot, caption in mono, minutes after 60 s.
    expect(cards[0].classList.contains('psr')).toBe(true);
    expect(cards[0].querySelector('.psr-avatar .psr-dot-waiting')).not.toBeNull();
    expect(cards[0].querySelector('.psr-where')?.textContent?.trim()).toBe('app');
    expect(cards[1].querySelector('claude-activity-elapsed')?.hasAttribute('minutes')).toBe(true);
    // One line: who needs you and who works, singular where it's one.
    const counts = view.querySelector('[data-testid="mission-counts"]');
    const text = (counts?.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(text).toBe('1 te necesita · 1 trabajando');
  });

  it('says what the tab is for until dismissed, then never again on this device', async () => {
    setupLocalStorageMock();
    await setLocale('es');
    const view = await mount();
    expect(view.querySelector('[data-testid="agents-intro"]')?.textContent).toContain(
      'Solo los agentes de IA (Claude, Codex, Gemini) con su estado'
    );
    touch(view.querySelector('[data-testid="agents-intro-dismiss"]') as HTMLElement, 2);
    await view.updateComplete;
    expect(view.querySelector('[data-testid="agents-intro"]')).toBeNull();

    fixtureCleanup();
    const again = await mount();
    expect(again.querySelector('[data-testid="agents-intro"]')).toBeNull();
    expect(localStorage.getItem(AGENTS_INTRO_DISMISSED_KEY)).toBe('1');
    restoreLocalStorage();
  });

  it('counts only who needs you and who works, plural at zero', async () => {
    await setLocale('es');
    const view = await mount([sessions()[0]]);
    const text = view.querySelector('[data-testid="mission-counts"]')?.textContent ?? '';
    expect(text.replace(/\s+/g, ' ').trim()).toBe('0 te necesitan · 0 trabajando');
  });

  it('opens a session on tap and selects cards after a long press', async () => {
    const view = await mount();
    const opened = vi.fn();
    view.addEventListener('session-select', (e) => opened((e as CustomEvent<Session>).detail.id));
    const card = () => view.querySelector<HTMLElement>('[data-session-id="busy"]') as HTMLElement;
    card().click();
    expect(opened).toHaveBeenCalledWith('busy');

    vi.useFakeTimers();
    // Also when an assertion in between fails: the next test gets the real clock.
    onTestFinished(() => {
      vi.useRealTimers();
    });
    card().dispatchEvent(
      new PointerEvent('pointerdown', { pointerType: 'touch', clientX: 5, clientY: 5 })
    );
    vi.advanceTimersByTime(600);
    card().dispatchEvent(
      new PointerEvent('pointerup', { pointerType: 'touch', clientX: 5, clientY: 5 })
    );
    vi.useRealTimers();
    await view.updateComplete;
    expect(opened).toHaveBeenCalledTimes(1);
    expect(card().getAttribute('aria-checked')).toBe('true');
    expect(view.querySelector('[data-testid="broadcast-bar"]')).not.toBeNull();
  });

  it('opens the answer sheet from "Needs you" on a waiting card, not the session', async () => {
    const view = await mount();
    const opened = vi.fn();
    const sheet = vi.fn();
    view.addEventListener('session-select', () => opened());
    const onSheet = (e: Event) => sheet((e as CustomEvent<{ sessionId: string }>).detail.sessionId);
    window.addEventListener('ut-open-answer-sheet', onSheet);
    try {
      const needs = view.querySelector<HTMLElement>(
        '[data-session-id="wait"] [data-testid="agent-doing"]'
      );
      touch(needs as HTMLElement, -100); // scrolling the list
      expect(sheet).not.toHaveBeenCalled();
      needs?.dispatchEvent(
        new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })
      );
      needs?.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
      expect(sheet).toHaveBeenCalledWith('wait');
      // A mouse click on it does the same; the card around it stays closed.
      // (past the 700 ms in which a click is taken as the tap's own, by the clock).
      vi.useFakeTimers({ toFake: ['Date'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      vi.setSystemTime(Date.now() + 750);
      needs?.click();
      expect(sheet).toHaveBeenCalledTimes(2);
      expect(opened).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('ut-open-answer-sheet', onSheet);
    }
  });

  it('a scroll that starts on a button does nothing, even if the list renders meanwhile', async () => {
    const view = await mount();
    const select = () => view.querySelector('[data-testid="mission-select"]') as HTMLElement;
    select().dispatchEvent(new PointerEvent('pointerdown', at(300)));
    // News from the server mid-scroll: the render makes new handlers.
    view.sessions = sessions();
    await view.updateComplete;
    select().dispatchEvent(new PointerEvent('pointerup', at(200)));
    await view.updateComplete;
    expect(view.querySelector('[data-testid="broadcast-bar"]')).toBeNull();
    touch(select(), 2);
    select().click();
    await view.updateComplete;
    expect(view.querySelector('[data-testid="broadcast-bar"]')).not.toBeNull();
  });

  it('confirms the targets, skips the one in a dialog and reports each result', async () => {
    const screens: Record<string, string> = {
      wait: 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n',
      busy: '✻ Running…\n  ⏵⏵ accept edits on\n',
      idle: '> \n  ? for shortcuts\n',
      codex: '› \n',
    };
    const send = vi.fn(async () => {});
    const view = await mount(sessions(), { readScreen: async (id) => screens[id], send });
    (view.querySelector('[data-testid="mission-select"]') as HTMLElement).click();
    await view.updateComplete;
    (view.querySelector('[data-testid="mission-select-all"]') as HTMLElement).click();
    await view.updateComplete;
    const input = view.querySelector('[data-testid="broadcast-input"]') as HTMLInputElement;
    input.value = 'Ejecuta los tests';
    input.dispatchEvent(new Event('input'));
    await view.updateComplete;
    (view.querySelector('[data-testid="broadcast-send"]') as HTMLElement).click();

    const sheet = document.body.querySelector('[data-testid="broadcast-sheet"]') as HTMLElement;
    expect(sheet.querySelector('[data-testid="broadcast-title"]')?.textContent).toContain(
      'Ejecuta los tests'
    );
    expect(sheet.querySelectorAll('[data-testid="broadcast-target"]')).toHaveLength(4);

    // The tap that opened the sheet can't also confirm it.
    const confirm = () =>
      sheet.querySelector('[data-testid="broadcast-confirm"]') as HTMLElement | null;
    confirm()?.click();
    expect(send).not.toHaveBeenCalled();

    const opened = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(opened + 600);
    confirm()?.click();
    await vi.waitFor(() =>
      expect(sheet.querySelectorAll('[data-testid="broadcast-result"]')).toHaveLength(4)
    );
    const outcomes = Object.fromEntries(
      [...sheet.querySelectorAll<HTMLElement>('[data-testid="broadcast-target"]')].map((row) => [
        row.dataset.sessionId,
        (row.querySelector('[data-testid="broadcast-result"]') as HTMLElement).dataset.outcome,
      ])
    );
    expect(outcomes).toEqual({ wait: 'blocked', busy: 'sent', codex: 'sent', idle: 'sent' });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalledWith('wait', expect.anything());
    expect(sheet.querySelector('[data-testid="broadcast-title"]')?.textContent).toContain(
      'Sent to 3 of 4'
    );
  });
  it('reports a tmux session opened only to watch as skipped, not sent', async () => {
    const send = vi.fn(async () => {});
    const watching = session('watch', {
      claudeStatus: { status: 'idle', title: 'Watched' },
      multiplexer: {
        type: 'tmux',
        socketPath: '/tmp/tmux-501/default',
        serverPid: 15674,
        serverStartedAt: 1727426400,
        sessionId: '$0',
        sessionName: '0',
        mode: 'watch',
        sizing: 'others',
        source: 'mac-sessions',
      },
    });
    const view = await mount([watching], {
      readScreen: async () => '> \n  ? for shortcuts\n',
      send,
    });
    (view.querySelector('[data-testid="mission-select"]') as HTMLElement).click();
    await view.updateComplete;
    (view.querySelector('[data-testid="mission-select-all"]') as HTMLElement).click();
    await view.updateComplete;
    const input = view.querySelector('[data-testid="broadcast-input"]') as HTMLInputElement;
    input.value = 'Sigue';
    input.dispatchEvent(new Event('input'));
    await view.updateComplete;
    (view.querySelector('[data-testid="broadcast-send"]') as HTMLElement).click();
    const sheet = document.body.querySelector('[data-testid="broadcast-sheet"]') as HTMLElement;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600);
    (sheet.querySelector('[data-testid="broadcast-confirm"]') as HTMLElement).click();
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="broadcast-result"]')?.textContent?.trim()).toBe(
        'Skipped: watch only'
      )
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('agent card title', () => {
  it("is the user's title when there is one, else Claude's, else the name", () => {
    const base = {
      id: 'a',
      name: 'claude (~/Projects)',
      command: ['claude'],
      claudeStatus: { status: 'idle', title: 'Fix login' },
    } as Session;
    expect(cardTitle({ ...base, userTitle: 'Mi tarea' })).toBe('Mi tarea');
    expect(cardTitle(base)).toBe('Fix login');
    expect(cardTitle({ ...base, claudeStatus: undefined })).toBe('claude (~/Projects)');
  });
});

describe('session-list entry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
    fixtureCleanup();
  });

  it('a scroll that starts on a tab does not switch lists; a still tap does', async () => {
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(true);
    const host = await fixture<SessionList>(
      html`<session-list
        .sessions=${sessions()}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></session-list>`
    );
    const tab = host.querySelector('[data-testid="tab-agents"]') as HTMLElement;
    touch(tab, -100);
    expect(window.location.pathname).toBe('/');
    touch(tab, 2);
    tab.click();
    expect(window.location.pathname).toBe('/agents');
  });

  it('switches the phone list to mission control on /agents', async () => {
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(true);
    const list = await fixture<SessionList>(
      html`<session-list
        .sessions=${sessions()}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></session-list>`
    );
    expect(list.querySelector('[data-testid="agents-tabs"]')).not.toBeNull();
    expect(list.querySelector('agent-mission')).toBeNull();
    expect(list.querySelector('[data-testid="phone-session-list"]')).not.toBeNull();
    // The Agents tab shows how many need you.
    expect(list.querySelector('[data-testid="tab-agents"]')?.textContent).toContain('1');

    (list.querySelector('[data-testid="tab-agents"]') as HTMLElement).click();
    await list.updateComplete;
    expect(window.location.pathname).toBe('/agents');
    expect(list.querySelector('agent-mission')).not.toBeNull();
    expect(list.querySelector('[data-testid="phone-session-list"]')).toBeNull();

    const opened = vi.fn();
    list.addEventListener('navigate-to-session', (e) =>
      opened((e as CustomEvent<{ sessionId: string }>).detail.sessionId)
    );
    await (list.querySelector('agent-mission') as AgentMission).updateComplete;
    // The very rows of the Sessions tab (QA 2026-10-12): ⋯ menus, inline answers, no tint.
    const slot = list.querySelector('[data-testid="agent-card"][data-session-id="wait"]');
    const row = slot?.querySelector('phone-session-row') as
      | (HTMLElement & { updateComplete: Promise<unknown> })
      | null;
    if (!row) throw new Error('no Sessions row in the Agents tab');
    await row.updateComplete;
    expect(row.querySelectorAll('.psr-choice').length).toBe(2);
    expect(row.querySelector('.psr-menu')).not.toBeNull();
    expect(list.querySelectorAll('agent-mission phone-session-row').length).toBe(4);
    (row.querySelector('.psr') as HTMLElement).click();
    expect(opened).toHaveBeenCalledWith('wait');

    window.history.pushState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await list.updateComplete;
    expect(list.querySelector('agent-mission')).toBeNull();
  });
});

describe('agent-mission while background agents run', () => {
  afterEach(async () => {
    await setLocale('en');
    fixtureCleanup();
  });

  it('shows a Claude busy only for background agents as waiting for them, not working', async () => {
    await setLocale('es');
    const view = await mount([
      session('bg', {
        claudeStatus: {
          status: 'busy',
          waitingForBackground: true,
          title: 'Agentes',
          since: Date.now() - 60_000,
        },
      }),
    ]);
    const card = view.querySelector<HTMLElement>('[data-testid="agent-card"]');
    expect(card?.dataset.state).toBe('idle');
    expect(card?.querySelector('[data-testid="agent-doing"]')?.textContent).toBe(
      'Esperando a agentes en segundo plano'
    );
  });
});

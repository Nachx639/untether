// @vitest-environment happy-dom

import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ shieldAvailable: true }));

vi.mock('../services/server-config-service.js', () => ({
  serverConfigService: {
    loadConfig: vi.fn(async () => ({ repositoryBasePath: '~', ...config })),
  },
}));

import type { Session } from '../../shared/types.js';
import { canShield } from '../utils/shield.js';
import { SHIELD_BANNER_DISMISS_KEY, type ShieldBanner, shieldCandidates } from './shield-banner.js';
import './shield-banner.js';

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    name: `name-${id}`,
    command: ['claude'],
    workingDir: '/tmp',
    status: 'running',
    startedAt: new Date().toISOString(),
    claudeSessionId: `conv-${id}`,
    claudeStatus: { status: 'idle' },
    ...extra,
  } as Session;
}

describe('shieldCandidates', () => {
  it('offers idle Claude sessions with a known conversation and lists busy ones apart', () => {
    const { ready, busy } = shieldCandidates([
      session('idle'),
      session('thinking', { claudeStatus: { status: 'thinking' } as Session['claudeStatus'] }),
      session('shielded', { shielded: true }),
      session('remote', { source: 'remote' } as Partial<Session>),
      session('unknown-conversation', { claudeSessionId: undefined }),
      session('shell', { command: ['zsh'], claudeStatus: undefined, claudeSessionId: undefined }),
      session('exited', { status: 'exited' }),
      session('external-terminal', { attachedViaUT: true }),
      // Opened with ut in a Mac terminal window: shielding would close it there (2026-10-03).
      session('fwd_1791050240624_6805'),
      session('fwd_1791050208450_879', {
        claudeStatus: { status: 'busy' } as Session['claudeStatus'],
      }),
      // Clients of a tmux session outside Untether, opened from "On this Mac" or the tmux
      // modal, whose command lines name "claude" (a socket, a session).
      session('attached', {
        name: 'tmux: work',
        command: [
          '/opt/homebrew/bin/tmux',
          '-u',
          '-N',
          '-S',
          '/tmp/tmux-501/claude',
          'attach-session',
        ],
        multiplexer: {
          type: 'tmux',
          socketPath: '/tmp/tmux-501/claude',
          serverPid: 4100,
          serverStartedAt: 1759490000,
          sessionId: '$0',
          sessionName: 'work',
          mode: 'control',
          sizing: 'others',
          source: 'mac-sessions',
        },
      }),
      session('modal-attach', {
        name: 'tmux: claude',
        command: ['tmux', 'attach', '-t', 'claude'],
      }),
    ]);
    expect(ready.map((s) => s.id)).toEqual(['idle']);
    expect(busy.map((s) => s.id)).toEqual(['thinking']);
  });

  it('never offers to shield a session from a terminal window in its menu', () => {
    expect(canShield(session('plain', { command: ['zsh'] }))).toBe(true);
    expect(canShield(session('fwd_1791050240624_6805'))).toBe(false);
  });
});

describe('shield-banner', () => {
  let now = 1_000_000;

  beforeEach(() => {
    config.shieldAvailable = true;
    // The shared test setup mocks localStorage with no-op spies; this needs a working one.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount(sessions: Session[]) {
    const el = await fixture<ShieldBanner>(
      html`<shield-banner .sessions=${sessions}></shield-banner>`
    );
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
    return el;
  }

  it('stays hidden when tmux is not available', async () => {
    config.shieldAvailable = false;
    const el = await mount([session('a')]);
    expect(el.querySelector('[data-testid="shield-banner"]')).toBeNull();
  });

  it('stays hidden when every Claude session is already shielded', async () => {
    const el = await mount([session('a', { shielded: true })]);
    expect(el.querySelector('[data-testid="shield-banner"]')).toBeNull();
  });

  it('shields the idle conversations in one tap and leaves the busy one alone', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ sessionId: 'new' }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const el = await mount([
      session('a'),
      session('b'),
      session('busy', { claudeStatus: { status: 'thinking' } as Session['claudeStatus'] }),
    ]);
    const refresh = vi.fn();
    el.addEventListener('refresh', refresh);

    expect(el.querySelector('[data-testid="shield-banner"]')?.textContent).toContain('3');
    (el.querySelector('[data-testid="shield-banner-open"]') as HTMLElement).click();
    await el.updateComplete;
    expect(el.querySelector('[data-testid="shield-banner-sheet"]')).not.toBeNull();

    now += 1000;
    (el.querySelector('[data-testid="shield-banner-confirm"]') as HTMLElement).click();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    await el.updateComplete;

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual(['/api/sessions/a/shield', '/api/sessions/b/shield']);
    expect(el.querySelector('[data-testid="shield-banner-sheet"]')?.textContent).toContain('✓');

    // The list refreshes: nothing left to shield, so the bar goes and the results stay.
    el.sessions = [
      session('busy', { claudeStatus: { status: 'thinking' } as Session['claudeStatus'] }),
    ];
    await el.updateComplete;
    expect(el.querySelector('[data-testid="shield-banner"]')?.textContent).toContain('1');
    el.sessions = [];
    await el.updateComplete;
    expect(el.querySelector('[data-testid="shield-banner"]')).toBeNull();
    const sheet = el.querySelector('[data-testid="shield-banner-sheet"]')?.textContent ?? '';
    expect(sheet).toContain('✓');
    expect(sheet).toContain('name-a');
  });

  it('a scroll of the list that starts on the banner opens nothing; a still tap does', async () => {
    const el = await mount([session('a')]);
    // iOS ends a scroll that began on a button with a pointerup on it.
    const touch = (target: Element | null, dy: number) => {
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 40,
        clientY: y,
        bubbles: true,
      });
      target?.dispatchEvent(new PointerEvent('pointerdown', at(300)));
      target?.dispatchEvent(new PointerEvent('pointerup', at(300 + dy)));
    };
    const open = el.querySelector('[data-testid="shield-banner-open"]') as HTMLElement;
    touch(open, -100);
    touch(el.querySelector('[data-testid="shield-banner-dismiss"]'), -100);
    await el.updateComplete;
    expect(el.querySelector('[data-testid="shield-banner"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="shield-banner-sheet"]')).toBeNull();
    touch(open, 2);
    open.click();
    await el.updateComplete;
    expect(el.querySelector('[data-testid="shield-banner-sheet"]')).not.toBeNull();
  });

  it('a quick tap right after opening the sheet does not shield anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const el = await mount([session('a')]);
    (el.querySelector('[data-testid="shield-banner-open"]') as HTMLElement).click();
    await el.updateComplete;
    now += 100;
    (el.querySelector('[data-testid="shield-banner-confirm"]') as HTMLElement).click();
    await el.updateComplete;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('✕ hides it for a week', async () => {
    const el = await mount([session('a')]);
    (el.querySelector('[data-testid="shield-banner-dismiss"]') as HTMLElement).click();
    await el.updateComplete;
    expect(el.querySelector('[data-testid="shield-banner"]')).toBeNull();
    expect(Number(localStorage.getItem(SHIELD_BANNER_DISMISS_KEY))).toBeGreaterThan(now);
  });
});

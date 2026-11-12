// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MacAgentSession,
  MacSessionItem,
  MacSessionsResponse,
  MacTmuxSession,
} from '../../shared/mac-sessions.js';
import type { PreviewItem, Session } from '../../shared/types.js';
import type { AuthClient } from '../services/auth-client.js';
import { rememberMacSessionsPlatform } from '../utils/mac-sessions.js';
import type { AgentMission } from './agent-mission.js';
import type { MacSessionRow } from './mac-session-row.js';
import type { PhoneSessionRow } from './phone-session-row.js';
import { SessionList } from './session-list.js';

// Confirms go through utils/confirm-dialog.ts (2026-10-12): answer no.
const { confirmDialog } = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => false) }));
vi.mock('../utils/confirm-dialog.js', () => ({ confirmDialog }));

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const session = (id: string, over: Partial<Session> = {}): Session =>
  ({
    id,
    name: id,
    command: ['zsh'],
    workingDir: '/tmp',
    status: 'running',
    startedAt: at(10),
    lastModified: at(1),
    ...over,
  }) as unknown as Session;

/** Opened with ut in a terminal window on the Mac. */
const inWindow = (id: string, app: string | null, over: Partial<Session> = {}) =>
  session(id, { command: ['claude'], macWindow: { app }, ...over });

const tmux = (over: Partial<MacTmuxSession> = {}): MacTmuxSession => ({
  kind: 'tmux',
  id: 't-4100-1759490000-0',
  name: 'work',
  server: { label: '', isDefault: true },
  windows: 2,
  activityAt: at(2),
  current: {
    windowIndex: 1,
    windowName: 'zsh',
    command: 'zsh',
    cwd: '/srv/api',
    width: 80,
    height: 24,
  },
  agents: [],
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
  cwd: '/srv/docs',
  startedAt: at(30),
  status: { status: 'idle', title: 'Docs pass' },
  ...over,
});

const listed = (
  items: MacSessionItem[],
  over: Partial<MacSessionsResponse> = {}
): MacSessionsResponse => ({
  enabled: true,
  platform: 'darwin',
  openMode: 'control',
  items,
  warnings: [],
  ...over,
});

const mount = (
  options: {
    sessions?: Session[];
    mac?: MacSessionsResponse | null;
    compact?: boolean;
    hideExited?: boolean;
    previews?: PreviewItem[];
  } = {}
) =>
  fixture<SessionList>(
    html`<session-list
      .sessions=${options.sessions ?? []}
      .macSessions=${options.mac ?? null}
      .previews=${options.previews ?? []}
      .compactMode=${options.compact ?? false}
      .hideExited=${options.hideExited ?? true}
      .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
    ></session-list>`
  );

const section = (list: Element) => list.querySelector('[data-testid="mac-section"]');
const heading = (list: Element) =>
  list
    .querySelector('[data-testid="mac-section-heading"]')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim();
/** The rows of "On this Mac", in order: Untether sessions by id, Mac items by theirs. */
const macRows = (list: Element) =>
  [...list.querySelectorAll('[data-testid="mac-session-list"] > *')].map((row) =>
    row.localName === 'phone-session-row'
      ? `ut:${(row as PhoneSessionRow).session.id}`
      : `mac:${(row as MacSessionRow).item.id}`
  );
const runningRows = (list: Element) =>
  [
    ...list.querySelectorAll<PhoneSessionRow>(
      '[data-testid="phone-session-list"] phone-session-row'
    ),
  ].map((row) => row.session.id);
const follows = (first: Element | null, second: Element | null) =>
  Boolean(
    first && second && first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
  );

describe('session list: "On this Mac"', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fixtureCleanup();
  });

  it('sits between the running sessions and the finished ones', async () => {
    const list = await mount({
      sessions: [session('a'), session('x', { status: 'exited' })],
      mac: listed([tmux(), agent()]),
      hideExited: false,
    });
    expect(macRows(list)).toEqual(['mac:t-4100-1759490000-0', 'mac:a-20085-1759500000']);
    expect(heading(list)).toBe('On this Mac (2)');
    const running = list.querySelector('[data-testid="phone-session-list"]');
    const finished = list.querySelector('[data-testid="phone-clear-finished"]');
    expect(follows(running, section(list))).toBe(true);
    expect(follows(section(list), finished)).toBe(true);
    // Mac items never become Untether sessions.
    expect(list.sessions.map((s) => s.id)).toEqual(['a', 'x']);
  });

  it('says "On this computer" off macOS', async () => {
    const list = await mount({
      sessions: [session('a')],
      mac: listed([tmux()], { platform: 'linux' }),
    });
    expect(heading(list)).toBe('On this computer (1)');
  });

  it.each([
    ['no such API on the server', null],
    ['turned off', listed([tmux()], { enabled: false, reason: 'disabled' })],
    ['nothing to list', listed([])],
  ])('is hidden with %s', async (_why, mac) => {
    const list = await mount({ sessions: [session('a')], mac });
    expect(section(list)).toBeNull();
  });

  it('shows on the empty screen too, below its start buttons', async () => {
    const preview = {
      id: 'pshop123',
      port: 5180,
      path: '/',
      createdAt: 1,
      lastOpenedAt: Date.now(),
      pinned: false,
      source: 'ut-open',
    } as PreviewItem;
    const list = await mount({ mac: listed([agent()]), previews: [preview] });
    const empty = list.querySelector('[data-testid="phone-empty"]');
    expect(empty).not.toBeNull();
    expect(macRows(list)).toEqual(['mac:a-20085-1759500000']);
    expect(follows(list.querySelector('[data-testid="preview-rows"]'), section(list))).toBe(true);
    // Its rows come and go with each answer: above the buttons they would move them.
    expect(follows(empty, section(list))).toBe(true);
  });

  it('shows in the sidebar opened from a session', async () => {
    const list = await mount({ sessions: [session('a')], mac: listed([tmux()]), compact: true });
    expect(macRows(list)).toEqual(['mac:t-4100-1759490000-0']);
  });

  it('lists the sessions opened in a terminal window on the Mac first, as session rows, and only there', async () => {
    rememberMacSessionsPlatform('darwin');
    const list = await mount({
      sessions: [
        session('a'),
        inWindow('fwd_1_10', 'Terminal', { startedAt: at(20) }),
        inWindow('fwd_2_20', null, {
          startedAt: at(40),
          claudeStatus: { status: 'waiting', waitingFor: 'Bash' },
        }),
      ],
      mac: listed([tmux()]),
    });
    expect(runningRows(list)).toEqual(['a']);
    // In the same order as running sessions: the one that needs you first.
    expect(macRows(list)).toEqual(['ut:fwd_2_20', 'ut:fwd_1_10', 'mac:t-4100-1759490000-0']);
    expect(heading(list)).toBe('On this Mac (3)');
    const row = list.querySelector<PhoneSessionRow>(
      '[data-testid="mac-session-list"] phone-session-row:nth-child(2)'
    );
    expect(row?.querySelector('[data-testid="psr-mac-window"]')?.textContent).toContain(
      'On the Mac · Terminal'
    );
  });

  it.each([
    ['has not answered yet', null],
    ['lists nothing else', listed([])],
  ])('shows those sessions there even when the server %s', async (_why, mac) => {
    const list = await mount({ sessions: [session('a'), inWindow('fwd_1_10', 'iTerm')], mac });
    expect(macRows(list)).toEqual(['ut:fwd_1_10']);
    expect(runningRows(list)).toEqual(['a']);
  });

  it.each([
    ['turned off', 'disabled' as const],
    ['not offered by the server', 'unsupported' as const],
  ])(
    'with the section %s, those sessions are running ones like any other, still marked',
    async (_why, reason) => {
      rememberMacSessionsPlatform('darwin');
      const list = await mount({
        sessions: [
          session('a', { startedAt: at(5) }),
          inWindow('fwd_1_10', 'iTerm', { startedAt: at(20) }),
        ],
        mac: listed([tmux()], { enabled: false, reason }),
      });
      expect(section(list)).toBeNull();
      expect(runningRows(list)).toEqual(['a', 'fwd_1_10']);
      const row = list.querySelector<PhoneSessionRow>(
        '[data-testid="phone-session-list"] phone-session-row:nth-child(2)'
      );
      expect(row?.querySelector('[data-testid="psr-mac-window"]')?.textContent).toContain(
        'On the Mac · iTerm'
      );
    }
  );

  it('a session opened in a terminal window that ended is with the finished ones', async () => {
    const list = await mount({
      sessions: [session('a'), inWindow('fwd_1_10', 'Terminal', { status: 'exited' })],
      mac: listed([]),
      hideExited: false,
    });
    expect(section(list)).toBeNull();
    const finished = [...list.querySelectorAll<PhoneSessionRow>('phone-session-row')].map(
      (row) => row.session.id
    );
    expect(finished).toEqual(['a', 'fwd_1_10']);
  });

  it('says once under its heading what could not be listed', async () => {
    const list = await mount({
      sessions: [session('a')],
      mac: listed([], {
        warnings: [
          { code: 'tmux-unreachable' },
          { code: 'tmux-unreachable' },
          { code: 'scan-partial' },
        ],
      }),
    });
    expect(
      [...list.querySelectorAll('[data-testid="mac-section-warning"]')].map((p) =>
        p.textContent?.trim()
      )
    ).toEqual([
      'A tmux server didn’t answer.',
      'Some sessions on this computer couldn’t be listed.',
    ]);
    expect(heading(list)).toBe('On this Mac (0)');
  });

  it('says tmux is missing only beside the agents it lists, never as a section alone', async () => {
    const noTmux = [{ code: 'tmux-unavailable' as const }];
    const list = await mount({ sessions: [session('a')], mac: listed([], { warnings: noTmux }) });
    expect(section(list)).toBeNull();

    fixtureCleanup();
    const empty = await mount({ mac: listed([], { warnings: noTmux }) });
    expect(empty.querySelector('[data-testid="phone-empty"]')).not.toBeNull();
    expect(section(empty)).toBeNull();

    fixtureCleanup();
    const agents = await mount({
      sessions: [session('a')],
      mac: listed([agent()], { warnings: noTmux }),
    });
    expect(
      [...agents.querySelectorAll('[data-testid="mac-section-warning"]')].map((p) =>
        p.textContent?.trim()
      )
    ).toEqual(['tmux isn’t installed, so only agents are listed.']);
    expect(macRows(agents)).toEqual(['mac:a-20085-1759500000']);
  });

  it('collapses, and stays collapsed on this device', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    const sessions = [session('a'), inWindow('fwd_1_10', 'Terminal')];
    const mac = listed([tmux()], { warnings: [{ code: 'scan-partial' }] });
    const list = await mount({ sessions, mac });
    const toggle = () =>
      list.querySelector<HTMLButtonElement>('[data-testid="mac-section-toggle"]');
    const rows = () => list.querySelector(`#${toggle()?.getAttribute('aria-controls')}`);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle()?.getAttribute('aria-label')).toBe('Hide these sessions');
    expect(rows()?.hasAttribute('hidden')).toBe(false);

    toggle()?.click();
    await list.updateComplete;
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle()?.getAttribute('aria-label')).toBe('Show these sessions');
    expect(rows()?.hasAttribute('hidden')).toBe(true);
    expect(macRows(list)).toEqual([]);
    expect(list.querySelector('[data-testid="mac-section-warning"]')).toBeNull();
    // The heading still counts what is inside.
    expect(heading(list)).toBe('On this Mac (2)');
    expect(store.get('ut-mac-section-collapsed')).toBe('1');

    fixtureCleanup();
    const again = await mount({ sessions, mac });
    expect(
      again.querySelector('[data-testid="mac-section-toggle"]')?.getAttribute('aria-expanded')
    ).toBe('false');
    again.querySelector<HTMLButtonElement>('[data-testid="mac-section-toggle"]')?.click();
    await again.updateComplete;
    expect(macRows(again)).toEqual(['ut:fwd_1_10', 'mac:t-4100-1759490000-0']);
    expect(store.has('ut-mac-section-collapsed')).toBe(false);
  });

  describe('search', () => {
    const items = [
      tmux(),
      tmux({ id: 't-4100-1759490000-1', name: 'build' }),
      agent(),
      agent({
        id: 'a-1-2',
        chatId: 'a-1-2',
        app: 'Visual Studio Code',
        cwd: '/srv/web',
        status: undefined,
      }),
    ];
    const search = async (list: SessionList, text: string) => {
      const input = list.querySelector<HTMLInputElement>('.phone-search input');
      if (!input) throw new Error('no search box');
      input.value = text;
      input.dispatchEvent(new Event('input'));
      await list.updateComplete;
    };

    it('counts what "On this Mac" lists for showing the search box', async () => {
      const sessions = [session('alpha'), session('beta'), inWindow('fwd_1_10', 'iTerm')];
      expect(
        (await mount({ sessions, mac: listed(items.slice(0, 3)) })).querySelector('.phone-search')
      ).toBeNull();
      fixtureCleanup();
      expect(
        (await mount({ sessions, mac: listed(items) })).querySelector('.phone-search')
      ).not.toBeNull();
    });

    it('finds Mac items by folder, app or name, and sessions in a window by their app', async () => {
      const sessions = [session('alpha'), session('beta'), inWindow('fwd_1_10', 'iTerm')];
      const list = await mount({
        sessions,
        mac: listed(items, { warnings: [{ code: 'scan-partial' }] }),
      });

      await search(list, 'docs');
      expect(macRows(list)).toEqual(['mac:a-20085-1759500000']);
      expect(runningRows(list)).toEqual([]);
      expect(list.querySelector('.phone-search-empty')).toBeNull();
      // Warnings are not search results.
      expect(list.querySelector('[data-testid="mac-section-warning"]')).toBeNull();

      await search(list, 'visual studio');
      expect(macRows(list)).toEqual(['mac:a-1-2']);

      await search(list, 'build');
      expect(macRows(list)).toEqual(['mac:t-4100-1759490000-1']);

      await search(list, 'iterm');
      expect(macRows(list)).toEqual(['ut:fwd_1_10']);

      await search(list, 'nothing like this');
      expect(section(list)).toBeNull();
      expect(list.querySelector('.phone-search-empty')).not.toBeNull();
    });
  });

  it('its rows reach the app as other rows do; Clear finished and Kill all count only Untether sessions', async () => {
    const list = await mount({
      sessions: [session('a'), session('x', { status: 'exited' })],
      mac: listed([tmux({ utSessionId: 'a', utMode: 'control', utClient: true }), agent()]),
      hideExited: false,
    });
    // 2026-10-12 (phone-spec 3.3): the footer is a tab bar now, without running/exited counts;
    // Clear finished still counts only Untether sessions.
    confirmDialog.mockClear();
    list.querySelector<HTMLButtonElement>('[data-testid="phone-clear-finished"]')?.click();
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Clear 1 finished session?' })
    );

    const navigate = vi.fn();
    const killed = vi.fn();
    const refresh = vi.fn();
    list.addEventListener('navigate-to-session', (e) => navigate((e as CustomEvent).detail));
    list.addEventListener('session-killed', (e) => killed((e as CustomEvent).detail));
    list.addEventListener('refresh', refresh);
    const tmuxRow = list.querySelector('mac-session-row');

    // A tap on a tmux session open here goes to that Untether session.
    tmuxRow?.querySelector<HTMLElement>('[data-testid="mac-session-row"]')?.click();
    expect(navigate).toHaveBeenCalledWith({ sessionId: 'a' });

    // "Disconnect Untether" on it ends that session like a row's kill.
    tmuxRow?.dispatchEvent(
      new CustomEvent('session-killed', {
        detail: { sessionId: 'a' },
        bubbles: true,
        composed: true,
      })
    );
    expect(killed).toHaveBeenCalledWith('a');
    expect(refresh).toHaveBeenCalled();
  });

  describe('in the Agents tab', () => {
    const pane = {
      agent: 'claude' as const,
      chatId: 'p-4100-1759490000-3',
      windowIndex: 1,
      windowName: 'zsh',
      inCurrentWindow: true,
      activePane: true,
      status: { status: 'busy' },
    };
    const mission = (list: Element) => list.querySelector<AgentMission>('agent-mission');
    const cards = (list: Element) =>
      [...list.querySelectorAll('[data-testid="agent-card"]')].map((card) =>
        card.getAttribute('data-session-id')
      );

    beforeEach(() => window.history.replaceState(null, '', '/agents'));
    afterEach(() => window.history.replaceState(null, '', '/'));

    it('lists below mission control only what runs an agent on the Mac, as rows that broadcast never reaches', async () => {
      const list = await mount({
        sessions: [
          session('c1', { command: ['claude'], claudeStatus: { status: 'idle' } }),
          inWindow('fwd_1_10', 'Terminal', { claudeStatus: { status: 'busy' } }),
          // A plain shell opened with ut: no agent.
          session('fwd_2_20', { macWindow: { app: 'Terminal' } }),
        ],
        mac: listed([tmux({ id: 't-4100-1759490000-1', agents: [pane] }), tmux(), agent()], {
          warnings: [{ code: 'scan-partial' }],
        }),
      });
      expect(cards(list)).toEqual(['c1']);
      expect(mission(list)?.sessions.map((s) => s.id)).toEqual(['c1']);
      expect(mission(list)?.hidden).toBe(false);
      expect(follows(mission(list), section(list))).toBe(true);
      expect(macRows(list)).toEqual([
        'ut:fwd_1_10',
        'mac:t-4100-1759490000-1',
        'mac:a-20085-1759500000',
      ]);
      expect(heading(list)).toBe('On this Mac (3)');
      expect(list.querySelector('[data-testid="mac-section-warning"]')).toBeNull();
    });

    it('with the section turned off, a ut agent is a mission card like any other', async () => {
      const list = await mount({
        sessions: [
          session('c1', { command: ['claude'], claudeStatus: { status: 'idle' } }),
          inWindow('fwd_1_10', 'Terminal', { claudeStatus: { status: 'busy' } }),
        ],
        mac: listed([agent()], { enabled: false, reason: 'disabled' }),
      });
      expect(mission(list)?.sessions.map((s) => s.id)).toEqual(['c1', 'fwd_1_10']);
      expect(cards(list).sort()).toEqual(['c1', 'fwd_1_10']);
      expect(section(list)).toBeNull();
    });

    it('with agents only on the Mac, mission control does not say none are running', async () => {
      const list = await mount({
        sessions: [inWindow('fwd_1_10', 'Terminal', { claudeStatus: { status: 'waiting' } })],
        mac: listed([agent()]),
      });
      expect(mission(list)?.hidden).toBe(true);
      expect(macRows(list)).toEqual(['ut:fwd_1_10', 'mac:a-20085-1759500000']);
      // Still counted on the tab: it needs you.
      expect(list.querySelector('[data-testid="tab-agents"]')?.textContent).toContain('1');

      fixtureCleanup();
      const none = await mount({ sessions: [session('z')], mac: listed([tmux()]) });
      expect(mission(none)?.hidden).toBe(false);
      expect(none.querySelector('[data-testid="mission-empty"]')).not.toBeNull();
      expect(section(none)).toBeNull();
    });
  });
});

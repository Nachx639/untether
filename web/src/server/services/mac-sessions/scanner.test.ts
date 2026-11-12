import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MacTmuxSession } from '../../../shared/mac-sessions.js';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import { type ClaudeStatus, parseProcessTable } from '../claude-chat.js';
import type { CodexChat } from '../codex-chat.js';
import type { GeminiChat } from '../gemini-chat.js';
import { TMUX_FIELD_SEPARATOR } from '../tmux-manager.js';
import type { AgentFinderDeps } from './agents.js';
import { MAX_ITEMS, MacSessionsScanner, type MacSessionsScannerDeps } from './scanner.js';
import type { MacSessionsSettings } from './settings.js';
import type { TmuxDiscoveryDeps } from './tmux-servers.js';

const SEP = TMUX_FIELD_SEPARATOR;
const DIR = '/private/tmp/tmux-501';
const SOCKET = `${DIR}/default`;
const LSTART = 'Fri Oct  2 09:00:00 2026';
const START_MS = Date.UTC(2026, 9, 2, 9, 0, 0);
const S = START_MS / 1000;
const TERMINAL = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';

const ps = (pid: number, ppid: number, tty: string, args: string) =>
  `${pid} ${ppid} ${pid} 0 ${tty} S 501 ${LSTART} ${args}`;

const MACHINE = [
  // A Claude in a Terminal tab.
  ps(500, 1, '??', TERMINAL),
  ps(520, 500, '16/1', '-zsh'),
  ps(530, 520, '16/1', 'claude'),
  // The user's tmux server: Claude in $0's first window, Codex in its second one.
  ps(600, 1, '??', 'tmux new -s 0'),
  ps(610, 600, '16/10', '-zsh'),
  ps(620, 610, '16/10', '2.1.283'),
  ps(611, 600, '16/11', '-zsh'),
  ps(630, 611, '16/11', 'node /Users/me/.nvm/bin/codex'),
  ps(612, 600, '16/12', '-zsh'),
  ps(613, 600, '16/13', '-zsh'),
  // Its clients: `tmux attach` in the Terminal tab, one typed in an Untether shell (810), and
  // one Untether opened itself (670, a session's pid).
  ps(650, 520, '16/1', 'tmux attach -t 0'),
  ps(4000, 1, '??', 'node untether --port 4020'),
  ps(810, 4000, '16/20', '-zsh'),
  ps(660, 810, '16/20', 'tmux attach -t 1'),
  ps(670, 4000, '16/21', `/opt/homebrew/bin/tmux -u -N -S ${SOCKET} attach-session -t $2`),
  // Untether's own Claude.
  ps(830, 4000, '16/22', '-zsh'),
  ps(840, 830, '16/22', 'claude'),
  // `ut claude` in the Terminal tab: an Untether session (of any instance), never a Mac item.
  ps(900, 520, '16/1', '/bin/bash /usr/local/bin/ut claude'),
  ps(905, 900, '16/1', '/Applications/Untether.app/Contents/Resources/untether-fwd claude'),
  ps(910, 905, '16/30', 'claude'),
];

const UT_SESSIONS = [
  { id: 'web-1', pid: 810, status: 'running' as const },
  { id: 'web-8', pid: 670, status: 'running' as const },
  { id: 'web-2', pid: 830, status: 'running' as const },
  { id: 'old', pid: 520, status: 'exited' as const },
];

interface PaneSpec {
  session: number;
  name: string;
  created: number;
  windows: number;
  window: number;
  windowIndex: number;
  windowActive: 0 | 1;
  windowName: string;
  pane: number;
  panePid: number;
  command: string;
  path: string;
  title?: string;
}

const paneLine = (p: PaneSpec) =>
  [
    'P',
    600,
    `$${p.session}`,
    p.name,
    1,
    p.created,
    p.created + 100,
    p.windows,
    `@${p.window}`,
    p.windowIndex,
    p.windowActive,
    120,
    40,
    p.windowName,
    `%${p.pane}`,
    0,
    1,
    p.panePid,
    0,
    p.command,
    p.path,
    p.title ?? '',
  ].join(SEP);

const clientLine = (pid: number, session: number, readOnly: 0 | 1) =>
  [
    'C',
    pid,
    `/dev/ttys0${pid % 100}`,
    `$${session}`,
    '@0',
    '%0',
    610,
    '/Users/me/project',
    readOnly,
    readOnly ? 'attached,ignore-size,read-only' : 'attached,focused',
    80,
    24,
    1759480200,
  ].join(SEP);

const LISTING = [
  paneLine({
    session: 0,
    name: '0',
    created: 1759480000,
    windows: 2,
    window: 0,
    windowIndex: 1,
    windowActive: 1,
    windowName: 'claude',
    pane: 0,
    panePid: 610,
    command: '2.1.283',
    path: '/Users/me/project',
    title: '✳ Refactor parser',
  }),
  paneLine({
    session: 0,
    name: '0',
    created: 1759480000,
    windows: 2,
    window: 1,
    windowIndex: 2,
    windowActive: 0,
    windowName: 'codex',
    pane: 1,
    panePid: 611,
    command: 'node',
    path: '/Users/me/other',
  }),
  paneLine({
    session: 1,
    name: '1',
    created: 1759490000,
    windows: 1,
    window: 2,
    windowIndex: 0,
    windowActive: 1,
    windowName: 'zsh',
    pane: 2,
    panePid: 612,
    command: 'zsh',
    path: '/Users/me/project',
  }),
  paneLine({
    session: 2,
    name: 'two',
    created: 1759470000,
    windows: 1,
    window: 3,
    windowIndex: 0,
    windowActive: 1,
    windowName: 'zsh',
    pane: 3,
    panePid: 613,
    command: 'zsh',
    path: '/Users/me/elsewhere',
  }),
  clientLine(650, 0, 0),
  clientLine(660, 1, 0),
  clientLine(670, 2, 1),
].join('\n');

const WAITING_SINCE = Date.UTC(2026, 9, 3, 19, 39, 58);
const STATUSES: Record<number, ClaudeStatus> = {
  530: {
    status: 'idle',
    sessionId: 'conv-a',
    title: 'Docs pass',
    preview: { role: 'assistant', text: 'Done.' },
    since: Date.UTC(2026, 9, 3, 14, 0, 0),
  },
  620: {
    status: 'waiting',
    waitingFor: 'permission',
    sessionId: 'conv-tmux',
    title: 'Refactor parser',
    since: WAITING_SINCE,
  },
};

const CODEX: CodexChat = {
  available: true,
  agent: 'codex',
  status: 'busy',
  title: 'Codex task',
  activity: { kind: 'thinking', since: START_MS + 1000 },
  messages: [{ id: '1', role: 'user', text: 'Fix the tests' }],
};

const settings = (overrides: Partial<MacSessionsSettings> = {}): MacSessionsSettings => ({
  on: true,
  supported: true,
  enabled: true,
  openMode: 'control',
  includeHeadless: false,
  ...overrides,
});

describe('MacSessionsScanner', () => {
  let claudeDir: string;
  let clock: { now: number };
  let current: MacSessionsSettings;
  let machine: string[];
  let listing: string;
  let env: Record<string, string | undefined>;
  let calls: { table: number; tmux: string[] };

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtm-scanner-'));
    fs.mkdirSync(path.join(claudeDir, 'sessions'));
    const sessionFile = (pid: number, sessionId: string, cwd: string) =>
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${pid}.json`),
        JSON.stringify({ pid, sessionId, cwd, entrypoint: 'cli', procStart: LSTART })
      );
    sessionFile(530, 'conv-a', '/Users/me/project');
    sessionFile(620, 'conv-tmux', '/Users/me/project');
    sessionFile(840, 'conv-ut', '/Users/me/project');
    sessionFile(910, 'conv-fwd', '/Users/me/project');
    clock = { now: Date.UTC(2026, 9, 3, 19, 40, 12, 345) };
    current = settings();
    machine = [...MACHINE];
    listing = LISTING;
    env = {};
    calls = { table: 0, tmux: [] };
  });

  afterEach(() => {
    fs.rmSync(claudeDir, RM_TEST_DIR);
  });

  const discovery = (): TmuxDiscoveryDeps => ({
    uid: 501,
    socketDir: DIR,
    ownShieldSocket: '/Users/me/.untether/control/.shield-tmux',
    listSockets: async () => [SOCKET],
    realpath: async (file) => (file === SOCKET ? file : null),
    socketId: async (file) => (file === SOCKET ? '1:2:3' : null),
    runTmux: async (socket) => {
      calls.tmux.push(socket);
      return listing;
    },
    socketsOf: async () => new Map(),
    startingEnvs: async () => new Map(),
    now: () => clock.now,
  });

  const agents = (): AgentFinderDeps => ({
    uid: 501,
    claudeDir: () => claudeDir,
    cwdsOf: async (pids) => new Map(pids.map((pid) => [pid, '/Users/me/other'])),
    untetherEnvOf: async () => new Set(),
    claudeStatus: async (pid) => STATUSES[pid],
    codexChat: () => CODEX,
    codexThreadId: () => 'thread-1',
    geminiChat: () => ({ ...CODEX, agent: 'gemini' }) as GeminiChat,
  });

  const deps = (overrides: Partial<MacSessionsScannerDeps> = {}): MacSessionsScannerDeps => ({
    settings: () => current,
    table: async () => {
      calls.table++;
      return parseProcessTable(machine.join('\n'));
    },
    utSessions: () => UT_SESSIONS,
    tmuxVersion: async () => ({ available: true, version: '3.7c', canOpen: true }),
    discovery: discovery(),
    agents: agents(),
    serverPid: 4000,
    platform: 'darwin',
    env,
    realpath: (folder) => folder,
    now: () => clock.now,
    ...overrides,
  });

  it('builds the rows: tmux sessions with their agents, agents on their own, in order', async () => {
    const scanner = new MacSessionsScanner(deps());
    const response = await scanner.scan();
    expect(response).toMatchObject({
      enabled: true,
      platform: 'darwin',
      scannedAt: '2026-10-03T19:40:12.345Z',
      openMode: 'control',
      tmux: { available: true, version: '3.7c', canOpen: true },
      warnings: [],
    });
    expect(response.items.map((item) => item.id)).toEqual([
      `t-600-${S}-0`,
      `a-530-${S}`,
      `t-600-${S}-1`,
      `t-600-${S}-2`,
    ]);
    const [busy, alone, typedInUntether, openedHere] = response.items;
    expect(busy).toEqual({
      kind: 'tmux',
      id: `t-600-${S}-0`,
      name: '0',
      server: { label: '', isDefault: true },
      windows: 2,
      createdAt: new Date(1759480000 * 1000).toISOString(),
      activityAt: new Date(WAITING_SINCE).toISOString(),
      current: {
        windowIndex: 1,
        windowName: 'claude',
        command: 'claude',
        title: 'Refactor parser',
        cwd: '/Users/me/project',
        width: 120,
        height: 40,
      },
      agents: [
        {
          agent: 'claude',
          chatId: `p-600-${S}-0`,
          status: {
            status: 'waiting',
            waitingFor: 'permission',
            title: 'Refactor parser',
            since: WAITING_SINCE,
          },
          title: 'Refactor parser',
          conversationId: 'conv-tmux',
          startedAt: new Date(START_MS).toISOString(),
          cwd: '/Users/me/project',
          windowIndex: 1,
          windowName: 'claude',
          inCurrentWindow: true,
          activePane: true,
        },
        {
          agent: 'codex',
          chatId: `p-600-${S}-1`,
          status: {
            status: 'busy',
            title: 'Codex task',
            activity: { kind: 'thinking', since: START_MS + 1000 },
            since: START_MS + 1000,
            preview: { role: 'user', text: 'Fix the tests' },
          },
          title: 'Codex task',
          conversationId: 'thread-1',
          startedAt: new Date(START_MS).toISOString(),
          cwd: '/Users/me/other',
          windowIndex: 2,
          windowName: 'codex',
          inCurrentWindow: false,
          activePane: true,
        },
      ],
      alsoOpenIn: ['Terminal'],
      canOpen: true,
    });
    expect(alone).toEqual({
      kind: 'agent',
      id: `a-530-${S}`,
      chatId: `a-530-${S}`,
      agent: 'claude',
      status: {
        status: 'idle',
        title: 'Docs pass',
        preview: { role: 'assistant', text: 'Done.' },
        since: Date.UTC(2026, 9, 3, 14, 0, 0),
      },
      title: 'Docs pass',
      conversationId: 'conv-a',
      startedAt: new Date(START_MS).toISOString(),
      cwd: '/Users/me/project',
      app: 'Terminal',
      tty: 'ttys001',
    });
    // `tmux attach` typed in an Untether shell (ending that session would end the shell), and a
    // client Untether opened read-only (ending it disconnects).
    expect(typedInUntether).toMatchObject({
      name: '1',
      agents: [],
      alsoOpenIn: [],
      utSessionId: 'web-1',
      utMode: 'control',
      utClient: false,
    });
    expect(openedHere).toMatchObject({
      name: 'two',
      utSessionId: 'web-8',
      utMode: 'watch',
      utClient: true,
    });
  });

  it("names Untether's own client of a tmux session first, never a terminal window's ut", async () => {
    // `ut tmux attach -t 1` in the Terminal tab: its session's program is that client.
    machine.push(
      ps(920, 520, '16/1', '/Applications/Untether.app/Contents/Resources/untether-fwd tmux'),
      ps(925, 920, '16/31', 'tmux attach -t 1')
    );
    listing = [LISTING, clientLine(925, 1, 0)].join('\n');
    const sessions = [
      ...UT_SESSIONS,
      { id: 'fwd_1759500000000_920', pid: 925, status: 'running' as const },
    ];
    const typedOnly = await new MacSessionsScanner(deps({ utSessions: () => sessions })).scan();
    expect(typedOnly.items.find((item) => item.id === `t-600-${S}-1`)).toMatchObject({
      utSessionId: 'web-1',
      utClient: false,
    });

    // A client Untether opened on the same tmux session, listed after the others.
    machine.push(
      ps(680, 4000, '16/23', `/opt/homebrew/bin/tmux -u -N -S ${SOCKET} attach-session -t $1`)
    );
    listing = [LISTING, clientLine(925, 1, 0), clientLine(680, 1, 1)].join('\n');
    const withOwn = await new MacSessionsScanner(
      deps({
        utSessions: () => [...sessions, { id: 'web-9', pid: 680, status: 'running' as const }],
      })
    ).scan();
    expect(withOwn.items.find((item) => item.id === `t-600-${S}-1`)).toMatchObject({
      utSessionId: 'web-9',
      utMode: 'watch',
      utClient: true,
    });
  });

  it("a web-spawned Terminal session (UUID id, forwarderPid) is never Untether's own client", async () => {
    // 2026-10-20: only `fwd_` ids were checked, so this one counted as Untether's own client.
    machine.push(
      ps(920, 520, '16/1', '/Applications/Untether.app/Contents/Resources/untether-fwd tmux'),
      ps(925, 920, '16/31', 'tmux attach -t 1')
    );
    listing = [LISTING, clientLine(925, 1, 0)].join('\n');
    const sessions = [
      ...UT_SESSIONS,
      {
        id: '0b7c2f8e-5a3d-4c1e-9f00-1234567890ab',
        pid: 925,
        status: 'running' as const,
        forwarderPid: 920,
      },
    ];
    const result = await new MacSessionsScanner(deps({ utSessions: () => sessions })).scan();
    expect(result.items.find((item) => item.id === `t-600-${S}-1`)).toMatchObject({
      utSessionId: 'web-1',
      utClient: false,
    });
  });

  it('indexes what each id names, and only that', async () => {
    const scanner = new MacSessionsScanner(deps());
    await scanner.scan();
    expect(scanner.target(`t-600-${S}-0`)).toEqual({
      kind: 'tmux',
      socketPath: SOCKET,
      serverPid: 600,
      serverStartedAt: S,
      tmuxSessionId: '$0',
      name: '0',
    });
    expect(scanner.target(`p-600-${S}-1`)).toEqual({
      kind: 'pane',
      socketPath: SOCKET,
      serverPid: 600,
      serverStartedAt: S,
      paneId: '%1',
      panePid: 611,
      agentPid: 630,
      agentStart: 'Fri Oct 2 09:00:00 2026',
      agent: 'codex',
      cwd: '/Users/me/other',
    });
    expect(scanner.target(`a-530-${S}`)).toEqual({
      kind: 'agent',
      pid: 530,
      lstart: 'Fri Oct 2 09:00:00 2026',
      agent: 'claude',
      cwd: '/Users/me/project',
      claudeDir,
    });
    // Untether's own Claudes are not Mac sessions, nor one started with ut in a terminal.
    expect(scanner.target(`a-840-${S}`)).toBeUndefined();
    expect(scanner.target(`a-910-${S}`)).toBeUndefined();
    expect(scanner.idsForProcess(620, 'Fri Oct 2 09:00:00 2026')).toEqual({
      chatId: `p-600-${S}-0`,
      tmuxId: `t-600-${S}-0`,
      tmuxName: '0',
      windowIndex: 1,
    });
  });

  it('keeps ids and order across scans', async () => {
    const scanner = new MacSessionsScanner(deps());
    const first = await scanner.scan();
    clock.now += 10_000;
    const second = await scanner.scan();
    expect(calls.table).toBe(2);
    expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    expect(second.items).toEqual(first.items);
  });

  it('reuses a scan for 3 s, shares one between callers, forces at most once a second', async () => {
    const scanner = new MacSessionsScanner(deps());
    const [a, b] = await Promise.all([scanner.scan(), scanner.scan()]);
    expect(a).toBe(b);
    expect(calls.table).toBe(1);
    clock.now += 500;
    await scanner.scan({ force: true });
    expect(calls.table).toBe(1);
    clock.now += 600;
    await scanner.scan({ force: true });
    expect(calls.table).toBe(2);
    clock.now += 2_000;
    await scanner.scan();
    expect(calls.table).toBe(2);
    clock.now += 1_001;
    await scanner.scan();
    expect(calls.table).toBe(3);
    scanner.invalidate();
    await scanner.scan();
    expect(calls.table).toBe(4);
  });

  it('answers the current open mode from a cached scan', async () => {
    const scanner = new MacSessionsScanner(deps());
    await scanner.scan();
    current = settings({ openMode: 'watch' });
    expect((await scanner.scan()).openMode).toBe('watch');
    expect(calls.table).toBe(1);
  });

  it('puts "Share with phone" on agent rows when answering, from the cache too', async () => {
    let enabled = true;
    let can = true;
    const scanner = new MacSessionsScanner(
      deps({
        share: () => ({
          status: () => (enabled ? { enabled: true } : { enabled: false, reason: 'disabled' }),
          availability: (row) =>
            row.app === 'Terminal'
              ? { can, ...(can ? {} : { reason: 'busy' as const }) }
              : undefined,
        }),
      })
    );
    const first = await scanner.scan();
    expect(first.share).toEqual({ enabled: true });
    const agent = first.items.find((item) => item.kind === 'agent');
    expect(agent).toMatchObject({ id: expect.stringMatching(/^a-530-/), share: { can: true } });
    expect(
      first.items.filter((item) => item.kind === 'tmux').every((item) => !('share' in item))
    ).toBe(true);
    can = false;
    const cached = await scanner.scan();
    expect(cached.items.find((item) => item.kind === 'agent')).toMatchObject({
      share: { can: false, reason: 'busy' },
    });
    enabled = false;
    const off = await scanner.scan();
    expect(off.share).toEqual({ enabled: false, reason: 'disabled' });
    expect(off.items.some((item) => 'share' in item)).toBe(false);
    expect(calls.table).toBe(1);
  });

  it('runs nothing while Mac Sessions is off', async () => {
    current = settings({ on: false, enabled: false, reason: 'disabled' });
    const spies = {
      table: vi.fn(),
      utSessions: vi.fn(),
      tmuxVersion: vi.fn(),
      runTmux: vi.fn(),
      claudeStatus: vi.fn(),
    };
    const scanner = new MacSessionsScanner(
      deps({
        table: spies.table,
        utSessions: spies.utSessions,
        tmuxVersion: spies.tmuxVersion,
        discovery: { ...discovery(), runTmux: spies.runTmux },
        agents: { ...agents(), claudeStatus: spies.claudeStatus },
      })
    );
    expect(await scanner.scan({ force: true })).toEqual({
      enabled: false,
      reason: 'disabled',
      platform: 'darwin',
      openMode: 'control',
      items: [],
      warnings: [],
    });
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(await scanner.resolve(`t-600-${S}-0`)).toBeUndefined();
  });

  it('lists only what is under UNTETHER_MAC_SESSIONS_ONLY_IN', async () => {
    env.UNTETHER_MAC_SESSIONS_ONLY_IN = ' /Users/me/elsewhere , /nowhere';
    const scanner = new MacSessionsScanner(deps());
    const response = await scanner.scan();
    expect(response.items.map((item) => item.id)).toEqual([`t-600-${S}-2`]);
    // What is not listed can't be acted on.
    expect(scanner.target(`a-530-${S}`)).toBeUndefined();
  });

  it('hides what runs inside a hidden folder, not a sibling that shares its prefix', async () => {
    current = settings({ hideIn: ['/Users/me/project'] });
    const scanner = new MacSessionsScanner(deps());
    const response = await scanner.scan();
    expect(response.items.map((item) => item.id)).toEqual([`t-600-${S}-2`]);
    expect(scanner.target(`a-530-${S}`)).toBeUndefined();

    // "/Users/me/proj" is not a parent of "/Users/me/project".
    current = settings({ hideIn: ['/Users/me/proj', '/Users/me/elsewher'] });
    const siblings = await new MacSessionsScanner(deps()).scan();
    expect(siblings.items).toHaveLength(4);
  });

  it('hides a folder reached through a link, and one hidden through a link', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vtm-hide-')));
    try {
      fs.mkdirSync(path.join(root, 'real', 'sub'), { recursive: true });
      fs.mkdirSync(path.join(root, 'kept'));
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
      listing = LISTING.replaceAll('/Users/me/project', path.join(root, 'link', 'sub')).replaceAll(
        '/Users/me/elsewhere',
        path.join(root, 'kept')
      );
      const real = deps({ realpath: undefined, env: { ...env } });
      // The tmux panes run in link/sub; the hidden folder is the real one.
      current = settings({ hideIn: [path.join(root, 'real')] });
      let response = await new MacSessionsScanner(real).scan();
      expect(response.items.map((item) => item.id)).toEqual([`a-530-${S}`, `t-600-${S}-2`]);
      // And the other way round: the hidden folder is given through the link.
      listing = listing.replaceAll(path.join(root, 'link'), path.join(root, 'real'));
      current = settings({ hideIn: [path.join(root, 'link')] });
      response = await new MacSessionsScanner(real).scan();
      expect(response.items.map((item) => item.id)).toEqual([`a-530-${S}`, `t-600-${S}-2`]);
    } finally {
      fs.rmSync(root, RM_TEST_DIR);
    }
  });

  it('still lists a hidden folder that is also under UNTETHER_MAC_SESSIONS_ONLY_IN', async () => {
    // The QA server's case: config.json, shared with the live server, hides QA's folder.
    env.UNTETHER_MAC_SESSIONS_ONLY_IN = '/Users/me/project';
    current = settings({ hideIn: ['/Users/me/project', '/Users/me/elsewhere'] });
    const response = await new MacSessionsScanner(deps()).scan();
    expect(response.items.map((item) => item.id)).toEqual([
      `t-600-${S}-0`,
      `a-530-${S}`,
      `t-600-${S}-1`,
    ]);
  });

  describe('what agents’ tools made for their tests', () => {
    const SCRATCH = '/private/tmp/claude-501/-Users-me-project/abcd/scratchpad';
    const AGENT_SOCKET = `${DIR}/agente-prueba`;
    const pane = (session: number, panePath: string, overrides: Partial<PaneSpec> = {}) =>
      paneLine({
        session,
        name: `s${session}`,
        created: 1759480000 + session,
        windows: 1,
        window: session,
        windowIndex: 0,
        windowActive: 1,
        windowName: 'zsh',
        pane: session,
        panePid: 612,
        command: 'zsh',
        path: panePath,
        ...overrides,
      });
    const onSocket = (
      socket: string,
      envOfServer: Record<string, string>
    ): Partial<MacSessionsScannerDeps> => ({
      discovery: {
        ...discovery(),
        listSockets: async () => [socket],
        realpath: async (file) => (file === socket ? file : null),
        socketId: async (file) => (file === socket ? '1:2:3' : null),
        startingEnvs: async (pids) =>
          new Map(pids.map((pid) => [pid, new Map(Object.entries(envOfServer))])),
      },
    });
    const ids = async (overrides: Partial<MacSessionsScannerDeps> = {}) =>
      (await new MacSessionsScanner(deps(overrides)).scan()).items.map((item) => item.id);

    it('leaves out a session in a scratchpad and keeps an ordinary one beside it', async () => {
      listing = [pane(1, SCRATCH), pane(2, '/Users/me/project')].join('\n');
      const listed = await ids();
      expect(listed).not.toContain(`t-600-${S}-1`);
      expect(listed).toContain(`t-600-${S}-2`);
    });

    it('keeps a session with any pane outside the scratchpad', async () => {
      listing = [
        pane(1, SCRATCH),
        pane(1, '/Users/me/project', { pane: 9, window: 9, windowActive: 0 }),
      ].join('\n');
      expect(await ids()).toContain(`t-600-${S}-1`);
    });

    it('keeps a session in a scratchpad that a Terminal window shows', async () => {
      listing = [pane(0, SCRATCH), clientLine(650, 0, 0)].join('\n');
      expect(await ids()).toContain(`t-600-${S}-0`);
    });

    it('leaves out a whole server an agent started on its own socket, with its agents', async () => {
      // No window of an app shows any of it.
      listing = LISTING.split('\n')
        .filter((line) => !line.startsWith('C'))
        .join('\n');
      const marked = await ids(onSocket(AGENT_SOCKET, { UNTETHER_TASK_ID: 'abc' }));
      expect(marked).toEqual([`a-530-${S}`]);
      // Nothing to act on: what is not listed can't be opened either.
      const scanner = new MacSessionsScanner(
        deps(onSocket(AGENT_SOCKET, { UNTETHER_TASK_ID: 'abc' }))
      );
      await scanner.scan();
      expect(scanner.target(`t-600-${S}-0`)).toBeUndefined();
      expect(scanner.target(`p-600-${S}-0`)).toBeUndefined();
    });

    it('lists the same server when nothing marks it: a user’s tmux with its own socket', async () => {
      const unmarked = await ids(onSocket(AGENT_SOCKET, { UNTETHER_SESSION_ID: 'web-1' }));
      expect(unmarked).toEqual(
        expect.arrayContaining([`t-600-${S}-0`, `t-600-${S}-1`, `t-600-${S}-2`])
      );
    });

    it('lists the default server even when an agent started it', async () => {
      const marked = await ids(onSocket(SOCKET, { CLAUDECODE: '1' }));
      expect(marked).toEqual(
        expect.arrayContaining([`t-600-${S}-0`, `t-600-${S}-1`, `t-600-${S}-2`])
      );
    });

    it('leaves out an agent in a marked server that can’t be listed, and its warning', async () => {
      const response = await new MacSessionsScanner(
        deps({
          discovery: {
            ...discovery(),
            listSockets: async () => [],
            realpath: async () => null,
            socketsOf: async () => new Map([[600, [AGENT_SOCKET]]]),
            startingEnvs: async (pids) =>
              new Map(pids.map((pid) => [pid, new Map([['CLAUDECODE', '1']])])),
          },
        })
      ).scan();
      expect(response.items.map((item) => item.id)).toEqual([`a-530-${S}`]);
      expect(response.warnings).toEqual([]);
    });

    it('leaves out an agent on its own in a scratchpad, not one in a Terminal tab', async () => {
      machine.push(ps(700, 1, '16/40', 'node /Users/me/.nvm/bin/codex'));
      const inScratch = (scratchPids: number[]) => ({
        agents: {
          ...agents(),
          cwdsOf: async (pids: number[]) =>
            new Map(
              pids.map((pid) => [pid, scratchPids.includes(pid) ? SCRATCH : '/Users/me/other'])
            ),
        },
      });
      expect(await ids()).toContain(`a-700-${S}`);
      expect(await ids(inScratch([700]))).not.toContain(`a-700-${S}`);
      // Claude in the Terminal tab (530) is the user's, wherever they went.
      expect(await ids(inScratch([530]))).toContain(`a-530-${S}`);
    });

    it('shows them to a server limited with UNTETHER_MAC_SESSIONS_ONLY_IN', async () => {
      env.UNTETHER_MAC_SESSIONS_ONLY_IN = '/private/tmp/claude-501';
      listing = pane(1, SCRATCH);
      expect(await ids()).toEqual([`t-600-${S}-1`]);
    });
  });

  it(`lists at most ${MAX_ITEMS} items`, async () => {
    listing = Array.from({ length: MAX_ITEMS + 5 }, (_, i) =>
      paneLine({
        session: i,
        name: `s${i}`,
        created: 1759400000 + i,
        windows: 1,
        window: i,
        windowIndex: 0,
        windowActive: 1,
        windowName: 'zsh',
        pane: i,
        panePid: 612,
        command: 'zsh',
        path: '/Users/me/project',
      })
    ).join('\n');
    const response = await new MacSessionsScanner(deps()).scan();
    expect(response.items).toHaveLength(MAX_ITEMS);
    expect(response.warnings).toEqual([{ code: 'truncated' }]);
    // The Terminal Claude first (idle beats no agent), then the newest sessions.
    expect(response.items[0].id).toBe(`a-530-${S}`);
    const names = response.items.slice(1).map((item) => (item as MacTmuxSession).name);
    expect(names[0]).toBe(`s${MAX_ITEMS + 4}`);
    expect(names).not.toContain('s5');
  });

  it('lists agents alone when tmux is missing or a tmux server can’t be listed', async () => {
    const noTmux = await new MacSessionsScanner(
      deps({ tmuxVersion: async () => ({ available: false, canOpen: false }) })
    ).scan();
    expect(noTmux.warnings).toEqual([{ code: 'tmux-unavailable' }]);
    expect(noTmux.tmux).toEqual({ available: false, canOpen: false });
    expect(noTmux.items.map((item) => [item.kind, item.id])).toEqual([
      ['agent', `a-620-${S}`],
      ['agent', `a-630-${S}`],
      ['agent', `a-530-${S}`],
    ]);
    expect(noTmux.items[0]).toMatchObject({ inTmux: { server: '' } });

    // The server's socket was deleted: its agents are shown read-only, on their own.
    const missing = await new MacSessionsScanner(
      deps({
        discovery: {
          ...discovery(),
          listSockets: async () => [],
          realpath: async () => null,
          socketsOf: async () => new Map([[600, [`${DIR}/work`]]]),
        },
      })
    ).scan();
    expect(missing.warnings).toEqual([{ code: 'tmux-socket-missing', ref: `600-${S}` }]);
    expect(missing.items[0]).toMatchObject({ id: `a-620-${S}`, inTmux: { server: 'work' } });
  });

  it('cannot open tmux sessions with a tmux older than 3.2', async () => {
    const response = await new MacSessionsScanner(
      deps({ tmuxVersion: async () => ({ available: true, version: '3.1c', canOpen: false }) })
    ).scan();
    expect(response.items[0]).toMatchObject({ canOpen: false, cannotOpenReason: 'tmux-too-old' });
  });

  it('resolves an id it doesn’t know yet with one new scan', async () => {
    const scanner = new MacSessionsScanner(deps());
    expect(await scanner.resolve(`t-600-${S}-1`)).toMatchObject({ tmuxSessionId: '$1' });
    expect(calls.table).toBe(1);
    clock.now += 1_500;
    expect(await scanner.resolve(`t-600-${S}-9`)).toBeUndefined();
    expect(calls.table).toBe(2);
  });

  it('tells History which Claude conversations are live outside Untether', async () => {
    const scanner = new MacSessionsScanner(deps());
    await scanner.scan();
    expect(Object.fromEntries(await scanner.liveClaudeConversations())).toEqual({
      'conv-a': { where: 'terminal', app: 'Terminal', chatId: `a-530-${S}` },
      'conv-tmux': {
        where: 'tmux',
        chatId: `p-600-${S}-0`,
        tmuxId: `t-600-${S}-0`,
        tmuxName: '0',
        windowIndex: 1,
      },
      // The ut claude's session is not one this server lists (another instance's): never a Mac
      // item, and never resumed here either.
      'conv-fwd': { where: 'terminal', app: 'Terminal' },
    });
    // Also with the section off: no ids then.
    current = settings({ on: false, enabled: false, reason: 'disabled' });
    await scanner.scan();
    expect(Object.fromEntries(await scanner.liveClaudeConversations())).toEqual({
      'conv-a': { where: 'terminal', app: 'Terminal' },
      'conv-tmux': { where: 'tmux' },
      'conv-fwd': { where: 'terminal', app: 'Terminal' },
    });
    // One of this server's own sessions: History opens that session instead.
    const listing = new MacSessionsScanner(
      deps({
        utSessions: () => [
          ...UT_SESSIONS,
          { id: 'fwd_1759500000000_905', pid: 910, status: 'running' as const },
        ],
      })
    );
    expect((await listing.liveClaudeConversations()).has('conv-fwd')).toBe(false);
  });

  it('never scans the real machine under vitest', async () => {
    const table = vi.fn();
    const scanner = new MacSessionsScanner({
      ...deps({ table }),
      discovery: undefined,
      agents: undefined,
    });
    await expect(scanner.scan()).rejects.toThrow(/vitest/);
    expect(table).not.toHaveBeenCalled();
    expect(calls.tmux).toEqual([]);
  });
});

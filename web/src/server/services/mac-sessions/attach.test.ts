import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type SessionMultiplexer, TitleMode } from '../../../shared/types.js';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import { PtyError } from '../../pty/types.js';
import { parseProcessTable, readProcessTable } from '../claude-chat.js';
import { parseUtcStart } from '../codex-process.js';
import { findTmuxBinary, tmuxEnv } from '../shielded-tmux.js';
import { type AttachedMode, TmuxAttachError } from '../tmux-attach-tracker.js';
import { TMUX_FIELD_SEPARATOR } from '../tmux-manager.js';
import {
  ATTACHING_MS,
  type AttachableSession,
  attachCommand,
  MacAttach,
  type MacAttachDeps,
  MacSessionsError,
} from './attach.js';
import type { MacSessionTarget } from './scanner.js';
import { assertMacTmuxAllowed, parseTmuxVersion, runMacTmux } from './tmux-run.js';
import { SERVER_LISTING_ARGS } from './tmux-servers.js';

// Nothing here reaches a real tmux server or process: the scanner, tmux, ps and the PTY
// manager are fakes.
const SEP = TMUX_FIELD_SEPARATOR;
const TMUX = '/opt/homebrew/bin/tmux';
const SOCKET = '/private/tmp/tmux-501/default';
const LSTART = 'Fri Oct  2 09:00:00 2026';
const S = Date.UTC(2026, 9, 2, 9, 0, 0) / 1000;
const NOW = Date.UTC(2026, 9, 3, 19, 40, 0);
const ID = `t-600-${S}-2`;

const TARGET: MacSessionTarget = {
  kind: 'tmux',
  socketPath: SOCKET,
  serverPid: 600,
  serverStartedAt: S,
  tmuxSessionId: '$2',
  name: 'work',
};

/** What a session opened on TARGET records. */
const TARGET_MULTIPLEXER: SessionMultiplexer = {
  type: 'tmux',
  socketPath: SOCKET,
  serverPid: 600,
  serverStartedAt: S,
  sessionId: '$2',
  sessionName: 'work',
  mode: 'control',
  sizing: 'others',
  source: 'mac-sessions',
};

const ps = (pid: number, ppid: number, tty: string, args: string, lstart = LSTART) =>
  `${pid} ${ppid} ${pid} 0 ${tty} S 501 ${lstart} ${args}`;

const MACHINE = [
  ps(600, 1, '??', 'tmux new -s work'),
  ps(610, 600, '16/10', '-zsh'),
  ps(611, 600, '16/11', '-zsh'),
  // Untether: a shell session (810) where `tmux attach` was typed (660).
  ps(4000, 1, '??', 'node untether --port 4020'),
  ps(810, 4000, '16/20', '-zsh'),
  ps(660, 810, '16/20', 'tmux attach -t work'),
  // A Terminal tab's `tmux attach`.
  ps(650, 1, '16/1', 'tmux attach -t work'),
];

const pane = (
  session: number,
  name: string,
  windowIndex: number,
  windowActive: 0 | 1,
  paneId: number,
  panePid: number,
  panePath: string,
  serverPid = 600
) =>
  [
    'P',
    serverPid,
    `$${session}`,
    name,
    1,
    1759480000,
    1759480100,
    2,
    `@${paneId}`,
    windowIndex,
    windowActive,
    120,
    40,
    'zsh',
    `%${paneId}`,
    0,
    1,
    panePid,
    0,
    'zsh',
    panePath,
    '',
  ].join(SEP);

const client = (pid: number, session: number, readOnly: 0 | 1) =>
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

// $2 "work": window 0 in the background, window 1 on screen; $3 "other".
const PANES = [
  pane(2, 'work', 0, 0, 7, 610, '/Users/me/background'),
  pane(2, 'work', 1, 1, 8, 611, '/Users/me/project'),
  pane(3, 'other', 0, 1, 9, 612, '/Users/me/other'),
];

describe('attachCommand', () => {
  it('attaches to the session by its id, ignoring size, read-only to watch', () => {
    expect(attachCommand(TMUX, SOCKET, '$2', 'control')).toEqual([
      TMUX,
      '-u',
      '-N',
      '-S',
      SOCKET,
      'attach-session',
      '-E',
      '-f',
      'ignore-size',
      '-t',
      '$2',
    ]);
    expect(attachCommand(TMUX, SOCKET, '$2', 'watch')).toEqual([
      TMUX,
      '-u',
      '-N',
      '-S',
      SOCKET,
      'attach-session',
      '-E',
      '-f',
      'ignore-size,read-only',
      '-t',
      '$2',
    ]);
  });

  it('never targets a window, a pane or a name, nor a relative path', () => {
    expect(() => attachCommand(TMUX, SOCKET, '$2:1', 'control')).toThrow();
    expect(() => attachCommand(TMUX, SOCKET, '%8', 'control')).toThrow();
    expect(() => attachCommand(TMUX, SOCKET, 'work', 'control')).toThrow();
    expect(() => attachCommand('tmux', SOCKET, '$2', 'control')).toThrow();
    expect(() => attachCommand(TMUX, 'default', '$2', 'control')).toThrow();
  });
});

describe('MacAttach', () => {
  let sessions: AttachableSession[];
  let listing: string[];
  let machine: string[];
  let tmuxCalls: Array<{ socket: string; args: string[] }>;
  let tmuxError: Error | null;
  let scanner: {
    resolve: Mock<(id: string) => Promise<MacSessionTarget | undefined>>;
    invalidate: Mock<() => void>;
  };
  let ptyManager: {
    listSessions: Mock<() => AttachableSession[]>;
    getSession: Mock<(id: string) => AttachableSession | null>;
    createSession: Mock<
      (
        command: string[],
        options: { multiplexer: SessionMultiplexer }
      ) => Promise<{ sessionId: string; sessionInfo: AttachableSession }>
    >;
    setAttachedMode: Mock<(id: string, change: Partial<AttachedMode>) => Promise<AttachedMode>>;
  };
  let created: number;
  let usable: (dir: string) => boolean;
  let version: { available: boolean; version?: string; canOpen: boolean };

  beforeEach(() => {
    sessions = [];
    listing = [...PANES, client(650, 2, 0)];
    machine = [...MACHINE];
    tmuxCalls = [];
    tmuxError = null;
    created = 0;
    usable = () => true;
    version = { available: true, version: '3.7c', canOpen: true };
    scanner = {
      resolve: vi.fn(async (id: string) => (id === ID ? TARGET : undefined)),
      invalidate: vi.fn(),
    };
    ptyManager = {
      listSessions: vi.fn(() => sessions),
      getSession: vi.fn((id: string) => sessions.find((session) => session.id === id) ?? null),
      createSession: vi.fn(
        async (_command: string[], options: { multiplexer: SessionMultiplexer }) => {
          created++;
          const session: AttachableSession = {
            id: `opened-${created}`,
            pid: 7000 + created,
            status: 'running',
            startedAt: new Date(NOW).toISOString(),
            multiplexer: options.multiplexer,
          };
          sessions.push(session);
          return { sessionId: session.id, sessionInfo: session };
        }
      ),
      setAttachedMode: vi.fn(
        async (): Promise<AttachedMode> => ({
          mode: 'control',
          sizing: 'others',
        })
      ),
    };
  });

  const attach = (overrides: Partial<MacAttachDeps> = {}) =>
    new MacAttach({
      scanner,
      ptyManager: ptyManager as unknown as MacAttachDeps['ptyManager'],
      tmuxVersion: async () => version,
      tmuxBin: () => TMUX,
      runTmux: async (socket, args) => {
        // Whatever open runs on the user's server must pass the allowlist.
        assertMacTmuxAllowed(args);
        tmuxCalls.push({ socket, args });
        if (tmuxError) throw tmuxError;
        return `${listing.join('\n')}\n`;
      },
      table: async () => parseProcessTable(machine.join('\n')),
      homeDir: () => '/Users/me',
      canStartIn: (dir) => usable(dir),
      now: () => NOW,
      ...overrides,
    });

  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as MacSessionsError;
    }
    throw new Error('expected a failure');
  };

  describe('open', () => {
    it('opens a new session on the tmux session, at the pane on screen', async () => {
      const answer = await attach().open(ID, { mode: 'control', cols: 52, rows: 30 });

      expect(answer).toEqual({ sessionId: 'opened-1', reused: false, mode: 'control' });
      expect(tmuxCalls).toEqual([{ socket: SOCKET, args: SERVER_LISTING_ARGS }]);
      expect(ptyManager.createSession).toHaveBeenCalledTimes(1);
      const [command, options] = ptyManager.createSession.mock.calls[0];
      expect(command).toEqual([
        TMUX,
        '-u',
        '-N',
        '-S',
        SOCKET,
        'attach-session',
        '-E',
        '-f',
        'ignore-size',
        '-t',
        '$2',
      ]);
      expect(options).toEqual({
        name: 'tmux: work',
        workingDir: '/Users/me/project',
        cols: 52,
        rows: 30,
        titleMode: TitleMode.STATIC,
        shielded: false,
        multiplexer: {
          type: 'tmux',
          socketPath: SOCKET,
          serverPid: 600,
          serverStartedAt: S,
          sessionId: '$2',
          sessionName: 'work',
          mode: 'control',
          sizing: 'others',
          source: 'mac-sessions',
        },
        attachSeed: { panePid: 611, paneId: '%8' },
      });
      expect(scanner.invalidate).toHaveBeenCalled();
    });

    it('opens read-only to watch, 80x24 unless told, in the home folder when the pane’s can’t be used', async () => {
      usable = (dir) => dir !== '/Users/me/project';
      const answer = await attach().open(ID, { mode: 'watch' });

      expect(answer).toEqual({ sessionId: 'opened-1', reused: false, mode: 'watch' });
      const [command, options] = ptyManager.createSession.mock.calls[0];
      expect(command).toContain('ignore-size,read-only');
      expect(options).toMatchObject({
        workingDir: '/Users/me',
        cols: 80,
        rows: 24,
        multiplexer: { mode: 'watch', sizing: 'others' },
      });
    });

    it('names the session as tmux lists it now', async () => {
      listing = listing.map((line) => line.replace(`${SEP}work${SEP}`, `${SEP}renamed${SEP}`));
      await attach().open(ID, { mode: 'control' });
      expect(ptyManager.createSession.mock.calls[0][1]).toMatchObject({
        name: 'tmux: renamed',
        multiplexer: { sessionName: 'renamed' },
      });
    });

    it('opens only tmux sessions, with a tmux that can', async () => {
      scanner.resolve.mockResolvedValueOnce({
        kind: 'agent',
        pid: 530,
        lstart: LSTART,
        agent: 'claude',
      });
      const agent = await failure(attach().open(`a-530-${S}`, { mode: 'control' }));
      expect(agent).toMatchObject({ code: 'not-openable', status: 422 });

      version = { available: true, version: '3.1c', canOpen: false };
      const old = await failure(attach().open(ID, { mode: 'control' }));
      expect(old).toMatchObject({ code: 'tmux-too-old', status: 409 });

      version = { available: false, canOpen: false };
      const missing = await failure(attach().open(ID, { mode: 'control' }));
      expect(missing).toMatchObject({ code: 'open-failed', status: 500 });

      expect(tmuxCalls).toEqual([]);
      expect(ptyManager.createSession).not.toHaveBeenCalled();
    });

    it('says gone for an id it doesn’t know, after the scanner looked again', async () => {
      const error = await failure(attach().open(`t-600-${S}-9`, { mode: 'control' }));
      expect(error).toBeInstanceOf(MacSessionsError);
      expect(error).toMatchObject({ code: 'gone', status: 404 });
      expect(scanner.resolve).toHaveBeenCalledWith(`t-600-${S}-9`);
      expect(tmuxCalls).toEqual([]);
    });

    it('says gone when the server is another one now, or the session closed', async () => {
      const gone = async () => {
        const error = await failure(attach().open(ID, { mode: 'control' }));
        expect(error).toMatchObject({ code: 'gone', status: 404 });
      };
      // Another server answers on that socket.
      listing = PANES.map((line) => line.replace(`P${SEP}600${SEP}`, `P${SEP}601${SEP}`));
      await gone();
      // Same pid, started at another time (a restarted server that got the pid back).
      listing = [...PANES];
      machine = MACHINE.map((line) =>
        line.startsWith('600 ') ? ps(600, 1, '??', 'tmux new', 'Sat Oct  3 08:00:00 2026') : line
      );
      await gone();
      // $2 closed.
      machine = [...MACHINE];
      listing = [PANES[2]];
      await gone();
      // The server is gone.
      tmuxError = Object.assign(new Error('Command failed'), {
        stderr: 'no server running on /private/tmp/tmux-501/default\n',
      });
      await gone();
      expect(ptyManager.createSession).not.toHaveBeenCalled();
    });

    it('says why when tmux fails otherwise, or the session can’t start', async () => {
      tmuxError = Object.assign(new Error('Command failed'), {
        stderr: 'protocol version mismatch (client 8, server 7)\n',
      });
      const listingFailed = await failure(attach().open(ID, { mode: 'control' }));
      expect(listingFailed).toMatchObject({
        code: 'open-failed',
        status: 500,
        details: 'protocol version mismatch (client 8, server 7)',
      });

      tmuxError = null;
      ptyManager.createSession.mockRejectedValueOnce(new PtyError('Failed to create session: x'));
      const createFailed = await failure(attach().open(ID, { mode: 'control' }));
      expect(createFailed).toMatchObject({
        code: 'open-failed',
        details: 'Failed to create session: x',
      });
      expect(scanner.invalidate).not.toHaveBeenCalled();
    });

    it('answers the Untether session already attached, in its own mode, without opening another', async () => {
      sessions = [
        {
          id: 'opened-before',
          pid: 7100,
          status: 'running',
          startedAt: '2026-10-03T10:00:00.000Z',
          multiplexer: { ...TARGET_MULTIPLEXER, mode: 'control' },
        },
      ];
      // tmux lists its client read-only: a key bound to switch-client -r changed it there.
      listing = [...PANES, client(650, 2, 0), client(7100, 2, 1)];

      const answer = await attach().open(ID, { mode: 'control' });

      expect(answer).toEqual({ sessionId: 'opened-before', reused: true, mode: 'watch' });
      expect(ptyManager.createSession).not.toHaveBeenCalled();
      expect(ptyManager.setAttachedMode).not.toHaveBeenCalled();
    });

    it('answers an Untether shell where `tmux attach` was typed', async () => {
      sessions = [
        { id: 'shell', pid: 810, status: 'running', startedAt: '2026-10-03T10:00:00.000Z' },
      ];
      listing = [...PANES, client(660, 2, 0)];
      expect(await attach().open(ID, { mode: 'watch' })).toEqual({
        sessionId: 'shell',
        reused: true,
        mode: 'control',
      });

      // Attached to another tmux session, or exited: not this one's.
      listing = [...PANES, client(660, 3, 0)];
      expect((await attach().open(ID, { mode: 'control' })).reused).toBe(false);
      sessions = [{ id: 'shell', pid: 810, status: 'exited', startedAt: '2026-10-03T10:00:00Z' }];
      listing = [...PANES, client(660, 2, 0)];
      expect((await attach().open(ID, { mode: 'control' })).reused).toBe(false);
    });

    it('opens once for two opens at the same time: the second waits and gets the first one', async () => {
      const opener = attach();
      const [first, second] = await Promise.all([
        opener.open(ID, { mode: 'control' }),
        opener.open(ID, { mode: 'watch' }),
      ]);

      expect(ptyManager.createSession).toHaveBeenCalledTimes(1);
      expect(first).toEqual({ sessionId: 'opened-1', reused: false, mode: 'control' });
      // Its client isn't listed yet: still attaching.
      expect(second).toEqual({ sessionId: 'opened-1', reused: true, mode: 'control' });
    });

    it('opens again when a session opened here shows another tmux session, or never attached', async () => {
      sessions = [
        {
          id: 'switched',
          pid: 7100,
          status: 'running',
          startedAt: new Date(NOW - 1000).toISOString(),
          multiplexer: TARGET_MULTIPLEXER,
        },
        {
          id: 'never-attached',
          pid: 7200,
          status: 'running',
          startedAt: new Date(NOW - ATTACHING_MS - 1).toISOString(),
          multiplexer: TARGET_MULTIPLEXER,
        },
      ];
      listing = [...PANES, client(7100, 3, 0)];

      const answer = await attach().open(ID, { mode: 'control' });

      expect(answer).toEqual({ sessionId: 'opened-1', reused: false, mode: 'control' });
    });

    it('lets one failed open not hold back the next', async () => {
      ptyManager.createSession.mockRejectedValueOnce(new Error('spawn failed'));
      const opener = attach();
      const [first, second] = await Promise.allSettled([
        opener.open(ID, { mode: 'control' }),
        opener.open(ID, { mode: 'control' }),
      ]);
      expect(first.status).toBe('rejected');
      expect(second).toEqual({
        status: 'fulfilled',
        value: { sessionId: 'opened-1', reused: false, mode: 'control' },
      });
    });
  });

  describe('setMode', () => {
    beforeEach(() => {
      sessions = [
        {
          id: 'opened-before',
          pid: 7100,
          status: 'running',
          startedAt: '2026-10-03T10:00:00.000Z',
          multiplexer: TARGET_MULTIPLEXER,
        },
        { id: 'plain', pid: 7200, status: 'running', startedAt: '2026-10-03T10:00:00.000Z' },
      ];
    });

    it('switches the session’s own client and answers what tmux reports', async () => {
      ptyManager.setAttachedMode.mockResolvedValueOnce({ mode: 'watch', sizing: 'others' });
      expect(await attach().setMode('opened-before', { mode: 'watch' })).toEqual({
        mode: 'watch',
        sizing: 'others',
      });
      expect(ptyManager.setAttachedMode).toHaveBeenCalledWith('opened-before', { mode: 'watch' });
      expect(scanner.invalidate).toHaveBeenCalled();
    });

    it('refuses sessions not attached to a tmux session, or not running', async () => {
      expect(await failure(attach().setMode('plain', { mode: 'watch' }))).toMatchObject({
        code: 'not-attached',
        status: 400,
      });
      expect(await failure(attach().setMode('missing', { mode: 'watch' }))).toMatchObject({
        code: 'not-attached',
      });
      sessions[0].status = 'exited';
      expect(await failure(attach().setMode('opened-before', { mode: 'watch' }))).toMatchObject({
        code: 'not-attached',
      });
      expect(ptyManager.setAttachedMode).not.toHaveBeenCalled();
    });

    it('says why tmux could not switch it', async () => {
      const cases: Array<[unknown, string, number]> = [
        [new TmuxAttachError('client-not-found', 'gone'), 'client-not-found', 409],
        [new TmuxAttachError('mode-failed', 'tmux reports watch'), 'mode-failed', 500],
        [new TmuxAttachError('not-tracked', 'not attached'), 'not-attached', 400],
        [new PtyError('not attached', 'NOT_ATTACHED'), 'not-attached', 400],
        [new Error('timeout'), 'mode-failed', 500],
      ];
      for (const [thrown, code, status] of cases) {
        ptyManager.setAttachedMode.mockRejectedValueOnce(thrown);
        expect(
          await failure(attach().setMode('opened-before', { sizing: 'here' })),
          code
        ).toMatchObject({ code, status });
      }
      // A change that failed half way may still show in the list.
      expect(scanner.invalidate).toHaveBeenCalledTimes(cases.length);
    });
  });
});

const tmuxBin = findTmuxBinary();
// Opening needs tmux 3.2 (attach-session -f, ignore-size, -N).
const canOpen =
  !!tmuxBin && !!parseTmuxVersion(execFileSync(tmuxBin, ['-V'], { encoding: 'utf8' }))?.canOpen;

/** A private tmux server (`-L vtmac-mac-<n>` under a short temp TMUX_TMPDIR), never the user's. */
describe.skipIf(!canOpen)('MacAttach on a tmux server', () => {
  const bin = tmuxBin as string;
  let dir: string;
  let env: Record<string, string>;
  let label: string;
  let servers = 0;
  let created: Array<{ command: string[]; options: Record<string, unknown> }>;

  const tmux = (...args: string[]) =>
    execFileSync(bin, ['-u', '-L', label, '-f', '/dev/null', ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  /**
   * `kill-server` returns before the server process is gone. A new server started on the
   * same socket meanwhile can attach to the dying one and fail with "server exited
   * unexpectedly" (seen on Linux CI), so wait for the old process to exit first.
   */
  async function killServer(): Promise<void> {
    const pid = Number(tmux('display-message', '-p', '#{pid}').trim());
    tmux('kill-server');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`tmux server ${pid} still running 5 s after kill-server`);
  }

  /** What the scanner's index would name for `$0` of the server running now. */
  async function listedTarget(): Promise<MacSessionTarget> {
    const pid = Number(tmux('display-message', '-p', '#{pid}').trim());
    const started = parseUtcStart((await readProcessTable()).starts.get(pid));
    if (started === undefined) throw new Error('the tmux server is not in ps');
    return {
      kind: 'tmux',
      socketPath: fs.realpathSync(path.join(dir, `tmux-${process.getuid?.() ?? 0}`, label)),
      serverPid: pid,
      serverStartedAt: Math.floor(started / 1000),
      tmuxSessionId: '$0',
      name: 'work',
    };
  }

  const opener = (target: MacSessionTarget) =>
    new MacAttach({
      scanner: { resolve: async () => target, invalidate: () => {} },
      ptyManager: {
        listSessions: () => [],
        getSession: () => null,
        // Nothing is spawned: what would be is recorded.
        createSession: async (command: string[], options: Record<string, unknown>) => {
          created.push({ command, options });
          return { sessionId: 'opened-1', sessionInfo: {} };
        },
        setAttachedMode: async () => ({ mode: 'control', sizing: 'others' }),
      } as unknown as MacAttachDeps['ptyManager'],
      tmuxBin: () => bin,
      runTmux: (socket, args) => runMacTmux(socket, args, { tmuxBin: bin, env }),
      table: () => readProcessTable(),
    });

  /**
   * `open` asks tmux several times, each run with a 2 s limit (tmux -V, list-panes). 2026-11-11:
   * with the Mac loaded one of them went over it and `open` answered open-failed, with
   * nothing wrong. Asked again until it answers with something else, with a deadline, instead
   * of trusting each run to be on time. A failure that is not a timeout keeps its answer.
   */
  const openWhenAnswered = async (
    target: MacSessionTarget
  ): Promise<{ value: Awaited<ReturnType<MacAttach['open']>> } | { error: unknown }> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        return { value: await opener(target).open('t-0-0-0', { mode: 'control' }) };
      } catch (error) {
        const timedOut = error instanceof MacSessionsError && error.code === 'open-failed';
        if (!timedOut || Date.now() > deadline) return { error };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };

  beforeEach(() => {
    // Short: socket paths over ~104 bytes fail.
    dir = fs.mkdtempSync('/tmp/vtm.');
    env = tmuxEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, TMUX_TMPDIR: dir });
    label = `vtmac-mac-${++servers}`;
    created = [];
    tmux('new-session', '-d', '-s', 'work', '-x', '120', '-y', '40', '-c', dir, 'sleep 300');
    tmux('new-window', '-t', '$0', '-c', dir, 'sleep 300');
    tmux('new-session', '-d', '-s', 'other', '-c', dir, 'sleep 300');
  });

  afterEach(() => {
    try {
      tmux('kill-server');
    } catch {
      // already gone
    }
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('opens $0 of the server it was listed on, at the pane on screen', async () => {
    const target = await listedTarget();
    expect(await openWhenAnswered(target)).toEqual({
      value: { sessionId: 'opened-1', reused: false, mode: 'control' },
    });
    expect(created).toHaveLength(1);
    const [{ command, options }] = created;
    expect(command).toEqual([
      bin,
      '-u',
      '-N',
      '-S',
      target.kind === 'tmux' ? target.socketPath : '',
      'attach-session',
      '-E',
      '-f',
      'ignore-size',
      '-t',
      '$0',
    ]);
    // The new window is the current one.
    const [paneId, panePid] = tmux('display-message', '-p', '-t', '$0', '#{pane_id} #{pane_pid}')
      .trim()
      .split(' ');
    expect(options).toMatchObject({
      name: 'tmux: work',
      workingDir: fs.realpathSync(dir),
      attachSeed: { paneId, panePid: Number(panePid) },
    });
  }, 90_000);

  it('says gone once $0 closed, its server is another one, or none runs', async () => {
    const target = await listedTarget();
    const gone = async () =>
      expect(await openWhenAnswered(target)).toMatchObject({ error: { code: 'gone' } });

    tmux('kill-session', '-t', '$0');
    await gone();
    // The same socket answers with a $0 named "work" again, from another server.
    await killServer();
    tmux('new-session', '-d', '-s', 'work', '-c', dir, 'sleep 300');
    await gone();
    await killServer();
    await gone();
    expect(created).toEqual([]);
  }, 90_000);
});

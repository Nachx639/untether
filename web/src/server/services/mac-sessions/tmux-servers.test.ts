import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  descendants,
  type ProcessTable,
  parseProcessTable,
  readProcessTable,
} from '../claude-chat.js';
import { findTmuxBinary } from '../shielded-tmux.js';
import { isNoTmuxServer, TMUX_FIELD_SEPARATOR } from '../tmux-manager.js';
import { ttyName } from './process-tree.js';
import { assertMacTmuxAllowed, runMacTmux } from './tmux-run.js';
import {
  listSocketFiles,
  parseLsofUnixSockets,
  parseProcEnviron,
  parseProcNetUnix,
  parseServerListing,
  realTmuxDiscoveryDeps,
  SERVER_LISTING_ARGS,
  STALE_SOCKET_MS,
  socketFileId,
  type TmuxDiscoveryDeps,
  TmuxServerFinder,
  tmuxSocketDir,
  unixSocketsOf,
} from './tmux-servers.js';

const SEP = TMUX_FIELD_SEPARATOR;
const DIR = '/private/tmp/tmux-501';
const UUID = '0b8f7a52-5d4c-4b0a-9a51-8d1c2e3f4a5b';

/** One P line: server pid, session ($id, name), window (index, active), pane (id, pid)… */
function paneLine(o: {
  server?: number;
  session?: string;
  name?: string;
  window?: number;
  windowActive?: number;
  pane?: string;
  panePid?: number;
  paneActive?: number;
  command?: string;
  path?: string;
  title?: string;
}): string {
  return [
    'P',
    o.server ?? 600,
    o.session ?? '$0',
    o.name ?? '0',
    1,
    1759480000,
    1759480100,
    1,
    '@0',
    o.window ?? 1,
    o.windowActive ?? 1,
    120,
    40,
    'zsh',
    o.pane ?? '%0',
    0,
    o.paneActive ?? 1,
    o.panePid ?? 610,
    0,
    o.command ?? 'zsh',
    o.path ?? '/Users/me/project',
    o.title ?? 'host.local',
  ].join(SEP);
}

function clientLine(o: { pid?: number; session?: string; readOnly?: number; flags?: string }) {
  return [
    'C',
    o.pid ?? 650,
    '/dev/ttys004',
    o.session ?? '$0',
    '@0',
    '%0',
    610,
    '/Users/me/project',
    o.readOnly ?? 0,
    o.flags ?? 'attached,focused,UTF-8',
    120,
    41,
    1759480200,
  ].join(SEP);
}

describe('parseServerListing', () => {
  it('reads panes and clients, names exact', () => {
    const listing = parseServerListing(
      `${[
        paneLine({ name: 'café: 1', title: 'build | watch', path: '/Users/me/a b' }),
        clientLine({ readOnly: 1, flags: 'attached,ignore-size,read-only' }),
      ].join('\n')}\n`
    );
    expect(listing.dropped).toBe(0);
    expect(listing.panes).toEqual([
      {
        serverPid: 600,
        sessionId: '$0',
        sessionName: 'café: 1',
        sessionAttached: 1,
        sessionCreated: 1759480000,
        sessionActivity: 1759480100,
        sessionWindows: 1,
        windowId: '@0',
        windowIndex: 1,
        windowActive: true,
        windowWidth: 120,
        windowHeight: 40,
        windowName: 'zsh',
        paneId: '%0',
        paneIndex: 0,
        paneActive: true,
        panePid: 610,
        paneDead: false,
        command: 'zsh',
        path: '/Users/me/a b',
        title: 'build | watch',
      },
    ]);
    expect(listing.clients).toEqual([
      {
        pid: 650,
        tty: '/dev/ttys004',
        sessionId: '$0',
        windowId: '@0',
        paneId: '%0',
        panePid: 610,
        path: '/Users/me/project',
        readOnly: true,
        flags: ['attached', 'ignore-size', 'read-only'],
        width: 120,
        height: 41,
        activity: 1759480200,
      },
    ]);
  });

  it('drops and counts lines without the expected fields', () => {
    const listing = parseServerListing(
      [
        paneLine({ title: `a${SEP}b` }),
        paneLine({ session: 'zero' }),
        `${clientLine({}).slice(0, -12)}`,
        'garbage',
        paneLine({ pane: '%1', panePid: 611 }),
      ].join('\n')
    );
    expect(listing.dropped).toBe(4);
    expect(listing.panes.map((pane) => pane.paneId)).toEqual(['%1']);
  });

  it('leaves out sessions named like shielded ones, and their clients', () => {
    const listing = parseServerListing(
      [
        paneLine({ session: '$4', name: `ut-${UUID}`, pane: '%9' }),
        paneLine({}),
        clientLine({ session: '$4' }),
        clientLine({ pid: 651 }),
      ].join('\n')
    );
    expect(listing.panes.map((pane) => pane.sessionId)).toEqual(['$0']);
    expect(listing.clients.map((client) => client.pid)).toEqual([651]);
    expect(listing.dropped).toBe(0);
  });

  it('asks only what the Mac Sessions runner allows', () => {
    expect(() => assertMacTmuxAllowed(SERVER_LISTING_ARGS)).not.toThrow();
  });
});

describe('socket lookups', () => {
  it('reads lsof’s unix sockets, paths only', () => {
    expect(
      parseLsofUnixSockets(
        [
          'p600',
          'f6',
          `n${DIR}/default`,
          'f7',
          'n->0x1234',
          'f8',
          `n${DIR}/default`,
          'p700',
          'f3',
          'n/tmp/x/s',
        ].join('\n')
      )
    ).toEqual(
      new Map([
        [600, [`${DIR}/default`]],
        [700, ['/tmp/x/s']],
      ])
    );
  });

  it('reads /proc/net/unix for the inodes a process holds', () => {
    const text = [
      'Num       RefCount Protocol Flags    Type St Inode Path',
      '0000000000000000: 00000002 00000000 00010000 0001 01 4242 /tmp/tmux-1000/default',
      '0000000000000000: 00000002 00000000 00010000 0001 01 4343 @abstract',
      '0000000000000000: 00000002 00000000 00010000 0001 01 4444 /tmp/other',
    ].join('\n');
    expect(
      parseProcNetUnix(
        text,
        new Map([
          ['4242', 800],
          ['4343', 800],
        ])
      )
    ).toEqual(new Map([[800, ['/tmp/tmux-1000/default']]]));
  });

  it('puts the socket directory under the real TMUX_TMPDIR', () => {
    expect(tmuxSocketDir(501, { TMUX_TMPDIR: '/nonexistent-vtm' })).toBe(
      '/nonexistent-vtm/tmux-501'
    );
    expect(tmuxSocketDir(501, {})).toBe(path.join(fs.realpathSync('/tmp'), 'tmux-501'));
  });

  it('never runs for real under vitest', () => {
    expect(() => realTmuxDiscoveryDeps()).toThrow(/vitest/);
  });
});

/** A ps line with the extended columns (no terminal unless given). */
const ps = (pid: number, ppid: number, args: string, tty = '??', uid = 501, stat = 'Ss') =>
  `${pid} ${ppid} ${pid} 0 ${tty} ${stat} ${uid} Fri Oct  2 09:00:00 2026 ${args}`;
const START_SEC = Date.UTC(2026, 9, 2, 9, 0, 0) / 1000;

interface Fake {
  deps: TmuxDiscoveryDeps;
  runs: string[];
  lookups: number[][];
  envReads: number[][];
  clock: { now: number };
}

/**
 * Discovery deps over a made-up machine: sockets on disk, which file each is (`ids`, changed
 * when a new server makes its socket at the same path) and what each one answers.
 */
function fake(options: {
  files?: string[];
  answers?: Record<string, string | Error>;
  links?: Record<string, string>;
  lsof?: Record<number, string[]>;
  ids?: Record<string, string>;
  envs?: Record<number, Record<string, string>>;
  envsFail?: boolean;
}): Fake {
  const runs: string[] = [];
  const lookups: number[][] = [];
  const envReads: number[][] = [];
  const clock = { now: 1_000_000 };
  const files = new Set(options.files ?? []);
  const deps: TmuxDiscoveryDeps = {
    uid: 501,
    socketDir: DIR,
    ownShieldSocket: '/Users/me/.untether/control/.shield-tmux',
    listSockets: async (dir) => [...files].filter((file) => path.dirname(file) === dir),
    realpath: async (file) => {
      const real = options.links?.[file] ?? file;
      return files.has(real) ? real : null;
    },
    socketId: async (file) => (files.has(file) ? (options.ids?.[file] ?? `${file}#1`) : null),
    runTmux: async (socket, args) => {
      expect(args).toEqual(SERVER_LISTING_ARGS);
      runs.push(socket);
      const answer = options.answers?.[socket];
      if (answer instanceof Error) throw answer;
      return answer ?? '';
    },
    socketsOf: async (pids) => {
      lookups.push(pids);
      return new Map(pids.map((pid) => [pid, options.lsof?.[pid] ?? []]));
    },
    startingEnvs: async (pids) => {
      envReads.push(pids);
      if (options.envsFail) throw new Error('ps failed');
      return new Map(pids.map((pid) => [pid, new Map(Object.entries(options.envs?.[pid] ?? {}))]));
    },
    now: () => clock.now,
  };
  return { deps, runs, lookups, envReads, clock };
}

const tmuxError = (stderr: string) => Object.assign(new Error('Command failed'), { stderr });

describe('parseProcEnviron', () => {
  it('reads NAME=value entries, keeping an equals sign in the value', () => {
    expect([...parseProcEnviron('CLAUDECODE=1\0A=b=c\0\0junk\0')]).toEqual([
      ['CLAUDECODE', '1'],
      ['A', 'b=c'],
    ]);
  });
});

describe('TmuxServerFinder', () => {
  it('lists the socket directory and the sockets servers name, each real path once', async () => {
    const machine = fake({
      files: [`${DIR}/default`, `${DIR}/work`, '/private/tmp/x/s'],
      links: { '/tmp/x/s': '/private/tmp/x/s' },
      answers: {
        [`${DIR}/default`]: paneLine({ server: 600 }),
        [`${DIR}/work`]: paneLine({ server: 700, panePid: 710 }),
        '/private/tmp/x/s': paneLine({ server: 800, panePid: 810 }),
      },
    });
    const table = parseProcessTable(
      [
        ps(600, 1, 'tmux'),
        ps(700, 1, '/opt/homebrew/bin/tmux -L work new -s w'),
        ps(800, 1, 'tmux -S /tmp/x/s new'),
        ps(650, 520, 'tmux -S /tmp/x/s attach', '16/4', 501, 'S+'),
      ].join('\n')
    );
    const found = await new TmuxServerFinder(machine.deps).discover(table);
    expect([...machine.runs].sort()).toEqual([`${DIR}/default`, `${DIR}/work`, '/private/tmp/x/s']);
    expect(
      found.servers.map(({ pid, label, isDefault, startSec }) => ({
        pid,
        label,
        isDefault,
        startSec,
      }))
    ).toEqual([
      { pid: 600, label: '', isDefault: true, startSec: START_SEC },
      { pid: 700, label: 'work', isDefault: false, startSec: START_SEC },
      { pid: 800, label: 's', isDefault: false, startSec: START_SEC },
    ]);
    expect(found.sockets.get(800)).toBe('/private/tmp/x/s');
    expect(found.warnings).toEqual([]);
    expect(machine.lookups).toEqual([]);
  });

  describe('servers an agent’s tool started', () => {
    const table = parseProcessTable(
      [
        ps(600, 1, 'tmux'),
        ps(700, 1, 'tmux -L agente new -s scratchpad'),
        ps(800, 1, 'tmux -L mio new -s trabajo'),
      ].join('\n')
    );
    const sockets = {
      files: [`${DIR}/default`, `${DIR}/agente`, `${DIR}/mio`],
      answers: {
        [`${DIR}/default`]: paneLine({ server: 600 }),
        [`${DIR}/agente`]: paneLine({ server: 700, panePid: 710 }),
        [`${DIR}/mio`]: paneLine({ server: 800, panePid: 810 }),
      },
    };
    const marks = (found: Awaited<ReturnType<TmuxServerFinder['discover']>>) =>
      Object.fromEntries(found.servers.map((server) => [server.pid, server.agentMarked]));

    it('tells them from the environment they started with', async () => {
      const machine = fake({
        ...sockets,
        envs: { 700: { UNTETHER_TASK_ID: 'abc' }, 800: { PATH: '/bin' } },
      });
      const found = await new TmuxServerFinder(machine.deps).discover(table);
      expect(marks(found)).toEqual({ 600: false, 700: true, 800: false });
      expect(found.warnings).toEqual([]);
    });

    it('reads each server once, as long as it is the same process', async () => {
      const machine = fake({ ...sockets, envs: { 700: { CLAUDECODE: '1' } } });
      const finder = new TmuxServerFinder(machine.deps);
      await finder.discover(table);
      const again = await finder.discover(table);
      expect(machine.envReads).toEqual([[600, 700, 800], []]);
      expect(marks(again)).toEqual({ 600: false, 700: true, 800: false });
    });

    it('shows a server whose environment could not be read, and says the scan is partial', async () => {
      const machine = fake({ ...sockets, envsFail: true });
      const found = await new TmuxServerFinder(machine.deps).discover(table);
      expect(marks(found)).toEqual({ 600: false, 700: false, 800: false });
      expect(found.warnings).toEqual([{ code: 'scan-partial', detail: 'tmux' }]);
    });

    it('does not warn about one that can no longer be listed', async () => {
      const machine = fake({
        lsof: { 700: [`${DIR}/agente`], 800: [`${DIR}/mio`] },
        envs: { 700: { CLAUDECODE: '1' } },
      });
      const found = await new TmuxServerFinder(machine.deps).discover(
        parseProcessTable(
          [ps(700, 1, '/usr/bin/tmux -D'), ps(800, 1, '/usr/bin/tmux -D')].join('\n')
        )
      );
      expect(found.unlisted.map(({ pid, agentMarked }) => [pid, agentMarked])).toEqual([
        [700, true],
        [800, false],
      ]);
      expect(found.warnings).toEqual([{ code: 'tmux-socket-missing', ref: `800-${START_SEC}` }]);
    });
  });

  it('never lists a shield server, of this instance or another', async () => {
    const machine = fake({
      files: [
        `${DIR}/.shield-tmux`,
        `${DIR}/untether-0123456789ab`,
        '/Users/me/.untether-qa/control/.shield-tmux',
      ],
    });
    const table = parseProcessTable(
      [
        ps(900, 1, 'tmux -S /Users/me/.untether-qa/control/.shield-tmux -D'),
        ps(910, 1, 'tmux -L untether-0123456789ab new-session -d'),
      ].join('\n')
    );
    const found = await new TmuxServerFinder(machine.deps).discover(table);
    expect(machine.runs).toEqual([]);
    expect(machine.lookups).toEqual([]);
    expect(found.sockets.get(900)).toBe('/Users/me/.untether-qa/control/.shield-tmux');
    expect(found.servers).toEqual([]);
  });

  it('skips a socket whose server is gone for 30 s', async () => {
    const gone = `${DIR}/old`;
    const machine = fake({
      files: [gone],
      answers: { [gone]: tmuxError(`error connecting to ${gone} (Connection refused)`) },
    });
    const finder = new TmuxServerFinder(machine.deps);
    const table = parseProcessTable('');
    expect((await finder.discover(table)).warnings).toEqual([]);
    machine.clock.now += STALE_SOCKET_MS - 1;
    await finder.discover(table);
    expect(machine.runs).toEqual([gone]);
    machine.clock.now += 2;
    await finder.discover(table);
    expect(machine.runs).toEqual([gone, gone]);
  });

  it('lists a new server at a stale socket’s path at once: its socket is a new file', async () => {
    const socket = `${DIR}/default`;
    const ids: Record<string, string> = { [socket]: 'old' };
    const answers: Record<string, string | Error> = {
      [socket]: tmuxError(`no server running on ${socket}`),
    };
    const machine = fake({ files: [socket], answers, ids });
    const finder = new TmuxServerFinder(machine.deps);
    await finder.discover(parseProcessTable(''));
    machine.clock.now += 1_000;
    await finder.discover(parseProcessTable(''));
    expect(machine.runs).toEqual([socket]);

    // `tmux` removed the dead socket, and the server it started made its own there.
    ids[socket] = 'new';
    answers[socket] = paneLine({ server: 600 });
    machine.clock.now += 10_000;
    const found = await finder.discover(parseProcessTable(ps(600, 1, 'tmux')));
    expect(machine.runs).toEqual([socket, socket]);
    expect(found.servers.map((server) => server.pid)).toEqual([600]);
    expect(found.unlisted).toEqual([]);
    expect(found.warnings).toEqual([]);
  });

  it('finds the socket of a server nothing else reached, and says when it was deleted', async () => {
    const machine = fake({ lsof: { 600: [`${DIR}/default`] } });
    const table = parseProcessTable(ps(600, 1, 'tmux new -s 0'));
    const found = await new TmuxServerFinder(machine.deps).discover(table);
    expect(machine.lookups).toEqual([[600]]);
    expect(found.unlisted).toEqual([
      {
        pid: 600,
        startSec: START_SEC,
        socketPath: `${DIR}/default`,
        label: '',
        isDefault: true,
        agentMarked: false,
        problem: 'tmux-socket-missing',
      },
    ]);
    expect(found.warnings).toEqual([{ code: 'tmux-socket-missing', ref: `600-${START_SEC}` }]);
    expect(found.sockets.get(600)).toBe(`${DIR}/default`);
  });

  // 2026-10-31: under load lsof timed out, its '' read as "no sockets" and the warning vanished.
  it('a failed socket lookup makes the scan partial, never silent', async () => {
    const machine = fake({});
    machine.deps.socketsOf = async () => {
      throw Object.assign(new Error('Command failed: lsof'), { killed: true, signal: 'SIGTERM' });
    };
    const table = parseProcessTable(ps(600, 1, 'tmux new -s 0'));
    const found = await new TmuxServerFinder(machine.deps).discover(table);
    expect(found.unlisted).toEqual([]);
    expect(found.warnings).toEqual([{ code: 'scan-partial', detail: 'tmux' }]);
  });

  it('says a server is unreachable when its socket is there but does not answer', async () => {
    const socket = `${DIR}/default`;
    const machine = fake({
      files: [socket],
      answers: { [socket]: tmuxError('server version is too old for client\nmore') },
      lsof: { 600: [socket] },
    });
    const found = await new TmuxServerFinder(machine.deps).discover(
      parseProcessTable(ps(600, 1, 'tmux'))
    );
    expect(found.warnings).toEqual([
      {
        code: 'tmux-unreachable',
        ref: `600-${START_SEC}`,
        detail: 'server version is too old for client',
      },
    ]);
    expect(found.unlisted.map((server) => server.problem)).toEqual(['tmux-unreachable']);
  });

  it('lists a socket outside the usual places once lsof names it', async () => {
    const elsewhere = '/private/var/folders/x/tmux-501/default';
    const machine = fake({
      files: [elsewhere],
      answers: { [elsewhere]: paneLine({ server: 600 }) },
      lsof: { 600: [elsewhere] },
    });
    const found = await new TmuxServerFinder(machine.deps).discover(
      parseProcessTable(ps(600, 1, 'tmux'))
    );
    expect(found.servers.map((server) => [server.pid, server.label])).toEqual([[600, 'default']]);
    expect(found.warnings).toEqual([]);
  });

  it('is quiet about a server with no sessions, and about other users’ servers', async () => {
    const socket = `${DIR}/default`;
    const machine = fake({ files: [socket], answers: { [socket]: '' }, lsof: { 600: [socket] } });
    const found = await new TmuxServerFinder(machine.deps).discover(
      parseProcessTable([ps(600, 1, 'tmux'), ps(700, 1, 'tmux -L theirs', '??', 502)].join('\n'))
    );
    expect(found.servers).toEqual([]);
    expect(found.unlisted).toEqual([]);
    expect(found.warnings).toEqual([]);
    expect(machine.lookups).toEqual([[600]]);
  });

  it('waits for a server the table doesn’t have yet, and counts lines it couldn’t read', async () => {
    const socket = `${DIR}/default`;
    const machine = fake({
      files: [socket],
      answers: { [socket]: [paneLine({ server: 4242 }), 'P~|ut|~broken'].join('\n') },
    });
    const found = await new TmuxServerFinder(machine.deps).discover(parseProcessTable(''));
    expect(found.servers).toEqual([]);
    expect(found.warnings).toEqual([{ code: 'scan-partial', detail: 'tmux' }]);
  });
});

const realTmux = findTmuxBinary();

/** Only these processes of a real `ps`: a test never looks at the developer's own tmux. */
function only(table: ProcessTable, pids: Set<number>): ProcessTable {
  const keep = <V>(map: Map<number, V>) => new Map([...map].filter(([pid]) => pids.has(pid)));
  return {
    children: new Map(
      [...table.children]
        .filter(([pid]) => pids.has(pid))
        .map(([pid, children]) => [pid, children.filter((child) => pids.has(child))])
    ),
    starts: keep(table.starts),
    args: keep(table.args),
    procs: keep(table.procs),
    extended: table.extended,
  };
}

/** Private tmux servers in a short temp dir (TMUX_TMPDIR), never the user's. */
describe.skipIf(!realTmux)('TmuxServerFinder on private tmux servers', () => {
  const tmuxBin = realTmux as string;
  let dir: string;
  let socketDir: string;
  let env: Record<string, string>;
  const started = new Map<string, number>();
  const leftovers: number[] = [];

  const tmux = (label: string, ...args: string[]) =>
    execFileSync(tmuxBin, ['-u', '-L', label, '-f', '/dev/null', ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const startServer = (label: string, session: string) => {
    tmux(
      label,
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      dir,
      '-x',
      '100',
      '-y',
      '30',
      'sleep 120'
    );
    const pid = Number(tmux(label, 'list-panes', '-a', '-F', '#{pid}').trim().split('\n')[0]);
    started.set(label, pid);
    return pid;
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(() => {
    dir = fs.mkdtempSync('/tmp/vtm-');
    // No LANG, LC_* or TMUX: -u alone must keep "café: 1".
    env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, TMUX_TMPDIR: dir };
    socketDir = tmuxSocketDir(process.getuid?.() ?? 0, env);
  });

  afterAll(async () => {
    for (const label of started.keys()) {
      try {
        tmux(label, 'kill-server');
      } catch {
        // killed by the test, or its socket is gone
      }
    }
    for (const pid of [...started.values(), ...leftovers]) {
      if (alive(pid)) process.kill(pid, 'SIGTERM');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Only what this test made: the sockets left behind, their directory, then its own.
    for (const label of started.keys()) fs.rmSync(path.join(socketDir, label), { force: true });
    if (fs.existsSync(socketDir)) fs.rmdirSync(socketDir);
    fs.rmdirSync(dir);
  });

  it('lists names exact, skips stale and shield sockets, and tells a deleted socket', async () => {
    const main = startServer('default', 'café: 1');
    tmux('default', 'new-window', '-t', '$0', '-c', dir, 'sleep 120');
    tmux('default', 'new-session', '-d', '-s', 'a.b', '-c', dir, 'sleep 120');
    tmux('default', 'select-pane', '-t', '$1', '-T', 'build | watch');
    // A shield socket in the same directory: never listed.
    const shield = startServer('.shield-tmux', 'shielded');
    // A server killed outright leaves its socket behind.
    const stale = startServer('stale', 's');
    leftovers.push(
      ...tmux('stale', 'list-panes', '-a', '-F', '#{pane_pid}').trim().split('\n').map(Number)
    );
    process.kill(stale, 'SIGKILL');
    // A server whose socket was deleted while it runs.
    const orphan = startServer('orphan', 'o');
    fs.unlinkSync(path.join(socketDir, 'orphan'));
    for (let i = 0; i < 50 && alive(stale); i++) await new Promise((r) => setTimeout(r, 20));

    const full = await readProcessTable();
    const mine = new Set([main, shield, orphan].flatMap((pid) => descendants(full, pid)));
    const table = only(full, mine);
    expect(ttyName(table, main)).toBeNull();

    const runs: string[] = [];
    const lookups: number[][] = [];
    const finder = new TmuxServerFinder({
      uid: process.getuid?.() ?? 0,
      socketDir,
      ownShieldSocket: null,
      listSockets: listSocketFiles,
      realpath: async (file) => fs.promises.realpath(file).catch(() => null),
      socketId: socketFileId,
      runTmux: (socket, args) => {
        runs.push(path.basename(socket));
        return runMacTmux(socket, args, { tmuxBin, env });
      },
      socketsOf: (pids) => {
        lookups.push(pids);
        return unixSocketsOf(pids);
      },
      startingEnvs: async () => new Map(),
      now: Date.now,
    });
    const found = await finder.discover(table);

    expect(runs.sort()).toEqual(['default', 'stale']);
    expect(found.servers).toHaveLength(1);
    const [server] = found.servers;
    expect(server).toMatchObject({ pid: main, label: '', isDefault: true });
    expect(server.socketPath).toBe(path.join(socketDir, 'default'));
    const sessions = [
      ...new Set(server.panes.map((pane) => `${pane.sessionId} ${pane.sessionName}`)),
    ];
    expect(sessions.sort()).toEqual(['$0 café: 1', '$1 a.b']);
    expect(server.panes.find((pane) => pane.sessionId === '$0')).toMatchObject({
      paneId: '%0',
      sessionWindows: 2,
      path: fs.realpathSync(dir),
    });
    expect(server.panes.find((pane) => pane.sessionId === '$1')?.title).toBe('build | watch');
    for (const pane of server.panes) expect(alive(pane.panePid), pane.paneId).toBe(true);

    // The shield names its socket; only the orphan needed lsof, and its socket is gone.
    expect(lookups).toEqual([[orphan]]);
    expect(found.unlisted).toMatchObject([
      { pid: orphan, problem: 'tmux-socket-missing', label: 'orphan' },
    ]);
    expect(found.warnings).toEqual([
      { code: 'tmux-socket-missing', ref: `${orphan}-${found.unlisted[0].startSec}` },
    ]);

    // The stale socket is not asked again for a while.
    runs.length = 0;
    await finder.discover(table);
    expect(runs).toEqual(['default']);

    const gone = await runMacTmux(path.join(socketDir, 'stale'), ['list-panes', '-a'], {
      tmuxBin,
      env,
    }).catch((error: unknown) => error);
    expect(isNoTmuxServer(gone)).toBe(true);

    // A new server at that path within the 30 s: tmux made a new socket file, listed at once.
    const restarted = startServer('stale', 's2');
    const now = await readProcessTable();
    runs.length = 0;
    const again = await finder.discover(
      only(now, new Set([main, shield, orphan, restarted].flatMap((pid) => descendants(now, pid))))
    );
    expect(runs.sort()).toEqual(['default', 'stale']);
    expect(again.servers.map((server) => server.pid).sort()).toEqual([main, restarted].sort());
    expect(again.warnings.map((warning) => warning.code)).toEqual(['tmux-socket-missing']);
    // 2026-11-02: about 0.5 s idle, but a dozen synchronous tmux runs on real servers passed
    // the default 10 s with load average 178 during a task check.
  }, 60_000);
});

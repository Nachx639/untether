import { spawn } from 'child_process';
import * as fs from 'fs';
import type * as Pty from 'node-pty';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { runGuardHook } from './task-guard-hook.js';
import {
  inShellGroup,
  listMarkedProcesses,
  lstartMs,
  type MarkedProcess,
  markerOf,
  PS_ROW_RE,
  pruneShellGroups,
  type ReapableTask,
  readProcessMarks,
  readShellGroups,
  recordShellGroup,
  SHELL_GROUPS_DIR,
  TASK_MARKER_VAR,
  TaskOrphanReaper,
} from './task-processes.js';

describe('PS_ROW_RE', () => {
  it('takes the command without the padding ps puts after lstart (2026-11-02: empty names)', () => {
    const match = PS_ROW_RE.exec('40281     1 40281 Mon Nov  2 14:50:12 2026     zsh -c sleep 60');
    expect(match?.[5]).toBe('zsh -c sleep 60');
  });
});

describe('markerOf', () => {
  it('reads the marker from what -E added after the command', () => {
    expect(markerOf('yes HOME=/h UNTETHER_TASK_ID=abc-1 PATH=/bin', 'yes')).toBe('abc-1');
    expect(markerOf('yes HOME=/h PATH=/bin', 'yes')).toBeNull();
  });

  it('a hidden environment (nothing added) is undefined, not "none"', () => {
    expect(markerOf('/bin/sleep 20', '/bin/sleep 20')).toBeUndefined();
  });

  it('the command line itself never counts as the marker', () => {
    expect(markerOf('grep UNTETHER_TASK_ID=abc HOME=/h', 'grep UNTETHER_TASK_ID=abc')).toBeNull();
  });
});

describe('shell groups', () => {
  const groups = new Map([[690, 1_000_000]]);
  it('a process of a recorded group, started after its shell, with the leader gone', () => {
    expect(inShellGroup({ pgid: 690, start: 1_005_000 }, groups, undefined)).toBe(true);
  });
  it('not: an unrecorded group, an earlier start, no start, or a leader that is another process', () => {
    expect(inShellGroup({ pgid: 691, start: 1_005_000 }, groups, undefined)).toBe(false);
    expect(inShellGroup({ pgid: 690, start: 900_000 }, groups, undefined)).toBe(false);
    expect(inShellGroup({ pgid: 690 }, groups, undefined)).toBe(false);
    // pid 690 reused later by a new leader: started at another time.
    expect(inShellGroup({ pgid: 690, start: 2_000_000 }, groups, { start: 1_900_000 })).toBe(false);
    // The original shell still alive.
    expect(inShellGroup({ pgid: 690, start: 1_005_000 }, groups, { start: 1_000_500 })).toBe(true);
  });
  it('a reused pid gets a new record: the file is made anew, not kept with its old birth', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-groups-'));
    try {
      const file = path.join(dir, '4242');
      fs.writeFileSync(file, '');
      // An old shell's record (setting an earlier mtime moves macOS's birth back too).
      fs.utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
      const old = readShellGroups(dir).get(4242) ?? 0;
      expect(old).toBeLessThan(Date.now() - 86_400_000);
      // A new shell with that pid runs the record line ("$$" is 4242).
      const line = recordShellGroup(dir).replaceAll('"$$"', '"4242"');
      await new Promise<void>((resolve) =>
        spawn('/bin/sh', ['-c', line]).on('exit', () => resolve())
      );
      const since = readShellGroups(dir).get(4242) ?? 0;
      expect(since).toBeGreaterThan(Date.now() - 60_000);
      // So its old orphans are not taken for the new shell's, and the new ones are.
      expect(inShellGroup({ pgid: 4242, start: old + 1000 }, readShellGroups(dir), undefined)).toBe(
        false
      );
      expect(inShellGroup({ pgid: 4242, start: Date.now() }, readShellGroups(dir), undefined)).toBe(
        true
      );
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });

  it('records of groups with nothing left go; groups in use and just-made records stay', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-groups-'));
    try {
      for (const name of ['10', '11', '12']) fs.writeFileSync(path.join(dir, name), '');
      const now = Date.now();
      const groups = new Map([
        [10, now - 60_000], // empty: goes
        [11, now - 60_000], // a process still in it: stays
        [12, now], // made after the table was read: stays
      ]);
      expect(pruneShellGroups(dir, groups, new Set([11]), now)).toEqual([10]);
      expect(fs.readdirSync(dir).sort()).toEqual(['11', '12']);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });

  it('ps lstart reads as local time', () => {
    expect(lstartMs('Mon Nov  2 15:36:48 2026')).toBe(new Date(2026, 10, 2, 15, 36, 48).getTime());
    expect(lstartMs('nonsense')).toBeUndefined();
  });
  it('the record survives a quote in the folder and names the shell', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-groups-'q-"));
    try {
      const out = spawn('/bin/sh', ['-c', `${recordShellGroup(dir)}echo $$`]);
      return new Promise<void>((resolve, reject) => {
        let text = '';
        out.stdout.on('data', (chunk) => {
          text += chunk;
        });
        out.on('exit', () => {
          try {
            expect([...readShellGroups(dir).keys()]).toEqual([Number(text.trim())]);
            resolve();
          } catch (error) {
            reject(error);
          } finally {
            fs.rmSync(dir, RM_TEST_DIR);
          }
        });
      });
    } catch (error) {
      fs.rmSync(dir, RM_TEST_DIR);
      throw error;
    }
  });
});

describe('TaskOrphanReaper', () => {
  const tasks: ReapableTask[] = [
    {
      id: 'done-1',
      name: 'load',
      state: 'merged',
      sessionId: 's1',
      isolation: 'worktree',
      worktreePath: '/w/done-1',
    },
    {
      id: 'open-1',
      state: 'working',
      sessionId: 's2',
      isolation: 'worktree',
      worktreePath: '/w/open-1',
    },
    { id: 'lingering', state: 'done', sessionId: 's3' },
    { id: 'failed-1', state: 'failed', sessionId: 's4' },
  ];
  const running = new Set(['s2', 's3']);
  const base: MarkedProcess[] = [
    { pid: 10, ppid: 1, command: 'node server', marker: null },
    { pid: 11, ppid: 10, command: 'node server-child', marker: 'done-1' }, // the server's line
    { pid: 700, ppid: 1, command: 'yes', marker: 'done-1' },
    { pid: 701, ppid: 1, command: 'yes', marker: 'open-1' },
    { pid: 702, ppid: 1, command: 'node x', marker: 'lingering' },
    { pid: 703, ppid: 1, command: 'node y', marker: 'failed-1' },
    { pid: 704, ppid: 1, command: 'node z', marker: 'unknown-task' },
    { pid: 705, ppid: 1, command: 'node users', marker: null },
    { pid: 706, ppid: 1, command: '/bin/sleep 9', marker: undefined },
    { pid: 707, ppid: 1, command: '/bin/sleep 9', marker: undefined },
    { pid: 708, ppid: 700, command: '/bin/sleep 9', marker: undefined },
  ];
  const cwds = new Map([
    [706, '/w/done-1/web'],
    [707, '/Users/u/elsewhere'],
    [708, '/w/done-1'],
  ]);

  function reaper(table: () => MarkedProcess[], signals: Array<[number, string]>) {
    return new TaskOrphanReaper({
      tasks: () => tasks,
      sessionStatus: (id) => (running.has(id) ? 'running' : 'exited'),
      list: async () => table(),
      cwds: async (pids) => new Map(pids.filter((p) => cwds.has(p)).map((p) => [p, cwds.get(p)!])),
      signal: (pid, sig) => signals.push([pid, sig]),
      sleep: async () => undefined,
      selfPid: 11,
    });
  }

  it('ends only marked processes of closed tasks, never the unmarked or open ones', async () => {
    const signals: Array<[number, string]> = [];
    // After TERM: 700 is gone, 703 still runs.
    let round = 0;
    const r = reaper(() => (round++ === 0 ? base : base.filter((e) => e.pid !== 700)), signals);
    const kills = await r.reap();
    const termed = signals.filter(([, sig]) => sig === 'SIGTERM').map(([pid]) => pid);
    expect(termed.sort()).toEqual([700, 703]);
    expect(signals.filter(([, sig]) => sig === 'SIGKILL').map(([pid]) => pid)).toEqual([703]);
    // Never: the open task's, a lingering session's, an unknown task's, the user's, the
    // server's own line, and no hidden environment at all (a folder proves nothing).
    for (const pid of [10, 11, 701, 702, 704, 705, 706, 707, 708]) {
      expect(signals.some(([p]) => p === pid)).toBe(false);
    }
    expect(kills.find((k) => k.pid === 700)).toMatchObject({ taskId: 'done-1', taskName: 'load' });
    expect(r.recent()).toHaveLength(kills.length);
    // The hidden one reparented in the closed worktree is only told.
    expect(r.suspects()).toEqual([
      {
        taskId: 'done-1',
        taskName: 'load',
        pid: 706,
        command: '/bin/sleep 9',
        cwd: '/w/done-1/web',
      },
    ]);
  });

  it('a reparented hidden process in a closed worktree is ended only with proof it started during the task', async () => {
    const signals: Array<[number, string]> = [];
    const made = Date.parse('2026-11-11T22:00:00Z');
    const task: ReapableTask = {
      id: 'wt',
      state: 'merged',
      isolation: 'worktree',
      worktreePath: '/w/wt',
      createdAt: new Date(made).toISOString(),
    };
    const table: MarkedProcess[] = [
      { pid: 900, ppid: 1, start: made + 60_000, command: 'zsh -c sleep 60', marker: undefined },
      { pid: 901, ppid: 1, start: made - 60_000, command: '/bin/sleep 9', marker: undefined }, // older
      { pid: 902, ppid: 1, command: '/bin/sleep 9', marker: undefined }, // no start time
      { pid: 903, ppid: 1, start: made + 60_000, command: '/bin/sleep 9', marker: undefined }, // elsewhere
      { pid: 904, ppid: 900, start: made + 60_000, command: '/bin/sleep 9', marker: undefined }, // not reparented
      { pid: 905, ppid: 1, start: made + 60_000, command: '/x/tmux -L s new', marker: undefined }, // shield
      { pid: 906, ppid: 1, start: made + 60_000, command: 'node s', marker: undefined }, // the server
    ];
    const cwdOf = new Map([
      [900, '/w/wt/web'],
      [901, '/w/wt'],
      [902, '/w/wt'],
      [903, '/w/other'],
      [904, '/w/wt'],
      [905, '/w/wt'],
      [906, '/w/wt'],
    ]);
    const r = new TaskOrphanReaper({
      tasks: () => [task],
      sessionStatus: () => undefined,
      list: async () => table.filter((e) => !signals.some(([p]) => p === e.pid)),
      cwds: async (pids) =>
        new Map(pids.filter((p) => cwdOf.has(p)).map((p) => [p, cwdOf.get(p)!])),
      signal: (pid, sig) => signals.push([pid, sig]),
      sleep: async () => undefined,
      selfPid: 906,
    });
    const kills = await r.reap();
    expect(kills.map((k) => [k.pid, k.by, k.signal])).toEqual([[900, 'cwd', 'TERM']]);
    expect(signals).toEqual([[900, 'SIGTERM']]);
    expect(r.suspects().map((s) => s.pid)).toEqual([901, 902]);
  });

  it('a hidden process in a shell group the closed task recorded is ended; one of another group is not', async () => {
    const signals: Array<[number, string]> = [];
    const table: MarkedProcess[] = [
      { pid: 800, ppid: 1, pgid: 790, start: 1_005_000, command: 'yes', marker: undefined },
      { pid: 801, ppid: 1, pgid: 791, start: 1_005_000, command: 'yes', marker: undefined },
      // Its leader alive, read, and not the task's: not ended.
      { pid: 802, ppid: 1, pgid: 792, start: 1_005_000, command: 'yes', marker: undefined },
      { pid: 792, ppid: 1, pgid: 792, start: 1_000_000, command: 'zsh', marker: null },
    ];
    const pruned: Array<[string, number[]]> = [];
    const r = new TaskOrphanReaper({
      tasks: () => tasks,
      sessionStatus: (id) => (running.has(id) ? 'running' : 'exited'),
      list: async () => table,
      signal: (pid, sig) => signals.push([pid, sig]),
      sleep: async () => undefined,
      selfPid: 11,
      shellGroups: (taskId) =>
        taskId === 'done-1'
          ? new Map([
              [790, 1_000_000],
              [792, 1_000_000],
              [793, 1_000_000],
            ])
          : new Map(),
      pruneShellGroups: (taskId, groups, inUse) =>
        pruned.push([taskId, [...groups.keys()].filter((pgid) => !inUse.has(pgid))]),
    });
    const kills = await r.reap();
    expect(kills.filter((k) => k.signal === 'TERM').map((k) => [k.pid, k.by])).toEqual([
      [800, 'group'],
    ]);
    expect(signals.some(([p]) => p === 801 || p === 802)).toBe(false);
    // 793 has nothing left: its record goes (its pid may be reused).
    expect(pruned).toEqual([['done-1', [793]]]);
  });

  it('a pid reused by another process during the grace is not killed', async () => {
    const signals: Array<[number, string]> = [];
    let round = 0;
    const r = reaper(
      () =>
        round++ === 0
          ? base
          : base.map((e) => (e.pid === 703 ? { ...e, command: 'other', marker: null } : e)),
      signals
    );
    await r.reap();
    expect(signals).not.toContainEqual([703, 'SIGKILL']);
  });

  it('nothing closed: the process table is not even read', async () => {
    let read = 0;
    const r = new TaskOrphanReaper({
      tasks: () => [tasks[1]],
      sessionStatus: () => 'running',
      list: async () => {
        read++;
        return base;
      },
    });
    expect(await r.reap()).toEqual([]);
    expect(read).toBe(0);
  });
});

// Real processes: a task's child reparented to launchd keeps the marker; the reaper ends it and
// leaves an unmarked twin alone.
describe.skipIf(process.platform !== 'darwin')('marked processes on this machine', () => {
  const started: number[] = [];
  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  });

  /** Starts `program` from a shell that exits at once (so it is reparented), returns its pid. */
  async function orphan(
    program: string,
    env: Record<string, string>,
    cwd: string
  ): Promise<number> {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', `${program} >/dev/null 2>&1 & echo $!`], {
        cwd,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let text = '';
      child.stdout.on('data', (chunk) => {
        text += chunk;
      });
      child.on('error', reject);
      child.on('exit', () => resolve(text));
    });
    const pid = Number(out.trim());
    started.push(pid);
    // Wait until it runs as itself and launchd adopted it (a deadline, never a fixed sleep).
    const deadline = Date.now() + 10_000;
    for (;;) {
      const entry = (await listMarkedProcesses()).find((e) => e.pid === pid);
      if (entry && entry.ppid === 1 && !entry.command.startsWith('/bin/sh')) return pid;
      if (Date.now() > deadline)
        throw new Error(`process ${pid} not adopted: ${JSON.stringify(entry)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * The reaper's grace wait between TERM and KILL, ended by the event it waits for: `pid`
   * gone (deadline 10 s). A fixed 1-3 s grace cost those seconds each run (2026-11-02); if
   * TERM did not end it, the wait runs out and the reaper's KILL still shows in its kills.
   */
  const untilGone = (pid: () => number) => async (): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid(), 0);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it('the guard reads the marker of a reparented child, and the reaper ends only it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-orphans-'));
    try {
      const program = `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`;
      const taskId = `test-${process.pid}-${Date.now()}`;
      const marked = await orphan(program, { [TASK_MARKER_VAR]: taskId }, dir);
      const plain = await orphan(program, {}, dir);
      expect(readProcessMarks([marked, plain])).toEqual(
        new Map([
          [marked, { marker: taskId }],
          [plain, { marker: null }],
        ])
      );
      const r = new TaskOrphanReaper({
        tasks: () => [{ id: taskId, state: 'discarded' }],
        sessionStatus: () => undefined,
        sleep: untilGone(() => marked),
      });
      const kills = await r.reap();
      expect(kills.map((k) => k.pid)).toEqual([marked]);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          process.kill(marked, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(() => process.kill(marked, 0)).toThrow();
      expect(() => process.kill(plain, 0)).not.toThrow();
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  }, 30_000);

  it('a platform binary hides its environment: unknown, never taken for a task’s', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-orphans-')));
    try {
      const pid = await orphan('/bin/sleep 60', { [TASK_MARKER_VAR]: 'test-hidden' }, dir);
      const mark = readProcessMarks([pid]).get(pid);
      // Hidden on macOS for /bin binaries (undefined); where it is shown, the marker is read.
      expect([undefined, 'test-hidden']).toContain(mark?.marker);
      const r = new TaskOrphanReaper({
        tasks: () => [
          { id: 'test-hidden', state: 'discarded', isolation: 'worktree', worktreePath: dir },
        ],
        sessionStatus: () => undefined,
        graceMs: 500,
      });
      const kills = await r.reap();
      if (mark?.marker === undefined) {
        expect(kills).toEqual([]);
        expect(() => process.kill(pid, 0)).not.toThrow();
        expect(r.suspects().map((s) => s.pid)).toEqual([pid]);
      } else {
        expect(kills.map((k) => k.pid)).toContain(pid);
      }
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  }, 30_000);

  // 2026-11-11: `zsh -c sleep 60` of a task's Bash tool outlived the task; the doctor asked to
  // end it by hand. Reparented, started after the task was made and working inside its folder:
  // ended. Another folder, an open task, or no proof it came after the task: not.
  it('a hidden reparented process working in a closed task’s folder, started after it: ended', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-cwd-')));
    try {
      const worktree = path.join(root, 'worktree');
      const web = path.join(worktree, 'web');
      const elsewhere = path.join(root, 'elsewhere');
      const openTree = path.join(root, 'open');
      for (const dir of [web, elsewhere, openTree]) fs.mkdirSync(dir, { recursive: true });
      const sleeper = (dir: string) => orphan('/bin/sleep 60', {}, dir);
      const inside = await sleeper(web);
      const outside = await sleeper(elsewhere);
      const ofOpen = await sleeper(openTree);
      const mark = readProcessMarks([inside]).get(inside)?.marker;
      // macOS hides the environment of /bin/sleep; where it shows, the marker path is another test's.
      if (mark !== undefined) return;
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
      const closed = (id: string, createdAt: string, dir: string): ReapableTask => ({
        id,
        state: 'merged',
        isolation: 'worktree',
        worktreePath: dir,
        createdAt,
      });
      const r = new TaskOrphanReaper({
        tasks: () => [
          closed('test-cwd-closed', hourAgo, worktree),
          { ...closed('test-cwd-open', hourAgo, openTree), state: 'working', sessionId: 'live' },
        ],
        sessionStatus: (id) => (id === 'live' ? 'running' : undefined),
        sleep: untilGone(() => inside),
      });
      const kills = await r.reap();
      expect(kills.filter((k) => k.signal === 'TERM').map((k) => [k.pid, k.by])).toEqual([
        [inside, 'cwd'],
      ]);
      const gone = Date.now() + 5000;
      while (Date.now() < gone) {
        try {
          process.kill(inside, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(() => process.kill(inside, 0)).toThrow();
      expect(() => process.kill(outside, 0)).not.toThrow();
      expect(() => process.kill(ofOpen, 0)).not.toThrow();
      expect(kills.some((k) => k.pid === outside || k.pid === ofOpen)).toBe(false);
    } finally {
      fs.rmSync(root, RM_TEST_DIR);
    }
  }, 60_000);

  // 2026-11-02: the bakery shape for real. A shell on its own terminal (node-pty, as a task's
  // Bash shell leads its own group) records its group, starts `yes` (a platform binary: its
  // environment is hidden) and exits: `yes` is reparented to launchd. The guard lets the task
  // kill it and the reaper ends it once the task closed; a twin from a shell that recorded
  // nothing stays blocked and alive.
  it('a reparented platform binary of a recorded shell group: killable and reaped', async () => {
    const pty = await vi.importActual<typeof Pty>('node-pty');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-groups-')));
    const groupsDir = path.join(dir, SHELL_GROUPS_DIR);
    fs.mkdirSync(groupsDir);
    const taskId = `test-${process.pid}-${Date.now()}`;
    const policy = path.join(dir, 'policy.json');
    fs.writeFileSync(policy, JSON.stringify({ taskId, root: dir, home: os.homedir() }));
    /** A shell on its own terminal starts `yes` and exits; returns yes's pid. */
    const start = (record: boolean) =>
      new Promise<number>((resolve, reject) => {
        // The session leader's exit hangs up its terminal: yes ignores it, as nohup would.
        const script = `${record ? recordShellGroup(groupsDir) : ''}trap '' HUP; /usr/bin/yes >/dev/null 2>&1 & echo "pid=$!"`;
        const term = pty.spawn('/bin/sh', ['-c', script], {
          cols: 80,
          rows: 24,
          env: { PATH: '/usr/bin:/bin', [TASK_MARKER_VAR]: taskId },
        });
        let text = '';
        term.onData((data) => {
          text += data;
        });
        term.onExit(() => {
          const match = /pid=(\d+)/.exec(text);
          if (match) {
            started.push(Number(match[1]));
            resolve(Number(match[1]));
          } else reject(new Error(`no pid: ${JSON.stringify(text)}`));
        });
      });
    try {
      const own = await start(true);
      const twin = await start(false);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const table = await listMarkedProcesses();
        const rows = [own, twin].map((pid) => table.find((e) => e.pid === pid));
        if (rows.every((e) => e && e.ppid === 1)) {
          // The bakery premise: the environment of /usr/bin/yes cannot be read.
          for (const row of rows) expect(row?.marker).toBeUndefined();
          expect(readShellGroups(groupsDir).has(rows[0]?.pgid ?? -1)).toBe(true);
          break;
        }
        if (Date.now() > deadline) throw new Error(`not adopted: ${JSON.stringify(rows)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const kill = (pid: number) =>
        runGuardHook(
          policy,
          JSON.stringify({ tool_name: 'Bash', tool_input: { command: `kill ${pid}` }, cwd: dir }),
          () => {},
          () => {}
        );
      expect(kill(own)).toBe(0);
      expect(kill(twin)).toBe(2);
      const r = new TaskOrphanReaper({
        tasks: () => [{ id: taskId, state: 'discarded' }],
        sessionStatus: () => undefined,
        sleep: untilGone(() => own),
        shellGroups: () => readShellGroups(groupsDir),
      });
      const kills = await r.reap();
      expect(kills.map((k) => [k.pid, k.by])).toEqual([[own, 'group']]);
      const gone = Date.now() + 5000;
      while (Date.now() < gone) {
        try {
          process.kill(own, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(() => process.kill(own, 0)).toThrow();
      expect(() => process.kill(twin, 0)).not.toThrow();
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  }, 60_000);
});

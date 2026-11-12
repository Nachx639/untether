import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { findTmuxBinary, shieldSocketArgs } from '../../server/services/shielded-tmux.js';
import { writeTestMarker } from '../../server/services/stray-tmux.js';
import { RM_TEST_DIR } from './rm-test-dir.js';
import {
  findRunTmuxServers,
  leftTestDirs,
  pathForms,
  type ReapDeps,
  reapRunTmuxServers,
  reapRunTmuxServersNow,
  runProcesses,
  sweepDeadTestRuns,
  tmuxServersUnder,
  watchRun,
} from './run-teardown.js';
import { stopTestShieldServer } from './shield-teardown.js';

describe('tmuxServersUnder', () => {
  const ps = [
    '  101 /opt/homebrew/bin/tmux -S /tmp/ut-test-aaa/ut/4196/.shield-tmux start-server ; set-option -g status off',
    '  102 tmux -S /tmp/ut-test-bbb/ut/c3e5/.shield-tmux start-server',
    '  103 /opt/homebrew/bin/tmux -S /Users/me/.untether/control/.shield-tmux start-server',
    '  104 cat /tmp/ut-test-aaa/ut/4196/.shield-tmux',
    '  105 /opt/homebrew/bin/tmux -L untether-0123456789ab start-server',
    '  106 tmux -S /private/tmp/ut-test-aaa/h-x/tmux-501/default new-session -d',
  ].join('\n');

  it("finds only the tmux servers whose socket is under the run's dir", () => {
    expect(tmuxServersUnder(ps, ['/tmp/ut-test-aaa', '/private/tmp/ut-test-aaa'])).toEqual([
      { pid: 101, socket: '/tmp/ut-test-aaa/ut/4196/.shield-tmux' },
      { pid: 106, socket: '/private/tmp/ut-test-aaa/h-x/tmux-501/default' },
    ]);
  });

  it('never matches a directory that only shares a prefix', () => {
    expect(tmuxServersUnder(ps, ['/tmp/ut-test-a'])).toEqual([]);
  });
});

describe('pathForms', () => {
  it('covers /tmp and /private/tmp spellings', () => {
    expect(pathForms('/tmp/ut-test-gone')).toEqual(
      expect.arrayContaining(['/tmp/ut-test-gone', '/private/tmp/ut-test-gone'])
    );
  });
});

describe('reapRunTmuxServers with fakes', () => {
  it('boots out shield jobs, SIGTERMs, and SIGKILLs what does not exit', async () => {
    const calls: string[] = [];
    let clock = 0;
    const reaped = await reapRunTmuxServers('/tmp/ut-test-zzz', {
      ps: () =>
        '  7 tmux -S /tmp/ut-test-zzz/ut/ab12/.shield-tmux start-server\n  8 tmux -S /tmp/other/.shield-tmux start-server\n',
      runDirOf: () => null,
      inUse: () => false,
      kill: (pid, signal) => {
        calls.push(`${signal}:${pid}`);
      },
      bootout: (label) => {
        calls.push(`bootout:${label}`);
      },
      sleep: async () => {
        clock += 100;
      },
      now: () => clock,
    });
    expect(reaped).toEqual([7]);
    expect(calls[0]).toMatch(/^bootout:com\.nachx639\.untether\.shield-tmux\./);
    expect(calls).toContain('SIGTERM:7');
    expect(calls).toContain('SIGKILL:7');
    expect(calls.some((call) => call.endsWith(':8'))).toBe(false);
  });
});

const fakeDeps = (ps: string, marks: Record<number, string>, calls: string[]): ReapDeps => ({
  ps: () => ps,
  runDirOf: (pid) => marks[pid] ?? null,
  kill: (pid, signal) => {
    calls.push(`${signal}:${pid}`);
  },
  bootout: (label) => {
    calls.push(`bootout:${label}`);
  },
  sleep: async () => undefined,
  now: () => 0,
  inUse: () => false,
});

describe('findRunTmuxServers', () => {
  it("finds a run's tmux servers by their UNTETHER_TEST_RUN_DIR mark wherever the socket is", () => {
    const ps = [
      '  11 tmux -S /tmp/vtsus.abc/.shield-tmux new-session -d',
      '  12 tmux -S /tmp/vtsus.def/.shield-tmux new-session -d',
      '  13 /opt/homebrew/bin/tmux -L untether-0123456789ab -D',
      '  14 tmux -S /Users/me/.untether/control/.shield-tmux -D',
    ].join('\n');
    const marks = {
      11: '/tmp/ut-test-mine',
      12: '/tmp/ut-test-other',
      13: '/private/tmp/ut-test-mine',
    };
    const found = findRunTmuxServers('/tmp/ut-test-mine', fakeDeps(ps, marks, []));
    expect(found.map(({ pid }) => pid)).toEqual([11, 13]);
  });
});

// `ps -axwwE -o pid=,command=`: each command followed by its environment.
const PS_ENV = [
  '  21 tmux -S /tmp/vtsus.abc/.shield-tmux new-session -d HOME=/tmp/vtsus.abc UNTETHER_TEST_RUN_DIR=/tmp/ut-test-mine',
  '  22 tmux -S /tmp/ut-test-mine/ut/fe37/.shield-tmux start-server HOME=/Users/me',
  '  23 tmux -S /tmp/vtsus.def/.shield-tmux new-session -d UNTETHER_TEST_RUN_DIR=/tmp/ut-test-other',
  '  24 tmux -S /Users/me/.untether/control/.shield-tmux -D HOME=/Users/me',
  '  25 node /repo/web/src/cli.ts --port 0 UNTETHER_TEST_RUN_DIR=/private/tmp/ut-test-mine TMPDIR=/tmp/ut-test-mine',
  '  26 node /repo/web/src/cli.ts --port 0 UNTETHER_TEST_RUN_DIR=/tmp/ut-test-other',
  '  27 node run-watchdog.ts /tmp/ut-test-mine 5 UNTETHER_TEST_RUN_DIR=/tmp/ut-test-mine',
  '  28 vim /tmp/ut-test-mine/notes HOME=/Users/me',
].join('\n');

describe('runProcesses', () => {
  it("names the run's tmux servers (socket or mark) and its other marked processes, nobody else's", () => {
    expect(runProcesses(PS_ENV, '/tmp/ut-test-mine', 27)).toEqual({
      servers: [
        { pid: 21, socket: '/tmp/vtsus.abc/.shield-tmux' },
        { pid: 22, socket: '/tmp/ut-test-mine/ut/fe37/.shield-tmux' },
      ],
      others: [25],
    });
  });
});

describe('watchRun with fakes', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, RM_TEST_DIR);
  });

  it('waits for the run to be gone, then kills its tmux servers at once and its other processes after a moment, until nothing is left', async () => {
    const calls: string[] = [];
    let clock = 0;
    let parentAlive = 3;
    // The test server (25) ignores SIGTERM; a tmux server (29) starts after the first look.
    const gone = new Set<number>();
    let looks = 0;
    await watchRun('/tmp/ut-test-mine', 5, {
      ...fakeDeps('', {}, calls),
      self: 27,
      psEnv: () => {
        looks += 1;
        if (looks === 2) throw new Error('ps timed out');
        const late =
          looks === 3
            ? '\n  29 tmux -L untether-0123456789ab -D UNTETHER_TEST_RUN_DIR=/tmp/ut-test-mine'
            : '';
        return (PS_ENV + late)
          .split('\n')
          .filter((line) => !gone.has(Number(line.trim().split(' ')[0])))
          .join('\n');
      },
      kill: (pid, signal) => {
        if (pid === 5 && signal === 0) {
          if (parentAlive-- > 0) return;
          throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        }
        calls.push(`${signal}:${pid}@${clock}`);
        if (signal === 'SIGKILL') gone.add(pid);
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    // Nothing before the run's vitest was gone (three looks at it, one second apart).
    expect(calls.find((call) => call.startsWith('SIG'))).toMatch(/@3000$/);
    expect(calls).toContain('SIGKILL:21@3000');
    expect(calls).toContain('SIGKILL:22@3000');
    expect(calls).toContain('SIGKILL:29@5000');
    expect(calls.filter((call) => call.includes(':25@'))).toEqual([
      ...[5, 6, 7, 8, 9, 10, 11, 12].map((s) => `SIGTERM:25@${s}000`),
      'SIGKILL:25@13000',
    ]);
    // Another run's, the developer's, a process that only names the dir, the watchdog itself.
    expect(calls.some((call) => /:(23|24|26|27|28)@/.test(call))).toBe(false);
    // Two looks with nothing left, then it ends.
    expect(clock).toBe(15000);
  });

  it("removes the dirs marked for the run, its own included, and no other run's nor one in use", async () => {
    const mk = (prefix: string) => {
      const dir = fs.mkdtempSync(prefix);
      dirs.push(dir);
      return dir;
    };
    const runDir = mk(path.join(os.tmpdir(), 'wr-run-'));
    writeTestMarker(runDir, runDir, 999_999_999);
    const home = mk('/tmp/ut-wr.');
    writeTestMarker(home, runDir);
    const used = mk('/tmp/ut-wr.');
    writeTestMarker(used, runDir);
    const others = mk('/tmp/ut-wr.');
    writeTestMarker(others, '/tmp/ut-test-other');
    await watchRun(runDir, 999_999_999, {
      ...fakeDeps('', {}, []),
      self: 1,
      psEnv: () => '',
      kill: () => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      },
      inUse: (dir) => fs.realpathSync(dir) === fs.realpathSync(used),
      now: (() => {
        let clock = 0;
        return () => (clock += 1000);
      })(),
    });
    expect(fs.existsSync(runDir)).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(used)).toBe(true);
    expect(fs.existsSync(others)).toBe(true);
  });
});

describe('leftTestDirs', () => {
  it('names exactly the nearest dir marked for this run, never a parent nor an unmarked dir', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'left-'));
    const run = path.join(base, 'ut-test-run');
    // /tmp/ut/abc as the shared parent of several control dirs.
    const abc = path.join(base, 'ut', 'abc');
    const otherRun = path.join(base, 'ut', 'def');
    const unmarked = path.join(base, 'vts-unmarked', '.untether', 'control');
    for (const dir of [run, abc, otherRun, unmarked]) fs.mkdirSync(dir, { recursive: true });
    writeTestMarker(abc, run);
    writeTestMarker(otherRun, '/tmp/ut-test-someone-else');
    expect(
      leftTestDirs(
        [
          { pid: 1, socket: path.join(abc, '.shield-tmux') },
          { pid: 2, socket: path.join(otherRun, '.shield-tmux') },
          { pid: 3, socket: path.join(unmarked, '.shield-tmux') },
          { pid: 4, socket: path.join(run, 'x', '.shield-tmux') },
          { pid: 5 },
        ],
        run
      )
    ).toEqual([abc]);
    fs.rmSync(base, RM_TEST_DIR);
  });
});

describe('sweepDeadTestRuns', () => {
  it('removes exactly the marked dirs whose owner ended and nobody uses; never unmarked, live or used ones', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
    const make = (name: string) => {
      const dir = path.join(base, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    // A pid that is surely gone: a child that already exited.
    const dead = Number(execFileSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim());
    const own = make('ut-test-own');
    writeTestMarker(own, own);
    const live = make('ut-test-live');
    writeTestMarker(live, live);
    const died = make('ut-test-died');
    writeTestMarker(died, died, dead);
    const nested = make('ut/abc');
    writeTestMarker(nested, died, dead);
    const used = make('ut-test-used');
    writeTestMarker(used, used, dead);
    const unmarked = make('ut-test-unmarked');
    const old = (Date.now() - 9 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(unmarked, old, old);
    const link = path.join(base, 'ut-test-link');
    fs.symlinkSync(died, link);

    const deps = { ...fakeDeps('', {}, []), inUse: (dir: string) => dir.endsWith('ut-test-used') };
    const swept = sweepDeadTestRuns(base, own, deps);

    expect(swept.map((dir) => path.relative(base, dir)).sort()).toEqual(['ut-test-died', 'ut/abc']);
    for (const dir of [own, live, used, unmarked, path.join(base, 'ut')]) {
      expect(fs.existsSync(dir)).toBe(true);
    }
    expect(fs.existsSync(died) || fs.existsSync(nested)).toBe(false);
    fs.rmSync(base, RM_TEST_DIR);
  });
});

describe('test temp dirs', () => {
  it("are inside the run's dir (os.tmpdir()), so the global teardown removes them", () => {
    const runDir = process.env.UNTETHER_TEST_RUN_DIR as string;
    expect(runDir).toBeTruthy();
    expect(os.tmpdir()).toBe(runDir);
  });
});

const tmux = findTmuxBinary();

describe.skipIf(!tmux)('global teardown kills the tmux servers a test leaves (real tmux)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      stopTestShieldServer(tmux as string, dir);
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });

  const startShield = (controlDir: string) => {
    fs.mkdirSync(controlDir, { recursive: true });
    // As a test server's shielded session does: a shield server with a program in a pane.
    execFileSync(tmux as string, [
      ...shieldSocketArgs(controlDir),
      'new-session',
      '-d',
      '-s',
      'ut-leak',
      'cat',
    ]);
    const pid = Number(
      execFileSync(tmux as string, [...shieldSocketArgs(controlDir), 'display', '-p', '#{pid}'], {
        encoding: 'utf8',
      }).trim()
    );
    expect(pid).toBeGreaterThan(0);
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

  it("kills a leaked shield server of the run, even after its dir was removed, and nobody else's", async () => {
    const runDir = fs.mkdtempSync(path.join('/tmp', 'ut-rt-'));
    const otherRun = fs.mkdtempSync(path.join('/tmp', 'ut-rt-'));
    dirs.push(path.join(runDir, 'ut', 'ab12'), path.join(otherRun, 'ut', 'cd34'), runDir, otherRun);

    const leaked = startShield(path.join(runDir, 'ut', 'ab12'));
    const kept = startShield(path.join(otherRun, 'ut', 'cd34'));
    // The test "cleaned up" its dir but never ran kill-server: the socket is gone too.
    fs.rmSync(path.join(runDir, 'ut'), RM_TEST_DIR);

    const reaped = await reapRunTmuxServers(runDir);

    expect(reaped).toEqual([leaked]);
    expect(alive(leaked)).toBe(false);
    expect(alive(kept)).toBe(true);
  }, 15_000);

  it('kills a marked shield server whose control dir is straight in /tmp, and removes that marked dir', () => {
    // As the tests that keep their socket path short do (markedTempDir('/tmp/vtsus.')).
    const fakeRun = fs.mkdtempSync(path.join('/tmp', 'ut-rt-run-'));
    dirs.push(fakeRun);
    const outside = fs.mkdtempSync('/tmp/ut-rt-out.');
    writeTestMarker(outside, fakeRun);
    dirs.push(outside);
    const controlDir = path.join(outside, '.untether', 'control');
    fs.mkdirSync(controlDir, { recursive: true });
    execFileSync(
      tmux as string,
      [...shieldSocketArgs(controlDir), 'new-session', '-d', '-s', 'ut-leak', 'cat'],
      { env: { ...process.env, UNTETHER_TEST_RUN_DIR: fakeRun } }
    );
    const pid = Number(
      execFileSync(tmux as string, [...shieldSocketArgs(controlDir), 'display', '-p', '#{pid}'], {
        encoding: 'utf8',
      }).trim()
    );

    const reaped = reapRunTmuxServersNow(fakeRun);

    expect(reaped).toContain(pid);
    const deadline = Date.now() + 3000;
    while (alive(pid) && Date.now() < deadline) execFileSync('sleep', ['0.05']);
    expect(alive(pid)).toBe(false);
    expect(fs.existsSync(outside)).toBe(false);
  }, 15_000);
});

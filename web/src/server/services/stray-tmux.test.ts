import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { staleTestDirsCheck, strayShieldTmuxCheck } from './doctor-checks.js';
import {
  dirInUse,
  dirInUseSync,
  envFromPsE,
  findTestDirs,
  homeInDir,
  isUserControlDir,
  lsofProvesUnused,
  MARKER_STALE_MS,
  markerEnded,
  parseEtime,
  parsePs,
  readTestMarker,
  type ShieldServerInfo,
  shieldSelection,
  shieldServers,
  TEST_RUN_MARKER,
  writeTestMarker,
} from './stray-tmux.js';

const HOUR = 60 * 60 * 1000;

describe('parseEtime', () => {
  it('reads every ps elapsed form', () => {
    expect(parseEtime('05:07')).toBe((5 * 60 + 7) * 1000);
    expect(parseEtime('01:02:03')).toBe((3600 + 120 + 3) * 1000);
    expect(parseEtime('20-22:34:47')).toBe(((20 * 24 + 22) * 3600 + 34 * 60 + 47) * 1000);
    expect(parseEtime('junk')).toBe(0);
  });
});

describe('shieldSelection', () => {
  it('finds -S …/.shield-tmux and -L untether-<hash> of tmux only', () => {
    expect(
      shieldSelection('/opt/homebrew/bin/tmux -S /tmp/utq8/.untether/control/.shield-tmux -D')
    ).toEqual(['-S', '/tmp/utq8/.untether/control/.shield-tmux']);
    expect(shieldSelection('/opt/homebrew/bin/tmux -L untether-bedbc3dfe58a -D')).toEqual([
      '-L',
      'untether-bedbc3dfe58a',
    ]);
    expect(shieldSelection('tmux -S /tmp/vtm-unit/default new-session')).toBeNull();
    expect(shieldSelection('cat -S /tmp/x/.shield-tmux')).toBeNull();
    expect(shieldSelection('tmux -L mysession')).toBeNull();
  });
});

describe('envFromPsE / homeInDir', () => {
  it('picks the asked variables out of ps -E output', () => {
    expect(
      envFromPsE('tmux -L untether-ab -D HOME=/tmp/h UNTETHER_CONTROL_DIR=/tmp/h/c PATH=/bin', [
        'HOME',
        'UNTETHER_CONTROL_DIR',
        'UNTETHER_TEST_RUN_DIR',
      ])
    ).toEqual({ HOME: '/tmp/h', UNTETHER_CONTROL_DIR: '/tmp/h/c' });
  });

  it('sees a HOME inside a dir, in either /tmp spelling, and not a prefix-sharing one', () => {
    const ps = 'bash PATH=/bin HOME=/private/tmp/utq8/home\nnode HOME=/tmp/utq88';
    expect(homeInDir(ps, '/tmp/utq8')).toBe(true);
    expect(homeInDir(ps, '/tmp/utq')).toBe(false);
  });
});

describe('shieldServers', () => {
  // 2026-11-09: a test tmux an agent left on its own socket is no shield: the doctor's
  // stray-shield-tmux has nothing to count there, marks or not.
  it('does not take an agent’s test tmux server for a stray shield', () => {
    const rows = parsePs('  700     1 01:00:00 tmux -L agente-prueba new-session -d -s scratchpad');
    expect(rows).toHaveLength(1);
    expect(shieldServers(rows, () => ({ UNTETHER_TASK_ID: 'abc', CLAUDECODE: '1' }))).toEqual([]);
  });

  const ps = [
    '    1     0 30-00:00:00 /sbin/launchd',
    '  100     1 20-22:34:47 /opt/homebrew/bin/tmux -S /Users/me/.untether/control/.shield-tmux -D',
    '  101   900    05:07 /Users/me/.untether/bin/tmux -S /Users/me/.untether/control/.shield-tmux attach-session -t =ut-1',
    '  102   100 20-22:00:00 -zsh',
    '  200     1 19-01:00:00 /opt/homebrew/bin/tmux -S /tmp/utq8/.untether/control/.shield-tmux -D',
    '  201   200 19-01:00:00 bash',
    '  300     1 01-15:19:09 /opt/homebrew/bin/tmux -L untether-bedbc3dfe58a -D',
  ].join('\n');

  it('reads control dir, test run, clients and programs of each', () => {
    const servers = shieldServers(parsePs(ps), (pid) =>
      pid === 300 ? { HOME: '/tmp/qa/home', UNTETHER_TEST_RUN_DIR: '/tmp/ut-test-x' } : null
    );
    expect(servers.map((server) => server.pid)).toEqual([100, 200, 300]);
    const [active, qa, named] = servers;
    expect(active).toMatchObject({ clients: 1, programs: ['zsh'] });
    expect(qa).toMatchObject({
      controlDir: '/tmp/utq8/.untether/control',
      clients: 0,
      programs: ['bash'],
    });
    expect(qa.testRunDir).toBeUndefined();
    expect(named).toMatchObject({
      controlDir: '/tmp/qa/home/.untether/control',
      testRunDir: '/tmp/ut-test-x',
      programs: [],
    });
    expect(qa.ageMs).toBeGreaterThan(19 * 24 * HOUR);
  });
});

describe('isUserControlDir', () => {
  it("protects ~/.untether*/control, not another HOME's", () => {
    expect(isUserControlDir('/Users/me/.untether/control', '/Users/me')).toBe(true);
    expect(isUserControlDir('/Users/me/.untether-dev/control', '/Users/me')).toBe(true);
    expect(isUserControlDir('/Users/me/.uq/.uq/c', '/Users/me')).toBe(false);
  });
});

describe('test markers', () => {
  it('reads back what was written; a symlinked dir or a junk marker is no marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-'));
    expect(readTestMarker(dir)).toBeNull();
    writeTestMarker(dir, '/tmp/ut-test-run', 4242);
    expect(readTestMarker(dir)).toMatchObject({ pid: 4242, runDir: '/tmp/ut-test-run' });
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    expect(readTestMarker(link)).toBeNull();
    const junk = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-'));
    fs.writeFileSync(path.join(junk, TEST_RUN_MARKER), 'not json');
    expect(readTestMarker(junk)).toBeNull();
  });

  it('a marker ends when its pid is gone or it is over 6 h old', () => {
    const now = 1_000_000_000_000;
    expect(markerEnded({ pid: 1, at: now }, now, () => true)).toBe(false);
    expect(markerEnded({ pid: 1, at: now }, now, () => false)).toBe(true);
    expect(markerEnded({ pid: 1, at: now - MARKER_STALE_MS - 1 }, now, () => true)).toBe(true);
  });
});

const server = (over: Partial<ShieldServerInfo>): ShieldServerInfo => ({
  pid: 200,
  ageMs: 19 * 24 * HOUR,
  select: ['-S', '/tmp/utq8/.untether/control/.shield-tmux'],
  controlDir: '/tmp/utq8/.untether/control',
  clients: 0,
  programs: ['bash'],
  ...over,
});

describe('strayShieldTmuxCheck', () => {
  const run = async (servers: ShieldServerInfo[], closeOk = true) => {
    const close = vi.fn(async () => closeOk);
    const findings = await strayShieldTmuxCheck({
      activeControlDir: '/Users/me/.untether/control',
      servers: async () => servers,
      close,
      isUserControlDir: (dir) => isUserControlDir(dir, '/Users/me'),
      testRunEnded: (dir) => dir === '/tmp/ut-test-gone',
    }).run();
    return { findings, close };
  };

  it('closes a server marked by a test run that has ended, whatever runs in it', async () => {
    const { findings, close } = await run([
      server({ ageMs: 20 * 60 * 1000, testRunDir: '/tmp/ut-test-gone', programs: ['node'] }),
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(findings[0].healed).toBe('closed');
  });

  it('never closes an unmarked server, even an old one with only bash: it only tells', async () => {
    const { findings, close } = await run([
      server({}),
      server({
        pid: 300,
        select: ['-L', 'untether-bedbc3dfe58a'],
        controlDir: undefined,
        programs: [],
      }),
    ]);
    expect(close).not.toHaveBeenCalled();
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.healed === undefined)).toBe(true);
    expect(findings[0].problem).toContain('not closed');
    expect(findings[1].problem).toContain('with no session');
  });

  it("leaves the active, the user's own, attached, young and live-run servers alone", async () => {
    const { findings, close } = await run([
      server({
        select: ['-S', '/Users/me/.untether/control/.shield-tmux'],
        controlDir: '/Users/me/.untether/control',
      }),
      server({
        select: ['-S', '/Users/me/.untether-dev/control/.shield-tmux'],
        controlDir: '/Users/me/.untether-dev/control',
      }),
      server({ clients: 1, testRunDir: '/tmp/ut-test-gone' }),
      server({ ageMs: 2 * HOUR }),
      server({ testRunDir: '/tmp/ut-test-live' }),
    ]);
    expect(findings).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it('says when closing failed', async () => {
    const { findings } = await run([server({ testRunDir: '/tmp/ut-test-gone' })], false);
    expect(findings[0].healed).toBeUndefined();
    expect(findings[0].problem).toContain('closing it failed');
  });
});

describe('findTestDirs + staleTestDirsCheck (real dirs)', () => {
  const old = (dir: string, ageMs: number) => {
    const at = (Date.now() - ageMs) / 1000;
    for (const entry of fs.readdirSync(dir, { recursive: true }) as string[]) {
      fs.utimesSync(path.join(dir, entry), at, at);
    }
    fs.utimesSync(dir, at, at);
  };

  it('removes exactly a marked dir nested in /tmp/ut-like parents, never the parent or unmarked ones', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-root-'));
    // As /tmp/ut/<hex>: a shared parent with runs' control dirs in it.
    const shared = path.join(root, 'ut');
    const abc = path.join(shared, 'abc');
    const other = path.join(shared, 'def');
    fs.mkdirSync(abc, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, '.shield-tmux'), '');
    writeTestMarker(abc, '/tmp/ut-test-dead', 999_999);
    // An unmarked QA HOME, old: told only.
    const qa = path.join(root, 'utq8');
    fs.mkdirSync(path.join(qa, '.untether', 'control'), { recursive: true });
    old(qa, 3 * 24 * HOUR);

    const found = findTestDirs([root]);
    expect(found.map((info) => [path.basename(info.dir), !!info.marker]).sort()).toEqual([
      ['abc', true],
      ['utq8', false],
    ]);

    const removed: string[] = [];
    const findings = await staleTestDirsCheck({
      dirs: () => findTestDirs([root]),
      inUse: async () => false,
      markerEnded: () => true,
      remove: (dir) => {
        removed.push(dir);
        fs.rmSync(dir, RM_TEST_DIR);
      },
    }).run();

    expect(removed.map((dir) => path.basename(dir))).toEqual(['abc']);
    expect(fs.existsSync(abc)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(qa)).toBe(true);
    const told = findings.find((finding) => finding.key === 'stale-test-dirs:unmarked');
    expect(told?.healed).toBeUndefined();
    expect(told?.problem).toContain('utq8');
    fs.rmSync(root, RM_TEST_DIR);
  });

  it('keeps a marked dir whose run is still alive', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-root-'));
    const live = path.join(root, 'ut-test-live');
    fs.mkdirSync(live);
    writeTestMarker(live, live);
    const remove = vi.fn();
    await staleTestDirsCheck({
      dirs: () => findTestDirs([root]),
      inUse: async () => false,
      remove,
    }).run();
    expect(remove).not.toHaveBeenCalled();
    fs.rmSync(root, RM_TEST_DIR);
  });

  it('keeps a marked, ended dir a process has as its cwd (real lsof)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-root-'));
    const dir = path.join(root, 'ut-test-dead');
    fs.mkdirSync(dir);
    writeTestMarker(dir, dir, 999_999);
    const sleeper = spawn('sleep', ['30'], { cwd: dir, stdio: 'ignore' });
    try {
      expect(await dirInUse(dir)).toBe(true);
      const remove = vi.fn();
      await staleTestDirsCheck({
        dirs: () => findTestDirs([root]),
        inUse: dirInUse,
        markerEnded: () => true,
        remove,
      }).run();
      expect(remove).not.toHaveBeenCalled();
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      sleeper.kill('SIGKILL');
      fs.rmSync(root, RM_TEST_DIR);
    }
  }, 30_000);

  it('dirInUse is false for a dir nobody uses', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-'));
    expect(await dirInUse(dir)).toBe(false);
    fs.rmSync(dir, RM_TEST_DIR);
  }, 30_000);

  it('dirInUseSync agrees: true with a cwd inside, false for an unused dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'used-sync-'));
    expect(dirInUseSync(dir)).toBe(false);
    const sleeper = spawn('sleep', ['30'], { cwd: dir, stdio: 'ignore' });
    try {
      const deadline = Date.now() + 5000;
      let used = dirInUseSync(dir);
      while (!used && Date.now() < deadline) used = dirInUseSync(dir);
      expect(used).toBe(true);
    } finally {
      sleeper.kill('SIGKILL');
      fs.rmSync(dir, RM_TEST_DIR);
    }
  }, 30_000);

  // 2026-11-02 (AI review): with -t, lsof exits 1 with no output for a dir it could not go
  // through, the same as an unused one; such a dir must never pass as unused.
  it.skipIf(process.getuid?.() === 0)(
    'a dir with a subdir lsof cannot read counts as in use (async and sync)',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-'));
      const locked = path.join(dir, 'locked');
      fs.mkdirSync(path.join(locked, 'inner'), { recursive: true });
      fs.chmodSync(locked, 0o000);
      try {
        expect(await dirInUse(dir)).toBe(true);
        expect(dirInUseSync(dir)).toBe(true);
      } finally {
        fs.chmodSync(locked, 0o755);
        fs.rmSync(dir, RM_TEST_DIR);
      }
    },
    30_000
  );
});

describe('lsofProvesUnused', () => {
  const run = (over: Partial<Parameters<typeof lsofProvesUnused>[0]>) =>
    lsofProvesUnused({ status: 1, stdout: '', stderr: '', timedOut: false, ...over });

  it('is true only for a full, silent run that lists no process', () => {
    expect(run({})).toBe(true);
    expect(run({ status: 0 })).toBe(true);
  });

  it('is false when a process is listed, lsof warned, failed or timed out', () => {
    expect(run({ stdout: 'p123\nfcwd\n' })).toBe(false);
    expect(run({ stderr: "lsof: WARNING: can't opendir(/tmp/x/locked): Permission denied" })).toBe(
      false
    );
    expect(run({ status: 2 })).toBe(false);
    expect(run({ status: null })).toBe(false);
    expect(run({ timedOut: true })).toBe(false);
  });
});

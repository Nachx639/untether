import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { findTmuxBinary } from '../../server/services/shielded-tmux.js';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

/**
 * 2026-11-01: shield tmux servers of tests and QA ran 18-20 days after their run. A real
 * vitest run (src/test/fixtures/leaky-run) whose test starts a shield tmux server outside the
 * run's dir and never cleans up must leave nothing alive, whether the test fails or the run is
 * killed with a signal.
 */
const webDir = path.resolve(__dirname, '../../..');
const fixtureDir = path.join(webDir, 'src/test/fixtures/leaky-run');

interface Leak {
  pid: number;
  home: string;
  runDir: string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

/** A process and everything under it, from one `ps` listing. */
function processTree(root: number): number[] {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const tree = [root];
  for (const pid of tree) {
    for (const [child, parent] of rows) if (parent === pid) tree.push(child);
  }
  return tree;
}

interface Run {
  code: number | null;
  leak: Leak;
  infoFile: string;
}

type Mode = 'fail' | 'hang' | 'late';
/** How the run ends: by itself, on a SIGTERM to vitest, or with its whole tree killed with -9. */
type End = 'itself' | 'SIGTERM' | 'tree SIGKILL';

/**
 * Everything the leaky runs create hangs from one dir inside THIS run's dir (2026-11-11:
 * /tmp/ut-leaky.* was left behind by a run cut short): afterAll, this run's teardown and its
 * watchdog remove it, whatever happened to the inner runs.
 */
let leakRoot = '';
/**
 * The leaky test's HOME has to be straight in /tmp (the inner run's cleanup only looks there:
 * that is what is tested), so it cannot hang from leakRoot; its name carries leakRoot's, and
 * afterAll removes by it, even when the inner run died before saying where its HOME was.
 */
const leakHomePrefix = () => `/tmp/ut-leaky.${path.basename(leakRoot)}.`;
const leakPids = new Set<number>();

async function runLeaky(mode: Mode, end: End): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(leakRoot, 'run-'));
  const infoFile = path.join(dir, 'leak.json');
  const child = spawn(
    process.execPath,
    [path.join(webDir, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts'],
    {
      cwd: fixtureDir,
      env: {
        ...process.env,
        LEAK_MODE: mode,
        LEAK_INFO_FILE: infoFile,
        LEAK_HOME_PREFIX: leakHomePrefix(),
      },
      stdio: 'ignore',
    }
  );
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  if (end !== 'itself') {
    const deadline = Date.now() + 45_000;
    while (!fs.existsSync(infoFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (end === 'SIGTERM') child.kill('SIGTERM');
    else {
      // No process of the run gets to clean up.
      for (const pid of processTree(child.pid as number)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Gone meanwhile.
        }
      }
    }
  }
  const code = await exited;
  const leak = JSON.parse(fs.readFileSync(infoFile, 'utf8')) as Leak;
  leakPids.add(leak.pid);
  return { code, leak, infoFile };
}

/** The tmux server a LEAK_MODE=late child started after its run was gone, once it says so. */
async function lateServer({ leak, infoFile }: Run, ms = 20_000): Promise<number | null> {
  const file = `${infoFile}.late`;
  const deadline = Date.now() + ms;
  while (!fs.existsSync(file) && alive(leak.pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!fs.existsSync(file)) return null;
  const { pid } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number };
  leakPids.add(pid);
  return pid;
}

describe.skipIf(!findTmuxBinary())('a test run that fails leaves no tmux server alive', () => {
  // 2026-11-02: the runs are separate vitest processes with their own run dirs, so they start
  // together (each test awaits its own) instead of one after the other.
  let runs: Record<'fail' | 'term' | 'kill' | 'late', Promise<Run>>;
  beforeAll(() => {
    leakRoot = fs.mkdtempSync(path.join(process.env.UNTETHER_TEST_RUN_DIR as string, 'leaky-'));
    runs = {
      fail: runLeaky('fail', 'itself'),
      term: runLeaky('hang', 'SIGTERM'),
      kill: runLeaky('hang', 'tree SIGKILL'),
      late: runLeaky('late', 'SIGTERM'),
    };
    // Each is awaited by its test; until then a failure is not an unhandled rejection.
    for (const run of Object.values(runs)) run.catch(() => {});
  });

  afterAll(async () => {
    // Whatever failed or was cut: wait for the inner runs, stop what they left, remove their dirs.
    await Promise.allSettled(Object.values(runs ?? {}));
    for (const pid of leakPids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    leakPids.clear();
    if (leakRoot) {
      const prefix = path.basename(leakHomePrefix());
      for (const name of fs.readdirSync('/tmp')) {
        if (name.startsWith(prefix)) fs.rmSync(path.join('/tmp', name), RM_TEST_DIR);
      }
      fs.rmSync(leakRoot, RM_TEST_DIR);
    }
  }, 60_000);

  const leftNothing = async (leak: Leak, pids: number[] = [leak.pid]) => {
    try {
      for (const pid of pids) expect(await gone(pid, 30_000)).toBe(true);
      await vi.waitFor(
        () => {
          expect(fs.existsSync(leak.home)).toBe(false);
          expect(fs.existsSync(leak.runDir)).toBe(false);
        },
        { timeout: 30_000, interval: 200 }
      );
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
      fs.rmSync(leak.home, RM_TEST_DIR);
      fs.rmSync(leak.runDir, RM_TEST_DIR);
    }
  };

  it('a test that fails on purpose: the teardown kills its server and removes its HOME', async () => {
    const { code, leak } = await runs.fail;
    expect(code).not.toBe(0);
    expect(leak.pid).toBeGreaterThan(0);
    await leftNothing(leak);
  }, 120_000);

  it('a run killed with SIGTERM mid-test: the signal handler cleans up', async () => {
    const { leak } = await runs.term;
    await leftNothing(leak);
  }, 120_000);

  // 2026-11-10: the doctor closed a shield tmux server (/tmp/ut-test-*/ut/fe37/.shield-tmux) of
  // a run that had been cut, at a load of 100-590. With every process of the run killed with
  // -9, nothing of the run is left to clean up: its watchdog does (run-watchdog.ts).
  it('a run whose whole tree is killed with SIGKILL: its watchdog cleans up', async () => {
    const { leak } = await runs.kill;
    await leftNothing(leak);
  }, 120_000);

  // The signal handler cleans up once, at the signal. A child of the run still alive then (a
  // test server, slow to notice on a loaded Mac) starts its shield tmux server afterwards.
  it('a child that outlives a SIGTERMed run and starts a tmux server after it: both go', async () => {
    const run = await runs.late;
    const server = await lateServer(run);
    await leftNothing(run.leak, server === null ? [run.leak.pid] : [run.leak.pid, server]);
  }, 120_000);
});

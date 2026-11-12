import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MERGE_REFLOG_ACTION as PIPELINE_REFLOG_ACTION } from '../../server/services/task-merge.js';
import { run } from '../../server/utils/exec-file.js';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

const require = createRequire(import.meta.url);
const {
  MERGE_REFLOG_ACTION,
  RestartBatcher,
  isServerSource,
  mergeSignal,
  restartHolds,
  tsxFlags,
  watchServer,
} = require('../../../scripts/server-watch.js');

const dirs: string[] = [];
const stops: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, RM_TEST_DIR);
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'server-watch-')));
  dirs.push(dir);
  return dir;
}

/** A fake clock and timers the batcher runs on. */
function fakeTime() {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let ids = 0;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++ids;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: number) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
    /** Moves the clock, running each timer due on the way. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((t) => t !== next);
        now = next.at;
        next.fn();
      }
      now = end;
    },
  };
}

function batcher(holds: () => string[] = () => []) {
  const time = fakeTime();
  const restarts: string[] = [];
  const b = new RestartBatcher({
    restart: (reason: string) => restarts.push(reason),
    holds,
    quietMs: 90_000,
    maxWaitMs: 600_000,
    pollMs: 5_000,
    humanDelayMs: 300,
    ...time,
  });
  return { b, time, restarts };
}

describe('RestartBatcher', () => {
  it('restarts a hand edit after the short debounce, as tsx watch did', () => {
    const { b, time, restarts } = batcher();
    b.change('human');
    time.advance(200);
    b.change('human');
    time.advance(299);
    expect(restarts).toEqual([]);
    time.advance(1);
    expect(restarts).toEqual(['code changed']);
  });

  it('batches merges: one restart once they stop for the quiet time', () => {
    const { b, time, restarts } = batcher();
    // Five merges a minute apart (02-nov: a merge every few minutes, one restart each).
    for (let i = 0; i < 5; i++) {
      b.change('merge');
      time.advance(60_000);
    }
    expect(restarts).toEqual([]);
    time.advance(29_999);
    expect(restarts).toEqual([]);
    time.advance(1);
    expect(restarts).toEqual(['merged code changed']);
    time.advance(600_000);
    expect(restarts).toHaveLength(1);
  });

  it('never waits past the maximum, even with merges that keep coming', () => {
    const { b, time, restarts } = batcher();
    for (let i = 0; i < 20; i++) {
      b.change('merge');
      time.advance(60_000);
      if (restarts.length) break;
    }
    expect(restarts).toEqual(['merged code changed']);
    expect(time.now()).toBe(600_000);
  });

  it('waits while a task starts or a check/merge runs, then restarts when they end', () => {
    let holds = ['pipeline 1234abcd'];
    const { b, time, restarts } = batcher(() => holds);
    b.change('merge');
    time.advance(90_000);
    expect(restarts).toEqual([]);
    time.advance(60_000);
    expect(restarts).toEqual([]);
    holds = [];
    time.advance(5_000);
    expect(restarts).toEqual(['merged code changed']);
    expect(time.now()).toBe(155_000);
  });

  it('a hold that never ends is waited for no longer than the maximum', () => {
    const { b, time, restarts } = batcher(() => ['start 1234abcd']);
    b.change('merge');
    time.advance(599_999);
    expect(restarts).toEqual([]);
    time.advance(1);
    expect(restarts).toEqual(['merged code waited 10 min (still: start 1234abcd)']);
  });

  it('a hand edit restarts at once and takes the waiting merges with it', () => {
    const { b, time, restarts } = batcher(() => ['pipeline x']);
    b.change('merge');
    time.advance(30_000);
    b.change('human');
    time.advance(300);
    expect(restarts).toEqual(['code changed']);
    expect(b.pending()).toBe(false);
    time.advance(700_000);
    expect(restarts).toHaveLength(1);
  });
});

describe('isServerSource', () => {
  it('takes server code, not the client, tests or other files', () => {
    expect(isServerSource('server/services/task-merge.ts')).toBe(true);
    expect(isServerSource('shared/tasks.ts')).toBe(true);
    expect(isServerSource('cli.ts')).toBe(true);
    expect(isServerSource('client/app.ts')).toBe(false);
    expect(isServerSource('test/unit/a.test.ts')).toBe(false);
    expect(isServerSource('server/services/task-merge.test.ts')).toBe(false);
    expect(isServerSource('server/README.md')).toBe(false);
  });
});

describe('restartHolds', () => {
  it('reads what is under way from the task journal', () => {
    const file = path.join(tempDir(), 'tasks.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        tasks: [
          { id: 'aaaaaaaa-1', state: 'preparing', effects: [{ kind: 'worktree' }] },
          { id: 'bbbbbbbb-2', state: 'working', effects: [{ kind: 'pipeline' }, { kind: 'base' }] },
          { id: 'cccccccc-3', state: 'ready' },
          { id: 'dddddddd-4', state: 'working', effects: [{ kind: 'session' }] },
        ],
      })
    );
    expect(restartHolds(file)).toEqual([
      'start aaaaaaaa',
      'worktree aaaaaaaa',
      'base bbbbbbbb',
      'pipeline bbbbbbbb',
      'session dddddddd',
    ]);
  });

  it('holds nothing when tasks.json is missing or unreadable', () => {
    const dir = tempDir();
    expect(restartHolds(path.join(dir, 'none.json'))).toEqual([]);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    expect(restartHolds(path.join(dir, 'bad.json'))).toEqual([]);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

/** A repository on main with a branch `task` one commit ahead (src/server/a.ts changed). */
function repoWithTask(): { repo: string; tasks: string } {
  const repo = tempDir();
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'src/server'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/server/a.ts'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'a');
  git(repo, 'checkout', '-qb', 'task');
  fs.writeFileSync(path.join(repo, 'src/server/a.ts'), 'export const a = 2;\n');
  git(repo, 'commit', '-qam', 'b');
  git(repo, 'checkout', '-q', 'main');
  return { repo, tasks: path.join(tempDir(), 'tasks.json') };
}

/** The fast-forward exactly as the pipeline runs it (task-merge-base.ts moveBase). */
async function pipelineFastForward(repo: string): Promise<void> {
  const head = git(repo, 'rev-parse', 'task').trim();
  const result = await run('git', ['merge', '--ff-only', head], repo, 10_000, {
    GIT_REFLOG_ACTION: PIPELINE_REFLOG_ACTION,
  });
  expect(result.code).toBe(0);
}

describe('mergeSignal', () => {
  it('uses the same reflog action as the pipeline', () => {
    expect(MERGE_REFLOG_ACTION).toBe(PIPELINE_REFLOG_ACTION);
  });

  it("knows the pipeline's fast-forward from a hand edit", async () => {
    const { repo, tasks } = repoWithTask();
    const gitDir = path.join(repo, '.git');
    const files = ['src/server/a.ts'];
    expect(mergeSignal({ repoRoot: repo, gitDir, tasks, files })).toBe(false);

    await pipelineFastForward(repo);
    expect(fs.readFileSync(path.join(repo, '.git/logs/HEAD'), 'utf8')).toContain(
      `${PIPELINE_REFLOG_ACTION}: Fast-forward`
    );
    expect(mergeSignal({ repoRoot: repo, gitDir, tasks, files })).toBe(true);

    // A hand edit right after the merge: the file is no longer what HEAD has.
    fs.writeFileSync(path.join(repo, 'src/server/a.ts'), 'export const a = 3;\n');
    expect(mergeSignal({ repoRoot: repo, gitDir, tasks, files })).toBe(false);
    // A new file by hand, too.
    git(repo, 'checkout', '--', 'src/server/a.ts');
    fs.writeFileSync(path.join(repo, 'src/server/b.ts'), 'export const b = 1;\n');
    expect(mergeSignal({ repoRoot: repo, gitDir, tasks, files: ['src/server/b.ts'] })).toBe(false);
  });

  it("an old merge in the reflog explains nothing; a human's merge never does", async () => {
    const { repo, tasks } = repoWithTask();
    const gitDir = path.join(repo, '.git');
    await pipelineFastForward(repo);
    const files = ['src/server/a.ts'];
    expect(
      mergeSignal({ repoRoot: repo, gitDir, tasks, files, now: Date.now() + 3 * 60_000 })
    ).toBe(false);
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    git(repo, 'merge', '-q', '--ff-only', 'task');
    expect(mergeSignal({ repoRoot: repo, gitDir, tasks, files })).toBe(false);
  });

  it('a base moving on this repository (task journal) is a merge before the reflog says so', () => {
    const { repo, tasks } = repoWithTask();
    const gitDir = path.join(repo, '.git');
    fs.writeFileSync(
      tasks,
      JSON.stringify({
        tasks: [{ id: 't', repoPath: repo, effects: [{ kind: 'base', sha: 'x' }] }],
      })
    );
    expect(mergeSignal({ repoRoot: repo, gitDir, tasks, files: ['src/server/a.ts'] })).toBe(true);
    fs.writeFileSync(
      tasks,
      JSON.stringify({
        tasks: [{ id: 't', repoPath: '/elsewhere', effects: [{ kind: 'base', sha: 'x' }] }],
      })
    );
    expect(mergeSignal({ repoRoot: repo, gitDir, tasks, files: ['src/server/a.ts'] })).toBe(false);
  });
});

/** Waits for `check`, polling, up to `ms`. */
async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('watchServer', () => {
  it('restarts at once on a hand edit and batches the restart a pipeline merge causes', async () => {
    const { repo, tasks } = repoWithTask();
    const starts = path.join(tempDir(), 'starts.log');
    // The "server": appends a line per start and stays up.
    const server = `require('fs').appendFileSync(${JSON.stringify(starts)}, 'start\\n'); setInterval(() => {}, 1000);`;
    const count = () =>
      fs.existsSync(starts)
        ? fs.readFileSync(starts, 'utf8').split('\n').filter(Boolean).length
        : 0;
    const logs: string[] = [];
    const watcher = watchServer({
      webDir: repo,
      srcDir: 'src',
      tasksFile: tasks,
      command: [process.execPath, ['-e', server]],
      stdio: 'ignore',
      settleMs: 300,
      batch: { quietMs: 4_000, maxWaitMs: 60_000, pollMs: 100, humanDelayMs: 50 },
      log: (text: string) => logs.push(text),
    });
    stops.push(() => watcher.stop());
    await until(() => count() === 1);

    // The pipeline merges: no restart until merges are quiet for quietMs.
    const merged = Date.now();
    await pipelineFastForward(repo);
    await until(() => watcher.batcher.pending());
    expect(count()).toBe(1);
    await until(() => count() === 2);
    expect(Date.now() - merged).toBeGreaterThanOrEqual(4_000);
    expect(logs.some((line) => line.includes('restarting: merged code changed'))).toBe(true);

    // A hand edit: restarted right away.
    const edited = Date.now();
    fs.writeFileSync(path.join(repo, 'src/server/a.ts'), 'export const a = 9;\n');
    await until(() => count() === 3);
    expect(Date.now() - edited).toBeLessThan(4_000);
    expect(logs.some((line) => line.includes('restarting: code changed'))).toBe(true);

    // A client or test file changes nothing.
    fs.mkdirSync(path.join(repo, 'src/client'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/client/app.ts'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(count()).toBe(3);
  }, 30_000);

  // 2026-11-10: the server ran under the `tsx` wrapper. A server that did not end on SIGTERM
  // outlived the restart (SIGKILL reached the wrapper only) and kept the port; stop() never ended.
  it('a server that ignores SIGTERM is gone after a restart and after stop', async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'src'));
    const pids = path.join(dir, 'pids.log');
    const entry = path.join(dir, 'stubborn.ts');
    fs.writeFileSync(
      entry,
      `import * as fs from 'node:fs';
process.on('SIGTERM', () => {});
const pid: number = process.pid;
fs.appendFileSync(${JSON.stringify(pids)}, pid + '\\n');
setInterval(() => {}, 1000);
`
    );
    const started = () =>
      fs.existsSync(pids)
        ? fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number)
        : [];
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // The real command: node with tsx's flags, found from this checkout's web folder.
    const webDir = path.resolve(__dirname, '../../..');
    const watcher = watchServer({
      webDir: dir,
      srcDir: 'src',
      tasksFile: path.join(dir, 'tasks.json'),
      command: [process.execPath, [...tsxFlags(webDir), entry]],
      stdio: 'ignore',
      killAfterMs: 300,
      stopKillAfterMs: 300,
      log: () => {},
    });
    stops.push(() => watcher.stop());
    try {
      await until(() => started().length === 1, 20_000);
      const [first] = started();
      // The process the watcher signals is the server itself, not a wrapper around it.
      expect(watcher.child().pid).toBe(first);

      watcher.restart('test');
      await until(() => started().length === 2, 20_000);
      expect(alive(first)).toBe(false);

      const second = started()[1];
      await watcher.stop();
      expect(alive(second)).toBe(false);
    } finally {
      for (const pid of started()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }, 60_000);
});

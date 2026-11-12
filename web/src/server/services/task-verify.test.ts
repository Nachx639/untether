import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  CHECK_NICE,
  checkAlive,
  checkConcurrency,
  checkDiskFrom,
  checkEnv,
  checkLoadFrom,
  checksFromCores,
  createDiskGate,
  createLimiter,
  createLoadGate,
  detectCheck,
  diskFullOutput,
  failedTestNames,
  onlyDocs,
  runCheck,
  tailLines,
  watchDisk,
  watchLoad,
  withToolDirs,
} from './task-verify';

let tmp: string;
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-verify-')));
});
afterAll(() => fs.rmSync(tmp, RM_TEST_DIR));

function fixture(name: string, files: Record<string, string>): string {
  const root = path.join(tmp, name);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'x', scripts, ...extra });

describe('onlyDocs', () => {
  it('is true only when every changed file is prose or a picture', () => {
    expect(onlyDocs(['docs/IDEAS_INKWELL.md', 'README.md', 'design/shot.PNG'])).toBe(true);
    expect(onlyDocs(['docs/IDEAS.md', 'server/app.py'])).toBe(false);
    expect(onlyDocs([])).toBe(false);
    // 2026-10-20: a .txt is prose only by its folder or name; manifests never are.
    expect(onlyDocs(['notes.txt', 'docs/plan.txt', 'LICENSE.txt', 'CHANGELOG.txt'])).toBe(true);
    for (const manifest of [
      'requirements.txt',
      'server/requirements-dev.txt',
      'constraints.txt',
      'CMakeLists.txt',
      'src/data.txt',
    ]) {
      expect(onlyDocs([manifest]), manifest).toBe(false);
    }
  });
});

describe('detectCheck', () => {
  it('pnpm workspace: nearest package per changed file, deduped, lockfile at the root', () => {
    const root = fixture('pnpm-ws', {
      'pnpm-lock.yaml': '',
      'package.json': pkg({ check: 'turbo check' }),
      'packages/web/package.json': pkg({ lint: 'biome check', typecheck: 'tsc', test: 'vitest' }),
      'packages/api/package.json': pkg({ test: 'vitest run' }),
      'packages/docs/package.json': pkg({}),
    });
    expect(
      detectCheck(root, [
        'packages/web/src/a.ts',
        'packages/web/src/b.ts',
        'packages/api/index.ts',
        'packages/docs/readme.md',
        'README.md',
      ])
    ).toEqual([
      {
        cwd: path.join(root, 'packages/web'),
        command: 'pnpm run lint && pnpm run typecheck && pnpm run test run',
        reason: 'package.json (pnpm): lint, typecheck, test',
      },
      {
        cwd: path.join(root, 'packages/api'),
        command: 'pnpm run test',
        reason: 'package.json (pnpm): test',
      },
      // docs has no scripts → falls back to the workspace root.
      { cwd: root, command: 'pnpm run check', reason: 'package.json (pnpm): check' },
    ]);
  });

  it('npm: check script, vitest watch gets `-- run`, placeholder test ignored', () => {
    const a = fixture('npm-a', {
      'package-lock.json': '{}',
      'package.json': pkg({ check: 'x', test: 'vitest --coverage' }),
    });
    expect(detectCheck(a, ['src/x.ts'])[0].command).toBe('npm run check && npm run test -- run');
    const b = fixture('npm-b', {
      'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .' }),
    });
    expect(detectCheck(b, ['index.js'])[0].command).toBe('npm run lint');
  });

  it('packageManager field and other lockfiles', () => {
    const y = fixture('yarn', { 'yarn.lock': '', 'package.json': pkg({ test: 'jest' }) });
    expect(detectCheck(y, ['a.js'])[0].command).toBe('yarn run test');
    const b = fixture('bun', { 'bun.lock': '', 'package.json': pkg({ test: 'bun test' }) });
    expect(detectCheck(b, ['a.ts'])[0].command).toBe('bun run test');
    const p = fixture('pm-field', {
      'package.json': pkg({ test: 'node --test' }, { packageManager: 'pnpm@9.0.0' }),
    });
    expect(detectCheck(p, ['a.ts'])[0].command).toBe('pnpm run test');
  });

  it('Makefile prefers check over test, ignores Makefiles without either', () => {
    const m = fixture('make', { Makefile: 'build:\n\tcc\ntest:\n\t./t\ncheck: test\n\tlint\n' });
    expect(detectCheck(m, ['main.c'])).toEqual([
      { cwd: m, command: 'make check', reason: 'Makefile: check' },
    ]);
    const n = fixture('make-none', { Makefile: 'build:\n\tcc\n' });
    expect(detectCheck(n, ['main.c'])).toEqual([]);
  });

  it('cargo, go and pytest', () => {
    const root = fixture('poly', {
      'rust/Cargo.toml': '[package]\nname="x"\n',
      'go/go.mod': 'module x\n',
      'py/pyproject.toml': '[tool.pytest.ini_options]\n',
      'py2/conftest.py': '',
      'py2/uv.lock': '',
    });
    expect(
      detectCheck(root, ['rust/src/main.rs', 'go/main.go', 'py/pkg/mod.py', 'py2/t.py']).map(
        (c) => [path.relative(root, c.cwd), c.command]
      )
    ).toEqual([
      ['rust', 'cargo test --quiet'],
      ['go', 'go test ./...'],
      ['py', 'python3 -m pytest -q'],
      ['py2', 'uv run pytest -q'],
    ]);
  });

  it("a tests folder uses its package's uv or .venv one folder up (2026-10-18: atlas)", () => {
    const root = fixture('py-up', {
      'server/pyproject.toml': '[tool.pytest.ini_options]\n',
      'server/uv.lock': '',
      'server/tests/conftest.py': '',
      'api/.venv/bin/python': '',
      'api/tests/conftest.py': '',
    });
    expect(
      detectCheck(root, ['server/tests/test_a.py', 'api/tests/test_b.py']).map((c) => [
        path.relative(root, c.cwd),
        c.command,
      ])
    ).toEqual([
      ['server/tests', 'uv run pytest -q'],
      ['api/tests', '../.venv/bin/python -m pytest -q'],
    ]);
  });

  it('no manifest, Xcode only, escaping paths and node_modules yield nothing', () => {
    const root = fixture('none', {
      'App.xcodeproj/project.pbxproj': '',
      'App/main.swift': '',
      'node_modules/x/package.json': pkg({ test: 'x' }),
    });
    expect(detectCheck(root, ['App/main.swift', '../outside.ts', 'node_modules/x/a.js'])).toEqual(
      []
    );
  });

  it('works for deleted files (folder no longer exists)', () => {
    const root = fixture('deleted', { 'package.json': pkg({ test: 'node --test' }) });
    expect(detectCheck(root, ['gone/dir/file.ts'])).toHaveLength(1);
  });
});

describe('runCheck', () => {
  it('runs with the Node the project asks for, first on PATH after the login profile (2026-11-02)', async () => {
    const bin = path.join(tmp, 'fake-node24/bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho v24.21.0\n', { mode: 0o755 });
    const logPath = path.join(tmp, 'logs/node/verify.log');
    const result = await runCheck({
      command: 'node -v; command -v node',
      cwd: tmp,
      timeoutSec: 20,
      logPath,
      node: {
        kind: 'switch',
        requirements: [{ range: '>=22.12.0 <25', source: 'package.json (engines.node)' }],
        defaultVersion: '26.12.1',
        node: { version: '24.21.0', bin, source: 'nvm' },
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.tail.split('\n').slice(-2)).toEqual(['v24.21.0', path.join(bin, 'node')]);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('# node: Node v24.21.0 (nvm');
  });

  it('checkAlive tells the doctor a silent check still lives, and forgets it once done (2026-11-08)', async () => {
    const dir = path.join(tmp, 'alive');
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(tmp, 'logs/alive/verify.log');
    expect(checkAlive(logPath)).toBeUndefined();
    // Prints nothing until told to end: what a quiet tsc under load looks like.
    const done = runCheck({
      command: 'touch started; while [ ! -f go ]; do sleep 0.05; done',
      cwd: dir,
      timeoutSec: 60,
      logPath,
    });
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(path.join(dir, 'started')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(checkAlive(logPath)).toBe(true);
    fs.writeFileSync(path.join(dir, 'go'), '');
    expect((await done).exitCode).toBe(0);
    expect(checkAlive(logPath)).toBeUndefined();
  });

  it('a check that fails with no fitting Node says so last, in its tail', async () => {
    const node = {
      kind: 'missing' as const,
      requirements: [{ range: '<25', source: 'web/package.json (engines.node)' }],
      defaultVersion: '26.12.1',
      installed: [],
    };
    const failed = await runCheck({
      command: 'echo "ERR_PNPM_UNSUPPORTED_ENGINE"; false',
      cwd: tmp,
      timeoutSec: 20,
      logPath: path.join(tmp, 'logs/node-missing/verify.log'),
      node,
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.tail.split('\n').pop()).toMatch(
      /^# The project asks for Node "<25".*no installed Node fits/
    );
    const passed = await runCheck({
      command: 'true',
      cwd: tmp,
      timeoutSec: 20,
      logPath: path.join(tmp, 'logs/node-missing-ok/verify.log'),
      node,
    });
    expect(passed.tail).not.toContain('no installed Node fits');
  });

  it('true → exit 0 with output in the log and tail', async () => {
    const logPath = path.join(tmp, 'logs/a/verify.log');
    const result = await runCheck({
      command: 'echo "ci=$CI extra=$EXTRA"; true',
      cwd: tmp,
      timeoutSec: 20,
      logPath,
      env: { EXTRA: 'yes' },
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    // A login shell may print its own lines first; ours is the last.
    expect(result.tail.split('\n').pop()).toBe('ci=1 extra=yes');
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('ci=1 extra=yes');
    expect(log).toContain('# exit 0');
  });

  it('false → non-zero exit; tail keeps only the last 40 lines', async () => {
    const result = await runCheck({
      command: 'for i in $(seq 1 100); do echo "line $i"; done; echo boom >&2; false',
      cwd: tmp,
      timeoutSec: 20,
      logPath: path.join(tmp, 'logs/b/verify.log'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    const lines = result.tail.split('\n');
    expect(lines).toHaveLength(40);
    expect(lines[lines.length - 1]).toBe('boom');
    expect(lines[0]).toBe('line 62');
  });

  it('ends when the shell exits, not when a background child lets go of its output (2026-10-20)', async () => {
    const started = Date.now();
    const result = await runCheck({
      command: 'echo ok; sleep 30 & exit 0',
      cwd: tmp,
      timeoutSec: 10,
      logPath: path.join(tmp, 'logs/d/verify.log'),
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.tail.split('\n').pop()).toBe('ok');
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it('a timed-out check never reports exit code 0', async () => {
    const result = await runCheck({
      command: "trap 'exit 0' TERM; sleep 30 & wait",
      cwd: tmp,
      timeoutSec: 1,
      logPath: path.join(tmp, 'logs/e/verify.log'),
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 15_000);

  it('timeout kills the process group', async () => {
    const started = Date.now();
    const result = await runCheck({
      command: 'echo start; sleep 30 & wait',
      cwd: tmp,
      timeoutSec: 1,
      logPath: path.join(tmp, 'logs/c/verify.log'),
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.tail).toContain('timed out after 1s');
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);

  it('stopped through its signal (2026-10-31: the review found problems first): the group goes, never a pass', async () => {
    const started = Date.now();
    const controller = new AbortController();
    const pidFile = path.join(tmp, 'child.pid');
    const pending = runCheck({
      command: `trap 'exit 0' TERM; sleep 30 & echo $! > ${pidFile}; wait`,
      cwd: tmp,
      timeoutSec: 60,
      logPath: path.join(tmp, 'logs/s/verify.log'),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), { timeout: 5_000 });
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.tail).toContain('stopped');
    expect(Date.now() - started).toBeLessThan(8_000);
    const child = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow(), { timeout: 7_000 });
  }, 20_000);

  it('a signal aborted before it starts stops it at once', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCheck({
      command: 'sleep 30',
      cwd: tmp,
      timeoutSec: 60,
      logPath: path.join(tmp, 'logs/s2/verify.log'),
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
  }, 15_000);
});

describe('tailLines', () => {
  it('strips ANSI and carriage returns', () => {
    expect(tailLines('\x1b[31mred\x1b[0m\r\nok\n\n')).toBe('red\nok');
  });
});

describe('createLimiter', () => {
  it('fast lane: an urgent one takes the next free slot, even marked while it waits (2026-11-01)', async () => {
    const limiter = createLimiter(1);
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const marked = new Set<string>();
    const job = (id: string) =>
      limiter.run(
        () => new Promise<void>((resolve) => releases.set(id, resolve)),
        () => started.push(id),
        undefined,
        () => marked.has(id)
      );
    const all = ['a', 'b', 'c', 'd'].map(job);
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(['a']);
    marked.add('d');
    releases.get('a')?.();
    await vi.waitFor(() => expect(started).toEqual(['a', 'd']));
    releases.get('d')?.();
    await vi.waitFor(() => expect(started).toEqual(['a', 'd', 'b']));
    releases.get('b')?.();
    await vi.waitFor(() => expect(started).toEqual(['a', 'd', 'b', 'c']));
    releases.get('c')?.();
    await Promise.all(all);
  });

  it('runs at most N at once and reports queued tasks', async () => {
    const limiter = createLimiter(2);
    const releases: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const jobs = [0, 1, 2, 3].map((i) =>
      limiter.run(
        () =>
          new Promise<number>((resolve) => {
            running++;
            peak = Math.max(peak, running);
            releases.push(() => {
              running--;
              resolve(i);
            });
          }),
        () => started.push(i)
      )
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(limiter.active).toBe(2);
    expect(limiter.queued).toBe(2);
    expect(started).toEqual([0, 1]);
    while (releases.length || started.length < 4) {
      releases.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
    expect(limiter.active).toBe(0);
  });

  it('a waiting task whose signal aborts leaves the line and never runs (2026-10-31)', async () => {
    const limiter = createLimiter(1);
    let release: () => void = () => {};
    const busy = limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
    const controller = new AbortController();
    const task = vi.fn(async () => 1);
    const waiting = limiter.run(task, undefined, controller.signal);
    const after = limiter.run(async () => 2);
    expect(limiter.queued).toBe(2);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(limiter.queued).toBe(1);
    release();
    await busy;
    expect(await after).toBe(2);
    expect(task).not.toHaveBeenCalled();
    // Already aborted: never queued.
    await expect(limiter.run(task, undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('frees the slot when a task rejects', async () => {
    const limiter = createLimiter(1);
    await expect(limiter.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(limiter.run(async () => 5)).resolves.toBe(5);
  });
});

describe('checkEnv', () => {
  it("drops what the server's own runtime set (2026-10-18: NODE_ENV=development)", () => {
    expect(
      checkEnv(
        {
          PATH: '/bin',
          HOME: '/Users/n',
          NODE_ENV: 'development',
          NODE_OPTIONS: '--inspect',
          npm_lifecycle_event: 'dev',
          PNPM_SCRIPT_SRC_DIR: '/x',
          UNTETHER_SESSION_ID: 's1',
        },
        () => false
      )
    ).toEqual({ PATH: '/bin', HOME: '/Users/n' });
  });
});

describe('runCheck priority', () => {
  it("runs the check below the user's own work (2026-10-23: load ~270)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-nice-'));
    const result = await runCheck({
      command: 'ps -o nice= -p $$',
      cwd: dir,
      timeoutSec: 20,
      logPath: path.join(dir, 'log'),
    });
    expect(result.exitCode).toBe(0);
    // To that level, never stacked (a check of Untether itself already runs niced).
    expect(Number(result.tail.trim())).toBe(Math.max(os.getPriority(), CHECK_NICE));
    fs.rmSync(dir, RM_TEST_DIR);
  });
});

describe('withToolDirs', () => {
  it("adds toolchain dirs a login zsh would miss (2026-10-22: cargo only on ~/.profile's PATH)", () => {
    const has = (dir: string) => dir === '/Users/n/.cargo/bin' || dir === '/Users/n/.local/bin';
    expect(withToolDirs('/usr/bin:/bin', '/Users/n', has)).toBe(
      '/usr/bin:/bin:/Users/n/.cargo/bin:/Users/n/.local/bin'
    );
    expect(withToolDirs('/Users/n/.cargo/bin:/bin', '/Users/n', has)).toBe(
      '/Users/n/.cargo/bin:/bin:/Users/n/.local/bin'
    );
    expect(withToolDirs('/bin', undefined, has)).toBe('/bin');
  });
});

describe('load gate (2026-10-24: load 94-120 on 12 cores)', () => {
  const gate = (load: () => number, settings = { maxLoadPerCore: 2, maxWaitSec: 600 }) =>
    createLoadGate({ settings: () => settings, loadavg: load, cores: () => 12, pollMs: 5000 });

  afterEach(() => vi.useRealTimers());

  it('is high over maxLoadPerCore × cores; 0 turns it off', () => {
    expect(gate(() => 24).sample()).toEqual({ load: 24, threshold: 24, high: false });
    expect(gate(() => 94).sample()).toMatchObject({ threshold: 24, high: true });
    expect(gate(() => 94, { maxLoadPerCore: 0, maxWaitSec: 600 }).sample().high).toBe(false);
  });

  it('config.json checkLoad: each field defaulted on its own', () => {
    expect(checkLoadFrom(undefined)).toEqual({
      maxLoadPerCore: 2,
      maxWaitSec: 600,
      maxConcurrent: 0,
      maxSlotWaitSec: 1800,
    });
    expect(checkLoadFrom({ maxWaitSec: 60 })).toEqual({
      maxLoadPerCore: 2,
      maxWaitSec: 60,
      maxConcurrent: 0,
      maxSlotWaitSec: 1800,
    });
    expect(checkLoadFrom({ maxSlotWaitSec: 300 }).maxSlotWaitSec).toBe(300);
    expect(checkLoadFrom({ maxConcurrent: 3 }).maxConcurrent).toBe(3);
  });

  it('the limiter starts no check while the Mac is loaded, and one when the load drops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    let load = 120;
    const limiter = createLimiter(
      2,
      gate(() => load)
    );
    const started: number[] = [];
    const jobs = [0, 1].map((i) =>
      limiter.run(
        async () => i,
        () => started.push(i)
      )
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toEqual([]);
    expect(limiter.queued).toBe(2);
    load = 20;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await Promise.all(jobs)).toEqual([0, 1]);
    expect(started).toEqual([0, 1]);
  });

  it('starts anyway after maxWaitSec, so a Mac that never quiets down still gets its checks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const limiter = createLimiter(
      2,
      gate(() => 120)
    );
    const started: number[] = [];
    const job = limiter.run(
      async () => 'ran',
      () => started.push(0)
    );
    await vi.advanceTimersByTimeAsync(595_000);
    expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await job).toBe('ran');
  });

  it('a check in line before a restart keeps its place and its "start anyway" deadline (2026-11-02)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const limiter = createLimiter(
      1,
      gate(() => 120)
    );
    const started: string[] = [];
    // Joined just now, and one that had waited 9 min 50 s under the previous server.
    const fresh = limiter.run(
      async () => 'fresh',
      () => started.push('fresh')
    );
    const waited = limiter.run(
      async () => 'waited',
      () => started.push('waited'),
      undefined,
      undefined,
      undefined,
      Date.now() - 590_000
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await waited).toBe('waited');
    expect(started).toEqual(['waited']);
    // A "since" in the future is taken as now.
    const late = limiter.run(
      async () => 'late',
      () => started.push('late'),
      undefined,
      undefined,
      undefined,
      Date.now() + 3_600_000
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await fresh).toBe('fresh');
    expect(await late).toBe('late');
    expect(started).toEqual(['waited', 'fresh', 'late']);
  });

  it('waitForLow: true once the load drops, false after the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    let load = 120;
    const dropped = gate(() => load).waitForLow();
    await vi.advanceTimersByTimeAsync(10_000);
    load = 5;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await dropped).toBe(true);
    const never = gate(() => 120, { maxLoadPerCore: 2, maxWaitSec: 60 }).waitForLow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await never).toBe(false);
  });

  it('waitForLow: a stopped check stops waiting, long before the wait runs out (2026-11-10)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const stop = new AbortController();
    let done = false;
    const waiting = gate(() => 120, { maxLoadPerCore: 2, maxWaitSec: 600 })
      .waitForLow(stop.signal)
      .then((dropped) => {
        done = true;
        return dropped;
      });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).toBe(false);
    stop.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await waiting).toBe(false);
  });
});

describe('disk gate (2026-11-01: ~1 GB free, claude-mem index at 81 GB)', () => {
  const GB = 1024 * 1024 * 1024;
  // Simulated volumes: the repo's and the worktrees' (statfs never reads the real disk).
  const free: Record<string, number> = {};
  const gate = (settings = { minFreeGB: 5, minFreePercent: 2 }) =>
    createDiskGate({
      settings: () => settings,
      statfs: (dir) => ({ freeBytes: (free[dir] ?? 100) * GB, totalBytes: 500 * GB }),
      pollMs: 1000,
    });
  // Real folders, so the gate's walk up to an existing folder stops at them.
  const repo = () => fs.mkdtempSync(path.join(tmp, 'repo-'));

  afterEach(() => {
    vi.useRealTimers();
    for (const key of Object.keys(free)) delete free[key];
  });

  it('is low under minFreeGB or under minFreePercent of the volume, on either path; 0 turns each off', () => {
    const a = repo();
    const b = repo();
    expect(gate().sample([a, b])).toMatchObject({ low: false, freeBytes: 100 * GB });
    free[b] = 4;
    expect(gate().sample([a, b])).toMatchObject({ path: b, low: true, freeBytes: 4 * GB });
    // 8 GB of 500 is 1.6 %: low by share though over 5 GB.
    free[b] = 8;
    expect(gate().sample([a, b])?.low).toBe(true);
    expect(gate({ minFreeGB: 5, minFreePercent: 0 }).sample([a, b])?.low).toBe(false);
    free[b] = 1;
    expect(gate({ minFreeGB: 0, minFreePercent: 0 }).sample([a, b])?.low).toBe(false);
    // A worktree not made yet is looked at through the folder above it.
    expect(gate().sample([path.join(b, 'wt', 'new')])).toMatchObject({ path: b, low: true });
  });

  it('config.json checkDisk: each field defaulted on its own', () => {
    expect(checkDiskFrom(undefined)).toEqual({ minFreeGB: 5, minFreePercent: 2 });
    expect(checkDiskFrom({ minFreeGB: 20 })).toEqual({ minFreeGB: 20, minFreePercent: 2 });
  });

  it('closed: the limiter starts no check while the disk is low, says so, and never starts anyway', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const dir = repo();
    free[dir] = 1;
    const disk = gate();
    // A load gate that would have started it anyway after 60 s: the disk does not.
    const load = createLoadGate({
      settings: () => ({ maxLoadPerCore: 2, maxWaitSec: 60 }),
      loadavg: () => 1,
      cores: () => 8,
    });
    const limiter = createLimiter(2, load, Date.now, disk);
    const waits: (number | undefined)[] = [];
    const started: string[] = [];
    const job = limiter.run(
      async () => 'ran',
      () => started.push('a'),
      undefined,
      undefined,
      { paths: [dir], onWait: (low) => waits.push(low?.freeBytes) }
    );
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(started).toEqual([]);
    expect(limiter.queued).toBe(1);
    expect(waits).toEqual([1 * GB]);
    // Open: the disk recovered.
    free[dir] = 50;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await job).toBe('ran');
    expect(started).toEqual(['a']);
    expect(waits).toEqual([1 * GB, undefined]);
  });

  it('open: with room, a check starts at once and nobody hears of the disk', async () => {
    const dir = repo();
    const onWait = vi.fn();
    const limiter = createLimiter(2, undefined, Date.now, gate());
    expect(
      await limiter.run(async () => 7, undefined, undefined, undefined, { paths: [dir], onWait })
    ).toBe(7);
    expect(onWait).not.toHaveBeenCalled();
  });

  it('waitForSpace resolves once the disk recovers, or when aborted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const dir = repo();
    free[dir] = 1;
    let done = false;
    const wait = gate()
      .waitForSpace([dir])
      .then(() => {
        done = true;
      });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).toBe(false);
    free[dir] = 30;
    await vi.advanceTimersByTimeAsync(1_000);
    await wait;
    expect(done).toBe(true);
    const controller = new AbortController();
    free[dir] = 1;
    const aborted = gate().waitForSpace([dir], controller.signal);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(aborted).resolves.toBeUndefined();
  });

  it('watchDisk keeps the lowest moment while the check ran, even if the disk recovered by its end', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
    const dir = repo();
    const watch = watchDisk(gate(), [dir]);
    free[dir] = 3;
    await vi.advanceTimersByTimeAsync(1_000);
    free[dir] = 0.5;
    await vi.advanceTimersByTimeAsync(1_000);
    free[dir] = 80;
    expect(watch.stop()).toMatchObject({ low: true, freeBytes: 0.5 * GB });
    const quiet = watchDisk(gate(), [dir]);
    expect(quiet.stop()).toBeUndefined();
  });

  it('diskFullOutput: ENOSPC and the usual wordings, colored or not', () => {
    expect(diskFullOutput("Error: ENOSPC: no space left on device, write '/tmp/x'")).toBe(true);
    expect(diskFullOutput('\x1b[31mwrite error: No space left on device\x1b[0m')).toBe(true);
    expect(diskFullOutput('fatal: the disk is full')).toBe(true);
    expect(diskFullOutput('There is not enough disk space to complete the operation')).toBe(true);
    expect(
      diskFullOutput(' FAIL  login.test.ts > logs in\nAssertionError: expected 2 to be 3')
    ).toBe(false);
  });
});

describe('failedTestNames (2026-11-02: tests flaky under load are named, not hidden)', () => {
  // vitest 4.1's own output (CI=1), trimmed.
  const vitest = [
    '⎯⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯',
    ' FAIL  src/server/logger-fresh.test.ts [ src/server/logger-fresh.test.ts ]',
    'Error: Hook timed out in 10000ms.',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯',
    '\x1b[31m FAIL \x1b[39m src/test/e2e/sessions-api.e2e.test.ts > Sessions API > creates a session',
    'AssertionError: expected 500 to be 200 // Object.is equality',
    ' ❯ src/test/e2e/sessions-api.e2e.test.ts:40:5',
    '⎯⎯⎯⎯⎯⎯⎯[1/3]⎯',
    ' FAIL  src/server/services/shielded-tmux.test.ts > real tmux > keeps the session 15034ms',
    ' FAIL  src/server/services/shielded-tmux.test.ts > real tmux > keeps the session 15034ms',
    'Error: Test timed out in 15000ms.',
    '⎯⎯⎯⎯⎯⎯⎯[2/3]⎯',
    ' Tests  2 failed | 300 passed (302)',
  ].join('\n');

  it("vitest's FAIL lines, each once, durations dropped, a file that failed to load too", () => {
    expect(failedTestNames(vitest)).toEqual([
      'src/server/logger-fresh.test.ts [ src/server/logger-fresh.test.ts ]',
      'src/test/e2e/sessions-api.e2e.test.ts > Sessions API > creates a session',
      'src/server/services/shielded-tmux.test.ts > real tmux > keeps the session',
    ]);
  });

  it("bun's (fail) and Playwright's ✘ lines; nothing named by a lint or type error", () => {
    expect(failedTestNames('(fail) css watch > rebuilds [12.00ms]\n(pass) other')).toEqual([
      'css watch > rebuilds',
    ]);
    expect(
      failedTestNames('  ✘  3 [chromium] › ut-title.spec.ts:12:3 › sets the title (5.1s)')
    ).toEqual(['[chromium] › ut-title.spec.ts:12:3 › sets the title']);
    expect(failedTestNames('src/a.ts:3:1 lint/style/useConst\nFound 1 error.')).toEqual([]);
    expect(failedTestNames('')).toEqual([]);
  });

  it('at most max names', () => {
    const many = Array.from({ length: 50 }, (_, i) => ` FAIL  a.test.ts > t${i}`).join('\n');
    expect(failedTestNames(many)).toHaveLength(30);
    expect(failedTestNames(many, 5)).toHaveLength(5);
  });
});

describe('watchLoad (2026-11-02: the load during a check run, not only at its end)', () => {
  it('samples at the start, all along and at the end: peak, mean, high when any was', async () => {
    let load = 4;
    let memory: string | undefined;
    const gate = {
      sample: () => ({ load, threshold: 24, high: load > 24 || !!memory, memory }),
    };
    const watch = watchLoad(gate, 5);
    load = 60;
    await new Promise((resolve) => setTimeout(resolve, 40));
    load = 2;
    const seen = watch.stop();
    expect(seen.peak).toBe(60);
    expect(seen.threshold).toBe(24);
    expect(seen.high).toBe(true);
    expect(seen.samples).toBeGreaterThanOrEqual(3);
    expect(seen.mean).toBeGreaterThan(2);
    expect(seen.mean).toBeLessThan(60);

    const quiet = watchLoad({ sample: () => ({ load: 3, threshold: 24, high: false }) }, 1000);
    expect(quiet.stop()).toEqual({ peak: 3, mean: 3, threshold: 24, samples: 2 });

    memory = 'swap 9 GB in use';
    load = 1;
    const short = watchLoad(gate, 1000).stop();
    expect(short).toMatchObject({ peak: 1, high: true, memory: 'swap 9 GB in use' });
  });

  it('a gate that throws is skipped, not the check', () => {
    const watch = watchLoad({
      sample: () => {
        throw new Error('no loadavg');
      },
    });
    expect(watch.stop()).toEqual({ peak: 0, mean: 0, threshold: 0, samples: 0 });
  });
});

describe('checks per Mac (2026-11-02: two full checks at once starved each other)', () => {
  it('one per 6 cores, at least one (2 on 12 cores); checkLoad.maxConcurrent overrides', () => {
    expect(checksFromCores(4)).toBe(1);
    expect(checksFromCores(8)).toBe(1);
    expect(checksFromCores(12)).toBe(2);
    expect(checksFromCores(16)).toBe(2);
    expect(checksFromCores(24)).toBe(4);
    const settings = { maxLoadPerCore: 2, maxWaitSec: 600, maxConcurrent: 0 };
    expect(checkConcurrency(settings, 12)).toBe(2);
    expect(checkConcurrency({ ...settings, maxConcurrent: 3 }, 12)).toBe(3);
  });

  it('the limiter reads its limit each time a slot frees (a config edit counts at once)', async () => {
    let max = 1;
    const limiter = createLimiter(() => max);
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const jobs = [0, 1, 2].map((i) =>
      limiter.run(
        () => new Promise<void>((resolve) => releases.push(resolve)),
        () => started.push(i)
      )
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0]);
    expect(limiter.queued).toBe(2);
    max = 2;
    releases[0]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]), { timeout: 2000 });
    releases[1]();
    releases[2]();
    await Promise.all(jobs);
  });
});

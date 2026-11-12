import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  findInServerPath,
  QuickStartAvailability,
  type QuickStartAvailabilityOptions,
  type ShellRunner,
} from './quick-start-availability.js';

// Never the real login shell: every checker below gets a fake runner or a fake "zsh" script.
function checker(options: QuickStartAvailabilityOptions & { runShell: ShellRunner }) {
  return new QuickStartAvailability({
    findInPath: async () => false,
    getShell: () => '/bin/zsh',
    ...options,
  });
}

describe('QuickStartAvailability', () => {
  it('asks the login shell once, and only about what the PATH lacks', async () => {
    const runShell = vi.fn<ShellRunner>(async () => 'codex: command\ncrush: none\ngemini: none\n');
    const findInPath = vi.fn(async (program: string) =>
      ['claude', 'node', 'zsh'].includes(program)
    );
    const availability = checker({ findInPath, runShell });

    const answer = await availability.check(['claude', 'gemini', 'node', 'crush', 'codex', 'zsh']);

    expect(answer).toEqual({
      claude: true,
      codex: true,
      crush: false,
      gemini: false,
      node: true,
      zsh: true,
    });
    expect(runShell).toHaveBeenCalledTimes(1);
    expect(runShell).toHaveBeenCalledWith(
      '/bin/zsh',
      [
        '-i',
        '-l',
        '-c',
        expect.stringContaining('whence -w -- "$@"'),
        '--',
        'codex',
        'crush',
        'gemini',
      ],
      expect.any(AbortSignal)
    );
  });

  it('starts no shell when the PATH has everything', async () => {
    const runShell = vi.fn<ShellRunner>(async () => '');
    const availability = checker({ findInPath: async () => true, runShell });

    expect(await availability.check(['claude', 'zsh'])).toEqual({ claude: true, zsh: true });
    expect(runShell).not.toHaveBeenCalled();
  });

  it('counts an alias, function, builtin or command as there and only "none" as missing', async () => {
    const availability = checker({
      runShell: async () =>
        [
          'Last login: Fri Oct  3 on ttys001',
          '',
          'll: alias',
          'claude: function',
          'cd: builtin',
          'tool: command',
          'gone: none',
        ].join('\n'),
    });

    expect(await availability.check(['ll', 'claude', 'cd', 'tool', 'gone', 'unmentioned'])).toEqual(
      { ll: true, claude: true, cd: true, tool: true, gone: false, unmentioned: true }
    );
  });

  it('asks bash with `type -t`', async () => {
    const runShell = vi.fn<ShellRunner>(async () => '\nll: alias\ngone: none\n');
    const availability = checker({ getShell: () => '/opt/homebrew/bin/bash', runShell });

    expect(await availability.check(['ll', 'gone'])).toEqual({ ll: true, gone: false });
    const script = runShell.mock.calls[0][1][3];
    expect(script).toContain('type -t -- "$name"');
  });

  it('reports everything as available for a shell it cannot ask', async () => {
    const runShell = vi.fn<ShellRunner>(async () => 'gemini: none\n');
    const availability = checker({ getShell: () => '/opt/homebrew/bin/fish', runShell });

    expect(await availability.check(['gemini', 'codex'])).toEqual({ gemini: true, codex: true });
    expect(runShell).not.toHaveBeenCalled();
  });

  it('reports everything as available when the shell fails', async () => {
    const availability = checker({
      runShell: async () => {
        throw new Error('spawn /bin/zsh EACCES');
      },
    });

    expect(await availability.check(['gemini', 'codex'])).toEqual({ gemini: true, codex: true });
  });

  it('reports everything as available when the shell does not answer in time, and stops it', async () => {
    let signal: AbortSignal | undefined;
    const availability = checker({
      timeoutMs: 20,
      runShell: (_shell, _args, abortSignal) => {
        signal = abortSignal;
        return new Promise(() => {});
      },
    });

    expect(await availability.check(['gemini', 'codex'])).toEqual({ gemini: true, codex: true });
    expect(signal?.aborted).toBe(true);
  });

  it('never hands the shell a relative path or a name a session could not run through it', async () => {
    const runShell = vi.fn<ShellRunner>(async () => '/opt/tools/gone: none\n');
    const availability = checker({ runShell });

    expect(await availability.check(['./run.sh', 'bin/tool', 'we$ird', '/opt/tools/gone'])).toEqual(
      {
        './run.sh': true,
        'bin/tool': true,
        we$ird: true,
        '/opt/tools/gone': false,
      }
    );
    expect(runShell.mock.calls[0][1].slice(4)).toEqual(['--', '/opt/tools/gone']);
  });

  it('caches the answer for a few minutes and shares a check in progress', async () => {
    let now = 1_000_000;
    let finish: (stdout: string) => void = () => {};
    const runShell = vi.fn<ShellRunner>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const findInPath = vi.fn(async () => false);
    const availability = checker({ findInPath, runShell, cacheMs: 300_000, now: () => now });

    const first = availability.check(['gemini', 'codex']);
    const second = availability.check(['codex', 'gemini', 'gemini']);
    await vi.waitFor(() => expect(runShell).toHaveBeenCalledTimes(1));
    finish('gemini: none\ncodex: command\n');
    expect(await first).toEqual({ codex: true, gemini: false });
    expect(await second).toEqual({ codex: true, gemini: false });

    now += 299_000;
    expect(await availability.check(['gemini', 'codex'])).toEqual({ codex: true, gemini: false });
    expect(runShell).toHaveBeenCalledTimes(1);
    expect(findInPath).toHaveBeenCalledTimes(2);

    // Another list of quick starts is checked at once; an old answer is checked again.
    const other = availability.check(['gemini']);
    await vi.waitFor(() => expect(runShell).toHaveBeenCalledTimes(2));
    finish('gemini: command\n');
    expect(await other).toEqual({ gemini: true });

    now += 300_000;
    const later = availability.check(['gemini']);
    await vi.waitFor(() => expect(runShell).toHaveBeenCalledTimes(3));
    finish('gemini: none\n');
    expect(await later).toEqual({ gemini: false });
  });
});

describe('quick-start availability on this machine (no login shell)', () => {
  const dirs: string[] = [];
  const pids: number[] = [];
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, RM_TEST_DIR);
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ut-quick-start-'));
    dirs.push(dir);
    return dir;
  }

  function script(dir: string, name: string, body: string): string {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function backgroundPid(file: string): Promise<number> {
    await vi.waitFor(() =>
      expect(existsSync(file) && readFileSync(file, 'utf8').trim()).toBeTruthy()
    );
    const pid = Number(readFileSync(file, 'utf8').trim());
    pids.push(pid);
    return pid;
  }

  it('finds a program in the server PATH the way resolveCommand does (which)', async () => {
    const dir = tempDir();
    script(dir, 'ut-qs-installed', 'exit 0');
    writeFileSync(join(dir, 'ut-qs-not-executable'), 'echo no\n');
    process.env.PATH = `${dir}:${originalPath}`;

    expect(await findInServerPath('ut-qs-installed')).toBe(true);
    expect(await findInServerPath('ut-qs-not-executable')).toBe(false);
    expect(await findInServerPath('ut-qs-not-installed-anywhere')).toBe(false);
  });

  it('runs the shell with the names after "--" and reads its answer', async () => {
    // A stand-in "zsh" answering like `whence -w` for the arguments it is given.
    const zsh = script(
      tempDir(),
      'zsh',
      [
        'while [ "$1" != "--" ]; do shift; done; shift',
        'for name in "$@"; do',
        '  case "$name" in gemini|crush) echo "$name: none" ;; *) echo "$name: command" ;; esac',
        'done',
      ].join('\n')
    );
    const availability = new QuickStartAvailability({
      findInPath: async (program) => program === 'node',
      getShell: () => zsh,
    });

    expect(await availability.check(['gemini', 'codex', 'crush', 'node'])).toEqual({
      gemini: false,
      codex: true,
      crush: false,
      node: true,
    });
  });

  it('kills a shell that hangs, with what it started, and reports everything available', async () => {
    const dir = tempDir();
    const pidFile = join(dir, 'sleep.pid');
    const zsh = script(dir, 'zsh', `sleep 30 &\necho $! > '${pidFile}'\nwait`);
    const availability = new QuickStartAvailability({
      findInPath: async () => false,
      getShell: () => zsh,
      // Room for the shell to start and write its pid first: at 300 ms, under a loaded
      // machine's full test run, it was killed before that and the test waited for nothing.
      timeoutMs: 2000,
    });

    expect(await availability.check(['gemini'])).toEqual({ gemini: true });
    const sleeper = await backgroundPid(pidFile);
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false));
  });

  it('does not wait for something the profile left running in the background', async () => {
    const dir = tempDir();
    const pidFile = join(dir, 'sleep.pid');
    const zsh = script(dir, 'zsh', `echo 'gemini: none'\nsleep 30 &\necho $! > '${pidFile}'`);
    const availability = new QuickStartAvailability({
      findInPath: async () => false,
      getShell: () => zsh,
      timeoutMs: 4000,
    });

    const started = Date.now();
    expect(await availability.check(['gemini'])).toEqual({ gemini: false });
    expect(Date.now() - started).toBeLessThan(3000);
    await backgroundPid(pidFile);
  });
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../test/helpers/rm-test-dir.js';
import {
  type BuildInfo,
  commandsFromHelp,
  currentBuild,
  installedCliBinaries,
  isOlderBuild,
  missingCommands,
  readBinaryBuild,
  sameCommit,
} from './build-info.js';
import { cachedBinaryBuild, cliBuildCheck } from './services/doctor-checks.js';
import { HANDED_OVER_ENV } from './task-cli/types.js';
import { runTaskCli, TASK_CLI_HELP } from './task-cli.js';

// 2026-10-31, the real case: the app's CLI from 10-24 did not know `ut project connector`,
// which the dev server (10-31) did.
const OLD_HELP = TASK_CLI_HELP.split('\n')
  .filter((line) => !line.includes('ut project connector'))
  .join('\n');
const appCli: BuildInfo = {
  commit: 'e2e429fad',
  date: '2026-10-24T11:01:18+02:00',
  commands: commandsFromHelp(OLD_HELP),
  cli: '/Applications/Untether.app/Contents/Resources/untether',
};
const devServer: BuildInfo = {
  commit: '3e19e408',
  date: '2026-10-31T20:50:48+01:00',
  dev: true,
  commands: commandsFromHelp(TASK_CLI_HELP),
  cli: '/repo/web/bin/untether-dev',
};

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-test-'));
});
afterAll(() => {
  if (tmp) fs.rmSync(tmp, RM_TEST_DIR);
});

describe('build identity', () => {
  it('reads the commands from the usage text', () => {
    const commands = commandsFromHelp(TASK_CLI_HELP);
    expect(commands).toContain('ut task new');
    expect(commands).toContain('ut task done');
    expect(commands).toContain('ut project connector add');
    expect(commands).toContain('ut project auto-approve');
    expect(commands).not.toContain('ut task');
  });

  it('compares builds by commit, then date, then commands', () => {
    expect(sameCommit('e2e429fad', 'e2e429f')).toBe(true);
    expect(sameCommit('unknown', 'unknown')).toBe(false);
    expect(isOlderBuild(appCli, devServer)).toBe(true);
    expect(isOlderBuild(devServer, appCli)).toBe(false);
    expect(isOlderBuild(appCli, { ...devServer, commit: 'e2e429f' })).toBe(false);
    expect(
      isOlderBuild({ commit: 'aaaa', commands: [] }, { commit: 'bbbb', commands: ['ut a b'] })
    ).toBe(true);
    expect(missingCommands(appCli, devServer)).toEqual([
      'ut project connector add',
      'ut project connector list',
      'ut project connector revoke',
    ]);
  });

  it('a checkout reads its build from git and offers its own CLI', () => {
    const git = vi.fn(() => 'abc1234\n2026-10-31T20:00:00+01:00');
    const build = currentBuild({
      commit: 'development',
      git,
      repo: '/repo',
      exists: (file) => file === '/repo/web/bin/untether-dev',
      help: TASK_CLI_HELP,
    });
    expect(git).toHaveBeenCalledWith('/repo', ['log', '-1', '--format=%h%n%cI']);
    expect(build).toMatchObject({
      commit: 'abc1234',
      date: '2026-10-31T20:00:00+01:00',
      dev: true,
      cli: '/repo/web/bin/untether-dev',
    });
    expect(build.commands).toContain('ut project connector add');
  });

  it('a bundle carries its own commit and date, and is its own CLI', () => {
    expect(
      currentBuild({
        commit: 'e2e429fad',
        buildDate: '2026-10-24T11:01:18+02:00',
        execPath: '/Applications/Untether.app/Contents/Resources/untether',
      })
    ).toEqual({
      commit: 'e2e429fad',
      date: '2026-10-24T11:01:18+02:00',
      cli: '/Applications/Untether.app/Contents/Resources/untether',
    });
  });
});

describe('readBinaryBuild', () => {
  const bundleText = (help: string) =>
    [
      // This module's own search strings in a bundle must not count.
      'const COMMIT_MARK = Buffer.from(`GIT_${"COMMIT = "}`); var x = "GIT_COMMIT = \\"";',
      'var GIT_COMMIT = "e2e429fad" || "development";',
      'var BUILD_DATE = "2026-10-24T11:01:18+02:00" || new Date().toISOString();',
      `var TASK_CLI_HELP = \`${help}\`;`,
    ].join('\n');

  it('reads commit, date and commands from the bytes, never running the binary', async () => {
    const file = path.join(tmp, 'untether');
    fs.writeFileSync(
      file,
      Buffer.concat([Buffer.alloc(1000, 7), Buffer.from(bundleText(OLD_HELP))])
    );
    expect(await readBinaryBuild(file)).toEqual({
      commit: 'e2e429fad',
      date: '2026-10-24T11:01:18+02:00',
      commands: commandsFromHelp(OLD_HELP),
    });
  });

  it('finds the marks across its read chunks', async () => {
    const file = path.join(tmp, 'untether-big');
    // The 8 MiB chunk ends inside the usage text.
    const pad = 8 * 1024 * 1024 - 300;
    fs.writeFileSync(
      file,
      Buffer.concat([Buffer.alloc(pad, 1), Buffer.from(bundleText(OLD_HELP))])
    );
    const build = await readBinaryBuild(file);
    expect(build?.commit).toBe('e2e429fad');
    expect(build?.commands).toEqual(commandsFromHelp(OLD_HELP));
  });

  it('nothing for a script or a missing file', async () => {
    const file = path.join(tmp, 'script');
    fs.writeFileSync(file, "#!/usr/bin/env node\nrequire('../dist/untether-cli');\n");
    expect(await readBinaryBuild(file)).toBeUndefined();
    expect(await readBinaryBuild(path.join(tmp, 'none'))).toBeUndefined();
  });
});

describe('installedCliBinaries', () => {
  it('the binary next to the ut in PATH and the installed apps, without repeats', () => {
    const files = new Set([
      '/opt/homebrew/bin/ut',
      '/Applications/Untether.app/Contents/Resources/ut',
      '/Applications/Untether.app/Contents/Resources/untether',
      '/Users/me/Applications/Untether.app/Contents/Resources/untether',
    ]);
    const found = installedCliBinaries({
      pathEnv: '/usr/bin:/opt/homebrew/bin',
      home: '/Users/me',
      exists: (file) => files.has(file),
      realpath: (file) =>
        file === '/opt/homebrew/bin/ut' ? '/Applications/Untether.app/Contents/Resources/ut' : file,
    });
    expect(found).toEqual([
      {
        path: '/Applications/Untether.app/Contents/Resources/untether',
        via: 'the ut in PATH (/opt/homebrew/bin/ut)',
      },
      {
        path: '/Users/me/Applications/Untether.app/Contents/Resources/untether',
        via: "the app's CLI (/Users/me/Applications/Untether.app)",
      },
    ]);
  });
});

describe('the doctor: cli-build', () => {
  const installed = [
    { path: '/Applications/Untether.app/Contents/Resources/untether', via: 'the ut in PATH' },
  ];

  it('warns when the installed CLI lacks commands the server knows, with the fix', async () => {
    const check = cliBuildCheck({
      server: () => devServer,
      installed: () => installed,
      read: async () => appCli,
    });
    const [finding, ...rest] = await check.run();
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      key: 'cli-build:/Applications/Untether.app/Contents/Resources/untether:e2e429fad',
      check: 'cli-build',
      severity: 'warning',
    });
    expect(finding.problem).toContain('build e2e429fad, 2026-10-24');
    expect(finding.problem).toContain('build 3e19e408, 2026-10-31, development');
    expect(finding.problem).toContain('ut project connector add');
    expect(finding.problem).toContain('rebuild and reinstall the Untether app');
    expect(finding.problem).toContain('/repo/web/bin/untether-dev task|project');
  });

  it('only a note when it is older but knows every command; nothing when current', async () => {
    const older = await cliBuildCheck({
      server: () => devServer,
      installed: () => installed,
      read: async () => ({ ...appCli, commands: devServer.commands }),
    }).run();
    expect(older.map((finding) => finding.severity)).toEqual(['info']);
    const same = await cliBuildCheck({
      server: () => ({ ...appCli, cli: undefined }),
      installed: () => installed,
      read: async () => appCli,
    }).run();
    expect(same).toEqual([]);
    const unreadable = await cliBuildCheck({
      server: () => devServer,
      installed: () => installed,
      read: async () => undefined,
    }).run();
    expect(unreadable).toEqual([]);
  });

  it('reads a binary again only when it changed', async () => {
    let stamp = { size: 1, mtimeMs: 1 };
    const read = vi.fn(async () => appCli);
    const cached = cachedBinaryBuild(read, () => stamp);
    await cached('/x');
    await cached('/x');
    expect(read).toHaveBeenCalledTimes(1);
    stamp = { size: 2, mtimeMs: 2 };
    await cached('/x');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('ut tells when it is older or newer than the server', () => {
  function run(
    argv: string[],
    builds: { cli: BuildInfo; server?: BuildInfo },
    response?: unknown,
    more: { env?: Record<string, string>; handOver?: number | 'none' | 'fails' } = {}
  ) {
    const out: string[] = [];
    const err: string[] = [];
    const task = vi.fn(async () => response as never);
    const readStdin = vi.fn(async () => 'the body');
    const handOver = vi.fn(async () =>
      more.handOver === 'fails' ? undefined : ((more.handOver as number | undefined) ?? 0)
    );
    const code = runTaskCli('project', argv, {
      task,
      env: more.env ?? {},
      cwd: '/repo',
      readStdin,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      builds: { cli: () => builds.cli, server: async () => builds.server },
      ...(more.handOver === 'none' ? {} : { handOver }),
    });
    return { code, out, err, task, handOver, readStdin };
  }
  const refusal = (argv: string) => [
    'Error: this ut (build e2e429fad, 2026-10-24) is older than the running Untether server (build 3e19e408, 2026-10-31, development): its commands and options may differ, so it ran nothing.',
    'Fix: rebuild and reinstall the Untether app from the checkout the server runs from so its ut catches up.',
    "Until then, run the server's own CLI:",
    `  /repo/web/bin/untether-dev ${argv}`,
  ];

  // 2026-11-10: the app's ut ran `ut project tell untether --reply-to mhz2xp2 -` against a newer
  // development server; it did not know --reply-to and sent the text "mhz2xp2 -".
  it("an older ut hands the command, untouched, to the server's own CLI", async () => {
    const argv = ['tell', 'untether', '--reply-to', 'mhz2xp2', '-'];
    const { code, task, handOver, readStdin, err, out } = run(
      argv,
      { cli: appCli, server: devServer },
      undefined,
      { handOver: 7 }
    );
    expect(await code).toBe(7);
    expect(handOver).toHaveBeenCalledWith('/repo/web/bin/untether-dev', ['project', ...argv]);
    // It ran nothing itself and left stdin (the heredoc) for the server's CLI.
    expect(task).not.toHaveBeenCalled();
    expect(readStdin).not.toHaveBeenCalled();
    expect([...out, ...err]).toEqual([]);
  });

  it('help and unknown commands go to it too: the server may know them', async () => {
    for (const argv of [['help'], ['frobnicate', '--json'], []]) {
      const { code, handOver, out } = run(argv, { cli: appCli, server: devServer });
      expect(await code).toBe(0);
      expect(handOver).toHaveBeenCalledWith('/repo/web/bin/untether-dev', ['project', ...argv]);
      expect(out).toEqual([]);
    }
  });

  it('it refuses, with the command to run, when it cannot hand over', async () => {
    const argv = ['tell', 'untether', '--reply-to', 'mhz2xp2', 'two words'];
    const said = refusal("project tell untether --reply-to mhz2xp2 'two words'");
    // The server's CLI could not be run; this build cannot hand over; no CLI announced.
    const failed = run(argv, { cli: appCli, server: devServer }, undefined, { handOver: 'fails' });
    expect(await failed.code).toBe(1);
    expect(failed.err).toEqual(said);
    expect(failed.task).not.toHaveBeenCalled();
    const none = run(argv, { cli: appCli, server: devServer }, undefined, { handOver: 'none' });
    expect(await none.code).toBe(1);
    expect(none.err).toEqual(said);
    const { cli: _cli, ...noCli } = devServer;
    const unnamed = run(argv, { cli: appCli, server: noCli });
    expect(await unnamed.code).toBe(1);
    expect(unnamed.err).toEqual(said.slice(0, 2));
    expect(unnamed.handOver).not.toHaveBeenCalled();
    expect(unnamed.task).not.toHaveBeenCalled();
  });

  it('never hands over twice: a handed-over ut that is still older refuses', async () => {
    const { code, handOver, err, task } = run(
      ['show'],
      { cli: appCli, server: devServer },
      undefined,
      { env: { [HANDED_OVER_ENV]: '1' } }
    );
    expect(await code).toBe(1);
    expect(handOver).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
    expect(err).toEqual(refusal('project show'));
  });

  it('the same build, a newer ut or no server: it runs the command itself', async () => {
    const data = { ok: true, status: 'done', data: { repoPath: '/repo', settings: {} } };
    for (const builds of [
      { cli: devServer, server: devServer },
      { cli: devServer, server: appCli },
      { cli: appCli },
    ]) {
      const { code, handOver, task } = run(['show'], builds, data);
      expect(await code).toBe(0);
      expect(handOver).not.toHaveBeenCalled();
      expect(task).toHaveBeenCalledTimes(1);
    }
    const same = run(['frobnicate'], { cli: devServer, server: devServer });
    expect(await same.code).toBe(1);
    expect(same.err).toEqual([
      'Error: unknown command: ut project frobnicate',
      "Run 'ut project help' for usage.",
    ]);
  });

  it('the server does not know the op: it is the older one', async () => {
    const { code, err } = run(
      ['show'],
      { cli: devServer, server: appCli },
      { ok: false, code: 'bad-request', message: 'Unknown task command: project-show' }
    );
    expect(await code).toBe(1);
    expect(err).toEqual([
      'Error: Unknown task command: project-show',
      'The running Untether server (build e2e429fad, 2026-10-24) is older than this ut (build 3e19e408, 2026-10-31, development): restart Untether, or rebuild the app it runs from.',
    ]);
  });
});

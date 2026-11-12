import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  APP_BUILD_STAMP,
  type AppLag,
  appAbove,
  appBuildCheck,
  appLag,
  describeLag,
  gitIn,
  isInstalledApp,
  loadsInChild,
  nativeModulesLoadCheck,
  readAppBuild,
} from './installed-app.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
    .toString()
    .trim();

describe('the app a server runs under', () => {
  const table: Record<number, { ppid: number; command: string }> = {
    900: { ppid: 800, command: 'node /repo/web/node_modules/.bin/tsx watch src/cli.ts' },
    800: { ppid: 700, command: 'node /opt/homebrew/bin/pnpm run dev --port 4020' },
    700: { ppid: 600, command: '/bin/zsh -l -c exec pnpm run dev' },
    600: { ppid: 1, command: '/Applications/Untether.app/Contents/MacOS/Untether' },
    500: { ppid: 400, command: 'node server.js' },
    400: { ppid: 1, command: '/bin/zsh' },
  };
  const processOf = async (pid: number) => table[pid];

  it('is the app bundle among its ancestors', async () => {
    expect(await appAbove(900, processOf)).toEqual({
      appPath: '/Applications/Untether.app',
      pid: 600,
    });
  });

  it('is none for a server started from a terminal', async () => {
    expect(await appAbove(500, processOf)).toBeUndefined();
  });

  it('is installed only in an Applications folder, not among Xcode products', () => {
    expect(isInstalledApp('/Applications/Untether.app', '/Users/u')).toBe(true);
    expect(isInstalledApp('/Users/u/Applications/Untether.app', '/Users/u')).toBe(true);
    expect(
      isInstalledApp(
        '/Users/u/Library/Developer/Xcode/DerivedData/Untether-x/Build/Products/Debug/Untether.app',
        '/Users/u'
      )
    ).toBe(false);
  });
});

describe('what an app bundle was built from', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-installed-app-'));
    fs.mkdirSync(path.join(tmp, 'A.app', 'Contents', 'Resources'), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, RM_TEST_DIR));

  it('is its stamp when the build left one', async () => {
    fs.writeFileSync(
      path.join(tmp, 'A.app', APP_BUILD_STAMP),
      JSON.stringify({ commit: 'abc123def', date: '2026-11-11T03:00:00+01:00' })
    );
    const readBinary = vi.fn();
    expect(await readAppBuild(path.join(tmp, 'A.app'), readBinary)).toEqual({
      commit: 'abc123def',
      date: '2026-11-11T03:00:00+01:00',
    });
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('is the commit of the CLI it packs when there is no stamp (or one that says nothing)', async () => {
    fs.writeFileSync(path.join(tmp, 'A.app', APP_BUILD_STAMP), '{"schemaVersion":1}');
    const readBinary = vi.fn(async () => ({ commit: 'addccfeb7' }));
    expect(await readAppBuild(path.join(tmp, 'A.app'), readBinary)).toEqual({
      commit: 'addccfeb7',
    });
    expect(readBinary).toHaveBeenCalledWith(
      path.join(tmp, 'A.app', 'Contents', 'Resources', 'untether')
    );
  });
});

describe('how far an app is behind its sources', () => {
  let repo: string;
  let built: string;
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };
  const commit = (message: string) => {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', message);
    return git(repo, 'rev-parse', '--short', 'HEAD');
  };

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-app-lag-')));
    git(repo, 'init', '-q', '-b', 'main');
    write('mac/Untether/App.swift', '// 1\n');
    write('web/src/server/server.ts', '// 1\n');
    write('web/bin/ut', '#!/bin/sh\n');
    built = commit('the commit the app was built from');
  });
  afterEach(() => fs.rmSync(repo, RM_TEST_DIR));

  const lagOf = (from = built) =>
    appLag(from, async (args) => {
      try {
        return git(repo, ...args);
      } catch {
        return undefined;
      }
    });

  it('is not behind at the commit it was built from', async () => {
    expect(await lagOf()).toMatchObject({ head: built, files: [], commits: 0 });
  });

  it('is not behind when only the server changed: the development server is not the app', async () => {
    write('web/src/server/server.ts', '// 2\n');
    write('docs/x.md', 'x\n');
    const head = commit('server only');
    expect(await lagOf()).toMatchObject({ head, files: [] });
  });

  it("is not behind when only the app's tests or documents changed", async () => {
    write('mac/UntetherTests/SomeTests.swift', '// 1\n');
    write('mac/docs/signing.md', 'x\n');
    write('mac/README.md', 'x\n');
    commit('tests and docs');
    expect((await lagOf())?.files).toEqual([]);
  });

  it('is behind when mac/ changed, and says what and in how many commits', async () => {
    write('mac/Untether/App.swift', '// 2\n');
    commit('mac 1');
    write('mac/Untether/Other.swift', '// 1\n');
    write('web/src/server/server.ts', '// 2\n');
    const head = commit('mac 2');
    const lag = (await lagOf()) as AppLag;
    expect(lag).toMatchObject({ head, commits: 2 });
    expect(lag.files.sort()).toEqual(['mac/Untether/App.swift', 'mac/Untether/Other.swift']);
    expect(lag.headDate).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it.each([
    ['web/bin/ut'],
    ['web/src/server/task-cli.ts'],
    ['native/ut-fwd/src/main.rs'],
    ['web/build-native.js'],
  ])('is behind when what it packs changed (%s)', async (file) => {
    write(file, 'changed\n');
    commit('packed');
    expect((await lagOf())?.files).toEqual([file]);
  });

  it('says nothing of an app built from a commit this checkout does not have', async () => {
    expect(await lagOf('0123456789abcdef0123456789abcdef01234567')).toMatchObject({
      unknown: true,
      files: [],
    });
  });

  it('reads the real git of a folder (gitIn), undefined when git fails', async () => {
    const real = gitIn(repo);
    expect(await real(['rev-parse', '--short', 'HEAD'])).toBe(built);
    expect(await real(['rev-parse', 'no-such-ref'])).toBeUndefined();
  });

  it('groups the changed files by what they are part of', () => {
    expect(
      describeLag(['mac/A.swift', 'mac/B.swift', 'web/bin/ut', 'native/ut-fwd/src/main.rs'])
    ).toBe('mac/ (2 files), web/bin/ut, native/ut-fwd/src/main.rs');
  });
});

describe("the doctor's app-build", () => {
  const app = { appPath: '/Applications/Untether.app', pid: 600 };
  const behind: AppLag = {
    head: 'bbb2222',
    headDate: '2026-11-11T04:00:00+01:00',
    files: ['mac/A.swift', 'web/bin/ut'],
    commits: 3,
  };
  const check = (over: Partial<Parameters<typeof appBuildCheck>[0]> = {}) =>
    appBuildCheck({
      app: () => app,
      build: async () => ({ commit: 'aaa1111', date: '2026-11-02T01:55:00+01:00' }),
      lag: async () => behind,
      autoUpdate: () => false,
      ...over,
    });

  it('is quiet for a server no installed app started', async () => {
    expect(await check({ app: () => undefined }).run()).toEqual([]);
  });

  it('is quiet when nothing the app is made of changed since its build', async () => {
    expect(await check({ lag: async () => ({ ...behind, files: [], commits: 0 }) }).run()).toEqual(
      []
    );
  });

  it('warns of an app behind its sources and says how to have it kept up', async () => {
    const [finding] = await check().run();
    expect(finding).toMatchObject({
      key: 'app-build:/Applications/Untether.app:aaa1111',
      check: 'app-build',
      severity: 'warning',
    });
    expect(finding.problem).toContain('build aaa1111, 2026-11-02');
    expect(finding.problem).toContain('3 commit(s) changed mac/A.swift, web/bin/ut');
    expect(finding.problem).toContain('autoUpdateInstalledApp');
  });

  it('only notes it when the automatic update is on and going ahead', async () => {
    const [finding] = await check({ autoUpdate: () => true }).run();
    expect(finding.severity).toBe('info');
    expect(finding.problem).toContain('rebuilds and replaces it by itself');
  });

  it('warns, with the reason, when the automatic update is on but held', async () => {
    const [finding] = await check({
      autoUpdate: () => true,
      held: () => 'the last attempt failed on bbb2222 (keychain)',
    }).run();
    expect(finding.severity).toBe('warning');
    expect(finding.problem).toContain('is held: the last attempt failed on bbb2222 (keychain)');
  });

  describe('with the update held but scheduled', () => {
    const now = Date.parse('2026-11-11T10:00:00+01:00');
    const held = 'at most one attempt every 6 h; the next in 99 min';
    const onTrack = (over: Partial<Parameters<typeof appBuildCheck>[0]> = {}) =>
      check({
        autoUpdate: () => true,
        held: () => held,
        schedule: () => ({ scheduled: true, lastFailed: false, everyHours: 6 }),
        now: () => now,
        ...over,
      });

    it('is only a note while the next attempt is scheduled and the lag is within 1.5 intervals', async () => {
      const [finding] = await onTrack().run();
      expect(finding.severity).toBe('info');
      expect(finding.problem).toContain('is held');
    });

    it('warns when the last attempt failed', async () => {
      const [finding] = await onTrack({
        schedule: () => ({ scheduled: true, lastFailed: true, everyHours: 6 }),
      }).run();
      expect(finding.severity).toBe('warning');
    });

    it('warns when nothing schedules the next attempt, or the update is off', async () => {
      const [unscheduled] = await onTrack({
        schedule: () => ({ scheduled: false, lastFailed: false, everyHours: 6 }),
      }).run();
      expect(unscheduled.severity).toBe('warning');
      const [off] = await onTrack({ autoUpdate: () => false }).run();
      expect(off.severity).toBe('warning');
    });

    it('warns when the lag passes 1.5 intervals (9 h with everyHours 6)', async () => {
      const late = Date.parse('2026-11-11T10:00:00+01:00') + 9 * 3_600_000 + 60_000;
      const [finding] = await onTrack({
        lag: async () => ({ ...behind, headDate: '2026-11-11T10:00:00+01:00' }),
        now: () => late,
      }).run();
      expect(finding.severity).toBe('warning');
      const [within] = await onTrack({
        lag: async () => ({ ...behind, headDate: '2026-11-11T10:00:00+01:00' }),
        now: () => late - 120_000,
      }).run();
      expect(within.severity).toBe('info');
    });
  });

  it('notes an app that does not say which commit it is', async () => {
    const [finding] = await check({ build: async () => undefined }).run();
    expect(finding).toMatchObject({
      key: 'app-build-unknown:/Applications/Untether.app',
      severity: 'info',
    });
  });
});

describe("the doctor's native-modules-load", () => {
  const file = '/repo/web/node_modules/authenticate-pam/build/Release/authenticate_pam.node';
  const setup = (loads: Array<string | undefined>, rebuild = vi.fn(async () => {})) => {
    let print = 'v1';
    const load = vi.fn(async () => loads.shift());
    const check = nativeModulesLoadCheck({
      modules: () => [
        { name: 'authenticate-pam', file },
        { name: 'node-pty', file: null },
      ],
      load,
      rebuild: async (name) => {
        await rebuild(name);
        print = `${print}+`;
      },
      fingerprint: () => print,
    });
    return { check, load, rebuild, touch: () => (print = `${print}!`) };
  };

  it('is quiet when the module loads, and does not open it again until the file changes', async () => {
    const { check, load, touch } = setup([undefined, undefined]);
    expect(await check.run()).toEqual([]);
    expect(await check.run()).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
    touch();
    expect(await check.run()).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rebuilds a module built for another Node and says it healed it', async () => {
    const { check, rebuild } = setup([
      'Error: The module was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 141.',
      undefined,
    ]);
    const [finding] = await check.run();
    expect(rebuild).toHaveBeenCalledWith('authenticate-pam');
    expect(finding).toMatchObject({
      key: 'native-modules-load:authenticate-pam',
      severity: 'critical',
    });
    expect(finding.problem).toContain('NODE_MODULE_VERSION 137');
    expect(finding.healed).toContain('rebuilt authenticate-pam');
    // Healed: the next pass is quiet.
    expect(await check.run()).toEqual([]);
  });

  it('says so when the rebuild does not help, and does not rebuild the same file again', async () => {
    const { check, rebuild } = setup(['Error: bad', 'Error: bad', 'Error: bad']);
    const [first] = await check.run();
    expect(first.healed).toBeUndefined();
    expect(first.problem).toContain('rebuilding it did not help');
    const [second] = await check.run();
    expect(second.key).toBe(first.key);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('says why when the rebuild itself fails', async () => {
    const { check } = setup(
      ['Error: bad'],
      vi.fn(async () => {
        throw new Error('node-gyp: no Xcode');
      })
    );
    const [finding] = await check.run();
    expect(finding.problem).toContain('rebuilding it failed: node-gyp: no Xcode');
  });

  it('opens a real addon in a child of this Node: one that loads, one that is not an addon', async () => {
    const pty = path.join(
      fs.realpathSync(path.dirname(require.resolve('node-pty/package.json'))),
      'build',
      'Release',
      'pty.node'
    );
    expect(await loadsInChild(pty)).toBeUndefined();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-not-addon-'));
    try {
      const bad = path.join(tmp, 'bad.node');
      fs.writeFileSync(bad, 'not a mach-o');
      expect(await loadsInChild(bad)).toMatch(/Error/);
    } finally {
      fs.rmSync(tmp, RM_TEST_DIR);
    }
  });
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  APP_BUILD_MARK,
  appBuildRunning,
  nativePtyCheck,
  registeredAppPaths,
  registeredAppsCheck,
  UNTETHER_BUNDLE_ID,
} from './doctor-checks-build.js';
import { nativeModulesLoadCheck } from './installed-app.js';

// 2026-11-12: during a release the doctor found node-pty's spawn-helper missing and rebuilt
// it while the app's build was rebuilding it too. The build keeps a mark while it runs
// (mac/scripts/build-web-frontend.sh) and the doctor rebuilds nothing meanwhile.
describe('the app build mark', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, RM_TEST_DIR);
  });
  const NOW = Date.parse('2026-11-12T03:50:00Z');
  const webDir = (mark?: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-build-mark-'));
    dirs.push(dir);
    if (mark !== undefined) fs.writeFileSync(path.join(dir, APP_BUILD_MARK), mark);
    return dir;
  };
  const seconds = (ms: number) => Math.floor(ms / 1000);

  it('is a build at work when its process lives', () => {
    const dir = webDir(`4242 ${seconds(NOW - 60_000)}\n`);
    expect(appBuildRunning(dir, { now: () => NOW, alive: (pid) => pid === 4242 })).toEqual({
      pid: 4242,
      since: seconds(NOW - 60_000) * 1000,
    });
  });

  it('is nothing without a mark, with a dead process, with a leftover of hours, or with nonsense', () => {
    const alive = () => true;
    expect(appBuildRunning(webDir(), { now: () => NOW, alive })).toBeUndefined();
    expect(
      appBuildRunning(webDir(`4242 ${seconds(NOW)}`), { now: () => NOW, alive: () => false })
    ).toBeUndefined();
    expect(
      appBuildRunning(webDir(`4242 ${seconds(NOW - 4 * 3600_000)}`), { now: () => NOW, alive })
    ).toBeUndefined();
    expect(appBuildRunning(webDir('building'), { now: () => NOW, alive })).toBeUndefined();
    expect(appBuildRunning(webDir(`1 ${seconds(NOW)}`), { now: () => NOW, alive })).toBeUndefined();
  });

  it('build-web-frontend.sh writes the mark the doctor reads, and removes it however it ends', () => {
    const script = fs.readFileSync(
      path.resolve(__dirname, '../../../../mac/scripts/build-web-frontend.sh'),
      'utf8'
    );
    expect(script).toContain(`APP_BUILD_MARK="\${WEB_DIR}/${APP_BUILD_MARK}"`);
    expect(script).toContain('echo "$$ $(date +%s)" > "${APP_BUILD_MARK}"');
    expect(script).toMatch(/trap 'rm -f "\$\{APP_BUILD_MARK\}"' EXIT/);
  });

  it('native-pty does not rebuild a missing spawn-helper while an app build is at work', async () => {
    let building: { pid: number; since: number } | undefined = { pid: 4242, since: NOW };
    let present = false;
    const rebuild = vi.fn(async () => {
      present = true;
    });
    const check = nativePtyCheck({
      helperPath: () => '/x/spawn-helper',
      rebuild,
      exists: () => present,
      building: () => building,
    });
    const [waiting] = await check.run();
    expect(rebuild).not.toHaveBeenCalled();
    expect(waiting.healed).toBeUndefined();
    expect(waiting.problem).toContain('an app build is at work in this checkout (pid 4242)');
    // The build ended and left it missing: now it is the doctor's.
    building = undefined;
    expect(await check.run()).toMatchObject([{ healed: 'node-pty rebuilt' }]);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('native-modules-load opens and rebuilds nothing while an app build is at work', async () => {
    let building = true;
    const load = vi.fn(async () => 'Error: NODE_MODULE_VERSION 137, requires 147');
    const rebuild = vi.fn(async () => {});
    const check = nativeModulesLoadCheck({
      modules: () => [{ name: 'authenticate-pam', file: '/x/authenticate_pam.node' }],
      load,
      rebuild,
      fingerprint: () => 'v1',
      building: () => building,
    });
    expect(await check.run()).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    building = false;
    const [finding] = await check.run();
    expect(finding.key).toBe('native-modules-load:authenticate-pam');
    expect(rebuild).toHaveBeenCalledWith('authenticate-pam');
  });
});

// 2026-11-12: macOS told the user "Untether is damaged and can't be opened" with the installed
// app intact: LaunchServices also knew build products and test bundles under the same
// identifier and opened one of those.
describe("the doctor's registered-apps", () => {
  const block = (appPath: string, identifier: string) =>
    [
      'bundle id:                  Untether (0x18a8)',
      `path:                       ${appPath} (0x18a8)`,
      'name:                       Untether',
      `identifier:                 ${identifier}`,
      'executable:                 Contents/MacOS/Untether',
    ].join('\n');
  const SEP = `\n${'-'.repeat(80)}\n`;
  const DUMP = [
    block('/Applications/Untether.app', UNTETHER_BUNDLE_ID),
    block(
      '/Users/n/Library/Developer/Xcode/DerivedData/Untether-abc/Build/Products/Release/Untether.app',
      UNTETHER_BUNDLE_ID
    ),
    block(
      '/Users/n/Projects/untether/mac/build/Build/Products/Release/Untether.app',
      UNTETHER_BUNDLE_ID
    ),
    block(
      '/private/var/folders/xh/T/untether-release-test.abc/toy/Untether.app',
      UNTETHER_BUNDLE_ID
    ),
    block(
      '/Users/n/Library/Developer/Xcode/DerivedData/Untether-abc/Build/Products/Debug/Untether.app',
      `${UNTETHER_BUNDLE_ID}.debug`
    ),
    block('/Applications/Other App.app', 'com.example.other'),
    block('/Users/n/Desktop/Untether.app', UNTETHER_BUNDLE_ID),
  ].join(SEP);

  it('reads the paths registered under an identifier, and only that identifier', () => {
    expect(registeredAppPaths(DUMP, UNTETHER_BUNDLE_ID)).toEqual([
      '/Applications/Untether.app',
      '/Users/n/Library/Developer/Xcode/DerivedData/Untether-abc/Build/Products/Release/Untether.app',
      '/Users/n/Projects/untether/mac/build/Build/Products/Release/Untether.app',
      '/private/var/folders/xh/T/untether-release-test.abc/toy/Untether.app',
      '/Users/n/Desktop/Untether.app',
    ]);
    expect(registeredAppPaths(DUMP, 'com.example.other')).toEqual(['/Applications/Other App.app']);
  });

  const setup = (over: { running?: string[]; gone?: string[] } = {}) => {
    let now = 0;
    const unregister = vi.fn(async (_appPath: string) => {});
    const registered = vi.fn(async () => registeredAppPaths(DUMP, UNTETHER_BUNDLE_ID));
    const check = registeredAppsCheck({
      registered,
      unregister,
      runningFrom: async (appPath) => (over.running ?? []).includes(appPath),
      exists: (file) => !(over.gone ?? []).includes(file),
      now: () => now,
    });
    return { check, unregister, registered, later: (ms: number) => (now += ms) };
  };

  it('is quiet when the only Untether macOS knows is the installed one', async () => {
    const check = registeredAppsCheck({
      registered: async () => ['/Applications/Untether.app'],
      unregister: vi.fn(),
      runningFrom: async () => false,
    });
    expect(await check.run()).toEqual([]);
  });

  it('unregisters build products and leftovers, and only tells a copy the user keeps', async () => {
    const { check, unregister } = setup();
    const findings = await check.run();
    expect(unregister.mock.calls.map(([appPath]) => appPath)).toEqual([
      '/Users/n/Library/Developer/Xcode/DerivedData/Untether-abc/Build/Products/Release/Untether.app',
      '/Users/n/Projects/untether/mac/build/Build/Products/Release/Untether.app',
      '/private/var/folders/xh/T/untether-release-test.abc/toy/Untether.app',
    ]);
    expect(findings.filter((finding) => finding.healed)).toHaveLength(3);
    const kept = findings.find((finding) => !finding.healed);
    expect(kept).toMatchObject({
      key: 'registered-apps:/Users/n/Desktop/Untether.app',
      severity: 'warning',
    });
    expect(kept?.problem).toContain('It is not a build product');
    expect(findings.some((finding) => finding.key.includes('/Applications/'))).toBe(false);
  });

  it('leaves a build product something runs from, and unregisters a copy that is gone', async () => {
    const running = '/Users/n/Projects/untether/mac/build/Build/Products/Release/Untether.app';
    const { check, unregister } = setup({
      running: [running],
      gone: ['/Users/n/Desktop/Untether.app'],
    });
    const findings = await check.run();
    expect(unregister).not.toHaveBeenCalledWith(running);
    expect(findings.find((finding) => finding.key.endsWith(running))?.problem).toContain(
      'Something runs from it'
    );
    expect(unregister).toHaveBeenCalledWith('/Users/n/Desktop/Untether.app');
  });

  it('reads the dump (tens of megabytes) once per half hour, and keeps telling what it left', async () => {
    const { check, registered, later } = setup();
    await check.run();
    later(5 * 60_000);
    const again = await check.run();
    expect(registered).toHaveBeenCalledTimes(1);
    expect(again.map((finding) => finding.key)).toEqual([
      'registered-apps:/Users/n/Desktop/Untether.app',
    ]);
    later(30 * 60_000);
    await check.run();
    expect(registered).toHaveBeenCalledTimes(2);
  });

  it('says so when unregistering fails', async () => {
    const check = registeredAppsCheck({
      registered: async () => ['/private/tmp/x/Untether.app'],
      unregister: async () => {
        throw new Error('lsregister: no');
      },
      runningFrom: async () => false,
      exists: () => true,
    });
    const [finding] = await check.run();
    expect(finding.healed).toBeUndefined();
    expect(finding.problem).toContain('unregistering it failed');
  });
});

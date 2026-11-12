import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { AppLag } from './installed-app.js';
import {
  type AppUpdateNotice,
  appUpdateFrom,
  buildFailure,
  DEFAULT_APP_UPDATE,
  InstalledAppUpdater,
  type InstalledAppUpdaterDeps,
  SWAP_LOST_MS,
  type SwapPlan,
} from './installed-app-updater.js';

const HOUR = 60 * 60 * 1000;
const START = Date.parse('2026-11-11T12:00:00Z');

describe('the installed app catches up by itself', () => {
  let dir: string;
  let now: number;
  let lag: AppLag;
  let enabled: boolean;
  let loadHigh: boolean;
  let busy: string | null;
  let buildResult: () => Promise<{ appPath: string }>;
  let notices: AppUpdateNotice[];
  let helperPlans: string[];
  let build: ReturnType<typeof vi.fn>;
  let slots: number;

  const builtApp = () => {
    const appPath = path.join(dir, 'products', 'Untether.app');
    fs.mkdirSync(path.join(appPath, 'Contents'), { recursive: true });
    return appPath;
  };

  const updater = (over: Partial<InstalledAppUpdaterDeps> = {}) =>
    new InstalledAppUpdater({
      enabled: () => enabled,
      app: async () => ({ appPath: '/Applications/Untether.app', pid: 600 }),
      appBuild: async () => ({ commit: 'aaa1111' }),
      lag: async () => lag,
      loadHigh: () => loadHigh,
      inCheckSlot: async (task) => {
        slots++;
        return task();
      },
      build: (commit) => build(commit),
      busy: () => busy,
      startHelper: (planPath) => helperPlans.push(planPath),
      swapCommands: () => ({
        quit: ['quit'],
        open: ['open'],
        healthUrl: 'http://127.0.0.1:1/api/health',
        serverGroup: 4242,
      }),
      notify: (notice) => notices.push(notice),
      dir: path.join(dir, 'app-update'),
      now: () => now,
      ...over,
    });

  const state = () =>
    JSON.parse(fs.readFileSync(path.join(dir, 'app-update', 'state.json'), 'utf8'));
  const writeResult = (result: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(dir, 'app-update', 'result.json'),
      JSON.stringify({ commit: 'bbb2222', at: new Date(now).toISOString(), ...result })
    );

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-app-updater-'));
    now = START;
    lag = {
      head: 'bbb2222',
      headDate: new Date(START - HOUR).toISOString(),
      files: ['mac/A.swift'],
      commits: 2,
    };
    enabled = true;
    loadHigh = false;
    busy = null;
    notices = [];
    helperPlans = [];
    slots = 0;
    buildResult = async () => ({ appPath: builtApp() });
    build = vi.fn(() => buildResult());
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  /** One look, and the build it may have started. */
  const look = async (u: InstalledAppUpdater) => {
    await u.tick();
    await u.settled();
  };

  it('does nothing with the setting off', async () => {
    enabled = false;
    await look(updater());
    expect(build).not.toHaveBeenCalled();
  });

  it('does nothing for a server no installed app started', async () => {
    await look(updater({ app: async () => undefined }));
    expect(build).not.toHaveBeenCalled();
  });

  it('does nothing while the app is not behind', async () => {
    lag = { ...lag, files: [], commits: 0 };
    await look(updater());
    expect(build).not.toHaveBeenCalled();
  });

  it('builds the head in a check slot, then swaps at the next quiet look and tells nobody yet', async () => {
    const u = updater();
    await look(u);
    expect(build).toHaveBeenCalledWith('bbb2222');
    expect(slots).toBe(1);
    expect(helperPlans).toEqual([]);

    await look(u);
    expect(helperPlans).toEqual([path.join(dir, 'app-update', 'plan.json')]);
    const plan = JSON.parse(fs.readFileSync(helperPlans[0], 'utf8')) as SwapPlan;
    expect(plan).toMatchObject({
      appPath: '/Applications/Untether.app',
      newAppPath: path.join(dir, 'products', 'Untether.app'),
      backupPath: path.join(dir, 'app-update', 'Untether.app.previous'),
      resultPath: path.join(dir, 'app-update', 'result.json'),
      commit: 'bbb2222',
      previousCommit: 'aaa1111',
      quit: ['quit'],
      open: ['open'],
      serverGroup: 4242,
    });
    // The phone hears of it after, never before.
    expect(notices).toEqual([]);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('never starts a build while the Mac is over its load threshold', async () => {
    loadHigh = true;
    const u = updater();
    await look(u);
    expect(build).not.toHaveBeenCalled();
    expect(u.heldBy()).toContain('load threshold');
  });

  it('gives its slot back unused when the load rose while it waited for it, and tries again later', async () => {
    const u = updater({
      inCheckSlot: async (task) => {
        loadHigh = true; // the limiter starts a waiting run anyway after its longest wait
        return task();
      },
    });
    await look(u);
    expect(build).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    loadHigh = false;
    // Not counted as an attempt: no six hours to wait.
    await look(updater());
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('waits for the sources to settle: a burst of merges is one build', async () => {
    lag = { ...lag, headDate: new Date(START - 60_000).toISOString() };
    const u = updater();
    await look(u);
    expect(build).not.toHaveBeenCalled();
    expect(u.heldBy()).toContain('settle');
    now += DEFAULT_APP_UPDATE.settleMin * 60_000;
    await look(u);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('holds a built app until nothing is going on, and says what it waits for', async () => {
    const u = updater();
    await look(u);
    busy = 'task "x" is verifying';
    await look(u);
    expect(helperPlans).toEqual([]);
    expect(u.heldBy()).toBe(
      'built bbb2222 0 min ago, waiting for a quiet moment (task "x" is verifying)'
    );
    busy = null;
    await look(u);
    expect(helperPlans).toHaveLength(1);
  });

  it('a build ready for hours is told to the phone once, with what holds it, and still swaps after', async () => {
    const u = updater();
    await look(u);
    busy = 'an agent was at work 12 s ago ("Bakery", session 457b54e4)';
    now += HOUR;
    await look(u);
    expect(notices).toEqual([]);
    now += DEFAULT_APP_UPDATE.waitNoticeHours * HOUR;
    await look(u);
    expect(notices).toEqual([
      {
        ok: false,
        waiting: true,
        commit: 'bbb2222',
        text: 'Untether\'s update to bbb2222 has been ready for 3 h 0 min and still waits for a quiet moment: an agent was at work 12 s ago ("Bakery", session 457b54e4)',
      },
    ]);
    expect(u.status()).toEqual({
      state: 'built-waiting',
      text: 'the app is build aaa1111, its sources are at bbb2222: built bbb2222 3 h 0 min ago, waiting for a quiet moment (an agent was at work 12 s ago ("Bakery", session 457b54e4))',
    });
    // Once per build, also across a restart of the server.
    now += 5 * HOUR;
    await look(u);
    await look(updater());
    expect(notices).toHaveLength(1);
    busy = null;
    await look(u);
    expect(helperPlans).toHaveLength(1);
    expect(u.status().state).toBe('swapping');
  });

  it('counts the wait of a built app whose state has no time from the first look on', async () => {
    const u = updater();
    await look(u);
    const saved = state();
    delete saved.built.at;
    fs.writeFileSync(path.join(dir, 'app-update', 'state.json'), JSON.stringify(saved));
    busy = 'a check is running';
    const next = updater();
    await look(next);
    expect(next.heldBy()).toContain('built bbb2222 0 min ago');
    now += DEFAULT_APP_UPDATE.waitNoticeHours * HOUR + 60_000;
    await look(next);
    expect(notices).toEqual([expect.objectContaining({ waiting: true, commit: 'bbb2222' })]);
  });

  it('tells the long wait of a commit built again after its bundle was lost', async () => {
    const u = updater();
    await look(u);
    busy = 'a check is running';
    now += 3 * HOUR;
    await look(u);
    expect(notices).toHaveLength(1);
    fs.rmSync(path.join(dir, 'products'), RM_TEST_DIR);
    busy = null;
    now += 7 * HOUR;
    await look(u);
    expect(build).toHaveBeenCalledTimes(2);
    busy = 'a check is running';
    now += 3 * HOUR;
    await look(u);
    expect(notices).toHaveLength(2);
  });

  it('always says in one line what it is doing', async () => {
    enabled = false;
    const off = updater();
    expect(off.status().state).toBe('not-looked');
    await look(off);
    expect(off.status()).toEqual({
      state: 'off',
      text: 'off (the autoUpdateInstalledApp setting)',
    });
    enabled = true;

    const none = updater({ app: async () => undefined });
    await look(none);
    expect(none.status().state).toBe('no-app');

    const upToDate = updater({ lag: async () => ({ ...lag, files: [], commits: 0 }) });
    await look(upToDate);
    expect(upToDate.status()).toEqual({
      state: 'up-to-date',
      text: 'up to date (the app is build aaa1111)',
    });

    let release: (() => void) | undefined;
    buildResult = () =>
      new Promise((resolve) => (release = () => resolve({ appPath: builtApp() })));
    const u = updater();
    await u.tick();
    expect(u.status()).toEqual({ state: 'building', text: 'building bbb2222' });
    now += 4 * 60_000;
    await u.tick();
    expect(u.status()).toEqual({ state: 'building', text: 'building bbb2222 for 4 min' });
    release?.();
    await u.settled();

    buildResult = async () => {
      throw new Error('** BUILD FAILED **');
    };
    lag = { ...lag, head: 'ccc3333' };
    fs.rmSync(path.join(dir, 'products'), RM_TEST_DIR);
    now += 7 * HOUR;
    const failing = updater();
    await look(failing);
    await look(failing);
    expect(failing.status()).toEqual({
      state: 'failed',
      text: 'the app is build aaa1111, its sources are at ccc3333: the last attempt failed on ccc3333 (build); it tries again when the sources move',
    });
  });

  it('tells the phone one line once the new server finds the result: updated', async () => {
    const u = updater();
    await look(u);
    await look(u);
    // The server died with the app; the next one starts and finds what the helper left.
    writeResult({ outcome: 'updated', previousCommit: 'aaa1111' });
    const next = updater();
    next.afterRestart();
    expect(notices).toEqual([
      { ok: true, commit: 'bbb2222', text: 'Untether updated itself to bbb2222' },
    ]);
    expect(fs.existsSync(path.join(dir, 'app-update', 'result.json'))).toBe(false);
    // Told once.
    next.afterRestart();
    updater().afterRestart();
    expect(notices).toHaveLength(1);
  });

  it.each([
    ['refused', 'signature', 'signature', "the new build's signature is not valid"],
    ['refused', 'signer', 'signer', 'macOS would ask every permission again'],
    ['refused', 'permission', 'permission', 'macOS did not allow replacing the app'],
    ['refused', 'app-did-not-quit', 'app-did-not-quit', 'the app did not quit'],
    ['rolled-back', 'no-answer', 'no-answer', 'the previous one is back'],
    ['broken', 'no-answer', 'broken', 'open Untether by hand'],
  ])('tells why it could not: %s / %s', async (outcome, reason, failure, words) => {
    const u = updater();
    await look(u);
    await look(u);
    writeResult({ outcome, reason, detail: 'the detail' });
    updater().afterRestart();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ ok: false, commit: 'bbb2222', failure });
    expect(notices[0].text).toContain('Untether could not update itself');
    expect(notices[0].text).toContain(words);
  });

  it('does not try the same sources again after a failure, and does when they move', async () => {
    const u = updater();
    await look(u);
    await look(u);
    writeResult({ outcome: 'rolled-back', reason: 'no-answer' });
    const next = updater();
    next.afterRestart();
    now += 24 * HOUR;
    await look(next);
    expect(build).toHaveBeenCalledTimes(1);
    expect(next.heldBy()).toContain('the last attempt failed on bbb2222');

    lag = { ...lag, head: 'ccc3333' };
    await look(next);
    expect(build).toHaveBeenLastCalledWith('ccc3333');
  });

  it('tells a result the helper left while this server stayed up (it refused before closing the app)', async () => {
    const u = updater();
    await look(u);
    await look(u);
    writeResult({ outcome: 'refused', reason: 'signer' });
    await look(u);
    expect(notices).toHaveLength(1);
    expect(notices[0].failure).toBe('signer');
  });

  it('takes a helper that never left a result for lost, and says so', async () => {
    const u = updater();
    await look(u);
    await look(u);
    now += SWAP_LOST_MS + 1000;
    await look(u);
    expect(notices).toEqual([expect.objectContaining({ ok: false, failure: 'helper-lost' })]);
  });

  it('builds at most once every everyHours, whatever moves meanwhile', async () => {
    buildResult = async () => {
      throw new Error('** BUILD FAILED **\nerror: something in Swift');
    };
    const u = updater();
    await look(u);
    expect(notices).toEqual([expect.objectContaining({ ok: false, failure: 'build' })]);
    lag = { ...lag, head: 'ccc3333' };
    now += 2 * HOUR;
    await look(u);
    expect(build).toHaveBeenCalledTimes(1);
    expect(u.heldBy()).toContain('at most one attempt every 6 h');
    now += 4 * HOUR;
    await look(u);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('a failed build is told once with its reason and not repeated on the same sources', async () => {
    buildResult = async () => {
      throw new Error(
        'build.sh ended with 1\nERROR: No signing identity found. Set SIGN_IDENTITY to a stable codesigning certificate.'
      );
    };
    const u = updater();
    await look(u);
    now += 24 * HOUR;
    await look(u);
    expect(build).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ ok: false, failure: 'signing', commit: 'bbb2222' });
    expect(notices[0].text).toContain('No signing identity found');
  });

  it('a server restarted under its own build builds again: that was not an attempt', async () => {
    let release: (() => void) | undefined;
    buildResult = () =>
      new Promise((resolve) => (release = () => resolve({ appPath: builtApp() })));
    const u = updater();
    await u.tick();
    expect(state().building).toMatchObject({ head: 'bbb2222' });
    // The server dies here (tsx reloads on a merge); the next one starts from the file.
    buildResult = async () => ({ appPath: builtApp() });
    const next = updater();
    await look(next);
    expect(build).toHaveBeenCalledTimes(2);
    release?.();
    await u.settled();
  });

  it('waits while a build of the previous server is still running in the worktree', async () => {
    const u = updater({ buildRunning: () => true });
    await look(u);
    expect(build).not.toHaveBeenCalled();
    expect(u.heldBy()).toContain('still running');
  });

  it('does not rebuild in a loop an app that still reads as older right after its update', async () => {
    const u = updater();
    await look(u);
    await look(u);
    writeResult({ outcome: 'updated' });
    const next = updater();
    next.afterRestart();
    // The app's build still says aaa1111 (a bundle without its stamp).
    now += 24 * HOUR;
    await look(next);
    expect(build).toHaveBeenCalledTimes(1);
    expect(next.heldBy()).toContain('already updated to bbb2222');
  });

  it('drops a built app whose bundle is gone and builds again when its turn comes', async () => {
    const u = updater();
    await look(u);
    fs.rmSync(path.join(dir, 'products'), RM_TEST_DIR);
    now += 7 * HOUR;
    await look(u);
    expect(helperPlans).toEqual([]);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('reads signing and keychain trouble from a build output', () => {
    expect(buildFailure('errSecInternalComponent')).toBe('keychain');
    expect(buildFailure('User interaction is not allowed.')).toBe('keychain');
    expect(buildFailure('ERROR: No signing identity found.')).toBe('signing');
    expect(buildFailure('Error: Code signature verification failed')).toBe('signing');
    expect(buildFailure('error: cannot find type Foo in scope')).toBe('build');
  });

  it('keeps its pacing settings within sane bounds', () => {
    expect(appUpdateFrom(undefined)).toEqual(DEFAULT_APP_UPDATE);
    expect(appUpdateFrom({ quietSec: 1, everyHours: 0, settleMin: -5 })).toEqual({
      quietSec: 10,
      everyHours: 0.25,
      settleMin: 0,
      waitNoticeHours: 2,
    });
    expect(appUpdateFrom({ quietSec: 300, everyHours: 12 })).toEqual({
      quietSec: 300,
      everyHours: 12,
      settleMin: 10,
      waitNoticeHours: 2,
    });
    expect(appUpdateFrom({ waitNoticeHours: 0 }).waitNoticeHours).toBe(0.25);
  });
});

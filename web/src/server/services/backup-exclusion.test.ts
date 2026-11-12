import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  BackupdWatch,
  BackupExclusion,
  backupdCpuFromPs,
  exclusionRefusal,
  parseCpuTime,
  type TmutilRunner,
  untetherOwnedDirs,
  worktreeExclusionTarget,
} from './backup-exclusion.js';
import { backupdCpuCheck, backupExclusionCheck } from './doctor-checks.js';

/** A fake tmutil keeping the excluded folders in a set, like the sticky xattr. */
function fakeTmutil(options: { failAdd?: boolean; missing?: boolean } = {}) {
  const excluded = new Set<string>();
  const run = vi.fn<TmutilRunner>(async (args) => {
    if (options.missing) return { code: 127, stdout: '' };
    const [command, dir] = args;
    if (command === 'addexclusion') {
      if (options.failAdd) return { code: 1, stdout: '' };
      excluded.add(dir);
      return { code: 0, stdout: '' };
    }
    if (command === 'isexcluded') {
      return {
        code: 0,
        stdout: `${excluded.has(dir) ? '[Excluded]' : '[Included]'}    ${dir}\n`,
      };
    }
    return { code: 1, stdout: '' };
  });
  return { run, excluded };
}

describe('backup exclusion', () => {
  let root: string;
  let home: string;
  let controlDir: string;
  let tasksDir: string;
  let worktrees: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-backup-')));
    home = path.join(root, '.untether');
    controlDir = path.join(home, 'control');
    tasksDir = path.join(home, 'tasks');
    worktrees = path.join(root, 'Projects', '.untether-worktrees');
    fs.mkdirSync(controlDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(path.join(worktrees, 'app', 'some-task'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Projects', 'app', '.git'), { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), '{}');
    fs.writeFileSync(path.join(home, 'projects.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(root, RM_TEST_DIR);
  });

  const make = (tmutil: TmutilRunner, enabled = true, platform: NodeJS.Platform = 'darwin') =>
    new BackupExclusion({ enabled: () => enabled, protectedDirs: [home], tmutil, platform });

  it('excludes the disposable folders with tmutil addexclusion (sticky, no sudo), once each', async () => {
    const tm = fakeTmutil();
    const exclusion = make(tm.run);
    expect(await exclusion.exclude(controlDir)).toBe(true);
    expect(await exclusion.exclude(controlDir)).toBe(true);
    expect(await exclusion.excludeAll([tasksDir, worktrees])).toEqual([tasksDir, worktrees]);
    expect(tm.run.mock.calls).toEqual([
      [['addexclusion', controlDir]],
      [['addexclusion', tasksDir]],
      [['addexclusion', worktrees]],
    ]);
    // Never -p (fixed path, needs admin) nor sudo.
    expect(tm.run.mock.calls.flat(2)).not.toContain('-p');
    expect(tm.run.mock.calls.flat(2)).not.toContain('sudo');
  });

  it('never excludes user data: ~/.untether, the home holding it, config files, repositories, files', async () => {
    const tm = fakeTmutil();
    const exclusion = make(tm.run);
    expect(await exclusion.exclude(home)).toBe(false);
    expect(await exclusion.exclude(root)).toBe(false);
    expect(await exclusion.exclude(path.join(home, 'config.json'))).toBe(false);
    expect(await exclusion.exclude(path.join(root, 'Projects', 'app'))).toBe(false);
    expect(await exclusion.exclude(path.join(root, 'missing'))).toBe(false);
    expect(await exclusion.exclude('/')).toBe(false);
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'projects.json'), '{}');
    expect(await exclusion.exclude(other)).toBe(false);
    expect(tm.run).not.toHaveBeenCalled();
    expect(exclusionRefusal(path.join(home, 'config.json'), [home])).toBe('not a folder');
    expect(exclusionRefusal(home, [home])).toMatch(/holds/);
  });

  it('does nothing when the setting is off, off macOS or without tmutil, and stays quiet on failure', async () => {
    const off = fakeTmutil();
    expect(await make(off.run, false).exclude(controlDir)).toBe(false);
    expect(await make(off.run, true, 'linux').exclude(controlDir)).toBe(false);
    expect(off.run).not.toHaveBeenCalled();

    const missing = fakeTmutil({ missing: true });
    const noTmutil = make(missing.run);
    expect(await noTmutil.exclude(controlDir)).toBe(false);
    expect(noTmutil.available()).toBe(false);
    expect(await noTmutil.exclude(tasksDir)).toBe(false);
    expect(missing.run).toHaveBeenCalledTimes(1);

    const failing = fakeTmutil({ failAdd: true });
    await expect(make(failing.run).exclude(controlDir)).resolves.toBe(false);

    const throwing = make(async () => {
      throw new Error('spawn failed');
    });
    await expect(throwing.exclude(controlDir)).resolves.toBe(false);
  });

  it('finds the target for a worktree: its .untether-worktrees folder, else the worktree itself', () => {
    expect(worktreeExclusionTarget('/u/Projects/.untether-worktrees/app/task')).toBe(
      '/u/Projects/.untether-worktrees'
    );
    expect(worktreeExclusionTarget('/custom/root/task')).toBe('/custom/root/task');
  });

  it('lists the existing Untether-owned folders: control, task logs, voice models, worktrees', () => {
    const dirs = untetherOwnedDirs({
      controlDir,
      taskLogDir: tasksDir,
      ttsDir: path.join(home, 'tts'),
      repoPaths: [path.join(root, 'Projects', 'app'), path.join(root, 'Elsewhere', 'gone')],
      worktreePaths: [path.join(worktrees, 'app', 'some-task')],
    });
    expect(dirs).toEqual([controlDir, tasksDir, worktrees]);
  });

  it('doctor: heals folders still included when on, says nothing when off', async () => {
    const tm = fakeTmutil();
    const dirs = () => [controlDir, tasksDir, worktrees, home];
    const check = backupExclusionCheck({ exclusion: make(tm.run), dirs });
    tm.excluded.add(tasksDir);
    const found = await check.run();
    expect(found.map((f) => f.key)).toEqual([
      `backup-exclusion:${controlDir}`,
      `backup-exclusion:${worktrees}`,
    ]);
    expect(found.every((f) => f.healed?.includes('tmutil addexclusion'))).toBe(true);
    expect(tm.excluded.has(home)).toBe(false);
    expect(await check.run()).toEqual([]);

    // Unmarked by hand later: found and marked again.
    tm.excluded.delete(controlDir);
    expect((await check.run()).map((f) => f.key)).toEqual([`backup-exclusion:${controlDir}`]);

    const offTm = fakeTmutil();
    expect(await backupExclusionCheck({ exclusion: make(offTm.run, false), dirs }).run()).toEqual(
      []
    );
    expect(offTm.run).not.toHaveBeenCalled();
  });

  it('doctor: warns when tmutil cannot exclude a folder', async () => {
    const tm = fakeTmutil({ failAdd: true });
    const found = await backupExclusionCheck({
      exclusion: make(tm.run),
      dirs: () => [controlDir],
    }).run();
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
    expect(found[0].healed).toBeUndefined();
    expect(found[0].problem).toMatch(/excludeFromBackups: false/);
  });
});

describe('backupd CPU', () => {
  it('reads backupd CPU time from ps', () => {
    expect(parseCpuTime('12:34.56')).toBeCloseTo(754.56);
    expect(parseCpuTime('3:02:01.00')).toBe(10921);
    expect(parseCpuTime('1-00:00:01')).toBe(86401);
    expect(parseCpuTime('nope')).toBeUndefined();
    const ps = [
      '   0:01.00 /usr/sbin/cfprefsd',
      ' 13:10:00.00 /System/Library/CoreServices/backupd.bundle/Contents/Resources/backupd',
      '   0:02.00 /System/Library/CoreServices/backupd.bundle/Contents/Resources/backupd-helper',
    ].join('\n');
    expect(backupdCpuFromPs(ps)).toBe(13 * 3600 + 600);
    expect(backupdCpuFromPs('   0:01.00 /usr/sbin/cfprefsd')).toBeUndefined();
  });

  it('tells when backupd kept high CPU for hours, naming the tasks it keeps waiting', async () => {
    let now = 1_000_000_000;
    let cpu: number | undefined = 100;
    const watch = new BackupdWatch(
      async () => cpu,
      () => now
    );
    const tasks: unknown[] = [];
    const check = backupdCpuCheck({ watch, tasks: () => tasks as never });
    const step = async (minutes: number, share: number) => {
      now += minutes * 60_000;
      if (cpu !== undefined) cpu += minutes * 60 * share;
      return check.run();
    };
    expect(await check.run()).toEqual([]);
    for (let i = 0; i < 11; i++) expect(await step(10, 0.95)).toEqual([]);
    tasks.push({
      state: 'queued',
      queued: { resources: { short: ['load'], detail: 'load 28' } },
    });
    const found = await step(10, 0.95);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
    expect(found[0].problem).toMatch(/backupd\) has kept ~95% CPU for 2 h; 1 task\(s\) wait/);

    // A quiet interval breaks the streak.
    expect(await step(10, 0.1)).toEqual([]);
    expect(await step(10, 0.95)).toEqual([]);
    // backupd gone: nothing.
    cpu = undefined;
    expect(await step(10, 0)).toEqual([]);
    expect(watch.busy()).toBeNull();
  });
});

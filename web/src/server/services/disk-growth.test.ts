import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  type DiskGrowthState,
  DiskGrowthWatch,
  describeGrowers,
  diskGrowers,
  scanStep,
} from './disk-growth.js';
import { diskCheck } from './doctor-checks.js';

const GB = 1024 * 1024 * 1024;
const MIN = 60_000;
const HOUR = 60 * MIN;
const HOME = '/Users/n';

/**
 * 2026-11-01 22:22, simulated: claude-mem's Chroma index grew to 81 GB in three hours, ~/Projects
 * a little, a check left a new folder in /private/tmp; ~/Library stayed as it was.
 */
function grownState(): DiskGrowthState {
  return {
    roots: { [HOME]: 0, '/private/tmp': 0 },
    units: {
      [`${HOME}/.claude-mem`]: {
        measures: [
          {
            at: 0,
            bytes: 1.2 * GB,
            dirs: {
              [`${HOME}/.claude-mem`]: 1.2 * GB,
              [`${HOME}/.claude-mem/chroma`]: 1 * GB,
              [`${HOME}/.claude-mem/chroma/abc`]: 1 * GB,
            },
            bigFiles: [],
          },
          {
            at: 3 * HOUR,
            bytes: 81.4 * GB,
            dirs: {
              [`${HOME}/.claude-mem`]: 81.4 * GB,
              [`${HOME}/.claude-mem/chroma`]: 81.2 * GB,
              [`${HOME}/.claude-mem/chroma/abc`]: 81.2 * GB,
            },
            bigFiles: [
              {
                path: `${HOME}/.claude-mem/chroma/abc/link_lists.bin`,
                bytes: 80 * GB,
                mtimeMs: 3 * HOUR - 2 * MIN,
              },
            ],
          },
        ],
      },
      [`${HOME}/Projects`]: {
        measures: [
          { at: 1 * HOUR, bytes: 40 * GB, dirs: { [`${HOME}/Projects`]: 40 * GB }, bigFiles: [] },
          {
            at: 3 * HOUR,
            bytes: 42.5 * GB,
            dirs: { [`${HOME}/Projects`]: 42.5 * GB },
            bigFiles: [],
          },
        ],
      },
      [`${HOME}/Library`]: {
        measures: [
          { at: 0, bytes: 45 * GB, dirs: { [`${HOME}/Library`]: 45 * GB }, bigFiles: [] },
          { at: 2 * HOUR, bytes: 45 * GB, dirs: { [`${HOME}/Library`]: 45 * GB }, bigFiles: [] },
        ],
      },
      // Appeared after /private/tmp had been listed: grown from nothing.
      '/private/tmp/ut-check-run': {
        newSince: 2 * HOUR,
        measures: [
          {
            at: 2 * HOUR,
            bytes: 1.5 * GB,
            dirs: { '/private/tmp/ut-check-run': 1.5 * GB },
            bigFiles: [],
          },
        ],
      },
    },
  };
}

const EXPECTED =
  '~/.claude-mem/chroma/abc +80.2 GB in 3 h (81.2 GB); ~/Projects +2.5 GB in 2 h (42.5 GB); /private/tmp/ut-check-run +1.5 GB in 0 min (1.5 GB); ~/.claude-mem/chroma/abc/link_lists.bin 80.0 GB, written 2 min ago';

describe('what grew, for the low-disk finding (2026-11-01: claude-mem at 81 GB)', () => {
  it('names the deepest folder carrying the growth, then other growers and big files written lately', () => {
    const growers = diskGrowers(grownState(), 3 * HOUR);
    // ~/.claude-mem and ~/.claude-mem/chroma grew by abc: not listed on top of it; ~/Library did not grow.
    expect(growers.map((entry) => entry.path)).toEqual([
      `${HOME}/.claude-mem/chroma/abc`,
      `${HOME}/Projects`,
      '/private/tmp/ut-check-run',
      `${HOME}/.claude-mem/chroma/abc/link_lists.bin`,
    ]);
    expect(growers[0]).toMatchObject({ grownBytes: 80.2 * GB, bytes: 81.2 * GB });
    expect(describeGrowers(growers, HOME)).toBe(EXPECTED);
  });

  it('with nothing measured before, the big files written lately still say it; old ones do not', () => {
    const state = grownState();
    for (const unit of Object.values(state.units)) unit.measures = unit.measures.slice(-1);
    delete state.units['/private/tmp/ut-check-run'].newSince;
    expect(describeGrowers(diskGrowers(state, 3 * HOUR), HOME)).toBe(
      '~/.claude-mem/chroma/abc/link_lists.bin 80.0 GB, written 2 min ago'
    );
    expect(diskGrowers(state, 12 * HOUR)).toEqual([]);
  });
});

describe("the doctor's disk check", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, RM_TEST_DIR);
    dir = undefined;
  });

  it('low: the finding names what grew; nearly low measures on now and then; plenty does nothing', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-growth-'));
    let now = 0;
    let free = 30 * GB;
    const steps: string[] = [];
    const growth = new DiskGrowthWatch({
      statePath: path.join(dir, 'disk-growth.json'),
      step: async (state, mode) => {
        steps.push(mode);
        // The simulated measurements: what the steps would have found.
        if (mode === 'low') Object.assign(state, grownState());
      },
      now: () => now,
      home: HOME,
    });
    const check = diskCheck({
      dir: '/',
      statfs: () => ({ freeBytes: free, totalBytes: 500 * GB }),
      growth,
    });
    // 30 GB of 500 (6 %): nearly low, a step.
    expect(await check.run()).toEqual([]);
    expect(steps).toEqual(['baseline']);
    // Not again within half an hour.
    now = 20 * MIN;
    expect(await check.run()).toEqual([]);
    expect(steps).toEqual(['baseline']);
    now = 3 * HOUR;
    free = 1 * GB;
    const [finding] = await check.run();
    expect(steps).toEqual(['baseline', 'low']);
    expect(finding).toMatchObject({ key: 'disk:low', severity: 'critical' });
    expect(finding.problem).toBe(`only 1.0 GB free on the disk of /; growing lately: ${EXPECTED}`);
    // Kept for the next run, after a restart too.
    const reloaded = new DiskGrowthWatch({
      statePath: path.join(dir, 'disk-growth.json'),
      step: async () => undefined,
      now: () => now,
      home: HOME,
    });
    expect(await reloaded.describe()).toBe(EXPECTED);
    // Plenty of room: nothing measured.
    free = 200 * GB;
    now = 10 * HOUR;
    expect(await check.run()).toEqual([]);
    expect(steps).toEqual(['baseline', 'low']);
  });

  it('a step that fails leaves the finding plain', async () => {
    const check = diskCheck({
      dir: '/',
      statfs: () => ({ freeBytes: 1 * GB, totalBytes: 500 * GB }),
      growth: {
        baseline: async () => undefined,
        describe: async () => {
          throw new Error('EPERM');
        },
      },
    });
    expect((await check.run())[0].problem).toBe(
      'only 1.0 GB free on the disk of /; nothing big found growing lately'
    );
  });
});

describe('scanStep', () => {
  let root: string;
  afterEach(() => fs.rmSync(root, RM_TEST_DIR));
  const write = (rel: string, kb: number) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), Buffer.alloc(kb * 1024, 1));
  };
  const options = (extra: Partial<Parameters<typeof scanStep>[1]> = {}) => ({
    roots: [root],
    files: [],
    skip: (dir: string) => dir === path.join(root, 'Documents'),
    budgetMs: 60_000,
    hardMs: 60_000,
    minDirBytes: 100 * 1024,
    minFileBytes: 100 * 1024,
    ...extra,
  });

  it('measures units, skips guarded folders, finds what grew between steps and new folders', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'disk-scan-')));
    write('cache/deep/big.bin', 256);
    write('Documents/private.bin', 256);
    write('loose.bin', 128);
    const state: DiskGrowthState = { roots: {}, units: {} };
    let now = 0;
    await scanStep(state, options({ now: () => now }));
    expect(Object.keys(state.units).sort()).toEqual([`${root}/.`, path.join(root, 'cache')].sort());
    expect(state.units[path.join(root, 'cache')].measures[0].dirs).toEqual({
      [path.join(root, 'cache')]: expect.any(Number),
      [path.join(root, 'cache', 'deep')]: expect.any(Number),
    });
    // The cache grows, a new folder appears; measured again an hour later.
    write('cache/deep/more.bin', 512);
    write('fresh/new.bin', 512);
    now = HOUR;
    await scanStep(state, options({ now: () => now }));
    const growers = diskGrowers(state, Date.now(), { minGrowthBytes: 400 * 1024 });
    expect(growers.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([path.join(root, 'cache', 'deep'), path.join(root, 'fresh')])
    );
    expect(growers.map((entry) => entry.path)).not.toContain(path.join(root, 'cache'));
  });

  it('stops at its budget and goes on from there the next step, never measured units first', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'disk-scan-')));
    for (const name of ['a', 'b', 'c']) write(`${name}/f.bin`, 4);
    const state: DiskGrowthState = { roots: {}, units: {} };
    let t = 0;
    // Each clock read moves on 1 ms; a budget of 0 lets one unit start per step.
    const clock = () => t++;
    const measured = () =>
      Object.entries(state.units)
        .filter(([, unit]) => unit.measures.length)
        .map(([key]) => key);
    await scanStep(state, options({ budgetMs: 1, now: clock }));
    const first = measured();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(4);
    for (let i = 0; i < 4; i++) await scanStep(state, options({ budgetMs: 1, now: clock }));
    expect(measured().sort()).toEqual(
      [`${root}/.`, path.join(root, 'a'), path.join(root, 'b'), path.join(root, 'c')].sort()
    );
  });
});

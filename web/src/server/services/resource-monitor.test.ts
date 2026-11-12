import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { resourcesCheck } from './doctor-checks.js';
import {
  CLOCK_BANK_KEEP_MS,
  createResourceMonitor,
  DEFAULT_TASK_ADMISSION,
  GRANT_FORCE_AFTER,
  GRANT_STALL_WARN,
  judgeAdmission,
  memoryShortage,
  parsePsMemory,
  parseSwapUsage,
  parseSysctl,
  parseVmStatAvailable,
  type ResourceSample,
  taskAdmissionFrom,
} from './resource-monitor.js';
import { createLoadGate } from './task-verify.js';

const GB = 1024 ** 3;

const sample = (over: Partial<ResourceSample> = {}): ResourceSample => ({
  at: 0,
  load: 3,
  cores: 12,
  memTotalBytes: 24 * GB,
  memAvailableBytes: 14 * GB,
  memFreePercent: 60,
  pressure: 'normal',
  swapUsedBytes: 1 * GB,
  swapTotalBytes: 4 * GB,
  ...over,
});

describe('resource monitor (taskAdmission, 2026-11-01)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 1, 21, 0));
  });
  afterEach(() => vi.useRealTimers());

  it('parses what macOS prints (real output of this Mac)', () => {
    expect(
      parseSwapUsage('total = 5120.00M  used = 4428.44M  free = 691.56M  (encrypted)')
    ).toEqual({ used: 4428.44 * 1024 ** 2, total: 5120 * 1024 ** 2 });
    expect(parseSwapUsage('nonsense')).toBeNull();
    expect(
      parseSysctl('total = 2.00G  used = 512.00M  free = 1.50G  (encrypted)\n49\n4\n')
    ).toEqual({
      swap: { used: 512 * 1024 ** 2, total: 2 * GB },
      freePercent: 49,
      pressure: 'critical',
    });
    expect(parseSysctl('total = 0.00M  used = 0.00M  free = 0.00M\n\n').freePercent).toBeNull();
    const vmStat = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                    25575.',
      'Pages active:                                 369188.',
      'Pages inactive:                               357884.',
      'Pages speculative:                             12074.',
      'Pages wired down:                             269242.',
      'Pages purgeable:                                 719.',
    ].join('\n');
    expect(parseVmStatAvailable(vmStat)).toBe((25575 + 357884 + 12074 + 719) * 16384);
    expect(parseVmStatAvailable('no pages here')).toBeNull();
  });

  it('judges memory, pressure, swap (level and growth) and load against the thresholds', () => {
    const settings = DEFAULT_TASK_ADMISSION;
    expect(judgeAdmission([sample()], settings)).toMatchObject({
      ok: true,
      short: [],
      tight: false,
    });
    expect(judgeAdmission([sample({ memFreePercent: 15 })], settings).short).toEqual(['memory']);
    expect(judgeAdmission([sample({ pressure: 'warn' })], settings).detail).toMatch(
      /pressure warn/
    );
    expect(judgeAdmission([sample({ swapUsedBytes: 7 * GB })], settings).short).toEqual(['swap']);
    // Growth within the window counts, before it does not.
    const growing = [
      sample({ at: 0, swapUsedBytes: 1 * GB }),
      sample({ at: 700_000, swapUsedBytes: 2 * GB }),
      sample({ at: 760_000, swapUsedBytes: 2.8 * GB }),
    ];
    expect(judgeAdmission(growing, settings)).toMatchObject({ ok: false, short: ['swap'] });
    expect(judgeAdmission(growing.slice(0, 2), settings).ok).toBe(true);
    expect(judgeAdmission([sample({ load: 30 })], settings).detail).toBe('load 30.0 (target 12)');
    expect(
      judgeAdmission([sample({ load: 30 })], { ...settings, targetLoadPerCore: 0 }).detail
    ).toBe('load 30.0 (max 24)');
    // 0 turns one limit off; enabled false all of them; no sample lets tasks in.
    expect(judgeAdmission([sample({ load: 30 })], { ...settings, maxLoadPerCore: 0 }).ok).toBe(
      true
    );
    expect(
      judgeAdmission([sample({ memFreePercent: 1 })], { ...settings, enabled: false }).ok
    ).toBe(true);
    expect(judgeAdmission([], settings).ok).toBe(true);
    // Past half of a limit: tight (the last task let in settles first).
    expect(judgeAdmission([sample({ load: 15 })], settings).tight).toBe(true);
  });

  it('the CPU-only clock survives a server restart (stateFile, 2026-11-02)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-admission-'));
    try {
      const stateFile = path.join(dir, 'admission-state.json');
      const make = () =>
        createResourceMonitor({
          sample: async () => ({ ...sample({ load: 36 }), at: Date.now() }),
          historyMs: 60 * 60_000,
          stateFile,
        });
      const first = make();
      await first.refresh();
      expect(first.admission().ok).toBe(false);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      // Restarted 15 min in: the new one remembers when the CPU-only wait began.
      const second = make();
      await second.refresh();
      expect(second.admission().ok).toBe(false);
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      await second.refresh();
      expect(second.admission().ok).toBe(true);
      second.started();
      // The start is kept too: a third one starts its 20 min from it.
      const third = make();
      await third.refresh();
      expect(third.admission().ok).toBe(false);
      expect(third.lastStartedAt()).toBe(Date.now());
      // A broken file counts as no clocks.
      fs.writeFileSync(stateFile, '{not json');
      const fourth = make();
      expect(fourth.lastStartedAt()).toBe(0);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });

  it('lets one task in when only the CPU has been short for cpuOnlyMaxWaitMin (2026-11-02)', async () => {
    let next = sample({ load: 36 });
    const monitor = createResourceMonitor({
      sample: async () => ({ ...next, at: Date.now() }),
      historyMs: 60 * 60_000,
    });
    await monitor.refresh();
    expect(monitor.admission()).toMatchObject({ ok: false, short: ['cpu'] });
    await vi.advanceTimersByTimeAsync(19 * 60_000);
    await monitor.refresh();
    expect(monitor.admission().ok).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await monitor.refresh();
    const let_in = monitor.admission();
    expect(let_in.ok).toBe(true);
    expect(let_in.detail).toContain('only the CPU');
    // Asked again before anyone started (a new task queued behind others, then the pump):
    // the grant is still there; only a start spends it.
    expect(monitor.admission().ok).toBe(true);
    monitor.started();
    // The window starts again: the next one waits its own 20 min.
    await vi.advanceTimersByTimeAsync(60_000);
    await monitor.refresh();
    expect(monitor.admission().ok).toBe(false);
    // Memory short as well: never let in by this rule.
    next = sample({ load: 36, memFreePercent: 10, pressure: 'warn' });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await monitor.refresh();
    expect(monitor.admission()).toMatchObject({ ok: false });
    expect(monitor.admission().short).toContain('memory');
  });

  it('keeps a short history, waits for its first sample, settles after a start, fails open when it cannot sample', async () => {
    let next = sample();
    let fail = false;
    const monitor = createResourceMonitor({
      sample: async () => {
        if (fail) throw new Error('sysctl: not found');
        return { ...next, at: Date.now() };
      },
      historyMs: 60_000,
    });
    // Nothing looked at yet: a moment's wait, not a start on no knowledge.
    expect(monitor.admission()).toMatchObject({ ok: false, settling: true });
    await monitor.refresh();
    expect(monitor.admission().ok).toBe(true);
    // The ramp: the next start waits settleSec after one let in.
    next = sample({ load: 8 });
    await monitor.refresh();
    monitor.started();
    expect(monitor.admission()).toMatchObject({ ok: false, short: [], settling: true });
    await vi.advanceTimersByTimeAsync(21_000);
    expect(monitor.admission().ok).toBe(true);
    // History: older than historyMs goes.
    await vi.advanceTimersByTimeAsync(70_000);
    await monitor.refresh();
    expect(monitor.history()).toHaveLength(1);
    // A failing sampler keeps the last sample and says why; a fresh one with none fails open.
    fail = true;
    await monitor.refresh();
    expect(monitor.lastError()).toBe('sysctl: not found');
    const broken = createResourceMonitor({
      sample: async () => {
        throw new Error('no sysctl');
      },
    });
    await broken.refresh();
    expect(broken.admission().ok).toBe(true);
  });

  it('settings: each field defaulted on its own', () => {
    expect(taskAdmissionFrom({ maxLoadPerCore: 1 })).toEqual({
      ...DEFAULT_TASK_ADMISSION,
      maxLoadPerCore: 1,
    });
    expect(taskAdmissionFrom(undefined)).toEqual(DEFAULT_TASK_ADMISSION);
  });

  it('the checks wait on the same memory/swap word, not on its CPU limit', () => {
    expect(memoryShortage([sample({ load: 100 })], DEFAULT_TASK_ADMISSION)).toBeUndefined();
    const short = memoryShortage([sample({ memFreePercent: 8 })], DEFAULT_TASK_ADMISSION);
    expect(short).toMatch(/memory 8 % free/);
    // Only paced (swap steady over its level, pressure warn): a check is not held by it.
    expect(
      memoryShortage(
        [
          sample({ at: 0, swapUsedBytes: 7 * GB, pressure: 'warn' }),
          sample({ at: 180_000, swapUsedBytes: 7 * GB, pressure: 'warn' }),
        ],
        DEFAULT_TASK_ADMISSION
      )
    ).toBeUndefined();
    let memory: string | undefined = short;
    const gate = createLoadGate({
      loadavg: () => 1,
      cores: () => 12,
      memoryShort: () => memory,
    });
    expect(gate.sample()).toMatchObject({ high: true, memory: short });
    memory = undefined;
    expect(gate.sample().high).toBe(false);
  });

  it('doctor: a sampler without fresh samples, and tasks waiting over an hour for room', async () => {
    const now = Date.now();
    let latest: ResourceSample | undefined;
    let error: string | undefined = 'sysctl: not found';
    const tasks = [
      {
        id: 'abcdef123456',
        name: 'T',
        state: 'queued',
        stateSince: new Date(now - 61 * 60_000).toISOString(),
        queued: {
          repoPath: '/r',
          since: '',
          order: 1,
          resources: { short: ['memory'], detail: 'memory 9 % free (min 20 %)', at: '' },
        },
      },
    ];
    let lastStart = 0;
    const check = resourcesCheck({
      monitor: {
        latest: () => latest,
        lastError: () => error,
        settings: () => DEFAULT_TASK_ADMISSION,
        lastStartedAt: () => lastStart,
      },
      tasks: () => tasks as never,
      now: () => now,
    });
    const found = (await check.run()) as { key: string; problem: string }[];
    expect(found.map((f) => f.key)).toEqual(['resources:sampler', 'resources:waiting']);
    expect(found[0].problem).toMatch(/sysctl: not found/);
    expect(found[1].problem).toMatch(/1 task\(s\) have waited over an hour.*memory 9 % free/);
    // The line still moves (one let in 10 min ago): a long wait on a busy Mac is no problem.
    lastStart = now - 10 * 60_000;
    expect(((await check.run()) as { key: string }[]).map((f) => f.key)).toEqual([
      'resources:sampler',
    ]);
    // Nobody let in for over 45 min: it warns again.
    lastStart = now - 50 * 60_000;
    expect(((await check.run()) as { key: string }[]).map((f) => f.key)).toContain(
      'resources:waiting'
    );
    // Time Machine busy for hours is named as a reason for the wait (2026-11-02).
    const withBackupd = resourcesCheck({
      monitor: {
        latest: () => latest,
        lastError: () => error,
        settings: () => DEFAULT_TASK_ADMISSION,
        lastStartedAt: () => lastStart,
      },
      tasks: () => tasks as never,
      backupd: () => ({ forMs: 3 * 3_600_000, share: 0.97 }),
      now: () => now,
    });
    const waitingFinding = ((await withBackupd.run()) as { key: string; problem: string }[]).find(
      (f) => f.key === 'resources:waiting'
    );
    expect(waitingFinding?.problem).toMatch(
      /Time Machine \(backupd\) has kept ~97% CPU for 3 h, a reason for the wait/
    );
    error = undefined;
    latest = sample({ at: now });
    tasks.length = 0;
    expect(await check.run()).toEqual([]);
  });

  // 2026-11-07, real case: c8dea364 waited over an hour «waiting for memory+swap» with 46 %
  // memory free (5.9 of 24 GB available), load 9 on 12 cores, swap 6.6 GB (max 6.0) and
  // pressure warn: macOS gives swap back slowly and keeps warn while the swap file is full.
  const steadyCase = (over: Partial<ResourceSample> = {}) =>
    sample({
      memFreePercent: 46,
      memAvailableBytes: 5.9 * GB,
      load: 9,
      pressure: 'warn',
      swapUsedBytes: 6.6 * GB,
      swapTotalBytes: 8 * GB,
      ...over,
    });

  const threeMinutes = (over: Partial<ResourceSample> = {}) => [
    steadyCase({ at: 0, ...over }),
    steadyCase({ at: 180_000, ...over }),
  ];

  it('judges a high but steady swap with pressure warn as steadySwap, and what really holds it', () => {
    const settings = DEFAULT_TASK_ADMISSION;
    const steady = judgeAdmission(threeMinutes(), settings);
    expect(steady).toMatchObject({ ok: false, steadySwap: true });
    expect(steady.short).toEqual(['memory', 'swap']);
    expect(steady.detail).toBe('pressure warn, swap steady at 6.6 GB (no growth over 10 min)');
    // Memory under twice the minimum, but over it: still only paced.
    expect(judgeAdmission(threeMinutes({ memFreePercent: 35 }), settings).steadySwap).toBe(true);
    // Growing swap, critical pressure, memory under its floor, too little available: held.
    const growing = judgeAdmission(
      [steadyCase({ at: 0, swapUsedBytes: 5.9 * GB }), steadyCase({ at: 60_000 })],
      settings
    );
    expect(growing).toMatchObject({ ok: false, short: ['swap'] });
    expect(growing.steadySwap).toBeUndefined();
    expect(growing.detail).toBe('swap growing +0.7 GB in 1 min (limit +512 MB)');
    for (const held of [
      { pressure: 'critical' as const },
      { memFreePercent: 15 },
      { memAvailableBytes: 3 * GB },
    ]) {
      const verdict = judgeAdmission(threeMinutes(held), settings);
      expect(verdict).toMatchObject({ ok: false, short: ['memory'] });
      expect(verdict.steadySwap).toBeUndefined();
      expect(verdict.warmingUp).toBeUndefined();
    }
  });

  describe('what holds a task (2026-11-08)', () => {
    const settings = DEFAULT_TASK_ADMISSION;
    const tenMinutes = (from: number, to: number, over: Partial<ResourceSample> = {}) => [
      sample({ at: 0, swapUsedBytes: from * GB, ...over }),
      sample({ at: 300_000, swapUsedBytes: (from + to) * 0.5 * GB, ...over }),
      sample({ at: 600_000, swapUsedBytes: to * GB, ...over }),
    ];
    const lowMemory = { memFreePercent: 40, memAvailableBytes: 9.6 * GB };
    // Under roomyFreeMemoryPercent (2026-11-11): only then does a still swap over its level pace.
    const notRoomy = { memFreePercent: 35, memAvailableBytes: 8.4 * GB };

    it('(a) swap 7 of 8 GB still, pressure warn, 40 % free: dripped, never held for the amount', async () => {
      const over = { pressure: 'warn' as const, swapTotalBytes: 8 * GB, ...lowMemory };
      const judged = judgeAdmission(tenMinutes(7, 7, over), settings);
      expect(judged).toMatchObject({ ok: false, steadySwap: true, short: ['memory', 'swap'] });
      expect(judged.detail).not.toMatch(/in use/);
      const monitor = createResourceMonitor({
        sample: async () => ({
          ...sample({ swapUsedBytes: 7 * GB, ...over }),
          at: Date.now(),
        }),
      });
      for (let minute = 0; minute < 15; minute++) {
        await monitor.refresh();
        expect(monitor.admission().ok).toBe(false);
        await vi.advanceTimersByTimeAsync(60_000);
      }
      await monitor.refresh();
      expect(monitor.admission()).toMatchObject({ ok: true });
      expect(monitor.admission().detail).toMatch(/one task let in every 15 min: one let in now/);
      monitor.started();
      await vi.advanceTimersByTimeAsync(60_000);
      await monitor.refresh();
      expect(monitor.admission().ok).toBe(false);
      expect(monitor.admission().detail).toMatch(/next in 14 min/);
    });

    it('(a) the drip interval is configurable', async () => {
      const monitor = createResourceMonitor({
        sample: async () => ({
          ...sample({ swapUsedBytes: 7 * GB, pressure: 'warn', ...lowMemory }),
          at: Date.now(),
        }),
        settings: () => ({ ...settings, steadySwapMaxWaitMin: 5 }),
      });
      for (let minute = 0; minute <= 5; minute++) {
        await monitor.refresh();
        if (minute < 5) await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(monitor.admission().ok).toBe(true);
    });

    it('(b) the 3-oct hang, swap 18 of 19 GB and growing with load 39: held, nothing granted', () => {
      const judged = judgeAdmission(
        tenMinutes(16.5, 18, { swapTotalBytes: 19 * GB, load: 39 }),
        settings
      );
      expect(judged).toMatchObject({ ok: false, short: ['swap', 'cpu'] });
      expect(judged.steadySwap).toBeUndefined();
      expect(judged.detail).toMatch(/swap growing \+1\.5 GB in 10 min/);
      expect(judged.detail).toMatch(/swap nearly full: 18\.0 GB of 19\.0 GB \(95 %, limit 90 %\)/);
    });

    it('swap nearly full holds even still; a small total macOS is still growing does not', () => {
      const full = judgeAdmission(tenMinutes(18, 18, { swapTotalBytes: 19 * GB }), settings);
      expect(full).toMatchObject({ ok: false, short: ['swap'] });
      expect(full.steadySwap).toBeUndefined();
      // 7.9 of 8 GB is 99 %, but on 24 GB of RAM the total is only what macOS has added so far.
      expect(
        judgeAdmission(tenMinutes(7.9, 7.9, { swapTotalBytes: 8 * GB, ...notRoomy }), settings)
          .steadySwap
      ).toBe(true);
      // Both limits can be set; 0 turns the rule off.
      expect(
        judgeAdmission(tenMinutes(7.9, 7.9, { swapTotalBytes: 8 * GB }), {
          ...settings,
          minSwapTotalPercentOfRam: 25,
        }).detail
      ).toMatch(/swap nearly full/);
      expect(
        judgeAdmission(tenMinutes(18, 18, { swapTotalBytes: 19 * GB, ...notRoomy }), {
          ...settings,
          maxSwapPercentOfTotal: 0,
        }).steadySwap
      ).toBe(true);
    });

    it('(c) pressure critical holds with little swap, and says so', () => {
      const judged = judgeAdmission(tenMinutes(0.5, 0.5, { pressure: 'critical' }), settings);
      expect(judged).toMatchObject({ ok: false, short: ['memory'], detail: 'pressure critical' });
    });

    it('(d) a high swap grown 1 GB in 10 min: held, the reason names the growth', () => {
      const judged = judgeAdmission(tenMinutes(7, 8, { swapTotalBytes: 9 * GB }), settings);
      expect(judged).toMatchObject({
        ok: false,
        short: ['swap'],
        detail: 'swap growing +1.0 GB in 10 min (limit +512 MB)',
      });
      expect(judged.steadySwap).toBeUndefined();
      // The window and the limit are configurable.
      expect(
        judgeAdmission(tenMinutes(7, 8, { swapTotalBytes: 9 * GB, ...notRoomy }), {
          ...settings,
          maxSwapGrowthMb: 2048,
        }).steadySwap
      ).toBe(true);
      expect(
        judgeAdmission(tenMinutes(7, 8, { swapTotalBytes: 9 * GB, ...notRoomy }), {
          ...settings,
          swapGrowthWindowMin: 1,
        }).short
      ).toEqual(['swap']);
    });

    it('growth counts from the lowest point in the window, so swap given back is not growth', () => {
      expect(
        judgeAdmission(tenMinutes(8, 7, { swapTotalBytes: 9 * GB, ...notRoomy }), settings)
          .steadySwap
      ).toBe(true);
      // With memory to spare the same still swap is no reason at all.
      expect(judgeAdmission(tenMinutes(8, 7, { swapTotalBytes: 9 * GB }), settings)).toMatchObject({
        ok: true,
        short: [],
        detail: '',
      });
    });

    it('(e) low swap and pressure normal: in, freely', () => {
      expect(judgeAdmission(tenMinutes(1, 1), settings)).toMatchObject({
        ok: true,
        short: [],
        detail: '',
      });
    });

    it('(f) too few samples: free lane judged as usual, drip lane held until the swap trend shows', async () => {
      // One sample, nothing wrong: in.
      expect(judgeAdmission([sample()], settings).ok).toBe(true);
      // Growth already over the limit in the samples there are: held like any other.
      expect(
        judgeAdmission([sample({ at: 0 }), sample({ at: 30_000, swapUsedBytes: 2 * GB })], settings)
          .short
      ).toEqual(['swap']);
      // Warn or a high swap and under swapWarmupMin of samples: no drip yet, and it says why.
      const early = judgeAdmission([steadyCase()], settings);
      expect(early).toMatchObject({ ok: false, warmingUp: true });
      expect(early.steadySwap).toBeUndefined();
      expect(early.detail).toMatch(/swap trend not known yet \(0 of 10 min sampled\)/);
      // Enough minutes, but climbing faster than the limit's pace: still not steady.
      const climbing = judgeAdmission(
        [
          steadyCase({ at: 0, swapUsedBytes: 6.6 * GB }),
          steadyCase({ at: 180_000, swapUsedBytes: 6.9 * GB }),
        ],
        settings
      );
      expect(climbing).toMatchObject({ ok: false, warmingUp: true });
      // Fresh ring (a server start): the drip opens once the warm-up has passed.
      const monitor = createResourceMonitor({
        sample: async () => ({ ...steadyCase(), at: Date.now() }),
      });
      await monitor.refresh();
      expect(monitor.steadySwapGrant()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await monitor.refresh();
      expect(monitor.steadySwapGrant()).toEqual({ waitMin: 15 });
      expect(monitor.grantStalls().steady).toBe(0);
    });

    it('keeps the samples of the whole window, and no more', async () => {
      let swap = 1 * GB;
      const monitor = createResourceMonitor({
        sample: async () => ({ ...sample({ swapUsedBytes: swap }), at: Date.now() }),
      });
      for (let minute = 0; minute < 20; minute++) {
        await monitor.refresh();
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(monitor.history()).toHaveLength(12);
      swap = 2 * GB;
      await monitor.refresh();
      expect(monitor.admission().detail).toMatch(/swap growing \+1\.0 GB in 10 min/);
    });

    it('a warm-up longer than the window still ends: the ring covers it (review 2026-11-08)', async () => {
      const monitor = createResourceMonitor({
        sample: async () => ({ ...steadyCase(), at: Date.now() }),
        settings: () => ({ ...settings, swapWarmupMin: 15 }),
      });
      for (let minute = 0; minute < 15; minute++) {
        await monitor.refresh();
        expect(monitor.steadySwapGrant()).toBeUndefined();
        await vi.advanceTimersByTimeAsync(60_000);
      }
      await monitor.refresh();
      expect(monitor.steadySwapGrant()).toEqual({ waitMin: 15 });
      expect(monitor.admission().ok).toBe(true);
    });

    it('settings: the new fields come from config, each on its own', () => {
      expect(taskAdmissionFrom({ swapGrowthWindowMin: 5, maxSwapPercentOfTotal: 80 })).toEqual({
        ...settings,
        swapGrowthWindowMin: 5,
        maxSwapPercentOfTotal: 80,
      });
    });
  });

  it('lets one task in every steadySwapMaxWaitMin while swap stays high but steady (2026-11-07)', async () => {
    let next = steadyCase();
    const monitor = createResourceMonitor({
      sample: async () => ({ ...next, at: Date.now() }),
      historyMs: 60 * 60_000,
    });
    await monitor.refresh();
    expect(monitor.admission()).toMatchObject({ ok: false, warmingUp: true });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await monitor.refresh();
    const held = monitor.admission();
    expect(held).toMatchObject({ ok: false, steadySwap: true });
    expect(held.detail).toMatch(/one task let in every 15 min \(next in 10 min\)/);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await monitor.refresh();
    expect(monitor.admission().ok).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await monitor.refresh();
    const let_in = monitor.admission();
    expect(let_in.ok).toBe(true);
    expect(let_in.detail).toMatch(/one let in now/);
    // Asked again before a start: still there; only a start spends it.
    expect(monitor.admission().ok).toBe(true);
    monitor.started();
    await vi.advanceTimersByTimeAsync(60_000);
    await monitor.refresh();
    expect(monitor.admission().ok).toBe(false);
    // The next one waits its own 15 min.
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    await monitor.refresh();
    expect(monitor.admission().ok).toBe(true);
    monitor.started();
    // Swap grows: nothing gets in while it is growing, however long since the last start.
    next = steadyCase({ swapUsedBytes: 7.3 * GB });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await monitor.refresh();
    next = steadyCase({ swapUsedBytes: 8 * GB });
    await vi.advanceTimersByTimeAsync(60_000);
    await monitor.refresh();
    const growing = monitor.admission();
    expect(growing).toMatchObject({ ok: false, short: ['swap'] });
    expect(growing.detail).toMatch(/swap growing \+0\.7 GB in 1 min/);
    // Past the window, still again: tasks drip once more.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await monitor.refresh();
    expect(monitor.admission().steadySwap).toBe(true);
    // Pressure critical or memory low: never by this rule.
    for (const bad of [
      steadyCase({ swapUsedBytes: 8 * GB, pressure: 'critical' }),
      steadyCase({ swapUsedBytes: 8 * GB, memFreePercent: 15 }),
    ]) {
      next = bad;
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await monitor.refresh();
      expect(monitor.admission()).toMatchObject({ ok: false });
      expect(monitor.admission().steadySwap).toBeUndefined();
    }
  });

  it('a swap that keeps growing slowly never counts as steady (2026-11-07)', async () => {
    let swap = 6.6 * GB;
    const monitor = createResourceMonitor({
      sample: async () => ({ ...steadyCase({ swapUsedBytes: swap }), at: Date.now() }),
      historyMs: 60 * 60_000,
    });
    for (let minute = 0; minute < 60; minute++) {
      swap += 100 * 1024 ** 2; // 100 MB a minute: under the 2-min growth limit, not steady.
      await monitor.refresh();
      expect(monitor.admission().ok).toBe(false);
      // …and the doctor is not told a task gets in every 15 min (review, 2026-11-07).
      expect(monitor.steadySwapGrant()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
    }
  });

  it('steadySwapGrant: only once swap has been steady for the window, never with the rule off', async () => {
    let settings = DEFAULT_TASK_ADMISSION;
    const monitor = createResourceMonitor({
      sample: async () => ({ ...steadyCase(), at: Date.now() }),
      settings: () => settings,
      historyMs: 60 * 60_000,
    });
    await monitor.refresh();
    expect(monitor.steadySwapGrant()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await monitor.refresh();
    expect(monitor.steadySwapGrant()).toEqual({ waitMin: 15 });
    // CPU short too: the longer of the two waits; CPU rule off: no grant.
    settings = { ...DEFAULT_TASK_ADMISSION, maxLoadPerCore: 0.5 };
    expect(monitor.steadySwapGrant()).toEqual({ waitMin: 20 });
    settings = { ...DEFAULT_TASK_ADMISSION, maxLoadPerCore: 0.5, cpuOnlyMaxWaitMin: 0 };
    expect(monitor.steadySwapGrant()).toBeUndefined();
    settings = { ...DEFAULT_TASK_ADMISSION, steadySwapMaxWaitMin: 0 };
    expect(monitor.steadySwapGrant()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await monitor.refresh();
    expect(monitor.admission().ok).toBe(false);
  });

  it('the steady-swap clocks survive a server restart (stateFile, 2026-11-07)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-admission-'));
    try {
      const stateFile = path.join(dir, 'admission-state.json');
      const make = () =>
        createResourceMonitor({
          sample: async () => ({ ...steadyCase(), at: Date.now() }),
          historyMs: 5 * 60_000,
          stateFile,
        });
      const first = make();
      await first.refresh();
      expect(first.admission().ok).toBe(false);
      await vi.advanceTimersByTimeAsync(12 * 60_000);
      // Restarted 12 min in (history gone): it remembers both the steady swap and the wait.
      const second = make();
      await second.refresh();
      expect(second.admission().ok).toBe(false);
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await second.refresh();
      expect(second.admission().ok).toBe(true);
      second.started();
      const third = make();
      await third.refresh();
      expect(third.admission().ok).toBe(false);
      const kept = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(kept.steadySwapSince).toBe(Date.now());
      // The clocks, and the samples of the window (2026-11-11).
      expect(Object.keys(kept).sort()).toEqual([
        'lastStart',
        'samples',
        'steadySwapSince',
        'steadySwapStreak',
      ]);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });

  it('doctor: names who holds the memory while tasks wait on a steady swap (2026-11-07)', async () => {
    expect(
      parsePsMemory(
        [
          '  1048576 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '  2097152 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer)',
          '  2097152 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer)',
          '  3145728 node',
          '   1024 /sbin/launchd',
          'garbage',
        ].join('\n'),
        2
      )
    ).toEqual([
      { name: 'Google Chrome Helper (Renderer)', processes: 2, rssBytes: 4 * GB },
      { name: 'node', processes: 1, rssBytes: 3 * GB },
    ]);
    const now = Date.now();
    const tasks = [
      {
        id: 'c8dea364aaaa',
        name: 'T',
        state: 'queued',
        stateSince: new Date(now - 70 * 60_000).toISOString(),
        queued: {
          repoPath: '/r',
          since: '',
          order: 1,
          resources: { short: ['memory', 'swap'], detail: 'swap 6.6 GB in use', at: '' },
        },
      },
    ];
    let lastStart = now - 10 * 60_000;
    const latest = steadyCase({ at: now });
    let grant: { waitMin: number } | undefined = { waitMin: 15 };
    const check = resourcesCheck({
      monitor: {
        latest: () => latest,
        lastError: () => undefined,
        settings: () => DEFAULT_TASK_ADMISSION,
        lastStartedAt: () => lastStart,
        steadySwapGrant: () => grant,
      },
      tasks: () => tasks as never,
      memoryHolders: async () => [
        { name: 'Google Chrome Helper (Renderer)', processes: 31, rssBytes: 4.2 * GB },
        { name: 'node', processes: 12, rssBytes: 2.9 * GB },
      ],
      now: () => now,
    });
    // The line moves (one let in every 15 min): an info naming the rule and the holders.
    const moving = (await check.run()) as { key: string; severity: string; problem: string }[];
    expect(moving).toHaveLength(1);
    expect(moving[0]).toMatchObject({ key: 'resources:steady-swap', severity: 'info' });
    expect(moving[0].problem).toMatch(
      /high but steady.*one task is let in every 15 min.*holding the most memory: Google Chrome Helper \(Renderer\) ×31 4\.2 GB, node ×12 2\.9 GB/
    );
    // Nobody let in for long: the warning says the same, with the holders.
    lastStart = now - 50 * 60_000;
    const stuck = (await check.run()) as { key: string; problem: string }[];
    expect(stuck.map((f) => f.key)).toEqual(['resources:waiting']);
    expect(stuck[0].problem).toMatch(/swap is high but steady.*holding the most memory: Google/);
    // The monitor grants nothing (swap creeping up, rule off, critical): no holders, no steady line.
    grant = undefined;
    const critical = (await check.run()) as { problem: string }[];
    expect(critical[0].problem).not.toMatch(/steady|holding/);
  });

  // 2026-11-08, real case cb1641b6: a single task had waited 12 min, only one pending, 43 %
  // memory free, swap steady — yet admission-state.json showed steadySwapSince 0.8 min old. With
  // memory flipping around 2 × the 20 % floor (38-45 %), one not-steady sample reset the clock on
  // every evaluation and «next in 15 min» never arrived. The hysteresis keeps the clock running.
  it('memory oscillating around 2 × the minimum does not reset the steady clock (2026-11-08)', async () => {
    let free = 45;
    const monitor = createResourceMonitor({
      sample: async () => ({ ...steadyCase({ memFreePercent: free }), at: Date.now() }),
      historyMs: 60 * 60_000,
    });
    for (let minute = 0; minute < 15; minute++) {
      // Even minutes 45 % (enters the roomy band), odd 38 % (under 2 × min but over 1.75 × it).
      free = minute % 2 === 0 ? 45 : 38;
      await monitor.refresh();
      expect(monitor.admission().ok).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    free = 42;
    await monitor.refresh();
    const let_in = monitor.admission();
    expect(let_in.ok).toBe(true);
    expect(let_in.detail).toMatch(/one let in now/);
    // The clock never reset: no stall for the doctor to warn about.
    expect(monitor.grantStalls()).toEqual({ steady: 0, cpu: 0 });
  });

  it('a lone task arriving into a long-steady Mac is not made to wait the window afresh (2026-11-08)', async () => {
    // The clock is kept by the sampler, not started when a task asks: a task that shows up after
    // swap has been steady past the window is let in at once (requirement: shorten a lone wait).
    const monitor = createResourceMonitor({
      sample: async () => ({ ...steadyCase(), at: Date.now() }),
      historyMs: 60 * 60_000,
    });
    // 16 min of steady sampling with nobody queued (as the server does every 10 s).
    for (let minute = 0; minute < 16; minute++) {
      await monitor.refresh();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await monitor.refresh();
    // First task to ask: the window already elapsed, so it goes now instead of waiting 15 min.
    expect(monitor.admission().ok).toBe(true);
    monitor.started();
    // The next one is paced its own window again.
    await vi.advanceTimersByTimeAsync(60_000);
    await monitor.refresh();
    expect(monitor.admission().ok).toBe(false);
  });

  it('the steady clock resets only after a sustained drop, counted as a stall (2026-11-08)', async () => {
    let free = 45;
    const monitor = createResourceMonitor({
      sample: async () => ({ ...steadyCase({ memFreePercent: free }), at: Date.now() }),
      historyMs: 60 * 60_000,
    });
    await monitor.refresh();
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    await monitor.refresh();
    // One sample under the memory floor: not a reset (CLOCK_RESET_GRACE_MS not elapsed).
    free = 15;
    await monitor.refresh();
    expect(monitor.grantStalls().steady).toBe(0);
    // Back in the band within the grace: the clock survived, the grant is still near.
    free = 45;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await monitor.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    await monitor.refresh();
    expect(monitor.admission().ok).toBe(true);
    // A sustained drop (over 3 min): now the clock resets, once, and is counted.
    free = 15;
    for (let i = 0; i < 4; i++) {
      await monitor.refresh();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(monitor.grantStalls().steady).toBe(1);
    expect(monitor.admission().ok).toBe(false);
  });

  it('clears stale grant-clock stalls once there is room again (review 2026-11-08)', async () => {
    // A reset left the clock undefined; room then returned and tasks ran, but the old stall from
    // the idle flap persisted, so a later queue could be denounced on failures that never
    // involved a waiting task. Room (judged.ok) and any start now drop the count.
    let s = steadyCase();
    const monitor = createResourceMonitor({
      sample: async () => ({ ...s, at: Date.now() }),
      historyMs: 60 * 60_000,
    });
    await monitor.refresh();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // Sustained drop under the memory floor: the steady clock resets, a stall is counted.
    s = steadyCase({ memFreePercent: 15 });
    for (let i = 0; i < 4; i++) {
      await monitor.refresh();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(monitor.grantStalls().steady).toBe(1);
    // Swap given back, pressure normal, memory fine (judged.ok): the stale stall is dropped.
    s = sample();
    await monitor.refresh();
    expect(monitor.admission().ok).toBe(true);
    expect(monitor.grantStalls().steady).toBe(0);
  });

  it('doctor: warns when a grant clock keeps resetting without letting a task in (2026-11-08)', async () => {
    const now = Date.now();
    const tasks = [
      {
        id: 'ddddeeee0000',
        name: 'T',
        state: 'queued',
        stateSince: new Date(now - 20 * 60_000).toISOString(),
        queued: {
          repoPath: '/r',
          since: '',
          order: 1,
          resources: { short: ['swap'], detail: 'swap 6.6 GB in use', at: '' },
        },
      },
    ];
    let stalls = { steady: GRANT_STALL_WARN, cpu: 0 };
    const check = resourcesCheck({
      monitor: {
        latest: () => steadyCase({ at: now }),
        lastError: () => undefined,
        settings: () => DEFAULT_TASK_ADMISSION,
        lastStartedAt: () => now - 5 * 60_000,
        steadySwapGrant: () => undefined,
        grantStalls: () => stalls,
      },
      tasks: () => tasks as never,
      now: () => now,
    });
    const found = (await check.run()) as { key: string; problem: string }[];
    expect(found.map((f) => f.key)).toContain('resources:grant-flapping');
    expect(found.find((f) => f.key === 'resources:grant-flapping')?.problem).toMatch(
      new RegExp(`steady-swap \\(${GRANT_STALL_WARN}×\\).*never fires`)
    );
    // Under the threshold: no warning.
    stalls = { steady: GRANT_STALL_WARN - 1, cpu: 1 };
    expect(((await check.run()) as { key: string }[]).map((f) => f.key)).not.toContain(
      'resources:grant-flapping'
    );
    // No task waiting for room: nothing to warn about even if a clock reset.
    stalls = { steady: GRANT_STALL_WARN + 2, cpu: 0 };
    tasks.length = 0;
    expect(((await check.run()) as { key: string }[]).map((f) => f.key)).not.toContain(
      'resources:grant-flapping'
    );
  });
  // 2026-11-10, real case: swap 6.7-7.3 GB of 8 for hours, memory over 50 % free, 11+ tasks of
  // three projects queued. Every wobble of swap past the growth limit reads as «swap growing»
  // for a whole window (growth counts from the lowest point in it), longer than the reset grace,
  // so the steady clock went back to zero each time and «next in 15 min» never arrived.
  const flappingSwap = (minute: number) => (minute % 9 >= 5 ? 7.3 : 6.7) * GB;
  /** One hour sampled every 30 s with a task always asking; the minutes at which one got in. */
  const runHour = async (
    monitor: ReturnType<typeof createResourceMonitor>,
    set: (minute: number) => void
  ) => {
    const grants: number[] = [];
    for (let step = 0; step <= 120; step++) {
      set(step / 2);
      await monitor.refresh();
      if (monitor.admission().ok) {
        grants.push(step / 2);
        monitor.started();
      }
      await vi.advanceTimersByTimeAsync(30_000);
    }
    return grants;
  };

  it('a swap flapping around the growth limit still lets one task in every 15 min (2026-11-10)', async () => {
    let swap = 6.7 * GB;
    const monitor = createResourceMonitor({
      sample: async () => ({
        ...steadyCase({ swapUsedBytes: swap, memFreePercent: 52, memAvailableBytes: 12 * GB }),
        at: Date.now(),
      }),
    });
    const grants = await runHour(monitor, (minute) => {
      swap = flappingSwap(minute);
    });
    // Without the exit hysteresis: none in the hour. With it: one every 15 min, as soon as swap
    // is judged steady again (never while it reads as growing).
    expect(grants.length).toBeGreaterThanOrEqual(3);
    const gaps = grants.map((at, i) => at - (grants[i - 1] ?? 0));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(15);
      expect(gap).toBeLessThanOrEqual(20);
    }
    for (const at of grants) expect(flappingSwap(at)).toBe(6.7 * GB);
    expect(monitor.grantStalls()).toEqual({ steady: 0, cpu: 0 });
    expect(monitor.forcedGrants().count).toBe(0);
  });

  it('real growth (over twice the limit) still cancels the turn, and nothing gets in while it grows', async () => {
    let swap = 5 * GB;
    const monitor = createResourceMonitor({
      sample: async () => ({ ...steadyCase({ swapUsedBytes: swap }), at: Date.now() }),
    });
    await monitor.refresh();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await monitor.refresh();
    for (let minute = 0; minute < 30; minute++) {
      swap += 0.3 * GB; // 3 GB per window, six times the limit
      await monitor.refresh();
      expect(monitor.admission().ok).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(monitor.grantStalls().steady).toBe(1);
  });

  it('a cancelled turn keeps the time already waited (2026-11-10)', async () => {
    let free = 46;
    const monitor = createResourceMonitor({
      sample: async () => ({ ...steadyCase({ memFreePercent: free }), at: Date.now() }),
    });
    const sampleFor = async (minutes: number) => {
      for (let i = 0; i < minutes * 2; i++) {
        await monitor.refresh();
        await vi.advanceTimersByTimeAsync(30_000);
      }
      await monitor.refresh();
    };
    await sampleFor(10);
    expect(monitor.admission().detail).toMatch(/next in 5 min/);
    // Memory really under its floor for 6 min: the turn is cancelled (a stall)…
    free = 15;
    await sampleFor(6);
    expect(monitor.grantStalls().steady).toBe(1);
    expect(monitor.admission().ok).toBe(false);
    // …but the 10 min waited are not lost: 5 more of steady and one gets in, not 15.
    free = 46;
    await sampleFor(1);
    expect(monitor.admission().detail).toMatch(/next in 4 min/);
    await sampleFor(4);
    expect(monitor.admission().ok).toBe(true);
    monitor.started();
    expect(monitor.grantStalls().steady).toBe(0);
    // Out of condition for a long time (CLOCK_BANK_KEEP_MS): the waited time is forgotten.
    await sampleFor(10);
    free = 15;
    await sampleFor(CLOCK_BANK_KEEP_MS / 60_000 + 4);
    free = 46;
    await sampleFor(1);
    expect(monitor.admission().detail).toMatch(/next in 14 min/);
  });

  it('a turn cancelled GRANT_FORCE_AFTER times running lets one task in anyway, on record (2026-11-10)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-admission-'));
    try {
      const stateFile = path.join(dir, 'admission-state.json');
      let free = 46;
      const monitor = createResourceMonitor({
        sample: async () => ({ ...steadyCase({ memFreePercent: free }), at: Date.now() }),
        stateFile,
      });
      // In condition 1 min of every 5 (memory really under its floor the other 4): the waited
      // time adds up to 3 min in 15, so the clock alone would take over an hour.
      const details: string[] = [];
      const grants: number[] = [];
      for (let step = 0; step <= 120; step++) {
        const minute = step / 2;
        free = minute % 5 < 1 ? 46 : 15;
        await monitor.refresh();
        const verdict = monitor.admission();
        if (verdict.ok) {
          grants.push(minute);
          details.push(verdict.detail);
          monitor.started();
        }
        await vi.advanceTimersByTimeAsync(30_000);
      }
      // Dosed, not blocked: one roughly every 15 min, only at a moment the signal is fine.
      expect(grants.length).toBeGreaterThanOrEqual(3);
      const gaps = grants.map((at, i) => at - (grants[i - 1] ?? 0));
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(15);
      for (const at of grants) expect(at % 5).toBeLessThan(1);
      expect(details[0]).toMatch(
        new RegExp(
          `turn cancelled ${GRANT_FORCE_AFTER}× without letting a task in: one let in anyway`
        )
      );
      const forced = monitor.forcedGrants();
      expect(forced.count).toBe(grants.length);
      expect(forced.last?.clock).toBe('steady-swap');
      expect(forced.last?.cancelled).toBeGreaterThanOrEqual(GRANT_FORCE_AFTER);
      expect(monitor.grantStalls().steady).toBeLessThan(GRANT_FORCE_AFTER);
      // On record across restarts too, with the stall count and the waited time.
      const kept = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(kept.forced.count).toBe(grants.length);
      expect(kept.forced.last.clock).toBe('steady-swap');
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });

  it('the stalls and the waited time of a cancelled turn survive a server restart (2026-11-10)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-admission-'));
    try {
      const stateFile = path.join(dir, 'admission-state.json');
      let free = 46;
      const make = () =>
        createResourceMonitor({
          sample: async () => ({ ...steadyCase({ memFreePercent: free }), at: Date.now() }),
          stateFile,
        });
      const first = make();
      await first.refresh();
      await vi.advanceTimersByTimeAsync(8 * 60_000);
      free = 15;
      for (let i = 0; i < 5; i++) {
        await first.refresh();
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(first.grantStalls().steady).toBe(1);
      const second = make();
      expect(second.grantStalls().steady).toBe(1);
      free = 46;
      await second.refresh();
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await second.refresh();
      // 8 min waited before the restart + 3 after: 4 to go (warming up meanwhile counts).
      expect(second.admission().detail).toMatch(/next in 4 min/);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });

  it('doctor: tells a forced grant of the last hour (2026-11-10)', async () => {
    const now = Date.now();
    let last = { at: now - 10 * 60_000, clock: 'steady-swap' as const, cancelled: 3 };
    const check = resourcesCheck({
      monitor: {
        latest: () => steadyCase({ at: now }),
        lastError: () => undefined,
        settings: () => DEFAULT_TASK_ADMISSION,
        forcedGrants: () => ({ count: 2, last }),
      },
      tasks: () => [],
      now: () => now,
    });
    const found = (await check.run()) as { key: string; severity: string; problem: string }[];
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ key: 'resources:grant-forced', severity: 'info' });
    expect(found[0].problem).toMatch(
      /steady-swap turn was cancelled 3× .* let in anyway 10 min ago/
    );
    last = { ...last, at: now - 2 * 60 * 60_000 };
    expect(await check.run()).toEqual([]);
  });

  describe('the admission state survives a server restart (2026-11-11)', () => {
    const MB = 1024 ** 2;
    let dir: string;
    let stateFile: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-admission-'));
      stateFile = path.join(dir, 'admission-state.json');
    });
    afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

    it('a restart in the middle of the window does not start it again', async () => {
      const make = () =>
        createResourceMonitor({
          sample: async () => ({ ...steadyCase(), at: Date.now() }),
          stateFile,
        });
      const first = make();
      for (let tick = 0; tick <= 16; tick++) {
        await first.refresh();
        if (tick < 16) await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(first.steadySwapGrant()).toEqual({ waitMin: 15 });
      // Restarted 8 min into the window: its samples are read back, each with its time.
      await vi.advanceTimersByTimeAsync(20_000);
      const second = make();
      expect(second.history()).toHaveLength(17);
      expect(second.history()[0].at).toBe(Date.now() - 8 * 60_000 - 20_000);
      // What was read back tells the trend, not the Mac as it is now: its own sample first.
      expect(second.admission()).toMatchObject({ ok: false, settling: true });
      await second.refresh();
      const verdict = second.admission();
      expect(verdict.warmingUp).toBeUndefined();
      expect(verdict.detail).toMatch(/swap steady at 6\.[0-9] GB .*next in 7 min/);
      expect(second.steadySwapGrant()).toEqual({ waitMin: 15 });
      // Growth is still counted from before the restart.
      const third = createResourceMonitor({
        sample: async () => ({ ...steadyCase({ swapUsedBytes: 9 * GB }), at: Date.now() }),
        stateFile,
      });
      await third.refresh();
      expect(third.admission().detail).toMatch(/swap growing \+/);
    });

    it('samples older than the window, or not samples at all, are not read back', async () => {
      const first = createResourceMonitor({
        sample: async () => ({ ...steadyCase(), at: Date.now() }),
        stateFile,
      });
      await first.refresh();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await first.refresh();
      const kept = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(kept.samples).toHaveLength(2);
      // Down 8 min: the first sample (13 min old) is past the 11 min kept, the second is not.
      await vi.advanceTimersByTimeAsync(8 * 60_000);
      expect(createResourceMonitor({ stateFile }).history()).toHaveLength(1);
      // Broken ones, out of order or from the future: left out, the rest stands.
      const good = kept.samples[1];
      fs.writeFileSync(
        stateFile,
        JSON.stringify({
          ...kept,
          samples: [
            good,
            { ...good, at: good.at - 1 },
            { ...good, at: Date.now() + 60_000 },
            { ...good, at: good.at + 1, swapUsedBytes: 'much' },
            { ...good, at: good.at + 2, pressure: 'odd' },
            null,
            7,
          ],
        })
      );
      expect(createResourceMonitor({ stateFile }).history()).toEqual([good]);
      fs.writeFileSync(stateFile, JSON.stringify({ ...kept, samples: 'none' }));
      expect(createResourceMonitor({ stateFile }).history()).toEqual([]);
    });

    /**
     * A task asks for room every 30 s while the server restarts every `restartMin`; swap sits
     * 300 MB higher (under the 512 MB limit) from a minute after each restart until the next
     * (what a merge sets off: the restart, and the next checks). When it got in (min), or -1.
     */
    const letInAfter = async (restartMin: number, hours: number) => {
      const start = Date.now();
      let monitor: ReturnType<typeof createResourceMonitor> | undefined;
      for (let tick = 0; tick <= hours * 120; tick++) {
        const sinceRestart = tick % (restartMin * 2);
        if (sinceRestart === 0) {
          monitor = createResourceMonitor({
            sample: async () => ({
              ...steadyCase({
                swapUsedBytes: 6.5 * GB + (sinceRestartNow() >= 2 ? 300 * MB : 0),
              }),
              at: Date.now(),
            }),
            stateFile,
          });
        }
        await monitor?.refresh();
        if (monitor?.admission({ waitedMs: Date.now() - start }).ok) {
          return (Date.now() - start) / 60_000;
        }
        await vi.advanceTimersByTimeAsync(30_000);
      }
      return -1;
      function sinceRestartNow() {
        return Math.round((Date.now() - start) / 30_000) % (restartMin * 2);
      }
    };

    it('a restart every 5 min does not keep a task out: it gets in at its turn', async () => {
      expect(await letInAfter(5, 3)).toBe(15);
    });

    it('a restart every 90 s (under the warm-up) does not keep it out either', async () => {
      const waited = await letInAfter(1.5, 3);
      expect(waited).toBeGreaterThan(0);
      expect(waited).toBeLessThanOrEqual(20);
    });

    it('a task that waited trendUnknownMaxWaitMin on an unknown trend takes the turn without the window', async () => {
      // No state on disk and a warm-up that never ends here: the trend stays unknown.
      let next = steadyCase();
      let settings = { ...DEFAULT_TASK_ADMISSION, swapWarmupMin: 120 };
      const monitor = createResourceMonitor({
        sample: async () => ({ ...next, at: Date.now() }),
        settings: () => settings,
      });
      const minutes = async (count: number) => {
        for (let minute = 0; minute < count; minute++) {
          await vi.advanceTimersByTimeAsync(60_000);
          await monitor.refresh();
        }
      };
      await monitor.refresh();
      await minutes(31);
      const WAITED = 31 * 60_000;
      // Nobody has waited that long: held as before.
      expect(monitor.admission()).toMatchObject({ ok: false, warmingUp: true });
      expect(monitor.admission({ waitedMs: 29 * 60_000 }).ok).toBe(false);
      const verdict = monitor.admission({ waitedMs: WAITED });
      expect(verdict.ok).toBe(true);
      expect(verdict.detail).toMatch(/trend not known yet.*waited over 30 min for the trend/);
      // Dosed like the steady swap: the next one waits its 15 min, however long it has waited.
      monitor.started();
      await minutes(14);
      expect(monitor.admission({ waitedMs: 5 * WAITED }).ok).toBe(false);
      await minutes(1);
      expect(monitor.admission({ waitedMs: 5 * WAITED }).ok).toBe(true);
      // Never past a real signal: memory under its floor holds whoever waits.
      next = steadyCase({ memFreePercent: 10 });
      await monitor.refresh();
      expect(monitor.admission({ waitedMs: 5 * WAITED })).toMatchObject({
        ok: false,
        short: ['memory'],
      });
      // 0 turns it off.
      next = steadyCase();
      await monitor.refresh();
      expect(monitor.admission({ waitedMs: 5 * WAITED }).ok).toBe(true);
      settings = { ...settings, trendUnknownMaxWaitMin: 0 };
      expect(monitor.admission({ waitedMs: 5 * WAITED }).ok).toBe(false);
    });
  });
});

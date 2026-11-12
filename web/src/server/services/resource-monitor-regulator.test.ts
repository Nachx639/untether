/**
 * Task admission as a regulator with a target (2026-11-11). A nearly idle Mac (load 5.9 on 12
 * cores, 68 % memory free, swap 6.25 of 7.17 GB and still) let one task in every 15 min: the
 * amount of swap in use paced them by itself. What must hold now:
 * - those real figures let tasks in, on the ramp, with no 15 min turn;
 * - the cases of the earlier incidents (swap growing, little memory free, pressure) do not;
 * - a simulated Mac is kept near the target without passing the limits.
 * Every monitor here is fed simulated samples on a clock of its own; nothing real is sampled.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { resourcesCheck } from './doctor-checks.js';
import {
  createResourceMonitor,
  DEFAULT_TASK_ADMISSION,
  DEFAULT_TYPICAL_TASK,
  judgeAdmission,
  loadLimitOf,
  pagingRate,
  parseVmStatSwap,
  type ResourceSample,
  roomFor,
  type TaskAdmissionSettings,
} from './resource-monitor.js';
import {
  CHECK_RAMP_MS,
  type CheckMargin,
  checkConcurrency,
  createLimiter,
  DEFAULT_CHECK_LOAD,
} from './task-verify.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const STEP_MS = 10_000;

/** The Mac of 11-nov 04:10, as measured: nearly idle, with old swap that does not move. */
const REAL: Omit<ResourceSample, 'at'> = {
  load: 5.9,
  cores: 12,
  memTotalBytes: 24 * GB,
  memAvailableBytes: 15 * GB,
  memFreePercent: 68,
  pressure: 'normal',
  swapUsedBytes: 6.25 * GB,
  swapTotalBytes: 7.17 * GB,
  swapins: 146_397_342,
  swapouts: 164_414_122,
};

/** A monitor on its own clock, fed whatever `mac()` says the Mac looks like now. */
function rig(
  mac: (at: number) => Omit<ResourceSample, 'at'>,
  options: { settings?: Partial<TaskAdmissionSettings>; stateFile?: string } = {}
) {
  let at = Date.UTC(2026, 10, 11, 3, 10);
  const monitor = createResourceMonitor({
    sample: async () => ({ ...mac(at), at }),
    settings: () => ({ ...DEFAULT_TASK_ADMISSION, ...options.settings }),
    now: () => at,
    ...(options.stateFile ? { stateFile: options.stateFile } : {}),
  });
  return {
    monitor,
    now: () => at,
    /** Time goes by, a sample every 10 s (the first one right away). */
    async run(ms: number) {
      await monitor.refresh();
      for (let gone = 0; gone < ms; gone += STEP_MS) {
        at += STEP_MS;
        await monitor.refresh();
      }
    },
  };
}

describe('task admission: a regulator with a target (2026-11-11)', () => {
  describe('the real figures of 11-nov 04:10', () => {
    it('old swap that does not move, with memory to spare, holds no one and paces no one', async () => {
      const { monitor, run } = rig(() => REAL);
      await run(11 * 60_000);
      const verdict = monitor.admission();
      expect(verdict).toMatchObject({ ok: true, short: [] });
      expect(verdict.detail).toBe('');
      // Six tasks get in within a few minutes, one at a time, never on a 15 min turn.
      const letIn: number[] = [];
      for (let step = 0; step < 30 && letIn.length < 6; step++) {
        const now = monitor.admission();
        expect(now.detail).not.toMatch(/one task let in every/);
        if (now.ok) {
          monitor.started();
          letIn.push(step);
        }
        await run(STEP_MS);
      }
      expect(letIn).toHaveLength(6);
      // The ramp: never two on the same sample, settleSec (20 s) apart at least.
      for (let i = 1; i < letIn.length; i++)
        expect(letIn[i] - letIn[i - 1]).toBeGreaterThanOrEqual(2);
    });

    it('says how full the Mac is and how many more fit', async () => {
      const { monitor, run } = rig(() => REAL);
      await run(11 * 60_000);
      const room = monitor.room();
      // With swap past its level tasks come in freely down to 40 % free (roomyFreeMemoryPercent):
      // 28 % of 24 GB over it, four tasks of 1.5 GB.
      expect(room).toMatchObject({ percentOfTarget: 53, fits: 4 });
      expect(room?.line).toBe(
        'the Mac is at 53 % of its target (load 5.9 of 12, memory 68 % free, free entry down to 40 % while swap is past its level): room for 4 more tasks (about 1.5 GB and a load of 1.0 each as they start)'
      );
      // Little swap: down to the 20 % floor.
      const little = rig(() => ({ ...REAL, swapUsedBytes: 1 * GB }));
      await little.run(60_000);
      expect(little.monitor.room()).toMatchObject({ percentOfTarget: 49, fits: 7 });
      expect(little.monitor.room()?.line).toMatch(
        /memory 68 % free over a 20 % floor\): room for 7/
      );
      // The same line reaches the doctor, as information.
      const findings = await resourcesCheck({ monitor, tasks: () => [], now: Date.now }).run();
      expect(findings.find((finding) => finding.key === 'resources:room')).toMatchObject({
        severity: 'info',
        problem: `task admission: ${room?.line}`,
      });
    });

    it('just after a start the trend is not known yet: paced, as before, until the warm-up is in', async () => {
      const { monitor, run } = rig(() => REAL);
      await run(30_000);
      expect(monitor.admission()).toMatchObject({ ok: false, short: ['swap'], warmingUp: true });
      await run(2 * 60_000);
      expect(monitor.admission().ok).toBe(true);
    });
  });

  describe('what still keeps tasks out (the earlier incidents)', () => {
    it('swap growing in the window holds, whatever memory is free', async () => {
      const from = Date.UTC(2026, 10, 11, 3, 10);
      // 6.25 → 7.05 GB over 10 min: +800 MB, past the 512 MB limit.
      const { monitor, run } = rig((at) => ({
        ...REAL,
        swapUsedBytes: 6.25 * GB + Math.min(1, (at - from) / 600_000) * 800 * MB,
        swapTotalBytes: 9 * GB,
      }));
      await run(10 * 60_000);
      const verdict = monitor.admission();
      expect(verdict).toMatchObject({ ok: false, short: ['swap'] });
      expect(verdict.detail).toMatch(/swap growing \+0\.8 GB in 10 min \(limit \+512 MB\)/);
      expect(monitor.room()).toMatchObject({ fits: 0 });
      expect(monitor.room()?.line).toMatch(/no task is let in now: swap growing/);
    });

    it('little memory free holds; pressure critical holds', async () => {
      const low = rig(() => ({ ...REAL, memFreePercent: 15, memAvailableBytes: 3 * GB }));
      await low.run(11 * 60_000);
      expect(low.monitor.admission()).toMatchObject({ ok: false, short: ['memory'] });
      expect(low.monitor.admission().detail).toMatch(/memory 15 % free \(min 20 %\)/);
      const critical = rig(() => ({ ...REAL, pressure: 'critical' }));
      await critical.run(11 * 60_000);
      expect(critical.monitor.admission()).toMatchObject({ ok: false, short: ['memory'] });
    });

    it('the 3-oct hang (swap 18 of 19 GB, load 39) stays held', () => {
      const hang = [0, 300_000, 600_000].map((at) => ({
        ...REAL,
        at,
        load: 39,
        memFreePercent: 22,
        swapUsedBytes: 18 * GB,
        swapTotalBytes: 19 * GB,
      }));
      const verdict = judgeAdmission(hang, DEFAULT_TASK_ADMISSION, DEFAULT_TYPICAL_TASK);
      expect(verdict.ok).toBe(false);
      expect(verdict.steadySwap).toBeUndefined();
      expect(verdict.detail).toMatch(/swap nearly full/);
    });

    it('swap over its level without memory to spare still paces, and says that', async () => {
      const { monitor, run } = rig(() => ({ ...REAL, memFreePercent: 35 }));
      await run(11 * 60_000);
      const verdict = monitor.admission();
      expect(verdict).toMatchObject({ ok: false, short: ['swap'], steadySwap: true });
      expect(verdict.detail).toMatch(
        /memory 35 % free with swap past its level \(tasks come in freely from 40 % free\), swap steady at 6\.3 GB/
      );
      expect(verdict.detail).toMatch(/one task let in every 15 min/);
    });

    it('pressure warn still paces, memory to spare or not', async () => {
      const { monitor, run } = rig(() => ({ ...REAL, pressure: 'warn' }));
      await run(11 * 60_000);
      expect(monitor.admission()).toMatchObject({ ok: false, short: ['memory', 'swap'] });
      expect(monitor.admission().detail).toMatch(/pressure warn/);
    });

    it('pages moving to or from swap pace tasks, with the rate in the reason', async () => {
      const from = Date.UTC(2026, 10, 11, 3, 10);
      // 500 pages/s swapped out (8 MB/s) while the amount in use stays where it was.
      const { monitor, run } = rig((at) => ({
        ...REAL,
        swapouts: (REAL.swapouts as number) + ((at - from) / 1000) * 500,
      }));
      await run(11 * 60_000);
      const verdict = monitor.admission();
      expect(verdict).toMatchObject({ ok: false, short: ['swap'] });
      expect(verdict.detail).toMatch(/swapping 500 pages\/s over the last 120 s \(max 64\)/);
      // Under the level it paces too: the Mac is paging now, whatever the amount.
      const little = rig((at) => ({
        ...REAL,
        swapUsedBytes: 1 * GB,
        swapins: (REAL.swapins as number) + ((at - from) / 1000) * 300,
      }));
      await little.run(11 * 60_000);
      expect(little.monitor.admission()).toMatchObject({ ok: false, short: ['swap'] });
    });

    it('vm_stat: the counters are read; a Mac without them is judged by the trend alone', () => {
      const text = [
        'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
        'Pageouts:                                    2732275.',
        'Swapins:                                   146397342.',
        'Swapouts:                                  164414122.',
      ].join('\n');
      expect(parseVmStatSwap(text)).toEqual({ swapins: 146_397_342, swapouts: 164_414_122 });
      expect(parseVmStatSwap('Pages free: 1.')).toBeNull();
      const { swapins: _in, swapouts: _out, ...bare } = REAL;
      const history = [0, 300_000, 600_000].map((at) => ({ ...bare, at }));
      expect(pagingRate(history, 120)).toBeUndefined();
      expect(judgeAdmission(history, DEFAULT_TASK_ADMISSION).ok).toBe(true);
      // Counters that start again (a reboot) are not a rate.
      const reset = [
        { ...REAL, at: 0 },
        { ...REAL, at: 60_000, swapins: 10, swapouts: 10 },
      ];
      expect(pagingRate(reset, 120)).toBeUndefined();
    });
  });

  describe('the load target', () => {
    const waitFor = async (load: number, limitMin: number) => {
      const { monitor, run } = rig(() => ({ ...REAL, swapUsedBytes: 1 * GB, load }));
      await monitor.refresh();
      for (let minute = 0; minute <= limitMin; minute += 0.5) {
        if (monitor.admission().ok) return { minute, monitor };
        await run(30_000);
      }
      return { minute: Number.POSITIVE_INFINITY, monitor };
    };

    it('the target is targetLoadPerCore × cores, with maxLoadPerCore as the net', () => {
      expect(loadLimitOf(DEFAULT_TASK_ADMISSION, 12)).toEqual({ limit: 12, word: 'target' });
      expect(loadLimitOf({ ...DEFAULT_TASK_ADMISSION, targetLoadPerCore: 0 }, 12)).toEqual({
        limit: 24,
        word: 'max',
      });
      // A target past the net does not lift it; the net at 0 still turns the CPU off.
      expect(loadLimitOf({ ...DEFAULT_TASK_ADMISSION, targetLoadPerCore: 3 }, 12).limit).toBe(24);
      expect(loadLimitOf({ ...DEFAULT_TASK_ADMISSION, maxLoadPerCore: 0 }, 12).limit).toBe(0);
    });

    it('past the target tasks come in one at a time, slower the nearer the load is to the net', async () => {
      // By the square root of the way from the target to the net. Just over (13 of 12): under
      // 6 min. Halfway (18): 14 min. At the net and past it (24, 30): the old turn whole.
      expect((await waitFor(13, 30)).minute).toBe(6);
      expect((await waitFor(18, 30)).minute).toBe(14.5);
      expect((await waitFor(24, 30)).minute).toBe(20);
      expect((await waitFor(30, 30)).minute).toBe(20);
    });

    it('says the turn and when it comes', async () => {
      const { monitor, run } = rig(() => ({ ...REAL, swapUsedBytes: 1 * GB, load: 18 }));
      await run(60_000);
      const verdict = monitor.admission();
      expect(verdict).toMatchObject({ ok: false, short: ['cpu'] });
      expect(verdict.detail).toBe(
        'load 18.0 (target 12); with only the CPU short one task is let in every 14 min at this load (next in 14 min)'
      );
    });

    it('past maxGrantLoadPerCore (the night of 10-nov, load 200-590) not even the turn lets one in', async () => {
      const { minute, monitor } = await waitFor(200, 60);
      expect(minute).toBe(Number.POSITIVE_INFINITY);
      expect(monitor.admission().detail).toBe(
        'load 200.0 (target 12); over 4 × cores no task is let in until the load drops'
      );
      expect(monitor.room()).toMatchObject({ fits: 0 });
    });
  });

  describe('the ramp', () => {
    it('room for one more over the floor: the one let in keeps it until the samples show it', async () => {
      // 30 % free: 2.4 GB over the 20 % floor, one typical task (1.5 GB).
      const { monitor, run } = rig(() => ({ ...REAL, swapUsedBytes: 1 * GB, memFreePercent: 30 }));
      await run(60_000);
      expect(monitor.admission().ok).toBe(true);
      monitor.started();
      expect(monitor.admission()).toMatchObject({ ok: false, short: [], settling: true });
      expect(monitor.admission().detail).toMatch(/settling \(20 s\)/);
      await run(30_000);
      const kept = monitor.admission();
      expect(kept).toMatchObject({ ok: false, short: [], settling: true });
      expect(kept.detail).toMatch(/1 task\(s\) let in over the last 90 s are still starting/);
      await run(60_000);
      expect(monitor.admission().ok).toBe(true);
    });

    it('over the floor by less than a task takes: not let in, and the reason says so', async () => {
      const { monitor, run } = rig(() => ({ ...REAL, swapUsedBytes: 1 * GB, memFreePercent: 24 }));
      await run(60_000);
      const verdict = monitor.admission();
      expect(verdict).toMatchObject({ ok: false, short: ['memory'] });
      expect(verdict.detail).toBe(
        'memory 24 % free: one more task (about 1.5 GB as it starts) would go under the 20 % floor'
      );
    });

    it('roomFor: by memory over the floor and by load under the target, less the ones just let in', () => {
      const sample = { ...REAL, swapUsedBytes: 1 * GB, at: 0 };
      expect(roomFor(sample, DEFAULT_TASK_ADMISSION)).toMatchObject({ byMemory: 7, byCpu: 7 });
      expect(roomFor(sample, DEFAULT_TASK_ADMISSION, DEFAULT_TYPICAL_TASK, 3).fits).toBe(4);
      const heavy = { memBytes: 3 * GB, load: 2, learned: 5 };
      expect(roomFor(sample, DEFAULT_TASK_ADMISSION, heavy)).toMatchObject({
        byMemory: 3,
        byCpu: 4,
        fits: 3,
      });
      // Swap past its level: counted down to roomyFreeMemoryPercent, where the free entry ends.
      expect(roomFor({ ...REAL, at: 0 }, DEFAULT_TASK_ADMISSION)).toMatchObject({
        byMemory: 4,
        fits: 4,
      });
    });

    describe('what a task takes as it starts is learned', () => {
      let dir: string;
      beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-regulator-'));
      });
      afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

      it('from the samples after each start, and kept across a restart', async () => {
        const stateFile = path.join(dir, 'admission-state.json');
        let started = false;
        // A start takes 10 % of 24 GB (2.4 GB) and adds a load of 2.
        const mac = () => ({
          ...REAL,
          swapUsedBytes: 1 * GB,
          memFreePercent: started ? 58 : 68,
          load: started ? 5 : 3,
        });
        const { monitor, run } = rig(mac, { stateFile });
        await run(60_000);
        expect(monitor.typicalTask()).toEqual(DEFAULT_TYPICAL_TASK);
        monitor.started();
        started = true;
        await run(100_000);
        // A moving average from 1.5 GB and a load of 1; heavier than expected weighs 0.5.
        const learned = monitor.typicalTask();
        expect(learned.learned).toBe(1);
        expect(learned.memBytes / GB).toBeCloseTo(1.5 + 0.5 * (2.4 - 1.5), 5);
        expect(learned.load).toBeCloseTo(1 + 0.5 * (2 - 1), 5);
        expect(monitor.room()?.line).toMatch(/about (1\.9|2\.0) GB and a load of 1\.5 each/);
        const again = rig(mac, { stateFile });
        expect(again.monitor.typicalTask()).toEqual(learned);
      });

      it('one outlier (a check running beside it) does not rule: what is learned is bounded', async () => {
        let started = false;
        const mac = () => ({
          ...REAL,
          swapUsedBytes: 1 * GB,
          memFreePercent: started ? 30 : 68,
          load: started ? 11 : 3,
        });
        const { monitor, run } = rig(mac);
        await run(60_000);
        monitor.started();
        started = true;
        await run(100_000);
        // Bounded at an eighth of the RAM (3 GB) and a load of 3 before it is averaged in.
        expect(monitor.typicalTask().memBytes / GB).toBeCloseTo(1.5 + 0.5 * (3 - 1.5), 5);
        expect(monitor.typicalTask().load).toBeCloseTo(1 + 0.5 * (3 - 1), 5);
      });

      it('lighter than expected comes down slowly; starts let in together share what was seen', async () => {
        let at0 = 0;
        const taken = (at: number) => (at0 ? Math.min(1, (at - at0) / 60_000) : 0);
        // Two tasks 20 s apart, 0.6 GB each over their first minute.
        const second = (at: number) =>
          at0 ? Math.min(1, Math.max(0, at - at0 - 20_000) / 60_000) : 0;
        const mac = (at: number) => ({
          ...REAL,
          swapUsedBytes: 1 * GB,
          memFreePercent: 68 - ((taken(at) + second(at)) * 0.6 * 100) / 24,
          load: 3,
        });
        const { monitor, run, now } = rig(mac);
        await run(60_000);
        monitor.started();
        at0 = now();
        await run(20_000);
        monitor.started();
        await run(200_000);
        const learned = monitor.typicalTask();
        expect(learned.learned).toBe(2);
        // Each saw about 1.2 GB between the two of them: 0.6-0.7 GB apiece, weighed 0.15 twice.
        expect(learned.memBytes / GB).toBeGreaterThan(1.2);
        expect(learned.memBytes / GB).toBeLessThan(1.35);
        // No load added: bounded below at 0.25, slowly.
        expect(learned.load).toBeCloseTo(1 - 0.15 * 0.75 - 0.15 * (1 - 0.15 * 0.75 - 0.25), 5);
      });
    });
  });

  describe("the checks' slots follow the real margin", () => {
    const margin = (over: Partial<CheckMargin> = {}): CheckMargin => ({
      active: 2,
      sinceStartMs: 5 * 60_000,
      load: 6,
      threshold: 24,
      room: true,
      ...over,
    });

    it('one per 6 cores, and more only while the running ones leave a check of margin', () => {
      const slots = (over: Partial<CheckMargin> = {}) =>
        checkConcurrency(DEFAULT_CHECK_LOAD, 12, margin(over));
      // Nothing known of the Mac: the fixed ones.
      expect(checkConcurrency(DEFAULT_CHECK_LOAD, 12)).toBe(2);
      // Two light checks running at load 6: 18 under the gate, room for two more, capped at 4.
      expect(slots()).toBe(4);
      expect(slots({ load: 12 })).toBe(3);
      // Two real checks (load 18 and over): no more, the next one would pass the gate.
      expect(slots({ load: 13 })).toBe(2);
      expect(slots({ load: 30 })).toBe(2);
      // Not while the base slots are free, a check just started, or the Mac has no room.
      expect(slots({ active: 1 })).toBe(2);
      expect(slots({ sinceStartMs: CHECK_RAMP_MS - 1 })).toBe(2);
      expect(slots({ active: 3, sinceStartMs: 1000 })).toBe(3);
      expect(slots({ room: false })).toBe(2);
      expect(slots({ threshold: 0 })).toBe(2);
      // Never past one per 3 cores; a number set by hand is that number.
      expect(slots({ active: 4, load: 0 })).toBe(4);
      expect(checkConcurrency({ ...DEFAULT_CHECK_LOAD, maxConcurrent: 5 }, 12, margin())).toBe(5);
    });

    it('the limiter hands its state to the limit and looks again by itself: the slot is taken once the last start shows', async () => {
      vi.useFakeTimers();
      try {
        let done = false;
        const limiter = createLimiter(
          (state) => checkConcurrency(DEFAULT_CHECK_LOAD, 12, margin(state)),
          undefined,
          Date.now,
          undefined,
          15_000
        );
        const check = () =>
          limiter.run(async () => {
            while (!done) await new Promise((resolve) => setTimeout(resolve, 1000));
          });
        const running = [check(), check(), check(), check(), check()];
        await vi.advanceTimersByTimeAsync(1000);
        // Two start at once; the others wait for the ramp though the load leaves margin.
        expect([limiter.active, limiter.queued]).toEqual([2, 3]);
        await vi.advanceTimersByTimeAsync(CHECK_RAMP_MS - 20_000);
        expect([limiter.active, limiter.queued]).toEqual([2, 3]);
        // Past the ramp nobody ends and nobody joins: the limiter's own look starts the third.
        await vi.advanceTimersByTimeAsync(35_000);
        expect([limiter.active, limiter.queued]).toEqual([3, 2]);
        // One slot per ramp window, never past one per 3 cores.
        await vi.advanceTimersByTimeAsync(CHECK_RAMP_MS + 15_000);
        expect([limiter.active, limiter.queued]).toEqual([4, 1]);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect([limiter.active, limiter.queued]).toEqual([4, 1]);
        done = true;
        await vi.advanceTimersByTimeAsync(2000);
        await Promise.all(running);
        expect([limiter.active, limiter.queued]).toEqual([0, 0]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Simulation: a model Mac driven by the monitor's own decisions
// ---------------------------------------------------------------------------------------------

/**
 * A 12-core, 24 GB Mac. Each task let in takes its memory over its first minute and adds its
 * load at once; the 1-minute load average follows the instantaneous one as the kernel's does.
 * `outside(minute)` is load from elsewhere (checks, backups: the night of 10-nov).
 */
async function simulate(options: {
  minutes: number;
  queued: number;
  taskMinutes: number;
  /** Swap in use, still all along (default: the 6.25 GB of 11-nov, over its level). */
  swapGb?: number;
  /** What each task takes: memory in GB (cycled through) and load. */
  taskGb?: number[];
  taskLoad?: number;
  outside?: (minute: number) => number;
  settings?: Partial<TaskAdmissionSettings>;
}) {
  const cores = 12;
  const total = 24 * GB;
  const baseUsed = 0.32 * total;
  const sizes = (options.taskGb ?? [1.0, 1.4, 1.8, 2.2]).map((size) => size * GB);
  const taskLoad = options.taskLoad ?? 0.8;
  const tasks: { at: number; mem: number }[] = [];
  let at = Date.UTC(2026, 10, 10, 21, 0);
  const from = at;
  let load = 2;
  const minuteOf = (time: number) => (time - from) / 60_000;
  const running = () => tasks.filter((task) => at - task.at < options.taskMinutes * 60_000);
  const used = () =>
    baseUsed +
    running().reduce((sum, task) => sum + task.mem * Math.min(1, (at - task.at) / 60_000), 0);
  const monitor = createResourceMonitor({
    sample: async () => {
      const free = Math.max(0, total - used());
      return {
        at,
        load,
        cores,
        memTotalBytes: total,
        memAvailableBytes: free,
        memFreePercent: (free / total) * 100,
        pressure: 'normal' as const,
        swapUsedBytes: (options.swapGb ?? 6.25) * GB,
        swapTotalBytes: 7.17 * GB,
        swapins: 146_397_342,
        swapouts: 164_414_122,
      };
    },
    settings: () => ({ ...DEFAULT_TASK_ADMISSION, ...options.settings }),
    now: () => at,
  });
  let queued = options.queued;
  const trace: {
    minute: number;
    load: number;
    freePercent: number;
    percentOfTarget: number;
    running: number;
    queued: number;
    letIn: number;
  }[] = [];
  for (let step = 0; step < (options.minutes * 60_000) / STEP_MS; step++) {
    const instant = 2 + running().length * taskLoad + (options.outside?.(minuteOf(at)) ?? 0);
    load += (instant - load) * (1 - Math.exp(-STEP_MS / 60_000));
    const sample = await monitor.refresh();
    let letIn = 0;
    // The scheduler's pump: it asks, and whoever is let in starts.
    while (queued > 0 && monitor.admission().ok) {
      monitor.started();
      tasks.push({ at, mem: sizes[tasks.length % sizes.length] });
      queued -= 1;
      letIn += 1;
    }
    trace.push({
      minute: minuteOf(at),
      load,
      freePercent: sample?.memFreePercent ?? 0,
      percentOfTarget: monitor.room()?.percentOfTarget ?? 0,
      running: running().length,
      queued,
      letIn,
    });
    at += STEP_MS;
  }
  const mean = (points: typeof trace, pick: (point: (typeof trace)[number]) => number) =>
    points.reduce((sum, point) => sum + pick(point), 0) / Math.max(1, points.length);
  // Past the ramp, while work still waits.
  const cruising = trace.filter((point) => point.minute >= 10 && point.queued > 0);
  return {
    trace,
    started: tasks.length,
    letInBy: (minute: number) =>
      trace.filter((point) => point.minute < minute).reduce((sum, point) => sum + point.letIn, 0),
    mostAtOnce: Math.max(...trace.map((point) => point.letIn)),
    meanPercentOfTarget: mean(cruising, (point) => point.percentOfTarget),
    meanRunning: mean(cruising, (point) => point.running),
    minFreePercent: Math.min(...trace.map((point) => point.freePercent)),
    maxLoad: Math.max(...trace.map((point) => point.load)),
  };
}

describe('task admission: simulation of the regulator (2026-11-11)', () => {
  const figures = (run: Awaited<ReturnType<typeof simulate>>) => ({
    letInBy5: run.letInBy(5),
    started: run.started,
    meanRunning: Number(run.meanRunning.toFixed(1)),
    meanPercentOfTarget: Math.round(run.meanPercentOfTarget),
    minFreePercent: Number(run.minFreePercent.toFixed(1)),
    maxLoad: Number(run.maxLoad.toFixed(1)),
  });

  it('swap past its level (the Mac of 11-nov): filled to the level tasks come in freely down to, never past the limits', async () => {
    const run = await simulate({ minutes: 180, queued: 80, taskMinutes: 20 });
    // One at a time, and four in within 5 min of a cold start (2 of them the swap warm-up).
    expect(run.mostAtOnce).toBe(1);
    expect(run.letInBy(5)).toBeGreaterThanOrEqual(4);
    // Past the ramp, with work waiting, at its target or a little over (the 15 min turn goes
    // on under 40 % free): 5 tasks at once.
    expect(run.meanPercentOfTarget).toBeGreaterThan(95);
    expect(run.meanRunning).toBeGreaterThanOrEqual(4.8);
    // Far from the 20 % floor and from the load target.
    expect(run.minFreePercent).toBeGreaterThan(30);
    expect(run.maxLoad).toBeLessThan(12);
    expect(figures(run)).toEqual({
      letInBy5: 4,
      started: 45,
      meanRunning: 5,
      meanPercentOfTarget: 107,
      minFreePercent: 31.3,
      maxLoad: 6.6,
    });
  });

  it('the rule before on the same Mac (swap past its level always paces): a quarter of the work', async () => {
    const before = await simulate({
      minutes: 180,
      queued: 80,
      taskMinutes: 20,
      settings: { roomyFreeMemoryPercent: 0 },
    });
    expect(before.letInBy(5)).toBe(0);
    expect(before.started).toBeLessThanOrEqual(12);
    expect(before.meanRunning).toBeLessThan(1.5);
  });

  it('roomyFreeMemoryPercent is the knob: at 30 one more task runs at once, still over the floor', async () => {
    const run = await simulate({
      minutes: 180,
      queued: 80,
      taskMinutes: 20,
      settings: { roomyFreeMemoryPercent: 30 },
    });
    expect(run.meanRunning).toBeGreaterThanOrEqual(5.8);
    expect(run.started).toBeGreaterThanOrEqual(53);
    expect(run.minFreePercent).toBeGreaterThan(20);
  });

  it('little swap: filled down to the memory floor, within 2 points of it', async () => {
    const run = await simulate({ minutes: 180, queued: 80, taskMinutes: 20, swapGb: 1 });
    expect(run.mostAtOnce).toBe(1);
    expect(run.letInBy(5)).toBeGreaterThanOrEqual(6);
    expect(run.meanPercentOfTarget).toBeGreaterThan(90);
    expect(run.meanRunning).toBeGreaterThanOrEqual(6.4);
    // A task heavier than the typical one, let in last, may dip under the 20 % floor: by little.
    expect(run.minFreePercent).toBeGreaterThan(18);
    expect(run.maxLoad).toBeLessThan(12);
  });

  it('tasks that weigh on the CPU, not on memory: held near the load target, far from the net', async () => {
    const run = await simulate({
      minutes: 180,
      queued: 200,
      taskMinutes: 20,
      swapGb: 1,
      taskGb: [0.3],
      taskLoad: 1.5,
    });
    // 2 + 1.5 per task: the target of 12 is 6-7 tasks. No fixed count decides it.
    expect(run.meanRunning).toBeGreaterThan(6);
    expect(run.meanRunning).toBeLessThan(8);
    expect(run.meanPercentOfTarget).toBeGreaterThan(95);
    expect(run.meanPercentOfTarget).toBeLessThan(115);
    // Past the target on the way (a task's load shows a minute late), never near 2 × cores.
    expect(run.maxLoad).toBeLessThan(16);
  });

  it('a storm like the night of 10-nov (load 200-590 from elsewhere): nothing is let in while it lasts', async () => {
    // Quiet for 30 min, then 40 min of load from elsewhere climbing to 590, then quiet again.
    const outside = (minute: number) =>
      minute < 30 || minute >= 70 ? 0 : 200 + ((minute - 30) / 40) * 390;
    const run = await simulate({ minutes: 150, queued: 80, taskMinutes: 20, swapGb: 1, outside });
    const storm = run.trace.filter((point) => point.load > 48);
    expect(storm.length).toBeGreaterThan(200);
    expect(storm.reduce((sum, point) => sum + point.letIn, 0)).toBe(0);
    // Nothing is killed: what ran before it ends by itself, and the Mac is empty of tasks when
    // it passes. Then the regulator fills it again, on the ramp.
    const calm = run.trace.find((point) => point.minute > 70 && point.load <= 12);
    expect(calm).toBeDefined();
    const after = run.trace.filter(
      (point) => calm && point.minute >= calm.minute && point.minute < calm.minute + 10
    );
    expect(after.reduce((sum, point) => sum + point.letIn, 0)).toBeGreaterThanOrEqual(4);
    expect(run.minFreePercent).toBeGreaterThan(18);
  });
});

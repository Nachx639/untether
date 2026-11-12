/**
 * How much room the Mac has: memory, swap and CPU, sampled cheaply and kept for a few minutes
 * (2026-11-01). The 24 GB Mac ran tasks of several projects at once into 7-9 GB of swap and a
 * load of 45-50; each project's maxActiveTasks could not see the others. One global sampler
 * now decides whether a new task (of any project) may start, and the checks' load gate asks it
 * too.
 *
 * A sample is one `sysctl` (swap, the kernel's free-memory level and pressure level) and one
 * `vm_stat` (pages), both a few milliseconds, plus os.loadavg(). No `top`, no `ps`, no
 * `memory_pressure` (it walks every process). Off macOS only os.loadavg/freemem are used.
 *
 * `admission` judges a sample against config.json's `taskAdmission`.
 * 2026-11-08: the amount of swap in use stopped holding tasks. macOS does not give swap back
 * even with RAM to spare, so past any fixed level tasks waited on a healthy Mac (7 tasks at
 * 40 % memory free, pressure warn, «swap 7.0 GB in use (max 6.0)»). Tasks are held only by a
 * real signal: pressure critical, memory under its floor, swap growing over the last
 * swapGrowthWindowMin, or swap nearly full. Pressure warn or swap over its level with none of
 * those let one task in every steadySwapMaxWaitMin. The 2026-10-03 hang (swap 18 of 19 GB,
 * load 39) stays held.
 * 2026-11-11: the samples are kept on disk with the clocks (stateFile) and read back on start
 * while still inside the window, so a server restart (one per merge with the dev server) does
 * not send the swap trend back to «not known yet»; and a task that has waited
 * trendUnknownMaxWaitMin on an unknown trend takes the steady-swap turn without the window.
 * 2026-11-11 (later): admission is a regulator with a target, not only a brake. A nearly idle
 * Mac (load 5.9 on 12 cores, 68 % memory free, swap 6.25 of 7.17 GB and still: old pages of
 * stopped processes macOS never takes back) let one task in every 15 min. Now:
 * - Swap over its level paces tasks only without calm: memory free under
 *   roomyFreeMemoryPercent, pressure warn, the trend not known yet, or pages moving to or from
 *   swap (vm_stat's Swapins/Swapouts rate). With calm, tasks come in freely.
 * - The load has a target (targetLoadPerCore × cores). Past it tasks come in one at a time,
 *   slower the nearer the load is to maxLoadPerCore (the old turn's full wait from there on),
 *   and not at all past maxGrantLoadPerCore.
 * - Ramp: settleSec between any two starts, and each task let in within rampWindowSec keeps
 *   room for what a typical task takes as it starts (learned from the samples after each
 *   start), so five do not come in on a sample that has not seen the first.
 * - `room()` says how full the Mac is against the target and how many more fit, or why none.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { createLogger } from '../utils/logger.js';
import { every } from '../utils/periodic-loop.js';

const logger = createLogger('resource-monitor');

export interface ResourceSample {
  /** When it was taken (ms since epoch). */
  at: number;
  /** 1-minute load average and the cores it is measured against. */
  load: number;
  cores: number;
  memTotalBytes: number;
  /** Free + inactive + speculative + purgeable pages (what can be had without swapping). */
  memAvailableBytes: number;
  /** The kernel's own free-memory percentage (kern.memorystatus_level; macOS only). */
  memFreePercent: number;
  /** kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical (macOS only). */
  pressure: 'normal' | 'warn' | 'critical';
  swapUsedBytes: number;
  swapTotalBytes: number;
  /** vm_stat's Swapins and Swapouts: pages moved from and to swap since boot (macOS only). */
  swapins?: number;
  swapouts?: number;
}

/** What a sample is short of, for a task to start. */
export type ResourceShortage = 'memory' | 'swap' | 'cpu';

/** config.json `taskAdmission`: when the Mac has room for one more task. */
export interface TaskAdmissionSettings {
  /** Off: tasks start as before (only their project's maxActiveTasks). */
  enabled: boolean;
  /** Free memory (the kernel's level) below this percentage: no new task. */
  minFreeMemoryPercent: number;
  /**
   * Swap in use over this percentage of the RAM, with nothing else wrong: tasks come in one at
   * a time (steadySwapMaxWaitMin) instead of freely. Never a reason to hold them on its own.
   */
  maxSwapPercentOfRam: number;
  /** Swap grown by more than this (MB) over the last swapGrowthWindowMin: no new task. */
  maxSwapGrowthMb: number;
  swapGrowthWindowMin: number;
  /**
   * Swap in use over this percentage of its total: no new task, once the total is at least
   * minSwapTotalPercentOfRam of the RAM. macOS adds swap files as they fill, so a small total
   * is nearly always ~90 % used with plenty still to come (7 of 8 GB is not «nearly full»).
   */
  maxSwapPercentOfTotal: number;
  minSwapTotalPercentOfRam: number;
  /**
   * With pressure warn or swap over its level, minutes of samples needed before swap counts as
   * steady. The ring starts empty only on a cold start (the samples are read back from disk
   * after a restart), and it stays short: long enough to see a trend.
   */
  swapWarmupMin: number;
  /**
   * A task that has waited this many minutes for room while the swap trend is still not known
   * (too few samples, nothing really wrong in them) takes the steady-swap turn as if swap were
   * steady, without waiting for the samples; 0 = never (2026-11-11).
   */
  trendUnknownMaxWaitMin: number;
  /** 1-minute load over this × cores: no new task; 0 = CPU not looked at. */
  maxLoadPerCore: number;
  /**
   * When CPU is the only thing short for this many minutes running (memory and swap have
   * room), one task is let in anyway; 0 = never. Agents mostly wait on their model and the
   * checks, which do load the CPU, have their own gate (2026-11-02: with bakery's checks
   * the load stayed at 30-40 on 12 cores and a task waited over an hour with 42 % memory free).
   */
  cpuOnlyMaxWaitMin: number;
  /**
   * Pressure warn and/or swap over its level, with nothing really wrong: one task is let in
   * after this many minutes, and the next one waits as long again; 0 = never.
   */
  steadySwapMaxWaitMin: number;
  /**
   * After a task is let in, the next one waits this long, so the sample shows what the last
   * one takes before another is judged by it.
   */
  settleSec: number;
  /**
   * Memory free at or over this percentage, pressure normal, swap still and no pages moving to
   * or from swap: swap over its level does not pace tasks (it is old, not pressure); 0 = it
   * always paces them. While swap is over its level this is in effect the memory floor the
   * regulator fills the Mac down to (memoryFloorOf): lower it to fit more tasks.
   */
  roomyFreeMemoryPercent: number;
  /**
   * Pages swapped in plus out per second, over the last pagingWindowSec, that count as the Mac
   * paging: tasks come in one at a time (steadySwapMaxWaitMin); 0 = not looked at.
   */
  maxSwapPagesPerSec: number;
  pagingWindowSec: number;
  /**
   * The load the regulator aims at, × cores: under it tasks come in on the ramp; over it one
   * at a time, slower up to maxLoadPerCore; 0 = only maxLoadPerCore counts (and with that one
   * at 0 the CPU is not looked at, whatever this says).
   */
  targetLoadPerCore: number;
  /** Load over this × cores: not even the CPU-only turn lets a task in; 0 = no such ceiling. */
  maxGrantLoadPerCore: number;
  /**
   * A task let in keeps room for a typical task's start (memory and load) this long, until the
   * samples show what it really takes.
   */
  rampWindowSec: number;
}

export const DEFAULT_TASK_ADMISSION: TaskAdmissionSettings = {
  enabled: true,
  minFreeMemoryPercent: 20,
  maxSwapPercentOfRam: 25,
  maxSwapGrowthMb: 512,
  swapGrowthWindowMin: 10,
  maxSwapPercentOfTotal: 90,
  minSwapTotalPercentOfRam: 50,
  swapWarmupMin: 2,
  trendUnknownMaxWaitMin: 30,
  maxLoadPerCore: 2,
  cpuOnlyMaxWaitMin: 20,
  steadySwapMaxWaitMin: 15,
  settleSec: 20,
  roomyFreeMemoryPercent: 40,
  maxSwapPagesPerSec: 64,
  pagingWindowSec: 120,
  targetLoadPerCore: 1,
  maxGrantLoadPerCore: 4,
  rampWindowSec: 90,
};

/**
 * What a typical task takes as it starts: the memory it brings the free level down by and the
 * load it adds within rampWindowSec. Learned from the samples after each start (a moving
 * average, kept across restarts); these are the values before any was seen.
 */
export interface TypicalTask {
  memBytes: number;
  load: number;
  /** How many starts it was learned from. */
  learned: number;
}

export const DEFAULT_TYPICAL_TASK: TypicalTask = {
  memBytes: 1.5 * 1024 ** 3,
  load: 1,
  learned: 0,
};

/** What a learned start may weigh: one outlier (a check running beside it) must not rule. */
const TYPICAL_MIN_MEM_BYTES = 0.5 * 1024 ** 3;
const TYPICAL_MAX_MEM_OF_RAM = 0.125;
const TYPICAL_MIN_LOAD = 0.25;
const TYPICAL_MAX_LOAD = 3;
/**
 * A start that took more than expected counts for more than one that took less: room is kept
 * for a task on the heavy side, so the floor is not passed by the ones heavier than the mean.
 */
const TYPICAL_WEIGHT_UP = 0.5;
const TYPICAL_WEIGHT_DOWN = 0.15;

/** How full the Mac is against the regulator's target, and how many more tasks fit. */
export interface MacRoom {
  /** The fuller of CPU (load of its target) and memory (used of what the floor leaves), in %. */
  percentOfTarget: number;
  /** How many more tasks fit now (0: none is let in). */
  fits: number;
  /** One line for `ut task list` and the doctor. */
  line: string;
}

/** The load tasks are let in under freely (0: the load is not looked at) and what it is. */
export function loadLimitOf(
  settings: TaskAdmissionSettings,
  cores: number
): { limit: number; word: 'target' | 'max' } {
  const { targetLoadPerCore: target, maxLoadPerCore: max } = settings;
  // maxLoadPerCore 0 keeps meaning «the CPU is not looked at», target or no target.
  if (max <= 0) return { limit: 0, word: 'max' };
  if (target > 0 && target <= max) return { limit: target * cores, word: 'target' };
  return { limit: max * cores, word: 'max' };
}

/**
 * Pages swapped in plus out per second over the last `windowSec` of samples; undefined: not
 * known (fewer than two samples with the counters, or the counters started again).
 */
export function pagingRate(
  history: readonly ResourceSample[],
  windowSec: number
): { perSec: number; spanSec: number } | undefined {
  const latest = history[history.length - 1];
  if (latest?.swapins === undefined || latest.swapouts === undefined) return;
  const from = latest.at - windowSec * 1000;
  const first = history.find(
    (sample) => sample.at >= from && sample.swapins !== undefined && sample.swapouts !== undefined
  );
  if (!first || first.at >= latest.at) return;
  const pages =
    latest.swapins - (first.swapins as number) + latest.swapouts - (first.swapouts as number);
  if (pages < 0) return;
  const spanSec = (latest.at - first.at) / 1000;
  return { perSec: pages / spanSec, spanSec };
}

/**
 * The free-memory percentage tasks come in freely down to: minFreeMemoryPercent, or
 * roomyFreeMemoryPercent while swap is over its level (under it they are paced, one every
 * steadySwapMaxWaitMin, so that is where the regulator stops filling the Mac).
 */
export function memoryFloorOf(latest: ResourceSample, settings: TaskAdmissionSettings): number {
  const swapLevel = (settings.maxSwapPercentOfRam / 100) * latest.memTotalBytes;
  const overLevel = settings.maxSwapPercentOfRam > 0 && latest.swapUsedBytes > swapLevel;
  return overLevel
    ? Math.max(settings.minFreeMemoryPercent, settings.roomyFreeMemoryPercent)
    : settings.minFreeMemoryPercent;
}

/**
 * How many more typical tasks fit: by memory, what is free over the floor (memoryFloorOf); by
 * CPU, what is left to the load target (any margin under it fits one: the load is a soft
 * count). `pending`: tasks let in so recently that the sample does not show them yet.
 */
export function roomFor(
  latest: ResourceSample,
  settings: TaskAdmissionSettings,
  typical: TypicalTask = DEFAULT_TYPICAL_TASK,
  pending = 0
): { percentOfTarget: number; byMemory: number; byCpu: number; fits: number } {
  const { limit } = loadLimitOf(settings, latest.cores);
  const floor = memoryFloorOf(latest, settings);
  const overFloor = ((latest.memFreePercent - floor) / 100) * latest.memTotalBytes;
  const byMemory = floor > 0 ? Math.max(0, Math.floor(overFloor / typical.memBytes)) : 99;
  const byCpu = limit > 0 ? Math.max(0, Math.ceil((limit - latest.load) / typical.load)) : 99;
  const cpuShare = limit > 0 ? latest.load / limit : 0;
  const memShare = floor > 0 && floor < 100 ? (100 - latest.memFreePercent) / (100 - floor) : 0;
  return {
    percentOfTarget: Math.round(Math.max(cpuShare, memShare) * 100),
    byMemory,
    byCpu,
    fits: Math.max(0, Math.min(byMemory, byCpu, 99) - pending),
  };
}

/** config.json's `taskAdmission`, each field defaulted on its own. */
export function taskAdmissionFrom(value?: Partial<TaskAdmissionSettings>): TaskAdmissionSettings {
  const out = { ...DEFAULT_TASK_ADMISSION };
  for (const key of Object.keys(out) as (keyof TaskAdmissionSettings)[]) {
    const given = value?.[key];
    if (given !== undefined) (out as Record<string, unknown>)[key] = given;
  }
  return out;
}

export interface AdmissionVerdict {
  ok: boolean;
  /** What is short (empty when ok, or when only settling). */
  short: ResourceShortage[];
  /** The last task let in is still settling (settleSec). */
  settling?: boolean;
  /**
   * Room, but past half of it on some count: the last task let in settles first. On an idle
   * Mac tasks start one right after another.
   */
  tight?: boolean;
  /**
   * What holds it is only pressure warn and/or swap over its level (maybe with the CPU) and
   * swap is steady: the monitor lets one in every steadySwapMaxWaitMin.
   */
  steadySwap?: boolean;
  /**
   * The same, but too few samples yet to say swap is steady (just after a server start): held
   * until they are in, its place in the drip kept.
   */
  warmingUp?: boolean;
  /**
   * Held only by swap growth, and by less than SWAP_GROWTH_EXIT_FACTOR × the limit, in the
   * drip lane (2026-11-10): nothing gets in while it reads as growing, but it is a wobble
   * around the threshold until proven otherwise, so the turn already counting is kept.
   */
  swapWobble?: boolean;
  /** One line with the numbers: "memory 12 % free (min 20 %), swap growing +1.0 GB in 10 min". */
  detail: string;
}

/**
 * A grant clock's turn is cancelled only once its condition has failed this long without a
 * break (2026-11-08): a single sample out of range — memory dipping under
 * 2 × the minimum for one reading, pressure flickering to warn — must not send the «next in N
 * min» countdown back to the full wait so it never arrives.
 */
export const CLOCK_RESET_GRACE_MS = 3 * 60_000;
/**
 * The steady-swap turn is entered with swap growth within the limit and left only past this
 * many times it (2026-11-10). Growth is counted from the lowest point of the window, so one
 * wobble of swap just over the limit (6.7 → 7.3 GB with a 512 MB limit) reads as «growing» for
 * the whole window, far longer than CLOCK_RESET_GRACE_MS: with one threshold for both, the
 * turn was cancelled on every wobble and never came (11+ tasks queued, memory over 50 % free).
 * No task gets in while swap reads as growing; only the turn's clock goes on.
 */
export const SWAP_GROWTH_EXIT_FACTOR = 2;
/**
 * A cancelled turn keeps the time it had waited, for when its condition holds again; out of
 * condition this long, that time is forgotten (the Mac really was short, not flapping).
 */
export const CLOCK_BANK_KEEP_MS = 30 * 60_000;
/**
 * A turn cancelled this many times running without a task getting in lets one in anyway the
 * next time its condition holds, the rule's wait since the last start (or since the first
 * turn) gone by: the rule is there to dose tasks, not to block them. It is logged and kept.
 */
export const GRANT_FORCE_AFTER = 3;
/**
 * The doctor warns once a turn has been cancelled this many times without ever letting a task
 * in: past GRANT_FORCE_AFTER, so it means the forced grant did not get one in either.
 */
export const GRANT_STALL_WARN = 2 * GRANT_FORCE_AFTER;

/** A task let in by GRANT_FORCE_AFTER rather than by its clock. */
export interface ForcedGrant {
  at: number;
  clock: 'steady-swap' | 'cpu-only';
  /** How many times the turn had been cancelled. */
  cancelled: number;
}

/** The samples go to disk this often (the clocks at once): a restart loses this much trend. */
export const SAMPLES_KEEP_EVERY_MS = 30_000;

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** A sample read back from disk, or undefined when it is not one. */
function sampleFrom(value: unknown): ResourceSample | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  const numbers = [
    'at',
    'load',
    'cores',
    'memTotalBytes',
    'memAvailableBytes',
    'memFreePercent',
    'swapUsedBytes',
    'swapTotalBytes',
  ] as const;
  for (const key of numbers) {
    const field = item[key];
    if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) return;
  }
  if (item.pressure !== 'normal' && item.pressure !== 'warn' && item.pressure !== 'critical') {
    return;
  }
  const out = { pressure: item.pressure } as ResourceSample;
  for (const key of numbers) out[key] = item[key] as number;
  for (const key of ['swapins', 'swapouts'] as const) {
    const field = item[key];
    if (typeof field === 'number' && Number.isFinite(field) && field >= 0) out[key] = field;
  }
  return out;
}

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

/**
 * Whether one more task fits now, from the latest sample and the ones before it (oldest
 * first). No sample at all: yes (a broken sampler must not hold every task; the doctor tells).
 *
 * Few samples (just after a server start) growth is only known over what there is:
 * - Swap under its level and pressure normal: judged as usual, nothing suggests trouble.
 * - Growth already over the limit in those samples: held, as with a full window.
 * - Pressure warn or swap over its level: not steady until swapWarmupMin of samples are in and
 *   swap grew no faster than the limit's pace so far; until then held, not dripped.
 */
export function judgeAdmission(
  history: readonly ResourceSample[],
  settings: TaskAdmissionSettings,
  typical?: TypicalTask
): AdmissionVerdict {
  const latest = history[history.length - 1];
  if (!settings.enabled || !latest) return { ok: true, short: [], detail: '' };
  const ramBytes = latest.memTotalBytes;
  const swapLevel = (settings.maxSwapPercentOfRam / 100) * ramBytes;
  const swapOverLevel = settings.maxSwapPercentOfRam > 0 && latest.swapUsedBytes > swapLevel;
  const warn = latest.pressure === 'warn';

  // The swap trend: growth over the window, and whether there are samples enough to call it.
  const windowMs = settings.swapGrowthWindowMin * 60_000;
  const inWindow = history.filter((sample) => sample.at >= latest.at - windowMs);
  const lowest = Math.min(...inWindow.map((sample) => sample.swapUsedBytes));
  const growth = latest.swapUsedBytes - lowest;
  const growthLimit = settings.maxSwapGrowthMb * MB;
  const growing = settings.maxSwapGrowthMb > 0 && growth > growthLimit;
  // Steady needs enough samples, and growth so far within the limit's pace for that span.
  const sampledMs = latest.at - history[0].at;
  const paceLimit = growthLimit * Math.min(1, sampledMs / windowMs);
  const trendKnown =
    sampledMs >= settings.swapWarmupMin * 60_000 &&
    (settings.maxSwapGrowthMb <= 0 || growth <= paceLimit);

  // Calm (2026-11-11): memory to spare, pressure normal, swap still and no pages moving to or
  // from it. Then swap over its level is old pages macOS never takes back, and paces no one.
  const paging =
    settings.maxSwapPagesPerSec > 0 ? pagingRate(history, settings.pagingWindowSec) : undefined;
  const pagingActive = paging !== undefined && paging.perSec > settings.maxSwapPagesPerSec;
  // A Mac whose vm_stat gives no counters is judged by the swap trend alone: «not known» is for
  // the first sample with them, not a reason to pace tasks for good.
  const pagingKnown =
    settings.maxSwapPagesPerSec <= 0 || paging !== undefined || latest.swapins === undefined;
  const roomy =
    settings.roomyFreeMemoryPercent > 0 && latest.memFreePercent >= settings.roomyFreeMemoryPercent;
  const calm = latest.pressure === 'normal' && roomy && trendKnown && pagingKnown && !pagingActive;
  const swapPaces = swapOverLevel && !calm;
  const drip = warn || swapPaces || pagingActive;

  const memoryParts: string[] = [];
  if (latest.pressure === 'critical') memoryParts.push('pressure critical');
  if (latest.memFreePercent < settings.minFreeMemoryPercent) {
    memoryParts.push(
      `memory ${Math.round(latest.memFreePercent)} % free (min ${settings.minFreeMemoryPercent} %)`
    );
  } else if (typical && settings.minFreeMemoryPercent > 0) {
    // Over the floor, but not by what one more task takes as it starts: it would end under it.
    const overFloor = ((latest.memFreePercent - settings.minFreeMemoryPercent) / 100) * ramBytes;
    if (overFloor < typical.memBytes) {
      memoryParts.push(
        `memory ${Math.round(latest.memFreePercent)} % free: one more task (about ${gb(typical.memBytes)} as it starts) would go under the ${settings.minFreeMemoryPercent} % floor`
      );
    }
  }
  const availableFloor = (settings.minFreeMemoryPercent / 100) * ramBytes;
  if (drip && latest.memAvailableBytes < availableFloor) {
    memoryParts.push(
      `only ${gb(latest.memAvailableBytes)} of memory available (min ${gb(availableFloor)})`
    );
  }

  const swapParts: string[] = [];
  if (growing) {
    const span = Math.max(1, Math.round((latest.at - inWindow[0].at) / 60_000));
    swapParts.push(
      `swap growing +${gb(growth)} in ${span} min (limit +${settings.maxSwapGrowthMb} MB)`
    );
  }
  const swapPercent =
    latest.swapTotalBytes > 0 ? (latest.swapUsedBytes / latest.swapTotalBytes) * 100 : 0;
  if (
    settings.maxSwapPercentOfTotal > 0 &&
    latest.swapTotalBytes >= (settings.minSwapTotalPercentOfRam / 100) * ramBytes &&
    swapPercent >= settings.maxSwapPercentOfTotal
  ) {
    swapParts.push(
      `swap nearly full: ${gb(latest.swapUsedBytes)} of ${gb(latest.swapTotalBytes)} (${Math.round(swapPercent)} %, limit ${settings.maxSwapPercentOfTotal} %)`
    );
  }

  // Held for real, or only paced: warn, paging and a high swap count just when nothing else is wrong.
  const held = memoryParts.length > 0 || swapParts.length > 0;
  const paced = drip && !held;
  const short: ResourceShortage[] = [];
  if (memoryParts.length > 0 || (paced && warn)) short.push('memory');
  if (swapParts.length > 0 || (paced && (swapPaces || pagingActive))) short.push('swap');
  const parts = [...memoryParts, ...swapParts];

  const steady = paced && trendKnown;
  if (paced) {
    // Why tasks come in one at a time: the signal itself, then what swap is doing.
    if (warn) parts.push('pressure warn');
    if (pagingActive && paging) {
      parts.push(
        `swapping ${Math.round(paging.perSec)} pages/s over the last ${Math.round(paging.spanSec)} s (max ${settings.maxSwapPagesPerSec})`
      );
    }
    if (swapPaces && !warn && !pagingActive && trendKnown) {
      parts.push(
        !roomy
          ? `memory ${Math.round(latest.memFreePercent)} % free with swap past its level (tasks come in freely from ${settings.roomyFreeMemoryPercent} % free)`
          : 'paging rate not known yet'
      );
    }
    parts.push(
      steady
        ? `swap steady at ${gb(latest.swapUsedBytes)} (no growth over ${settings.swapGrowthWindowMin} min)`
        : `swap trend not known yet (${Math.floor(sampledMs / 60_000)} of ${settings.swapGrowthWindowMin} min sampled)`
    );
  }

  const { limit: loadLimit, word: loadWord } = loadLimitOf(settings, latest.cores);
  if (loadLimit > 0 && latest.load > loadLimit) {
    short.push('cpu');
    parts.push(`load ${latest.load.toFixed(1)} (${loadWord} ${loadLimit.toFixed(0)})`);
  }
  // Growth alone, short of the exit threshold: held now, the turn kept (see the constant).
  const swapWobble =
    drip &&
    growing &&
    memoryParts.length === 0 &&
    swapParts.length === 1 &&
    growth <= growthLimit * SWAP_GROWTH_EXIT_FACTOR;
  const tight =
    latest.pressure !== 'normal' ||
    latest.memFreePercent < settings.minFreeMemoryPercent * 2 ||
    (settings.maxSwapPercentOfRam > 0 && latest.swapUsedBytes > swapLevel / 2) ||
    (loadLimit > 0 && latest.load > loadLimit / 2);
  return {
    ok: short.length === 0,
    short,
    tight,
    ...(steady ? { steadySwap: true } : {}),
    ...(paced && !steady ? { warmingUp: true } : {}),
    ...(swapWobble ? { swapWobble: true } : {}),
    detail: parts.join(', '),
  };
}

// ---------------------------------------------------------------------------------------------
// Parsing (pure; tests feed it real output)
// ---------------------------------------------------------------------------------------------

const UNIT: Record<string, number> = { K: 1024, M: MB, G: GB };

/** `total = 5120.00M  used = 4428.44M  free = 691.56M  (encrypted)` → bytes. */
export function parseSwapUsage(text: string): { used: number; total: number } | null {
  const read = (name: string) => {
    const match = new RegExp(`${name}\\s*=\\s*([\\d.]+)([KMG])`).exec(text);
    return match ? Number(match[1]) * UNIT[match[2]] : undefined;
  };
  const used = read('used');
  const total = read('total');
  return used === undefined || total === undefined ? null : { used, total };
}

/** vm_stat's free + inactive + speculative + purgeable pages, in bytes. */
export function parseVmStatAvailable(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 0);
  if (!pageSize) return null;
  let pages = 0;
  let found = false;
  for (const name of ['free', 'inactive', 'speculative', 'purgeable']) {
    const match = new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(text);
    if (match) {
      pages += Number(match[1]);
      found = true;
    }
  }
  return found ? pages * pageSize : null;
}

/** vm_stat's `Swapins:` and `Swapouts:` (pages since boot); null when it prints neither. */
export function parseVmStatSwap(text: string): { swapins: number; swapouts: number } | null {
  const swapins = /^Swapins:\s+(\d+)/m.exec(text)?.[1];
  const swapouts = /^Swapouts:\s+(\d+)/m.exec(text)?.[1];
  if (swapins === undefined || swapouts === undefined) return null;
  return { swapins: Number(swapins), swapouts: Number(swapouts) };
}

const PRESSURE: Record<string, ResourceSample['pressure']> = {
  '1': 'normal',
  '2': 'warn',
  '4': 'critical',
};

/** The three lines of `sysctl -n vm.swapusage kern.memorystatus_level kern.memorystatus_vm_pressure_level`. */
export function parseSysctl(text: string): {
  swap: { used: number; total: number } | null;
  freePercent: number | null;
  pressure: ResourceSample['pressure'];
} {
  const lines = text.trim().split('\n');
  const freePercent = Number(lines[1]);
  return {
    swap: parseSwapUsage(lines[0] ?? ''),
    freePercent: Number.isFinite(freePercent) && lines[1]?.trim() ? freePercent : null,
    pressure: PRESSURE[lines[2]?.trim() ?? ''] ?? 'normal',
  };
}

// ---------------------------------------------------------------------------------------------
// The sampler
// ---------------------------------------------------------------------------------------------

export interface ResourceMonitorOptions {
  /** One sample (tests feed simulated ones). */
  sample?: () => Promise<ResourceSample>;
  settings?: () => TaskAdmissionSettings;
  /** How often it samples while started (default 10 s). */
  intervalMs?: number;
  /** How long samples are kept (default: a minute past swapGrowthWindowMin or swapWarmupMin). */
  historyMs?: number;
  now?: () => number;
  /**
   * Where the admission clocks (last start, since when only the CPU is short) and the samples
   * of the window are kept across server restarts. 2026-11-02: the dev server restarts on every merge (tsx watch), every few
   * minutes on a busy day, and each restart set the 20 min CPU-only clock back to zero, so it
   * never ran out and tasks waited over two hours on a CPU-busy Mac.
   */
  stateFile?: string;
}

export interface ResourceMonitor {
  start(): void;
  stop(): void;
  /** Take a sample now (also what the timer does). */
  refresh(): Promise<ResourceSample | null>;
  /** Kept samples, oldest first. */
  history(): readonly ResourceSample[];
  latest(): ResourceSample | undefined;
  /** The last sampling error, cleared by a good sample (the doctor shows it). */
  lastError(): string | undefined;
  /** When a task was last let in (0: none since the server started). */
  lastStartedAt(): number;
  /**
   * Whether one more task may start now. `started` is called by whoever lets it in, so the
   * next one waits settleSec for the sample to show it. `waitedMs`: how long the task that
   * would start has waited for room already (trendUnknownMaxWaitMin).
   */
  admission(waiting?: { waitedMs?: number }): AdmissionVerdict;
  started(): void;
  settings(): TaskAdmissionSettings;
  /**
   * How full the Mac is against the regulator's target and how many more tasks fit now, or
   * why none is let in; no clock is touched (`ut task list`, the doctor, the checks' slots).
   */
  room(): MacRoom | undefined;
  /** What a typical task takes as it starts, as learned so far. */
  typicalTask(): TypicalTask;
  /**
   * Whether the steady-swap rule is letting tasks in now (judged steady, rule on, CPU rule
   * allowing), with the minutes between grants; no clock is touched (the doctor asks it,
   * 2026-11-07).
   */
  steadySwapGrant(): { waitMin: number } | undefined;
  /**
   * How many times each grant clock (steady-swap, CPU-only) has been cancelled without letting
   * a task in since the admission system was last healthy — cleared when any task starts or
   * when there is room again (judged.ok), so an idle flap does not linger (2026-11-08). At
   * GRANT_FORCE_AFTER one task is let in anyway; a counter climbing to GRANT_STALL_WARN with
   * tasks waiting for room means not even that got one in — the doctor warns on it.
   */
  grantStalls(): { steady: number; cpu: number };
  /** Tasks let in by GRANT_FORCE_AFTER (kept across restarts), and the last one. */
  forcedGrants(): { count: number; last?: ForcedGrant };
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000, encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    );
  });
}

/** One real sample: sysctl + vm_stat on macOS, os.* elsewhere. */
export async function sampleNow(now: number = Date.now()): Promise<ResourceSample> {
  const base = {
    at: now,
    load: os.loadavg()[0],
    cores: os.availableParallelism(),
    memTotalBytes: os.totalmem(),
  };
  if (process.platform !== 'darwin') {
    const free = os.freemem();
    return {
      ...base,
      memAvailableBytes: free,
      memFreePercent: (free / base.memTotalBytes) * 100,
      pressure: 'normal',
      swapUsedBytes: 0,
      swapTotalBytes: 0,
    };
  }
  const [sysctl, vmStat] = await Promise.all([
    run('/usr/sbin/sysctl', [
      '-n',
      'vm.swapusage',
      'kern.memorystatus_level',
      'kern.memorystatus_vm_pressure_level',
    ]),
    run('/usr/bin/vm_stat', []),
  ]);
  const parsed = parseSysctl(sysctl);
  const available = parseVmStatAvailable(vmStat) ?? os.freemem();
  return {
    ...base,
    memAvailableBytes: available,
    memFreePercent: parsed.freePercent ?? (available / base.memTotalBytes) * 100,
    pressure: parsed.pressure,
    swapUsedBytes: parsed.swap?.used ?? 0,
    swapTotalBytes: parsed.swap?.total ?? 0,
    ...(parseVmStatSwap(vmStat) ?? {}),
  };
}

export function createResourceMonitor(options: ResourceMonitorOptions = {}): ResourceMonitor {
  const now = options.now ?? Date.now;
  const take = options.sample ?? (() => sampleNow(now()));
  const settings = () => options.settings?.() ?? DEFAULT_TASK_ADMISSION;
  const intervalMs = options.intervalMs ?? 10_000;
  // The ring must cover both spans it answers for: a shorter one would never finish the warm-up.
  const historyMs = () => {
    const { swapGrowthWindowMin, swapWarmupMin } = settings();
    return options.historyMs ?? (Math.max(swapGrowthWindowMin, swapWarmupMin) + 1) * 60_000;
  };
  const samples: ResourceSample[] = [];
  let error: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<ResourceSample | null> | undefined;
  let lastStart = 0;
  /** What a typical task takes as it starts (learned; kept in the state file). */
  let typical: TypicalTask = { ...DEFAULT_TYPICAL_TASK };
  /**
   * The tasks let in lately, each with the Mac as it was then: room is kept for them while the
   * samples do not show them (rampWindowSec), and what they took teaches `typical`.
   */
  const starts: { at: number; freeBytes?: number; load?: number }[] = [];
  const freeBytesOf = (sample: ResourceSample) =>
    (sample.memFreePercent / 100) * sample.memTotalBytes;
  const pendingStarts = (current: TaskAdmissionSettings) =>
    starts.filter((start) => now() - start.at < current.rampWindowSec * 1000).length;
  /** Starts whose ramp window is over teach what a task takes; overlapping ones share it. */
  const learnStarts = (current: TaskAdmissionSettings) => {
    const rampMs = current.rampWindowSec * 1000;
    const latest = samples[samples.length - 1];
    if (!latest) return;
    const done = starts.filter((start) => latest.at >= start.at + rampMs);
    for (const start of done) {
      const seen = samples.filter(
        (sample) => sample.at >= start.at && sample.at <= start.at + rampMs
      );
      if (start.freeBytes !== undefined && start.load !== undefined && seen.length > 0) {
        // Others let in around it share what the window saw, each by how much of its own ramp
        // fell inside this one's window (one let in at its very end hardly shows in it).
        const together = starts.reduce(
          (sum, other) => sum + Math.max(0, 1 - Math.abs(other.at - start.at) / rampMs),
          0
        );
        const took = (start.freeBytes - Math.min(...seen.map(freeBytesOf))) / Math.max(1, together);
        const added =
          (Math.max(...seen.map((sample) => sample.load)) - start.load) / Math.max(1, together);
        const toward = (from: number, to: number) =>
          from + (to > from ? TYPICAL_WEIGHT_UP : TYPICAL_WEIGHT_DOWN) * (to - from);
        const clamp = (value: number, low: number, high: number) =>
          Math.min(high, Math.max(low, value));
        const mem = clamp(
          took,
          TYPICAL_MIN_MEM_BYTES,
          Math.max(TYPICAL_MIN_MEM_BYTES, TYPICAL_MAX_MEM_OF_RAM * latest.memTotalBytes)
        );
        const load = clamp(added, TYPICAL_MIN_LOAD, TYPICAL_MAX_LOAD);
        typical = {
          memBytes: toward(typical.memBytes, mem),
          load: toward(typical.load, load),
          learned: typical.learned + 1,
        };
      }
    }
    // Kept one more window: a later start that overlapped still counts them as company.
    while (starts.length > 0 && latest.at >= starts[0].at + 2 * rampMs) starts.shift();
    for (const start of done) {
      start.freeBytes = undefined;
      start.load = undefined;
    }
  };
  /**
   * A grant clock: the wait toward «one task let in» of a rule (2026-11-08, 2026-11-10).
   * - since: when the wait began; undefined while cancelled.
   * - failing: since when its condition has been failing with tasks still blocked.
   * - waited: what a cancelled turn had waited, given back when its condition holds again.
   * - stalls: cancellations without a task getting in since (the doctor reads them).
   * - streak: when the first turn began since a task last got in (the forced grant's pace).
   */
  interface GrantClock {
    since?: number;
    failing?: number;
    waited: number;
    stalls: number;
    streak?: number;
  }
  /** Only the CPU has kept tasks out (cpuOnlyMaxWaitMin). */
  const cpuClock: GrantClock = { waited: 0, stalls: 0 };
  /** Only a steady high swap (and maybe the CPU) has kept tasks out (steadySwapMaxWaitMin). */
  const steadyClock: GrantClock = { waited: 0, stalls: 0 };
  let forcedCount = 0;
  let lastForced: ForcedGrant | undefined;
  /** The forced grant admission() last answered with, if any; a start records it. */
  let forcedAnswer: Omit<ForcedGrant, 'at'> | undefined;
  /** A sample of this process is in: restored ones alone never answer for the Mac as it is now. */
  let fresh = false;
  /** When the samples were last written (they go to disk every SAMPLES_KEEP_EVERY_MS). */
  let samplesKeptAt = 0;
  const stateFile = options.stateFile;
  if (stateFile) {
    try {
      const kept = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
      // Only plausible times: a clock from the future or a broken file counts as none.
      const valid = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now()
          ? value
          : undefined;
      const count = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
      const restore = (clock: GrantClock, name: string) => {
        clock.since = valid(kept[`${name}Since`]);
        clock.waited = clock.since === undefined ? count(kept[`${name}Waited`]) : 0;
        clock.stalls = Math.floor(count(kept[`${name}Stalls`]));
        clock.streak = valid(kept[`${name}Streak`]);
      };
      lastStart = valid(kept.lastStart) ?? 0;
      restore(cpuClock, 'cpuOnly');
      restore(steadyClock, 'steadySwap');
      const forced = kept.forced as { count?: unknown; last?: Partial<ForcedGrant> } | undefined;
      forcedCount = Math.floor(count(forced?.count));
      const at = valid(forced?.last?.at);
      const clock = forced?.last?.clock;
      if (at !== undefined && (clock === 'steady-swap' || clock === 'cpu-only')) {
        lastForced = { at, clock, cancelled: Math.floor(count(forced?.last?.cancelled)) };
      }
      const learned = kept.typical as Partial<TypicalTask> | undefined;
      if (count(learned?.memBytes) > 0 && count(learned?.load) > 0) {
        typical = {
          memBytes: count(learned?.memBytes),
          load: count(learned?.load),
          learned: Math.floor(count(learned?.learned)),
        };
      }
      // The samples still inside the window, in order (2026-11-11): the trend goes on from them.
      const oldest = now() - historyMs();
      for (const item of Array.isArray(kept.samples) ? kept.samples : []) {
        const restored = sampleFrom(item);
        const last = samples[samples.length - 1];
        if (!restored || restored.at < oldest || restored.at > now()) continue;
        if (last && restored.at <= last.at) continue;
        samples.push(restored);
      }
    } catch {
      // None kept yet.
    }
  }
  // Zeroes are left out: at rest the file holds only the times.
  const kept = (clock: GrantClock, name: string) => ({
    [`${name}Since`]: clock.since,
    [`${name}Waited`]: clock.waited || undefined,
    [`${name}Stalls`]: clock.stalls || undefined,
    [`${name}Streak`]: clock.streak,
  });
  const clocks = () => ({
    lastStart,
    ...kept(cpuClock, 'cpuOnly'),
    ...kept(steadyClock, 'steadySwap'),
    forced: forcedCount > 0 ? { count: forcedCount, last: lastForced } : undefined,
    typical: typical.learned > 0 ? typical : undefined,
  });
  const state = () => JSON.stringify(clocks());
  let savedState = state();
  const keepState = () => {
    if (!stateFile) return;
    const next = state();
    const samplesDue = now() - samplesKeptAt >= SAMPLES_KEEP_EVERY_MS;
    if (next === savedState && !samplesDue) return;
    savedState = next;
    samplesKeptAt = now();
    try {
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...clocks(), samples }));
      fs.renameSync(tmp, stateFile);
    } catch {
      // Best effort: only the clocks are lost.
    }
  };

  /**
   * One grant clock moved on by the latest judgement.
   * - Its condition holds (`active`): the wait begins, or goes on from what a cancelled turn
   *   had already waited (2026-11-10: the time waited is never lost to a cancellation).
   * - Room now (`roomNow`, judged.ok): nothing is blocked, so the clock is not needed and is
   *   left as it was; the cancellations so far are stale (an idle flap must not be held against
   *   the rule when the next task queues, review 2026-11-08).
   * - Otherwise, still blocked by something else: cancelled only once that has held
   *   CLOCK_RESET_GRACE_MS (2026-11-08), so a single off-range sample — memory dipping for one
   *   reading, pressure flickering — changes nothing. A cancellation counts as a stall.
   */
  const advanceClock = (clock: GrantClock, active: boolean, roomNow: boolean) => {
    const t = now();
    if (active) {
      if (clock.since === undefined) clock.since = t - clock.waited;
      clock.waited = 0;
      clock.failing = undefined;
      clock.streak ??= t;
      return;
    }
    if (roomNow) {
      clock.failing = undefined;
      clock.waited = 0;
      clock.stalls = 0;
      clock.streak = undefined;
      return;
    }
    clock.failing ??= t;
    if (clock.since === undefined) {
      if (t - clock.failing >= CLOCK_BANK_KEEP_MS) clock.waited = 0;
      return;
    }
    if (t - clock.failing < CLOCK_RESET_GRACE_MS) return;
    clock.waited = Math.max(0, clock.failing - clock.since);
    clock.since = undefined;
    clock.stalls += 1;
  };

  /**
   * Whether a clock's turn is due: its wait gone by, or (`forced`) cancelled GRANT_FORCE_AFTER
   * times running with the wait gone by since the last start, or since its first turn. Asked
   * only while the rule's condition holds, so a forced grant never comes on a bad signal.
   */
  const due = (clock: GrantClock, waitMs: number) => {
    if (clock.since === undefined) return { ok: false, forced: false, leftMs: waitMs };
    const t = now();
    const leftMs = waitMs - (t - clock.since);
    if (leftMs <= 0) return { ok: true, forced: false, leftMs: 0 };
    const paceFrom = Math.max(lastStart, clock.streak ?? t);
    const forced = clock.stalls >= GRANT_FORCE_AFTER && t - paceFrom >= waitMs;
    return { ok: forced, forced, leftMs };
  };

  /** The load is past the ceiling no turn lets a task in over (maxGrantLoadPerCore). */
  const overCeiling = (current: TaskAdmissionSettings) => {
    const latest = samples[samples.length - 1];
    return (
      !!latest &&
      current.maxGrantLoadPerCore > 0 &&
      latest.load > current.maxGrantLoadPerCore * latest.cores
    );
  };

  /**
   * How long only the CPU must have been short before one task is let in: growing with the load
   * from the target to cpuOnlyMaxWaitMin at maxLoadPerCore and beyond (the nearer the edge, the
   * slower they come in), never under a ramp window. By the square root of the way there: a
   * task stays for many minutes, so a turn every minute or two just over the target would pile
   * them well past it (simulated: load 17 on a target of 12).
   */
  const cpuWaitMs = (current: TaskAdmissionSettings) => {
    const full = current.cpuOnlyMaxWaitMin * 60_000;
    const latest = samples[samples.length - 1];
    const { targetLoadPerCore: target, maxLoadPerCore: max } = current;
    if (!latest || !(target > 0 && max > target)) return full;
    const over = (latest.load / latest.cores - target) / (max - target);
    return Math.min(full, Math.max(current.rampWindowSec * 1000, Math.sqrt(over) * full));
  };

  /** The steady-swap rule as it applies to a judged verdict now; undefined: it does not. */
  const steadyRule = (judged: AdmissionVerdict, current: TaskAdmissionSettings) => {
    if (judged.ok || judged.steadySwap !== true || current.steadySwapMaxWaitMin <= 0) return;
    // With the CPU short too, its own rule must allow a grant and the longer wait counts.
    const withCpu = judged.short.includes('cpu');
    if (withCpu && (current.cpuOnlyMaxWaitMin <= 0 || overCeiling(current))) return;
    return {
      waitMin: Math.max(current.steadySwapMaxWaitMin, withCpu ? current.cpuOnlyMaxWaitMin : 0),
    };
  };

  const refresh = () => {
    inFlight ??= take()
      .then((sample) => {
        samples.push(sample);
        fresh = true;
        const current = settings();
        const keepMs = historyMs();
        while (samples.length > 1 && samples[0].at < sample.at - keepMs) samples.shift();
        // The admission clocks are kept here, judged on every sample (not only when a task asks),
        // so the reset hysteresis sees the real signal and a lone task arriving into a Mac that
        // has been steady a while is not made to wait the whole window afresh (2026-11-08).
        learnStarts(current);
        const judged = judgeAdmission(samples, current, typical);
        const cpuOnly =
          !judged.ok && judged.short.length > 0 && judged.short.every((s) => s === 'cpu');
        advanceClock(cpuClock, cpuOnly, judged.ok);
        // Warming up counts as steady for the clock: a restart must not lose the turn it was
        // owed. So does a wobble of swap short of the exit threshold (SWAP_GROWTH_EXIT_FACTOR).
        const steady =
          !judged.ok &&
          (judged.steadySwap === true || judged.warmingUp === true || judged.swapWobble === true);
        advanceClock(steadyClock, steady, judged.ok);
        keepState();
        error = undefined;
        return sample;
      })
      .catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err);
        return null;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return {
    start() {
      if (timer) return;
      void refresh();
      timer = every('resource monitor', () => refresh(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    refresh,
    history: () => samples,
    latest: () => samples[samples.length - 1],
    lastError: () => error,
    lastStartedAt: () => lastStart,
    settings,
    admission(waiting) {
      const current = settings();
      // Not looked yet (just started): a few seconds' wait, not a start on no knowledge (the
      // samples read back from disk tell the trend, not how the Mac is now). A sampler that
      // fails lets tasks in (the doctor's resources check says so).
      if (current.enabled && !fresh && !error) {
        void refresh();
        return { ok: false, short: [], settling: true, detail: 'the first sample is being taken' };
      }
      // The clocks are kept by refresh(); admission only reads them (so asking twice never
      // spends a grant, and a single off-range sample has not reset the countdown).
      const judged = judgeAdmission(samples, current, typical);
      const cpuOnly =
        !judged.ok && judged.short.length > 0 && judged.short.every((s) => s === 'cpu');
      // Waited long enough on a trend not known yet (2026-11-11): the turn is taken as if swap
      // were steady. Nothing in the samples there are is wrong (else it would be held, not
      // warming up), and the turn's clock still doses them, one every steadySwapMaxWaitMin.
      const overdue =
        judged.warmingUp === true &&
        current.trendUnknownMaxWaitMin > 0 &&
        (waiting?.waitedMs ?? 0) >= current.trendUnknownMaxWaitMin * 60_000;
      const rule = steadyRule(overdue ? { ...judged, steadySwap: true } : judged, current);
      let verdict: AdmissionVerdict = judged;
      forcedAnswer = undefined;
      const anyway = (clock: GrantClock) =>
        `turn cancelled ${clock.stalls}× without letting a task in: one let in anyway`;
      const ceiling = overCeiling(current);
      const cpuWait = cpuWaitMs(current);
      const cpuWaitMin = Math.max(1, Math.round(cpuWait / 60_000));
      const cpuDue =
        cpuOnly && current.cpuOnlyMaxWaitMin > 0 && !ceiling ? due(cpuClock, cpuWait) : undefined;
      if (cpuDue?.ok) {
        if (cpuDue.forced) forcedAnswer = { clock: 'cpu-only', cancelled: cpuClock.stalls };
        verdict = {
          ...judged,
          ok: true,
          short: [],
          tight: true,
          detail: cpuDue.forced
            ? `${judged.detail}; only the CPU is short, ${anyway(cpuClock)}`
            : `${judged.detail}; only the CPU was short for ${cpuWaitMin} min, memory has room: one let in`,
        };
      } else if (rule && steadyClock.since !== undefined) {
        const { waitMin } = rule;
        const turn = due(steadyClock, waitMin * 60_000);
        const ruleText = overdue
          ? `waited over ${current.trendUnknownMaxWaitMin} min for the trend, one task let in every ${waitMin} min`
          : `one task let in every ${waitMin} min`;
        if (turn.ok) {
          if (turn.forced) forcedAnswer = { clock: 'steady-swap', cancelled: steadyClock.stalls };
          verdict = {
            ...judged,
            ok: true,
            short: [],
            tight: true,
            detail: turn.forced
              ? `${judged.detail}; ${ruleText}, ${anyway(steadyClock)}`
              : `${judged.detail}; ${ruleText}: one let in now`,
          };
        } else {
          const nextMin = Math.max(1, Math.ceil(turn.leftMs / 60_000));
          verdict = { ...judged, detail: `${judged.detail}; ${ruleText} (next in ${nextMin} min)` };
        }
      } else if (judged.swapWobble && steadyClock.since !== undefined) {
        verdict = {
          ...judged,
          detail: `${judged.detail}; the turn is kept for when swap is still`,
        };
      } else if (judged.short.includes('cpu') && ceiling) {
        verdict = {
          ...judged,
          detail: `${judged.detail}; over ${current.maxGrantLoadPerCore} × cores no task is let in until the load drops`,
        };
      } else if (cpuDue) {
        const nextMin = Math.max(1, Math.ceil(cpuDue.leftMs / 60_000));
        verdict = {
          ...judged,
          detail: `${judged.detail}; with only the CPU short one task is let in every ${cpuWaitMin} min at this load (next in ${nextMin} min)`,
        };
      }
      if (!verdict.ok || !current.enabled) return verdict;
      // The ramp (2026-11-11): one at a time, with a pause to see what the last one takes…
      const left = lastStart + current.settleSec * 1000 - now();
      if (left > 0) {
        return {
          ok: false,
          short: [],
          settling: true,
          detail: `the last task let in is settling (${Math.ceil(left / 1000)} s)`,
        };
      }
      // …and room kept for the ones the sample does not show yet. A turn granted with the CPU
      // short is not asked for CPU room again, only for memory.
      const pending = pendingStarts(current);
      const latest = samples[samples.length - 1];
      if (pending > 0 && latest) {
        const room = roomFor(latest, current, typical, pending);
        const left = judged.ok ? room.fits : room.byMemory - pending;
        if (left < 1) {
          return {
            ok: false,
            short: [],
            settling: true,
            detail: `${pending} task(s) let in over the last ${current.rampWindowSec} s are still starting: room is kept for them (about ${gb(typical.memBytes)} and a load of ${typical.load.toFixed(1)} each) until the samples show what they take`,
          };
        }
      }
      return verdict;
    },
    room() {
      const current = settings();
      const latest = samples[samples.length - 1];
      if (!current.enabled || !latest) return;
      const verdict = this.admission();
      const room = roomFor(latest, current, typical, pendingStarts(current));
      const { limit } = loadLimitOf(current, latest.cores);
      const numbers = [
        limit > 0
          ? `load ${latest.load.toFixed(1)} of ${limit.toFixed(0)}`
          : `load ${latest.load.toFixed(1)}`,
        memoryFloorOf(latest, current) > current.minFreeMemoryPercent
          ? `memory ${Math.round(latest.memFreePercent)} % free, free entry down to ${memoryFloorOf(latest, current)} % while swap is past its level`
          : `memory ${Math.round(latest.memFreePercent)} % free over a ${current.minFreeMemoryPercent} % floor`,
      ].join(', ');
      const head = `the Mac is at ${room.percentOfTarget} % of its target (${numbers})`;
      if (!verdict.ok) {
        return {
          percentOfTarget: room.percentOfTarget,
          fits: 0,
          line: `${head}: no task is let in now: ${verdict.detail}`,
        };
      }
      const fits = Math.max(1, room.fits);
      return {
        percentOfTarget: room.percentOfTarget,
        fits,
        line: `${head}: room for ${fits} more task${fits === 1 ? '' : 's'} (about ${gb(typical.memBytes)} and a load of ${typical.load.toFixed(1)} each as they start)`,
      };
    },
    typicalTask: () => typical,
    steadySwapGrant() {
      const current = settings();
      if (!current.enabled) return;
      const rule = steadyRule(judgeAdmission(samples, current), current);
      return rule ? { waitMin: rule.waitMin } : undefined;
    },
    grantStalls: () => ({ steady: steadyClock.stalls, cpu: cpuClock.stalls }),
    forcedGrants: () => ({ count: forcedCount, ...(lastForced ? { last: lastForced } : {}) }),
    started() {
      const t = now();
      if (forcedAnswer) {
        lastForced = { at: t, ...forcedAnswer };
        forcedCount += 1;
        logger.warn(
          `task admission: the ${lastForced.clock} turn was cancelled ${lastForced.cancelled}× without letting a task in; one let in anyway (forced grant #${forcedCount})`
        );
        forcedAnswer = undefined;
      }
      lastStart = t;
      const latest = samples[samples.length - 1];
      starts.push({
        at: t,
        ...(latest ? { freeBytes: freeBytesOf(latest), load: latest.load } : {}),
      });
      // 2026-11-02: the CPU-only grant was spent when it was *answered*: a new task asking while
      // others waited was told "room", queued behind them, and the pump that followed found the
      // 20 min clock reset, so a task waited 80 min. It is spent only by a task that starts.
      // The steady-swap grant the same way: the next one waits its own time.
      // A task started: the admission system is making progress, so no grant rule is "never
      // granting" right now — drop the stalls and what cancelled turns had waited, whichever
      // path let this task in (review 2026-11-08).
      for (const clock of [cpuClock, steadyClock]) {
        if (clock.since !== undefined) clock.since = t;
        clock.failing = undefined;
        clock.waited = 0;
        clock.stalls = 0;
        clock.streak = undefined;
      }
      keepState();
    },
  };
}

/**
 * What really holds memory or swap now, for the checks' load gate (CPU it judges itself, by
 * checkLoad); undefined: room, no sample, admission off, or only paced (a steady swap or
 * pressure warn slows new tasks, it does not stop a check).
 */
export function memoryShortage(
  history: readonly ResourceSample[],
  settings: TaskAdmissionSettings
): string | undefined {
  const verdict = judgeAdmission(history, { ...settings, maxLoadPerCore: 0 });
  return verdict.ok || verdict.steadySwap || verdict.warmingUp ? undefined : verdict.detail;
}

/** A program and what its processes hold in memory together (resident pages). */
export interface MemoryHolder {
  name: string;
  processes: number;
  rssBytes: number;
}

/**
 * `ps -axo rss=,comm=` → the programs holding the most resident memory, their processes summed
 * (Chrome's helpers count as one), biggest first.
 */
export function parsePsMemory(text: string, limit = 5): MemoryHolder[] {
  const byName = new Map<string, MemoryHolder>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const name = match[2].split('/').pop() || match[2];
    const holder = byName.get(name) ?? { name, processes: 0, rssBytes: 0 };
    holder.processes += 1;
    holder.rssBytes += Number(match[1]) * 1024;
    byName.set(name, holder);
  }
  return [...byName.values()].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, limit);
}

/** The programs holding the most memory now (one `ps`, for the doctor only; nothing is killed). */
export async function memoryHolders(limit = 5): Promise<MemoryHolder[]> {
  return parsePsMemory(await run('/bin/ps', ['-axo', 'rss=,comm=']), limit);
}

/** "Google Chrome Helper (Renderer) ×31 4.2 GB, node ×12 2.9 GB". */
export function describeMemoryHolders(holders: readonly MemoryHolder[]): string {
  return holders
    .map((h) => `${h.name}${h.processes > 1 ? ` ×${h.processes}` : ''} ${gb(h.rssBytes)}`)
    .join(', ');
}

/** A sample in one line, for the doctor and logs. */
export function describeSample(sample: ResourceSample): string {
  return [
    `memory ${Math.round(sample.memFreePercent)} % free (${gb(sample.memAvailableBytes)} of ${gb(sample.memTotalBytes)} available)`,
    `pressure ${sample.pressure}`,
    `swap ${gb(sample.swapUsedBytes)}`,
    `load ${sample.load.toFixed(1)} on ${sample.cores} cores`,
  ].join(', ');
}

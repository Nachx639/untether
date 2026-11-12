/**
 * The merge train of a two-level project (2026-11-02, ProjectSettings.relatedTestCommand).
 *
 * The whole check (for Untether: pnpm run check and ~6900 tests, 2-3 min idle, much longer under
 * load) ran for every task: the main cost per task and the main source of load flakes. In a
 * two-level project a task's own check is the fast one and only the tests related to its files;
 * the whole check still guards the base, once per batch of merges, on their combined result:
 *
 *  - The task at the head of the merge queue (merge-queue.ts) builds on the train's tip (the last
 *    car's commit; the base when the train is empty), runs its own check there and boards: it
 *    leaves the merge queue, so the next task takes its turn on top of it, and waits.
 *  - The train leaves when nobody is in the merge queue behind it, when it has `maxCars`, or
 *    `maxWaitMs` after its first car boarded. It runs the whole check once, in the last car's
 *    worktree (its commit is the combined result), unless that car's own check was the whole
 *    one already. Passed: the base moves once, to the last car's commit; every car is merged.
 *  - Failed: the batch is bisected on the cars' commits (car i's commit is the base plus cars
 *    1..i): the first prefix that fails names the car that broke it. The cars before it merge,
 *    it is sent back (its related tests passed but it broke something else), the ones after it
 *    build again on the new base. A car whose own check was the whole one is a known good prefix.
 *  - A base moved by hand meanwhile, a car discarded while the batch was checked, or a car that
 *    built on another tip than the train's: they build again (`again`); nothing unchecked moves.
 *
 * Generic and in memory: the pipeline (task-merge.ts) hands each car its own closures (its
 * check, the base move with its journal entry) and keeps the restart refs.
 */
import type { TaskVerify } from '../../shared/tasks.js';
import { loopStep } from '../utils/periodic-loop.js';
import type { MergeQueue } from './merge-queue.js';

export interface TrainCheck {
  passed: boolean;
  verify: TaskVerify;
  /** Not the code's: the disk was low, Untether failed. All cars stop as Untether's. */
  internal?: string;
}

export type TrainMove =
  | { kind: 'merged' }
  /** The base is not where the train was built on (moved by hand). */
  | { kind: 'moved' }
  /** The base can't be moved now (a dirty checkout, an error): the cars that would merge stop. */
  | { kind: 'blocked'; reason: string; detail?: unknown };

export interface TrainCar {
  id: string;
  /** Its commit: what it built on with its own work merged in. */
  head: string;
  /** The commit it built on: the previous car's head, or the base. */
  onto: string;
  /** The level of its own check: a 'full' one is a known good prefix. */
  level: 'related' | 'full';
  /** Its own changed files. */
  files: string[];
  /** The whole check in its worktree, on its head, of these files' packages. */
  fullCheck(files: string[]): Promise<TrainCheck>;
  /** Records (task journal) that the base is about to get its head; before any move. */
  recordMove?(): void;
  /** Moves the base from `expected` to `sha`. */
  move(expected: string, sha: string): Promise<TrainMove>;
  /** The batch check's run, recorded on every car of the batch. */
  batchRan?(run: { start: number; end: number; outcome: string; by: string }): void;
  note?(text: string): void;
  signal?: AbortSignal;
}

export type TrainVerdict =
  /** The base has its head now; `onto` is where its own change starts. */
  | { kind: 'merged'; onto: string }
  /** It broke the whole check: the run that failed (on its commit, in its worktree). */
  | { kind: 'failed'; verify: TaskVerify; batch: number }
  /** Build again on the base as it is now. */
  | { kind: 'again'; reason: string }
  | { kind: 'blocked'; reason: string; detail?: unknown }
  | { kind: 'internal'; reason: string; verify?: TaskVerify }
  /** It was discarded meanwhile. */
  | { kind: 'left' };

export interface MergeTrains {
  /**
   * What the car taking its turn builds on: the last car's head, or undefined (the base). While
   * a batch is checked it waits for its end.
   */
  base(key: string, signal?: AbortSignal): Promise<string | undefined>;
  /** A batch is boarding or being checked. */
  busy(key: string): boolean;
  /** Resolves once no batch is boarding or being checked (at once when there is none). */
  gone(key: string, signal?: AbortSignal): Promise<void>;
  /** `main`: the base the first car built on. Resolves once the batch is decided. */
  board(key: string, car: TrainCar, main: string): Promise<TrainVerdict>;
  /** The cars on board, in order (tests, status). */
  cars(key: string): string[];
  /**
   * The cars of a batch still boarding (its whole check has not started): one of them can leave
   * at once (its signal), the ones built on it build again.
   */
  boarding(key: string): string[];
}

export interface MergeTrainOptions {
  queue: MergeQueue;
  maxCars?: number;
  maxWaitMs?: number;
}

export const TRAIN_MAX_CARS = 6;
export const TRAIN_MAX_WAIT_MS = 15 * 60_000;

interface Boarded {
  car: TrainCar;
  resolve: (verdict: TrainVerdict) => void;
  aborted: boolean;
  onAbort?: () => void;
}

interface Train {
  main: string;
  cars: Boarded[];
  departing: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const lastHead = (train: Train | undefined) =>
  train?.cars.length ? train.cars[train.cars.length - 1].car.head : undefined;

export function createMergeTrains(options: MergeTrainOptions): MergeTrains {
  const maxCars = options.maxCars ?? TRAIN_MAX_CARS;
  const maxWaitMs = options.maxWaitMs ?? TRAIN_MAX_WAIT_MS;
  const trains = new Map<string, Train>();
  const idle = new Map<string, (() => void)[]>();

  const wakeIdle = (key: string) => {
    for (const resolve of idle.get(key)?.splice(0) ?? []) resolve();
    idle.delete(key);
  };

  const settle = (boarded: Boarded, verdict: TrainVerdict) => {
    if (boarded.onAbort) boarded.car.signal?.removeEventListener('abort', boarded.onAbort);
    boarded.resolve(boarded.aborted ? { kind: 'left' } : verdict);
  };

  const noteAll = (cars: Boarded[], text: string) => {
    for (const { car } of cars) car.note?.(text);
  };

  const depart = async (key: string) => {
    const train = trains.get(key);
    if (!train || train.departing) return;
    if (!train.cars.length) {
      // Emptied (its cars discarded): nothing to check; its timer and entry go.
      if (train.timer) clearTimeout(train.timer);
      trains.delete(key);
      wakeIdle(key);
      return;
    }
    train.departing = true;
    if (train.timer) clearTimeout(train.timer);
    const cars = [...train.cars];
    const n = cars.length;
    const ids = cars.map(({ car }) => car.id).join(', ');
    noteAll(cars, `# merge batch of ${n} (${ids}) leaves`);
    const filesUpTo = (i: number) => [
      ...new Set(cars.slice(0, i + 1).flatMap(({ car }) => car.files)),
    ];
    const runs = new Map<number, TrainCheck>();
    const check = async (i: number): Promise<TrainCheck> => {
      const start = Date.now();
      const result = await cars[i].car.fullCheck(filesUpTo(i));
      const outcome = result.internal ? 'internal' : result.passed ? 'passed' : 'failed';
      const prefix = i === n - 1 ? `the batch of ${n}` : `cars 1-${i + 1} of ${n}`;
      for (const { car } of cars.slice(0, i + 1)) {
        car.batchRan?.({
          start,
          end: Date.now(),
          outcome: `${outcome} (${prefix})`,
          by: cars[i].car.id,
        });
      }
      noteAll(
        cars,
        `# merge batch: the whole check of ${prefix} (in ${cars[i].car.id}) ${outcome}`
      );
      runs.set(i, result);
      return result;
    };
    try {
      const last = n - 1;
      // The last car's own check was the whole one: it ran on the combined result already.
      let good = -1;
      cars.forEach(({ car }, i) => {
        if (car.level === 'full') good = i;
      });
      let bad = -1;
      if (good < last) {
        const whole = await check(last);
        if (whole.internal) {
          for (const boarded of cars) {
            settle(boarded, { kind: 'internal', reason: whole.internal, verify: whole.verify });
          }
          return;
        }
        if (!whole.passed) {
          bad = last;
          // The first prefix that fails: good < culprit <= bad.
          while (bad - good > 1) {
            const mid = Math.floor((good + bad) / 2);
            const r = await check(mid);
            if (r.internal) {
              for (const boarded of cars) {
                settle(boarded, { kind: 'internal', reason: r.internal, verify: r.verify });
              }
              return;
            }
            if (r.passed) good = mid;
            else bad = mid;
          }
        } else {
          good = last;
        }
      }
      const merging = bad < 0 ? last : bad - 1;
      const again = (from: number, reason: string) => {
        for (const boarded of cars.slice(from)) settle(boarded, { kind: 'again', reason });
      };
      // A car discarded meanwhile: its work must not reach the base, nor anything built on it.
      const gone = cars.findIndex((boarded) => boarded.aborted);
      if (gone >= 0 && gone <= merging) {
        again(0, 'a task of the merge batch was discarded');
        return;
      }
      if (merging >= 0) {
        for (const { car } of cars.slice(0, merging + 1)) car.recordMove?.();
        const moved = await cars[merging].car.move(train.main, cars[merging].car.head);
        if (moved.kind === 'moved') {
          again(0, 'the base moved while the batch was checked');
          return;
        }
        if (moved.kind === 'blocked') {
          for (const boarded of cars.slice(0, merging + 1)) {
            settle(boarded, { kind: 'blocked', reason: moved.reason, detail: moved.detail });
          }
          if (bad >= 0) {
            settle(cars[bad], {
              kind: 'failed',
              verify: (runs.get(bad) as TrainCheck).verify,
              batch: n,
            });
          }
          again(bad >= 0 ? bad + 1 : merging + 1, 'the batch could not merge');
          return;
        }
        noteAll(
          cars,
          `# merge batch: base moved to ${cars[merging].car.head} (${merging + 1} of ${n})`
        );
        for (const boarded of cars.slice(0, merging + 1)) {
          settle(boarded, { kind: 'merged', onto: boarded.car.onto });
        }
      }
      if (bad >= 0) {
        settle(cars[bad], {
          kind: 'failed',
          verify: (runs.get(bad) as TrainCheck).verify,
          batch: n,
        });
        again(bad + 1, `built on ${cars[bad].car.id}, which broke the whole check`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const boarded of cars) settle(boarded, { kind: 'internal', reason });
    } finally {
      trains.delete(key);
      wakeIdle(key);
    }
  };

  const maybeDepart = (key: string) => {
    const train = trains.get(key);
    if (!train || train.departing || !train.cars.length) return;
    if (train.cars.length >= maxCars || options.queue.line(key).length === 0) void depart(key);
  };
  options.queue.onChange((key) => {
    // After the change is done (a leave wakes the next one first).
    queueMicrotask(() => maybeDepart(key));
  });

  /** Until the key's batch is gone (wakeIdle); rejects when `signal` aborts. */
  const untilIdle = (key: string, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const list = idle.get(key) ?? [];
      idle.set(key, list);
      const abort = () => reject(new DOMException('Left the merge train', 'AbortError'));
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      list.push(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      });
    });

  return {
    async base(key, signal) {
      for (;;) {
        const train = trains.get(key);
        if (!train?.departing) return lastHead(train);
        await untilIdle(key, signal);
      }
    },
    async gone(key, signal) {
      while (trains.get(key)) await untilIdle(key, signal);
    },
    busy(key) {
      return !!trains.get(key)?.cars.length;
    },
    board(key, car, main) {
      let train = trains.get(key);
      if (train?.departing) {
        return Promise.resolve({ kind: 'again', reason: 'a merge batch was being checked' });
      }
      const tip = lastHead(train) ?? main;
      if (car.onto !== tip || (train && !train.cars.length && train.main !== main)) {
        return Promise.resolve({ kind: 'again', reason: 'the merge batch moved on meanwhile' });
      }
      if (!train) {
        train = { main, cars: [], departing: false };
        trains.set(key, train);
        const created = train;
        created.timer = setTimeout(
          loopStep('merge train departure', () => depart(key)),
          maxWaitMs
        );
        created.timer.unref?.();
      }
      const current = train;
      return new Promise<TrainVerdict>((resolve) => {
        const boarded: Boarded = { car, resolve, aborted: false };
        current.cars.push(boarded);
        if (car.signal) {
          boarded.onAbort = () => {
            boarded.aborted = true;
            if (current.departing) return; // decided at the move (see depart)
            const index = current.cars.indexOf(boarded);
            const after = current.cars.splice(index);
            for (const other of after) {
              settle(other, { kind: 'again', reason: `built on ${car.id}, which was discarded` });
            }
            if (!current.cars.length) {
              if (current.timer) clearTimeout(current.timer);
              trains.delete(key);
              wakeIdle(key);
            }
          };
          if (car.signal.aborted) boarded.onAbort();
          else car.signal.addEventListener('abort', boarded.onAbort, { once: true });
        }
        maybeDepart(key);
      });
    },
    cars(key) {
      return (trains.get(key)?.cars ?? []).map(({ car }) => car.id);
    },
    boarding(key) {
      const train = trains.get(key);
      return train && !train.departing ? train.cars.map(({ car }) => car.id) : [];
    },
  };
}

const byQueue = new WeakMap<MergeQueue, MergeTrains>();

/** The trains of a merge queue's lines (one per queue, made on first use). */
export function mergeTrainsFor(queue: MergeQueue): MergeTrains {
  let trains = byQueue.get(queue);
  if (!trains) {
    trains = createMergeTrains({ queue });
    byQueue.set(queue, trains);
  }
  return trains;
}

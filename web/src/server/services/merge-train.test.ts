import { describe, expect, it } from 'vitest';
import type { TaskVerify } from '../../shared/tasks.js';
import { createMergeQueue } from './merge-queue.js';
import { createMergeTrains, type TrainCar, type TrainMove } from './merge-train.js';

/**
 * The merge train of a two-level project (2026-11-02): each task checks only its related tests,
 * the whole check runs once per batch on the combined result before the base moves, and a
 * failure is pinned on the car that broke it.
 */
const KEY = 'repo\0main';
const verify = (exitCode: number): TaskVerify => ({
  command: 'whole',
  cwd: '/wt',
  startedAt: new Date().toISOString(),
  exitCode,
});

interface World {
  /** Prefix i (cars 1..i+1 merged) passes the whole check. */
  passes(prefix: string[]): boolean;
  checks: string[][];
  moves: { expected: string; sha: string }[];
  move?: TrainMove;
}

const world = (passes: (prefix: string[]) => boolean): World => ({
  passes,
  checks: [],
  moves: [],
});

/** Car `id` built on `onto`; its head is `onto+id`; `prefix` is every id up to it. */
const car = (
  w: World,
  id: string,
  onto: string,
  level: 'related' | 'full' = 'related'
): TrainCar => ({
  id,
  head: `${onto}+${id}`,
  onto,
  level,
  files: [`${id}.ts`],
  async fullCheck() {
    const prefix = `${onto}+${id}`.split('+').slice(1);
    w.checks.push(prefix);
    await Promise.resolve();
    return { passed: w.passes(prefix), verify: verify(w.passes(prefix) ? 0 : 1) };
  },
  async move(expected, sha) {
    w.moves.push({ expected, sha });
    return w.move ?? { kind: 'merged' };
  },
});

describe('merge train', () => {
  it('a lone car leaves at once and merges after one whole check', async () => {
    const queue = createMergeQueue();
    const trains = createMergeTrains({ queue });
    const w = world(() => true);
    const verdict = await trains.board(KEY, car(w, 'a', 'm'), 'm');
    expect(verdict).toEqual({ kind: 'merged', onto: 'm' });
    expect(w.checks).toEqual([['a']]);
    expect(w.moves).toEqual([{ expected: 'm', sha: 'm+a' }]);
  });

  it('a car whose own check was the whole one needs no batch check', async () => {
    const queue = createMergeQueue();
    const trains = createMergeTrains({ queue });
    const w = world(() => true);
    expect(await trains.board(KEY, car(w, 'a', 'm', 'full'), 'm')).toEqual({
      kind: 'merged',
      onto: 'm',
    });
    expect(w.checks).toEqual([]);
  });

  it('waits while someone is in the merge queue, then checks the batch once', async () => {
    const queue = createMergeQueue();
    const trains = createMergeTrains({ queue });
    const w = world(() => true);
    const ticketB = queue.join(KEY, { id: 'b', at: 2 });
    const a = trains.board(KEY, car(w, 'a', 'm'), 'm');
    expect(trains.cars(KEY)).toEqual(['a']);
    expect(await trains.base(KEY)).toBe('m+a');
    const b = trains.board(KEY, car(w, 'b', 'm+a'), 'm');
    ticketB.leave();
    expect(await a).toEqual({ kind: 'merged', onto: 'm' });
    expect(await b).toEqual({ kind: 'merged', onto: 'm+a' });
    expect(w.checks).toEqual([['a', 'b']]);
    expect(w.moves).toEqual([{ expected: 'm', sha: 'm+a+b' }]);
  });

  it('a cross-file break: bisected, the cars before merge, the culprit is sent back, the rest build again', async () => {
    const queue = createMergeQueue();
    const trains = createMergeTrains({ queue });
    // c breaks what a and b do together with it; each passes its related tests.
    const w = world((prefix) => !prefix.includes('c'));
    const ticket = queue.join(KEY, { id: 'later', at: 9 });
    const a = trains.board(KEY, car(w, 'a', 'm'), 'm');
    const b = trains.board(KEY, car(w, 'b', 'm+a'), 'm');
    const c = trains.board(KEY, car(w, 'c', 'm+a+b'), 'm');
    const d = trains.board(KEY, car(w, 'd', 'm+a+b+c'), 'm');
    ticket.leave();
    expect(await a).toEqual({ kind: 'merged', onto: 'm' });
    expect(await b).toEqual({ kind: 'merged', onto: 'm+a' });
    expect(await c).toMatchObject({ kind: 'failed', batch: 4 });
    expect(await d).toMatchObject({ kind: 'again' });
    // The whole batch, then the prefixes the bisection needed.
    expect(w.checks).toEqual([
      ['a', 'b', 'c', 'd'],
      ['a', 'b'],
      ['a', 'b', 'c'],
    ]);
    expect(w.moves).toEqual([{ expected: 'm', sha: 'm+a+b' }]);
  });

  it('the first car broke it: nothing merges', async () => {
    const queue = createMergeQueue();
    const trains = createMergeTrains({ queue });
    const w = world((prefix) => !prefix.includes('a'));
    const ticket = queue.join(KEY, { id: 'later', at: 9 });
    const a = trains.board(KEY, car(w, 'a', 'm'), 'm');
    const b = trains.board(KEY, car(w, 'b', 'm+a'), 'm');
    ticket.leave();
    expect(await a).toMatchObject({ kind: 'failed' });
    expect(await b).toMatchObject({ kind: 'again' });
    expect(w.moves).toEqual([]);
  });

  it('a base moved by hand: every car builds again, nothing unchecked moves', async () => {
    const queue = createMergeQueue();
    const trains = createMergeTrains({ queue });
    const w = world(() => true);
    w.move = { kind: 'moved' };
    expect(await trains.board(KEY, car(w, 'a', 'm'), 'm')).toMatchObject({ kind: 'again' });
  });

  it('a car built on another tip, or boarding while a batch is checked, builds again', async () => {
    const queue = createMergeQueue();
    const trains = createMergeTrains({ queue });
    const w = world(() => true);
    const ticket = queue.join(KEY, { id: 'later', at: 9 });
    const a = trains.board(KEY, car(w, 'a', 'm'), 'm');
    expect(await trains.board(KEY, car(w, 'b', 'm'), 'm')).toMatchObject({ kind: 'again' });
    ticket.leave();
    expect(await a).toMatchObject({ kind: 'merged' });
  });

  it('a discarded car leaves; the ones built on it build again', async () => {
    const queue = createMergeQueue();
    const trains = createMergeTrains({ queue });
    const w = world(() => true);
    const ticket = queue.join(KEY, { id: 'later', at: 9 });
    const controller = new AbortController();
    const first = { ...car(w, 'a', 'm'), signal: controller.signal };
    const a = trains.board(KEY, first, 'm');
    const b = trains.board(KEY, car(w, 'b', 'm+a'), 'm');
    controller.abort();
    expect(await a).toEqual({ kind: 'left' });
    expect(await b).toMatchObject({ kind: 'again' });
    expect(trains.busy(KEY)).toBe(false);
    ticket.leave();
  });

  it('leaves at maxCars even with more waiting', async () => {
    const queue = createMergeQueue();
    const trains = createMergeTrains({ queue, maxCars: 2 });
    const w = world(() => true);
    const ticket = queue.join(KEY, { id: 'later', at: 9 });
    const a = trains.board(KEY, car(w, 'a', 'm'), 'm');
    const b = trains.board(KEY, car(w, 'b', 'm+a'), 'm');
    expect(await a).toMatchObject({ kind: 'merged' });
    expect(await b).toMatchObject({ kind: 'merged' });
    ticket.leave();
  });
  it('a base that cannot move: the cars that would merge stop with its reason, the culprit still fails', async () => {
    const queue = createMergeQueue();
    const trains = createMergeTrains({ queue });
    const w = world((prefix) => !prefix.includes('b'));
    w.move = { kind: 'blocked', reason: 'main checkout is dirty' };
    const ticket = queue.join(KEY, { id: 'later', at: 9 });
    const a = trains.board(KEY, car(w, 'a', 'm'), 'm');
    const b = trains.board(KEY, car(w, 'b', 'm+a'), 'm');
    const c = trains.board(KEY, car(w, 'c', 'm+a+b'), 'm');
    ticket.leave();
    expect(await a).toEqual({ kind: 'blocked', reason: 'main checkout is dirty' });
    expect(await b).toMatchObject({ kind: 'failed' });
    expect(await c).toMatchObject({ kind: 'again' });
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';
import { HISTORY_LIMIT } from './task-scheduler-rules.js';

// 2026-11-11 (server audit): what the scheduler keeps per task in memory was dropped on a
// merge, a discard and a removal only. A task closed as done or missed, and every task that
// left the history, kept its entries for as long as the server ran; several maps were in no
// forget() at all.

/** Per task, but the task's own flows put in and take out (a run under way, a timer armed on purpose). */
const NOT_FORGOTTEN = new Set([
  // Runs under way: each flow removes its own mark when it ends.
  'finishing',
  'discarding',
  'retrying',
  'resuming',
  'piping',
  'pipeRuns',
  'lookingAtBase',
  'typing',
  'readingTokens',
  'touchLooking',
  'syncing',
  'folderLooking',
  'dueStarting',
  'reverting',
  // Armed by the final state itself: stops the finished task's session, then removes itself.
  'finishedTimers',
  // Keyed by session, not by task.
  'replacing',
  'launchedHere',
  'lastStatus',
  'userHolds',
  'previews',
  // Not keyed by task at all.
  'jobs',
  'holds', // seeded apart: its values are timers (cancelHold)
]);

const task = (overrides: Partial<NewTask> = {}): NewTask => ({
  name: 'Arregla el login',
  prompt: 'Arregla el login',
  workingDir: '/repo',
  command: ['claude'],
  agent: 'claude',
  shielded: false,
  notify: true,
  isolation: 'none',
  ...overrides,
});

describe('TaskScheduler: what is kept per task is forgotten', () => {
  let dir: string;
  let scheduler: TaskScheduler;
  let n: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-forget-'));
    n = 0;
    const worktrees = {
      create: vi.fn(),
      remove: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true })),
      commitLeftovers: vi.fn(async () => false),
      changes: vi.fn(async () => ({ files: [], stats: undefined })),
      hasUnmergedWork: vi.fn(async () => false),
    } as unknown as TaskWorktrees;
    scheduler = new TaskScheduler({
      storePath: path.join(dir, 'tasks.json'),
      launch: (async () => ({ sessionId: `s${++n}` })) as unknown as TaskSchedulerDeps['launch'],
      notify: vi.fn(),
      sessionStatus: () => 'running',
      stopSession: async () => {},
      deliver: (async () => true) as unknown as TaskSchedulerDeps['deliver'],
      worktrees,
      inputWaitMs: 0,
    });
    await scheduler.start(0);
  });

  afterEach(() => {
    scheduler.stop();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  /** Every Map and Set the scheduler holds, by name. */
  const stores = () =>
    Object.entries(scheduler as unknown as Record<string, unknown>).filter(
      (entry): entry is [string, Map<string, unknown> | Set<string>] =>
        entry[1] instanceof Map || entry[1] instanceof Set
    );
  /** Puts the task in every store that is forgotten, as if it had gone through all of it. */
  const seed = (id: string) => {
    const seeded: string[] = [];
    for (const [name, store] of stores()) {
      if (NOT_FORGOTTEN.has(name)) continue;
      if (store instanceof Set) store.add(id);
      else if (name.endsWith('Timers'))
        store.set(
          id,
          setTimeout(() => {}, 60_000)
        );
      else store.set(id, 'x');
      seeded.push(name);
    }
    return seeded;
  };
  const holding = (id: string) =>
    stores()
      .filter(([name, store]) => !NOT_FORGOTTEN.has(name) && store.has(id))
      .map(([name]) => name);

  it('reads the stores (a class with none would pass everything)', () => {
    const names = stores().map(([name]) => name);
    expect(names.length).toBeGreaterThan(30);
    // Every exception is still a store of the class.
    expect([...NOT_FORGOTTEN].filter((name) => !names.includes(name))).toEqual([]);
    for (const expected of ['lastReply', 'touched', 'folderSeen', 'ledgerSigs', 'zoneStarting']) {
      expect(names).toContain(expected);
    }
  });

  it('a task closed as done leaves nothing behind', async () => {
    const created = await scheduler.create(task());
    await scheduler.settled();
    const running = scheduler.get(created.id) as TaskRecord;
    expect(running.state).toBe('working');
    const seeded = seed(created.id);
    expect(seeded.length).toBeGreaterThan(15);

    await scheduler.markDone(running.sessionId as string, 'hecho');
    await scheduler.settled();
    expect(scheduler.get(created.id)?.state).toBe('done');
    expect(holding(created.id)).toEqual([]);
  });

  it('a task that leaves the history leaves nothing behind either', async () => {
    const first = await scheduler.create(task({ name: 'la primera' }));
    await scheduler.settled();
    await scheduler.markDone(scheduler.get(first.id)?.sessionId as string, 'hecho');
    await scheduler.settled();
    // What a finished task still gets (its last usage read, its ledger entry).
    seed(first.id);

    for (let index = 0; index < HISTORY_LIMIT; index++) {
      const next = await scheduler.create(task({ name: `otra ${index}`, prompt: `otra ${index}` }));
      await scheduler.settled();
      await scheduler.markDone(scheduler.get(next.id)?.sessionId as string, 'hecho');
      await scheduler.settled();
    }
    expect(scheduler.get(first.id)).toBeUndefined();
    expect(holding(first.id)).toEqual([]);
  });
});

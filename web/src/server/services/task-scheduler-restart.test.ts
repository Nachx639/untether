/**
 * The task journal (shared/task-effects.ts, 2026-11-01): the server is killed at every point
 * between "recorded" and "done" of every effect a worktree task goes through (worktree,
 * session, its brief, the pipeline, the base move, the cleanup, the push), and a new server
 * started on what the dead one left on disk, with the world as the kill left it. Whatever the
 * point: the task ends merged, with one session, one merge, one brief and one push.
 *
 * A kill lands between two turns of the event loop (tsx watch's SIGTERM is handled there):
 * each effect is looked at right before it is made (the disk as it is then: conservative) and
 * after the turn it was made in (the disk and the world as a kill then would leave them).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { NotificationPayload } from './push-notification-service.js';
import type { PipelineOptions, PipelineResult, PipelineTask } from './task-merge.js';
import {
  type LaunchedSession,
  TASK_START_CUTS_MAX,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';
import type { TaskWorktreeSetup } from './task-worktree.js';

interface World {
  sessions: Record<string, 'running' | 'exited'>;
  /** Sessions made, in order. */
  launches: string[];
  /** Sessions a first message was typed into, once per typing. */
  typed: string[];
  /** Worktree folders there now, and how many were made. */
  worktrees: string[];
  made: number;
  /** The commits the base branch was moved to, once per move. */
  moves: string[];
  /** Pushes sent, by type. */
  pushes: string[];
}

interface KillPoint {
  label: string;
  /** tasks.json as the dead server left it (null: never written). */
  disk: string | null;
  world: World;
}

const HEAD = 'h1';
const ONTO = 'b0';
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('TaskScheduler across restarts (task journal, 2026-11-01)', () => {
  let dirs: string[];
  let schedulers: TaskScheduler[];

  beforeEach(() => {
    dirs = [];
    schedulers = [];
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    for (const dir of dirs) fs.rmSync(dir, RM_TEST_DIR);
  });

  const newDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-journal-'));
    dirs.push(dir);
    return dir;
  };

  /** A scheduler on `store` acting on `world`; `points` collects the kill points. */
  const make = (
    store: string,
    world: World,
    points?: KillPoint[],
    extra: Partial<TaskSchedulerDeps> = {}
  ) => {
    const look = (label: string) => {
      if (!points) return;
      points.push({
        label,
        disk: fs.existsSync(store) ? fs.readFileSync(store, 'utf8') : null,
        world: structuredClone(world),
      });
    };
    /** One effect on the world: looked at right before, and after the turn it was made in. */
    const act = (label: string, effect: () => void) => {
      look(`before ${label}`);
      effect();
      if (points) setImmediate(() => look(`after ${label}`));
    };
    const worktrees: TaskWorktrees = {
      create: async (_task: TaskRecord, setup: TaskWorktreeSetup) => {
        const worktreePath = `/wt/${world.made + 1}`;
        setup.onPlanned?.({ repoPath: '/repo', branch: 'ut/journal', worktreePath });
        await nextTurn();
        act('worktree add', () => {
          world.made++;
          world.worktrees.push(worktreePath);
        });
        await nextTurn();
        return {
          repoPath: '/repo',
          baseBranch: 'main',
          baseSha: ONTO,
          branch: 'ut/journal',
          worktreePath,
          clonedDirs: [],
        };
      },
      remove: async (task) => {
        act('worktree remove', () => {
          world.worktrees = world.worktrees.filter((dir) => dir !== task.worktreePath);
        });
        return { worktreeRemoved: true, branchDeleted: true };
      },
      commitLeftovers: async () => false,
      changes: async () => ({
        files: ['src/a.ts'],
        stats: { commits: 1, files: 1, insertions: 3, deletions: 1 },
      }),
      hasUnmergedWork: async () => false,
    };
    /** The merge is finished: the agent's session ends, the folder goes. */
    const cleanUp = async (task: PipelineTask, options: PipelineOptions) => {
      await options.beforeCleanup?.();
      await nextTurn();
      act('cleanup', () => {
        world.worktrees = world.worktrees.filter((dir) => dir !== task.worktreePath);
      });
      await nextTurn();
    };
    const merged: PipelineResult = {
      state: 'merged',
      mergedSha: HEAD,
      baseSha: HEAD,
      mergedOnto: ONTO,
    };
    /** A session made: running, then its first message typed once the agent is ready. */
    const open = async (sessionId: string, text: string): Promise<LaunchedSession> => {
      await nextTurn();
      act('session', () => {
        world.sessions[sessionId] = 'running';
        world.launches.push(sessionId);
      });
      // Made, but its maker has not answered yet (2026-11-01 review: a kill here left the
      // adopted session without its brief when the brief was recorded only on the answer).
      await nextTurn();
      const typed = sleep(2).then(() => {
        act('brief', () => world.typed.push(sessionId));
        return true;
      });
      return { sessionId, typed, text };
    };
    const scheduler = new TaskScheduler({
      storePath: store,
      logDir: path.join(path.dirname(store), 'logs'),
      launch: (_task, _prompt, sessionId) => open(sessionId, 'the brief'),
      resume: (_task, _conversation, sessionId) => open(sessionId, 'carry on'),
      // A message waiting (pendingInput) typed into a session.
      deliver: (sessionId) => {
        act('typing', () => world.typed.push(sessionId));
        return true;
      },
      sessionStatus: (sessionId) => world.sessions[sessionId],
      stopSession: async (sessionId) => {
        act('session stop', () => {
          world.sessions[sessionId] = 'exited';
        });
      },
      notify: (payload: NotificationPayload) => {
        act(`push ${payload.type}`, () => world.pushes.push(payload.type));
      },
      worktrees,
      // Never merges twice by itself: a second call after the move is a second merge.
      pipeline: async (task, options) => {
        await nextTurn();
        options.onProgress?.({ state: 'merging' });
        await nextTurn();
        options.onMoveBase?.({ sha: HEAD, onto: ONTO });
        act('base move', () => world.moves.push(HEAD));
        await nextTurn();
        await cleanUp(task, options);
        return merged;
      },
      finishMerge: async (task, options) => {
        const move = task.effects?.find((effect) => effect.kind === 'base');
        if (!move || !world.moves.includes(move.sha)) return null;
        await cleanUp(task, options);
        return merged;
      },
      setupRetryMs: 5,
      finishedSessionGraceMs: 5,
      now: () => Date.now(),
      ...extra,
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  const emptyWorld = (): World => ({
    sessions: {},
    launches: [],
    typed: [],
    worktrees: [],
    made: 0,
    moves: [],
    pushes: [],
  });

  /** Drive a task as its agent would until it is merged (or nothing more happens). */
  const drive = async (scheduler: TaskScheduler, world: World, id: string) => {
    for (let round = 0; round < 60; round++) {
      await scheduler.settled();
      await sleep(5);
      const task = scheduler.get(id);
      if (!task) return undefined;
      if (task.state === 'merged' && world.pushes.includes('task-merged')) return task;
      const { sessionId } = task;
      // The agent got its brief and did its work: it says it is done.
      if (
        task.state === 'working' &&
        sessionId &&
        world.sessions[sessionId] === 'running' &&
        world.typed.includes(sessionId)
      ) {
        await scheduler.markDone(sessionId, 'hecho');
      }
    }
    return scheduler.get(id);
  };

  it('every kill between a step recorded and done: merged once, one session, one brief, one push', async () => {
    const dir = newDir();
    const store = path.join(dir, 'tasks.json');
    const world = emptyWorld();
    const points: KillPoint[] = [];
    const first = make(store, world, points);
    await first.start(0);
    const created = await first.create({
      name: 'Journal',
      prompt: 'Haz algo',
      workingDir: '/repo',
      command: ['claude'],
      agent: 'claude',
      shielded: true,
      notify: true,
      isolation: 'worktree',
    });
    const done = await drive(first, world, created.id);
    await sleep(20);
    first.stop();
    // The run without a kill: what every run with one must end like.
    expect(done?.state).toBe('merged');
    expect(world.launches).toHaveLength(1);
    expect(world.moves).toEqual([HEAD]);
    expect(world.typed).toEqual(world.launches);
    expect(world.pushes).toEqual(['task-merged']);
    expect(world.worktrees).toEqual([]);
    // Every kind of step went by.
    const labels = points.map((point) => point.label);
    for (const step of [
      'worktree add',
      'session',
      'brief',
      'base move',
      'session stop',
      'cleanup',
      'push task-merged',
    ]) {
      expect(labels).toContain(`before ${step}`);
      expect(labels).toContain(`after ${step}`);
    }

    const outcomes: string[] = [];
    for (const point of points) {
      const again = newDir();
      const againStore = path.join(again, 'tasks.json');
      if (point.disk !== null) fs.writeFileSync(againStore, point.disk);
      const after = structuredClone(point.world);
      const second = make(againStore, after);
      await second.start(0);
      const task = await drive(second, after, created.id);
      await sleep(20);
      second.stop();
      const where = `killed ${point.label}`;
      if (!task) {
        // Killed before the task was first saved: nothing of it may have been done.
        expect(point.disk === null || !point.disk.includes(created.id), where).toBe(true);
        expect(after, where).toEqual(emptyWorld());
        continue;
      }
      expect(task.state, where).toBe('merged');
      expect(task.effects, where).toBeUndefined();
      expect(after.launches, `${where}: sessions made`).toHaveLength(1);
      expect(after.moves, `${where}: merges`).toEqual([HEAD]);
      expect(after.typed, `${where}: briefs typed`).toEqual(after.launches);
      expect(after.pushes, `${where}: pushes`).toEqual(['task-merged']);
      expect(after.worktrees, `${where}: folders left`).toEqual([]);
      expect(
        Object.values(after.sessions).filter((status) => status === 'running'),
        `${where}: sessions still running`
      ).toEqual([]);
      const saved = JSON.parse(fs.readFileSync(againStore, 'utf8'));
      expect(saved.outbox, `${where}: pushes left to send`).toBeUndefined();
      outcomes.push(point.label);
    }
    // Most points had the task on disk already: the loop really tried them.
    expect(outcomes.length).toBeGreaterThan(points.length / 2);
  }, 60_000);
  it('a session reopened after a restart, killed again while it is made: one new session, its message typed once', async () => {
    const dir = newDir();
    const store = path.join(dir, 'tasks.json');
    const world = emptyWorld();
    const first = make(store, world);
    await first.start(0);
    const created = await first.create({
      name: 'Journal',
      prompt: 'Haz algo',
      workingDir: '/repo',
      command: ['claude'],
      agent: 'claude',
      shielded: true,
      notify: true,
      isolation: 'worktree',
    });
    for (let i = 0; i < 20 && !world.typed.length; i++) await sleep(5);
    await first.settled();
    first.stop();
    const old = first.get(created.id)?.sessionId as string;
    expect(old).toBeTruthy();
    // The server went down and its session with it: the next one reopens the conversation.
    world.sessions[old] = 'exited';
    const disk = fs.readFileSync(store, 'utf8');
    const reopening = structuredClone(world);
    const points: KillPoint[] = [];
    const conversation = { claudeConversation: () => 'conv-1' };
    const second = make(store, reopening, points, conversation);
    await second.start(0);
    await second.checkExited();
    for (let i = 0; i < 20 && reopening.typed.length < 2; i++) await sleep(5);
    await second.settled();
    second.stop();
    expect(reopening.launches).toHaveLength(2);
    expect(points.map((point) => point.label)).toContain('after session');

    for (const point of points.filter((p) => p.disk !== disk || p.label.includes('session'))) {
      const again = newDir();
      const againStore = path.join(again, 'tasks.json');
      fs.writeFileSync(againStore, point.disk ?? disk);
      const after = structuredClone(point.world);
      const third = make(againStore, after, undefined, conversation);
      await third.start(0);
      await third.checkExited();
      for (let i = 0; i < 20 && after.typed.length < 2; i++) await sleep(5);
      await third.settled();
      await third.checkExited();
      await third.settled();
      third.stop();
      const where = `killed ${point.label}`;
      const task = third.get(created.id) as TaskRecord;
      // The first session, then exactly one more: never two agents on one conversation.
      expect(after.launches, `${where}: sessions made`).toHaveLength(2);
      expect(task.sessionId, where).toBe(after.launches[1]);
      expect(after.sessions[after.launches[1]], where).toBe('running');
      expect(after.typed, `${where}: messages typed`).toEqual(after.launches);
      expect(task.state, where).toBe('working');
      expect(task.effects, where).toBeUndefined();
    }
  }, 30_000);

  it('the same outcome after a restart is not pushed again', async () => {
    const dir = newDir();
    const store = path.join(dir, 'tasks.json');
    const world = emptyWorld();
    const ready = async (): Promise<PipelineResult> => ({ state: 'ready', headSha: HEAD });
    const first = make(store, world, undefined, { pipeline: ready });
    await first.start(0);
    const created = await first.create({
      name: 'Journal',
      prompt: 'Haz algo',
      workingDir: '/repo',
      command: ['claude'],
      agent: 'claude',
      shielded: true,
      notify: true,
      isolation: 'worktree',
      mergePolicy: 'ask',
    });
    for (let i = 0; i < 20 && !world.typed.length; i++) await sleep(5);
    await first.markDone(first.get(created.id)?.sessionId as string, 'hecho');
    await first.settled();
    expect(first.get(created.id)?.state).toBe('ready');
    expect(world.pushes).toEqual(['task-ready']);
    first.stop();
    // Checked again after a restart (the phone's «Comprobar», a redraw): nothing new to say.
    const second = make(store, world, undefined, { pipeline: ready });
    await second.start(0);
    expect(second.verify(created.id)).toMatchObject({ ok: true });
    await second.settled();
    expect(second.get(created.id)?.state).toBe('ready');
    expect(world.pushes).toEqual(['task-ready']);
  });
  const plain = {
    name: 'Journal',
    prompt: 'Haz algo',
    workingDir: '/repo',
    command: ['claude'],
    agent: 'claude' as const,
    shielded: true,
    notify: true,
    isolation: 'worktree' as const,
  };

  it('a push whose sending throws stays in the outbox and goes once, even across a restart (2026-11-01 review)', async () => {
    const dir = newDir();
    const store = path.join(dir, 'tasks.json');
    const world = emptyWorld();
    let fail = true;
    const notify = (payload: NotificationPayload) => {
      if (payload.type === 'task-ready' && fail) {
        fail = false;
        throw new Error('push service down');
      }
      world.pushes.push(payload.type);
    };
    const ready = async (): Promise<PipelineResult> => ({ state: 'ready', headSha: HEAD });
    const first = make(store, world, undefined, { pipeline: ready, notify });
    await first.start(0);
    const created = await first.create({ ...plain, mergePolicy: 'ask' });
    for (let i = 0; i < 20 && !world.typed.length; i++) await sleep(5);
    await first.markDone(first.get(created.id)?.sessionId as string, 'hecho');
    await first.settled();
    expect(world.pushes).toEqual([]);
    first.stop();
    // Still on disk, with the state it was about.
    expect(JSON.parse(fs.readFileSync(store, 'utf8')).outbox).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ type: 'task-ready' }),
        tries: 1,
      }),
    ]);
    const second = make(store, world, undefined, { pipeline: ready, notify });
    await second.start(0);
    await second.settled();
    expect(world.pushes).toEqual(['task-ready']);
    expect(JSON.parse(fs.readFileSync(store, 'utf8')).outbox).toBeUndefined();
  });

  const withWorktrees = (scheduler: TaskScheduler) =>
    (scheduler as unknown as { worktrees: TaskWorktrees }).worktrees;

  it('a half-made worktree stays recorded until its removal went, across a restart in the middle of it (2026-11-01 review)', async () => {
    const dir = newDir();
    const store = path.join(dir, 'tasks.json');
    const world = emptyWorld();
    const hang = new Promise<never>(() => {});
    // Killed while its worktree was being made.
    const first = make(store, world, undefined, {
      worktrees: {
        create: async (_t, setup) => {
          setup.onPlanned?.({ repoPath: '/repo', branch: 'ut/half', worktreePath: '/wt/half' });
          return hang;
        },
        remove: async () => hang,
        commitLeftovers: async () => false,
        changes: async () => ({
          files: [],
          stats: { commits: 0, files: 0, insertions: 0, deletions: 0 },
        }),
        hasUnmergedWork: async () => false,
      },
    });
    await first.start(0);
    const created = await first.create(plain);
    await sleep(5);
    first.stop();
    // Killed again while the next server removes it: the step is still there.
    const removing = make(store, world, undefined, {
      worktrees: {
        ...(first as unknown as { worktrees: TaskWorktrees }).worktrees,
        remove: async () => hang,
      },
      setupRetryMs: 60_000,
    });
    await removing.start(0);
    await sleep(5);
    removing.stop();
    const effects = () =>
      (JSON.parse(fs.readFileSync(store, 'utf8')).tasks as TaskRecord[]).find(
        (t) => t.id === created.id
      )?.effects;
    expect(effects()).toEqual([
      expect.objectContaining({ kind: 'worktree', worktreePath: '/wt/half' }),
    ]);
    // The third one removes it and only then forgets it.
    const removed: string[] = [];
    // (Its worktree made the usual way: it starts over once the half-made one went.)
    const third = make(store, world, undefined, { setupRetryMs: 60_000 });
    withWorktrees(third).remove = async (t) => {
      removed.push(t.worktreePath as string);
      return { worktreeRemoved: true, branchDeleted: true };
    };
    await third.start(0);
    await third.settled();
    third.stop();
    expect(removed).toEqual(['/wt/half']);
    expect(effects()).toBeUndefined();
    expect(third.get(created.id)?.state).toBe('working');
  });

  /** A worktree step that hangs right after `git worktree add` made its folder. */
  const hangingCreate =
    (world: World): TaskWorktrees['create'] =>
    async (_task, setup) => {
      const worktreePath = `/wt/${world.made + 1}`;
      setup.onPlanned?.({ repoPath: '/repo', branch: 'ut/journal', worktreePath });
      world.made++;
      world.worktrees.push(worktreePath);
      return new Promise<never>(() => {});
    };
  const stored = (store: string, id: string) =>
    (JSON.parse(fs.readFileSync(store, 'utf8')).tasks as TaskRecord[]).find((t) => t.id === id);

  it('cut while its worktree is made: the half-made one goes and it starts over by itself, not told as failed (2026-11-02)', async () => {
    const dir = newDir();
    const store = path.join(dir, 'tasks.json');
    const world = emptyWorld();
    const first = make(store, world);
    withWorktrees(first).create = hangingCreate(world);
    await first.start(0);
    const created = await first.create(plain);
    await sleep(5);
    first.stop();
    expect(stored(store, created.id)?.state).toBe('preparing');
    expect(world.worktrees).toEqual(['/wt/1']);

    const second = make(store, world);
    await second.start(0);
    const task = await drive(second, world, created.id);
    second.stop();
    expect(task?.state).toBe('merged');
    // The half-made folder went, one new one was made and used, one session, one brief.
    expect(world.made).toBe(2);
    expect(world.worktrees).toEqual([]);
    expect(world.launches).toHaveLength(1);
    expect(world.typed).toEqual(world.launches);
    // Nothing was told about the cut: only the merge.
    expect(world.pushes).toEqual(['task-merged']);
    expect(task?.startCuts).toBeUndefined();
    expect(task?.error).toBeUndefined();
  });

  it('cut after its worktree, before its session: that worktree goes, a fresh one and one session (2026-11-02)', async () => {
    const dir = newDir();
    const store = path.join(dir, 'tasks.json');
    const world = emptyWorld();
    // Its session is never made: the server stops while the agent is being started.
    const first = make(store, world, undefined, { launch: () => new Promise(() => {}) });
    await first.start(0);
    const created = await first.create(plain);
    for (let i = 0; i < 20 && !stored(store, created.id)?.worktreePath; i++) await sleep(5);
    first.stop();
    const before = stored(store, created.id) as TaskRecord;
    expect(before).toMatchObject({ state: 'preparing', worktreePath: '/wt/1' });
    expect(before.sessionId).toBeUndefined();
    expect(world.launches).toEqual([]);

    const removed: string[] = [];
    const second = make(store, world);
    const remove = withWorktrees(second).remove;
    withWorktrees(second).remove = async (t, options) => {
      removed.push(t.worktreePath as string);
      return remove(t, options);
    };
    await second.start(0);
    const task = await drive(second, world, created.id);
    second.stop();
    expect(task?.state).toBe('merged');
    // The unused worktree was removed once, before the new one was made.
    expect(removed[0]).toBe('/wt/1');
    expect(removed.filter((p) => p === '/wt/1')).toHaveLength(1);
    expect(world.made).toBe(2);
    expect(world.worktrees).toEqual([]);
    expect(world.launches).toHaveLength(1);
    expect(world.typed).toEqual(world.launches);
    expect(world.pushes).toEqual(['task-merged']);
  });

  it('cut while removing the unused worktree: the next server removes it once and starts once (2026-11-02)', async () => {
    const dir = newDir();
    const store = path.join(dir, 'tasks.json');
    const world = emptyWorld();
    const first = make(store, world, undefined, { launch: () => new Promise(() => {}) });
    await first.start(0);
    const created = await first.create(plain);
    for (let i = 0; i < 20 && !stored(store, created.id)?.worktreePath; i++) await sleep(5);
    first.stop();
    // The second server is cut while it removes /wt/1: its step is still on disk.
    const second = make(store, world);
    withWorktrees(second).remove = () => new Promise(() => {});
    await second.start(0);
    await sleep(5);
    second.stop();
    // Starting over already (preparing), behind the removal: its new worktree waits for it.
    expect(stored(store, created.id)).toMatchObject({
      state: 'preparing',
      startCuts: 1,
      effects: [expect.objectContaining({ kind: 'worktree', worktreePath: '/wt/1' })],
    });
    const third = make(store, world);
    await third.start(0);
    const task = await drive(third, world, created.id);
    third.stop();
    expect(task?.state).toBe('merged');
    expect(world.made).toBe(2);
    expect(world.worktrees).toEqual([]);
    expect(world.launches).toHaveLength(1);
    expect(world.pushes).toEqual(['task-merged']);
  });

  it('cut again while starting over, before it left scheduled: started, never missed for its old runAt (2026-11-02 review)', async () => {
    const dir = newDir();
    const store = path.join(dir, 'tasks.json');
    const world = emptyWorld();
    const first = make(store, world);
    withWorktrees(first).create = hangingCreate(world);
    await first.start(0);
    const created = await first.create(plain);
    await sleep(5);
    first.stop();
    // The next server put it back to scheduled and was cut while it waited for its slot
    // (git answering), long after its runAt.
    const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
    const cut = saved.tasks.find((t: TaskRecord) => t.id === created.id);
    cut.state = 'scheduled';
    cut.startCuts = 1;
    cut.runAt = new Date(Date.now() - 24 * 3_600_000).toISOString();
    fs.writeFileSync(store, JSON.stringify(saved));
    const second = make(store, world);
    await second.start(0);
    const task = await drive(second, world, created.id);
    second.stop();
    expect(task?.state).toBe('merged');
    expect(world.launches).toHaveLength(1);
    expect(world.worktrees).toEqual([]);
    expect(world.pushes).toEqual(['task-merged']);
  });

  it('cut while starting more times in a row than TASK_START_CUTS_MAX: failed with the reason, told once (2026-11-02)', async () => {
    const dir = newDir();
    const store = path.join(dir, 'tasks.json');
    const world = emptyWorld();
    const first = make(store, world);
    withWorktrees(first).create = hangingCreate(world);
    await first.start(0);
    const created = await first.create(plain);
    await sleep(5);
    first.stop();
    for (let cut = 1; cut <= TASK_START_CUTS_MAX; cut++) {
      const next = make(store, world, undefined, { setupRetryMs: 60_000 });
      withWorktrees(next).create = hangingCreate(world);
      await next.start(0);
      await sleep(5);
      next.stop();
      expect(stored(store, created.id)).toMatchObject({ state: 'preparing', startCuts: cut });
      expect(world.pushes).toEqual([]);
    }
    const last = make(store, world, undefined, { setupRetryMs: 60_000 });
    await last.start(0);
    await last.settled();
    last.stop();
    expect(last.get(created.id)).toMatchObject({
      state: 'failed',
      blocker: { kind: 'setup' },
      error: `The server stopped while the task was starting, ${TASK_START_CUTS_MAX + 1} times in a row`,
    });
    expect(world.pushes).toEqual(['task-failed']);
    // Every half-made folder went; none was made by the last server.
    expect(world.made).toBe(TASK_START_CUTS_MAX + 1);
    expect(world.worktrees).toEqual([]);
    expect(world.launches).toEqual([]);
  });

  it('no session is made when its step cannot be saved (2026-11-01 review)', async () => {
    const dir = newDir();
    const store = path.join(dir, 'tasks.json');
    const world = emptyWorld();
    const scheduler = make(store, world, undefined, { setupRetryMs: 60_000 });
    await scheduler.start(0);
    // As when tasks.json can be neither read nor kept aside (or the disk is full).
    (scheduler as unknown as { saveBlocked: boolean }).saveBlocked = true;
    const created = await scheduler.create(plain);
    await scheduler.settled();
    expect(world.launches).toEqual([]);
    expect(scheduler.get(created.id)).toMatchObject({
      state: 'failed',
      blocker: { kind: 'setup' },
    });
  });
  it('a push resent after a kill between its send and the write carries the same tag and id (at least once, 2026-11-02)', async () => {
    const dir = newDir();
    const store = path.join(dir, 'tasks.json');
    const world = emptyWorld();
    const sent: NotificationPayload[] = [];
    let killedDisk: string | null = null;
    // SIGKILL right after the push left: tasks.json still holds it in its outbox.
    const notify = (payload: NotificationPayload) => {
      sent.push(payload);
      if (killedDisk === null) killedDisk = fs.readFileSync(store, 'utf8');
    };
    const ready = async (): Promise<PipelineResult> => ({ state: 'ready', headSha: HEAD });
    const first = make(store, world, undefined, { pipeline: ready, notify });
    await first.start(0);
    const created = await first.create({ ...plain, mergePolicy: 'ask' });
    for (let i = 0; i < 20 && !world.typed.length; i++) await sleep(5);
    await first.markDone(first.get(created.id)?.sessionId as string, 'hecho');
    await first.settled();
    first.stop();
    expect(sent.map((p) => p.type)).toEqual(['task-ready']);
    expect(JSON.parse(killedDisk as unknown as string).outbox).toHaveLength(1);
    const again = newDir();
    const againStore = path.join(again, 'tasks.json');
    fs.writeFileSync(againStore, killedDisk as unknown as string);
    const second = make(againStore, world, undefined, { pipeline: ready, notify });
    await second.start(0);
    await second.settled();
    second.stop();
    // Sent again (no outside send is exactly once), as the same push: the phone replaces it
    // (same tag) and the orchestrator ignores it (same pushId, orchestrator.test.ts).
    expect(sent).toHaveLength(2);
    const [one, two] = sent;
    expect(one.data?.pushId).toEqual(expect.any(String));
    expect(two.data?.pushId).toBe(one.data?.pushId);
    expect(one.tag).toBe(`untether-push-${one.data?.pushId}`);
    expect(two.tag).toBe(one.tag);
    expect(JSON.parse(fs.readFileSync(againStore, 'utf8')).outbox).toBeUndefined();
  });
});

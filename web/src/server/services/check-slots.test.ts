/**
 * Check slots for runs agents and scripts start (2026-11-10): they stand in the same limiter
 * as the merge pipeline's verification runs, wait while the Mac is over its load, and free
 * their slot when their holder ends.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { CheckResults } from './check-results.js';
import {
  CheckSlots,
  type CheckSlotView,
  PLACE_KEPT_MS,
  WAITING_SILENCE_MS,
} from './check-slots.js';
import { createLimiter, createLoadGate, type Limiter } from './task-verify.js';

const tick = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('CheckSlots', () => {
  let alive: Set<number>;
  let load: number;
  let limiter: Limiter;
  let slots: CheckSlots;
  let dir: string;

  const gate = () =>
    createLoadGate({
      settings: () => ({
        maxLoadPerCore: 2,
        maxWaitSec: 600,
        maxConcurrent: 1,
        maxSlotWaitSec: 1800,
      }),
      loadavg: () => load,
      cores: () => 12,
      pollMs: 1000,
    });

  const make = (file?: string) =>
    new CheckSlots({
      limiter,
      gate: gate(),
      maxWaitSec: () => 1800,
      pidAlive: (pid) => alive.has(pid),
      ...(file ? { file } : {}),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 10, 12, 0));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-check-slots-'));
    alive = new Set([100, 200, 300]);
    load = 3;
    limiter = createLimiter(1, gate());
    slots = make();
  });

  afterEach(() => {
    slots.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('one runs, the next waits its turn and says how many are ahead; a release lets it in', async () => {
    const a = slots.acquire({ pid: 100, label: 'pnpm test', taskId: 'task-a' });
    await tick();
    expect(slots.status(a.id)).toMatchObject({ state: 'running', ahead: 0, running: 1, limit: 1 });
    vi.advanceTimersByTime(10);
    const b = slots.acquire({ pid: 200, label: 'pnpm test', taskId: 'task-b' });
    vi.advanceTimersByTime(10);
    const c = slots.acquire({ pid: 300, label: 'scripts/check.sh', cwd: '/repo' });
    await tick();
    expect(slots.status(b.id)).toMatchObject({ state: 'waiting', ahead: 0, running: 1 });
    expect(slots.status(c.id)).toMatchObject({ state: 'waiting', ahead: 1, running: 1 });

    expect(slots.release(a.id)).toBe(true);
    await tick();
    expect(slots.status(a.id)).toBeUndefined();
    expect(slots.status(b.id)?.state).toBe('running');
    expect(slots.status(c.id)).toMatchObject({ state: 'waiting', ahead: 0 });
  });

  it("shares the slot with the merge pipeline's verification runs, in both directions", async () => {
    // A verification run of Untether's holds the only slot: the agent's run waits for it.
    let endVerify = () => {};
    const verify = limiter.run(() => new Promise<void>((resolve) => (endVerify = resolve)));
    await tick();
    const agent = slots.acquire({ pid: 100, label: 'pnpm test', taskId: 'task-a' });
    await tick();
    expect(slots.status(agent.id)).toMatchObject({ state: 'waiting', running: 1 });
    endVerify();
    await verify;
    await tick();
    expect(slots.status(agent.id)?.state).toBe('running');

    // And while the agent's run holds it, a verification run does not start.
    const started = vi.fn();
    const second = limiter.run(async () => undefined, started);
    await tick();
    expect(started).not.toHaveBeenCalled();
    expect(limiter.queued).toBe(1);
    slots.release(agent.id);
    await second;
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('with the Mac over checkLoad the run waits instead of starting, and says why; it starts when the load drops', async () => {
    load = 250;
    const a = slots.acquire({ pid: 100, label: 'pnpm test' });
    await tick();
    expect(slots.status(a.id)).toMatchObject({
      state: 'waiting',
      running: 0,
      busy: { load: 250, threshold: 24 },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(slots.status(a.id)?.state).toBe('waiting');
    // The one behind it waits for its turn, not for the load: it is told how many are ahead.
    const b = slots.acquire({ pid: 200, label: 'pnpm test' });
    expect(slots.status(b.id)).toMatchObject({ state: 'waiting', ahead: 1 });
    expect(slots.status(b.id)?.busy).toBeUndefined();
    slots.release(b.id);
    load = 10;
    await vi.advanceTimersByTimeAsync(1500);
    const view = slots.status(a.id);
    expect(view?.state).toBe('running');
    expect(view?.busy).toBeUndefined();
  });

  it('under a load that never drops it starts anyway after checkLoad.maxWaitSec', async () => {
    load = 250;
    const a = slots.acquire({ pid: 100, label: 'pnpm test' });
    for (let i = 0; i < 61; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      slots.status(a.id); // its holder keeps asking
    }
    expect(slots.status(a.id)?.state).toBe('running');
  });

  it('a holder that is gone frees its slot; a waiting one nobody asks about leaves the line', async () => {
    const a = slots.acquire({ pid: 100, label: 'pnpm test' });
    const b = slots.acquire({ pid: 200, label: 'pnpm test' });
    const c = slots.acquire({ pid: 300, label: 'pnpm test' });
    await tick();
    // b's caller stops asking (killed); c keeps asking.
    for (let waited = 0; waited <= WAITING_SILENCE_MS; waited += 5000) {
      await vi.advanceTimersByTimeAsync(5000);
      slots.status(c.id);
      slots.sweep();
    }
    expect(slots.status(b.id)).toBeUndefined();
    expect(slots.status(c.id)).toMatchObject({ state: 'waiting', ahead: 0 });
    // a's shell died without releasing (an `exit` in its command, a timeout).
    alive.delete(100);
    slots.sweep();
    await tick();
    expect(slots.status(a.id)).toBeUndefined();
    expect(slots.status(c.id)?.state).toBe('running');
  });

  it('a wait cut short keeps its place: the same run asked again goes back in front', async () => {
    const a = slots.acquire({ pid: 100, label: 'pnpm test', taskId: 'task-a' });
    vi.advanceTimersByTime(1000);
    const b = slots.acquire({ pid: 200, label: 'pnpm test', taskId: 'task-b' });
    vi.advanceTimersByTime(1000);
    const c = slots.acquire({ pid: 300, label: 'pnpm test', taskId: 'task-c' });
    await tick();
    // b's Bash call timed out while it waited.
    slots.release(b.id, { keepPlace: true });
    expect(slots.status(c.id)).toMatchObject({ ahead: 0 });
    vi.advanceTimersByTime(20_000);
    const again = slots.acquire({ pid: 200, label: 'pnpm test', taskId: 'task-b' });
    expect(again.since).toBe(b.since);
    expect(slots.status(again.id)).toMatchObject({ state: 'waiting', ahead: 0 });
    expect(slots.status(c.id)).toMatchObject({ ahead: 1 });
    slots.release(a.id);
    await tick();
    expect(slots.status(again.id)?.state).toBe('running');

    // A place is not kept for ever.
    slots.release(c.id, { keepPlace: true });
    vi.advanceTimersByTime(PLACE_KEPT_MS + 1000);
    slots.sweep();
    const late = slots.acquire({ pid: 300, label: 'pnpm test', taskId: 'task-c' });
    expect(late.since).toBeGreaterThan(c.since);
  });

  it('a caller cannot jump the line with a `since` of its own: it counts at most the longest wait back', async () => {
    const a = slots.acquire({ pid: 100, label: 'a' });
    vi.advanceTimersByTime(5000);
    const b = slots.acquire({ pid: 200, label: 'b' });
    vi.advanceTimersByTime(5000);
    const cheat = slots.acquire({ pid: 300, label: 'c', since: 0 });
    expect(cheat.since).toBe(Date.now() - 1800_000);
    // An honest one (a server restart: it joined a minute ago) keeps what it says.
    slots.release(cheat.id);
    const honest = slots.acquire({ pid: 300, label: 'd', since: Date.now() - 60_000 });
    expect(honest.since).toBe(Date.now() - 60_000);
    expect(slots.status(b.id)).toMatchObject({ state: 'waiting', ahead: 1 });
    slots.release(a.id);
  });

  it("tells the scheduler when a task's agent waits and when that wait ended", async () => {
    const a = slots.acquire({ pid: 100, label: 'pnpm test', taskId: 'task-a' });
    await tick();
    expect(slots.taskWait('task-a').waiting).toBe(false);
    const b = slots.acquire({ pid: 200, label: 'pnpm test', taskId: 'task-b' });
    await tick();
    expect(slots.taskWait('task-b')).toEqual({ waiting: true });
    vi.advanceTimersByTime(120_000);
    slots.status(b.id);
    slots.release(a.id);
    await tick();
    expect(slots.taskWait('task-b')).toEqual({ waiting: false, endedAt: Date.now() });
    expect(slots.taskWait('nobody')).toEqual({ waiting: false });
  });

  it('over the socket: acquire, status, release, list; a bad request is refused', async () => {
    const got = await slots.handle({ action: 'acquire', pid: 100, label: 'pnpm test' });
    expect(got).toMatchObject({ ok: true, status: 'done' });
    const id = (got as { data: { id: string } }).data.id;
    await tick();
    expect(await slots.handle({ action: 'status', id })).toMatchObject({
      ok: true,
      data: { state: 'running', maxWaitSec: 1800 },
    });
    expect(await slots.handle({ action: 'list' })).toMatchObject({
      ok: true,
      data: { running: 1, limit: 1, tickets: [{ id, pid: 100, state: 'running' }] },
    });
    expect(await slots.handle({ action: 'release', id })).toMatchObject({
      data: { released: true },
    });
    expect(await slots.handle({ action: 'status', id })).toMatchObject({
      ok: false,
      code: 'not-found',
    });
    expect(await slots.handle({ action: 'acquire', label: 'x' })).toMatchObject({
      ok: false,
      code: 'bad-request',
    });
    expect(await slots.handle({ action: 'explode', id: 'x' })).toMatchObject({ ok: false });
  });

  describe('a check that passed on the very same files is not run again (2026-11-11)', () => {
    let tree: string;
    let lock: string;
    let results: CheckResults;
    let runs: Array<{ taskId?: string; label: string; ms: number; reusedMs?: number }>;
    const check = (pid: number, extra: Record<string, unknown> = {}) =>
      slots.handle({
        action: 'acquire',
        pid,
        label: 'pnpm test',
        cwd: '/repo',
        command: 'pnpm run test',
        ...extra,
      }) as Promise<{ ok: true; data: CheckSlotView }>;
    const stateOf = (id: string) => slots.status(id)?.state;

    beforeEach(() => {
      tree = 'a'.repeat(40);
      lock = 'l1';
      results = new CheckResults();
      runs = [];
      slots = new CheckSlots({
        limiter,
        gate: gate(),
        maxWaitSec: () => 1800,
        pidAlive: (pid) => alive.has(pid),
        results,
        identify: async () => ({ tree, lock, dir: '' }),
        onRun: (run) => runs.push(run),
      });
    });

    it('a pass is kept, and the same check on the same files is told so at once: no slot, no run', async () => {
      const first = (await check(100, { taskId: 'task-a' })).data;
      await tick();
      expect(stateOf(first.id)).toBe('running');
      await vi.advanceTimersByTimeAsync(278_000);
      slots.release(first.id, { exitCode: 0 });
      await slots.settled();
      expect(results.find({ tree, lock, dir: '' }, 'pnpm run test', 'shell')).toMatchObject({
        ms: 278_000,
        taskId: 'task-a',
      });
      expect(runs).toEqual([{ taskId: 'task-a', label: 'pnpm test', ms: 278_000 }]);

      const again = (await check(200, { taskId: 'task-a' })).data;
      expect(again).toMatchObject({
        state: 'reused',
        reused: { ms: 278_000, tree },
      });
      expect(limiter.active).toBe(0);
      expect(slots.summary().tickets).toEqual([]);
      expect(runs[1]).toEqual({ taskId: 'task-a', label: 'pnpm test', ms: 0, reusedMs: 278_000 });
    });

    it('files that differ by one byte, other lockfiles, another command or another folder: it runs', async () => {
      const first = (await check(100)).data;
      await tick();
      slots.release(first.id, { exitCode: 0 });
      await slots.settled();

      tree = `${'a'.repeat(39)}b`;
      const edited = (await check(200)).data;
      await tick();
      expect(stateOf(edited.id)).toBe('running');
      slots.release(edited.id);
      tree = 'a'.repeat(40);

      lock = 'l2';
      const deps = (await check(200)).data;
      await tick();
      expect(stateOf(deps.id)).toBe('running');
      slots.release(deps.id);
      lock = 'l1';

      const other = (await check(200, { command: 'pnpm run test --coverage' })).data;
      await tick();
      expect(stateOf(other.id)).toBe('running');
      slots.release(other.id);

      // Unchanged, the first one still stands.
      expect((await check(300)).data.state).toBe('reused');
    });

    it('a failed run is never kept, nor one whose exit code nobody told', async () => {
      const failed = (await check(100)).data;
      await tick();
      slots.release(failed.id, { exitCode: 1 });
      const unknown = (await check(100)).data;
      await tick();
      expect(unknown.state).not.toBe('reused');
      slots.release(unknown.id);
      // Its holder died (a timeout): no result either.
      const cut = (await check(100)).data;
      await tick();
      alive.delete(100);
      slots.sweep();
      await slots.settled();
      expect(results.size).toBe(0);
      const next = (await check(200)).data;
      await tick();
      expect(stateOf(next.id)).toBe('running');
      expect(cut.id).not.toBe(next.id);
    });

    it('a pass on files that changed while it ran is not kept', async () => {
      const first = (await check(100)).data;
      await tick();
      expect(stateOf(first.id)).toBe('running');
      // The agent (or the check itself) rewrote a file meanwhile.
      tree = 'c'.repeat(40);
      slots.release(first.id, { exitCode: 0 });
      await slots.settled();
      expect(results.size).toBe(0);
    });

    it('the same check twice in line: the second is told at its turn, and its slot goes to the next', async () => {
      const first = (await check(100, { taskId: 'task-a' })).data;
      await tick();
      const second = (await check(200, { taskId: 'task-b' })).data;
      const third = slots.acquire({ pid: 300, label: 'something else' });
      await tick();
      expect(second.state).toBe('waiting');
      expect(slots.taskWait('task-b').waiting).toBe(true);
      slots.release(first.id, { exitCode: 0 });
      await slots.settled();
      await tick();
      expect(slots.taskWait('task-b')).toMatchObject({ waiting: false });
      expect(stateOf(third.id)).toBe('running');
      // Told once; then nothing is left of it.
      expect(slots.status(second.id)).toMatchObject({ state: 'reused', reused: { tree } });
      expect(slots.status(second.id)).toBeUndefined();
      expect(runs.filter((run) => run.reusedMs !== undefined)).toHaveLength(1);
    });

    it('the files are read again at its turn: edited while it waited, it runs on what is there then', async () => {
      const first = (await check(100)).data;
      await tick();
      slots.release(first.id, { exitCode: 0 });
      await slots.settled();
      // In line behind a run of something else, and edited while it waits.
      const other = slots.acquire({ pid: 100, label: 'something else' });
      await tick();
      tree = 'd'.repeat(40);
      const waiting = (await check(300)).data;
      await tick();
      expect(waiting.state).toBe('waiting');
      slots.release(other.id);
      await tick();
      expect(stateOf(waiting.id)).toBe('running');
      // Its pass is of the tree it started on.
      slots.release(waiting.id, { exitCode: 0 });
      await slots.settled();
      expect(results.find({ tree, lock, dir: '' }, 'pnpm run test', 'shell')).toBeDefined();
    });

    it("stands on a pass of Untether's own verification; a run that never said what it is neither reuses nor keeps", async () => {
      results.record({ tree, lock, dir: '', command: 'pnpm run test', runner: 'untether', ms: 9 });
      expect((await check(100)).data.state).toBe('reused');
      const plain = (
        (await slots.handle({
          action: 'acquire',
          pid: 100,
          label: 'pnpm run test',
          cwd: '/repo',
        })) as {
          data: CheckSlotView;
        }
      ).data;
      await tick();
      expect(stateOf(plain.id)).toBe('running');
      slots.release(plain.id, { exitCode: 0 });
      await slots.settled();
      expect(results.size).toBe(1);
    });

    it('git that cannot answer never keeps a run from happening', async () => {
      slots = new CheckSlots({
        limiter,
        pidAlive: (pid) => alive.has(pid),
        results,
        identify: async () => {
          throw new Error('not a git repository');
        },
      });
      const run = (await check(100)).data;
      await tick();
      expect(stateOf(run.id)).toBe('running');
      slots.release(run.id, { exitCode: 0 });
      await slots.settled();
      expect(results.size).toBe(0);
    });
  });

  it('a server restart: a run that still holds its slot is counted again, a dead one is not', async () => {
    const file = path.join(dir, 'check-slots.json');
    slots = make(file);
    const a = slots.acquire({ pid: 100, label: 'pnpm test', taskId: 'task-a' });
    await tick();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject([{ id: a.id, pid: 100 }]);

    // The server starts again: a new limiter, the same file.
    limiter = createLimiter(1, gate());
    slots = make(file);
    await tick();
    expect(limiter.active).toBe(1);
    expect(slots.status(a.id)?.state).toBe('running');
    const b = slots.acquire({ pid: 200, label: 'pnpm test' });
    await tick();
    expect(slots.status(b.id)?.state).toBe('waiting');
    slots.release(a.id);
    await tick();
    expect(slots.status(b.id)?.state).toBe('running');
    slots.release(b.id);
    expect(fs.existsSync(file)).toBe(false);

    // One whose holder died while the server was down is not taken up.
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: 'dead', pid: 999, label: 'x', key: 'k', since: 1, startedAt: Date.now() },
      ])
    );
    limiter = createLimiter(1, gate());
    slots = make(file);
    await tick();
    expect(limiter.active).toBe(0);
    expect(slots.status('dead')).toBeUndefined();
  });
});

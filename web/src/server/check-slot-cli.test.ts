/**
 * `ut check-slot`: waits its turn in the Mac's check slots and says so, and never keeps a run
 * from happening (no server, an older one, a wait past the limit).
 */
import { describe, expect, it, vi } from 'vitest';
import { type CheckSlotCliDeps, runCheckSlotCli, waitingLine } from './check-slot-cli.js';
import type { TaskResponse } from './pty/socket-protocol.js';
import { CHECK_SLOT_ENV, SLOT_REUSED_EXIT } from './services/check-slot-wrap.js';
import type { CheckSlotView } from './services/check-slots.js';

const view = (overrides: Partial<CheckSlotView> = {}): CheckSlotView => ({
  id: 'T1',
  state: 'running',
  ahead: 0,
  running: 1,
  limit: 2,
  since: 1000,
  maxWaitSec: 1800,
  ...overrides,
});
const done = (data: object): TaskResponse => ({
  ok: true,
  status: 'done',
  data: data as Record<string, unknown>,
});

function harness(answers: Array<TaskResponse | Error>, extra: Partial<CheckSlotCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: Array<Record<string, unknown>> = [];
  let now = 0;
  const spawn = vi.fn(async () => 0);
  const deps: CheckSlotCliDeps = {
    task: async (op, args) => {
      expect(op).toBe('check-slot');
      asked.push(args);
      const next = answers.shift();
      if (!next) return done({ released: true });
      if (next instanceof Error) throw next;
      return next;
    },
    env: { UNTETHER_TASK_ID: 'task-1' },
    cwd: '/repo',
    pid: 500,
    ppid: 400,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    spawn,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    ...extra,
  };
  return { deps, out, err, asked, spawn };
}

describe('ut check-slot', () => {
  it('run: a free slot is taken at once, quietly; the command runs with the ticket and the slot is given back', async () => {
    const { deps, err, asked, spawn } = harness([done(view())]);
    spawn.mockResolvedValueOnce(7);
    expect(await runCheckSlotCli(['run', '--', 'pnpm', 'test'], deps)).toBe(7);
    expect(asked[0]).toMatchObject({
      action: 'acquire',
      pid: 500,
      label: 'pnpm test',
      taskId: 'task-1',
      cwd: '/repo',
    });
    expect(spawn).toHaveBeenCalledWith(
      ['pnpm', 'test'],
      expect.objectContaining({ [CHECK_SLOT_ENV]: 'T1' })
    );
    // How it ended goes with the release (a pass may be kept).
    expect(asked[1]).toEqual({ action: 'release', id: 'T1', exitCode: 7 });
    expect(err).toEqual([]);
  });

  it('run: waits its turn, says how many are ahead and when it got the slot', async () => {
    const { deps, err, spawn } = harness([
      done(view({ state: 'waiting', ahead: 2, running: 2 })),
      done(view({ state: 'waiting', ahead: 2, running: 2 })),
      done(view({ state: 'waiting', ahead: 1, running: 2 })),
      done(view({ state: 'waiting', ahead: 0, running: 0, busy: { load: 250, threshold: 24 } })),
      done(view()),
    ]);
    expect(await runCheckSlotCli(['run', '--', 'scripts/check.sh --all'], deps)).toBe(0);
    expect(err[0]).toMatch(
      /^\[untether\] waiting for a check slot: 2 ahead \(2 of 2 running\)\. .*keeps its place in line/
    );
    expect(err[1]).toBe(
      '[untether] waiting for a check slot: 1 ahead (2 of 2 running) · 4 s so far'
    );
    expect(err[2]).toBe(
      "[untether] waiting for a check slot: the Mac's load is 250, over 24 · 6 s so far"
    );
    expect(err[3]).toBe('[untether] check slot taken after 8 s');
    // One argument is a shell command line.
    expect(spawn).toHaveBeenCalledWith(
      ['/bin/sh', '-c', 'scripts/check.sh --all'],
      expect.anything()
    );
  });

  it('run: past --max-wait it runs without a slot, says so, and keeps its place', async () => {
    const waiting = () => done(view({ state: 'waiting', ahead: 3, running: 2 }));
    const { deps, err, asked, spawn } = harness(Array.from({ length: 40 }, waiting));
    expect(await runCheckSlotCli(['run', '--max-wait', '10', '--', 'pnpm', 'test'], deps)).toBe(0);
    expect(err.at(-1)).toBe(
      '[untether] no check slot (still none after 10 s): running without one'
    );
    expect(asked.find((args) => args.action === 'release')).toEqual({
      action: 'release',
      id: 'T1',
      keepPlace: true,
    });
    const [, env] = spawn.mock.calls[0] as unknown as [string[], Record<string, string>];
    expect(env[CHECK_SLOT_ENV]).toBeUndefined();
  });

  it('run: without a server, or with one that does not know check slots, the command still runs', async () => {
    const down = harness([new Error('Untether server is not running')]);
    expect(await runCheckSlotCli(['run', '--', 'pnpm', 'test'], down.deps)).toBe(0);
    expect(down.spawn).toHaveBeenCalledTimes(1);
    expect(down.err[0]).toBe(
      '[untether] no check slot (Untether server is not running): running without one'
    );
    const old = harness([{ ok: false, code: 'bad-request', message: 'unknown op: check-slot' }]);
    expect(await runCheckSlotCli(['run', '--', 'pnpm', 'test'], old.deps)).toBe(0);
    expect(old.spawn).toHaveBeenCalledTimes(1);
  });

  it('run: inside a run that holds a slot already nothing is asked for', async () => {
    const { deps, asked, spawn } = harness([], { env: { [CHECK_SLOT_ENV]: 'verify' } });
    expect(await runCheckSlotCli(['run', '--', 'pnpm', 'test'], deps)).toBe(0);
    expect(asked).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('run: a server restart while it waits puts it back in line where it was', async () => {
    const { deps, asked } = harness([
      done(view({ state: 'waiting', ahead: 1, since: 1234 })),
      { ok: false, code: 'not-found', message: 'No such check slot ticket' },
      done(view({ id: 'T2', state: 'running', since: 1234 })),
    ]);
    expect(await runCheckSlotCli(['run', '--', 'pnpm', 'test'], deps)).toBe(0);
    expect(asked[2]).toMatchObject({ action: 'acquire', since: 1234 });
    expect(asked.at(-1)).toEqual({ action: 'release', id: 'T2', exitCode: 0 });
  });

  it('run: interrupted while waiting it leaves the line, keeps its place and runs nothing', async () => {
    let interrupted = false;
    const { deps, asked, spawn } = harness(
      [done(view({ state: 'waiting', ahead: 1 })), done(view({ state: 'waiting', ahead: 1 }))],
      { interrupted: () => interrupted }
    );
    deps.sleep = async () => {
      interrupted = true;
    };
    expect(await runCheckSlotCli(['run', '--', 'pnpm', 'test'], deps)).toBe(130);
    expect(spawn).not.toHaveBeenCalled();
    expect(asked.at(-1)).toEqual({ action: 'release', id: 'T1', keepPlace: true });
  });

  it('acquire: the holder is the calling shell (or --pid); the ticket goes to stdout, the wait to stderr', async () => {
    const mine = harness([done(view({ state: 'waiting', ahead: 1 })), done(view())]);
    expect(await runCheckSlotCli(['acquire', '--label', 'pnpm test'], mine.deps)).toBe(0);
    expect(mine.asked[0]).toMatchObject({ pid: 400, label: 'pnpm test' });
    expect(mine.out).toEqual(['T1']);
    expect(mine.err.length).toBeGreaterThan(0);
    const given = harness([done(view())]);
    await runCheckSlotCli(['acquire', '--pid', '777'], given.deps);
    expect(given.asked[0]).toMatchObject({ pid: 777 });
    // No slot: nothing on stdout, exit 0 (the shell runs its command anyway).
    const none = harness([new Error('Untether server is not running')]);
    expect(await runCheckSlotCli(['acquire'], none.deps)).toBe(0);
    expect(none.out).toEqual([]);
  });

  it('release: gives the ticket back; without one (no slot was taken) it does nothing', async () => {
    const { deps, asked } = harness([]);
    expect(await runCheckSlotCli(['release', 'T1'], deps)).toBe(0);
    expect(asked).toEqual([{ action: 'release', id: 'T1' }]);
    const none = harness([]);
    expect(await runCheckSlotCli(['release'], none.deps)).toBe(0);
    expect(none.asked).toEqual([]);
  });

  it('release --exit: how the run ended goes to the server', async () => {
    const { deps, asked } = harness([]);
    expect(await runCheckSlotCli(['release', 'T1', '--exit', '0'], deps)).toBe(0);
    expect(asked).toEqual([{ action: 'release', id: 'T1', exitCode: 0 }]);
  });

  describe('a check that passed on the very same files', () => {
    const reused = () =>
      done(
        view({
          id: 'T1',
          state: 'reused',
          reused: { at: -600_000, ms: 278_000, tree: 'abc123def4567890' },
        })
      );

    it('run: a test run says what it is; reused, it is not run, says so and ends with 0', async () => {
      const { deps, err, asked, spawn } = harness([reused()]);
      expect(await runCheckSlotCli(['run', '--', 'cd web && pnpm run test'], deps)).toBe(0);
      expect(asked[0]).toMatchObject({ action: 'acquire', command: 'cd web && pnpm run test' });
      expect(spawn).not.toHaveBeenCalled();
      expect(asked).toHaveLength(1);
      expect(err.join('\n')).toMatch(
        /check: reused, same tree as 1969-12-31T23:50:00\.000Z \(10 min ago; it passed in 5 min on these very files, tree abc123def456\): not run again/
      );
      expect(err.join('\n')).toContain('--fresh');
    });

    it('run: the words of a command are one check too', async () => {
      const { deps, asked, spawn } = harness([reused()]);
      expect(await runCheckSlotCli(['run', '--', 'pnpm', 'run', 'test'], deps)).toBe(0);
      expect(asked[0]).toMatchObject({ command: 'pnpm run test' });
      expect(spawn).not.toHaveBeenCalled();
    });

    it('run --fresh, and a command that is more than a check: nothing is asked to be reused', async () => {
      const fresh = harness([done(view())]);
      await runCheckSlotCli(['run', '--fresh', '--', 'pnpm run test'], fresh.deps);
      expect(fresh.asked[0]).not.toHaveProperty('command');
      expect(fresh.spawn).toHaveBeenCalled();
      for (const line of [
        'pnpm run test && git commit -m done',
        'pnpm run test | tail -5',
        'pnpm run test; echo over',
        'pnpm run test > out.log',
        'make deploy',
      ]) {
        const more = harness([done(view())]);
        await runCheckSlotCli(['run', '--', line], more.deps);
        expect(more.asked[0], line).not.toHaveProperty('command');
        expect(more.spawn, line).toHaveBeenCalled();
      }
    });

    it('run: a server that says reused to a run that never said what it is is not believed', async () => {
      const { deps, spawn, err } = harness([reused()]);
      expect(await runCheckSlotCli(['run', '--', 'make deploy'], deps)).toBe(0);
      expect(spawn).toHaveBeenCalled();
      expect(err.join('\n')).toContain('running without one');
    });

    it('acquire --command: reused ends with its own exit code and prints no ticket; else the ticket', async () => {
      const kept = harness([reused()]);
      expect(
        await runCheckSlotCli(['acquire', '--pid', '400', '--command', 'pnpm run test'], kept.deps)
      ).toBe(SLOT_REUSED_EXIT);
      expect(kept.asked[0]).toMatchObject({ pid: 400, command: 'pnpm run test' });
      expect(kept.out).toEqual([]);
      expect(kept.err.join('\n')).toContain('check: reused, same tree as');
      const run = harness([done(view())]);
      expect(
        await runCheckSlotCli(['acquire', '--pid', '400', '--command', 'pnpm run test'], run.deps)
      ).toBe(0);
      expect(run.out).toEqual(['T1']);
    });

    it('a waiting check that passed meanwhile elsewhere is told at its turn', async () => {
      const { deps, spawn } = harness([done(view({ state: 'waiting', ahead: 1 })), reused()]);
      expect(await runCheckSlotCli(['run', '--', 'pnpm run test'], deps)).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it('status, usage and help', async () => {
    const { deps, out } = harness([
      done({
        running: 1,
        limit: 2,
        queued: 1,
        tickets: [
          { id: 'T1', pid: 100, taskId: 'abcdef123456', label: 'pnpm test', state: 'running' },
          { id: 'T2', pid: 200, label: 'scripts/check.sh', state: 'waiting' },
        ],
      }),
    ]);
    expect(await runCheckSlotCli(['status'], deps)).toBe(0);
    expect(out[0]).toBe('Check slots: 1 of 2 running, 1 waiting');
    expect(out[1]).toContain('running T1 pid 100 task abcdef12 · pnpm test');
    const bad = harness([]);
    expect(await runCheckSlotCli(['run'], bad.deps)).toBe(1);
    expect(bad.err[0]).toBe('Error: ut check-slot run needs a command after --');
    const help = harness([]);
    expect(await runCheckSlotCli(['--help'], help.deps)).toBe(0);
    expect(help.out[0]).toContain('ut check-slot run');
    // The command's own --help is the command's.
    const own = harness([done(view())]);
    await runCheckSlotCli(['run', '--', 'pnpm', 'test', '--help'], own.deps);
    expect(own.spawn).toHaveBeenCalledWith(['pnpm', 'test', '--help'], expect.anything());
  });

  it('the waiting line', () => {
    expect(waitingLine(view({ state: 'waiting', ahead: 2, running: 2 }))).toBe(
      'waiting for a check slot: 2 ahead (2 of 2 running)'
    );
    expect(
      waitingLine(
        view({ state: 'waiting', ahead: 1, busy: { load: 30, threshold: 24, memory: 'memory' } })
      )
    ).toBe('waiting for a check slot: the Mac is short of memory, 1 ahead');
  });
});

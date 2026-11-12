import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../test/helpers/rm-test-dir.js';
import { formatEvent, runEventsCli } from './events-cli.js';
import type { TaskResponse } from './pty/socket-protocol.js';
import { EventLog, EventQueryError, parseEventQuery } from './services/event-log.js';

describe('ut events', () => {
  let dir: string;
  let log: EventLog;
  let out: string[];
  let err: string[];
  let calls: Array<Record<string, unknown>>;
  /** What the server does with an `events` request (server-tasks.ts eventsOverSocket). */
  let serve: (args: Record<string, unknown>) => Promise<TaskResponse>;

  const serveFrom = async (args: Record<string, unknown>): Promise<TaskResponse> => {
    try {
      const { wait, ...query } = await parseEventQuery(args, async () => null);
      // The long poll is not waited for in tests: a read is enough.
      void wait;
      return { ok: true, status: 'done', data: { ...log.read(query) } };
    } catch (error) {
      if (error instanceof EventQueryError) {
        return { ok: false, code: 'bad-request', message: error.message };
      }
      throw error;
    }
  };
  const run = (argv: string[], extra: { interrupted?: Promise<void> } = {}) =>
    runEventsCli(argv, {
      task: (op, args) => {
        expect(op).toBe('events');
        calls.push(args);
        return serve(args);
      },
      cwd: '/repos/app',
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      sleep: async () => {},
      ...extra,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-events-cli-'));
    log = new EventLog({ dir });
    out = [];
    err = [];
    calls = [];
    serve = serveFrom;
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  it('prints the events after an id as JSON lines and the id to resume from', async () => {
    for (let i = 1; i <= 4; i++)
      log.record({ type: 'task.state', taskId: `t${i}`, state: 'working' });
    expect(await run(['--after', '2', '--json'])).toBe(0);
    expect(out.map((line) => JSON.parse(line).id)).toEqual([3, 4]);
    expect(err).toEqual(['resume: ut events --after 4']);
  });

  it('sends the filters: types (repeated or with commas), project from the cwd, limit', async () => {
    await run(['--type', 'task', '--type=session,push', '--project', 'web', '--limit', '5']);
    expect(calls[0]).toEqual({
      after: 0,
      wait: 0,
      types: ['task', 'session', 'push'],
      project: '/repos/app/web',
      limit: 5,
    });
  });

  it('refuses bad options before asking the server, and passes on its errors', async () => {
    expect(await run(['--after', 'x'])).toBe(1);
    expect(await run(['--bogus'])).toBe(1);
    expect(await run(['--follow', '--limit', '3'])).toBe(1);
    expect(calls).toEqual([]);
    expect(await run(['--type', 'tasks'])).toBe(1);
    expect(err.join('\n')).toContain('unknown event type tasks');
  });

  it('follows through a server restart without losing or repeating an event', async () => {
    log.record({ type: 'task.state', taskId: 'a', state: 'working' });
    let stop: () => void = () => {};
    const interrupted = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let round = 0;
    serve = async (args) => {
      round++;
      if (round === 2) {
        // Two events, then the server goes down for a request and comes back from disk.
        log.record({ type: 'task.state', taskId: 'b', state: 'needs_you', reason: 'ask' });
        log.record({ type: 'session.state', sessionId: 's', state: 'waiting' });
      }
      if (round === 3) throw new Error('connect ECONNREFUSED');
      if (round === 4) {
        log = new EventLog({ dir });
        log.record({ type: 'task.state', taskId: 'c', state: 'ready' });
      }
      if (round === 6) stop();
      return serveFrom(args);
    };
    expect(await run(['--follow', '--json'], { interrupted })).toBe(0);
    expect(out.map((line) => JSON.parse(line).id)).toEqual([1, 2, 3, 4]);
    expect(calls.map((args) => args.after)).toEqual([0, 1, 3, 3, 4, 4]);
    expect(calls.every((args) => args.wait === 10_000)).toBe(true);
    expect(err.some((line) => line.includes('still following'))).toBe(true);
    expect(err.at(-1)).toBe('resume: ut events --after 4');
  });

  it('formats an event on one line', () => {
    expect(
      formatEvent({
        id: 7,
        at: '2026-11-08T10:04:01.000Z',
        type: 'task.state',
        state: 'needs_you',
        from: 'working',
        branch: 'ut/foo',
        project: '/repos/app',
        reason: 'ask',
        message: 'Which port?',
      })
    ).toBe('#7 10:04:01 task.state needs_you ← working · ut/foo · app · ask: Which port?');
  });
});

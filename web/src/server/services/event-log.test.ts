import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  EVENT_TEXT_MAX,
  EventLog,
  type EventLogOptions,
  EventQueryError,
  parseEventQuery,
  SESSION_STATES_FILE,
  type UntetherEvent,
} from './event-log.js';
import { UntetherDoctor } from './untether-doctor.js';

const T0 = new Date('2026-11-08T10:00:00Z').getTime();
const DAY = 24 * 60 * 60_000;

describe('EventLog', () => {
  let dir: string;
  let now: number;
  const open = (options: Partial<EventLogOptions> = {}) =>
    new EventLog({ dir, now: () => now, ...options });
  const segments = () => fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  /** Every event, page by page from `after`, as a follower reads them. */
  const readAll = (log: EventLog, after = 0, limit = 3) => {
    const seen: UntetherEvent[] = [];
    let cursor = after;
    for (;;) {
      const page = log.read({ after: cursor, limit });
      seen.push(...page.events);
      expect(page.cursor).toBeGreaterThanOrEqual(cursor);
      if (page.cursor === cursor || !page.events.length) return { seen, cursor: page.cursor };
      cursor = page.cursor;
    }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-events-'));
    now = T0;
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('gives each event the next id, in order, read back in pages without holes', () => {
    const log = open();
    for (let i = 0; i < 10; i++)
      log.record({ type: 'task.state', taskId: `t${i}`, state: 'working' });
    const { seen, cursor } = readAll(log);
    expect(seen.map((event) => event.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(seen.map((event) => event.taskId)).toEqual(seen.map((_, i) => `t${i}`));
    expect(cursor).toBe(10);
    expect(log.read({ after: 10 }).events).toEqual([]);
  });

  it('goes on after a restart from the last id: no hole, no duplicate', () => {
    const first = open();
    for (let i = 1; i <= 5; i++) first.record({ type: 'task.state', taskId: `a${i}` });
    const page = first.read({ after: 0, limit: 3 });
    expect(page.events.map((e) => e.id)).toEqual([1, 2, 3]);
    // The server restarts; more events come; the follower resumes from its cursor.
    const second = open();
    expect(second.last).toBe(5);
    for (let i = 1; i <= 3; i++) second.record({ type: 'task.state', taskId: `b${i}` });
    const { seen } = readAll(second, page.cursor);
    expect(seen.map((e) => e.id)).toEqual([4, 5, 6, 7, 8]);
    expect(seen.map((e) => e.taskId)).toEqual(['a4', 'a5', 'b1', 'b2', 'b3']);
    // A third instance reading from disk only (its cache is the newest segment: still all).
    expect(readAll(open()).seen.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('drops a line a crash cut short, and the next event does not glue onto it', () => {
    const first = open();
    first.record({ type: 'task.state', taskId: 'a' });
    first.record({ type: 'task.state', taskId: 'b' });
    const [file] = segments();
    fs.appendFileSync(path.join(dir, file), '{"id":3,"at":"2026-11-08T10:00:00.000Z","ty');
    const second = open();
    expect(second.last).toBe(2);
    second.record({ type: 'task.state', taskId: 'c' });
    const { seen } = readAll(open());
    expect(seen.map((e) => [e.id, e.taskId])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
  });

  it('does not publish an event it could not write: no id used, none lost on restart', () => {
    const log = open();
    const seen: number[] = [];
    log.subscribe((event) => seen.push(event.id));
    log.record({ type: 'task.state', taskId: 'a' });
    const [file] = segments();
    // The disk refuses the next write (a full disk, lost permissions).
    fs.chmodSync(path.join(dir, file), 0o400);
    expect(log.record({ type: 'task.state', taskId: 'lost' })).toBeNull();
    expect(log.last).toBe(1);
    expect(log.read({ after: 0 }).events.map((e) => e.taskId)).toEqual(['a']);
    fs.chmodSync(path.join(dir, file), 0o600);
    expect(log.record({ type: 'task.state', taskId: 'b' })?.id).toBe(2);
    expect(seen).toEqual([1, 2]);
    const reopened = open();
    expect(reopened.last).toBe(2);
    expect(reopened.read({ after: 1 }).events.map((e) => [e.id, e.taskId])).toEqual([[2, 'b']]);
  });

  it("keeps each live session's last state on disk and catches up after a crash", () => {
    const log = open();
    log.record({ type: 'session.state', sessionId: 's1', state: 'busy' });
    log.record({ type: 'session.state', sessionId: 's2', state: 'waiting' });
    log.record({ type: 'session.state', sessionId: 's1', state: 'idle' });
    log.record({ type: 'session.state', sessionId: 's2', state: 'exited' });
    expect(open().latestSessionState('s1')?.state).toBe('idle');
    expect(open().latestSessionState('s2')).toBeUndefined();
    // The saved file lags behind (a crash after the append): the segments fill it in.
    const file = path.join(dir, SESSION_STATES_FILE);
    const stale = fs.readFileSync(file, 'utf8');
    log.record({ type: 'session.state', sessionId: 's3', state: 'busy' });
    fs.writeFileSync(file, stale);
    expect(open().latestSessionState('s3')?.state).toBe('busy');
    // Lost or unreadable: everything kept is replayed.
    fs.writeFileSync(file, '{not json');
    const replayed = open();
    expect(replayed.latestSessionState('s1')?.state).toBe('idle');
    expect(replayed.latestSessionState('s3')?.state).toBe('busy');
    // A write that failed is not a state.
    const [segment] = segments();
    fs.chmodSync(path.join(dir, segment), 0o400);
    expect(replayed.record({ type: 'session.state', sessionId: 's1', state: 'busy' })).toBeNull();
    expect(replayed.latestSessionState('s1')?.state).toBe('idle');
    fs.chmodSync(path.join(dir, segment), 0o600);
  });

  it('filters by type or family and by project (tasks by repo, sessions by folder)', () => {
    const log = open();
    log.record({ type: 'task.state', taskId: 't1', project: '/repos/app', state: 'needs_you' });
    log.record({ type: 'session.state', sessionId: 's1', dir: '/repos/app/web', state: 'waiting' });
    log.record({
      type: 'session.state',
      sessionId: 's2',
      dir: '/repos/application',
      state: 'idle',
    });
    log.record({ type: 'doctor.finding', key: 'k', severity: 'warning' });
    log.record({ type: 'push', pushType: 'task-ready', title: 'Ready' });
    const ids = (query: Parameters<EventLog['read']>[0]) => log.read(query).events.map((e) => e.id);
    expect(ids({ types: ['task'] })).toEqual([1]);
    expect(ids({ types: ['session.state'] })).toEqual([2, 3]);
    expect(ids({ types: ['doctor', 'push'] })).toEqual([4, 5]);
    expect(ids({ project: '/repos/app' })).toEqual([1, 2]);
    expect(ids({ project: '/repos/app/', types: ['session'] })).toEqual([2]);
    // A filtered read still resumes past what it skipped.
    expect(log.read({ types: ['task'] }).cursor).toBe(5);
    const limited = log.read({ types: ['session'], limit: 1 });
    expect(limited.events.map((e) => e.id)).toEqual([2]);
    expect(limited.cursor).toBe(2);
  });

  it('keeps no secrets, only known fields, and short texts', () => {
    const log = open();
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const event = log.record({
      type: 'task.state',
      message: `Claude asks: push with ${token}? ${'x'.repeat(1000)}`,
      // Not a field of the log: a caller passing more keeps none of it.
      ...({ prompt: 'the whole prompt', body: 'the reply' } as object),
    });
    expect(JSON.stringify(event)).not.toContain(token);
    expect(event.prompt).toBeUndefined();
    expect(event.body).toBeUndefined();
    expect(String(event.message).length).toBeLessThanOrEqual(EVENT_TEXT_MAX);
    const onDisk = fs.readFileSync(path.join(dir, segments()[0]), 'utf8');
    expect(onDisk).not.toContain(token);
    expect(onDisk).not.toContain('the whole prompt');
  });

  it('rotates by size and keeps reading across segments in order', () => {
    const log = open({ segmentBytes: 400 });
    for (let i = 1; i <= 20; i++) log.record({ type: 'task.state', taskId: `t${i}` });
    expect(segments().length).toBeGreaterThan(3);
    // From disk (a fresh instance caches only the newest segment).
    const { seen } = readAll(open({ segmentBytes: 400 }), 0, 4);
    expect(seen.map((e) => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('rotates daily, drops segments past their days and tells the reader of the gap', () => {
    const log = open({ retentionDays: 2 });
    log.record({ type: 'task.state', taskId: 'old' });
    const [oldSegment] = segments();
    fs.utimesSync(path.join(dir, oldSegment), new Date(T0), new Date(T0));
    now = T0 + DAY;
    log.record({ type: 'task.state', taskId: 'day2' });
    expect(segments()).toHaveLength(2);
    const day2 = segments().find((name) => name !== oldSegment) as string;
    fs.utimesSync(path.join(dir, day2), new Date(T0 + DAY), new Date(T0 + DAY));
    now = T0 + 3 * DAY;
    log.record({ type: 'task.state', taskId: 'day4' });
    expect(segments()).not.toContain(oldSegment);
    const page = open({ retentionDays: 2 }).read({ after: 0 });
    expect(page.events.map((e) => e.taskId)).toEqual(['day2', 'day4']);
    expect(page.oldestId).toBe(2);
    // From the start (0) is "from the oldest kept": no gap; from 1, the event 1 is gone… but
    // 1 was read, so neither. Nothing after 1 was lost.
    expect(open({ retentionDays: 2 }).read({ after: 0 }).gap).toBe(false);
    expect(open({ retentionDays: 2 }).read({ after: 1 }).gap).toBe(false);
  });

  it('keeps the total under its size, never the newest segment, and ids go on', () => {
    const log = open({ segmentBytes: 200, totalBytes: 600 });
    for (let i = 1; i <= 40; i++) log.record({ type: 'task.state', taskId: `t${i}` });
    const total = segments().reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
    expect(total).toBeLessThanOrEqual(600 + 200);
    const reopened = open({ segmentBytes: 200, totalBytes: 600 });
    expect(reopened.last).toBe(40);
    const page = reopened.read({ after: 3 });
    expect(page.gap).toBe(true);
    expect(page.events[0].id).toBe(page.oldestId);
    expect(page.events.at(-1)?.id).toBe(40);
  });

  it('says reset when asked past its last id (the log started over)', () => {
    const log = open();
    log.record({ type: 'push', pushType: 'x', title: 'one' });
    const page = log.read({ after: 99 });
    expect(page.reset).toBe(true);
    expect(page.events.map((e) => e.id)).toEqual([1]);
    expect(page.cursor).toBe(1);
  });

  it('waits for a matching event (long poll) and times out with the cursor moved', async () => {
    vi.useFakeTimers();
    const log = open();
    const waiting = log.wait({ after: 0, types: ['task'] }, 5000);
    log.record({ type: 'push', pushType: 'x', title: 'not this' });
    log.record({ type: 'task.state', taskId: 't1', state: 'needs_you' });
    const page = await waiting;
    expect(page.events.map((e) => e.id)).toEqual([2]);
    const quiet = log.wait({ after: 2, types: ['task'] }, 5000);
    log.record({ type: 'push', pushType: 'x', title: 'still not' });
    await vi.advanceTimersByTimeAsync(5000);
    const empty = await quiet;
    expect(empty.events).toEqual([]);
    expect(empty.cursor).toBe(3);
  });

  it('parses a query: types, project, numbers, unknown types refused', async () => {
    const resolve = async (dir: string) => (dir.startsWith('/repos/app') ? '/repos/app' : null);
    await expect(
      parseEventQuery(
        { after: '4', types: 'task,session', project: '/repos/app/web', wait: 100 },
        resolve
      )
    ).resolves.toEqual({ after: 4, types: ['task', 'session'], project: '/repos/app', wait: 100 });
    await expect(parseEventQuery({ types: ['tasks'] }, resolve)).rejects.toBeInstanceOf(
      EventQueryError
    );
    await expect(parseEventQuery({ after: '-1' }, resolve)).rejects.toThrow('after');
    await expect(parseEventQuery({ wait: 60_000 }, resolve)).rejects.toThrow('wait');
    await expect(parseEventQuery({ project: 'relative' }, resolve)).rejects.toThrow('absolute');
  });
});

describe('UntetherDoctor events', () => {
  it('records each new finding, a healed one and a cleared one, once', async () => {
    const recorded: unknown[] = [];
    let findings = [
      { key: 'a', check: 'c', severity: 'warning' as const, problem: 'broken thing' },
      { key: 'b', check: 'c', severity: 'info' as const, problem: 'fixed', healed: 'restarted' },
    ];
    const doctor = new UntetherDoctor({
      checks: [{ id: 'c', run: () => findings }],
      tellOrchestrator: () => true,
      push: () => {},
      log: () => {},
      recordEvent: (event) => recorded.push(event),
    });
    await doctor.runOnce();
    findings = findings.slice(0, 1);
    await doctor.runOnce();
    findings = [];
    await doctor.runOnce();
    expect(recorded).toEqual([
      {
        type: 'doctor.finding',
        key: 'a',
        check: 'c',
        severity: 'warning',
        message: 'broken thing',
        healed: undefined,
      },
      {
        type: 'doctor.finding',
        key: 'b',
        check: 'c',
        severity: 'info',
        message: 'fixed',
        healed: 'restarted',
      },
      { type: 'doctor.cleared', key: 'a' },
    ]);
  });
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { EventLog } from './event-log.js';
import { SessionStateEvents, sessionStateOf } from './session-state-events.js';

describe('SessionStateEvents', () => {
  let dir: string;
  let log: EventLog;
  const sessions = new Map<string, { name?: string; dir?: string }>([
    ['claude-1', { name: 'web', dir: '/repos/app/web' }],
    // A task worktree outside its repository's folder.
    ['codex-1', { name: 'fix', dir: '/worktrees/app/fix-login' }],
    ['gemini-1', { name: 'docs', dir: '/elsewhere' }],
  ]);
  let resolves: Array<() => void>;
  let failWrites: boolean;
  const make = (slow = false) =>
    new SessionStateEvents({
      record: (event) => (failWrites ? null : log.record(event)),
      latest: (id) => log.latestSessionState(id),
      session: (id) => sessions.get(id),
      resolveProject: (folder) => {
        const repo =
          folder.startsWith('/repos/app') || folder.startsWith('/worktrees/app/')
            ? '/repos/app'
            : null;
        if (!slow) return Promise.resolve(repo);
        return new Promise((resolve) => resolves.push(() => resolve(repo)));
      },
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-session-events-'));
    log = new EventLog({ dir });
    resolves = [];
    failWrites = false;
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  it('records each agent once per change, with its repository, also for a worktree outside it', async () => {
    const states = make();
    states.observe('claude-1', 'claude', 'busy');
    states.observe('claude-1', 'claude', 'busy');
    states.observe('codex-1', 'codex', 'waiting', { reason: 'permission' });
    states.observe('gemini-1', 'gemini', 'busy');
    states.observe('claude-1', 'claude', 'busy', { background: true });
    states.observe('codex-1', 'codex', 'idle');
    states.exited('codex-1');
    states.exited('codex-1');
    states.exited('never-seen');
    await states.settled();
    const events = log.read({ types: ['session'] }).events;
    expect(events.map((e) => [e.sessionId, e.agent, e.state, e.from ?? null])).toEqual([
      ['claude-1', 'claude', 'busy', null],
      ['codex-1', 'codex', 'waiting', null],
      ['gemini-1', 'gemini', 'busy', null],
      ['claude-1', 'claude', 'busy', 'busy'],
      ['codex-1', 'codex', 'idle', 'waiting'],
      ['codex-1', 'codex', 'exited', 'idle'],
    ]);
    expect(events[1]).toMatchObject({ reason: 'permission', project: '/repos/app' });
    expect(events[3].background).toBe(true);
    // --project finds the worktree session too.
    expect(log.read({ project: '/repos/app' }).events.map((e) => e.sessionId)).toEqual([
      'claude-1',
      'codex-1',
      'claude-1',
      'codex-1',
      'codex-1',
    ]);
  });

  it("keeps a session's events in order while its project is being resolved", async () => {
    const states = make(true);
    states.observe('codex-1', 'codex', 'busy');
    states.observe('codex-1', 'codex', 'waiting', { reason: 'question' });
    states.exited('codex-1');
    // Another session's event goes in meanwhile: this one's still wait for their project.
    states.observe('claude-1', 'claude', 'idle');
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.read().events.map((e) => e.sessionId)).toEqual([]);
    while (resolves.length) {
      resolves.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await states.settled();
    const codex = log.read().events.filter((e) => e.sessionId === 'codex-1');
    expect(codex.map((e) => e.state)).toEqual(['busy', 'waiting', 'exited']);
    const ids = codex.map((e) => e.id);
    expect(ids).toEqual(codex.map((e) => e.id).sort((x, y) => x - y));
  });

  it('after a restart tells only what changed since the log last said', async () => {
    const first = make();
    first.observe('claude-1', 'claude', 'waiting');
    first.observe('gemini-1', 'gemini', 'idle');
    await first.settled();
    log = new EventLog({ dir });
    const second = make();
    second.observe('claude-1', 'claude', 'waiting');
    second.observe('gemini-1', 'gemini', 'busy');
    second.exited('claude-1');
    await second.settled();
    expect(log.read().events.map((e) => [e.sessionId, e.state, e.from ?? null])).toEqual([
      ['claude-1', 'waiting', null],
      ['gemini-1', 'idle', null],
      ['gemini-1', 'busy', 'idle'],
      ['claude-1', 'exited', 'waiting'],
    ]);
  });

  it('knows the last state after a restart even when it is far back in the log', async () => {
    const first = make();
    first.observe('gemini-1', 'gemini', 'busy');
    await first.settled();
    // Thousands of other events, in many segments, since then.
    log = new EventLog({ dir, segmentBytes: 4096 });
    for (let i = 0; i < 2500; i++) log.record({ type: 'push', pushType: 'x', title: `n${i}` });
    log = new EventLog({ dir, segmentBytes: 4096 });
    const second = make();
    second.observe('gemini-1', 'gemini', 'busy');
    await second.settled();
    expect(log.read({ types: ['session'] }).events.map((e) => e.state)).toEqual(['busy']);
  });

  it('tells a change again once a write failed, when the disk is back', async () => {
    const states = make();
    states.observe('claude-1', 'claude', 'busy');
    await states.settled();
    failWrites = true;
    states.observe('claude-1', 'claude', 'waiting');
    await states.settled();
    states.observe('claude-1', 'claude', 'waiting');
    await states.settled();
    failWrites = false;
    states.observe('claude-1', 'claude', 'waiting');
    await states.settled();
    expect(log.read().events.map((e) => [e.state, e.from ?? null])).toEqual([
      ['busy', null],
      ['waiting', 'busy'],
    ]);
  });

  it("maps an agent's event state to the log's", () => {
    expect(sessionStateOf('working')).toEqual({ state: 'busy' });
    expect(sessionStateOf('compacting')).toEqual({ state: 'busy' });
    expect(sessionStateOf('permission')).toEqual({ state: 'waiting', reason: 'permission' });
    expect(sessionStateOf('question')).toEqual({ state: 'waiting', reason: 'question' });
    expect(sessionStateOf('turn-ended')).toEqual({ state: 'idle' });
    expect(sessionStateOf('halted')).toEqual({ state: 'idle', reason: 'halted' });
    expect(sessionStateOf('ended')).toBeUndefined();
  });
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenChoices } from '../../shared/claude-screen.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { AgentEventService } from './agent-event-service.js';
import type { AgentSnapshot } from './agent-events.js';
import { parseProcessTable } from './claude-chat.js';
import type { CodexSessionRef } from './codex-chat.js';
import { codexSessionRef, type SessionLike } from './codex-process.js';
import {
  CODEX_MENU_READ_MS,
  CODEX_MENU_SAME_MS,
  CodexMenus,
  CodexSessions,
  codexAgentStatus,
  codexSightings,
} from './codex-session-status.js';

const FIXTURES = path.join(__dirname, '__fixtures__/agent-events');
const lines = (name: string) =>
  fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean);

const direct: SessionLike = {
  id: 'direct',
  command: ['codex', '--no-alt-screen'],
  workingDir: '/work/a',
  startedAt: '2026-11-10T09:00:00.000Z',
  pid: 100,
  status: 'running',
};
const shell: SessionLike = {
  id: 'shell',
  command: ['zsh'],
  workingDir: '/work/b',
  startedAt: '2026-11-10T09:00:00.000Z',
  pid: 200,
  status: 'running',
};

describe('CodexSessions', () => {
  it('follows a Codex the session was started with and one typed in a shell', async () => {
    // What `TZ=UTC ps` shows for `codex` typed in an Untether zsh (codex-process.test.ts).
    const table = parseProcessTable(
      [
        '  100     1 Tue Nov 10 09:00:00 2026     codex --no-alt-screen',
        '  200     1 Tue Nov 10 09:00:00 2026     -zsh',
        '  300   200 Tue Nov 10 09:05:00 2026     node /opt/node/bin/codex',
        '  400     1 Tue Nov 10 09:00:00 2026     -zsh',
        '',
      ].join('\n')
    );
    const deps = { table: async () => table, cwdOf: async () => '/work/b/project' };
    const plain: SessionLike = { ...shell, id: 'plain', pid: 400 };
    const sessions = new CodexSessions({
      sessions: () => [direct, shell, plain],
      resolve: (session) => codexSessionRef(session, deps),
    });
    await sessions.refresh();
    expect(sessions.ids().sort()).toEqual(['direct', 'shell']);
    // The session itself for the first; the process, where it runs, for the second.
    expect(sessions.ref('direct')).toMatchObject({ id: 'direct', workingDir: '/work/a' });
    expect(sessions.ref('shell')).toMatchObject({
      workingDir: '/work/b/project',
      startedAt: '2026-11-10T09:05:00.000Z',
    });
    expect(sessions.ref('shell')?.id).toMatch(/^proc:300:/);
    expect(sessions.ref('plain')).toBeUndefined();
  });

  it('tells when a session’s Codex left or is another one, and only then', async () => {
    let refs: Record<string, CodexSessionRef | null> = {
      shell: { id: 'proc:300:1', workingDir: '/work/b', startedAt: '2026-11-10T09:05:00.000Z' },
    };
    const onGone = vi.fn();
    const sessions = new CodexSessions({
      sessions: () => [shell],
      resolve: async (session) => refs[session.id] ?? null,
      onGone,
    });
    await sessions.refresh();
    await sessions.refresh();
    expect(onGone).not.toHaveBeenCalled();
    // `codex` typed again in the same shell: another process, another conversation.
    refs = { shell: { ...(refs.shell as CodexSessionRef), id: 'proc:310:2' } };
    await sessions.refresh();
    expect(onGone).toHaveBeenCalledTimes(1);
    refs = {};
    await sessions.refresh();
    expect(onGone).toHaveBeenCalledTimes(2);
    expect(sessions.ids()).toEqual([]);
    await sessions.refresh();
    expect(onGone).toHaveBeenCalledTimes(2);
  });

  it('keeps what it knew through a look that failed, and skips exited sessions', async () => {
    let fail = false;
    const onGone = vi.fn();
    const onError = vi.fn();
    let list: SessionLike[] = [shell];
    const sessions = new CodexSessions({
      sessions: () => list,
      resolve: async () => {
        if (fail) throw new Error('ps failed');
        return { id: 'proc:300:1', workingDir: '/work/b', startedAt: shell.startedAt };
      },
      onGone,
      onError,
    });
    await sessions.refresh();
    fail = true;
    await sessions.refresh();
    expect(sessions.ids()).toEqual(['shell']);
    expect(onGone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('shell', expect.any(Error));
    fail = false;
    list = [{ ...shell, status: 'exited' }];
    await sessions.refresh();
    expect(sessions.ids()).toEqual([]);
    expect(onGone).toHaveBeenCalledWith('shell');
  });

  it('shares one look between calls made at the same time', async () => {
    const resolve = vi.fn(async () => null);
    const sessions = new CodexSessions({ sessions: () => [shell], resolve });
    await Promise.all([sessions.refresh(), sessions.refresh()]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe('codexAgentStatus', () => {
  const snapshot = (extra: Partial<AgentSnapshot>): AgentSnapshot => ({
    state: 'working',
    since: 1000,
    source: 'codex-rollout',
    lastEventAt: 1000,
    toolsOpen: 0,
    ...extra,
  });

  it('tells a Codex state in the list’s words', () => {
    expect(codexAgentStatus(snapshot({}))).toEqual({ agent: 'codex', status: 'busy', since: 1000 });
    expect(codexAgentStatus(snapshot({ state: 'compacting' }))?.status).toBe('busy');
    expect(codexAgentStatus(snapshot({ state: 'turn-ended', since: 5 }))).toEqual({
      agent: 'codex',
      status: 'idle',
      since: 5,
    });
    expect(codexAgentStatus(snapshot({ state: 'starting' }))?.status).toBe('idle');
    expect(
      codexAgentStatus(snapshot({ state: 'permission', asking: 'Permission for shell' }))
    ).toEqual({
      agent: 'codex',
      status: 'waiting',
      since: 1000,
      waitingFor: 'Permission for shell',
    });
    expect(
      codexAgentStatus(
        snapshot({ state: 'halted', halt: { kind: 'usage-limit', message: 'limit' } })
      )
    ).toEqual({ agent: 'codex', status: 'idle', since: 1000, halted: 'usage-limit' });
  });

  it('says nothing without events, for an ended agent or for another agent’s events', () => {
    expect(codexAgentStatus(undefined)).toBeUndefined();
    expect(codexAgentStatus(snapshot({ state: 'ended' }))).toBeUndefined();
    expect(codexAgentStatus(snapshot({ source: 'claude-hook' }))).toBeUndefined();
  });
});

describe('a Codex typed in a shell, end to end', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-status-'));
  });
  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('gets its state from its rollout, and loses it when that Codex is gone', async () => {
    const rollout = path.join(dir, 'rollout.jsonl');
    const all = lines('codex-rollout-turn.jsonl');
    fs.writeFileSync(rollout, `${all.slice(0, 5).join('\n')}\n`);
    let running = true;
    const sessions: CodexSessions = new CodexSessions({
      sessions: () => [shell],
      resolve: async () =>
        running ? { id: 'proc:300:1', workingDir: dir, startedAt: shell.startedAt } : null,
      onGone: (sessionId) => {
        if (events.tracker.get(sessionId)?.source === 'codex-rollout') events.forget(sessionId);
      },
    });
    const events = new AgentEventService({
      eventsDir: path.join(dir, 'events'),
      codexRollout: (sessionId) => (sessions.ref(sessionId) ? rollout : null),
    });
    const status = () =>
      sessions.ref('shell') ? codexAgentStatus(events.snapshot('shell')) : undefined;
    // Not looked at yet: nothing is said, the list falls back to the output time.
    expect(status()).toBeUndefined();
    await sessions.refresh();
    expect(status()).toMatchObject({ agent: 'codex', status: 'busy' });
    fs.appendFileSync(rollout, `${all.slice(5).join('\n')}\n`);
    expect(status()).toMatchObject({ agent: 'codex', status: 'idle' });
    // Codex quit, the shell stays: the shell is not an idle Codex.
    running = false;
    await sessions.refresh();
    expect(status()).toBeUndefined();
    expect(events.tracker.get('shell')).toBeUndefined();
  });
});

describe('codexSightings (the status notifier’s look at Codex)', () => {
  const ref = { id: 'proc:300:1', workingDir: '/work/b', startedAt: '2026-11-10T09:05:00.000Z' };
  const snapshot = (extra: Partial<AgentSnapshot>): AgentSnapshot => ({
    state: 'turn-ended',
    since: 2000,
    source: 'codex-rollout',
    lastEventAt: 2000,
    toolsOpen: 0,
    ...extra,
  });
  const look = async (state: AgentSnapshot | undefined, title?: () => string | undefined) =>
    codexSightings([{ id: 'shell' }, { id: 'plain' }], {
      ref: (sessionId) => (sessionId === 'shell' ? ref : undefined),
      snapshot: () => state,
      title,
    });

  it('gives each Codex session its state in Claude’s words, its last message as the text', async () => {
    const seen = await look(
      snapshot({ finalMessage: 'Done:\n  the login\tworks.', conversationId: 'thread-1' }),
      () => 'Fix the login'
    );
    expect([...seen.keys()]).toEqual(['shell']);
    expect(seen.get('shell')).toEqual({
      agent: 'codex',
      program: 'proc:300:1',
      status: {
        status: 'idle',
        since: 2000,
        title: 'Fix the login',
        preview: { role: 'assistant', text: 'Done: the login works.' },
        sessionId: 'thread-1',
      },
    });
    expect((await look(snapshot({ state: 'working', since: 5 }))).get('shell')?.status).toEqual({
      status: 'busy',
      since: 5,
    });
  });

  it('sees a Codex without a turn yet as idle, and tells why a turn was cut short', async () => {
    expect((await look(undefined)).get('shell')?.status).toEqual({ status: 'idle' });
    const halted = await look(
      snapshot({ state: 'halted', halt: { kind: 'usage-limit', message: 'You hit your limit.' } })
    );
    expect(halted.get('shell')?.status).toMatchObject({
      status: 'idle',
      preview: { role: 'assistant', text: 'You hit your limit.' },
    });
  });

  it('leaves out another agent’s events and survives a title that cannot be read', async () => {
    expect((await look(snapshot({ source: 'claude-hook' }))).size).toBe(0);
    const seen = await look(snapshot({}), () => {
      throw new Error('rollout gone');
    });
    expect(seen.get('shell')?.status).toEqual({ status: 'idle', since: 2000 });
  });
});

describe('CodexMenus (the menu Codex waits on, off its screen)', () => {
  const approval: ScreenChoices = {
    question: 'Would you like to run the following command?',
    options: ['Yes, proceed (y)', 'No, and tell Codex what to do differently (esc)'],
    detail: ['touch nuevo.txt'],
    key: 'touchnuevo.txtYes,proceed(y)No',
    cursor: 0,
    navigate: true,
    numbered: true,
  };
  const busy = { agent: 'codex', status: 'busy', since: 50 } as const;

  function setup() {
    const state = { now: 1000, screen: null as ScreenChoices | null, count: 0, fail: false };
    const read = vi.fn(async () => {
      if (state.fail) throw new Error('no terminal');
      return state.screen;
    });
    const menus = new CodexMenus({
      read,
      changeCount: () => state.count,
      now: () => state.now,
    });
    /** The screen changed and enough time went by for another read. */
    const later = (ms = CODEX_MENU_READ_MS) => {
      state.now += ms;
      state.count++;
    };
    return { state, read, menus, later };
  }

  it('makes a Codex at work with a menu up waiting, with the menu and what it approves', async () => {
    const { state, menus } = setup();
    state.screen = approval;
    expect(await menus.status('s1', busy)).toEqual({
      agent: 'codex',
      status: 'waiting',
      since: 1000,
      choices: {
        question: approval.question,
        options: approval.options,
        detail: ['touch nuevo.txt'],
        key: approval.key,
      },
    });
  });

  it('reads the trust and update prompts of a Codex that has had no turn yet', async () => {
    const { state, menus } = setup();
    state.screen = { question: 'Trust this folder?', options: ['Trust and continue', 'Back'] };
    expect(await menus.status('s1', undefined)).toMatchObject({
      agent: 'codex',
      status: 'waiting',
      choices: { question: 'Trust this folder?' },
    });
  });

  it('leaves a Codex whose turn is over alone: what is on screen is the user’s own doing', async () => {
    const { state, read, menus } = setup();
    state.screen = { question: 'Select a model', options: ['gpt-a', 'gpt-b'] };
    const idle = { agent: 'codex', status: 'idle', since: 9 } as const;
    expect(await menus.status('s1', idle)).toBe(idle);
    expect(read).not.toHaveBeenCalled();
  });

  it('says nothing new without a menu', async () => {
    const { menus } = setup();
    expect(await menus.status('s1', busy)).toBe(busy);
    expect(await menus.status('s2', undefined)).toBeUndefined();
  });

  it('never reads an unchanged screen again, a changing one at most every 2 s', async () => {
    const { state, read, menus, later } = setup();
    state.screen = approval;
    await menus.status('s1', busy);
    await menus.status('s1', busy);
    state.now += 60_000;
    await menus.status('s1', busy);
    expect(read).toHaveBeenCalledTimes(1);
    later();
    await menus.status('s1', busy);
    expect(read).toHaveBeenCalledTimes(2);
    // It changed again, but was read a moment ago.
    state.count++;
    state.now += 500;
    await menus.status('s1', busy);
    expect(read).toHaveBeenCalledTimes(2);
    // Concurrent looks (the list and the notifier) share one read.
    later();
    await Promise.all([menus.status('s1', busy), menus.status('s1', busy)]);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('keeps a question’s time through one missed read, and gives another question its own', async () => {
    const { state, menus, later } = setup();
    state.screen = approval;
    const first = await menus.status('s1', busy);
    later();
    state.screen = null;
    expect(await menus.status('s1', busy)).toBe(busy);
    later();
    state.screen = approval;
    expect((await menus.status('s1', busy))?.since).toBe(first?.since);
    later();
    state.screen = { ...approval, key: 'rm-rfbuildYes,proceed(y)No', detail: ['rm -rf build'] };
    const second = await menus.status('s1', busy);
    expect(second?.since).toBeGreaterThan(first?.since ?? 0);
    // Still up look after look (every few seconds): the same question, however long.
    for (let look = 0; look < 8; look++) {
      later();
      expect((await menus.status('s1', busy))?.since).toBe(second?.since);
    }
    // Gone for longer than a missed read, then asked again: news.
    state.screen = null;
    later();
    await menus.status('s1', busy);
    later(CODEX_MENU_SAME_MS + 1);
    state.screen = { ...approval, key: 'rm-rfbuildYes,proceed(y)No', detail: ['rm -rf build'] };
    expect((await menus.status('s1', busy))?.since).toBeGreaterThan(second?.since ?? 0);
  });

  it('keeps a question’s time on an unchanged screen, however long nobody looked', async () => {
    const { state, menus } = setup();
    state.screen = approval;
    const first = await menus.status('s1', busy);
    // The timers stalled (a loaded Mac): the screen is the same, so is the question.
    state.now += 10 * CODEX_MENU_SAME_MS;
    expect((await menus.status('s1', busy))?.since).toBe(first?.since);
  });

  it('a failed read is not the menu leaving; once answered the screen is read again', async () => {
    const { state, read, menus, later } = setup();
    state.screen = approval;
    await menus.status('s1', busy);
    later();
    state.fail = true;
    expect((await menus.status('s1', busy))?.status).toBe('waiting');
    state.fail = false;
    state.screen = null;
    // Answered through /answer: no waiting for the 2 s to go by.
    menus.forget('s1');
    expect(await menus.status('s1', busy)).toBe(busy);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('skips a screen that would mean replaying a long output', async () => {
    const read = vi.fn(async () => approval);
    const menus = new CodexMenus({ read, canRead: () => false });
    expect(await menus.status('s1', busy)).toBe(busy);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('codexSightings with a menu', () => {
  it('sees a Codex waiting on its menu, its question as what it asks', async () => {
    const ref = { id: 'proc:300:1', workingDir: '/w', startedAt: '2026-11-10T09:05:00.000Z' };
    const seen = await codexSightings([{ id: 's1' }], {
      ref: () => ref,
      snapshot: () => undefined,
      withMenu: async () => ({
        agent: 'codex',
        status: 'waiting',
        since: 77,
        choices: { question: 'Trust this folder?', options: ['Trust and continue', 'Back'] },
      }),
    });
    expect(seen.get('s1')?.status).toEqual({
      status: 'waiting',
      since: 77,
      waitingFor: 'Trust this folder?',
    });
    // A screen that cannot be read leaves the rollout's word.
    const unread = await codexSightings([{ id: 's1' }], {
      ref: () => ref,
      snapshot: () => undefined,
      withMenu: async () => {
        throw new Error('no terminal');
      },
    });
    expect(unread.get('s1')?.status).toEqual({ status: 'idle' });
  });
});

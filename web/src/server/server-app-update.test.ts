import { describe, expect, it, vi } from 'vitest';

vi.mock('./utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  appUpdatePush,
  ENGINE_STEP_MAX_MS,
  type QuietFacts,
  quietBlocker,
  TOOL_RUN_MAX_MS,
} from './server-app-update.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('a quiet moment for swapping the app: real activity, never a state that can last hours', () => {
  const quiet = 120_000;
  const none: QuietFacts = { tasks: [], checksRunning: 0, sessions: [] };
  const blocker = (facts: Partial<QuietFacts>) => quietBlocker({ ...none, ...facts }, quiet, NOW);

  it('is quiet with nothing going on', () => {
    expect(blocker({})).toBeNull();
  });

  it('2026-11-11: every task paused at the usage limit or waiting for the user holds nothing', () => {
    // The morning of its first real run: one task paused by Claude's 429, one waiting four
    // hours at a permission prompt (its tool call open all that time), both orchestrators idle.
    expect(
      blocker({
        tasks: [
          { name: 'Partir la web', state: 'paused', stateSince: NOW - 2 * HOUR },
          { name: 'Partir runner/llave.mjs', state: 'needs_you', stateSince: NOW - 4 * HOUR },
          { name: 'una lista', state: 'ready', stateSince: NOW - 9 * HOUR },
          { name: 'una en cola', state: 'queued', stateSince: NOW - 3 * HOUR },
        ],
        sessions: [
          // Cut by the 429: its turn never ended, its last event is hours old.
          { id: '3481c835-1', name: 'Partir la web', lastEventAt: NOW - 2 * HOUR },
          // At the permission prompt: the screen reads "waiting", the terminal still redraws.
          {
            id: 'c7ac8796-1',
            name: 'Partir runner/llave.mjs',
            lastEventAt: NOW - 4 * HOUR,
            screenBusy: false,
            lastOutputAt: NOW - 2000,
            agentState: 'permission',
            screenResting: true,
            toolOpenSince: NOW - 4 * HOUR,
          },
          { id: '1a9d1e1d-1', name: 'UNTETHER', lastEventAt: NOW - 80 * MIN, lastOutputAt: NOW },
        ],
      })
    ).toBeNull();
  });

  it('a turn left open for hours with no event does not hold, whatever it left open', () => {
    expect(
      blocker({
        tasks: [{ name: 'x', state: 'working', stateSince: NOW - 5 * HOUR }],
        sessions: [{ id: 'aaaaaaaa-1', lastEventAt: NOW - 3 * HOUR, busySeenAt: NOW - 3 * HOUR }],
      })
    ).toBeNull();
  });

  it('is not while an agent did something within quietSec, and names the session', () => {
    expect(
      blocker({ sessions: [{ id: 'aaaaaaaa-1', name: 'Bakery', lastEventAt: NOW - 30_000 }] })
    ).toBe('an agent was at work 30 s ago ("Bakery", session aaaaaaaa)');
    expect(blocker({ sessions: [{ id: 'bbbbbbbb-2', busySeenAt: NOW - 60_000 }] })).toBe(
      'an agent was at work 60 s ago (session bbbbbbbb)'
    );
    expect(blocker({ sessions: [{ id: 'bbbbbbbb-2', busySeenAt: NOW - 3 * MIN }] })).toBeNull();
  });

  it('is not while a long silent command runs: the screen reads as working and its timer ticks', () => {
    const session = { id: 'aaaaaaaa-1', lastEventAt: NOW - 40 * MIN, lastOutputAt: NOW - 1000 };
    expect(blocker({ sessions: [{ ...session, screenBusy: true }] })).toContain('at work 1 s ago');
    // The same output from a screen at rest or at a prompt is only a redraw.
    expect(blocker({ sessions: [{ ...session, screenBusy: false }] })).toBeNull();
    // A screen that says working and wrote nothing for longer than quietSec is not at work.
    expect(
      blocker({ sessions: [{ ...session, screenBusy: true, lastOutputAt: NOW - 5 * MIN }] })
    ).toBeNull();
  });

  it('is not while a command of a turn runs in silence, its call open and its agent at work', () => {
    const session = {
      id: 'aaaaaaaa-1',
      name: 'x',
      lastEventAt: NOW - 20 * MIN,
      agentState: 'working',
      toolOpenSince: NOW - 20 * MIN,
    };
    expect(blocker({ sessions: [session] })).toBe(
      'an agent\'s command has been running for 20 min ("x", session aaaaaaaa)'
    );
    // The same call open while the agent asks for permission or a question, or with its
    // screen at rest (a turn that was cut), or open for longer than any command runs.
    expect(blocker({ sessions: [{ ...session, agentState: 'permission' }] })).toBeNull();
    expect(blocker({ sessions: [{ ...session, agentState: 'question' }] })).toBeNull();
    expect(blocker({ sessions: [{ ...session, screenResting: true }] })).toBeNull();
    expect(
      blocker({
        sessions: [
          { ...session, lastEventAt: NOW - 3 * HOUR, toolOpenSince: NOW - TOOL_RUN_MAX_MS - MIN },
        ],
      })
    ).toBeNull();
  });

  it('is not while a check runs; checks only waiting for a slot hold nothing', () => {
    expect(blocker({ checksRunning: 1 })).toBe('a check is running');
  });

  it('a task just prepared, checked or merged holds; one stuck there for hours does not', () => {
    for (const state of ['preparing', 'verifying', 'merging'] as const) {
      expect(blocker({ tasks: [{ name: 'x', state, stateSince: NOW - MIN }] })).toBe(
        `task "x" is ${state}`
      );
      expect(
        blocker({ tasks: [{ name: 'x', state, stateSince: NOW - ENGINE_STEP_MAX_MS - MIN }] })
      ).toBeNull();
    }
  });
});

describe("the phone's line about an update of the app", () => {
  it('says the commit after an update', () => {
    expect(
      appUpdatePush({ ok: true, commit: 'bbb2222', text: 'Untether updated itself to bbb2222' })
    ).toMatchObject({
      type: 'app-updated',
      title: 'Untether updated itself to bbb2222',
      body: '',
      data: { type: 'app-updated', detail: 'bbb2222' },
    });
  });

  it('says why it could not, with the reason for the phone to word', () => {
    const push = appUpdatePush({
      ok: false,
      commit: 'bbb2222',
      failure: 'keychain',
      text: 'Untether could not update itself: the keychain did not let the build be signed',
    });
    expect(push).toMatchObject({
      type: 'app-update-failed',
      title: 'Untether could not update itself',
      data: { type: 'app-update-failed', detail: 'bbb2222', reason: 'keychain' },
    });
    expect(push.body).toContain('the keychain did not let the build be signed');
  });

  it('says what a build that is ready has waited on, as a line of its own kind', () => {
    const text =
      "Untether's update to bbb2222 has been ready for 2 h 1 min and still waits for a quiet moment: a check is running";
    expect(appUpdatePush({ ok: false, waiting: true, commit: 'bbb2222', text })).toMatchObject({
      type: 'app-update-waiting',
      title: "Untether's update is waiting for a quiet moment",
      body: text,
      data: { type: 'app-update-waiting', detail: 'bbb2222' },
    });
  });
});

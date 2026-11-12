import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { ClaudeStatus } from './claude-chat.js';
import {
  type AgentSighting,
  ClaudeStatusNotifier,
  FORGET_AFTER_UNSEEN_TICKS,
  STATUS_STATE_MAX_AGE_MS,
  transcriptBytesOf,
} from './claude-status-notifier.js';

describe('ClaudeStatusNotifier', () => {
  it('notifies when Claude finishes or starts waiting, never on first sighting', async () => {
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'claude (~/p)', pid: 42, status: 'running' }],
      notify,
      async () => new Map([[42, status]])
    );

    await notifier.tick();
    expect(notify).not.toHaveBeenCalled();

    status = {
      status: 'idle',
      title: 'Fix login',
      preview: { role: 'assistant', text: 'Done: login fixed.' },
    };
    await notifier.tick();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'claude-finished',
        title: '✅ Claude finished · Fix login',
        body: 'Done: login fixed.',
        tag: 'untether-claude-s1',
        data: expect.objectContaining({ sessionId: 's1' }),
      })
    );

    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);

    status = { status: 'waiting', waitingFor: 'permission to run Bash' };
    await notifier.tick();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'claude-waiting',
        body: 'permission to run Bash',
        requireInteraction: true,
      })
    );

    // Waiting -> idle (the user answered and Claude was not working) is not news.
    status = { status: 'idle' };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("names the session by the title the user gave it, over Claude's", async () => {
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [
        { id: 's1', name: 'claude (~/p)', userTitle: 'Login work', pid: 42, status: 'running' },
      ],
      notify,
      async () => new Map([[42, status]])
    );

    await notifier.tick();
    status = { status: 'idle', title: 'Fix login' };
    await notifier.tick();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: '✅ Claude finished · Login work',
        data: expect.objectContaining({ where: 'Login work' }),
      })
    );
  });

  it('survives a failing status read instead of rejecting', async () => {
    const onError = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running' }],
      vi.fn(),
      async () => {
        throw new Error('ps: fork failed');
      },
      onError
    );

    await expect(notifier.tick()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'ps: fork failed' }));
  });

  it('stays silent for a muted session', async () => {
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running', muted: true }],
      notify,
      async () => new Map([[42, status]])
    );
    await notifier.tick();
    status = { status: 'waiting', waitingFor: 'permission' };
    await notifier.tick();
    status = { status: 'idle' };
    await notifier.tick();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('ClaudeStatusNotifier with background agents', () => {
  function notifierWith(read: () => ClaudeStatus) {
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running' }],
      notify,
      async () => new Map([[42, read()]])
    );
    return { notifier, notify };
  }
  const reply = { role: 'assistant' as const, text: 'Hecho; el agente sigue.' };

  it('sends one "replied" when the turn ends while background agents run, then the usual "finished"', async () => {
    let status: ClaudeStatus = { status: 'busy', since: 1000, title: 'Agentes' };
    const { notifier, notify } = notifierWith(() => status);
    await notifier.tick();

    status = {
      status: 'busy',
      since: 1000,
      title: 'Agentes',
      waitingForBackground: true,
      preview: reply,
    };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'claude-replied',
        title: '💬 Claude replied · Agentes',
        body: 'Hecho; el agente sigue.',
        tag: 'untether-claude-s1',
        requireInteraction: false,
        data: expect.objectContaining({
          type: 'claude-replied',
          detail: 'Hecho; el agente sigue.',
        }),
      })
    );

    // Still waiting for the agents: busy → busy is not news, and never a "finished".
    await notifier.tick();
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);

    // A task notification starts a turn (no push), its reply ends again: one more "replied".
    status = { status: 'busy', since: 1000, title: 'Agentes' };
    await notifier.tick();
    status = {
      status: 'busy',
      since: 1000,
      title: 'Agentes',
      waitingForBackground: true,
      preview: reply,
    };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(2);

    // Everything ended: Claude goes idle, and that is still the usual "finished".
    status = { status: 'idle', since: 9000, title: 'Agentes', preview: reply };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'claude-finished' }));
  });

  it('sends no "replied" from idle or on first sighting', async () => {
    let status: ClaudeStatus = { status: 'busy', since: 1000, waitingForBackground: true };
    const { notifier, notify } = notifierWith(() => status);
    await notifier.tick();
    status = { status: 'idle', since: 2000 };
    await notifier.tick();
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'claude-finished' }));
    status = { status: 'busy', since: 3000, waitingForBackground: true };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeStatusNotifier across looks that miss Claude', () => {
  function notifierWith(read: () => Promise<Map<number, ClaudeStatus>>) {
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running' }],
      notify,
      read
    );
    return { notifier, notify };
  }

  it('still sends "finished" when one look between busy and idle did not see Claude', async () => {
    let status: ClaudeStatus | null = { status: 'busy', since: 1000 };
    const { notifier, notify } = notifierWith(async () => new Map(status ? [[42, status]] : []));
    await notifier.tick();
    // ps ran mid-fork, or the session file was read mid-write: Claude is not seen once.
    status = null;
    await notifier.tick();
    status = { status: 'idle', since: 2000 };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'claude-finished' }));
  });

  it('notices idle → busy → idle hidden by a short gap, by the new since', async () => {
    let status: ClaudeStatus | null = { status: 'idle', since: 1000 };
    const { notifier, notify } = notifierWith(async () => new Map(status ? [[42, status]] : []));
    await notifier.tick();
    status = null;
    await notifier.tick();
    await notifier.tick();
    status = { status: 'idle', since: 3000 };
    await notifier.tick();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'claude-finished' }));
  });

  it('stays silent when a restore puts a new program in the session (new pid)', async () => {
    let pid = 42;
    let status: ClaudeStatus | null = { status: 'busy', since: 1000 };
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid, status: 'running' }],
      notify,
      async () => new Map(status ? [[pid, status]] : [])
    );
    await notifier.tick();
    // The shield's tmux server went away: the session is restored with a new Claude, idle.
    status = null;
    await notifier.tick();
    pid = 77;
    status = { status: 'idle', since: 5000 };
    await notifier.tick();
    expect(notify).not.toHaveBeenCalled();
    // From then on it is watched as usual.
    status = { status: 'busy', since: 6000 };
    await notifier.tick();
    status = { status: 'idle', since: 7000 };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'claude-finished' }));
  });

  it('forgets a session unseen for several looks: its next sighting is a first one again', async () => {
    let status: ClaudeStatus | null = { status: 'busy', since: 1000 };
    const { notifier, notify } = notifierWith(async () => new Map(status ? [[42, status]] : []));
    await notifier.tick();
    status = null;
    for (let i = 0; i < FORGET_AFTER_UNSEEN_TICKS; i++) await notifier.tick();
    status = { status: 'idle', since: 2000 };
    await notifier.tick();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not count a failed read as a look that missed Claude', async () => {
    let status: ClaudeStatus | null = { status: 'busy', since: 1000 };
    const { notifier, notify } = notifierWith(async () => {
      if (!status) throw new Error('ps: fork failed');
      return new Map([[42, status]]);
    });
    await notifier.tick();
    status = null;
    for (let i = 0; i < FORGET_AFTER_UNSEEN_TICKS + 2; i++) await notifier.tick();
    status = { status: 'idle', since: 2000 };
    await notifier.tick();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'claude-finished' }));
  });
});

describe('ClaudeStatusNotifier log of what it drops', () => {
  it("logs a muted session's skipped push, and a Claude lost and found again, once each", async () => {
    let status: ClaudeStatus | null = { status: 'busy', since: 1000 };
    let muted = true;
    const log = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running', muted }],
      vi.fn(),
      async () => new Map(status ? [[42, status]] : []),
      undefined,
      undefined,
      { log }
    );
    await notifier.tick();
    await notifier.tick();
    status = {
      status: 'idle',
      since: 2000,
      preview: { role: 'assistant', text: 'secret reply text' },
    };
    await notifier.tick();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(
      'Claude status: claude-finished for session s1 not pushed: session muted'
    );

    muted = false;
    status = null;
    await notifier.tick();
    await notifier.tick();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(
      'Claude status: session s1 not seen (last idle, after 3 looks with it)'
    );
    status = { status: 'busy', since: 3000 };
    await notifier.tick();
    await notifier.tick();
    expect(log).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenLastCalledWith(
      'Claude status: session s1 seen again (busy) after 2 looks without it'
    );
    expect(log.mock.calls.flat().join('\n')).not.toContain('secret');
  });
});

describe('ClaudeStatusNotifier transitions', () => {
  it('reports every status change, muted sessions and first sightings included', async () => {
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const seen: Array<[string, string | undefined, string]> = [];
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running', muted: true }],
      notify,
      async () => new Map([[42, status]])
    );
    notifier.onTransition((id, previous, next) => seen.push([id, previous, next]));
    await notifier.tick();
    await notifier.tick();
    status = { status: 'waiting', waitingFor: 'permission' };
    await notifier.tick();
    status = { status: 'idle' };
    await notifier.tick();
    expect(seen).toEqual([
      ['s1', undefined, 'busy'],
      ['s1', 'busy', 'waiting'],
      ['s1', 'waiting', 'idle'],
    ]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps going when a listener throws', async () => {
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const onError = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running' }],
      notify,
      async () => new Map([[42, status]]),
      onError
    );
    notifier.onTransition(() => {
      throw new Error('boom');
    });
    await notifier.tick();
    status = { status: 'idle' };
    await notifier.tick();
    expect(onError).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'claude-finished' }));
  });

  it('sends nothing when the rewriter drops the push', async () => {
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running' }],
      notify,
      async () => new Map([[42, status]])
    );
    notifier.setPayloadRewriter(() => null);
    await notifier.tick();
    status = { status: 'idle' };
    await notifier.tick();
    expect(notify).not.toHaveBeenCalled();
  });
});

// 2026-10-20: opening a finished task's terminal on the phone redraws Claude's TUI; Claude
// Code's status read busy then idle and the task engine took it for another turn.
describe('ClaudeStatusNotifier and redraws with no conversation activity', () => {
  function setup() {
    const state: { status: ClaudeStatus; bytes: number | undefined } = {
      status: { status: 'idle', since: 1000, sessionId: 'conv-1' },
      bytes: 500,
    };
    const notify = vi.fn();
    const transitions: Array<[string | undefined, string]> = [];
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running' }],
      notify,
      async () => new Map([[42, state.status]]),
      undefined,
      undefined,
      { transcriptBytes: () => state.bytes }
    );
    notifier.onTransition((_id, previous, status) => transitions.push([previous, status]));
    return { state, notify, notifier, transitions };
  }

  it('takes busy then idle with an unchanged transcript as a redraw, not a turn', async () => {
    const { state, notify, notifier, transitions } = setup();
    await notifier.tick();
    state.status = { status: 'busy', since: 2000, sessionId: 'conv-1' };
    await notifier.tick();
    state.status = { status: 'idle', since: 3000, sessionId: 'conv-1' };
    await notifier.tick();
    // Idle again with a new since only (the redraw fell between two looks).
    state.status = { status: 'idle', since: 4000, sessionId: 'conv-1' };
    await notifier.tick();
    expect(notify).not.toHaveBeenCalled();
    expect(transitions).toEqual([[undefined, 'idle']]);
  });

  it('still reports a real turn: the transcript grows', async () => {
    const { state, notify, notifier, transitions } = setup();
    await notifier.tick();
    // The first busy look comes before the prompt reached the transcript: one look later.
    state.status = { status: 'busy', since: 2000, sessionId: 'conv-1' };
    await notifier.tick();
    state.bytes = 900;
    await notifier.tick();
    state.status = { status: 'idle', since: 3000, sessionId: 'conv-1' };
    await notifier.tick();
    expect(transitions).toEqual([
      [undefined, 'idle'],
      ['idle', 'busy'],
      ['busy', 'idle'],
    ]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'claude-finished' }));
    // A quick turn hidden between two looks still counts when the transcript grew.
    state.bytes = 1200;
    state.status = { status: 'idle', since: 5000, sessionId: 'conv-1' };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('keeps the old behaviour when the transcript size is unknown', async () => {
    const { state, notify, notifier } = setup();
    state.bytes = undefined;
    await notifier.tick();
    state.status = { status: 'busy', since: 2000, sessionId: 'conv-1' };
    await notifier.tick();
    state.status = { status: 'idle', since: 3000, sessionId: 'conv-1' };
    await notifier.tick();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'claude-finished' }));
  });
});

describe('transcriptBytesOf', () => {
  it("reads the size of the conversation's JSONL under any project folder", async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      fs.mkdirSync(path.join(dir, 'projects', '-Users-x-p'), { recursive: true });
      const file = path.join(dir, 'projects', '-Users-x-p', 'conv-9.jsonl');
      fs.writeFileSync(file, '{"a":1}\n');
      expect(transcriptBytesOf({ sessionId: 'conv-9' }, dir)).toBe(8);
      fs.appendFileSync(file, '{"b":2}\n');
      expect(transcriptBytesOf({ sessionId: 'conv-9' }, dir)).toBe(16);
      expect(transcriptBytesOf({ sessionId: 'missing' }, dir)).toBeUndefined();
      expect(transcriptBytesOf({ sessionId: '../etc' }, dir)).toBeUndefined();
      expect(transcriptBytesOf({}, dir)).toBeUndefined();
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });
});

describe('ClaudeStatusNotifier across a server restart (stateFile, 2026-11-02)', () => {
  const sessions =
    (pid = 42) =>
    () => [{ id: 's1', name: 'x', pid, status: 'running' as const }];

  function withState(run: (file: string) => Promise<void>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-claude-status-'));
    return run(path.join(dir, 'claude-status.json')).finally(() => fs.rmSync(dir, RM_TEST_DIR));
  }

  it('a turn that ends while the server restarts is still "finished"; the tasks get a first look', () =>
    withState(async (stateFile) => {
      const before = new ClaudeStatusNotifier(
        sessions(),
        vi.fn(),
        async () => new Map([[42, { status: 'busy', since: 1000 } as ClaudeStatus]]),
        undefined,
        undefined,
        { stateFile }
      );
      await before.tick();
      const notify = vi.fn();
      const transitions: Array<[string | undefined, string]> = [];
      const after = new ClaudeStatusNotifier(
        sessions(),
        notify,
        async () => new Map([[42, { status: 'idle', since: 2000 } as ClaudeStatus]]),
        undefined,
        undefined,
        { stateFile }
      );
      after.onTransition((_id, previous, status) => transitions.push([previous, status]));
      await after.tick();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'claude-finished' }));
      expect(transitions).toEqual([[undefined, 'idle']]);
      // Then as usual.
      await after.tick();
      expect(notify).toHaveBeenCalledTimes(1);
    }));

  it('nothing pushed when nothing changed, the program changed, or the saved state is old', () =>
    withState(async (stateFile) => {
      let now = 1_000_000;
      const busy = async () => new Map([[42, { status: 'busy', since: 1000 } as ClaudeStatus]]);
      await new ClaudeStatusNotifier(sessions(), vi.fn(), busy, undefined, undefined, {
        stateFile,
        now: () => now,
      }).tick();
      const notify = vi.fn();
      // Same status: nothing.
      await new ClaudeStatusNotifier(sessions(), notify, busy, undefined, undefined, {
        stateFile,
        now: () => now,
      }).tick();
      // Another program in the session (pid 43): a first look.
      const idle43 = async () => new Map([[43, { status: 'idle', since: 2000 } as ClaudeStatus]]);
      await new ClaudeStatusNotifier(sessions(43), notify, idle43, undefined, undefined, {
        stateFile: `${stateFile}.other`,
        now: () => now,
      }).tick();
      // Saved too long ago: a first look.
      now += STATUS_STATE_MAX_AGE_MS + 1;
      const idle = async () => new Map([[42, { status: 'idle', since: 2000 } as ClaudeStatus]]);
      await new ClaudeStatusNotifier(sessions(), notify, idle, undefined, undefined, {
        stateFile,
        now: () => now,
      }).tick();
      expect(notify).not.toHaveBeenCalled();
    }));
});

describe('ClaudeStatusNotifier with Codex (readAgents, 2026-11-10)', () => {
  const session = { id: 's1', name: 'codex (~/p)', pid: 42, status: 'running' };
  const codex = (status: ClaudeStatus, program = 'proc:300:1'): Map<string, AgentSighting> =>
    new Map([['s1', { agent: 'codex', program, status }]]);

  function setup(options: { claude?: () => ClaudeStatus | undefined } = {}) {
    let sighting: Map<string, AgentSighting> = new Map();
    const notify = vi.fn();
    const transitions: unknown[][] = [];
    const notifier = new ClaudeStatusNotifier(
      () => [session],
      notify,
      async () => {
        const claude = options.claude?.();
        return claude ? new Map([[42, claude]]) : new Map();
      },
      undefined,
      undefined,
      { readAgents: () => sighting }
    );
    notifier.onTransition((...args) => transitions.push(args));
    return {
      notify,
      notifier,
      transitions,
      see: async (status: ClaudeStatus | undefined, program?: string) => {
        sighting = status ? codex(status, program) : new Map();
        await notifier.tick();
      },
    };
  }

  it('pushes "Codex finished" and "Codex needs you" like Claude’s, never on a first look', async () => {
    const { notify, see, transitions } = setup();
    await see({ status: 'busy', since: 1 });
    expect(notify).not.toHaveBeenCalled();
    await see({
      status: 'idle',
      since: 2,
      title: 'Fix the login',
      preview: { role: 'assistant', text: 'Done: login fixed.' },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'codex-finished',
        title: '✅ Codex finished · Fix the login',
        body: 'Done: login fixed.',
        tag: 'untether-codex-s1',
        requireInteraction: false,
        data: expect.objectContaining({ sessionId: 's1', agent: 'codex', type: 'codex-finished' }),
      })
    );
    await see({ status: 'idle', since: 2 });
    expect(notify).toHaveBeenCalledTimes(1);
    await see({ status: 'waiting', since: 3, waitingFor: 'Would you like to run the command?' });
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'codex-waiting',
        title: '⏳ Codex needs you · codex (~/p)',
        body: 'Would you like to run the command?',
        requireInteraction: true,
        actions: expect.arrayContaining([{ action: 'answer', title: 'Answer' }]),
      })
    );
    // Its transitions say whose they are: Claude's listeners (tasks, orchestrators) skip them.
    expect(transitions.map((args) => args[4])).toEqual(['codex', 'codex', 'codex']);
  });

  it('one push per turn: the same status seen again says nothing, a new turn does', async () => {
    const { notify, see } = setup();
    await see({ status: 'idle', since: 10 });
    for (let look = 0; look < 5; look++) await see({ status: 'idle', since: 10 });
    expect(notify).not.toHaveBeenCalled();
    // A turn that began and ended between two looks (3 s apart): idle again, since later.
    await see({ status: 'idle', since: 20 });
    expect(notify).toHaveBeenCalledTimes(1);
    // Still working over many looks, tool after tool: nothing until it ends.
    await see({ status: 'busy', since: 30 });
    await see({ status: 'busy', since: 31 });
    await see({ status: 'busy', since: 31 });
    expect(notify).toHaveBeenCalledTimes(1);
    await see({ status: 'idle', since: 40 });
    await see({ status: 'idle', since: 40 });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('an approval answered and the turn over within one look: "needs you", then "finished"', async () => {
    const { notify, see } = setup();
    await see({ status: 'busy', since: 100 });
    await see({ status: 'waiting', since: 200, waitingFor: 'Would you like to run it?' });
    expect(notify).toHaveBeenCalledTimes(1);
    // Answered; the command ran and the turn ended before the next look.
    await see({ status: 'idle', since: 300, preview: { role: 'assistant', text: 'Done.' } });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toMatchObject({ type: 'codex-finished', body: 'Done.' });
  });

  it('a menu answered before any turn (trust this folder) is no "finished"', async () => {
    const { notify, see } = setup();
    await see({ status: 'idle' });
    await see({ status: 'waiting', since: 200, waitingFor: 'Trust this folder?' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      type: 'codex-waiting',
      body: 'Trust this folder?',
    });
    await see({ status: 'idle' });
    await see({ status: 'idle' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('the same question is pushed once, also when one look missed its menu', async () => {
    const { notify, see } = setup();
    await see({ status: 'busy', since: 100 });
    await see({ status: 'waiting', since: 200 });
    // One read caught the screen mid-redraw: no menu, then the same one again (same time).
    await see({ status: 'busy', since: 100 });
    await see({ status: 'waiting', since: 200 });
    await see({ status: 'waiting', since: 200 });
    expect(notify).toHaveBeenCalledTimes(1);
    // Another question (a later time) is news.
    await see({ status: 'busy', since: 100 });
    await see({ status: 'waiting', since: 400 });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('pushes the first turn of a Codex seen before it had any (no status time yet)', async () => {
    const { notify, see } = setup();
    // No rollout before the first prompt: seen idle, without a time.
    await see({ status: 'idle' });
    await see({ status: 'idle' });
    expect(notify).not.toHaveBeenCalled();
    // The whole first turn fit between two looks.
    await see({ status: 'idle', since: 5, preview: { role: 'assistant', text: 'Hi.' } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ type: 'codex-finished', body: 'Hi.' });
  });

  it('takes another Codex in the same session as a first look, and Claude’s status first', async () => {
    let claude: ClaudeStatus | undefined;
    const { notify, see } = setup({ claude: () => claude });
    await see({ status: 'busy', since: 1 });
    // `codex` quit and typed again in the same shell: its idle is no "finished" of the old one.
    await see({ status: 'idle', since: 2 }, 'proc:310:2');
    expect(notify).not.toHaveBeenCalled();
    await see({ status: 'busy', since: 3 }, 'proc:310:2');
    // Claude runs there now (Codex's reader still answers for a moment): Claude's is the one.
    claude = { status: 'idle' };
    await see({ status: 'idle', since: 4 }, 'proc:310:2');
    expect(notify).not.toHaveBeenCalled();
    claude = { status: 'busy' };
    await see(undefined);
    claude = { status: 'idle', preview: { role: 'assistant', text: 'From Claude.' } };
    await see(undefined);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ type: 'claude-finished' });
  });

  it('a muted session gets none, and a failing reader leaves Claude’s pushes alone', async () => {
    const notify = vi.fn();
    const errors: unknown[] = [];
    let status: ClaudeStatus = { status: 'busy' };
    const notifier = new ClaudeStatusNotifier(
      () => [{ ...session, muted: false }],
      notify,
      async () => new Map([[42, status]]),
      (error) => errors.push(error),
      undefined,
      {
        readAgents: () => {
          throw new Error('rollout unreadable');
        },
      }
    );
    await notifier.tick();
    status = { status: 'idle' };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(2);

    const quiet = vi.fn();
    let sighting = codex({ status: 'busy', since: 1 });
    const muted = new ClaudeStatusNotifier(
      () => [{ ...session, muted: true }],
      quiet,
      async () => new Map(),
      undefined,
      undefined,
      { readAgents: () => sighting }
    );
    await muted.tick();
    sighting = codex({ status: 'idle', since: 2 });
    await muted.tick();
    expect(quiet).not.toHaveBeenCalled();
  });

  it('keeps Codex’s status across a restart: a turn that ended meanwhile is still pushed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-'));
    try {
      const stateFile = path.join(dir, 'claude-status.json');
      const build = (sighting: () => Map<string, AgentSighting>, notify = vi.fn()) => ({
        notify,
        notifier: new ClaudeStatusNotifier(
          () => [session],
          notify,
          async () => new Map(),
          undefined,
          undefined,
          { stateFile, readAgents: sighting }
        ),
      });
      const before = build(() => codex({ status: 'busy', since: 1 }));
      await before.notifier.tick();
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions.s1).toMatchObject({
        status: 'busy',
        program: 'codex:proc:300:1',
      });
      const after = build(() => codex({ status: 'idle', since: 2 }));
      await after.notifier.tick();
      expect(after.notify).toHaveBeenCalledTimes(1);
      // Another Codex since then: a first look, no push.
      const other = build(() => codex({ status: 'idle', since: 9 }, 'proc:999:9'));
      await other.notifier.tick();
      expect(other.notify).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });
});

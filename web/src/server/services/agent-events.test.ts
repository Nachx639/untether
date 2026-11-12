/**
 * The agents' state from their own events (agent-events.ts). Fixtures in
 * __fixtures__/agent-events are recorded, not written by hand:
 *   claude-hooks-turn.jsonl          claude 2.1.316 -p with Untether's hook settings: a prompt,
 *                                    a Bash call, the reply ("done").
 *   claude-hooks-auth-failure.jsonl  the same with a key that is no key: StopFailure
 *                                    authentication_failed.
 *   claude-transcript-auth-failure.jsonl  that run's transcript (isApiErrorMessage entry).
 *   codex-rollout-usage-limit.jsonl  codex-cli 0.164's rollout of bakery's task cut by its
 *                                    usage limit (2026-11-01 00:52Z), and its automatic fix
 *                                    cut again at 00:53Z; texts and tool inputs blanked.
 *   codex-rollout-turn.jsonl         a Codex turn that ended normally.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { AGENT_STATE_FILE, AgentEventService } from './agent-event-service.js';
import {
  type AgentEvent,
  AgentStateTracker,
  CodexRolloutReader,
  claudeErrorKind,
  claudeHookEvent,
  codexErrorKind,
  SignalLedger,
} from './agent-events.js';
import { apiErrorFromLines } from './claude-chat.js';

import {
  CLAUDE_HOOK_EVENTS,
  claudeHookFiles,
  ensureClaudeHookFiles,
  HOOK_INPUT_MAX_BYTES,
  hookSettings,
  withClaudeHooks,
} from './claude-hooks.js';
import { agentEventsCheck, HOOKS_SILENT_AFTER_MS } from './doctor-checks.js';
import { currentWait } from './task-scheduler-stall.js';
import type { DoctorFinding } from './untether-doctor.js';

/** The hook script takes milliseconds; Claude gives it 5 s. */
const HOOK_RUN_TIMEOUT_MS = 10_000;

const FIXTURES = path.join(__dirname, '__fixtures__/agent-events');
const lines = (name: string) =>
  fs
    .readFileSync(path.join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim());

/** A recorded hook run: each line {at, event, input}. */
function hookEvents(name: string): AgentEvent[] {
  return lines(name)
    .map(
      (line) => JSON.parse(line) as { at: number; event: string; input: Record<string, unknown> }
    )
    .map(({ at, event, input }) => claudeHookEvent({ ...input, hook_event_name: event }, at))
    .filter((event): event is AgentEvent => event !== null);
}

function rolloutEvents(name: string): AgentEvent[] {
  const reader = new CodexRolloutReader();
  return lines(name)
    .map((line) => reader.line(line))
    .filter((event): event is AgentEvent => event !== null);
}

describe('Claude Code hook events (recorded)', () => {
  it('a turn: working at the prompt and the tool call, over at Stop with its whole reply', () => {
    const events = hookEvents('claude-hooks-turn.jsonl');
    expect(events.map((event) => event.kind)).toEqual([
      'session-start',
      'turn-start',
      'tool-start',
      'tool-end',
      'turn-end',
      'session-end',
    ]);
    const tracker = new AgentStateTracker();
    const states: string[] = [];
    for (const event of events) {
      tracker.apply('s1', event);
      states.push(tracker.get('s1')?.state as string);
    }
    expect(states).toEqual(['starting', 'working', 'working', 'working', 'turn-ended', 'ended']);
    // A tool call open: whatever changes files meanwhile is the agent's.
    const toolStart = events[2];
    const replay = new AgentStateTracker();
    for (const event of events.slice(0, 3)) replay.apply('s1', event);
    expect(replay.get('s1')?.toolsOpen).toBe(1);
    expect(replay.actedSince('s1', toolStart.at + 60_000)).toBe(true);
    replay.apply('s1', events[3]);
    replay.apply('s1', events[4]);
    expect(replay.get('s1')).toMatchObject({
      state: 'turn-ended',
      toolsOpen: 0,
      finalMessage: 'done',
      conversationId: '6a65b0bd-b198-4fee-a5ed-7e69a4a40ef2',
    });
    // After its turn it did nothing: a check's rewrites since then are the check's.
    expect(replay.actedSince('s1', events[4].at + 1)).toBe(false);
    expect(replay.actedSince('s1', events[3].at)).toBe(true);
    // A session it never saw: its events tell nothing.
    expect(replay.actedSince('other', 0)).toBeUndefined();
  });

  it('a turn cut by a lost login is a halt (StopFailure authentication_failed), not an end', () => {
    const events = hookEvents('claude-hooks-auth-failure.jsonl');
    expect(events.map((event) => event.kind)).toEqual([
      'session-start',
      'turn-start',
      'halt',
      'session-end',
    ]);
    const tracker = new AgentStateTracker();
    for (const event of events.slice(0, 3)) tracker.apply('s1', event);
    expect(tracker.get('s1')).toMatchObject({
      state: 'halted',
      halt: { kind: 'auth', message: 'Invalid API key · Fix external API key' },
    });
    // The next prompt is a new turn: the halt is over.
    tracker.apply('s1', { at: events[2].at + 1000, source: 'claude-hook', kind: 'turn-start' });
    expect(tracker.get('s1')?.state).toBe('working');
    expect(tracker.get('s1')?.halt).toBeUndefined();
  });

  it("a usage limit's reset comes from its message; a refused prompt ends the turn, no halt", () => {
    const at = new Date(2026, 10, 1, 1, 0).getTime();
    const limit = claudeHookEvent(
      {
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
        last_assistant_message: "You've hit your session limit · resets 4:25am",
      },
      at
    );
    expect(limit).toMatchObject({
      kind: 'halt',
      halt: { kind: 'usage-limit', resumeAt: new Date(2026, 10, 1, 4, 25).getTime() },
    });
    expect(
      claudeHookEvent(
        { hook_event_name: 'StopFailure', error: 'invalid_request', last_assistant_message: 'x' },
        at
      )
    ).toMatchObject({ kind: 'turn-end', error: 'invalid_request' });
    expect(claudeErrorKind('billing_error')).toBe('usage-limit');
    expect(claudeErrorKind('server_error')).toBe('api-error');
    expect(claudeErrorKind('something_new')).toBeNull();
  });

  it('questions and permissions wait for the user; an answer is work again', () => {
    const tracker = new AgentStateTracker();
    const at = 1_000;
    const apply = (input: Record<string, unknown>, offset: number) => {
      const event = claudeHookEvent(input, at + offset);
      if (event) tracker.apply('s1', event);
    };
    apply({ hook_event_name: 'UserPromptSubmit' }, 0);
    apply(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'q1',
        tool_input: { questions: [{ question: '¿Borro la rama vieja?' }] },
      },
      10
    );
    expect(tracker.get('s1')).toMatchObject({ state: 'question', asking: '¿Borro la rama vieja?' });
    apply({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q1' }, 20);
    expect(tracker.get('s1')?.state).toBe('working');
    apply(
      {
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      },
      30
    );
    expect(tracker.get('s1')).toMatchObject({
      state: 'permission',
      asking: 'Claude needs your permission to use Bash',
    });
    apply({ hook_event_name: 'PreCompact', trigger: 'auto' }, 40);
    expect(tracker.get('s1')?.state).toBe('compacting');
    apply({ hook_event_name: 'PostCompact', trigger: 'auto' }, 50);
    expect(tracker.get('s1')?.state).toBe('permission');
    // idle_prompt says nothing new (its turn was over already).
    expect(
      claudeHookEvent({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, 60)
    ).toBeNull();
  });
});

describe('a permission prompt says what it asks for (bakery 3dc243e4, 2026-11-10)', () => {
  it("the request's whole command is kept; Claude's notice for the same prompt does not replace it", () => {
    const tracker = new AgentStateTracker();
    const command = `bash -c '\ngrep -H "solo-si-cambia=" scripts/check.d/*.sh | while read -r b r; do echo "$b"; done\n${'# relleno '.repeat(30)}'`;
    const apply = (input: Record<string, unknown>, at: number) => {
      const event = claudeHookEvent(input, at);
      if (event) tracker.apply('s1', event);
    };
    apply({ hook_event_name: 'UserPromptSubmit' }, 1);
    apply({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command } }, 2);
    // Whole (longer than the 120 characters of a tool's one-line detail), with its tool.
    expect(command.length).toBeGreaterThan(300);
    expect(tracker.get('s1')).toMatchObject({
      state: 'permission',
      asking: `Permission for Bash: ${command}`,
    });
    apply(
      {
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      },
      3
    );
    expect(tracker.get('s1')?.asking).toBe(`Permission for Bash: ${command}`);
    // The next prompt is its own.
    apply({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 4);
    apply(
      {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Write',
        tool_input: { file_path: '/repo/.git/config' },
      },
      5
    );
    expect(tracker.get('s1')?.asking).toBe('Permission for Write: /repo/.git/config');
  });
});

describe('Codex rollout events (recorded)', () => {
  it("bakery's task cut by its usage limit: halted with the reset it gave, twice", () => {
    const events = rolloutEvents('codex-rollout-usage-limit.jsonl');
    const halts = events.filter((event) => event.kind === 'halt');
    expect(halts).toHaveLength(2);
    expect(halts[0].halt?.kind).toBe('usage-limit');
    expect(halts[0].halt?.message).toContain('try again at 4:25 AM');
    // 4:25 AM on this machine's clock, the day it was hit.
    const cut = new Date(halts[0].at);
    expect(new Date(halts[0].halt?.resumeAt as number)).toEqual(
      new Date(
        cut.getFullYear(),
        cut.getMonth(),
        cut.getDate() + (cut.getHours() >= 5 ? 1 : 0),
        4,
        25
      )
    );
    const tracker = new AgentStateTracker();
    for (const event of events) tracker.apply('s1', event);
    expect(tracker.get('s1')).toMatchObject({
      state: 'halted',
      toolsOpen: 0,
      source: 'codex-rollout',
    });
    // Its automatic fix (the second turn) started and was cut again: a new turn each time.
    expect(events.filter((event) => event.kind === 'turn-start')).toHaveLength(2);
  });

  it('a normal Codex turn: working through its tool calls, over at task_complete with its message', () => {
    const events = rolloutEvents('codex-rollout-turn.jsonl');
    const tracker = new AgentStateTracker();
    let maxOpen = 0;
    for (const event of events) {
      tracker.apply('s1', event);
      if (event.kind !== 'turn-end') {
        expect(tracker.get('s1')?.state).toBe('working');
      }
      maxOpen = Math.max(maxOpen, tracker.get('s1')?.toolsOpen ?? 0);
    }
    expect(maxOpen).toBeGreaterThan(0);
    expect(tracker.get('s1')).toMatchObject({
      state: 'turn-ended',
      toolsOpen: 0,
      finalMessage: 'Done: the change is committed.',
    });
  });

  it("codex_error_info: a name or an object keyed by one; Codex's own policy errors are no halt", () => {
    expect(codexErrorKind('usage_limit_exceeded')).toBe('usage-limit');
    expect(codexErrorKind({ http_connection_failed: { http_status_code: 502 } })).toBe('api-error');
    expect(codexErrorKind('unauthorized')).toBe('auth');
    expect(codexErrorKind('context_window_exceeded')).toBeNull();
    expect(codexErrorKind('cyber_policy')).toBeNull();
    expect(codexErrorKind(undefined)).toBeNull();
  });

  it("a used-up limit's resets_at (token_count) is the halt's reset when there is one", () => {
    const reader = new CodexRolloutReader();
    const ts = (s: number) => new Date(1_793_494_000_000 + s * 1000).toISOString();
    reader.line(
      JSON.stringify({ timestamp: ts(0), type: 'event_msg', payload: { type: 'task_started' } })
    );
    reader.line(
      JSON.stringify({
        timestamp: ts(1),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 100, window_minutes: 300, resets_at: 1_793_510_000 },
          },
        },
      })
    );
    const halt = reader.line(
      JSON.stringify({
        timestamp: ts(2),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          error: {
            message: "You've hit your usage limit.",
            codex_error_info: 'usage_limit_exceeded',
          },
        },
      })
    );
    expect(halt?.halt?.resumeAt).toBe(1_793_510_000_000);
  });
});

describe("Claude's transcript: the API error a turn ended on", () => {
  it('the recorded failure is read from its isApiErrorMessage entry; a new prompt clears it', () => {
    const transcript = lines('claude-transcript-auth-failure.jsonl');
    expect(apiErrorFromLines(transcript)).toMatchObject({
      error: 'authentication_failed',
      text: 'Invalid API key · Fix external API key',
    });
    const prompt = JSON.stringify({
      type: 'user',
      isSidechain: false,
      message: { role: 'user', content: 'sigue' },
      timestamp: '2026-11-01T22:10:00.000Z',
    }).replace(/": /g, '":');
    expect(apiErrorFromLines([...transcript, prompt])).toBeUndefined();
  });
});

describe('Untether hooks for the Claude sessions it starts', () => {
  const settings = '/home/u/.untether/agent-hooks/claude-settings.json';

  it('only a command that starts Claude gets them, and only once', () => {
    expect(withClaudeHooks(['/usr/local/bin/claude', '--model', 'opus'], settings)).toEqual([
      '/usr/local/bin/claude',
      '--settings',
      settings,
      '--model',
      'opus',
    ]);
    // An alias resolved through the shell (process-utils buildShellCommandArgs).
    expect(
      withClaudeHooks(
        ['/bin/zsh', '-i', '-l', '-c', 'claude "$@"', '--', '--resume', 'abc'],
        settings
      )
    ).toEqual([
      '/bin/zsh',
      '-i',
      '-l',
      '-c',
      `claude --settings '${settings}' "$@"`,
      '--',
      '--resume',
      'abc',
    ]);
    // Its own settings are its own: left alone.
    const own = ['claude', '--settings', '/x.json'];
    expect(withClaudeHooks(own, settings)).toBe(own);
    const ownViaShell = ['/bin/zsh', '-ilc', 'claude "$@"', '--', '--settings=/x.json'];
    expect(withClaudeHooks(ownViaShell, settings)).toBe(ownViaShell);
    // Anything else is no Claude.
    for (const command of [
      ['codex'],
      ['/bin/zsh'],
      ['/bin/zsh', '-lc', 'claudette'],
      ['vim', 'claude'],
    ]) {
      expect(withClaudeHooks(command, settings)).toBe(command);
    }
  });

  it('the settings hold hooks only, every event to the script', () => {
    const value = hookSettings("/h/it's/claude-event.sh") as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(Object.keys(value)).toEqual(['hooks']);
    expect(Object.keys(value.hooks)).toEqual([...CLAUDE_HOOK_EVENTS]);
    expect(value.hooks.PreToolUse[0].matcher).toBe('*');
    expect(value.hooks.Stop[0].matcher).toBeUndefined();
    expect(value.hooks.Stop[0].hooks[0].command).toBe(`'/h/it'\\''s/claude-event.sh' Stop`);
  });

  describe('the script and the mailbox', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-hooks-'));
    });
    afterEach(() => {
      fs.rmSync(dir, RM_TEST_DIR);
    });

    /**
     * One run of the hook script. With a deadline: a synchronous child that never ends blocks
     * the worker's event loop, so vitest's own test timeout never fires (2026-11-03: a task's
     * related check sat 15 minutes on this file without a line and timed out). Killed past
     * it, the run fails here, saying so.
     */
    const run = (
      files: NonNullable<ReturnType<typeof ensureClaudeHookFiles>>,
      event: string,
      input: string,
      id?: string
    ) => {
      const result = spawnSync('/bin/sh', [files.script, event], {
        input,
        env: { PATH: process.env.PATH, ...(id ? { UNTETHER_SESSION_ID: id } : {}) },
        encoding: 'utf8',
        timeout: HOOK_RUN_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      if (result.error || result.signal) {
        throw new Error(
          `hook script ${event} did not finish within ${HOOK_RUN_TIMEOUT_MS} ms: ${result.error?.message ?? result.signal}`
        );
      }
      return result;
    };

    it('drops each event into its session mailbox, silent and always exit 0; the service reads them in order', () => {
      const files = ensureClaudeHookFiles(claudeHookFiles(path.join(dir, 'untether dir')));
      expect(files).not.toBeNull();
      if (!files) return;
      expect(fs.statSync(files.script).mode & 0o777).toBe(0o700);
      // The recorded turn, replayed through the real script.
      const recorded = lines('claude-hooks-turn.jsonl').map(
        (line) => JSON.parse(line) as { event: string; input: unknown }
      );
      for (const { event, input } of recorded) {
        const result = run(files, event, JSON.stringify(input), 'sess-1');
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
      }
      // Without a session id (a Claude not started by Untether): nothing written.
      expect(run(files, 'Stop', '{}').status).toBe(0);
      // A tool output of megabytes: its first 64 KB, still read for its state.
      const huge = JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_use_id: 'r1',
        tool_response: 'x'.repeat(HOOK_INPUT_MAX_BYTES * 3),
      });
      expect(run(files, 'PostToolUse', huge, 'sess-2').status).toBe(0);
      const names = fs.readdirSync(files.eventsDir).sort();
      expect(names).toEqual(['sess-1', 'sess-2']);
      const sess2 = fs.readdirSync(path.join(files.eventsDir, 'sess-2'));
      expect(fs.statSync(path.join(files.eventsDir, 'sess-2', sess2[0])).size).toBe(
        HOOK_INPUT_MAX_BYTES
      );

      const service = new AgentEventService({ eventsDir: files.eventsDir });
      expect(service.snapshot('sess-1')).toMatchObject({ state: 'ended', finalMessage: 'done' });
      // The events are taken; only the session's written state stays (across restarts).
      expect(fs.readdirSync(path.join(files.eventsDir, 'sess-1'))).toEqual([AGENT_STATE_FILE]);
      expect(service.snapshot('sess-2')).toMatchObject({
        state: 'working',
        lastActionAt: expect.any(Number),
      });
      expect(service.isCovered('sess-2')).toBe(true);
      // A session gone: its mailbox and state go with the next poll.
      service.poll(new Set(['sess-2']));
      expect(fs.existsSync(path.join(files.eventsDir, 'sess-1'))).toBe(false);
      expect(service.isCovered('sess-1')).toBe(false);
    });

    it("follows a Codex session's rollout as it grows", () => {
      const rollout = path.join(dir, 'rollout.jsonl');
      const all = lines('codex-rollout-turn.jsonl');
      fs.writeFileSync(rollout, `${all.slice(0, 5).join('\n')}\n`);
      const service = new AgentEventService({
        eventsDir: path.join(dir, 'events'),
        codexRollout: (id) => (id === 'c1' ? rollout : null),
      });
      expect(service.snapshot('c1')?.state).toBe('working');
      // A line written in two parts is read once whole.
      const rest = `${all.slice(5).join('\n')}\n`;
      fs.appendFileSync(rollout, rest.slice(0, 10));
      expect(service.snapshot('c1')?.state).toBe('working');
      fs.appendFileSync(rollout, rest.slice(10));
      expect(service.snapshot('c1')).toMatchObject({
        state: 'turn-ended',
        source: 'codex-rollout',
      });
      expect(service.snapshot('nope')).toBeUndefined();
    });
  });
});

describe('SignalLedger', () => {
  it('counts every decision by source and logs only the screen ones, once a minute', () => {
    let now = 0;
    const log = vi.fn();
    const ledger = new SignalLedger(log, () => now);
    ledger.record('halt', 'events', 's1');
    ledger.record('halt', 'screen', 's1', 'no events');
    ledger.record('halt', 'screen', 's1', 'no events');
    now += 61_000;
    ledger.record('agent-active', 'output', 's1');
    ledger.record('agent-active', 'output', 's1');
    expect(ledger.snapshot()).toEqual({
      halt: { events: 1, screen: 2 },
      'agent-active': { output: 2 },
    });
    expect(ledger.screenShare()).toEqual({ screen: 4, total: 5 });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toMatch(
      /\[agent-state\] halt decided from the screen \(session s1\): no events/
    );
  });
});

describe("a server restart keeps each agent's state (2026-11-03)", () => {
  // bakery 03-nov 00:30: after a restart the tracker knew nothing of a Claude busy in one
  // long Bash call, so the doctor called it hook-silent and the stall clock started over.
  let dir: string;
  let eventsDir: string;
  let seq = 0;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-agent-state-'));
    eventsDir = path.join(dir, 'events');
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  /** One hook event in the session's mailbox, as the hook script leaves it. */
  const hook = (id: string, event: string, at: number, input: Record<string, unknown> = {}) => {
    const mailbox = path.join(eventsDir, id);
    fs.mkdirSync(mailbox, { recursive: true });
    const file = path.join(mailbox, `${Math.floor(at / 1000)}-${++seq}-${event}.json`);
    fs.writeFileSync(file, JSON.stringify({ session_id: 'conv-1', ...input }));
    fs.utimesSync(file, at / 1000, at / 1000);
  };
  const stateFile = (id: string) => path.join(eventsDir, id, AGENT_STATE_FILE);
  const T0 = Date.UTC(2026, 10, 3, 0, 10);
  const MIN = 60_000;

  /** The bakery turn: a prompt, a tool call done, then a long Bash call still running. */
  const longCall = (id: string) => {
    hook(id, 'UserPromptSubmit', T0, { prompt: 'go' });
    hook(id, 'PreToolUse', T0 + MIN, { tool_name: 'Read', tool_use_id: 'r1' });
    hook(id, 'PostToolUse', T0 + 2 * MIN, { tool_name: 'Read', tool_use_id: 'r1' });
    hook(id, 'PreToolUse', T0 + 6 * MIN, {
      tool_name: 'Bash',
      tool_use_id: 'b1',
      tool_input: { command: 'pnpm run test run' },
    });
  };

  it('takes back the state, the open call and the progress clock; the call ends after it', () => {
    longCall('s1');
    let now = T0 + 7 * MIN;
    const before = new AgentEventService({ eventsDir, now: () => now });
    const was = before.snapshot('s1');
    expect(was).toMatchObject({
      state: 'working',
      toolsOpen: 1,
      waitingOn: { tool: 'Bash', since: T0 + 6 * MIN },
      lastProgressAt: T0 + 6 * MIN,
      turnStartedAt: T0,
      conversationId: 'conv-1',
    });
    // Written next to the mailbox, and not taken for an event.
    expect(fs.existsSync(stateFile('s1'))).toBe(true);
    expect(before.snapshot('s1')).toEqual(was);
    expect(fs.existsSync(stateFile('s1'))).toBe(true);

    // The server restarts: a new service, nothing in memory.
    now = T0 + 20 * MIN;
    const after = new AgentEventService({ eventsDir, now: () => now });
    expect(after.snapshot('s1')).toEqual(was);
    expect(after.isCovered('s1')).toBe(true);
    // The stall layer's clock and wait: the same as before the restart.
    expect(currentWait(after.snapshot('s1'), 'busy')).toEqual({
      what: 'Bash "pnpm run test run"',
      since: T0 + 6 * MIN,
    });
    expect(after.actedSince('s1', T0 + 19 * MIN)).toBe(true);

    // The call ends after the restart: paired with the call opened before it.
    hook('s1', 'PostToolUse', T0 + 21 * MIN, { tool_name: 'Bash', tool_use_id: 'b1' });
    hook('s1', 'Stop', T0 + 22 * MIN, { last_assistant_message: 'all green' });
    now = T0 + 23 * MIN;
    expect(after.snapshot('s1')).toMatchObject({
      state: 'turn-ended',
      toolsOpen: 0,
      lastProgressAt: T0 + 22 * MIN,
      finalMessage: 'all green',
    });
    expect(after.snapshot('s1')?.waitingOn).toBeUndefined();
  });

  it('writes a changed state at most every 2 s, and all of it on flush (shutdown)', () => {
    let now = T0;
    const service = new AgentEventService({ eventsDir, now: () => now });
    hook('s1', 'UserPromptSubmit', T0);
    service.snapshot('s1');
    hook('s1', 'PreToolUse', T0 + 500, { tool_name: 'Bash', tool_use_id: 'b1' });
    now = T0 + 500;
    service.snapshot('s1');
    const read = () => JSON.parse(fs.readFileSync(stateFile('s1'), 'utf8')).tracked;
    expect(read().state).toBe('working');
    expect(read().open).toEqual([]);
    service.flush(true);
    expect(read().open).toEqual([['b1', { tool: 'Bash', since: T0 + 500 }]]);
    // Nothing left behind by the atomic write.
    expect(fs.readdirSync(path.join(eventsDir, 's1'))).toEqual([AGENT_STATE_FILE]);
  });

  it('a long tool call across a restart is not called hook-silent', () => {
    longCall('s1');
    new AgentEventService({ eventsDir, now: () => T0 + 7 * MIN }).snapshot('s1');
    const serverStartedAt = T0 + 20 * MIN;
    const now = T0 + 30 * MIN;
    const service = new AgentEventService({ eventsDir, now: () => now });
    const session = (id: string) => {
      const agent = service.snapshot(id);
      return {
        sessionId: id,
        // The screen saw it busy right after the restart, and since.
        busySeenAt: serverStartedAt + 1000,
        lastEventAt: agent?.lastEventAt,
        waitingSince: agent?.waitingOn?.since,
      };
    };
    const check = (ids: string[], startedAt = serverStartedAt) =>
      agentEventsCheck({
        ensureHookFiles: () => true,
        sessions: () => ids.map(session),
        serverStartedAt: startedAt,
        now: () => now,
      }).run() as DoctorFinding[];
    expect(check(['s1'])).toEqual([]);

    // No call open and no event since the restart: silent once past the threshold after it.
    hook('s2', 'UserPromptSubmit', T0);
    hook('s2', 'Stop', T0 + MIN);
    new AgentEventService({ eventsDir, now: () => T0 + 2 * MIN }).snapshot('s2');
    expect(check(['s2'], now - HOOKS_SILENT_AFTER_MS / 2)).toEqual([]);
    expect(check(['s2']).map((finding) => finding.key)).toEqual(['agent-events:silent:s2']);
  });

  it('a session cleaned up takes its written state with it', () => {
    longCall('s1');
    longCall('s2');
    const service = new AgentEventService({ eventsDir, now: () => T0 + 7 * MIN });
    service.poll(new Set(['s1', 's2']));
    service.flush(true);
    expect(fs.existsSync(stateFile('s1'))).toBe(true);
    expect(fs.existsSync(stateFile('s2'))).toBe(true);
    service.forget('s1');
    expect(fs.existsSync(stateFile('s1'))).toBe(false);
    service.poll(new Set());
    expect(fs.existsSync(path.join(eventsDir, 's2'))).toBe(false);
    // Nothing to take back on the next start.
    expect(new AgentEventService({ eventsDir }).snapshot('s1')).toBeUndefined();
  });

  it('an unreadable or foreign state file is ignored: its events start over', () => {
    fs.mkdirSync(path.join(eventsDir, 's1'), { recursive: true });
    fs.writeFileSync(stateFile('s1'), '{"tracked":{"state":"dancing","since":1}}');
    const service = new AgentEventService({ eventsDir, now: () => T0 + MIN });
    expect(service.snapshot('s1')).toBeUndefined();
    hook('s1', 'UserPromptSubmit', T0);
    expect(service.snapshot('s1')).toMatchObject({ state: 'working', turnStartedAt: T0 });
  });

  it('reads a Codex rollout on from where the last run stopped, not from its tail again', () => {
    const rollout = path.join(dir, 'rollout.jsonl');
    const all = lines('codex-rollout-turn.jsonl');
    fs.writeFileSync(rollout, `${all.slice(0, 5).join('\n')}\n`);
    const options = { eventsDir, codexRollout: (id: string) => (id === 'c1' ? rollout : null) };
    const before = new AgentEventService(options);
    expect(before.snapshot('c1')?.state).toBe('working');
    before.flush(true);
    const written = JSON.parse(fs.readFileSync(stateFile('c1'), 'utf8'));
    expect(written.rollout).toEqual({ path: rollout, offset: fs.statSync(rollout).size });
    fs.appendFileSync(rollout, `${all.slice(5).join('\n')}\n`);
    const after = new AgentEventService(options);
    expect(after.snapshot('c1')).toMatchObject({ state: 'turn-ended', source: 'codex-rollout' });
  });
});

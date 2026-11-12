import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSuspension } from '../../shared/types.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  blockerKind,
  blockersForUser,
  type ClaudeLook,
  clampIdleMinutes,
  type ProcessView,
  processHolds,
  SessionSuspender,
  type SessionSuspenderDeps,
  type SuspendCandidate,
  type SuspendFacts,
  suspendBlockers,
  suspendedSessionsCheck,
  transcriptEndsCleanly,
  transcriptHolds,
} from './session-suspender.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const START = NOW - 5 * 60 * 60_000; // Claude started 5 h ago
const IDLE = 120 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

// Transcript lines in the shapes Claude Code 2.1.31x writes them on this Mac.
const userTurn = (at: number, text = 'hola') =>
  JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: text } });
const toolUse = (at: number, id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(at),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
const toolResult = (at: number, id: string, text: string, result?: Record<string, unknown>) =>
  JSON.stringify({
    type: 'user',
    timestamp: iso(at),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    ...(result ? { toolUseResult: result } : {}),
  });
const notification = (at: number, taskId: string, status?: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: iso(at),
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n${status ? `<status>${status}</status>\n` : ''}<summary>Background command "x" completed</summary>\n</task-notification>`,
    },
  });
const queuedNotification = (at: number, taskId: string, status: string) =>
  JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: iso(at),
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n</task-notification>`,
  });
const fire = (at: number, taskId: string, kind = 'loop') =>
  JSON.stringify({
    type: 'system',
    subtype: 'scheduled_task_fire',
    timestamp: iso(at),
    taskId,
    taskKind: kind,
    cronKind: kind,
  });
const endTurn = (at: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(at),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hecho' }],
      stop_reason: 'end_turn',
    },
  });

const T1 = START + 60_000;
const T2 = START + 120_000;
const T3 = START + 180_000;

describe('transcriptHolds', () => {
  it('a plain finished conversation holds nothing', () => {
    expect(transcriptHolds([userTurn(T1), endTurn(T2)], START, NOW)).toEqual([]);
  });

  it('a ScheduleWakeup not stopped and not fired holds; stop:true or its fire releases it', () => {
    const scheduled = [
      userTurn(T1),
      toolUse(T2, 'w1', 'ScheduleWakeup', { delaySeconds: 1200, prompt: 'x' }),
      toolResult(T2, 'w1', 'Next wakeup scheduled', { scheduledFor: NOW + 600_000 }),
    ];
    expect(transcriptHolds(scheduled, START, NOW)).toContain('a ScheduleWakeup is pending');
    // Fired, scheduled time past: the loop ended when that turn did not reschedule.
    const fired = [
      userTurn(T1),
      toolUse(T2, 'w1', 'ScheduleWakeup', { delaySeconds: 60, prompt: 'x' }),
      toolResult(T2, 'w1', 'Next wakeup scheduled', { scheduledFor: T2 + 60_000 }),
      fire(T3, '535bea9a'),
    ];
    expect(transcriptHolds(fired, START, NOW)).toEqual([]);
    const stopped = [
      ...scheduled.slice(0, 1),
      toolUse(T3, 'w2', 'ScheduleWakeup', { stop: true }),
      toolResult(T3, 'w2', 'stopped'),
    ];
    expect(transcriptHolds(stopped, START, NOW)).toEqual([]);
  });

  it('a CronCreate holds until its CronDelete; a one-shot that fired is gone', () => {
    const created = [
      toolUse(T1, 'c1', 'CronCreate', { cron: '13 * * * *', prompt: 'x' }),
      toolResult(T1, 'c1', 'Scheduled', { id: '7b8655d9', recurring: true }),
    ];
    expect(transcriptHolds(created, START, NOW)).toEqual([
      'cron job 7b8655d9 (CronCreate) is still scheduled',
    ]);
    const deleted = [
      ...created,
      toolUse(T2, 'c2', 'CronDelete', { id: '7b8655d9' }),
      toolResult(T2, 'c2', 'Deleted'),
    ];
    expect(transcriptHolds(deleted, START, NOW)).toEqual([]);
    const oneShot = [
      toolUse(T1, 'c1', 'CronCreate', { cron: '30 14 31 10 *', prompt: 'x', recurring: false }),
      toolResult(T1, 'c1', 'Scheduled', { id: 'aaaa1111', recurring: false }),
    ];
    expect(transcriptHolds(oneShot, START, NOW)).toHaveLength(1);
    expect(transcriptHolds([...oneShot, fire(T2, 'aaaa1111', 'cron')], START, NOW)).toEqual([]);
  });

  it('a CronCreate whose id cannot be read holds', () => {
    const lines = [
      toolUse(T1, 'c1', 'CronCreate', { cron: '13 * * * *', prompt: 'x' }),
      toolResult(T1, 'c1', 'Scheduled job'),
    ];
    expect(transcriptHolds(lines, START, NOW)).toContain(
      'a CronCreate whose job id could not be read'
    );
  });

  it('a background Bash holds until its notification says it finished', () => {
    const launched = [
      toolUse(T1, 'b1', 'Bash', { command: 'sleep 999', run_in_background: true }),
      toolResult(T1, 'b1', 'Command running in background with ID: bowyw94lx.', {
        backgroundTaskId: 'bowyw94lx',
      }),
    ];
    expect(transcriptHolds(launched, START, NOW)).toEqual([
      'Bash (background) bowyw94lx has not finished',
    ]);
    expect(
      transcriptHolds([...launched, notification(T2, 'bowyw94lx', 'completed')], START, NOW)
    ).toEqual([]);
    // Also when the notification only sits in Claude's queue.
    expect(
      transcriptHolds([...launched, queuedNotification(T2, 'bowyw94lx', 'failed')], START, NOW)
    ).toEqual([]);
    // A notification without a final status (a Monitor event) does not end it.
    expect(transcriptHolds([...launched, notification(T2, 'bowyw94lx')], START, NOW)).toHaveLength(
      1
    );
  });

  it('a background Agent or Workflow holds until its notification; TaskStop ends one', () => {
    const agent = [
      toolUse(T1, 'a1', 'Agent', { description: 'x', prompt: 'y' }),
      toolResult(T1, 'a1', 'Async agent launched successfully.\nagentId: af5e0f124fe01f6ad', {
        isAsync: true,
        status: 'async_launched',
        agentId: 'af5e0f124fe01f6ad',
      }),
    ];
    expect(transcriptHolds(agent, START, NOW)).toEqual([
      'Agent af5e0f124fe01f6ad has not finished',
    ]);
    expect(
      transcriptHolds([...agent, notification(T2, 'af5e0f124fe01f6ad', 'completed')], START, NOW)
    ).toEqual([]);
    const workflow = [
      toolUse(T1, 'f1', 'Workflow', { script: 'x' }),
      toolResult(T1, 'f1', 'Workflow launched in background. Task ID: wmstqknww', {
        status: 'async_launched',
        taskId: 'wmstqknww',
      }),
    ];
    expect(transcriptHolds(workflow, START, NOW)).toEqual(['Workflow wmstqknww has not finished']);
    const stopped = [
      ...workflow,
      toolUse(T2, 's1', 'TaskStop', { task_id: 'wmstqknww' }),
      toolResult(T2, 's1', 'Successfully stopped task'),
    ];
    expect(transcriptHolds(stopped, START, NOW)).toEqual([]);
    // A synchronous Agent (it returned its answer) holds nothing.
    const sync = [
      toolUse(T1, 'a2', 'Agent', { description: 'x', prompt: 'y' }),
      toolResult(T1, 'a2', 'Here is the answer', { status: 'completed' }),
    ];
    expect(transcriptHolds(sync, START, NOW)).toEqual([]);
  });

  it('a Monitor holds until it ends or its own timeout has passed', () => {
    const monitor = (timeoutMs: number) => [
      toolUse(T1, 'm1', 'Monitor', { command: 'tail -f x', timeout_ms: timeoutMs }),
      toolResult(T1, 'm1', 'Monitor started (task bx58f7hmo, expires in 15m)', {
        taskId: 'bx58f7hmo',
        timeoutMs,
        persistent: false,
      }),
    ];
    expect(transcriptHolds(monitor(10 * 60 * 60_000), START, NOW)).toEqual([
      'Monitor bx58f7hmo has not finished',
    ]);
    expect(transcriptHolds(monitor(15 * 60_000), START, NOW)).toEqual([]);
  });

  it('a tool call without its result holds (a turn cut short)', () => {
    expect(transcriptHolds([toolUse(T1, 'x1', 'Bash', { command: 'ls' })], START, NOW)).toEqual([
      'Bash call without its result',
    ]);
  });

  it('the last user turn being /loop or /ralph-loop holds', () => {
    const loop = userTurn(
      T1,
      '<command-name>/loop</command-name>\n<command-args>5m check</command-args>'
    );
    expect(transcriptHolds([loop], START, NOW)).toEqual(['the last command was /loop']);
    const ralph = userTurn(T1, '<command-name>/ralph-loop:ralph-loop</command-name>');
    expect(transcriptHolds([ralph], START, NOW)).toEqual([
      'the last command was /ralph-loop:ralph-loop',
    ]);
    expect(transcriptHolds([loop, userTurn(T2, 'otra cosa')], START, NOW)).toEqual([]);
  });

  it('only what this Claude process started counts', () => {
    const before = START - 60_000;
    const lines = [
      toolUse(before, 'b1', 'Bash', { command: 'sleep 9', run_in_background: true }),
      toolResult(before, 'b1', 'running in background with ID: old1', { backgroundTaskId: 'old1' }),
      toolUse(before, 'c1', 'CronCreate', { cron: '1 * * * *', prompt: 'x' }),
      toolResult(before, 'c1', 'x', { id: 'deadbeef' }),
    ];
    expect(transcriptHolds(lines, START, NOW)).toEqual([]);
  });

  it('a line that cannot be read holds', () => {
    expect(transcriptHolds(['{"type":"user", broken'], START, NOW)).toEqual([
      '1 transcript line(s) could not be read',
    ]);
  });

  it('task-notification text inside a tool call is not taken for one', () => {
    const lines = [
      toolUse(T1, 'b1', 'Bash', { command: 'sleep 9', run_in_background: true }),
      toolResult(T1, 'b1', 'running in background with ID: b77', { backgroundTaskId: 'b77' }),
      toolUse(T2, 'g1', 'Bash', {
        command: "grep '<task-notification><task-id>b77</task-id><status>completed</status>' x",
      }),
      toolResult(T2, 'g1', '<task-notification><task-id>b77</task-id><status>completed</status>'),
    ];
    expect(transcriptHolds(lines, START, NOW)).toEqual(['Bash (background) b77 has not finished']);
  });
});

describe('transcriptEndsCleanly', () => {
  it('needs a final newline and a whole JSON line', () => {
    expect(transcriptEndsCleanly(`${endTurn(T1)}\n`)).toBe(true);
    expect(transcriptEndsCleanly(endTurn(T1))).toBe(false);
    expect(transcriptEndsCleanly(`${endTurn(T1)}\n{"type":"assi\n`)).toBe(false);
  });
});

describe('processHolds', () => {
  const view = (
    children: Record<number, number[]>,
    args: Record<number, string>,
    starts: Record<number, number>
  ): ProcessView => ({
    children: new Map(Object.entries(children).map(([k, v]) => [Number(k), v])),
    args: new Map(Object.entries(args).map(([k, v]) => [Number(k), v])),
    startMs: (pid) => starts[pid],
  });
  const claude = 100;

  it('MCP servers (named so or started with Claude) and language servers are fine', () => {
    const v = view(
      { 100: [101, 102, 103, 104], 101: [201] },
      {
        100: 'claude --dangerously-skip-permissions',
        101: 'npm exec @cocal/google-calendar-mcp',
        201: 'node /x/google-calendar-mcp/build/index.js',
        102: 'node -e require("mcp-server.cjs")',
        103: '/Users/x/.config/youtube-uploader/uploader -client_secret_file y',
        104: '/Applications/Xcode.app/.../usr/bin/sourcekit-lsp',
      },
      { 100: START, 101: START + 1000, 102: START + 1000, 103: START + 3000, 104: START + 3600_000 }
    );
    expect(processHolds(v, claude)).toEqual([]);
  });

  it("a command of Claude's Bash tool, a shell, caffeinate, openclaw agent or a late child holds", () => {
    const v = view(
      { 100: [101, 102, 103, 104, 105] },
      {
        100: 'claude',
        101: '/bin/zsh -c -l source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh && eval sleep',
        102: 'caffeinate -i -t 300',
        103: 'node /opt/openclaw/openclaw.mjs agent --to x',
        104: 'node node_modules/.bin/vite --port 5173',
        105: '/bin/bash ./build.sh',
      },
      { 100: START, 101: NOW, 102: NOW, 103: NOW, 104: NOW, 105: NOW }
    );
    const holds = processHolds(v, claude);
    expect(holds.some((h) => h.includes('Bash tool'))).toBe(true);
    expect(holds.some((h) => h.includes('caffeinate'))).toBe(true);
    expect(holds.some((h) => h.includes('openclaw agent'))).toBe(true);
    expect(holds.some((h) => h.includes('vite'))).toBe(true);
    expect(holds.some((h) => h.includes('bash runs under Claude'))).toBe(true);
  });

  it('a Bash tool command deep under an MCP server still holds', () => {
    const v = view(
      { 100: [101], 101: [201] },
      {
        100: 'claude',
        101: 'npm exec some-mcp',
        201: 'zsh -c source ~/.claude/shell-snapshots/s.sh',
      },
      { 100: START, 101: START }
    );
    expect(processHolds(v, claude)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

function baseFacts(over: Partial<SuspendFacts> = {}): SuspendFacts {
  const session: SuspendCandidate = {
    id: 's1',
    status: 'running',
    shielded: true,
    command: ['/Users/x/.local/bin/claude', '--dangerously-skip-permissions'],
    workingDir: '/tmp',
    claudeSessionId: 'conv-1',
    lastInputAt: NOW - 3 * 60 * 60_000,
    lastOutputAt: NOW - 3 * 60 * 60_000,
  };
  return {
    session,
    idleMs: IDLE,
    now: NOW,
    claude: {
      status: 'idle',
      sessionId: 'conv-1',
      since: NOW - 3 * 60 * 60_000,
      pid: 100,
      startedAt: START,
    },
    transcriptPath: '/x/conv-1.jsonl',
    transcriptTail: `${endTurn(T2)}\n`,
    transcriptLines: [userTurn(T1), endTurn(T2), ''],
    screen: { draft: false, menu: false },
    watched: false,
    processHolds: [],
    heldBy: null,
    ralphLoop: false,
    ...over,
  };
}

describe('suspendBlockers: every rule keeps a session awake on its own', () => {
  it('an idle Claude session past every rule may be suspended', () => {
    expect(suspendBlockers(baseFacts())).toEqual([]);
  });

  const cases: Array<[string, (f: SuspendFacts) => SuspendFacts, RegExp]> = [
    ['Claude busy', (f) => ({ ...f, claude: { ...f.claude!, status: 'busy' } }), /Claude is busy/],
    [
      'a permission prompt (waiting)',
      (f) => ({ ...f, claude: { ...f.claude!, status: 'waiting', waitingFor: 'permission' } }),
      /Claude is waiting/,
    ],
    [
      'background work after the turn',
      (f) => ({ ...f, claude: { ...f.claude!, waitingForBackground: true } }),
      /background/,
    ],
    [
      'idle for less than the idle time',
      (f) => ({ ...f, claude: { ...f.claude!, since: NOW - 30 * 60_000 } }),
      /not idle for the whole/,
    ],
    [
      'a menu or question on screen',
      (f) => ({ ...f, screen: { draft: false, menu: true } }),
      /menu/,
    ],
    ['text in the input box', (f) => ({ ...f, screen: { draft: true, menu: false } }), /input box/],
    [
      'no input box seen',
      (f) => ({ ...f, screen: { draft: undefined, menu: false } }),
      /input box/,
    ],
    ['screen unreadable', (f) => ({ ...f, screen: undefined }), /screen not readable/],
    ['someone viewing it', (f) => ({ ...f, watched: true }), /looking at it/],
    [
      'recent input',
      (f) => ({ ...f, session: { ...f.session, lastInputAt: NOW - 60_000 } }),
      /input in the idle time/,
    ],
    [
      'recent output',
      (f) => ({ ...f, session: { ...f.session, lastOutputAt: NOW - 60_000 } }),
      /output in the idle time/,
    ],
    [
      'unknown output time',
      (f) => ({ ...f, session: { ...f.session, lastOutputAt: undefined } }),
      /output in the idle time/,
    ],
    [
      'no claudeSessionId',
      (f) => ({ ...f, claude: { ...f.claude!, sessionId: undefined } }),
      /no Claude conversation id/,
    ],
    ['no Claude status at all', (f) => ({ ...f, claude: undefined }), /no Claude status/],
    ['transcript missing', (f) => ({ ...f, transcriptPath: null }), /transcript not found/],
    [
      'transcript cut mid-line',
      (f) => ({ ...f, transcriptTail: '{"type":"assistant","mess' }),
      /complete entry/,
    ],
    [
      'a background shell under Claude',
      (f) => ({ ...f, processHolds: ["a command of Claude's Bash tool runs (pid 9)"] }),
      /Bash tool/,
    ],
    ['process tree unread', (f) => ({ ...f, processHolds: undefined }), /process tree not read/],
    [
      'a pending ScheduleWakeup',
      (f) => ({
        ...f,
        transcriptLines: [
          toolUse(T1, 'w', 'ScheduleWakeup', { delaySeconds: 600, prompt: 'x' }),
          toolResult(T1, 'w', 'ok', { scheduledFor: NOW + 60_000 }),
        ],
      }),
      /ScheduleWakeup/,
    ],
    [
      'a pending cron',
      (f) => ({
        ...f,
        transcriptLines: [
          toolUse(T1, 'c', 'CronCreate', { cron: '1 * * * *', prompt: 'x' }),
          toolResult(T1, 'c', 'ok', { id: 'abcd1234' }),
        ],
      }),
      /cron job abcd1234/,
    ],
    ['a ralph-loop', (f) => ({ ...f, ralphLoop: true }), /ralph-loop/],
    [
      'an orchestrator with open tasks',
      (f) => ({ ...f, heldBy: 'it orchestrates 2 open task(s)' }),
      /orchestrates 2 open/,
    ],
    [
      'a delivery queue',
      (f) => ({ ...f, heldBy: 'waiting to reach it: 1 queued task event(s)' }),
      /queued task event/,
    ],
    [
      "a task's session",
      (f) => ({ ...f, heldBy: 'task abcd1234 (verifying) runs in it' }),
      /verifying/,
    ],
    [
      'marked keep awake',
      (f) => ({ ...f, session: { ...f.session, keepAwake: true } }),
      /keep awake/,
    ],
    ['not shielded', (f) => ({ ...f, session: { ...f.session, shielded: false } }), /not shielded/],
    [
      'a terminal window or tmux session',
      (f) => ({ ...f, session: { ...f.session, external: true } }),
      /outside Untether/,
    ],
    [
      'Codex or a shell',
      (f) => ({ ...f, session: { ...f.session, command: ['codex'] } }),
      /not a Claude session/,
    ],
    [
      'another conversation than recorded',
      (f) => ({ ...f, claude: { ...f.claude!, sessionId: 'conv-2' } }),
      /another conversation/,
    ],
    [
      'Claude start time unknown',
      (f) => ({ ...f, claude: { ...f.claude!, startedAt: undefined } }),
      /start time unknown/,
    ],
  ];
  for (const [name, change, reason] of cases) {
    it(`holds: ${name}`, () => {
      const blockers = suspendBlockers(change(baseFacts()));
      expect(blockers.some((b) => reason.test(b))).toBe(true);
    });
  }
});

describe('clampIdleMinutes', () => {
  it('defaults to 120 and keeps at least 15 minutes', () => {
    expect(clampIdleMinutes(undefined)).toBe(120);
    expect(clampIdleMinutes(1)).toBe(15);
    expect(clampIdleMinutes(240)).toBe(240);
  });
});

// ---------------------------------------------------------------------------------------------

/** An in-memory stand-in for the PTY manager's session.json records. */
function harness(over: Partial<SessionSuspenderDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suspender-'));
  const transcript = path.join(dir, 'conv-1.jsonl');
  fs.writeFileSync(transcript, `${userTurn(T1)}\n${endTurn(T2)}\n`);
  const sessions = new Map<string, SuspendCandidate>([
    [
      's1',
      {
        id: 's1',
        status: 'running',
        shielded: true,
        command: ['claude', '--dangerously-skip-permissions', '--allowedTools', 'Bash(ut task:*)'],
        workingDir: dir,
        claudeSessionId: 'conv-1',
        lastOutputAt: NOW - 3 * 60 * 60_000,
      },
    ],
  ]);
  let claude: ClaudeLook | undefined = {
    status: 'idle',
    sessionId: 'conv-1',
    since: NOW - 3 * 60 * 60_000,
    pid: 100,
    startedAt: START,
  };
  const log: string[] = [];
  const suspend = vi.fn(async (id: string, record: SessionSuspension) => {
    const s = sessions.get(id)!;
    sessions.set(id, { ...s, status: 'exited', suspended: record });
    claude = undefined;
  });
  const resume = vi.fn(async (id: string) => {
    const s = sessions.get(id)!;
    sessions.set(id, {
      ...s,
      status: 'running',
      suspended: { ...(s.suspended as SessionSuspension), wakingAt: iso(NOW) },
    });
    claude = { status: 'idle', sessionId: 'conv-1', since: NOW, pid: 200, startedAt: NOW };
    return { ok: true as const };
  });
  const setSuspension = vi.fn((id: string, record: SessionSuspension | undefined) => {
    const s = sessions.get(id)!;
    sessions.set(id, { ...s, suspended: record });
  });
  const deps: SessionSuspenderDeps = {
    enabled: () => true,
    idleMinutes: () => 120,
    sessions: () => [...sessions.values()],
    claude: async () => claude,
    transcriptPath: () => transcript,
    screen: async () => ({ draft: false, menu: false }),
    watched: () => false,
    processView: async () => ({
      children: new Map([[100, [101]]]),
      args: new Map([
        [100, 'claude'],
        [101, 'npm exec some-mcp'],
      ]),
      startMs: (pid) => (pid === 100 || pid === 101 ? START : undefined),
    }),
    heldBy: () => null,
    suspend,
    resume,
    setSuspension,
    liveElsewhere: async () => false,
    log: (m) => log.push(m),
    warn: (m) => log.push(`WARN ${m}`),
    now: () => NOW,
    sleep: async () => {},
    wakeConfirmMs: 0,
    ...over,
  };
  // wakeConfirmMs 0 would never loop: give the loop one round with a moving clock.
  let clock = NOW;
  deps.now = over.now ?? (() => clock);
  deps.sleep =
    over.sleep ??
    (async () => {
      clock += 1000;
    });
  deps.wakeConfirmMs = over.wakeConfirmMs ?? 5000;
  return {
    dir,
    sessions,
    suspend,
    resume,
    setSuspension,
    log,
    suspender: new SessionSuspender(deps),
    /** Another server on the same sessions (a restart): nothing kept in memory. */
    restarted: () => new SessionSuspender(deps),
    setClaude: (look: ClaudeLook | undefined) => {
      claude = look;
    },
    resetClock: () => {
      clock = NOW;
    },
  };
}

describe('SessionSuspender', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => {
    fs.rmSync(h.dir, RM_TEST_DIR);
  });

  it('suspends an idle session with what it needs to wake, and Claude plus its MCP tree', async () => {
    expect(await h.suspender.tick()).toBe('s1');
    expect(h.suspend).toHaveBeenCalledTimes(1);
    const [id, record, tree] = h.suspend.mock.calls[0] as unknown as [
      string,
      SessionSuspension,
      number[],
    ];
    expect(id).toBe('s1');
    expect(record).toMatchObject({
      claudeSessionId: 'conv-1',
      command: ['claude', '--dangerously-skip-permissions', '--allowedTools', 'Bash(ut task:*)'],
      workingDir: h.dir,
      shielded: true,
      idleMinutes: 180,
    });
    expect(tree).toEqual([100, 101]);
    expect(h.log.some((line) => line.includes('session suspend: s1 suspended'))).toBe(true);
  });

  it('does nothing while the setting is off', async () => {
    const off = harness({ enabled: () => false });
    expect(await off.suspender.tick()).toBeNull();
    expect(off.suspend).not.toHaveBeenCalled();
    fs.rmSync(off.dir, RM_TEST_DIR);
  });

  it('suspends nothing when a rule holds (here: an orchestrator with a queued event)', async () => {
    const held = harness({ heldBy: () => 'waiting to reach it: 1 queued task event(s)' });
    expect(await held.suspender.tick()).toBeNull();
    expect(held.suspend).not.toHaveBeenCalled();
    // The cheap rules decide first: nothing else is read for a session they hold.
    expect(held.suspender.lastBlockers.get('s1')).toContain(
      'waiting to reach it: 1 queued task event(s)'
    );
    fs.rmSync(held.dir, RM_TEST_DIR);
  });

  it('a rule that changes between the look and the stop keeps it awake (looked at twice)', async () => {
    let looks = 0;
    const racing = harness({
      watched: () => {
        looks++;
        return looks > 1;
      },
    });
    expect(await racing.suspender.tick()).toBeNull();
    expect(racing.suspend).not.toHaveBeenCalled();
    fs.rmSync(racing.dir, RM_TEST_DIR);
  });

  it('wakes the same session id and clears the record once Claude is back on its conversation', async () => {
    await h.suspender.tick();
    expect(h.suspender.isSuspended('s1')).toBe(true);
    const woke = await h.suspender.wake('s1', 'a task event');
    expect(woke).toEqual({ ok: true, sessionId: 's1' });
    expect(h.resume).toHaveBeenCalledWith('s1');
    expect(h.sessions.get('s1')?.suspended).toBeUndefined();
    expect(h.sessions.get('s1')?.status).toBe('running');
    expect(h.log.some((line) => line.includes('s1 woke (a task event)'))).toBe(true);
  });

  it('delivering to a suspended session wakes it first, then delivers', async () => {
    await h.suspender.tick();
    const order: string[] = [];
    h.resume.mockImplementationOnce(async (id: string) => {
      order.push('wake');
      const s = h.sessions.get(id)!;
      h.sessions.set(id, { ...s, status: 'running' });
      h.setClaude({ status: 'idle', sessionId: 'conv-1', since: NOW, pid: 200, startedAt: NOW });
      return { ok: true as const };
    });
    // What server.ts does around every deliverer (orchestrator, tasks, API input).
    const deliver = async (text: string) => {
      if (!(await h.suspender.ensureAwake('s1', 'orchestrator message'))) return false;
      order.push(`typed ${text}`);
      return true;
    };
    expect(await deliver('[untether] task ready')).toBe(true);
    expect(order).toEqual(['wake', 'typed [untether] task ready']);
  });

  it('two wakes at once share one resume', async () => {
    await h.suspender.tick();
    const [a, b] = await Promise.all([
      h.suspender.wake('s1', 'tap'),
      h.suspender.wake('s1', 'input'),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(h.resume).toHaveBeenCalledTimes(1);
  });

  it('a failed wake leaves it suspended with the error, warns and alerts; nothing is typed', async () => {
    const alert = vi.fn();
    const failing = harness({
      resume: async () => ({ ok: false, error: 'cannot start claude' }),
      alert,
    });
    await failing.suspender.tick();
    expect(await failing.suspender.ensureAwake('s1', 'input')).toBe(false);
    const record = failing.sessions.get('s1')?.suspended;
    expect(record?.resumeError).toBe('cannot start claude');
    expect(failing.sessions.get('s1')?.status).toBe('exited');
    expect(alert).toHaveBeenCalledWith('s1', 'cannot start claude');
    expect(failing.log.some((line) => line.startsWith('WARN') && line.includes('failed'))).toBe(
      true
    );
    fs.rmSync(failing.dir, RM_TEST_DIR);
  });

  it('never wakes a conversation that runs outside Untether right now', async () => {
    const elsewhere = harness({ liveElsewhere: async () => true });
    await elsewhere.suspender.tick();
    const woke = await elsewhere.suspender.wake('s1', 'tap');
    expect(woke.ok).toBe(false);
    expect(elsewhere.resume).not.toHaveBeenCalled();
    fs.rmSync(elsewhere.dir, RM_TEST_DIR);
  });

  it('a Claude that ends right after resuming is a failed wake', async () => {
    const dying = harness();
    await dying.suspender.tick();
    dying.resume.mockImplementationOnce(async (id: string) => {
      const s = dying.sessions.get(id)!;
      dying.sessions.set(id, { ...s, status: 'exited' });
      return { ok: true as const };
    });
    const woke = await dying.suspender.wake('s1', 'tap');
    expect(woke).toEqual({ ok: false, error: 'Claude ended right after resuming' });
    expect(dying.sessions.get('s1')?.suspended?.resumeError).toBe(
      'Claude ended right after resuming'
    );
    fs.rmSync(dying.dir, RM_TEST_DIR);
  });

  it('an unchanged transcript is not read again on every look; a changed one is', async () => {
    const reads: string[] = [];
    const cron = harness({
      readFile: (file) => {
        reads.push(file);
        return fs.readFileSync(file, 'utf8');
      },
    });
    const transcript = path.join(cron.dir, 'conv-1.jsonl');
    fs.writeFileSync(
      transcript,
      `${toolUse(T1, 'c', 'CronCreate', { cron: '1 * * * *', prompt: 'x' })}\n${toolResult(T1, 'c', 'ok', { id: 'abcd1234' })}\n`
    );
    expect(await cron.suspender.tick()).toBeNull();
    expect(await cron.suspender.tick()).toBeNull();
    expect(reads).toHaveLength(1);
    expect(cron.suspender.lastBlockers.get('s1')).toContain(
      'cron job abcd1234 (CronCreate) is still scheduled'
    );
    fs.appendFileSync(
      transcript,
      `${toolUse(T2, 'd', 'CronDelete', { id: 'abcd1234' })}\n${toolResult(T2, 'd', 'ok')}\n`
    );
    expect(await cron.suspender.tick()).toBe('s1');
    expect(reads.length).toBeGreaterThan(1);
    fs.rmSync(cron.dir, RM_TEST_DIR);
  });

  it('a Claude that changed at the very last look is not stopped', async () => {
    let calls = 0;
    const base = {
      status: 'idle',
      sessionId: 'conv-1',
      since: NOW - 3 * 60 * 60_000,
      pid: 100,
      startedAt: START,
    };
    const racing = harness({
      claude: async () => {
        calls++;
        // inspect, inspect again, then the last look right before stopping: now busy.
        return calls >= 3 ? { ...base, status: 'busy', since: NOW } : base;
      },
    });
    expect(await racing.suspender.tick()).toBeNull();
    expect(racing.suspend).not.toHaveBeenCalled();
    expect(racing.suspender.lastBlockers.get('s1')).toEqual([
      'Claude changed right before suspending',
    ]);
    fs.rmSync(racing.dir, RM_TEST_DIR);
  });

  it('input typed while it was being stopped wakes it again and is typed in', async () => {
    const sent: unknown[] = [];
    const typed = harness({ sendInput: (_id, input) => sent.push(input) });
    // As the PTY manager does: the held input goes on disk with the suspension.
    typed.suspend.mockImplementationOnce(async (id: string, record: SessionSuspension) => {
      const s = typed.sessions.get(id)!;
      typed.sessions.set(id, {
        ...s,
        status: 'exited',
        suspended: { ...record, pendingInput: [{ text: 'hola' }] },
      });
      return { heldInput: [{ text: 'hola' }] };
    });
    expect(await typed.suspender.tick()).toBe('s1');
    expect(typed.resume).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ text: 'hola' }]);
    expect(typed.sessions.get('s1')?.suspended).toBeUndefined();
    fs.rmSync(typed.dir, RM_TEST_DIR);
  });

  it('held input survives a failed wake on disk and the next good wake types it', async () => {
    const sent: unknown[] = [];
    let fails = true;
    const flaky = harness({
      sendInput: (_id, input) => sent.push(input),
      resume: async (id: string) => {
        if (fails) return { ok: false as const, error: 'tmux busy' };
        const s = flaky.sessions.get(id)!;
        flaky.sessions.set(id, { ...s, status: 'running' });
        flaky.setClaude({
          status: 'idle',
          sessionId: 'conv-1',
          since: NOW,
          pid: 300,
          startedAt: NOW,
        });
        return { ok: true as const };
      },
    });
    flaky.suspend.mockImplementationOnce(async (id: string, record: SessionSuspension) => {
      const s = flaky.sessions.get(id)!;
      flaky.sessions.set(id, {
        ...s,
        status: 'exited',
        suspended: { ...record, pendingInput: [{ text: 'sigue' }] },
      });
      return { heldInput: [{ text: 'sigue' }] };
    });
    expect(await flaky.suspender.tick()).toBe('s1');
    expect(sent).toEqual([]);
    const kept = flaky.sessions.get('s1')?.suspended;
    expect(kept?.resumeError).toBe('tmux busy');
    expect(kept?.pendingInput).toEqual([{ text: 'sigue' }]);
    fails = false;
    expect((await flaky.suspender.wake('s1', 'tap', { byUser: true })).ok).toBe(true);
    expect(sent).toEqual([{ text: 'sigue' }]);
    expect(flaky.sessions.get('s1')?.suspended).toBeUndefined();
    fs.rmSync(flaky.dir, RM_TEST_DIR);
  });

  it('after a failed wake, automatic wakes wait; the user can retry at once; one alert', async () => {
    const alert = vi.fn();
    let fails = true;
    const broken = harness({
      alert,
      resume: async (id: string) => {
        if (fails) return { ok: false as const, error: 'cannot start claude' };
        const s = broken.sessions.get(id)!;
        broken.sessions.set(id, { ...s, status: 'running' });
        broken.setClaude({
          status: 'idle',
          sessionId: 'conv-1',
          since: NOW,
          pid: 300,
          startedAt: NOW,
        });
        return { ok: true as const };
      },
    });
    await broken.suspender.tick();
    expect((await broken.suspender.wake('s1', 'orchestrator message')).ok).toBe(false);
    // A queued event retried a moment later: no new attempt, no new alert.
    const again = await broken.suspender.wake('s1', 'orchestrator message');
    expect(again).toEqual({ ok: false, error: 'its last wake failed: cannot start claude' });
    expect((await broken.suspender.wake('s1', 'tap', { byUser: true })).ok).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
    fails = false;
    expect((await broken.suspender.wake('s1', 'tap', { byUser: true })).ok).toBe(true);
    fs.rmSync(broken.dir, RM_TEST_DIR);
  });

  it('a restart keeps the wait after a failed wake and does not alert again (2026-11-02)', async () => {
    const alert = vi.fn();
    const resume = vi.fn(async () => ({ ok: false as const, error: 'cannot start claude' }));
    const broken = harness({ alert, resume });
    await broken.suspender.tick();
    expect((await broken.suspender.wake('s1', 'orchestrator message')).ok).toBe(false);
    const next = broken.restarted();
    expect(await next.wake('s1', 'orchestrator message')).toEqual({
      ok: false,
      error: 'its last wake failed: cannot start claude',
    });
    expect(resume).toHaveBeenCalledTimes(1);
    // The user's tap still tries now: failed again, still one alert for the run of failures.
    expect((await next.wake('s1', 'tap', { byUser: true })).ok).toBe(false);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledTimes(1);
    fs.rmSync(broken.dir, RM_TEST_DIR);
  });

  it('a session that is not suspended wakes as a no-op', async () => {
    expect(await h.suspender.wake('s1', 'input')).toEqual({ ok: true, sessionId: 's1' });
    expect(h.resume).not.toHaveBeenCalled();
  });

  it('after a restart: a suspension cut short (Claude still runs) is dropped', async () => {
    h.sessions.set('s1', {
      ...h.sessions.get('s1')!,
      suspended: {
        at: iso(NOW),
        claudeSessionId: 'conv-1',
        command: ['claude'],
        workingDir: h.dir,
        shielded: true,
        idleMinutes: 130,
      },
    });
    await h.suspender.reconcile();
    expect(h.sessions.get('s1')?.suspended).toBeUndefined();
  });
});

describe('reconcile after a restart during a wake (2026-11-10)', () => {
  it('a session that runs is no longer suspended, even before its Claude reports; its held input goes in', async () => {
    const sent: unknown[] = [];
    // Its Claude has not written its state yet.
    const h = harness({
      sendInput: (_id, input) => sent.push(input),
      claude: async () => undefined,
    });
    h.sessions.set('s1', {
      ...h.sessions.get('s1')!,
      status: 'running',
      suspended: {
        at: iso(NOW),
        wakingAt: iso(NOW),
        claudeSessionId: 'conv-1',
        command: ['claude'],
        workingDir: h.dir,
        shielded: true,
        idleMinutes: 130,
        pendingInput: [{ text: 'hola' }],
      } as SessionSuspension,
    });
    await h.suspender.reconcile();
    expect(h.sessions.get('s1')?.suspended).toBeUndefined();
    expect(sent).toEqual([{ text: 'hola' }]);
    fs.rmSync(h.dir, RM_TEST_DIR);
  });
});

describe('suspendedSessionsCheck', () => {
  const record: SessionSuspension = {
    at: iso(NOW - 3600_000),
    claudeSessionId: 'conv-1',
    command: ['claude'],
    workingDir: '/tmp',
    shielded: true,
    idleMinutes: 125,
  };
  it('records each suspension and warns on a failed wake', () => {
    const findings = suspendedSessionsCheck({
      enabled: () => true,
      now: () => NOW,
      sessions: () => [
        { id: 'aaaaaaaa-1', title: 'A', status: 'exited', suspended: record },
        {
          id: 'bbbbbbbb-2',
          title: 'B',
          status: 'exited',
          suspended: { ...record, resumeError: 'boom', resumeErrorAt: iso(NOW) },
        },
      ],
    }).run() as Array<{ severity: string; problem: string }>;
    expect(findings.map((f) => f.severity)).toEqual(['info', 'warning']);
    expect(findings[1].problem).toContain('could not wake');
  });
});

// 2026-10-31: "Suspender" in a session's menu (web and phone): the same rules and safe stop as
// the idle look, without its idle time; anything that keeps it awake is answered, by kind.
describe('SessionSuspender.suspendByUser', () => {
  const RECENT = NOW - 60_000;
  let h: ReturnType<typeof harness>;
  /** A session the user just used: output and input a minute ago, Claude idle for a minute. */
  function justUsed(
    over: Partial<SessionSuspenderDeps> = {},
    session: Partial<SuspendCandidate> = {}
  ) {
    h = harness({ watched: () => true, ...over });
    const s1 = h.sessions.get('s1') as SuspendCandidate;
    h.sessions.set('s1', { ...s1, lastOutputAt: RECENT, lastInputAt: RECENT, ...session });
    h.setClaude({ status: 'idle', sessionId: 'conv-1', since: RECENT, pid: 100, startedAt: START });
    return h;
  }
  afterEach(() => {
    fs.rmSync(h.dir, RM_TEST_DIR);
  });

  it('suspends at once a session used a minute ago, watched and marked keep awake', async () => {
    justUsed({ enabled: () => false }, { keepAwake: true });
    // The idle look leaves it alone…
    expect(await h.suspender.tick()).toBeNull();
    expect(h.suspend).not.toHaveBeenCalled();
    // …the user's request suspends it, through the same safe stop (Claude and its MCP tree).
    expect(await h.suspender.suspendByUser('s1')).toEqual({ ok: true, sessionId: 's1' });
    expect(h.suspend).toHaveBeenCalledTimes(1);
    const [, record, tree, lastInput] = h.suspend.mock.calls[0] as unknown as [
      string,
      SessionSuspension,
      number[],
      number,
    ];
    expect(record).toMatchObject({ claudeSessionId: 'conv-1', byUser: true, shielded: true });
    expect(tree).toEqual([100, 101]);
    expect(lastInput).toBe(RECENT);
    expect(h.suspender.isSuspended('s1')).toBe(true);
  });

  const cases: Array<{
    name: string;
    kind: string;
    over?: Partial<SessionSuspenderDeps>;
    session?: Partial<SuspendCandidate>;
    claude?: Partial<ClaudeLook>;
    transcript?: string[];
  }> = [
    { name: 'a turn running', kind: 'busy', claude: { status: 'busy' } },
    { name: 'Claude waiting for an answer', kind: 'question', claude: { status: 'waiting' } },
    {
      name: 'a menu or question on screen',
      kind: 'question',
      over: { screen: async () => ({ draft: false, menu: true }) },
    },
    {
      name: 'text typed in its input box',
      kind: 'draft',
      over: { screen: async () => ({ draft: true, menu: false }) },
    },
    {
      name: 'a background shell',
      kind: 'background',
      over: {
        processView: async () => ({
          children: new Map([[100, [101, 102]]]),
          args: new Map([
            [100, 'claude'],
            [101, 'npm exec some-mcp'],
            [
              102,
              '/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh && eval sleep 100',
            ],
          ]),
          startMs: (pid) => (pid === 102 ? NOW : START),
        }),
      },
    },
    {
      name: 'a pending ScheduleWakeup',
      kind: 'scheduled',
      transcript: [
        userTurn(T1),
        toolUse(T2, 'w1', 'ScheduleWakeup', { delaySeconds: 1200, prompt: 'x' }),
        toolResult(T2, 'w1', 'scheduled', { scheduledFor: NOW + 600_000 }),
        endTurn(T3),
      ],
    },
    {
      name: "an orchestrator's open tasks",
      kind: 'tasks',
      over: { heldBy: () => 'it orchestrates 2 open task(s)' },
    },
    { name: 'a session that is not shielded', kind: 'notAllowed', session: { shielded: false } },
  ];
  for (const c of cases) {
    it(`does not suspend with ${c.name}, and says so (${c.kind})`, async () => {
      justUsed(c.over, c.session);
      if (c.claude) {
        h.setClaude({
          status: 'idle',
          sessionId: 'conv-1',
          since: RECENT,
          pid: 100,
          startedAt: START,
          ...c.claude,
        });
      }
      if (c.transcript)
        fs.writeFileSync(path.join(h.dir, 'conv-1.jsonl'), `${c.transcript.join('\n')}\n`);
      const result = await h.suspender.suspendByUser('s1');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.blockers.map((b) => b.kind)).toContain(c.kind);
      // Only what the user can act on: not the "could not read" that follow from it.
      if (c.kind !== 'notAllowed') {
        expect(result.blockers.map((b) => b.kind)).not.toContain('unknown');
      }
      expect(h.suspend).not.toHaveBeenCalled();
      expect(h.suspender.isSuspended('s1')).toBe(false);
    });
  }

  it('text typed during the last look keeps it awake (the draft is never thrown away)', async () => {
    // First look clean, the second (right before the stop) sees text: not suspended.
    let looks = 0;
    justUsed({
      screen: async () => ({ draft: looks++ > 0, menu: false }),
    });
    const result = await h.suspender.suspendByUser('s1');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.blockers.map((b) => b.kind)).toContain('draft');
    expect(h.suspend).not.toHaveBeenCalled();
  });

  it('input that arrives during the stop cancels it and is answered as busy', async () => {
    justUsed({
      suspend: vi.fn(async () => {
        throw new Error('Input arrived since the last look');
      }),
    });
    const result = await h.suspender.suspendByUser('s1');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.blockers.map((b) => b.kind)).toEqual(['busy']);
  });

  it('a session already being suspended by the idle look is not suspended twice', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const suspend = vi.fn(async (id: string, record: SessionSuspension) => {
      await gate;
      const s = h.sessions.get(id) as SuspendCandidate;
      h.sessions.set(id, { ...s, status: 'exited', suspended: record });
    });
    h = harness({ suspend });
    const tick = h.suspender.tick();
    await vi.waitFor(() => expect(suspend).toHaveBeenCalledTimes(1));
    const byUser = await h.suspender.suspendByUser('s1');
    expect(byUser).toMatchObject({ ok: false });
    release();
    expect(await tick).toBe('s1');
    expect(suspend).toHaveBeenCalledTimes(1);
  });
});

describe('blockerKind', () => {
  it('sorts every reason the rules give into what the user is told', () => {
    const kinds: Record<string, string> = {
      'session is exited': 'notAllowed',
      'already suspended': 'notAllowed',
      'not shielded (only shielded sessions resume in place)': 'notAllowed',
      'runs outside Untether (terminal window or tmux)': 'notAllowed',
      'not a Claude session': 'notAllowed',
      'Claude is busy': 'busy',
      'Claude is waiting': 'question',
      'Claude is waiting on background work': 'background',
      'Claude was not idle for the whole idle time': 'busy',
      'Claude changed right before suspending': 'busy',
      'Bash call without its result': 'busy',
      'transcript does not end with a complete entry': 'busy',
      'text in its input box (or no input box seen)': 'draft',
      'a menu or question is on screen': 'question',
      'a ScheduleWakeup is pending': 'scheduled',
      'cron job abc (CronCreate) is still scheduled': 'scheduled',
      'a CronCreate whose job id could not be read': 'scheduled',
      'the last command was /loop': 'scheduled',
      'a ralph-loop is active in its folder': 'scheduled',
      'Monitor t1 has not finished': 'scheduled',
      'Bash (background) b1 has not finished': 'background',
      'Agent a1 has not finished': 'background',
      'a Workflow whose task id could not be read': 'background',
      "a command of Claude's Bash tool runs (pid 9)": 'background',
      'openclaw agent runs (pid 9)': 'background',
      'vite runs under Claude (pid 9)': 'background',
      'a process under Claude is not an MCP server: x (pid 9)': 'background',
      'task 1234abcd (running) runs in it': 'tasks',
      'it orchestrates 2 open task(s)': 'tasks',
      'waiting to reach it: 3 event(s)': 'tasks',
      'could not be suspended: Input arrived since the last look': 'busy',
      'screen not readable': 'unknown',
      'process tree not read': 'unknown',
      'no Claude status': 'unknown',
    };
    for (const [reason, kind] of Object.entries(kinds)) {
      expect([reason, blockerKind(reason)]).toEqual([reason, kind]);
    }
  });

  it('leaves out the unknowns that follow from a known reason, keeps them when alone', () => {
    expect(blockersForUser(['Claude is busy', 'screen not readable'])).toEqual([
      { kind: 'busy', reason: 'Claude is busy' },
    ]);
    expect(blockersForUser(['screen not readable'])).toEqual([
      { kind: 'unknown', reason: 'screen not readable' },
    ]);
  });
});

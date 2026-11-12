/**
 * A task stopped on a prompt of its agent's own (2026-11-10, bakery 3dc243e4): Claude Code
 * asked permission for four `bash -c '…'` calls of its background subagents although it ran
 * with --dangerously-skip-permissions, and the task sat hours on «needs you · permission
 * prompt». Its orchestrator could not read the prompt, `ut task send` waited behind it and
 * `ut task retry` only said "The task is needs_you".
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROMPT_ESCALATE_MS } from '../../shared/agent-prompt.js';
import type { ScreenChoices } from '../../shared/claude-screen.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { AgentSnapshot } from './agent-events.js';
import type { ClaudeStatus } from './claude-chat.js';
import type { NotificationPayload } from './push-notification-service.js';
import { type NewTask, TaskScheduler, type TaskSchedulerDeps } from './task-scheduler.js';

const T0 = new Date('2026-11-10T08:19:00Z').getTime();
const OPTIONS = [
  'Yes',
  "Yes, and don't ask again for bash -c commands in this folder",
  'No, and tell Claude what to do differently (esc)',
];
const GREP = `bash -c '\ngrep -H "solo-si-cambia=" scripts/check.d/*.sh | while read -r b r; do echo "$b"; done\n'`;

const menuOf = (command: string): ScreenChoices => ({
  question: 'Do you want to proceed?',
  options: OPTIONS,
  detail: ['Bash command', command.split('\n')[0]],
  numbered: true,
  key: `key ${command}`,
});

const waiting: ClaudeStatus = {
  status: 'waiting',
  waitingFor: 'permission prompt',
} as ClaudeStatus;
const busy = { status: 'busy' } as ClaudeStatus;

describe("a task stopped on its agent's own prompt has a way out (3dc243e4, 2026-11-10)", () => {
  let dir: string;
  let notify: ReturnType<typeof vi.fn>;
  let statuses: Map<string, string>;
  let scheduler: TaskScheduler;
  let menu: ScreenChoices | null;
  let asking: string | undefined;
  let answered: Array<{ sessionId: string; option: number }>;
  let deliver: ReturnType<typeof vi.fn>;
  let waitingWhy: Array<{ id: string; why: string }>;

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    let n = 0;
    scheduler = new TaskScheduler({
      storePath: path.join(dir, 'tasks.json'),
      launch: (async () => ({ sessionId: `s${++n}` })) as unknown as TaskSchedulerDeps['launch'],
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: (id) => statuses.get(id),
      now: () => Date.now(),
      readPrompt: async () => menu,
      answerPrompt: async (sessionId, _menu, option) => {
        answered.push({ sessionId, option });
        menu = null;
        return 'ok';
      },
      agentState: () =>
        asking
          ? ({ state: 'permission', asking, since: T0, lastEventAt: T0 } as AgentSnapshot)
          : undefined,
      deliver: deliver as unknown as TaskSchedulerDeps['deliver'],
      messageWaiting: (id, why) => waitingWhy.push({ id, why }),
      inputRetryMs: 1000,
      inputWaitMs: 10,
      ...extra,
    });
    return scheduler;
  };

  /** An orchestrator's task whose Claude went from work to a permission prompt. */
  async function onPrompt(command = GREP, over: Partial<NewTask> = {}): Promise<TaskRecord> {
    await scheduler.start(0);
    const created = await scheduler.create({
      name: 'Revisión completa',
      prompt: 'Revisa',
      workingDir: '/Users/me/Projects/app',
      command: ['claude', '--dangerously-skip-permissions'],
      agent: 'claude',
      shielded: true,
      notify: true,
      origin: 'orchestrator',
      orchestratorSessionId: 'orch-1',
      ...over,
    });
    statuses.set('s1', 'running');
    menu = menuOf(command);
    asking = `Permission for Bash: ${command}`;
    scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
    scheduler.onClaudeTransition('s1', 'busy', 'waiting', waiting);
    await scheduler.settled();
    return scheduler.get(created.id) as TaskRecord;
  }

  const pushes = () => notify.mock.calls.map(([payload]) => payload as NotificationPayload);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-task-prompt-'));
    notify = vi.fn();
    statuses = new Map();
    menu = null;
    asking = undefined;
    answered = [];
    waitingWhy = [];
    deliver = vi.fn(async () => false);
  });

  afterEach(() => {
    scheduler?.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('what the prompt asks is on the task: its whole command, its question and its options', async () => {
    make();
    const task = await onPrompt();
    expect(task).toMatchObject({
      state: 'needs_you',
      blocker: {
        kind: 'permission',
        fromPrompt: true,
        prompt: {
          question: 'Do you want to proceed?',
          options: OPTIONS,
          asks: `Permission for Bash: ${GREP}`,
        },
      },
    });
    expect(task.blocker?.prompt?.deletes).toBeUndefined();
    // Its orchestrator is told what it asks and how to answer, once.
    const told = pushes().filter((payload) => payload.body.includes('Its agent asks'));
    expect(told).toHaveLength(1);
    expect(told[0].data?.toUser).toBeUndefined();
    // The same prompt read again (each tick) is no news.
    await scheduler.checkExited();
    await scheduler.settled();
    expect(pushes().filter((payload) => payload.body.includes('Its agent asks'))).toHaveLength(1);
  });

  it('its orchestrator approves a prompt that deletes nothing: the plain Yes, and it goes on', async () => {
    make();
    const task = await onPrompt();
    const result = await scheduler.answerPrompt(task.id, { kind: 'approve' }, { byAgent: true });
    expect(result.ok).toBe(true);
    expect(answered).toEqual([{ sessionId: 's1', option: 1 }]);
    scheduler.onClaudeTransition('s1', 'waiting', 'busy', busy);
    expect(scheduler.get(task.id)).toMatchObject({ state: 'working' });
    expect(scheduler.get(task.id)?.blocker).toBeUndefined();
  });

  it('never approves a deletion for an agent: refused, nothing typed, the user told on the phone', async () => {
    make();
    const rm = 'D="${TMPDIR:-/tmp}/rv"; mkdir -p "$D"; cd "$D"\nrm -rf "$D"/*';
    const task = await onPrompt(rm);
    // The screen shows only its first line; what its own event said it asks has the rm.
    expect(menu?.detail?.join(' ')).not.toContain('rm -rf');
    expect(task.blocker?.prompt?.deletes).toBe(true);
    for (const answer of [{ kind: 'approve' }, { kind: 'option', option: 1 }] as const) {
      const result = await scheduler.answerPrompt(task.id, answer, { byAgent: true });
      expect(result).toMatchObject({ ok: false, code: 'needs-user' });
    }
    expect(answered).toEqual([]);
    await scheduler.settled();
    const toUser = pushes().filter((payload) => payload.data?.toUser === true);
    expect(toUser).toHaveLength(1);
    expect(toUser[0]).toMatchObject({ type: 'task-needs-you' });
    expect(toUser[0].body).toContain('only you approve');
    // Denying it is the agent's to do; approving it, the user's.
    const denied = await scheduler.answerPrompt(task.id, { kind: 'deny' }, { byAgent: true });
    expect(denied.ok).toBe(true);
    expect(answered).toEqual([{ sessionId: 's1', option: 3 }]);
    menu = menuOf(rm);
    expect((await scheduler.answerPrompt(task.id, { kind: 'approve' })).ok).toBe(true);
    expect(answered.at(-1)).toEqual({ sessionId: 's1', option: 1 });
  });

  it('nor a prompt it could not read, nor an option that allows more than this call', async () => {
    make({ agentState: () => undefined });
    const task = await onPrompt();
    menu = { question: 'Do you want to proceed?', options: OPTIONS, key: 'k' };
    const blind = await scheduler.answerPrompt(task.id, { kind: 'approve' }, { byAgent: true });
    expect(blind).toMatchObject({ ok: false, code: 'needs-user' });
    menu = menuOf(GREP);
    const wide = await scheduler.answerPrompt(
      task.id,
      { kind: 'option', option: 2 },
      { byAgent: true }
    );
    expect(wide).toMatchObject({ ok: false, code: 'needs-user' });
    expect(answered).toEqual([]);
  });

  it('told once, and kept: refused again or after a restart, the phone hears nothing more (review 2026-11-10)', async () => {
    make();
    const task = await onPrompt('rm -rf build');
    const refuse = () => scheduler.answerPrompt(task.id, { kind: 'approve' }, { byAgent: true });
    const toUser = () => pushes().filter((payload) => payload.data?.toUser === true);
    await refuse();
    await refuse();
    expect(toUser()).toHaveLength(1);
    // Written with its push: a server started again on the same file knows it was told.
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
    expect(JSON.stringify(stored)).toContain('toldUserAt');
    // A prompt on the screen of a task that is not «needs you» (its main agent went on): on no
    // blocker, still one push however often the answer is refused.
    scheduler.onClaudeTransition('s1', 'waiting', 'busy', busy);
    expect(scheduler.get(task.id)?.state).toBe('working');
    notify.mockClear();
    asking = undefined;
    await refuse();
    await refuse();
    expect(toUser()).toHaveLength(1);
    expect(answered).toEqual([]);
  });

  it('--text refuses it and tells the agent what to do instead', async () => {
    make();
    const task = await onPrompt();
    deliver.mockResolvedValue(true);
    const result = await scheduler.answerPrompt(
      task.id,
      { kind: 'text', text: 'usa el scratchpad, no $TMPDIR' },
      { byAgent: true }
    );
    await scheduler.settled();
    expect(result.ok).toBe(true);
    expect(answered).toEqual([{ sessionId: 's1', option: 3 }]);
    expect(deliver.mock.calls.at(-1)?.[1]).toContain('usa el scratchpad, no $TMPDIR');
  });

  it('no prompt on its screen, or an option it does not have: said, nothing typed', async () => {
    make();
    const task = await onPrompt();
    const none = await scheduler.answerPrompt(task.id, { kind: 'option', option: 7 });
    expect(none).toMatchObject({ ok: false, code: 'no-prompt' });
    expect(none.ok ? '' : none.message).toContain('1. Yes');
    menu = null;
    expect(await scheduler.answerPrompt(task.id, { kind: 'approve' })).toMatchObject({
      ok: false,
      code: 'no-prompt',
    });
    expect(answered).toEqual([]);
  });

  it('nobody answers it: the phone hears once, though the task reports to an orchestrator', async () => {
    make();
    const task = await onPrompt();
    await vi.advanceTimersByTimeAsync(PROMPT_ESCALATE_MS - 60_000);
    await scheduler.checkExited();
    expect(pushes().filter((payload) => payload.data?.toUser === true)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await scheduler.checkExited();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await scheduler.checkExited();
    await scheduler.settled();
    const toUser = pushes().filter((payload) => payload.data?.toUser === true);
    expect(toUser).toHaveLength(1);
    expect(toUser[0].body).toMatch(/Nobody answered its agent's prompt in 1\d min/);
    expect(toUser[0].body).toContain('solo-si-cambia');
    expect(scheduler.get(task.id)?.blocker?.prompt?.toldUserAt).toBeTruthy();
  });

  it('a prompt on a command Untether itself rewrote: phone and orchestrator hear at once, with the whole command (2026-11-11)', async () => {
    make();
    const long = `pnpm run test ${'--reporter=dot '.repeat(40)}`.trim();
    const wrapped = `__ut_slot=$('/app/ut' check-slot acquire --pid $$ --label 'pnpm run test')\n[ -n "$__ut_slot" ] && export UNTETHER_CHECK_SLOT="$__ut_slot"\n{ ${long}\n}\n__ut_slot_rc=$?\n(exit $__ut_slot_rc)`;
    const task = await onPrompt(wrapped);
    expect(task.blocker?.prompt).toMatchObject({ wrapped: 'check slot' });
    // No PROMPT_ESCALATE_MS wait: told now, though the task reports to an orchestrator.
    const toUser = pushes().filter((payload) => payload.data?.toUser === true);
    expect(toUser).toHaveLength(1);
    expect(toUser[0].body).toContain('a command Untether itself rewrote (check slot)');
    expect(toUser[0].body).toContain(wrapped); // whole, not its 300-character summary
    expect(task.blocker?.prompt?.toldUserAt).toBeTruthy();
    // Its orchestrator's own notice, as for any prompt.
    expect(pushes().filter((payload) => payload.body.includes('Its agent asks:'))).toHaveLength(1);
    // Once: read again each tick, and past the escalation time, nothing more.
    await vi.advanceTimersByTimeAsync(PROMPT_ESCALATE_MS + 60_000);
    await scheduler.checkExited();
    await scheduler.settled();
    expect(pushes().filter((payload) => payload.data?.toUser === true)).toHaveLength(1);
    // Untether's wrapper deletes nothing: its orchestrator may still approve it.
    expect(scheduler.get(task.id)?.blocker?.prompt?.deletes).toBeUndefined();
  });

  it('retry says what to do instead of "The task is needs_you"', async () => {
    make();
    const task = await onPrompt();
    const result = await scheduler.retry(task.id);
    expect(result).toMatchObject({ ok: false, code: 'not-open' });
    const message = result.ok ? '' : result.message;
    expect(message).toContain('waits on a prompt of its own');
    expect(message).toContain(`ut task answer ${task.id.slice(0, 8)}`);
  });

  it('a message sent meanwhile says on its own record why it waits, and goes in once answered', async () => {
    make();
    const task = await onPrompt();
    await scheduler.send(task.id, 'sigue con la lista', 'cli', {
      id: 'mbcd234',
      header: '[untether] Message mbcd234 from the orchestrator of "bakery":',
    });
    await scheduler.settled();
    expect(waitingWhy[0]?.id).toBe('mbcd234');
    expect(waitingWhy[0]?.why).toContain("a prompt of its own on the task's screen");
    expect(waitingWhy[0]?.why).toContain(`ut task answer ${task.id.slice(0, 8)}`);
    // Answered: typed at once, not at its next retry.
    deliver.mockResolvedValue(true);
    const before = deliver.mock.calls.length;
    await scheduler.answerPrompt(task.id, { kind: 'approve' }, { byAgent: true });
    await scheduler.settled();
    expect(deliver.mock.calls.length).toBe(before + 1);
    expect(scheduler.get(task.id)?.pendingInput).toBeUndefined();
  });
});

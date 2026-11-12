import { describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../shared/tasks.js';
import type { TaskResponse } from './pty/socket-protocol.js';
import { parseFlags } from './task-cli/flags.js';
import { formatTaskDetail } from './task-cli/format-task-detail.js';
import { formatTaskLine } from './task-cli/format-task-line.js';
import { parseSettingValue } from './task-cli/project-settings.js';
import { waitSatisfied } from './task-cli/task-wait.js';
import { WAIT_OUTAGE_MS } from './task-cli/types.js';
import { COMMAND_OPTIONS, runTaskCli, TASK_CLI_HELP } from './task-cli.js';

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: '0123456789abcdef',
    name: 'Login',
    prompt: 'Añade login',
    workingDir: '/repo',
    command: ['claude'],
    agent: 'claude',
    shielded: false,
    notify: true,
    runAt: '2026-10-18T00:00:00.000Z',
    createdAt: '2026-10-18T00:00:00.000Z',
    state: 'working',
    stateSince: '2026-10-18T00:00:00.000Z',
    isolation: 'worktree',
    origin: 'user',
    followUps: [],
    files: [],
    branch: 'ut/login',
    baseBranch: 'main',
    ...over,
  };
}

function cli(
  responses: TaskResponse[] | ((op: string, args: Record<string, unknown>) => TaskResponse)
) {
  const calls: Array<{ op: string; args: Record<string, unknown>; caller: unknown }> = [];
  const out: string[] = [];
  const err: string[] = [];
  let clock = 0;
  const deps = {
    task: vi.fn(async (op: string, args: Record<string, unknown>, caller: unknown) => {
      calls.push({ op, args, caller });
      if (typeof responses === 'function') return responses(op, args);
      return responses.shift() ?? { ok: false as const, code: 'error', message: 'no more' };
    }),
    env: { UNTETHER_SESSION_ID: 'sess-9' } as Record<string, string | undefined>,
    cwd: '/repo/web',
    readStdin: async () => 'prompt from stdin\n',
    out: (text: string) => out.push(text),
    err: (text: string) => err.push(text),
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, calls, out, err };
}

const done = (data: Record<string, unknown>): TaskResponse => ({ ok: true, status: 'done', data });

describe('task CLI', () => {
  it('parses flags, values and the -- separator', () => {
    expect(
      parseFlags(
        ['--repo', 'x', '--json', '--title=Hola', '--', '--not-a-flag', 'y'],
        'ut task new',
        COMMAND_OPTIONS['task new']
      )
    ).toEqual({
      flags: { repo: 'x', json: true, title: 'Hola' },
      positional: ['--not-a-flag', 'y'],
    });
    expect(parseSettingValue('riskIgnore', 'a/**, b')).toEqual(['a/**', 'b']);
    expect(parseSettingValue('checkCommand', '')).toBeNull();
    // The command guard (2026-11-02): rule ids as a list, patterns whole (commas in them).
    expect(parseSettingValue('guardOff', 'git-push, sudo')).toEqual(['git-push', 'sudo']);
    expect(parseSettingValue('guardDeny', 'terraform (apply|destroy){1,2}')).toEqual([
      'terraform (apply|destroy){1,2}',
    ]);
    expect(parseSettingValue('guardAllow', '["^make deploy$","a,b"]')).toEqual([
      '^make deploy$',
      'a,b',
    ]);
    expect(parseSettingValue('verifyTimeoutSec', '600')).toBe(600);
    // Every numeric setting, read from the schema (2026-11-01: maxActiveTasks went as "2");
    // out of range still a number, so the server says why; text settings keep their digits.
    expect(parseSettingValue('maxActiveTasks', '2')).toBe(2);
    expect(parseSettingValue('maxActiveTasks', '0')).toBe(0);
    expect(parseSettingValue('securityDepsEvery', '3')).toBe(3);
    expect(parseSettingValue('checkCommand', '123')).toBe('123');
    expect(parseSettingValue('nonsense', '7')).toBe('7');
    expect(parseSettingValue('allowMergeWithoutCheck', 'true')).toBe(true);
    // Saving features (2026-11-03): the holdout share a number, the guard's record cleared.
    expect(parseSettingValue('savingHoldoutPct', '20')).toBe(20);
    expect(parseSettingValue('savingAutoOff', '')).toBeNull();
  });

  describe('an option a command does not know is an error (2026-11-10)', () => {
    // The real case: a ut without --reply-to took it for a switch nobody read, and sent
    // "mhz2xp2 -" as the text, unlinked and without the heredoc's body.
    it('the incident: tell with an option it does not know sends nothing', async () => {
      const { deps, calls, err } = cli([]);
      const readStdin = vi.fn(async () => 'the body');
      const code = await runTaskCli(
        'project',
        ['tell', 'untether', '--reply-too', 'mhz2xp2', '-'],
        { ...deps, readStdin }
      );
      expect(code).toBe(1);
      expect(calls).toEqual([]);
      expect(readStdin).not.toHaveBeenCalled();
      expect(err[0]).toBe(
        'Error: unknown option --reply-too for \'ut project tell\' (it takes: --reply-to VALUE, --user-decision VALUE, --no-reply, --json). Nothing was done. Text that starts with -- goes after a lone --: ut project tell … -- "--text"'
      );
      // The same command with the option it knows: linked, and the body from stdin.
      const ok = cli([done({ to: 'untether', id: 'm2', replyTo: 'mhz2xp2' })]);
      expect(
        await runTaskCli('project', ['tell', 'untether', '--reply-to', 'mhz2xp2', '-'], ok.deps)
      ).toBe(0);
      expect(ok.calls[0]).toMatchObject({
        op: 'project-tell',
        args: { to: 'untether', replyTo: 'mhz2xp2', text: 'prompt from stdin\n' },
      });
    });

    it('every command refuses it, wherever it is typed, and runs nothing', async () => {
      for (const command of Object.keys(COMMAND_OPTIONS)) {
        const [group, sub] = command.split(' ') as ['task' | 'project', string];
        for (const argv of [
          [sub, '--frobnicate', 'abc', 'text'],
          [sub, 'abc', 'text', '--frobnicate'],
          [sub, 'abc', '--frobnicate=1', 'text'],
          [sub, '--frobnicate and some text'],
        ]) {
          const { deps, calls, err } = cli([]);
          const readStdin = vi.fn(async () => '{}');
          const code = await runTaskCli(group, argv, { ...deps, readStdin, exists: () => true });
          expect([command, argv, code]).toEqual([command, argv, 1]);
          expect(calls).toEqual([]);
          expect(readStdin).not.toHaveBeenCalled();
          expect(err[0]).toContain(`unknown option --frobnicate`);
          expect(err[0]).toContain(`for 'ut ${command}'`);
        }
      }
    });

    it("another command's option is unknown too, and a switch takes no value", async () => {
      const cases: Array<['task' | 'project', string[], string]> = [
        ['task', ['send', 'abc', 'hola', '--user-decision', 'x'], 'unknown option --user-decision'],
        ['task', ['merge', 'abc', '--yes'], 'unknown option --yes'],
        ['task', ['discard', 'abc', '--accept-risk'], 'unknown option --accept-risk'],
        ['project', ['show', '--all'], 'unknown option --all'],
        ['task', ['list', '--json=1'], '--json takes no value'],
        ['task', ['discard', 'abc', '--yes=no'], '--yes takes no value'],
      ];
      for (const [group, argv, message] of cases) {
        const { deps, calls, err } = cli([]);
        expect(await runTaskCli(group, argv, deps)).toBe(1);
        expect(calls).toEqual([]);
        expect(err[0]).toContain(message);
      }
    });

    it('text that starts with -- goes after a lone --', async () => {
      const { deps, calls } = cli([done({}), done({ to: 'untether', id: 'm3' })]);
      expect(await runTaskCli('task', ['ask', '--', '--force', 'or', 'not?'], deps)).toBe(0);
      expect(calls[0]).toMatchObject({ op: 'ask', args: { question: '--force or not?' } });
      expect(
        await runTaskCli(
          'project',
          ['tell', 'untether', '--no-reply', '--', '--reply-to is the option'],
          deps
        )
      ).toBe(0);
      expect(calls[1]).toMatchObject({
        op: 'project-tell',
        args: { to: 'untether', noReply: true, text: '--reply-to is the option' },
      });
      expect(calls[1].args).not.toHaveProperty('replyTo');
    });

    it('the usage and the table agree: every documented option is accepted', () => {
      // Each usage entry: from its "  ut <group> <sub>" line to the next one (or the blank line).
      const entries = new Map<string, string>();
      let current: string | undefined;
      for (const line of TASK_CLI_HELP.split('\n').slice(1)) {
        const start = /^ {2}ut (task|project) ([a-z-]+)/.exec(line);
        if (start) current = `${start[1]} ${start[2]}`;
        else if (!line.trim()) break;
        if (current) entries.set(current, `${entries.get(current) ?? ''}\n${line}`);
      }
      // `show` is documented as another name of `status`.
      expect([...entries.keys(), 'task show'].sort()).toEqual(Object.keys(COMMAND_OPTIONS).sort());
      for (const [command, text] of entries) {
        const { value = [], switches = [] } = COMMAND_OPTIONS[command];
        const takes = new Set([...value, ...switches, 'json']);
        const documented = [...text.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]);
        expect([command, documented.filter((name) => !takes.has(name))]).toEqual([command, []]);
      }
    });
  });

  it('project stats asks for the last N tasks and prints the comparison (2026-11-03)', async () => {
    const group = {
      tasks: 3,
      medianCost: 1_500_000,
      costTasks: 3,
      firstCheckPassRate: 2 / 3,
      checkPassed: 2,
      checkTasks: 3,
      firstReviewOkRate: 1,
      reviewOk: 3,
      reviewTasks: 3,
      meanAutoFixRounds: 0.33,
      reverted: 0,
      small: true,
    };
    const report = {
      repoPath: '/repo',
      window: 40,
      tasks: 3,
      holdout: 1,
      holdoutPct: 10,
      all: group,
      features: [
        {
          id: 'test-summary',
          version: 1,
          label: 'summarised test output',
          state: 'on',
          comparison: {
            feature: 'test-summary',
            version: 1,
            with: group,
            without: group,
            small: true,
            signals: [
              {
                signal: 'check',
                label: 'first-try check pass rate',
                with: { hits: 2, n: 3 },
                without: { hits: 2, n: 3 },
                difference: { diff: 0, low: -0.6, high: 0.6 },
                adjusted: 0,
                sized: 0,
                verdict: 'insufficient',
              },
            ],
          },
        },
      ],
      guard: { minGroup: 10, marginPct: 15, confidencePct: 99 },
    };
    const { deps, calls, out } = cli([done({ report })]);
    expect(await runTaskCli('project', ['stats', '--last', '40'], deps)).toBe(0);
    expect(calls[0]).toMatchObject({ op: 'project-stats', args: { last: 40 } });
    const text = out.join('\n');
    expect(text).toMatch(/last 3 finished task\(s\) of \/repo \(window 40; holdout 1/);
    expect(text).toMatch(/test-summary v1 \(summarised test output\): on/);
    expect(text).toMatch(
      /with: {4}3 tasks \(small sample\) · median cost 1\.5M · first-try check 67% \(3\) · first review ok 100% \(3\) · auto-fix rounds 0\.33/
    );
    expect(text).toMatch(/small sample: read these numbers with care/);
    expect(text).toMatch(
      /guard: {3}first-try check pass rate: not enough data yet \(3 task\(s\) with it, 3 without; the guard needs 10 in each\)/
    );
    const bad = cli([]);
    expect(await runTaskCli('project', ['stats', '--last', 'lots'], bad.deps)).not.toBe(0);
    expect(bad.calls).toHaveLength(0);
  });

  it('new sends the prompt, the folder, worktree isolation and the caller', async () => {
    const { deps, calls, out } = cli([done({ task: task(), tasks: [task()] })]);
    const exit = await runTaskCli(
      'task',
      [
        'new',
        '--repo',
        '..',
        '--agent',
        'codex',
        '--parallel',
        '1',
        '--merge',
        'ask',
        '--',
        'Añade',
        'login',
      ],
      deps
    );
    expect(exit).toBe(0);
    expect(calls[0]).toEqual({
      op: 'new',
      args: {
        prompt: 'Añade login',
        cwd: '/repo/web',
        repoPath: '/repo',
        isolation: 'worktree',
        agent: 'codex',
        mergePolicy: 'ask',
        parallel: 1,
      },
      caller: { sessionId: 'sess-9' },
    });
    expect(out[0]).toContain('01234567  working');
    expect(out[0]).toContain('[ut/login]');
  });

  it('send says what really became of the message (2026-10-23)', async () => {
    const said = async (sent: TaskRecord) => {
      const { deps, out } = cli([done({ task: sent })]);
      expect(await runTaskCli('task', ['send', 'abc', 'usa 48 kHz'], deps)).toBe(0);
      return out.join('\n');
    };
    expect(await said(task())).toContain('if it is working it reads it within its current turn');
    const pending = [{ text: 'usa 48 kHz', at: 'x' }];
    expect(await said(task({ pendingInput: pending, pendingWhy: 'menu' }))).toContain(
      "Claude shows a choice of its own on the task's screen"
    );
    const codex = await said(task({ agent: 'codex', pendingInput: pending, pendingWhy: 'busy' }));
    expect(codex).toContain('Codex is working and only takes text at its prompt');
    expect(codex).toContain('it carries the time it was sent');
    expect(await said(task({ pendingInput: pending }))).toContain('being typed into its agent now');
  });

  it("status shows the prompt a task's agent stopped on; answer answers it (3dc243e4, 2026-11-10)", async () => {
    const stopped = task({
      id: '3dc243e4-0d81-4374-8964-09536762ba0c',
      state: 'needs_you',
      blocker: {
        kind: 'permission',
        message: 'permission prompt',
        fromPrompt: true,
        prompt: {
          question: 'Do you want to proceed?',
          options: ['Yes', 'No, and tell Claude what to do differently (esc)'],
          detail: ['Bash command', "bash -c 'grep -H x scripts/check.d/*.sh'"],
          asks: "Permission for Bash: bash -c 'grep -H x scripts/check.d/*.sh'",
          since: '2026-11-10T08:19:33.000Z',
        },
      },
    });
    const shown = cli([done({ task: stopped })]);
    expect(await runTaskCli('task', ['status', '3dc243e4'], shown.deps)).toBe(0);
    const text = shown.out.join('\n');
    expect(text).toContain("prompt:   asks: Permission for Bash: bash -c 'grep -H x");
    expect(text).toContain('Do you want to proceed?');
    expect(text).toContain('1. Yes');
    expect(text).toContain('ut task answer 3dc243e4 approve | deny | <number> | --text');

    const sent = async (argv: string[]) => {
      const { deps, calls, out } = cli([done({ task: task() })]);
      expect(await runTaskCli('task', ['answer', ...argv], deps)).toBe(0);
      expect(out.join('\n')).toContain('Answered');
      return calls[0];
    };
    expect(await sent(['3dc243e4', 'approve'])).toMatchObject({
      op: 'answer',
      args: { ref: '3dc243e4', choice: 'approve' },
    });
    expect((await sent(['3dc243e4', 'deny'])).args).toEqual({ ref: '3dc243e4', choice: 'deny' });
    expect((await sent(['3dc243e4', '2'])).args).toEqual({ ref: '3dc243e4', choice: 2 });
    expect((await sent(['3dc243e4', '--text', 'usa el scratchpad'])).args).toEqual({
      ref: '3dc243e4',
      text: 'usa el scratchpad',
    });
    // Not an answer: said, nothing sent.
    const wrong = cli([]);
    expect(await runTaskCli('task', ['answer', '3dc243e4', 'quizas'], wrong.deps)).not.toBe(0);
    expect(wrong.calls).toHaveLength(0);
    expect(wrong.err.join('\n')).toContain('is no answer');
    // Only the user may: its reason reaches the caller.
    const refused = cli([
      {
        ok: false,
        code: 'needs-user',
        message: 'Not answered: it asks to delete something: only the user approves that.',
      },
    ]);
    expect(await runTaskCli('task', ['answer', '3dc243e4', 'approve'], refused.deps)).toBe(1);
    expect(refused.err.join('\n')).toContain('only the user approves that');
  });

  it('new - reads the prompt from stdin; --no-worktree runs in the folder', async () => {
    const { deps, calls } = cli([done({ task: task() })]);
    deps.env = {};
    await runTaskCli('task', ['new', '--no-worktree', '-'], deps);
    expect(calls[0].args).toMatchObject({ prompt: 'prompt from stdin\n', isolation: 'none' });
    // 2026-10-20: no `interactive` claim any more (it gave no rights).
    expect(calls[0].caller).toEqual({});
  });

  it('handoff opens a plain session in another folder; it needs --dir', async () => {
    const { deps, calls } = cli([done({ task: task() })]);
    deps.env = { HOME: '/Users/n' };
    Object.assign(deps, { exists: (dir: string) => dir === '/Users/n/Projects/tele' });
    await runTaskCli(
      'task',
      ['handoff', '--dir', '~/Projects/tele', 'sigue', 'con', 'la', 'app'],
      deps
    );
    expect(calls[0]).toMatchObject({
      op: 'new',
      args: { prompt: 'sigue con la app', workingDir: '/Users/n/Projects/tele', isolation: 'none' },
    });
    const missing = cli([]);
    expect(await runTaskCli('task', ['handoff', 'hola'], missing.deps)).toBe(1);
    expect(await runTaskCli('task', ['handoff', '--dir', '/nope', 'hola'], missing.deps)).toBe(1);
    expect(missing.calls).toEqual([]);
  });

  // P6: `new --route` routes like the home screen's box.
  it('new --route submits for routing and reports where it went', async () => {
    const sent = cli([done({ action: 'sent', task: task(), decision: { kind: 'match' } })]);
    expect(
      await runTaskCli(
        'task',
        ['new', '--route', '--agent', 'codex', '--', 'y el logout'],
        sent.deps
      )
    ).toBe(0);
    expect(sent.calls[0]).toMatchObject({
      op: 'submit',
      args: { text: 'y el logout', cwd: '/repo/web', agent: 'codex' },
    });
    expect(sent.out.join('\n')).toContain('→ added to 01234567');

    const created = cli([done({ action: 'created', task: task({ name: 'Docs' }) })]);
    expect(await runTaskCli('task', ['new', '--route', 'docs'], created.deps)).toBe(0);
    expect(created.out.join('\n')).toContain('Docs');

    const unsure = cli([
      done({
        action: 'ask',
        decision: { kind: 'ask', candidates: ['aaaa1111', 'bbbb2222'] },
        open: [
          { id: 'aaaa1111', name: 'Login con Google', branch: 'ut/login-google' },
          { id: 'bbbb2222', name: 'Login con GitHub' },
          { id: 'cccc3333', name: 'Otra' },
        ],
      }),
    ]);
    expect(await runTaskCli('task', ['new', '--route', 'el login falla'], unsure.deps)).toBe(3);
    const text = unsure.out.join('\n');
    expect(text).toContain('aaaa1111  Login con Google  [ut/login-google]');
    expect(text).toContain('bbbb2222  Login con GitHub');
    expect(text).not.toContain('Otra');

    const json = cli([
      done({ action: 'ask', decision: { kind: 'ask', candidates: [] }, open: [] }),
    ]);
    expect(await runTaskCli('task', ['new', '--route', '--json', 'x'], json.deps)).toBe(3);

    const bad = cli([]);
    expect(await runTaskCli('task', ['new', '--route', '--parallel', '2', 'x'], bad.deps)).toBe(1);
    expect(bad.calls).toHaveLength(0);
  });

  it('prints a pending confirmation and exits 0; errors go to stderr with 1', async () => {
    const pending: TaskResponse = {
      ok: true,
      status: 'pending-confirmation',
      confirmation: {
        id: 'abcdef1234',
        kind: 'merge-risk',
        createdAt: 'x',
        expiresAt: '2026-10-18T01:00:00.000Z',
        where: 'Login',
        summary: 'Merge with its risky changes: Login',
        detail: ['secrets: .env'],
        requestedBy: {},
      },
    };
    const { deps, out, err, calls } = cli([
      pending,
      { ok: false, code: 'forbidden', message: 'A task cannot merge; the engine merges it' },
    ]);
    expect(await runTaskCli('task', ['merge', 'ut/login', '--accept-risk'], deps)).toBe(0);
    expect(calls[0].args).toEqual({ ref: 'ut/login', acceptRisk: true });
    expect(out.join('\n')).toContain(
      "Waiting for the user's OK on the phone (confirmation abcdef12)"
    );
    expect(out.join('\n')).toContain('  secrets: .env');
    expect(await runTaskCli('task', ['merge', 'x'], deps)).toBe(1);
    expect(err).toEqual(['Error: A task cannot merge; the engine merges it']);
  });

  it('done takes its summary on stdin with - (2026-10-20: quotes and $ broke it)', async () => {
    const { deps, calls } = cli(() => done({ task: task() }));
    await runTaskCli('task', ['done', '--verified', 'pnpm test: ok', '-'], deps);
    await runTaskCli('task', ['done', '--summary', '-'], deps);
    expect(calls.map(({ op, args }) => [op, args])).toEqual([
      ['done', { summary: 'prompt from stdin\n', verified: 'pnpm test: ok' }],
      ['done', { summary: 'prompt from stdin\n' }],
    ]);
  });

  it('2026-11-01: done takes a structured result as JSON, on stdin with its summary', async () => {
    const result = {
      outcome: 'done',
      files: [{ path: 'a.ts', why: 'x' }],
      tests: [{ command: 'pnpm test', result: 'passed' }],
      risks: [],
      followUps: [],
    };
    const { deps, calls } = cli(() => done({ task: task() }));
    deps.readStdin = async () =>
      JSON.stringify({
        summary: 'Hecho',
        verified: 'pnpm test: ok',
        undo: 'git revert',
        ...result,
      });
    expect(await runTaskCli('task', ['done', '--result', '-'], deps)).toBe(0);
    expect(
      await runTaskCli(
        'task',
        ['done', '--summary', 'Otro', '--result', JSON.stringify(result)],
        deps
      )
    ).toBe(0);
    expect(calls.map(({ op, args }) => [op, args])).toEqual([
      ['done', { summary: 'Hecho', verified: 'pnpm test: ok', undo: 'git revert', result }],
      ['done', { summary: 'Otro', result }],
    ]);
  });

  it('2026-11-01: done refuses a --result that is not JSON, or stdin asked for twice', async () => {
    const { deps, err, calls } = cli(() => done({ task: task() }));
    expect(await runTaskCli('task', ['done', '--result', '{outcome: done}'], deps)).not.toBe(0);
    expect(err.join('\n')).toContain('--result is not valid JSON');
    expect(err.join('\n')).toContain('Example: {"outcome":"done"');
    expect(await runTaskCli('task', ['done', '--summary', '-', '--result', '-'], deps)).not.toBe(0);
    expect(err.join('\n')).toContain('stdin carries either the summary or the --result JSON');
    expect(calls).toEqual([]);
  });

  it('--json prints the response as is', async () => {
    const response = done({ tasks: [task()] });
    const { deps, out } = cli([response]);
    expect(await runTaskCli('task', ['list', '--all', '--json'], deps)).toBe(0);
    expect(JSON.parse(out[0])).toEqual(response);
  });

  it('done, ask, discard --yes, keep, logs and project set build the right requests', async () => {
    const { deps, calls } = cli(() => done({ task: task(), tasks: [], text: 'x', exists: true }));
    await runTaskCli('task', ['done', '--summary', 'Login hecho'], deps);
    await runTaskCli('task', ['ask', '¿Google', 'o', 'GitHub?'], deps);
    await runTaskCli('task', ['discard', 'abc1', '--yes'], deps);
    await runTaskCli('task', ['keep', 'abc1'], deps);
    await runTaskCli('task', ['logs', 'abc1', '--kind', 'merge', '--lines', '20'], deps);
    await runTaskCli(
      'project',
      ['set', '--merge', 'ask', 'riskIgnore=docs/**', 'checkCommand='],
      deps
    );
    await runTaskCli('project', ['set', 'aiReview=true'], deps);
    await runTaskCli('task', ['merge', 'abc1', '--accept-review', '--review-again'], deps);
    await runTaskCli('project', ['show'], deps);
    await runTaskCli('task', ['retry', 'abc1'], deps);
    await runTaskCli('project', ['tell', 'untether', 'posix_spawnp', 'failed'], deps);
    expect(calls.map(({ op, args }) => [op, args])).toEqual([
      ['done', { summary: 'Login hecho' }],
      ['ask', { question: '¿Google o GitHub?' }],
      ['discard', { ref: 'abc1', confirm: true }],
      ['keep', { ref: 'abc1', confirm: false }],
      ['logs', { ref: 'abc1', kind: 'merge', lines: 20 }],
      [
        'project-set',
        {
          repo: undefined,
          cwd: '/repo/web',
          settings: { mergePolicy: 'ask', riskIgnore: ['docs/**'], checkCommand: null },
        },
      ],
      ['project-set', { repo: undefined, cwd: '/repo/web', settings: { aiReview: true } }],
      ['merge', { ref: 'abc1', acceptRisk: false, acceptReview: true, reviewAgain: true }],
      ['project-show', { repo: undefined, cwd: '/repo/web' }],
      ['retry', { ref: 'abc1' }],
      ['project-tell', { to: 'untether', text: 'posix_spawnp failed' }],
    ]);
  });

  it('messages between agents: tell and send print the id, take --reply-to, and messages lists them (2026-11-10)', async () => {
    const answers: Record<string, unknown>[] = [
      { to: 'untether', repoPath: '/projects/untether', id: 'mbcd234', expectsReply: true },
      {
        to: 'atlas',
        repoPath: '/projects/atlas',
        id: 'mfgh567',
        expectsReply: false,
        replyTo: 'mbcd234',
        userDecision: { quote: 'Vale, publica el viernes', at: '2026-11-10T09:00:00.000Z' },
      },
      { task: task({ id: 'abc1abc1-0000', state: 'working' }), message: { id: 'mjkm892' } },
      {
        now: Date.parse('2026-11-10T12:00:00.000Z'),
        messages: [
          {
            id: 'mbcd234',
            at: '2026-11-10T11:00:00.000Z',
            from: { kind: 'project', repoPath: '/projects/atlas' },
            to: { kind: 'project', repoPath: '/projects/untether' },
            preview: 'posix_spawnp failed',
            state: 'delivered',
            expectsReply: true,
          },
        ],
      },
      { now: 0, messages: [] },
    ];
    const { deps, calls, out } = cli(() => done(answers.shift() ?? {}));
    expect(await runTaskCli('project', ['tell', 'untether', 'posix_spawnp', 'failed'], deps)).toBe(
      0
    );
    expect(
      await runTaskCli(
        'project',
        [
          'tell',
          'atlas',
          '--reply-to',
          'mbcd234',
          '--user-decision',
          'publica el viernes',
          '--no-reply',
          'Hecho',
        ],
        deps
      )
    ).toBe(0);
    expect(
      await runTaskCli('task', ['send', 'abc1', '--reply-to=mbcd234', 'falta', 'algo'], deps)
    ).toBe(0);
    expect(await runTaskCli('project', ['messages'], deps)).toBe(0);
    expect(await runTaskCli('project', ['messages', '--all', '--repo', '/repo'], deps)).toBe(0);
    expect(calls.map(({ op, args }) => [op, args])).toEqual([
      ['project-tell', { to: 'untether', text: 'posix_spawnp failed' }],
      [
        'project-tell',
        {
          to: 'atlas',
          text: 'Hecho',
          replyTo: 'mbcd234',
          noReply: true,
          userDecision: 'publica el viernes',
        },
      ],
      ['send', { ref: 'abc1', text: 'falta algo', replyTo: 'mbcd234' }],
      ['project-messages', { repo: undefined }],
      ['project-messages', { repo: '/repo', all: true }],
    ]);
    const text = out.join('\n');
    expect(text).toContain('→ message mbcd234 to the orchestrator of untether');
    expect(text).toContain('Its answer comes as a message "in reply to mbcd234"');
    expect(text).toContain(
      '→ message mfgh567 to the orchestrator of atlas, in reply to mbcd234 (answered now)'
    );
    expect(text).toContain(
      "Untether attached the user's own words (2026-11-10T09:00:00.000Z): Vale, publica el viernes"
    );
    expect(text).toContain('Message mjkm892: its next report answers it.');
    expect(text).toContain(
      'mbcd234  atlas → untether  delivered, not read yet  1 h ago  posix_spawnp failed'
    );
    expect(text).toContain('No messages between agents here');
  });

  it('queued tasks (project task limit): new says where it waits, move reorders, maxActiveTasks is a setting', async () => {
    const queued = task({
      id: 'cccccccc-0000',
      state: 'queued',
      queued: { repoPath: '/repo', since: '', order: 2, limit: 2, position: 2, of: 3, active: 2 },
    });
    const { deps, calls, out } = cli(() => done({ task: queued }));
    expect(await runTaskCli('task', ['new', 'Haz', 'algo'], deps)).toBe(0);
    expect(out.join('\n')).toContain('cccccccc  queued 2/3');
    expect(out.join('\n')).toContain(
      "Queued (2 of 3 in line): 2 of 2 tasks of the project are running (maxActiveTasks); it starts by itself when one ends. 'ut task retry cccccccc --force' starts it now anyway"
    );
    await runTaskCli('task', ['move', 'cccc', '1'], deps);
    await runTaskCli('project', ['set', 'maxActiveTasks=2'], deps);
    expect(calls.slice(1).map(({ op, args }) => [op, args])).toEqual([
      ['move', { ref: 'cccc', position: 1 }],
      ['project-set', { repo: undefined, cwd: '/repo/web', settings: { maxActiveTasks: 2 } }],
    ]);
    expect(await runTaskCli('task', ['move', 'cccc'], deps)).toBe(1);
    expect(await runTaskCli('task', ['move', 'cccc', '0'], deps)).toBe(1);
  });

  it('new --after / --zone: sent as lists; a waiting task says what it waits for, and what the prompt touches is told', async () => {
    const waiting = task({
      id: 'cccccccc-0000',
      state: 'queued',
      after: ['aaaaaaaa-1111'],
      zones: ['core'],
      queued: {
        repoPath: '/repo',
        since: '',
        order: 1,
        position: 1,
        of: 1,
        active: 1,
        waitsFor: [{ taskId: 'aaaaaaaa-1111', name: 'Primera', why: 'after', state: 'working' }],
      },
    });
    const { deps, calls, out, err } = cli(() =>
      done({
        task: waiting,
        touches: [{ taskId: 'bbbbbbbb-2222', name: 'Otra', files: ['web/a.ts'], count: 1 }],
      })
    );
    expect(
      await runTaskCli(
        'task',
        ['new', '--after', 'aaaaaaaa, ut/primera', '--zone=core,docs', 'Haz', 'algo'],
        deps
      )
    ).toBe(0);
    expect(calls[0].args).toMatchObject({
      prompt: 'Haz algo',
      after: ['aaaaaaaa', 'ut/primera'],
      zone: ['core', 'docs'],
    });
    expect(out.join('\n')).toContain('cccccccc  waits for aaaaaaaa');
    expect(out.join('\n')).toContain(
      'Waits for aaaaaaaa «Primera» (working): it starts by itself once it merges or closes, from a base with that work.'
    );
    expect(err.join('\n')).toContain(
      "Touches the same as bbbbbbbb «Otra» (web/a.ts): use --after bbbbbbbb (discard this one first: 'ut task discard cccccccc') or leave it running."
    );
    // status: its zone, what it starts after and what it waits for.
    const status = formatTaskDetail(waiting);
    expect(status).toContain('  zone:     core');
    expect(status).toContain('  after:    aaaaaaaa');
    expect(status).toContain('  queue:    Waits for aaaaaaaa «Primera» (working)');
    // The project's zones: a comma list of rules.
    await runTaskCli('project', ['set', 'zones=web/src/client/**=client,mac=mac'], deps);
    expect(calls[1].args).toMatchObject({
      settings: { zones: ['web/src/client/**=client', 'mac=mac'] },
    });
    expect(await runTaskCli('task', ['new', '--after'], deps)).toBe(1);
  });

  it('refuses bad usage without calling the server', async () => {
    const { deps, calls, err } = cli([]);
    expect(await runTaskCli('task', ['merge'], deps)).toBe(1);
    expect(await runTaskCli('task', ['new'], deps)).toBe(1);
    expect(await runTaskCli('task', ['wait', 'x', '--until', 'forever'], deps)).toBe(1);
    expect(await runTaskCli('task', ['frobnicate'], deps)).toBe(1);
    expect(await runTaskCli('project', ['set'], deps)).toBe(1);
    expect(await runTaskCli('project', ['tell'], deps)).toBe(1);
    expect(await runTaskCli('project', ['tell', 'untether'], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(err[0]).toBe('Error: ut task merge needs a task id or branch');
    expect(await runTaskCli('task', ['help'], deps)).toBe(0);
  });

  describe('wait', () => {
    it('polls until every task is done', async () => {
      const states: TaskRecord['state'][][] = [
        ['working', 'working'],
        ['ready', 'verifying'],
        ['ready', 'merged'],
      ];
      const { deps, calls, out } = cli(() => {
        const [a, b] = states.shift() ?? ['ready', 'merged'];
        return done({
          tasks: [task({ id: 'aaaa1111', state: a }), task({ id: 'bbbb2222', state: b })],
        });
      });
      expect(await runTaskCli('task', ['wait', 'aaaa', 'bbbb', '--interval', '1'], deps)).toBe(0);
      expect(calls).toHaveLength(3);
      expect(calls[0]).toMatchObject({ op: 'status', args: { refs: ['aaaa', 'bbbb'] } });
      expect(out.at(-1)).toContain('merged');
    });

    it('--until attention stops at the first task that needs someone', async () => {
      const { deps, calls } = cli(() =>
        done({
          tasks: [task({ state: calls.length > 1 ? 'needs_you' : 'working' }), task({ id: 'b' })],
        })
      );
      expect(await runTaskCli('task', ['wait', 'a', 'b', '--until', 'attention'], deps)).toBe(0);
      expect(calls).toHaveLength(2);
    });

    it('times out with exit 0: nothing changed, events will be typed in (2026-10-20)', async () => {
      const { deps, out } = cli(() => done({ tasks: [task()] }));
      expect(
        await runTaskCli('task', ['wait', 'a', '--timeout', '9', '--interval', '3'], deps)
      ).toBe(0);
      expect(out.at(-1)).toBe('Timed out after 9s, nothing changed; events will be typed in.');
    });

    it('waits through a server restart instead of failing', async () => {
      let looks = 0;
      const { deps, err } = cli(() => {
        looks++;
        if (looks === 2 || looks === 3) throw new Error('Untether server is not running');
        return done({ tasks: [task({ state: looks > 3 ? 'ready' : 'working' })] });
      });
      expect(await runTaskCli('task', ['wait', 'a', '--interval', '2'], deps)).toBe(0);
      expect(looks).toBe(4);
      expect(err).toEqual([
        'Untether server unavailable (Untether server is not running); still waiting...',
      ]);
    });

    it('gives up after a long outage', async () => {
      const { deps } = cli(() => {
        throw new Error('Untether server is not running');
      });
      await expect(runTaskCli('task', ['wait', 'a', '--interval', '60'], deps)).rejects.toThrow(
        'not running'
      );
      expect(deps.now()).toBe(WAIT_OUTAGE_MS);
    });

    it('any: a change of state', () => {
      const initial = new Map([['a', 'working' as const]]);
      expect(waitSatisfied('any', [task({ id: 'a', state: 'working' })], initial)).toBe(false);
      expect(waitSatisfied('any', [task({ id: 'a', state: 'verifying' })], initial)).toBe(true);
      expect(waitSatisfied('done', [task({ id: 'a', state: 'needs_you' })], initial)).toBe(false);
    });

    it('attention: one ready task of several is enough (2026-10-20)', () => {
      const tasks = [task({ id: 'a', state: 'ready' }), task({ id: 'b', state: 'working' })];
      expect(waitSatisfied('attention', tasks, new Map())).toBe(true);
      expect(waitSatisfied('done', tasks, new Map())).toBe(false);
    });
  });

  describe('2026-10-20 pitfalls', () => {
    it('--help or -h anywhere shows the usage and runs nothing', async () => {
      for (const argv of [
        ['merge', 'abc', '--help'],
        ['discard', '-h', 'abc'],
        ['new', '--help', 'Añade login'],
      ]) {
        const { deps, calls, out } = cli([]);
        expect(await runTaskCli('task', argv, deps)).toBe(0);
        expect(calls).toEqual([]);
        expect(out[0]).toContain('Usage:');
      }
      // After `--` it is part of the prompt.
      const { deps, calls } = cli([done({ task: task() })]);
      await runTaskCli('task', ['new', '--', 'explain', '--help'], deps);
      expect(calls[0].args.prompt).toBe('explain --help');
    });

    it("a command waiting for the user's OK exits 0 and says so", async () => {
      const { deps, out } = cli([
        {
          ok: true,
          status: 'pending-confirmation',
          confirmation: {
            id: 'conf1234abcd',
            kind: 'merge-risk',
            createdAt: 'x',
            expiresAt: '2026-10-20T12:00:00Z',
            where: 'Login',
            summary: 'Merge with its risky changes: Login',
            detail: [],
            requestedBy: {},
          },
        },
      ]);
      expect(await runTaskCli('task', ['merge', 'abc', '--accept-risk'], deps)).toBe(0);
      expect(out[0]).toContain("Waiting for the user's OK on the phone (confirmation conf1234)");
    });

    it('list says who each task reports to and its age', async () => {
      const { deps, out } = cli([
        done({
          tasks: [
            task({
              origin: 'orchestrator',
              orchestratorSessionId: 'sess-9',
              createdAt: '1970-01-01T00:00:00.000Z',
            }),
            task({ id: 'ffff0000', createdAt: '1970-01-01T00:00:00.000Z' }),
          ],
        }),
      ]);
      deps.now = () => 3 * 3600_000;
      await runTaskCli('task', ['list'], deps);
      expect(out[0]).toContain('(3h, reports to you)');
      expect(out[0]).toContain('(3h, reports to the user)');
    });

    it('list ends with how full the Mac is against the admission target (2026-11-11)', async () => {
      const room =
        'the Mac is at 53 % of its target (load 5.9 of 12, memory 68 % free, free entry down to 40 % while swap is past its level): room for 4 more tasks (about 1.5 GB and a load of 1.0 each as they start)';
      const { deps, out } = cli([done({ tasks: [task()], room }), done({ tasks: [] })]);
      await runTaskCli('task', ['list'], deps);
      expect(out[out.length - 1]).toBe(`Admission: ${room}`);
      // A server with admission off says nothing about it.
      out.length = 0;
      await runTaskCli('task', ['list'], deps);
      expect(out).toEqual(['No tasks']);
    });

    it('status shows the live state, files, report, auto-fix, review retry, pending input and OKs', async () => {
      const { deps, out } = cli([
        done({
          task: task({
            files: ['src/a.ts'],
            summary: 'Cambié X',
            report: { verified: 'pnpm test: 3 passed', undo: 'git revert x' },
            autoFix: { attempts: 1, max: 2, reason: 'verify', at: 'x' },
            reviewRetryAt: '2026-10-20T11:00:00.000Z',
            pendingInput: [{ text: 'hola', at: 'x' }],
          }),
          live: {
            status: 'busy',
            progress: {
              at: new Date(0).toISOString(),
              by: 'commit',
              waitingOn: { what: 'Monitor "pnpm test"', since: new Date(0).toISOString() },
            },
            stall: {
              progressAt: new Date(0).toISOString(),
              waitingOn: 'Monitor "pnpm test"',
              notedAt: new Date(0).toISOString(),
            },
          },
          confirmations: [
            {
              id: 'c1c1c1c1c1',
              kind: 'merge',
              createdAt: 'x',
              expiresAt: 'y',
              where: 'Login',
              summary: 'Merge: Login',
              detail: [],
              requestedBy: {},
            },
          ],
        }),
      ]);
      await runTaskCli('task', ['status', 'abc'], deps);
      const text = out[0];
      expect(text).toContain('live:     busy, last progress');
      expect(text).toContain('(a commit)');
      expect(text).toContain('waiting:  on Monitor "pnpm test" since');
      expect(text).toContain('stalled:  no progress since');
      expect(text).toContain('files:    src/a.ts');
      expect(text).toContain('reports:  to the user');
      expect(text).toContain('verified: pnpm test: 3 passed');
      expect(text).toContain('undo:     git revert x');
      expect(text).toContain('attempt 1 of 2');
      expect(text).toContain('tries it again at 2026-10-20T11:00:00.000Z');
      expect(text).toContain('waiting:  1 message being typed into its agent now.');
      expect(text).toContain('(confirmation c1c1c1c1)');
    });

    it('show says where the time went: each phase in all, then each round (2026-10-31)', async () => {
      const at = (min: number, sec = 0) =>
        new Date(Date.UTC(2026, 9, 31, 13, min, sec)).toISOString();
      const { deps, out } = cli([
        done({
          task: task({
            state: 'merged',
            verify: { command: 'pnpm test', cwd: '/w', startedAt: 'x', cancelled: true },
            timings: [
              {
                phase: 'verify',
                startedAt: at(21, 31),
                finishedAt: at(25, 20),
                round: 1,
                outcome: 'cancelled',
              },
              {
                phase: 'review',
                startedAt: at(21, 31),
                finishedAt: at(22, 1),
                round: 1,
                outcome: 'concerns',
              },
              {
                phase: 'fix',
                startedAt: at(22, 2),
                finishedAt: at(31, 33),
                round: 1,
                outcome: 'review',
              },
              {
                phase: 'verify',
                startedAt: at(31, 33),
                finishedAt: at(36, 11),
                round: 2,
                outcome: 'passed',
              },
              {
                phase: 'review',
                startedAt: at(31, 33),
                finishedAt: at(31, 42),
                round: 2,
                outcome: 'ok (incremental)',
              },
              {
                phase: 'merge',
                startedAt: at(36, 11),
                finishedAt: at(36, 20),
                round: 2,
                outcome: 'merged',
              },
            ],
          }),
        }),
      ]);
      await runTaskCli('task', ['show', 'abc'], deps);
      const text = out[0];
      expect(text).toContain('stopped (the AI review found problems first');
      expect(text).toContain(
        'time:     check 8m 27s (×2), AI review 39s (×2), agent fixing 9m 31s, merge 9s; 2 rounds, 14m 49s in all'
      );
      expect(text).toContain(
        'round 1: check 3m 49s (cancelled), AI review 30s (concerns), agent fixing 9m 31s (review)'
      );
      expect(text).toContain(
        'round 2: check 4m 38s (passed), AI review 9s (ok (incremental)), merge 9s (merged)'
      );
    });

    it('project show says which check runs and that the AI review is on', async () => {
      const { deps, out } = cli([
        done({
          repoPath: '/repo',
          settings: { mergePolicy: 'auto', aiReview: true },
          stored: {},
          check: { source: 'none', checks: [] },
        }),
      ]);
      await runTaskCli('project', ['show'], deps);
      expect(out[0]).toContain('check that runs: none detected');
      expect(out[0]).toContain('AI review: on');
    });

    it('done carries --verified and --undo; revert undoes a merged task', async () => {
      const { deps, calls, out } = cli([
        done({ task: task() }),
        done({ task: task({ name: 'Undo: Login' }) }),
      ]);
      await runTaskCli(
        'task',
        ['done', '--summary', 'X', '--verified', 'pnpm test ok', '--undo', 'revert it'],
        deps
      );
      expect(calls[0]).toMatchObject({
        op: 'done',
        args: { summary: 'X', verified: 'pnpm test ok', undo: 'revert it' },
      });
      await runTaskCli('task', ['revert', 'abc'], deps);
      expect(calls[1]).toMatchObject({ op: 'revert', args: { ref: 'abc' } });
      expect(out.at(-1)).toContain('Undoing it with a new task');
    });

    it('hold stops a security fix about to merge on its own (2026-10-23)', async () => {
      const { deps, calls } = cli([done({ task: task({ state: 'needs_you' }) })]);
      await runTaskCli('task', ['hold', 'abc'], deps);
      expect(calls[0]).toMatchObject({ op: 'hold', args: { ref: 'abc' } });
    });

    it('priority marks a task urgent or back to normal; anything else is a usage error (2026-11-01)', async () => {
      const { deps, calls, out } = cli([
        done({ task: task({ state: 'verifying', urgent: true }) }),
        done({ task: task({ state: 'verifying' }) }),
      ]);
      expect(await runTaskCli('task', ['priority', 'abc', 'urgent'], deps)).toBe(0);
      expect(calls[0]).toMatchObject({ op: 'priority', args: { ref: 'abc', level: 'urgent' } });
      expect(out.join('\n')).toContain('(urgent)');
      expect(await runTaskCli('task', ['priority', 'abc', 'normal'], deps)).toBe(0);
      expect(calls[1]).toMatchObject({ op: 'priority', args: { ref: 'abc', level: 'normal' } });
      expect(await runTaskCli('task', ['priority', 'abc', 'soon'], deps)).not.toBe(0);
      expect(calls).toHaveLength(2);
    });
  });

  describe('budgets (2026-11-01)', () => {
    it('new --budget, budget <id> +…, and show prints spent / limit', async () => {
      const budget = {
        limits: { wall: 3 * 3_600_000, agent: 2 * 3_600_000, rounds: 6, tokens: 100_000_000 },
        warnPct: 75,
        spent: { wall: 70 * 60_000, agent: 2 * 3_600_000, rounds: 2, tokens: 31_000_000 },
        cut: { at: 'x', keys: ['agent' as const], working: true },
      };
      const { deps, calls, out } = cli([
        done({ task: task({ state: 'working' }) }),
        done({ task: task({ state: 'working' }) }),
        done({ task: task({ state: 'needs_you', budget }) }),
      ]);
      expect(
        await runTaskCli('task', ['new', '--budget', 'wall=2h,rounds=4', 'Arregla el login'], deps)
      ).toBe(0);
      expect(calls[0]).toMatchObject({ op: 'new', args: { budget: 'wall=2h,rounds=4' } });
      expect(await runTaskCli('task', ['budget', 'abc', '+1h', 'rounds=+2'], deps)).toBe(0);
      expect(calls[1]).toMatchObject({
        op: 'budget',
        args: { ref: 'abc', change: '+1h rounds=+2' },
      });
      expect(await runTaskCli('task', ['show', 'abc'], deps)).toBe(0);
      expect(out.join('\n')).toContain(
        'budget:   wall 1h 10m/3h · agent 2h/2h · rounds 2/6 · tokens 31M/100M (stopped at agent)'
      );
      expect(await runTaskCli('task', ['budget'], deps)).not.toBe(0);
    });
  });

  describe('project forget (2026-10-24)', () => {
    it('sends the folder (gone or not) and says what was forgotten', async () => {
      const { deps, calls, out } = cli([
        { ok: true, status: 'done', data: { repoPath: '/gone/prueba', forgotten: true } },
        { ok: true, status: 'done', data: { repoPath: '/repo', forgotten: false } },
      ]);
      expect(await runTaskCli('project', ['forget', '--repo', '/gone/prueba'], deps)).toBe(0);
      expect(calls[0]).toMatchObject({
        op: 'project-forget',
        args: { repo: '/gone/prueba', cwd: '/repo/web' },
      });
      expect(out.join('\n')).toContain('Forgot /gone/prueba (its folder was not touched)');
      expect(await runTaskCli('project', ['forget'], deps)).toBe(0);
      expect(calls[1].args).toEqual({ repo: undefined, cwd: '/repo/web' });
      expect(out.join('\n')).toContain('Untether had no record of /repo');
    });

    it("from an agent it says the user's OK is pending; open tasks fail", async () => {
      const { deps, out, err } = cli([
        {
          ok: true,
          status: 'pending-confirmation',
          confirmation: {
            id: 'c-1',
            kind: 'project-forget',
            createdAt: '2026-10-24T10:00:00.000Z',
            expiresAt: '2026-10-24T10:30:00.000Z',
            where: 'prueba',
            repoPath: '/gone/prueba',
            summary: 'Forget the project prueba',
            detail: [],
            requestedBy: { sessionId: 'sess-9' },
          },
        },
        {
          ok: false,
          code: 'busy',
          message: 'It still has 1 open task(s): merge or discard them first',
        },
      ]);
      expect(await runTaskCli('project', ['forget', '--repo', '/gone/prueba'], deps)).toBe(0);
      expect(out.join('\n')).toContain('Forget the project prueba');
      expect(await runTaskCli('project', ['forget', '--repo', '/repo'], deps)).toBe(1);
      expect(err.join('\n')).toContain('open task(s)');
    });
  });

  describe('project new (2026-10-24)', () => {
    it('sends the name, the parent (required) and the goal, and says what was made', async () => {
      const { deps, calls, out } = cli([
        done({
          repoPath: '/Users/me/Projects/mi-app',
          name: 'Mi App',
          branch: 'main',
          commit: 'abcdef0123456789',
        }),
        done({
          repoPath: '/repo/web/apps/atlas',
          name: 'Atlas',
          branch: 'main',
          commit: '0123456789abcdef',
          orchestrator: { ok: true, sessionId: 'orch-12345678', pending: true },
        }),
        done({
          repoPath: '/x/recados',
          name: 'Recados',
          branch: 'main',
          commit: '0123456789abcdef',
          orchestrator: { ok: false, message: 'Orchestrators are not available here' },
        }),
      ]);
      expect(
        await runTaskCli('project', ['new', 'Mi', 'App', '--dir', '/Users/me/Projects'], deps)
      ).toBe(0);
      expect(calls[0]).toMatchObject({
        op: 'project-new',
        args: { name: 'Mi App', dir: '/Users/me/Projects' },
      });
      expect(calls[0].args).not.toHaveProperty('goal');
      expect(out.join('\n')).toContain('Created /Users/me/Projects/mi-app (branch main');
      // A relative --dir is the caller's folder; the goal from stdin with "-".
      expect(await runTaskCli('project', ['new', 'Atlas', '--dir', 'apps', '-'], deps)).toBe(0);
      expect(calls[1].args).toEqual({
        name: 'Atlas',
        dir: '/repo/web/apps',
        goal: 'prompt from stdin\n',
      });
      expect(out.join('\n')).toContain('started its orchestrator (session orch-123)');
      expect(
        await runTaskCli('project', ['new', 'Recados', '--dir', '~/x', '--goal', 'Un bot'], deps)
      ).toBe(0);
      expect(calls[2].args).toEqual({ name: 'Recados', dir: '~/x', goal: 'Un bot' });
      expect(out.join('\n')).toContain('Its orchestrator did not start');
    });

    it('refuses without --dir or a name, and with two goals; nothing is sent', async () => {
      const { deps, calls, err } = cli([]);
      expect(await runTaskCli('project', ['new', 'Mi App'], deps)).toBe(1);
      expect(err.join('\n')).toContain('needs --dir');
      expect(err.join('\n')).toContain('there is no default place');
      expect(await runTaskCli('project', ['new', '--dir', '/x'], deps)).toBe(1);
      expect(err.join('\n')).toContain('needs a project name');
      expect(
        await runTaskCli('project', ['new', 'A', '--dir', '/x', '--goal', 'g', '-'], deps)
      ).toBe(1);
      expect(calls).toHaveLength(0);
    });

    it("from an agent it says the user's OK is pending; a refusal is an error", async () => {
      const { deps, out, err } = cli([
        {
          ok: true,
          status: 'pending-confirmation',
          confirmation: {
            id: 'c-2',
            kind: 'project-new',
            createdAt: '2026-10-24T10:00:00.000Z',
            expiresAt: '2026-10-24T10:30:00.000Z',
            where: 'atlas',
            repoPath: '/x/atlas',
            summary: 'Create the project Atlas',
            detail: ['Folder: /x/atlas'],
            requestedBy: { sessionId: 'sess-9' },
          },
        },
        { ok: false, code: 'busy', message: '/x/atlas exists already' },
      ]);
      expect(await runTaskCli('project', ['new', 'Atlas', '--dir', '/x'], deps)).toBe(0);
      expect(out.join('\n')).toContain('Create the project Atlas');
      expect(await runTaskCli('project', ['new', 'Atlas', '--dir', '/x'], deps)).toBe(1);
      expect(err.join('\n')).toContain('exists already');
    });
  });

  describe('project auto-approve (2026-10-24)', () => {
    it('sends on or off, says the result, and refuses anything else', async () => {
      const { deps, calls, out } = cli([
        { ok: true, status: 'done', data: { autoApprove: false } },
      ]);
      expect(await runTaskCli('project', ['auto-approve', 'off'], deps)).toBe(0);
      expect(calls[0]).toMatchObject({ op: 'auto-approve', args: { on: false } });
      expect(out.join('\n')).toContain('autoApprove is off');
      const bad = cli([]);
      expect(await runTaskCli('project', ['auto-approve', 'yes'], bad.deps)).toBe(1);
      expect(bad.calls).toEqual([]);
    });

    it('a done result the user’s autoApprove gave says it was not asked', async () => {
      const { deps, out } = cli([
        {
          ok: true,
          status: 'done',
          data: {
            repoPath: '/repo',
            sessionId: 'orch-1234567890',
            reused: false,
            autoApproved: { id: 'c1', summary: 'Start the orchestrator of repo' },
          },
        },
      ]);
      // --wait returns at once: nothing is pending.
      expect(await runTaskCli('project', ['orchestrate', '--wait', 'Monta', 'login'], deps)).toBe(
        0
      );
      expect(out[0]).toBe(
        "Done without asking (the user's autoApprove is on): Start the orchestrator of repo"
      );
      expect(out[1]).toContain('started the orchestrator of repo');
    });
  });

  describe('project orchestrate', () => {
    const asked: TaskResponse = {
      ok: true,
      status: 'pending-confirmation',
      confirmation: {
        id: 'conf-0123456789',
        kind: 'project-orchestrate',
        createdAt: 'x',
        expiresAt: '2026-10-23T01:00:00.000Z',
        where: 'untether',
        repoPath: '/repo',
        summary: 'Start the orchestrator of untether',
        detail: ['Project: /repo', 'Goal:', 'Monta el login'],
        requestedBy: {},
      },
    };
    const outcome = (status: string, extra: Record<string, unknown> = {}) =>
      done({
        id: 'conf-0123456789',
        status,
        confirmation: asked.ok && 'confirmation' in asked ? asked.confirmation : {},
        ...extra,
      });
    const started = {
      ok: true,
      status: 'done',
      data: { repoPath: '/repo', sessionId: 'orch-1234567890', reused: false },
    };

    it('asks the user and says how to wait; reads the goal from stdin', async () => {
      const { deps, calls, out } = cli([asked]);
      expect(await runTaskCli('project', ['orchestrate', '--repo', '..', '-'], deps)).toBe(0);
      expect(calls[0]).toMatchObject({
        op: 'project-orchestrate',
        args: { repo: '/repo', cwd: '/repo/web', goal: 'prompt from stdin\n' },
        caller: { sessionId: 'sess-9' },
      });
      const text = out.join('\n');
      expect(text).toContain("Waiting for the user's OK on the phone (confirmation conf-012)");
      expect(text).toContain('  Goal:');
      expect(text).toContain('run the same command again with --wait');
      expect(calls).toHaveLength(1);
    });

    it('--wait polls the answer: approved says it started', async () => {
      const { deps, calls, out } = cli([
        asked,
        outcome('pending'),
        outcome('approved', { result: started }),
      ]);
      expect(
        await runTaskCli('project', ['orchestrate', '--wait', 'Monta', 'el', 'login'], deps)
      ).toBe(0);
      expect(calls[0].args).toMatchObject({ goal: 'Monta el login', cwd: '/repo/web' });
      expect(calls.slice(1).map((call) => call.op)).toEqual(['confirmation', 'confirmation']);
      expect(calls[1].args).toEqual({ id: 'conf-0123456789' });
      expect(out.at(-1)).toBe('→ started the orchestrator of repo (session orch-123)');
    });

    it('--wait: declined, expired or failed started nothing (exit 1)', async () => {
      for (const [status, says] of [
        ['declined', 'The user declined'],
        ['expired', 'expired unanswered'],
        ['unknown', 'The answer is unknown'],
      ]) {
        const { deps, err } = cli([asked, outcome(status)]);
        expect(await runTaskCli('project', ['orchestrate', '--wait', 'x'], deps)).toBe(1);
        expect(err.join('\n')).toContain(says);
      }
      const failed = cli([
        asked,
        outcome('approved', { result: { ok: false, code: 'busy', message: 'Already starting' } }),
      ]);
      expect(await runTaskCli('project', ['orchestrate', '--wait', 'x'], failed.deps)).toBe(1);
      expect(failed.err.join('\n')).toContain('could not start: Already starting');
    });

    it('--wait gives up after --timeout without an error; --json prints the outcome', async () => {
      const slow = cli(() => outcome('pending'));
      slow.deps.task.mockResolvedValueOnce(asked);
      expect(
        await runTaskCli('project', ['orchestrate', '--wait', '--timeout', '9', 'x'], slow.deps)
      ).toBe(0);
      expect(slow.out.at(-1)).toContain("Still waiting for the user's OK after 9s");

      const json = cli([asked, outcome('approved', { result: started })]);
      expect(await runTaskCli('project', ['orchestrate', '--wait', '--json', 'x'], json.deps)).toBe(
        0
      );
      expect(JSON.parse(json.out.join('\n'))).toMatchObject({
        ok: true,
        data: { status: 'approved', result: started },
      });
    });

    it('a goal given straight to a running orchestrator, and a missing goal', async () => {
      const { deps, out } = cli([
        done({ repoPath: '/repo', sessionId: 'orch-1234567890', reused: true, pending: true }),
      ]);
      expect(await runTaskCli('project', ['orchestrate', 'x'], deps)).toBe(0);
      expect(out.join('\n')).toBe(
        '→ gave the goal to the running orchestrator of repo (session orch-123)\nIts brief is typed in once its Claude is ready.'
      );
      const none = cli([]);
      expect(await runTaskCli('project', ['orchestrate'], none.deps)).toBe(1);
      expect(none.err[0]).toBe('Error: A goal is required');
      expect(none.calls).toHaveLength(0);
    });
  });
});

describe('merge queue in ut task list / show (2026-11-01)', () => {
  it('names its place in the project line while it waits, not once it is its turn', () => {
    const waiting = task({
      state: 'verifying',
      repoPath: '/Users/x/Projects/bakery',
      mergeQueue: { position: 2, of: 3, since: '2026-11-01T10:00:00.000Z' },
    });
    expect(formatTaskLine(waiting)).toContain('merge queue 2/3');
    expect(formatTaskDetail(waiting)).toContain(
      "merge:    2nd in bakery's merge queue (1 ahead, 3 in line); its check runs at its turn, on main as it is then"
    );
    const turn = { ...waiting, mergeQueue: { position: 1, of: 3, since: '' } };
    expect(formatTaskLine(turn)).not.toContain('merge queue');
    expect(formatTaskDetail(turn)).not.toContain('merge queue');
  });
});

describe('model and agent of a task in ut task (2026-11-01)', () => {
  it('new --model sends it as given (a level or a name)', async () => {
    const { deps, calls } = cli([done({ task: task(), tasks: [task()] })]);
    expect(await runTaskCli('task', ['new', '--model', 'fast', '--', 'Renombra'], deps)).toBe(0);
    expect(calls[0].args).toMatchObject({ prompt: 'Renombra', model: 'fast' });
  });

  it('show names the model, why, each change of agent and the offer of a pause', () => {
    const changed = task({
      agent: 'claude',
      model: 'sonnet',
      modelChoice: { tier: 'fast', by: 'router', reason: 'a rename' },
      agentChanges: [
        {
          at: '2026-11-01T01:00:00.000Z',
          from: { agent: 'codex', runner: 'codex', model: 'o4-mini' },
          to: { agent: 'claude', runner: 'claude', model: 'sonnet' },
          reason: 'You’ve hit your usage limit',
          by: 'auto',
        },
      ],
    });
    const detail = formatTaskDetail(changed);
    expect(detail).toContain('model:    sonnet · fast, router: a rename');
    expect(detail).toContain(
      'changed:  2026-11-01T01:00:00.000Z codex (o4-mini) → claude (sonnet), by itself: You’ve hit your usage limit'
    );
    expect(formatTaskDetail(task({}))).toContain("model:    the agent's default");
    // 2026-11-08: the real model read from its transcript, next to the asked one.
    const lastModel = { model: 'claude-opus-4-8', at: '2026-11-08T10:00:00.000Z' };
    const usage = {
      input: 1,
      cacheWrite: 0,
      cacheRead: 0,
      output: 1,
      turns: 1,
      maxContext: 1,
      compactions: 0,
      lastModel,
    };
    const metrics = { savings: { on: {} }, quality: { autoFixRounds: 0, riskRules: [] }, usage };
    expect(formatTaskDetail(task({ metrics }))).toContain(
      "model:    the agent's default; real: claude-opus-4-8"
    );
    expect(formatTaskDetail(task({ model: 'claude-opus-5-5', metrics }))).toContain(
      'model:    claude-opus-5-5; real: claude-opus-4-8 (not the asked model)'
    );
    const paused = task({
      state: 'paused',
      halt: {
        kind: 'usage-limit',
        message: 'limit',
        since: '2026-11-01T01:00:00.000Z',
        attempts: 0,
        offer: { agent: 'codex', runner: 'codex' },
      },
    });
    expect(formatTaskDetail(paused)).toContain(
      `offer:    'ut task retry ${paused.id.slice(0, 8)} --agent codex' goes on with it in the same worktree`
    );
  });
});

describe('check level in ut task status (2026-11-02, two-level checks)', () => {
  it('names the level that ran, why the whole one, and how long', () => {
    const related = task({
      state: 'merged',
      verify: {
        command: '(fast) && (related {files})',
        cwd: '/wt',
        startedAt: '2026-11-02T10:00:00.000Z',
        finishedAt: '2026-11-02T10:00:42.000Z',
        exitCode: 0,
        level: 'related',
        relatedFiles: 3,
      },
      timings: [
        {
          phase: 'verify',
          level: 'related',
          round: 1,
          startedAt: '2026-11-02T10:00:00.000Z',
          finishedAt: '2026-11-02T10:00:42.000Z',
          outcome: 'passed',
        },
        {
          phase: 'verify',
          level: 'batch',
          round: 1,
          startedAt: '2026-11-02T10:01:00.000Z',
          finishedAt: '2026-11-02T10:04:00.000Z',
          outcome: 'passed (the batch of 2)',
        },
      ],
    });
    const detail = formatTaskDetail(related, { now: Date.parse('2026-11-02T10:05:00.000Z') });
    expect(detail).toContain(
      'level:    related tests only (of 3 changed files); the whole check runs on the merge batch, 42s'
    );
    expect(detail).toContain(
      'check [related] 42s (passed), check [batch] 3m (passed (the batch of 2))'
    );
    const full = task({
      verify: {
        command: 'whole',
        cwd: '/wt',
        startedAt: '2026-11-02T10:00:00.000Z',
        level: 'full',
        fullReason: 'web/package.json reaches tests no import shows',
      },
    });
    expect(formatTaskDetail(full)).toContain(
      'level:    whole check (web/package.json reaches tests no import shows)'
    );
  });
});

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { textDeletes, untetherWrapper } from '../../shared/agent-prompt.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { slotCommand } from './check-slot-wrap.js';
import { withClaudeHooks } from './claude-hooks.js';
import { taskGuardCheck } from './doctor-checks.js';
import { ProjectSettingsPatchSchema } from './project-settings.js';
import { runGuardHook, runShellEnvHook } from './task-guard-hook.js';
import {
  codexGuardArgs,
  createTaskGuard,
  guardedClaudeSettings,
  guardHookCommand,
  TASK_UNATTENDED_CLAUDE_SETTINGS,
} from './task-guard-setup.js';
import { guardApplied, taskCommand } from './task-launcher.js';
import { summarizedCommand } from './task-output.js';
import { readShellGroups, recordShellGroup, shellGroupsTrouble } from './task-processes.js';
import { TaskScheduler } from './task-scheduler.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-guard-'));
});

afterEach(() => {
  fs.rmSync(dir, RM_TEST_DIR);
});

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'abc123',
    name: 'x',
    prompt: 'p',
    workingDir: '/repo',
    command: ['claude'],
    agent: 'claude',
    shielded: true,
    notify: false,
    runAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    state: 'scheduled',
    stateSince: new Date().toISOString(),
    isolation: 'worktree',
    origin: 'user',
    followUps: [],
    files: [],
    repoPath: '/repo',
    baseBranch: 'main',
    branch: 'ut/x',
    ...overrides,
  } as TaskRecord;
}

describe('createTaskGuard', () => {
  it('writes the policy and Claude settings with the event hooks and the guard first', () => {
    const guard = createTaskGuard({
      untetherDir: dir,
      home: '/Users/alex',
      hook: ['/usr/bin/node', '/x/task-guard-hook.ts'],
      settings: () => ({ guardOff: ['sudo'], guardDeny: ['terraform apply'] }),
    });
    const prepared = guard.prepare(task({ worktreePath: '/wt/x' }), '/wt/x');
    expect(prepared).not.toBeNull();
    const policyFile = path.join(dir, 'agent-hooks', 'tasks', 'abc123', 'policy.json');
    const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    expect(policy).toMatchObject({
      taskId: 'abc123',
      root: '/wt/x',
      baseRoot: '/repo',
      baseBranch: 'main',
      branch: 'ut/x',
      off: ['sudo'],
      deny: ['terraform apply'],
    });
    const settings = JSON.parse(fs.readFileSync(prepared?.claudeSettings as string, 'utf8'));
    const pre = settings.hooks.PreToolUse;
    expect(pre[0].hooks[0].command).toBe(`'/usr/bin/node' '/x/task-guard-hook.ts' '${policyFile}'`);
    expect(pre[1].hooks[0].command).toContain('claude-event.sh');
    // Its shells record their group from Claude's env file, written at SessionStart.
    const start = settings.hooks.SessionStart;
    expect(start[0].hooks[0].command).toBe(
      `'/usr/bin/node' '/x/task-guard-hook.ts' '--shell-env' '${policyFile}'`
    );
    expect(start[1].hooks[0].command).toContain('claude-event.sh');
    expect(settings.hooks.Stop).toBeDefined();
    // The written file turns off what only a human watching needs (2026-11-03).
    expect(settings).toMatchObject(TASK_UNATTENDED_CLAUDE_SETTINGS);
    // A Claude task does not ask Codex anything.
    expect(prepared?.codexArgs).toBeNull();
  });

  it('merges a provider task /model picker into the Claude settings (model-providers.ts)', () => {
    const picker = {
      modelPicker: {
        replaceBuiltInOptions: true,
        options: [{ model: 'abliterated-model-large-v2', label: 'Large v2' }],
      },
      model: 'abliterated-model-large-v2',
    };
    const guard = createTaskGuard({
      untetherDir: dir,
      hook: ['h'],
      providerSettings: (t) => (t.modelProvider ? picker : undefined),
    });
    const prepared = guard.prepare(
      task({
        worktreePath: '/wt/x',
        modelProvider: 'abliteration',
        model: 'abliterated-model-large-v2',
      }),
      '/wt/x'
    );
    const settings = JSON.parse(fs.readFileSync(prepared?.claudeSettings as string, 'utf8'));
    // Only the provider's models in /model, no Anthropic rows; the guard hooks are still there.
    expect(settings.modelPicker).toEqual(picker.modelPicker);
    expect(settings.model).toBe('abliterated-model-large-v2');
    expect(settings.hooks.PreToolUse).toBeDefined();
  });

  it('a plain task gets no modelPicker', () => {
    const guard = createTaskGuard({
      untetherDir: dir,
      hook: ['h'],
      providerSettings: (t) => (t.modelProvider ? { modelPicker: {} } : undefined),
    });
    const prepared = guard.prepare(task({ worktreePath: '/wt/x' }), '/wt/x');
    const settings = JSON.parse(fs.readFileSync(prepared?.claudeSettings as string, 'utf8'));
    expect(settings.modelPicker).toBeUndefined();
  });

  it('gives a Codex task its hook flags only when Codex takes unreviewed hooks', () => {
    const make = (ok: boolean) =>
      createTaskGuard({ untetherDir: dir, hook: ['h'], codexTakesHookTrust: () => ok }).prepare(
        task({ agent: 'codex', command: ['codex'] }),
        '/wt/x'
      );
    expect(make(true)?.codexArgs?.[0]).toBe('--dangerously-bypass-hook-trust');
    expect(make(false)?.codexArgs).toBeNull();
  });

  it('reads back what the hook blocked, and records a task that runs unguarded', () => {
    const guard = createTaskGuard({ untetherDir: dir, hook: ['h'] });
    guard.prepare(task(), '/wt/x');
    expect(guard.blockedStamp('abc123')).toBeNull();
    guard.unguarded(task(), 'its command names its own --settings');
    const entries = guard.blocked('abc123');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ rule: 'guard-error' });
    expect(guard.blockedStamp('abc123')).not.toBeNull();
  });

  it('returns null (unguarded) when its folder cannot be written', () => {
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, '');
    expect(createTaskGuard({ untetherDir: file, hook: ['h'] }).prepare(task(), '/wt')).toBeNull();
  });
});

describe('runGuardHook', () => {
  function policyFile(): string {
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        taskId: 't',
        root: '/wt/x',
        baseBranch: 'main',
        home: '/Users/alex',
        blockedLog: path.join(dir, 'blocked.jsonl'),
      })
    );
    return file;
  }

  it('exits 2 with the reason and logs the block; exits 0 on an allowed call', () => {
    const file = policyFile();
    let said = '';
    const call = (command: string) =>
      runGuardHook(
        file,
        JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/wt/x' }),
        (text) => {
          said += text;
        }
      );
    expect(call('git push --force')).toBe(2);
    expect(said).toContain('git-push');
    expect(call('git status')).toBe(0);
    const log = fs.readFileSync(path.join(dir, 'blocked.jsonl'), 'utf8').trim().split('\n');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0])).toMatchObject({
      rule: 'git-push',
      tool: 'Bash',
      what: 'git push --force',
    });
  });

  it('lets a command it cannot judge run, and writes it down as uncertain', () => {
    const file = policyFile();
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf "$X"' },
      cwd: '/wt/x',
    });
    expect(runGuardHook(file, input, () => {})).toBe(0);
    const log = fs.readFileSync(path.join(dir, 'blocked.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(log[0])).toMatchObject({ rule: 'uncertain', what: 'rm -rf "$X"' });
  });

  it('Claude: a Bash call let run is left exactly as the agent wrote it (2026-11-11)', () => {
    const file = policyFile();
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...policy, recordShellGroups: true }));
    let out = '';
    const call = (command: string, tool = 'Bash') =>
      runGuardHook(
        file,
        JSON.stringify({ tool_name: tool, tool_input: { command, timeout: 5 }, cwd: '/wt/x' }),
        () => {},
        (text) => {
          out += text;
        }
      );
    // No updatedInput: the shell-group record used to go in front of every command, and its
    // `rm` made Claude Code ask permission for the ones it could not analyse whole.
    expect(call('git status')).toBe(0);
    // The shape that sat 4 h on a prompt (bakery 19112d1a): a heredoc, then `bash -c '…'`.
    expect(
      call(
        [
          "python3 - <<'EOF'",
          "old='''  elif grep -qE '^(import|  )[^;]* from \"\\\\./llave-[a-z-]+\\\\.mjs\";$' \"$f\"; then bad'''",
          'EOF',
          'b19() { bash -c \'fail=0; bad() { echo "FALLO: $*"; fail=1; }; source scripts/check.d/19.sh; echo "fail=$fail"\'; }',
          'b19 | tail -3',
        ].join('\n')
      )
    ).toBe(0);
    expect(call('rm -rf "$X"')).toBe(0); // let run as uncertain: as written too
    expect(call('git push --force')).toBe(2);
    expect(call('ls', 'Read')).toBe(0);
    expect(out).toBe('');
  });

  it('Claude: the SessionStart hook has every Bash shell record its group, outside the command', () => {
    const file = policyFile();
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...policy, recordShellGroups: true }));
    const groups = path.join(dir, 'groups');
    const envFile = path.join(dir, 'sessionstart-hook-0.sh');
    // Another hook's lines are kept; a resumed session (same file again) adds nothing.
    fs.writeFileSync(envFile, 'export OTHER=1');
    expect(runShellEnvHook(file, envFile)).toBe(0);
    expect(runShellEnvHook(file, envFile)).toBe(0);
    const env = fs.readFileSync(envFile, 'utf8');
    expect(env).toBe(`export OTHER=1\n${recordShellGroup(groups)}`);
    // Claude runs the env file in the command's own shell: a file named after its pid.
    const ran = spawnSync('/bin/sh', ['-c', `. '${envFile}'\necho $$ $OTHER`], {
      encoding: 'utf8',
    });
    const [pid, other] = ran.stdout.trim().split(' ');
    expect(other).toBe('1');
    expect([...readShellGroups(groups).keys()]).toEqual([Number(pid)]);
    expect(fs.existsSync(path.join(dir, 'blocked.jsonl'))).toBe(false);
  });

  it('Claude: no env file from Claude, or one that cannot be written, is on the task (never fatal)', () => {
    const file = policyFile();
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...policy, recordShellGroups: true }));
    expect(runShellEnvHook(file, '')).toBe(0);
    expect(runShellEnvHook(file, path.join(dir, 'no-such-folder', 'env.sh'))).toBe(0);
    const log = fs
      .readFileSync(path.join(dir, 'blocked.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(log.map((entry) => entry.rule)).toEqual(['guard-error', 'guard-error']);
    expect(log[0].reason).toContain('no CLAUDE_ENV_FILE');
    expect(log[1].reason).toContain('could not be written');
    // Codex (no recordShellGroups) and a session that is not a task: nothing done.
    fs.writeFileSync(file, JSON.stringify(policy));
    const envFile = path.join(dir, 'env.sh');
    expect(runShellEnvHook(file, envFile)).toBe(0);
    expect(runShellEnvHook(path.join(dir, 'missing.json'), envFile)).toBe(0);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it('Claude: shells that stop recording their group are told once, on the task', () => {
    const file = policyFile();
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...policy, recordShellGroups: true }));
    const groups = path.join(dir, 'groups');
    const envFile = path.join(dir, 'env.sh');
    const bash = () =>
      runGuardHook(
        file,
        JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/wt/x' }),
        () => {},
        () => {}
      );
    const told = () => {
      try {
        return fs.readFileSync(path.join(dir, 'blocked.jsonl'), 'utf8').trim().split('\n');
      } catch {
        return [];
      }
    };
    // A session whose SessionStart hook never ran (started before it existed): not judged.
    expect(shellGroupsTrouble(groups)).toBeNull();
    runShellEnvHook(file, envFile);
    // Bash calls for over a minute and no shell ran the line: Claude no longer runs its env file.
    expect(shellGroupsTrouble(groups)).toBeNull();
    expect(shellGroupsTrouble(groups, Date.now() + 30_000)).toBeNull();
    expect(shellGroupsTrouble(groups, Date.now() + 120_000)).toContain('no shell ran');
    expect(shellGroupsTrouble(groups, Date.now() + 180_000)).toBeNull(); // told once
    // A shell that ran it: nothing to tell, through the hook either.
    fs.rmSync(path.join(groups, '.told'));
    spawnSync('/bin/sh', ['-c', `. '${envFile}'`]);
    expect(shellGroupsTrouble(groups, Date.now() + 120_000)).toBeNull();
    expect(bash()).toBe(0);
    expect(told()).toEqual([]);
    // The env file lost the line (or is gone): told by the hook, once.
    fs.writeFileSync(envFile, '');
    expect(bash()).toBe(0);
    expect(bash()).toBe(0);
    expect(told()).toHaveLength(1);
    expect(JSON.parse(told()[0])).toMatchObject({ rule: 'guard-error', tool: 'Bash' });
    expect(JSON.parse(told()[0]).reason).toContain("no longer in Claude's env file");
  });

  it("Untether's own wrappers bring nothing Claude Code's own checks look at (2026-11-11)", () => {
    // Reproduced with a real Claude Code 2.1.322 under --dangerously-skip-permissions: an `rm`
    // anywhere in the command starts its dangerous-removal check, which asks permission when
    // it cannot analyse the rest (a heredoc, a `bash -c` script). The wrappers around a
    // check command carry no deleting command, no nested shell script and no eval, so they
    // never turn the agent's own command into one that check looks at.
    const BODY = 'BODY';
    const wrappers = [
      summarizedCommand(BODY, 'auto', '/u/output/x.log', ['/app/untether', 'guard-hook']),
      slotCommand(BODY, BODY, ['/app/untether']),
      slotCommand(BODY, BODY, ['/app/untether'], true),
      slotCommand(
        summarizedCommand(BODY, 'auto', '/u/output/x.log', ['/app/untether', 'guard-hook']),
        BODY,
        ['/app/untether'],
        true
      ),
    ];
    for (const wrapper of wrappers) {
      expect(textDeletes(wrapper)).toBe(false);
      expect(wrapper).not.toMatch(/\b(?:rm|rmdir|unlink|eval)\b/);
      expect(wrapper).not.toMatch(/\b(?:ba|z|da)?sh\s+-\w*c\b/);
      // And a prompt on one is known as Untether's (the net: shared/agent-prompt.ts).
      expect(untetherWrapper(`Permission for Bash: ${wrapper}`)).not.toBeNull();
    }
  });

  it('without recordShellGroups (Codex) nothing is written to stdout', () => {
    const file = policyFile();
    let out = '';
    runGuardHook(
      file,
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/wt/x' }),
      () => {},
      (text) => {
        out += text;
      }
    );
    expect(out).toBe('');
  });

  it('lets the call run without a policy, and records unreadable input', () => {
    expect(runGuardHook(path.join(dir, 'missing.json'), '{}')).toBe(0);
    const file = policyFile();
    expect(runGuardHook(file, 'not json')).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'blocked.jsonl'), 'utf8')).toContain('guard-error');
  });

  it('works as the real process (node + tsx on task-guard-hook.ts)', () => {
    const file = policyFile();
    // As a dev server runs it: this Node with tsx's loader on the hook's source.
    const hook = guardHookCommand({ sea: false, execArgv: ['--import', 'tsx'] });
    const run = (command: string) =>
      spawnSync(hook[0], [...hook.slice(1), file], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/wt/x' }),
        encoding: 'utf8',
        timeout: 30_000,
      });
    const blocked = run('rm -rf /Users/alex/Documents');
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('delete-outside');
    const allowed = run('rm -rf ./build');
    expect(allowed.status).toBe(0);
    expect(allowed.stderr).toBe('');
  });
});

describe('guardHookCommand', () => {
  it("runs the app's binary as `untether guard-hook`", () => {
    expect(guardHookCommand({ sea: true, execPath: '/app/untether' })).toEqual([
      '/app/untether',
      'guard-hook',
    ]);
  });

  it("runs a dev server's hook source with its loader flags", () => {
    const hookSource = path.join(dir, 'task-guard-hook.ts');
    fs.writeFileSync(hookSource, '');
    expect(
      guardHookCommand({
        sea: false,
        execPath: '/node',
        execArgv: ['--require', '/p.cjs', '--import', 'file:///l.mjs', '--max-old-space-size=4096'],
        hookSource,
      })
    ).toEqual(['/node', '--require', '/p.cjs', '--import', 'file:///l.mjs', hookSource]);
  });

  it('falls back to the server entry with guard-hook', () => {
    expect(
      guardHookCommand({
        sea: false,
        execPath: '/node',
        entry: '/dist/cli.js',
        hookSource: '/nope.ts',
      })
    ).toEqual(['/node', '/dist/cli.js', 'guard-hook']);
  });
});

describe('taskCommand with the guard', () => {
  const guard = {
    claudeSettings: '/u/agent-hooks/tasks/t/claude-settings.json',
    codexArgs: codexGuardArgs("'h' 'p'"),
  };

  it('puts --settings right after claude (env prefix kept), and counts it applied', () => {
    const command = taskCommand(
      task({
        command: ['env', 'CLAUDE_CONFIG_DIR=/w', 'claude', '--dangerously-skip-permissions'],
      }),
      guard
    );
    expect(command.slice(0, 5)).toEqual([
      'env',
      'CLAUDE_CONFIG_DIR=/w',
      'claude',
      '--settings',
      guard.claudeSettings,
    ]);
    expect(command).toContain('--allowedTools');
    expect(guardApplied(command, guard)).toBe(true);
  });

  it("leaves a command with the user's own --settings, and says the guard is not on", () => {
    const command = taskCommand(task({ command: ['claude', '--settings', '/mine.json'] }), guard);
    expect(command.filter((arg) => arg === '--settings')).toHaveLength(1);
    expect(guardApplied(command, guard)).toBe(false);
  });

  it('gives Codex the hook flags next to its update switch', () => {
    const command = taskCommand(
      task({ agent: 'codex', command: ['codex', '--dangerously-bypass-approvals-and-sandbox'] }),
      guard
    );
    expect(command).toContain('--dangerously-bypass-hook-trust');
    expect(command.find((arg) => arg.startsWith('hooks.PreToolUse='))).toContain(
      "command=\"'h' 'p'\""
    );
    expect(command).toContain('check_for_update_on_startup=false');
    expect(guardApplied(command, guard)).toBe(true);
    const old = taskCommand(task({ agent: 'codex', command: ['codex'] }), {
      ...guard,
      codexArgs: null,
    });
    expect(old).not.toContain('--dangerously-bypass-hook-trust');
    expect(guardApplied(old, { ...guard, codexArgs: null })).toBe(false);
  });

  it('a session that is not a task gets no guard', () => {
    expect(taskCommand(task())).not.toContain('--settings');
  });
});

describe("the spawn rewriter and a task's settings", () => {
  const shared = '/u/agent-hooks/claude-settings.json';

  it("keeps a task's own settings and still marks it hooked (a new array)", () => {
    const command = ['claude', '--settings', '/u/agent-hooks/tasks/t/claude-settings.json'];
    const out = withClaudeHooks(command, shared);
    expect(out).toEqual(command);
    expect(out).not.toBe(command);
  });

  it("leaves the user's own settings as they were (same array)", () => {
    const command = ['claude', '--settings', '/home/me/mine.json'];
    expect(withClaudeHooks(command, shared)).toBe(command);
  });
});

describe('guardedClaudeSettings', () => {
  it('adds the guard before the event hook of PreToolUse only', () => {
    const settings = guardedClaudeSettings('/s/claude-event.sh', "'g'") as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.PreToolUse.map((group) => group.hooks[0].command)).toEqual([
      "'g'",
      "'/s/claude-event.sh' PreToolUse",
    ]);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it('turns off what only serves a human watching, and nothing about the work (2026-11-03)', () => {
    const settings = guardedClaudeSettings('/s/claude-event.sh', "'g'") as Record<string, unknown>;
    expect(settings).toMatchObject({
      promptSuggestionEnabled: false,
      awaySummaryEnabled: false,
      spinnerTipsEnabled: false,
      feedbackSurveyRate: 0,
      env: {
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
        CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
        CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
      },
    });
    for (const work of [
      'model',
      'effortLevel',
      'modelSettings',
      'alwaysThinkingEnabled',
      'autoCompactEnabled',
      'idleCompaction',
      'permissions',
    ]) {
      expect(settings).not.toHaveProperty(work);
    }
    const env = settings.env as Record<string, string>;
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/COMPACT|THINKING|MODEL|EFFORT|NONESSENTIAL|TERMINAL_TITLE/);
    }
    // A copy each time: one task's file can't change the next one's.
    (settings.env as Record<string, string>).X = '1';
    expect(guardedClaudeSettings('/s/e.sh', "'g'")).not.toHaveProperty('env.X');
    expect(TASK_UNATTENDED_CLAUDE_SETTINGS.env).not.toHaveProperty('X');
  });
});

describe('TaskScheduler.syncGuardBlocks', () => {
  it("puts what the guard blocked on the working task's record, read again only on change", async () => {
    let stamp: string | null = null;
    const entries: Array<{ at: string; rule: string; tool: string; what: string; reason: string }> =
      [];
    let reads = 0;
    const scheduler = new TaskScheduler({
      storePath: path.join(dir, 'tasks.json'),
      launch: async () => ({ sessionId: 's1' }),
      notify: () => {},
      sessionStatus: () => 'running',
      guardLog: {
        stamp: () => stamp,
        read: () => {
          reads++;
          return [...entries];
        },
      },
    });
    await scheduler.start(0);
    const created = await scheduler.create({
      name: 'x',
      prompt: 'p',
      workingDir: dir,
      command: ['claude'],
      agent: 'claude',
      shielded: false,
      notify: false,
    });
    await scheduler.checkExited();
    expect(scheduler.list()[0].guardBlocks).toBeUndefined();
    for (let i = 0; i < 60; i++) {
      entries.push({
        at: `2026-11-02T00:00:${i}Z`,
        rule: 'git-push',
        tool: 'Bash',
        what: `git push ${i}`,
        reason: 'r',
      });
    }
    stamp = '1';
    await scheduler.checkExited();
    await scheduler.checkExited();
    const record = scheduler.list().find((entry) => entry.id === created.id);
    expect(record?.guardBlocks?.count).toBe(60);
    expect(record?.guardBlocks?.recent).toHaveLength(50);
    expect(record?.guardBlocks?.recent.at(-1)?.what).toBe('git push 59');
    expect(reads).toBe(1);
    scheduler.stop();
  });
});

describe('project guard settings', () => {
  it('takes known rules and patterns that compile, refuses the rest', () => {
    expect(
      ProjectSettingsPatchSchema.safeParse({ guardOff: ['git-push'], guardDeny: ['^make deploy'] })
        .success
    ).toBe(true);
    expect(ProjectSettingsPatchSchema.safeParse({ guardOff: ['everything'] }).success).toBe(false);
    expect(ProjectSettingsPatchSchema.safeParse({ guardAllow: ['(['] }).success).toBe(false);
    expect(ProjectSettingsPatchSchema.safeParse({ guardDeny: null }).success).toBe(true);
  });
});

describe('doctor task-guard', () => {
  it('warns about an open task whose agent runs unguarded, not about one that was only blocked', async () => {
    const entry = (rule: string, reason: string) => ({
      at: 'x',
      rule,
      tool: '-',
      what: '',
      reason,
    });
    const findings = await taskGuardCheck({
      tasks: () => [
        {
          id: 'a',
          name: 'A',
          guardBlocks: {
            count: 1,
            recent: [entry('guard-error', 'the agent runs without the command guard: old Codex')],
          },
        },
        { id: 'b', name: 'B', guardBlocks: { count: 1, recent: [entry('git-push', 'no push')] } },
        { id: 'c', name: 'C' },
      ],
    }).run();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ key: 'task-guard:a', severity: 'warning' });
    expect(findings[0].problem).toContain('old Codex');
  });
});

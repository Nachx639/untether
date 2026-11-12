import * as os from 'os';
import { describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import {
  agentExecutable,
  CODEX_NO_TOOLTIPS,
  CODEX_NO_UPDATE_CHECK,
  createTaskLauncher,
  createTaskResumer,
  modelForLevel,
  TASK_ALLOWED_TOOLS,
  TASK_RESUME_TEXT,
  taskCommand,
  taskRunners,
} from './task-launcher.js';

vi.mock('../utils/git-info.js', () => ({ detectGitInfo: vi.fn(async () => ({})) }));

const task: TaskRecord = {
  id: 't1',
  name: 'Resume el repo',
  prompt: 'Resume {folder}',
  workingDir: os.tmpdir(),
  command: ['claude', '--dangerously-skip-permissions'],
  agent: 'claude',
  shielded: true,
  notify: true,
  runAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  state: 'working',
  stateSince: new Date().toISOString(),
  isolation: 'none',
  origin: 'user',
  followUps: [],
  files: [],
};

describe('createTaskLauncher provider tasks', () => {
  const providerTask: TaskRecord = {
    ...task,
    modelProvider: 'abliteration',
    model: 'abliterated-model-large-v2',
  };
  const launch = {
    marker: { id: 'abliteration', model: 'abliterated-model-large-v2' },
    env: { ANTHROPIC_BASE_URL: 'https://api.abliteration.ai', ANTHROPIC_AUTH_TOKEN: 'k' },
    unset: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  };

  it('passes the provider env, removals and marker to createSession', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'p', sessionInfo: {} }));
    const run = createTaskLauncher({
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => vi.fn(),
      providerEnv: async () => launch,
    });
    await run(providerTask, 'Do it', 'p');
    expect(createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        env: launch.env,
        unsetEnv: launch.unset,
        modelProvider: launch.marker,
      })
    );
  });

  it('fails the launch when the provider key cannot be read (never runs on the user login)', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'p', sessionInfo: {} }));
    const run = createTaskLauncher({
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => vi.fn(),
      providerEnv: async () => {
        throw new Error('no key');
      },
    });
    await expect(run(providerTask, 'Do it', 'p')).rejects.toThrow(/no key/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('a plain task gets no provider options', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'n', sessionInfo: {} }));
    const run = createTaskLauncher({
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => vi.fn(),
      providerEnv: async () => launch,
    });
    await run(task, 'Do it', 'n');
    const opts = (createSession.mock.calls[0] as unknown[])[1];
    expect(opts).not.toHaveProperty('env');
    expect(opts).not.toHaveProperty('modelProvider');
  });
});

describe('createTaskLauncher', () => {
  it('puts the Node its project asks for first and tells its agent once, with the task (2026-11-02)', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'n', sessionInfo: {} }));
    const deliver = vi.fn();
    const requirements = [{ range: '<25', source: 'package.json (engines.node)' }];
    const switched = createTaskLauncher({
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => deliver,
      nodeRuntime: async () => ({
        kind: 'switch',
        requirements,
        defaultVersion: '26.0.0',
        node: { version: '24.1.0', bin: '/n24/bin', source: 'nvm' },
      }),
    });
    const launched = await switched(task, 'Do it', 'n');
    expect(createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pathPrepend: '/n24/bin' })
    );
    expect(launched.text).toMatch(/^\[untether\] Node v24\.1\.0 .*\n\nDo it$/s);
    expect(deliver).toHaveBeenCalledWith('n', launched.text, 'claude');

    createSession.mockClear();
    const missing = createTaskLauncher({
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => deliver,
      nodeRuntime: async () => ({
        kind: 'missing',
        requirements,
        defaultVersion: '26.0.0',
        installed: [],
      }),
    });
    const told = await missing(task, 'Do it', 'm');
    expect(told.text).toContain('no installed Node fits');
    expect((createSession.mock.calls[0] as unknown[])[1]).not.toHaveProperty('pathPrepend');

    // A resume keeps the Node and says nothing again.
    createSession.mockClear();
    const resume = createTaskResumer({
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => deliver,
      nodeRuntime: async () => ({
        kind: 'switch',
        requirements,
        node: { version: '24.1.0', bin: '/n24/bin', source: 'nvm' },
      }),
    });
    const resumed = await resume(task, 'conv', 'r');
    expect(resumed.text).toBe(TASK_RESUME_TEXT);
    expect(createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pathPrepend: '/n24/bin' })
    );
  });

  it('a project that asks nothing of Node changes nothing', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'z', sessionInfo: {} }));
    const launch = createTaskLauncher({
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => vi.fn(),
      nodeRuntime: async () => ({ kind: 'none' }),
    });
    expect((await launch(task, 'Same', 'z')).text).toBe('Same');
    expect((createSession.mock.calls[0] as unknown[])[1]).not.toHaveProperty('pathPrepend');
  });

  it('starts the command shielded and hands the prompt to the initial-input flow', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'abc', sessionInfo: {} }));
    const deliver = vi.fn();
    const launch = createTaskLauncher({
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => deliver,
    });
    const launched = await launch(task, 'Resume tmp', 'abc');
    expect(launched).toMatchObject({ sessionId: 'abc', text: 'Resume tmp' });
    // Whether the prompt went in is handed back (2026-10-20: it was dropped silently).
    expect(launched.typed).toBeInstanceOf(Promise);
    expect(createSession).toHaveBeenCalledWith(
      ['claude', '--dangerously-skip-permissions'],
      // With the id the scheduler recorded first (task journal, 2026-11-01).
      // Marked with its task (2026-11-02): every process it starts carries UNTETHER_TASK_ID.
      expect.objectContaining({
        name: 'Resume el repo',
        shielded: true,
        sessionId: 'abc',
        taskId: 't1',
      })
    );
    expect(deliver).toHaveBeenCalledWith('abc', 'Resume tmp', 'claude');
  });

  it("a security sweep's agent runs unshielded and without credentials (2026-10-23)", async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'abc', sessionInfo: {} }));
    const launch = createTaskLauncher({
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => vi.fn(async () => true),
    });
    await launch(
      {
        ...task,
        isolation: 'worktree',
        worktreePath: os.tmpdir(),
        security: { kind: 'sweep', section: 'web' },
      },
      'x',
      'abc'
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ shielded: false, withoutSecrets: true })
    );
    // A confirmed fix is a normal task again: shielded, with the user's environment.
    createSession.mockClear();
    await launch(
      { ...task, isolation: 'worktree', worktreePath: os.tmpdir(), security: { kind: 'fix' } },
      'x',
      'abc'
    );
    const options = (createSession.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(options).toMatchObject({ shielded: true });
    expect(options.withoutSecrets).toBeUndefined();
  });

  it('refuses a shielded task without tmux and a missing folder', async () => {
    const createSession = vi.fn();
    const launchNoTmux = createTaskLauncher({
      ptyManager: { createSession, isShieldAvailable: () => false } as never,
      deliverInitialInput: () => vi.fn(),
    });
    await expect(launchNoTmux(task, 'x', 'abc')).rejects.toThrow(/tmux/);
    const launch = createTaskLauncher({
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => vi.fn(),
    });
    await expect(
      launch({ ...task, workingDir: '/definitely/not/here' }, 'x', 'abc')
    ).rejects.toThrow(/Folder not found/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('starts a worktree task in its worktree, allowing the task tools and trusting the folder', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'wt', sessionInfo: {} }));
    const deliver = vi.fn();
    const launch = createTaskLauncher({
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => deliver,
    });
    const worktreePath = os.tmpdir();
    await launch(
      {
        ...task,
        isolation: 'worktree',
        worktreePath,
        workingDir: '/not/used',
        command: ['claude'],
      },
      'p',
      'wt'
    );
    expect(createSession).toHaveBeenCalledWith(
      [
        'claude',
        '--allowedTools',
        'Bash(ut task done:*)',
        'Bash(ut task ask:*)',
        'Bash(ut task handoff:*)',
        'Bash(ut project tools want:*)',
      ],
      expect.objectContaining({ workingDir: worktreePath })
    );
    expect(deliver).toHaveBeenCalledWith('wt', 'p', 'claude', { trustFolder: true });
    await expect(launch({ ...task, isolation: 'worktree' }, 'p', 'wt')).rejects.toThrow(
      /no worktree/
    );
  });

  it('runs every task shielded when tmux is there, asked or not (2026-10-18, no worktree 2026-10-20)', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'wt', sessionInfo: {} }));
    const make = (shield: boolean) =>
      createTaskLauncher({
        ptyManager: { createSession, isShieldAvailable: () => shield } as never,
        deliverInitialInput: () => vi.fn(),
      });
    const wt = {
      ...task,
      shielded: false,
      isolation: 'worktree' as const,
      worktreePath: os.tmpdir(),
    };
    await make(true)(wt, 'p', 'wt');
    await make(false)(wt, 'p', 'wt');
    await make(true)({ ...task, shielded: false }, 'p', 'wt');
    expect(createSession.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      expect.objectContaining({ shielded: true }),
      expect.objectContaining({ shielded: false }),
      expect.objectContaining({ shielded: true }),
    ]);
  });

  it('resumes a worktree task’s conversation in its worktree and tells it to carry on', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'again', sessionInfo: {} }));
    const deliver = vi.fn();
    const resume = createTaskResumer({
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => deliver,
    });
    const worktreePath = os.tmpdir();
    const wt = { ...task, isolation: 'worktree' as const, worktreePath, command: ['claude'] };
    const resumed = await resume(wt, 'conv-1', 'again');
    expect(resumed).toMatchObject({ sessionId: 'again', text: TASK_RESUME_TEXT });
    expect(createSession).toHaveBeenCalledWith(
      [
        'claude',
        '--allowedTools',
        'Bash(ut task done:*)',
        'Bash(ut task ask:*)',
        'Bash(ut task handoff:*)',
        'Bash(ut project tools want:*)',
        '--resume',
        'conv-1',
      ],
      expect.objectContaining({ workingDir: worktreePath, shielded: true, sessionId: 'again' })
    );
    expect(deliver).toHaveBeenCalledWith('again', TASK_RESUME_TEXT, 'claude', {
      trustFolder: true,
    });
    // A task without a worktree reopens in its own folder (2026-10-20).
    await resume({ ...task }, 'conv-1', 'again-2');
    expect(createSession).toHaveBeenLastCalledWith(
      expect.arrayContaining(['--resume', 'conv-1']),
      expect.objectContaining({ workingDir: os.tmpdir() })
    );
    await expect(
      resume({ ...task, isolation: 'worktree' as const, worktreePath: undefined }, 'conv-1', 'x')
    ).rejects.toThrow(/worktree/);
  });

  it('adds the task tools only to a worktree task that starts Claude itself', () => {
    expect(taskCommand({ command: ['claude'], agent: 'claude', isolation: 'none' })).toEqual([
      'claude',
    ]);
    expect(
      taskCommand({ command: ['codex'], agent: 'codex', isolation: 'worktree' })
    ).not.toContain('--allowedTools');
    expect(
      taskCommand({ command: ['zsh', '-lc', 'claude'], agent: 'claude', isolation: 'worktree' })
    ).toEqual(['zsh', '-lc', 'claude']);
  });
});

describe("a task's Codex (2026-10-23)", () => {
  it('starts without its update prompt, whatever the isolation', () => {
    for (const isolation of ['none', 'worktree'] as const) {
      expect(
        taskCommand({ command: ['/opt/homebrew/bin/codex', '--yolo'], agent: 'codex', isolation })
      ).toEqual([
        '/opt/homebrew/bin/codex',
        ...CODEX_NO_UPDATE_CHECK,
        ...CODEX_NO_TOOLTIPS,
        '--yolo',
      ]);
    }
    expect(CODEX_NO_UPDATE_CHECK).toEqual(['-c', 'check_for_update_on_startup=false']);
    // Set by the user already: left as it is.
    const own = ['codex', '-c', 'check_for_update_on_startup=true', '-c', 'tui.show_tooltips=true'];
    expect(taskCommand({ command: own, agent: 'codex', isolation: 'none' })).toEqual(own);
    // Claude's command is not touched by it.
    expect(taskCommand({ command: ['claude'], agent: 'claude', isolation: 'none' })).toEqual([
      'claude',
    ]);
  });
});

describe("a task's Codex without its tooltips (2026-11-03)", () => {
  it('starts without the welcome tooltips nobody watches, unless the user set them', () => {
    expect(CODEX_NO_TOOLTIPS).toEqual(['-c', 'tui.show_tooltips=false']);
    expect(taskCommand({ command: ['codex'], agent: 'codex', isolation: 'worktree' })).toContain(
      'tui.show_tooltips=false'
    );
    // Only the update switch set by the user: the tooltips switch is still added.
    expect(
      taskCommand({
        command: ['codex', '-c', 'check_for_update_on_startup=true'],
        agent: 'codex',
        isolation: 'none',
      })
    ).toEqual(['codex', ...CODEX_NO_TOOLTIPS, '-c', 'check_for_update_on_startup=true']);
    // Claude's command is not touched by it.
    expect(taskCommand({ command: ['claude'], agent: 'claude', isolation: 'none' })).not.toContain(
      'tui.show_tooltips=false'
    );
  });
});

describe("a task's model and runners (2026-11-01)", () => {
  it('runs with its model (over one its command names), past env and its variables', () => {
    expect(
      taskCommand({ command: ['claude'], agent: 'claude', isolation: 'none', model: 'sonnet' })
    ).toEqual(['claude', '--model', 'sonnet']);
    expect(
      taskCommand({ command: ['codex', '--yolo'], agent: 'codex', isolation: 'none', model: 'o4' })
    ).toEqual(['codex', ...CODEX_NO_UPDATE_CHECK, ...CODEX_NO_TOOLTIPS, '-m', 'o4', '--yolo']);
    // The quick start's own model gives way: what runs is what the card says.
    expect(
      taskCommand({
        command: ['claude', '--model', 'opus', '--verbose'],
        agent: 'claude',
        isolation: 'none',
        model: 'sonnet',
      })
    ).toEqual(['claude', '--model', 'sonnet', '--verbose']);
    expect(
      taskCommand({ command: ['codex', '-m=o3'], agent: 'codex', isolation: 'none', model: 'o4' })
    ).toEqual(['codex', ...CODEX_NO_UPDATE_CHECK, ...CODEX_NO_TOOLTIPS, '-m=o4']);
    // A shell wrapping the agent: left as it is.
    expect(
      taskCommand({
        command: ['zsh', '-lc', 'claude'],
        agent: 'claude',
        isolation: 'none',
        model: 'sonnet',
      })
    ).toEqual(['zsh', '-lc', 'claude']);
    // No model: the command as it was.
    const own = ['claude', '--model', 'opus'];
    expect(taskCommand({ command: own, agent: 'claude', isolation: 'none' })).toEqual(own);
    expect(
      taskCommand({
        command: ['env', 'CLAUDE_CONFIG_DIR=/x', 'claude'],
        agent: 'claude',
        isolation: 'worktree',
        model: 'sonnet',
      })
    ).toEqual([
      'env',
      'CLAUDE_CONFIG_DIR=/x',
      'claude',
      '--model',
      'sonnet',
      '--allowedTools',
      ...TASK_ALLOWED_TOOLS,
    ]);
    expect(agentExecutable(['env', 'A=1', 'B=2', '/usr/bin/codex'])).toEqual({
      index: 3,
      name: 'codex',
    });
  });

  it("the installation's models per level: Claude's fast is sonnet unless configured", () => {
    expect(modelForLevel(undefined, 'claude', 'fast')).toBe('sonnet');
    expect(modelForLevel(undefined, 'claude', 'capable')).toBeUndefined();
    expect(modelForLevel(undefined, 'codex', 'fast')).toBeUndefined();
    const own = { claude: { fast: 'haiku', capable: 'opus' }, codex: { fast: 'o4-mini' } };
    expect(modelForLevel(own, 'claude', 'fast')).toBe('haiku');
    expect(modelForLevel(own, 'claude', 'capable')).toBe('opus');
    expect(modelForLevel(own, 'codex', 'fast')).toBe('o4-mini');
  });

  it('runners: the configured fallbacks, else both agents; only programs on this Mac', () => {
    const agentCommand = (agent: 'claude' | 'codex') => [agent];
    const argv = (command: string) => command.split(' ');
    expect(
      taskRunners({ fallbacks: undefined, agentCommand, argv, available: { codex: false } })
    ).toEqual([{ name: 'claude', agent: 'claude', command: ['claude'] }]);
    expect(
      taskRunners({
        fallbacks: [
          { name: 'claude-work', agent: 'claude', command: 'env CLAUDE_CONFIG_DIR=/w claude' },
          { name: 'codex', agent: 'codex', model: 'o4' },
          { name: 'codex', agent: 'codex' },
        ],
        agentCommand,
        argv,
        available: {},
      })
    ).toEqual([
      {
        name: 'claude-work',
        agent: 'claude',
        command: ['env', 'CLAUDE_CONFIG_DIR=/w', 'claude'],
      },
      { name: 'codex', agent: 'codex', command: ['codex'], model: 'o4' },
    ]);
  });
});

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionProviderMarker } from '../../shared/model-providers.js';
import type { Session, TerminalClaude } from '../../shared/types.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { ModelProvider } from '../../types/config.js';
import type { ProcessTable } from './claude-chat.js';
import {
  keepShellAfterClaude,
  shieldReopenPlan,
  shieldRestorePlan,
  terminalClaudeNoticePlan,
} from './shielded-tmux.js';
import {
  configuredProviderFor,
  detectedProviderFor,
  differingBackendVars,
  lookForTerminalClaudes,
  type ProcessEnv,
  parseProcessEnv,
  providerReproduces,
  readProcessEnvs,
  recordTerminalClaudes,
  safeClaudeFlags,
} from './terminal-claude.js';

// Not credentials, but the shape of a value that must never reach disk.
const PRIVATE_VALUE = 'private-value-never-saved';
const PROVIDER_URL = 'https://models.example.test';
const START = 'Sun Nov 8 20:10:41 2026';

function table(tree: Record<number, number[]>, args: Record<number, string> = {}): ProcessTable {
  const children = new Map(Object.entries(tree).map(([p, c]) => [Number(p), c]));
  const pids = [...children.keys(), ...[...children.values()].flat()];
  return {
    children,
    starts: new Map(pids.map((pid) => [pid, START])),
    args: new Map(Object.entries(args).map(([p, a]) => [Number(p), a])),
    procs: new Map(),
    extended: true,
  };
}

const session = (fields: Partial<Session>): Session =>
  ({
    id: 's1',
    name: 'terminal',
    command: ['zsh', '-l', '-i'],
    workingDir: '/w',
    status: 'running',
    startedAt: '2026-11-08T00:00:00Z',
    shielded: true,
    ...fields,
  }) as Session;

const record = (fields: Partial<TerminalClaude> = {}): TerminalClaude => ({
  conversationId: 'conv-1',
  pid: 42,
  cwd: '/work/repo',
  flags: [],
  customEnv: [],
  ...fields,
});

describe('finding Claude in a terminal', () => {
  let claudeDir: string;
  const writeEntry = (dir: string, pid: number, fields: Record<string, unknown> = {}) => {
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'sessions', `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: `conv-${pid}`,
        cwd: `/work/${pid}`,
        procStart: START,
        kind: 'interactive',
        entrypoint: 'cli',
        status: 'idle',
        startedAt: Date.now(),
        ...fields,
      })
    );
  };

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-claude-'));
  });
  afterEach(() => fs.rmSync(claudeDir, RM_TEST_DIR));

  const look = (roots: number[], processes: ProcessTable, envs = new Map<number, ProcessEnv>()) =>
    lookForTerminalClaudes(roots, {
      claudeDir,
      table: async () => processes,
      readEnvs: async () => envs,
    }).then(({ claudes }) => claudes);

  it('finds it under a launcher of any name, and only by its registry entry', async () => {
    writeEntry(claudeDir, 30);
    const found = await look(
      [10],
      table({ 10: [20], 20: [30] }, { 20: 'bash ./some-launcher', 30: 'not-even-called-that' })
    );
    expect(found.get(10)).toEqual({ pid: 30, conversationId: 'conv-30', cwd: '/work/30' });
  });

  it('finds nothing in a terminal without Claude', async () => {
    expect((await look([10], table({ 10: [20] }, { 20: 'vim' }))).size).toBe(0);
    expect((await look([10], table({}))).size).toBe(0);
  });

  it('keeps several terminals apart', async () => {
    writeEntry(claudeDir, 30);
    writeEntry(claudeDir, 31);
    const found = await look([10, 11, 12], table({ 10: [30], 11: [31], 12: [] }));
    expect(found.get(10)?.conversationId).toBe('conv-30');
    expect(found.get(11)?.conversationId).toBe('conv-31');
    expect(found.has(12)).toBe(false);
  });

  it('ignores one-off runs and an entry left by another process with that pid', async () => {
    writeEntry(claudeDir, 30, { kind: 'print' });
    writeEntry(claudeDir, 31, { entrypoint: 'sdk-cli' });
    writeEntry(claudeDir, 32, { procStart: 'Sat Nov 7 01:00:00 2026' });
    expect((await look([10], table({ 10: [30, 31, 32] }))).size).toBe(0);
  });

  it('takes the outermost Claude when one runs another', async () => {
    writeEntry(claudeDir, 30);
    writeEntry(claudeDir, 40);
    expect((await look([10], table({ 10: [30], 30: [40] }))).get(10)?.pid).toBe(30);
  });

  it('finds a Claude whose launcher gave it another home', async () => {
    const otherHome = path.join(claudeDir, 'other-home');
    writeEntry(otherHome, 30);
    const envs = new Map([[30, new Map([['CLAUDE_CONFIG_DIR', otherHome]])]]);
    expect((await look([10], table({ 10: [30] }), envs)).get(10)?.pid).toBe(30);
  });
});

describe('reading a process environment', () => {
  it('splits NAME=value words', () => {
    const env = parseProcessEnv(`PATH=/bin:/usr/bin ANTHROPIC_BASE_URL=${PROVIDER_URL} EMPTY=`);
    expect(env.get('ANTHROPIC_BASE_URL')).toBe(PROVIDER_URL);
    expect(env.get('EMPTY')).toBe('');
  });

  it('reads a real process through ps, skipping its command line', async () => {
    const processes = table({}, { [process.pid]: 'placeholder' });
    const result = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(process.pid)], {
      encoding: 'utf8',
    });
    processes.args.set(process.pid, result.stdout.trim());
    const envs = await readProcessEnvs([process.pid], processes);
    expect(envs.get(process.pid)?.has('PATH')).toBe(true);
  });
});

describe('what a resume may carry', () => {
  it('keeps the leading known flags and stops at anything else', () => {
    expect(
      safeClaudeFlags(
        `claude --dangerously-skip-permissions --model=opus --mcp-config {"t":"${PRIVATE_VALUE}"} --effort high`
      )
    ).toEqual(['--dangerously-skip-permissions', '--model=opus']);
    expect(safeClaudeFlags('claude --model $(x)')).toEqual([]);
  });

  it('never takes words of a prompt for flags', () => {
    expect(safeClaudeFlags('claude explain --dangerously-skip-permissions')).toEqual([]);
    expect(safeClaudeFlags('claude -- --dangerously-skip-permissions')).toEqual([]);
    expect(
      safeClaudeFlags('claude --append-system-prompt be careful --dangerously-skip-permissions')
    ).toEqual([]);
  });

  it('after a free-form value a restore can only ask for more permissions', () => {
    expect(
      safeClaudeFlags(
        'claude --model x --dangerously-skip-permissions --permission-mode bypassPermissions'
      )
    ).toEqual(['--model', 'x']);
    expect(
      safeClaudeFlags('claude --permission-mode plan --dangerously-skip-permissions --model x')
    ).toEqual(['--permission-mode', 'plan', '--dangerously-skip-permissions', '--model', 'x']);
  });

  it('compares the variables that choose the backend, and only those', () => {
    expect(
      differingBackendVars(
        new Map([
          ['ANTHROPIC_BASE_URL', PROVIDER_URL],
          ['PATH', '/a'],
        ]),
        {
          PATH: '/b',
        }
      )
    ).toEqual(['ANTHROPIC_BASE_URL']);
    expect(differingBackendVars(new Map(), { ANTHROPIC_API_KEY: PRIVATE_VALUE })).toEqual([
      'ANTHROPIC_API_KEY',
    ]);
    expect(differingBackendVars(new Map([['HOME', '/h']]), { HOME: '/x' })).toEqual([]);
  });

  describe('a configured provider', () => {
    const providers = [
      { id: 'p1', label: 'P', baseUrl: `${PROVIDER_URL}/`, models: ['m1'] },
    ] as ModelProvider[];
    const env = (model: string) =>
      new Map([
        ['ANTHROPIC_BASE_URL', PROVIDER_URL],
        ['ANTHROPIC_MODEL', model],
      ]);

    it('is a candidate by endpoint, keeping only a model its config lists', () => {
      expect(configuredProviderFor(env('m1'), providers)).toEqual({ id: 'p1', model: 'm1' });
      expect(configuredProviderFor(env('unlisted'), providers)).toEqual({ id: 'p1', model: '' });
      expect(configuredProviderFor(new Map(), providers)).toBeUndefined();
      expect(
        configuredProviderFor(new Map([['ANTHROPIC_BASE_URL', 'https://other.test']]), providers)
      ).toBeUndefined();
    });

    it('is detected for the row by host alone, keeping only a model its config lists', () => {
      const at = (url: string) => new Map([['ANTHROPIC_BASE_URL', url]]);
      expect(detectedProviderFor(at(`${PROVIDER_URL}/v1/deep`), providers)).toEqual({
        id: 'p1',
        model: '',
      });
      expect(detectedProviderFor(env('m1'), providers)).toEqual({ id: 'p1', model: 'm1' });
      expect(detectedProviderFor(env('unlisted'), providers)?.model).toBe('');
      expect(detectedProviderFor(at('https://other.test'), providers)).toBeUndefined();
      expect(detectedProviderFor(at('not a url'), providers)).toBeUndefined();
      expect(detectedProviderFor(new Map(), providers)).toBeUndefined();
      expect(detectedProviderFor(env('m1'), undefined)).toBeUndefined();
    });

    it('refuses to replace or remove what Claude inherited, though it is no difference', () => {
      const live = new Map([
        ['A_URL', 'u'],
        ['A_KEY', 'inherited'],
      ]);
      expect(
        providerReproduces(live, ['A_URL'], { env: { A_URL: 'u', A_KEY: 'configured' }, unset: [] })
      ).toBe(false);
      expect(providerReproduces(live, ['A_URL'], { env: { A_URL: 'u' }, unset: ['A_KEY'] })).toBe(
        false
      );
    });

    it('accepts removing a variable the original did not have', () => {
      expect(
        providerReproduces(new Map([['A_URL', 'u']]), ['A_URL'], {
          env: { A_URL: 'u' },
          unset: ['A_KEY'],
        })
      ).toBe(true);
    });

    it('refuses a variable the launch would add', () => {
      expect(
        providerReproduces(new Map([['A_URL', 'u']]), ['A_URL'], {
          env: { A_URL: 'u', A_EXTRA: 'x' },
          unset: [],
        })
      ).toBe(false);
    });

    it('a variable removed and then set counts as set', () => {
      const rebuilt = { env: { A_TOKEN: 't' }, unset: ['A_TOKEN'] };
      expect(providerReproduces(new Map([['A_TOKEN', 't']]), ['A_TOKEN'], rebuilt)).toBe(true);
      expect(providerReproduces(new Map([['A_TOKEN', 'x']]), ['A_TOKEN'], rebuilt)).toBe(false);
    });

    it('reproduces an environment only value by value', () => {
      const rebuilt = { env: { A_TOKEN: 'same', A_URL: 'u' }, unset: ['A_KEY'] };
      const live = (token: string, more: Array<[string, string]> = []) =>
        new Map([['A_TOKEN', token], ['A_URL', 'u'], ...more]);
      expect(providerReproduces(live('same'), ['A_TOKEN', 'A_URL'], rebuilt)).toBe(true);
      expect(providerReproduces(live('another'), ['A_TOKEN', 'A_URL'], rebuilt)).toBe(false);
      expect(providerReproduces(new Map(), ['A_TOKEN'], rebuilt)).toBe(false);
      expect(providerReproduces(live('same'), ['CLAUDE_CONFIG_DIR'], rebuilt)).toBe(false);
      expect(providerReproduces(live('same'), ['A_KEY'], rebuilt)).toBe(true);
      expect(providerReproduces(live('same', [['A_KEY', 'x']]), ['A_KEY'], rebuilt)).toBe(false);
    });
  });
});

describe('recording', () => {
  const liveTable = table({ 10: [30] }, { 30: 'claude --model opus' });
  let claudeDir: string;
  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-claude-rec-'));
    fs.mkdirSync(path.join(claudeDir, 'sessions'));
    fs.writeFileSync(
      path.join(claudeDir, 'sessions', '30.json'),
      JSON.stringify({
        pid: 30,
        sessionId: 'conv-30',
        cwd: '/work',
        procStart: START,
        kind: 'interactive',
      })
    );
  });
  afterEach(() => fs.rmSync(claudeDir, RM_TEST_DIR));

  const run = async (
    sessions: Session[],
    env: Array<[string, string]> = [],
    extra: {
      alive?: boolean;
      processes?: ProcessTable;
      providers?: ModelProvider[];
      rebuilt?: { env: Record<string, string>; unset: string[] } | null;
      baseline?: Record<string, string>;
    } = {}
  ) => {
    const save = vi.fn();
    const readEnvs = vi.fn(async () => new Map([[30, new Map(env) as ProcessEnv]]));
    const rebuildProviderEnv = vi.fn(async () => extra.rebuilt ?? null);
    await recordTerminalClaudes({
      claudeDir,
      listSessions: () => sessions,
      rootPid: () => 10,
      save,
      isAlive: () => extra.alive ?? true,
      providers: () => extra.providers,
      rebuildProviderEnv,
      baselineEnv: () => extra.baseline ?? { PATH: '/usr/bin' },
      table: async () => extra.processes ?? liveTable,
      readEnvs,
    });
    return { save, readEnvs, rebuildProviderEnv };
  };

  it('records the conversation, folder and flags of a Claude under a shell', async () => {
    const { save } = await run([session({})]);
    expect(save).toHaveBeenCalledWith('s1', {
      conversationId: 'conv-30',
      pid: 30,
      cwd: '/work',
      flags: ['--model', 'opus'],
      customEnv: [],
    });
  });

  it('never saves an environment value or a secret flag', async () => {
    const providers = [
      { id: 'p1', label: 'P', baseUrl: PROVIDER_URL, models: ['m1'] },
    ] as ModelProvider[];
    const processes = table({ 10: [30] }, { 30: `claude --mcp-config ${PRIVATE_VALUE}` });
    for (const list of [undefined, providers]) {
      const { save } = await run(
        [session({})],
        [
          ['ANTHROPIC_BASE_URL', PROVIDER_URL],
          ['ANTHROPIC_AUTH_TOKEN', PRIVATE_VALUE],
          ['ANTHROPIC_MODEL', PRIVATE_VALUE],
        ],
        { processes, providers: list, rebuilt: null }
      );
      const saved = JSON.stringify(save.mock.calls);
      expect(saved).toContain('ANTHROPIC_AUTH_TOKEN');
      expect(saved).not.toContain(PRIVATE_VALUE);
      expect(saved).not.toContain(PROVIDER_URL);
    }
  });

  describe('against a configured provider', () => {
    const providers = [
      { id: 'p1', label: 'P', baseUrl: PROVIDER_URL, models: ['m1'] },
    ] as ModelProvider[];
    const live: Array<[string, string]> = [
      ['ANTHROPIC_BASE_URL', PROVIDER_URL],
      ['ANTHROPIC_AUTH_TOKEN', PRIVATE_VALUE],
      ['ANTHROPIC_MODEL', 'm1'],
    ];
    const rebuilt = (token: string) => ({
      env: {
        ANTHROPIC_BASE_URL: PROVIDER_URL,
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_MODEL: 'm1',
      },
      unset: [],
    });

    it('keeps the provider when its launch gives the same environment', async () => {
      const { save } = await run([session({})], live, {
        providers,
        rebuilt: rebuilt(PRIVATE_VALUE),
      });
      expect(save.mock.calls[0][1].modelProvider).toEqual({ id: 'p1', model: 'm1' });
      expect(JSON.stringify(save.mock.calls)).not.toContain(PRIVATE_VALUE);
    });

    it('same endpoint with another credential is another account: no provider', async () => {
      const { save } = await run([session({})], live, {
        providers,
        rebuilt: rebuilt('the-configured-one'),
      });
      expect(save.mock.calls[0][1].modelProvider).toBeUndefined();
      expect(save.mock.calls[0][1].customEnv).toContain('ANTHROPIC_AUTH_TOKEN');
    });

    it('an inherited base credential with another URL is not resumed on the provider', async () => {
      // The credential equals the baseline: it is not in customEnv, only the URL is.
      const inherited: Array<[string, string]> = [
        ['ANTHROPIC_BASE_URL', PROVIDER_URL],
        ['ANTHROPIC_AUTH_TOKEN', PRIVATE_VALUE],
        ['ANTHROPIC_MODEL', 'm1'],
      ];
      const baseline = {
        ANTHROPIC_AUTH_TOKEN: PRIVATE_VALUE,
        ANTHROPIC_MODEL: 'm1',
      };
      const { save } = await run([session({})], inherited, {
        providers,
        baseline,
        rebuilt: rebuilt('the-configured-one'),
      });
      expect(save.mock.calls[0][1].customEnv).toEqual(['ANTHROPIC_BASE_URL']);
      expect(save.mock.calls[0][1].modelProvider).toBeUndefined();
    });

    it('an inherited credential the provider would remove is not resumed either', async () => {
      const { save } = await run([session({})], [...live, ['ANTHROPIC_API_KEY', PRIVATE_VALUE]], {
        providers,
        baseline: { ANTHROPIC_API_KEY: PRIVATE_VALUE },
        rebuilt: { ...rebuilt(PRIVATE_VALUE), unset: ['ANTHROPIC_API_KEY'] },
      });
      expect(save.mock.calls[0][1].customEnv).not.toContain('ANTHROPIC_API_KEY');
      expect(save.mock.calls[0][1].modelProvider).toBeUndefined();
    });

    it('a removal the original did not need still resumes on the provider', async () => {
      const { save } = await run([session({})], live, {
        providers,
        rebuilt: { ...rebuilt(PRIVATE_VALUE), unset: ['ANTHROPIC_API_KEY'] },
      });
      expect(save.mock.calls[0][1].modelProvider).toEqual({ id: 'p1', model: 'm1' });
    });

    it('no provider when it cannot be rebuilt', async () => {
      const { save } = await run([session({})], live, { providers, rebuilt: null });
      expect(save.mock.calls[0][1].modelProvider).toBeUndefined();
    });

    it('marks the provider even when a restore could not reproduce it', async () => {
      const { save } = await run([session({})], live, { providers, rebuilt: null });
      expect(save.mock.calls[0][1].modelProvider).toBeUndefined();
      expect(save.mock.calls[0][1].detectedProvider).toEqual({ id: 'p1', model: 'm1' });
      expect(sessionProviderMarker({ terminalClaude: save.mock.calls[0][1] })).toEqual({
        id: 'p1',
        model: 'm1',
      });
    });

    it('no mark when the host matches no configured provider', async () => {
      const { save } = await run([session({})], [['ANTHROPIC_BASE_URL', 'https://other.test/v1']], {
        providers,
      });
      expect(save.mock.calls[0][1].detectedProvider).toBeUndefined();
      expect(sessionProviderMarker({ terminalClaude: save.mock.calls[0][1] })).toBeUndefined();
    });

    it('persists the provider id, never the URL, credential or an unlisted model', async () => {
      const { save } = await run(
        [session({})],
        [
          ['ANTHROPIC_BASE_URL', `${PROVIDER_URL}/secret-path`],
          ['ANTHROPIC_AUTH_TOKEN', PRIVATE_VALUE],
          ['ANTHROPIC_MODEL', PRIVATE_VALUE],
        ],
        { providers, rebuilt: null }
      );
      expect(save.mock.calls[0][1].detectedProvider).toEqual({ id: 'p1', model: '' });
      const saved = JSON.stringify(save.mock.calls);
      expect(saved).not.toContain(PRIVATE_VALUE);
      expect(saved).not.toContain(PROVIDER_URL);
      expect(saved).not.toContain('secret-path');
    });

    describe('a Claude recorded without a mark', () => {
      const recorded = (fields: Partial<TerminalClaude> = {}) =>
        record({
          pid: 30,
          conversationId: 'conv-30',
          cwd: '/work',
          customEnv: ['ANTHROPIC_BASE_URL'],
          ...fields,
        });

      it('gets it, and nothing else of the record changes', async () => {
        const { save } = await run([session({ terminalClaude: recorded() })], live, { providers });
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith('s1', {
          ...recorded(),
          detectedProvider: { id: 'p1', model: 'm1' },
        });
      });

      it('is left alone while its host matches no provider', async () => {
        const { save } = await run(
          [session({ terminalClaude: recorded() })],
          [['ANTHROPIC_BASE_URL', 'https://other.test']],
          { providers }
        );
        expect(save).not.toHaveBeenCalled();
      });

      it('is not read again without a base URL of its own or without providers', async () => {
        const plain = await run([session({ terminalClaude: recorded({ customEnv: [] }) })], live, {
          providers,
        });
        expect(plain.readEnvs).not.toHaveBeenCalled();
        const none = await run([session({ terminalClaude: recorded() })], live, { providers: [] });
        expect(none.readEnvs).not.toHaveBeenCalled();
      });

      it('is not read again once marked', async () => {
        const { readEnvs } = await run(
          [session({ terminalClaude: recorded({ detectedProvider: { id: 'p1', model: '' } }) })],
          live,
          { providers }
        );
        expect(readEnvs).not.toHaveBeenCalled();
      });
    });

    it('a terminal without Claude gets no mark', async () => {
      const { save } = await run([session({})], live, {
        providers,
        processes: table({ 10: [20] }, { 20: 'vim' }),
      });
      expect(save).not.toHaveBeenCalled();
      expect(sessionProviderMarker(session({}))).toBeUndefined();
    });

    it('reads no key for an endpoint that is not configured', async () => {
      const { rebuildProviderEnv } = await run([session({})], live, { providers: [] });
      expect(rebuildProviderEnv).not.toHaveBeenCalled();
    });
  });

  it('does not read the environment again for the same Claude', async () => {
    const { save, readEnvs } = await run([
      session({ terminalClaude: record({ pid: 30, conversationId: 'conv-30', cwd: '/work' }) }),
    ]);
    expect(readEnvs).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('follows a /clear or /resume inside the same Claude', async () => {
    const { save, readEnvs } = await run([
      session({ terminalClaude: record({ pid: 30, conversationId: 'old', cwd: '/work' }) }),
    ]);
    expect(readEnvs).not.toHaveBeenCalled();
    expect(save.mock.calls[0][1]).toMatchObject({ conversationId: 'conv-30', pid: 30 });
  });

  it('forgets it when Claude ended and the shell lives on', async () => {
    const { save } = await run([session({ terminalClaude: record() })], [], {
      processes: table({ 10: [] }),
    });
    expect(save).toHaveBeenCalledWith('s1', undefined);
  });

  it('keeps it when the whole pane is gone: that is what a restore needs', async () => {
    const { save } = await run([session({ terminalClaude: record() })], [], {
      alive: false,
      processes: table({}),
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('leaves alone sessions whose command already says what runs', async () => {
    const { save } = await run([
      session({ command: ['claude'] }),
      session({ command: ['/opt/bin/codex'] }),
      session({ shielded: false }),
      session({ status: 'exited' }),
    ]);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('restoring a terminal', () => {
  const shell = ['zsh', '-l', '-i'];

  it('a terminal without Claude stays an empty shell, even with an old conversation', () => {
    expect(shieldRestorePlan({ command: shell, claudeSessionId: 'old' })).toEqual({
      command: shell,
      kind: 'same-command',
    });
  });

  it('resumes the conversation in its folder and keeps the shell for afterwards', () => {
    expect(
      shieldRestorePlan({ command: shell, terminalClaude: record({ flags: ['--model', 'opus'] }) })
    ).toEqual({
      command: ['claude', '--resume', 'conv-1', '--model', 'opus'],
      kind: 'terminal-claude-resume',
      cwd: '/work/repo',
      thenShell: shell,
    });
  });

  it('a session started as a script resumes without a shell to return to', () => {
    const plan = shieldRestorePlan({ command: ['./launch'], terminalClaude: record() });
    expect(plan.kind).toBe('terminal-claude-resume');
    expect(plan.thenShell).toBeUndefined();
  });

  it('resumes against the configured provider that matches', () => {
    const modelProvider = { id: 'p1', model: '' };
    expect(
      shieldRestorePlan({
        command: shell,
        terminalClaude: record({ customEnv: ['ANTHROPIC_BASE_URL'], modelProvider }),
      })
    ).toMatchObject({ kind: 'terminal-claude-resume', modelProvider });
  });

  it('with an unknown environment, brings the terminal back and says how to resume', () => {
    const plan = shieldRestorePlan({
      command: shell,
      terminalClaude: record({ customEnv: ['ANTHROPIC_BASE_URL'] }),
    });
    expect(plan.kind).toBe('terminal-claude-notice');
    expect(plan.command[0]).toBe('/bin/sh');
    expect(plan.command.slice(-3)).toEqual(shell);
    const run = spawnSync('/bin/sh', [...plan.command.slice(1, -3), '/usr/bin/true']);
    expect(run.status).toBe(0);
    expect(run.stdout.toString()).toContain('--resume conv-1');
    expect(run.stdout.toString()).toContain('ANTHROPIC_BASE_URL');
  });

  it('a script run through a shell is not a shell to come back to', () => {
    const script = ['zsh', './launch.sh'];
    const resumed = shieldRestorePlan({ command: script, terminalClaude: record() });
    expect(resumed.kind).toBe('terminal-claude-resume');
    expect(resumed.thenShell).toBeUndefined();
    const notice = terminalClaudeNoticePlan(script, record({ customEnv: ['ANTHROPIC_X'] }));
    expect(notice.command).toEqual(script);
    expect(notice.banner).toContain('--resume conv-1');
    for (const command of [
      ['fish', '--command=x'],
      ['bash', '-lc', 'x'],
    ]) {
      expect(shieldRestorePlan({ command, terminalClaude: record() }).thenShell).toBeUndefined();
    }
  });

  it('a script session with an unknown environment runs again and carries the notice', () => {
    const plan = terminalClaudeNoticePlan(['./launch'], record({ customEnv: ['ANTHROPIC_X'] }));
    expect(plan.command).toEqual(['./launch']);
    expect(plan.banner).toContain('--resume conv-1');
  });

  it('the shell comes back after a resumed Claude quits', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-claude-sh-'));
    try {
      const fake = path.join(dir, 'fake claude');
      const after = path.join(dir, 'fake-shell');
      fs.writeFileSync(fake, '#!/bin/sh\necho "claude:$*"\nexit 3\n', { mode: 0o755 });
      fs.writeFileSync(after, '#!/bin/sh\necho "shell:$*"\n', { mode: 0o755 });
      const hostile = "it's $(echo spliced) `echo spliced`";
      const command = keepShellAfterClaude([fake, '--resume', hostile], [after, '-l', '-i']);
      const run = spawnSync(command[0], command.slice(1), { encoding: 'utf8' });
      expect(run.stdout).toBe(`claude:--resume ${hostile}\nshell:-l -i\n`);
      expect(command[2]).not.toContain('--resume');
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });

  it('Blindar on a terminal keeps its command (only a restore resumes it)', () => {
    expect(shieldReopenPlan({ command: shell, claudeSessionId: 'c' }).replacesOld).toBe(false);
  });
});

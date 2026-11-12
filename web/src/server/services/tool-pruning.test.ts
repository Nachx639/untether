import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newTaskMetrics } from '../../shared/task-metrics.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { toolsLine } from '../task-cli/format-task-detail.js';
import { parseSettingValue } from '../task-cli/project-settings.js';
import { formatTools } from '../task-cli/project-tools.js';
import { runTaskCli } from '../task-cli.js';
import { ProjectSettingsPatchSchema } from './project-settings.js';
import { createTaskGuard } from './task-guard-setup.js';
import { createTaskLauncher, createTaskResumer, TASK_ALLOWED_TOOLS } from './task-launcher.js';
import {
  createToolPruner,
  mcpToolPrefix,
  planToolPruning,
  pruningNote,
  pruningSettings,
  readToolInventory,
  scanClaudeTranscript,
  type ToolInventory,
  type ToolSession,
  ToolUsageStore,
  wantedKeys,
  windowSessions,
} from './tool-pruning.js';

vi.mock('../utils/git-info.js', () => ({ detectGitInfo: vi.fn(async () => ({})) }));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-pruning-'));
});

afterEach(() => {
  fs.rmSync(dir, RM_TEST_DIR);
});

const line = (value: unknown) => JSON.stringify(value);

function assistant(tools: Array<{ id?: string; name: string; input?: object }>, usage?: object) {
  return line({
    type: 'assistant',
    message: {
      id: `m${Math.random()}`,
      ...(usage ? { usage } : {}),
      content: tools.map((tool) => ({ type: 'tool_use', id: tool.id ?? 'x', ...tool })),
    },
  });
}

function result(id: string, content: unknown) {
  return line({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
}

const inventory: ToolInventory = {
  plugins: [
    {
      id: 'vercel@official',
      name: 'vercel',
      servers: ['plugin:vercel:vercel'],
      lsp: false,
      hooks: true,
    },
    {
      id: 'claude-mem@thedotmack',
      name: 'claude-mem',
      servers: ['plugin:claude-mem:mcp-search'],
      lsp: false,
      hooks: true,
    },
    { id: 'typescript-lsp@official', name: 'typescript-lsp', servers: [], lsp: true, hooks: false },
    { id: 'cctop@cctop', name: 'cctop', servers: [], lsp: false, hooks: true },
    { id: 'docs@skills', name: 'docs', servers: [], lsp: false, hooks: false },
  ],
  mcpServers: ['github', 'inkwell'],
  skills: ['gmail', 'browser-tools', 'macos'],
};

function sessions(count: number, used: string[][] = []): ToolSession[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
    used: used[i] ?? [],
  }));
}

describe('names', () => {
  it("follows Claude Code's normalization of MCP tool names", () => {
    expect(mcpToolPrefix('plugin:claude-mem:mcp-search')).toBe('plugin_claude-mem_mcp-search');
    expect(mcpToolPrefix('github')).toBe('github');
    expect(mcpToolPrefix('claude.ai Google Calendar')).toBe('claude_ai_Google_Calendar');
  });
});

describe('scanClaudeTranscript', () => {
  it('records skills, MCP servers, plugin agents, the misses and the first turn', () => {
    const found = scanClaudeTranscript([
      line({ type: 'attachment', attachment: { type: 'skill_listing' } }),
      assistant([{ name: 'Bash' }], {
        input_tokens: 2,
        cache_creation_input_tokens: 32_414,
        cache_read_input_tokens: 29_208,
        output_tokens: 50,
      }),
      assistant(
        [
          { name: 'mcp__plugin_claude-mem_mcp-search__work_state_write' },
          { name: 'Skill', input: { skill: 'vercel:deploy' } },
          { name: 'Agent', input: { subagent_type: 'cctop:watch' } },
          { name: 'Agent', input: { subagent_type: 'Explore' } },
          { id: 's1', name: 'ToolSearch', input: { query: 'github create issue' } },
          { id: 's2', name: 'ToolSearch', input: { query: 'select:mcp__inkwell__list_ideas' } },
          { id: 's3', name: 'ToolSearch', input: { query: 'select:Monitor' } },
          { id: 'k1', name: 'Skill', input: { skill: 'docs:pdf' } },
        ],
        { input_tokens: 9 }
      ),
      result('s1', 'No matching deferred tools found'),
      result('s2', [{ type: 'text', text: 'No matching deferred tools found' }]),
      result('s3', '<functions>…</functions>'),
      result('k1', 'Unknown skill: docs:pdf'),
      'not json',
    ]);
    expect(found.startTokens).toBe(61_624);
    expect(found.used).toEqual([
      'mcp:inkwell',
      'mcp:plugin_claude-mem_mcp-search',
      'plugin:cctop',
      'plugin:docs',
      'plugin:vercel',
      'skill:docs:pdf',
      'skill:vercel:deploy',
    ]);
    expect(found.misses).toEqual(['github create issue']);
  });
});

describe('planToolPruning', () => {
  it('prunes nothing until enough task sessions are recorded', () => {
    expect(planToolPruning({ inventory, sessions: sessions(4) })).toBeNull();
    expect(planToolPruning({ inventory, sessions: sessions(3), window: 3 })).not.toBeNull();
  });

  it('drops what nobody used; never LSP plugins, the keep list or what was used', () => {
    const plan = planToolPruning({
      inventory,
      sessions: sessions(6, [['mcp:plugin_claude-mem_mcp-search'], ['skill:macos']]),
      keep: ['CCTOP', 'inkwell'],
    });
    expect(plan).toMatchObject({
      plugins: ['vercel@official', 'docs@skills'],
      mcpServers: ['github'],
      skills: ['gmail', 'browser-tools'],
      claudeAi: true,
      sessions: 6,
      window: 20,
    });
    // A plugin kept (here: cctop for the keep list) loses no server it has none of; claude-mem
    // stays whole because its server was used.
    expect(plan?.mcpServers).not.toContain('plugin:claude-mem:mcp-search');
  });

  it('keeps a plugin used through a skill but denies its unused MCP server', () => {
    const plan = planToolPruning({
      inventory,
      sessions: sessions(5, [['plugin:vercel', 'skill:vercel:deploy']]),
    });
    expect(plan?.plugins).not.toContain('vercel@official');
    expect(plan?.mcpServers).toContain('plugin:vercel:vercel');
  });

  it('brings back what a search missed by name, and claude.ai when one connector was used', () => {
    const recent = sessions(5);
    recent[0].misses = ['github create issue', 'gmail inbox'];
    recent[1].used = ['mcp:claude_ai_Gmail'];
    const plan = planToolPruning({ inventory, sessions: recent });
    expect(plan?.mcpServers).not.toContain('github');
    expect(plan?.skills).not.toContain('gmail');
    expect(plan?.claudeAi).toBe(false);
  });

  it('brings back the claude.ai connectors a failed search named (2026-11-10)', () => {
    const recent = sessions(5);
    expect(planToolPruning({ inventory, sessions: recent })?.claudeAi).toBe(true);
    recent[0].misses = ['claude.ai gmail send'];
    expect(planToolPruning({ inventory, sessions: recent })?.claudeAi).toBe(false);
  });

  it('looks only at the last `window` task sessions, and the asks made meanwhile', () => {
    const all = sessions(8, [['mcp:github']]);
    all.push({
      id: 'want:x',
      at: new Date(Date.UTC(2026, 10, 1, 0, 6, 30)).toISOString(),
      used: ['skill:macos'],
    });
    const recent = windowSessions(all, 3);
    expect(recent.map((s) => s.id)).toEqual(['t7', 'want:x', 't6', 't5']);
    const plan = planToolPruning({ inventory, sessions: all, window: 3 });
    expect(plan?.mcpServers).toContain('github');
    expect(plan?.skills).not.toContain('macos');
  });
});

describe('pruningSettings and the note', () => {
  it("are Claude Code's own settings keys", () => {
    const plan = planToolPruning({ inventory, sessions: sessions(5) });
    if (!plan) throw new Error('no plan');
    const settings = pruningSettings(plan);
    expect(settings).toEqual({
      enabledPlugins: {
        'vercel@official': false,
        'claude-mem@thedotmack': false,
        'cctop@cctop': false,
        'docs@skills': false,
      },
      deniedMcpServers: [{ serverName: 'github' }, { serverName: 'inkwell' }],
      skillOverrides: { gmail: 'name-only', 'browser-tools': 'name-only', macos: 'name-only' },
      disableClaudeAiConnectors: true,
    });
    expect(settings).not.toHaveProperty('hooks');
    expect(pruningNote(plan)).toContain('ut project tools want <name>');
    expect(pruningNote(plan)).toContain('plugins vercel, claude-mem, cctop, docs');
  });

  it('turns names into usage keys', () => {
    expect(wantedKeys(inventory, 'Vercel')).toEqual(['plugin:vercel', 'mcp:plugin_vercel_vercel']);
    expect(wantedKeys(inventory, 'vercel@official')).toEqual([
      'plugin:vercel',
      'mcp:plugin_vercel_vercel',
    ]);
    expect(wantedKeys(inventory, 'mcp-search')).toEqual(['mcp:plugin_claude-mem_mcp-search']);
    expect(wantedKeys(inventory, 'github')).toEqual(['mcp:github']);
    expect(wantedKeys(inventory, 'gmail')).toEqual(['skill:gmail']);
    expect(wantedKeys(inventory, 'claude.ai')).toEqual(['mcp:claude_ai_']);
    expect(wantedKeys(inventory, 'nope')).toBeNull();
  });
});

describe('readToolInventory', () => {
  it('reads the enabled plugins, their servers, LSP, hooks, MCP servers and skills', () => {
    const claudeDir = path.join(dir, 'claude');
    const repo = path.join(dir, 'repo');
    const vercel = path.join(claudeDir, 'plugins', 'cache', 'vercel');
    const swift = path.join(claudeDir, 'plugins', 'cache', 'swift');
    const write = (file: string, value: unknown) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write(path.join(claudeDir, 'settings.json'), {
      enabledPlugins: {
        'vercel@official': true,
        'swift@official': true,
        'off@x': false,
        'over@x': true,
      },
    });
    write(path.join(repo, '.claude', 'settings.local.json'), {
      enabledPlugins: { 'over@x': false },
    });
    write(path.join(claudeDir, 'plugins', 'installed_plugins.json'), {
      plugins: {
        'vercel@official': [{ scope: 'user', installPath: vercel }],
        'swift@official': [{ scope: 'user', installPath: swift }],
      },
    });
    write(path.join(vercel, '.mcp.json'), { vercel: { url: 'https://example.invalid' } });
    write(path.join(vercel, 'hooks', 'hooks.json'), {});
    write(path.join(vercel, '.claude-plugin', 'plugin.json'), { name: 'vercel' });
    write(path.join(swift, '.claude-plugin', 'plugin.json'), { name: 'swift' });
    write(
      path.join(
        claudeDir,
        'plugins',
        'marketplaces',
        'official',
        '.claude-plugin',
        'marketplace.json'
      ),
      {
        plugins: [{ name: 'swift', lspServers: {} }],
      }
    );
    const claudeJson = path.join(dir, 'claude.json');
    write(claudeJson, {
      mcpServers: { github: {} },
      projects: { [repo]: { mcpServers: { local: {} } } },
    });
    write(path.join(repo, '.mcp.json'), { mcpServers: { shared: {} } });
    write(path.join(claudeDir, 'skills', 'gmail', 'SKILL.md'), '---\nname: gmail-pro\n---\nx');
    write(path.join(repo, '.claude', 'skills', 'deploy', 'SKILL.md'), 'no front matter');
    fs.mkdirSync(path.join(claudeDir, 'skills', 'empty'), { recursive: true });

    const found = readToolInventory({ repo, claudeDir, claudeJson });
    expect(found.plugins).toEqual([
      { id: 'swift@official', name: 'swift', servers: [], lsp: true, hooks: false },
      {
        id: 'vercel@official',
        name: 'vercel',
        servers: ['plugin:vercel:vercel'],
        lsp: false,
        hooks: true,
      },
    ]);
    expect(found.mcpServers).toEqual(['github', 'local', 'shared']);
    expect(found.skills).toEqual(['deploy', 'gmail-pro']);
  });
});

describe('ToolUsageStore', () => {
  it('keeps sessions per project across a reload and follows moved folders', () => {
    const file = path.join(dir, 'tool-usage.json');
    const store = new ToolUsageStore(file);
    store.put('/a', { id: 't1', at: '2026-11-01T00:00:00Z', used: ['mcp:github'] });
    store.put('/a', { id: 't1', at: '2026-11-01T00:00:00Z', used: ['skill:x'] });
    expect(new ToolUsageStore(file).sessions('/a')).toEqual([
      { id: 't1', at: '2026-11-01T00:00:00Z', used: ['skill:x'] },
    ]);
    expect(store.projectsMoved([{ from: '/a', to: '/b' }])).toBe(1);
    expect(new ToolUsageStore(file).sessions('/b')).toHaveLength(1);
    expect(store.sessions('/a')).toEqual([]);
  });
});

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'abc123',
    name: 'x',
    prompt: 'p',
    workingDir: dir,
    command: ['claude'],
    agent: 'claude',
    shielded: true,
    notify: false,
    runAt: '2026-11-03T00:00:00Z',
    createdAt: '2026-11-03T00:00:00Z',
    startedAt: '2026-11-03T00:00:00Z',
    state: 'working',
    stateSince: '2026-11-03T00:00:00Z',
    isolation: 'worktree',
    origin: 'user',
    followUps: [],
    files: [],
    repoPath: '/repo',
    worktreePath: dir,
    baseBranch: 'main',
    branch: 'ut/x',
    ...overrides,
  } as TaskRecord;
}

function pruner(options: { on?: boolean; tasks?: TaskRecord[]; keep?: string[] } = {}) {
  const store = new ToolUsageStore(path.join(dir, 'tool-usage.json'));
  const settings = { toolPruning: options.on ?? true, toolKeep: options.keep };
  const tools = createToolPruner({
    store,
    settings: () => settings,
    tasks: () => options.tasks ?? [],
    profileFile: (taskId) => path.join(dir, 'tasks', taskId, 'tool-profile.json'),
    inventory: () => inventory,
  });
  return { store, settings, tools };
}

describe('createToolPruner', () => {
  it("fixes a task's list at its first start: a later change does not touch it", () => {
    const { store, settings, tools } = pruner();
    for (const s of sessions(5)) store.put('/repo', s);
    const first = tools.profileFor(task());
    expect(first?.plugins).toContain('vercel@official');
    // github wanted now, pruning turned off: the running task keeps its list (prompt cache).
    tools.want('/repo', ['github', 'vercel']);
    settings.toolPruning = false;
    expect(tools.profileFor(task())).toEqual(first);
    // A new task gets the new state of things.
    expect(tools.profileFor(task({ id: 'next' }))).toBeNull();
    settings.toolPruning = true;
    const third = tools.profileFor(task({ id: 'third' }));
    expect(third?.mcpServers).not.toContain('github');
    expect(third?.plugins).not.toContain('vercel@official');
  });

  it('a holdout task, or one made after the quality guard turned it off, gets every tool (2026-11-03)', () => {
    const { store, tools } = pruner();
    for (const s of sessions(5)) store.put('/repo', s);
    const holdout = task({ id: 'h', metrics: newTaskMetrics({ on: {}, holdout: true }) });
    expect(tools.profileFor(holdout)).toBeNull();
    const withIt = task({ id: 'w', metrics: newTaskMetrics({ on: { 'tool-pruning': 1 } }) });
    expect(tools.profileFor(withIt)?.plugins).toContain('vercel@official');
  });

  it('a task that started with everything keeps everything; Codex tasks are never pruned', () => {
    const { store, tools } = pruner();
    expect(tools.profileFor(task())).toBeNull();
    for (const s of sessions(5)) store.put('/repo', s);
    expect(tools.profileFor(task())).toBeNull();
    expect(tools.profileFor(task({ id: 'cx', agent: 'codex', command: ['codex'] }))).toBeNull();
    expect(tools.taskTools(task())).toEqual({ pruned: null });
  });

  it('records what its tasks used from their transcripts, read again only when they grew', async () => {
    const transcript = path.join(dir, 'conv.jsonl');
    fs.writeFileSync(
      transcript,
      `${[
        assistant([{ name: 'mcp__github__get_issue' }], {
          input_tokens: 1000,
          cache_read_input_tokens: 20_000,
        }),
      ].join('\n')}\n`
    );
    const first = task({ budget: { tokensBy: { [transcript]: 1 } } as TaskRecord['budget'] });
    const { store, tools } = pruner({ tasks: [first] });
    await tools.scan();
    expect(store.get('/repo', 'abc123')).toMatchObject({
      used: ['mcp:github'],
      startTokens: 21_000,
      at: '2026-11-03T00:00:00Z',
    });
    fs.appendFileSync(transcript, `${assistant([{ name: 'Skill', input: { skill: 'gmail' } }])}\n`);
    await tools.scan();
    expect(store.get('/repo', 'abc123')?.used).toEqual(['mcp:github', 'skill:gmail']);
    expect(tools.taskTools(first)).toEqual({ startTokens: 21_000 });

    const show = await tools.show('/repo');
    expect(show).toMatchObject({ enabled: true, sessions: 1, minSessions: 5, plan: null });
    expect(show.startTokens).toEqual({ full: 21_000, fullCount: 1, prunedCount: 0 });
    expect(formatTools({ ...show, action: 'show' })).toContain(
      '1 of the 5 task sessions needed first'
    );
  });

  it('restore asks for everything the plan drops; the next task gets it all', async () => {
    const { store, tools } = pruner();
    for (const s of sessions(5)) store.put('/repo', s);
    const restored = await tools.restore('/repo');
    expect(restored).toContain('vercel@official');
    expect(restored).toContain('claude.ai');
    expect(tools.planFor('/repo')).toMatchObject({
      plugins: [],
      mcpServers: [],
      skills: [],
      claudeAi: false,
    });
    expect(tools.want('/repo', ['nope'])).toEqual({ keys: [], unknown: ['nope'] });
  });
});

describe("the task's session", () => {
  it('writes the pruning into its --settings next to the hooks, and tells the agent once', async () => {
    const { store, tools } = pruner();
    for (const s of sessions(5)) store.put('/repo', s);
    const guard = createTaskGuard({
      untetherDir: dir,
      home: '/Users/alex',
      hook: ['/usr/bin/node', '/x/hook.ts'],
      toolProfile: (t) => tools.profileFor(t),
    });
    const prepared = guard.prepare(task(), dir);
    const settings = JSON.parse(fs.readFileSync(prepared?.claudeSettings as string, 'utf8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('/x/hook.ts');
    expect(settings.enabledPlugins['vercel@official']).toBe(false);
    expect(settings.deniedMcpServers).toContainEqual({ serverName: 'github' });
    expect(prepared?.toolNote).toContain('ut project tools want');

    const createSession = vi.fn(async () => ({ sessionId: 'n', sessionInfo: {} }));
    const deliver = vi.fn();
    const deps = {
      ptyManager: { createSession, isShieldAvailable: () => true } as never,
      deliverInitialInput: () => deliver,
      guard,
      nodeRuntime: async () => ({ kind: 'default' }) as never,
    };
    const launched = await createTaskLauncher(deps)(task(), 'Do it', 'n');
    expect(launched.text).toMatch(/^\[untether\] To save context.*\n\nDo it$/s);
    // The resumed conversation: same settings file, same list, nothing told again.
    const resumed = await createTaskResumer(deps)(task(), 'conv', 'r');
    expect(resumed.text).not.toContain('To save context');
    const again = JSON.parse(fs.readFileSync(prepared?.claudeSettings as string, 'utf8'));
    expect(again.enabledPlugins).toEqual(settings.enabledPlugins);
    expect(TASK_ALLOWED_TOOLS).toContain('Bash(ut project tools want:*)');
  });

  it('a Codex task gets no pruning keys', () => {
    const toolProfile = vi.fn(() => null);
    const guard = createTaskGuard({
      untetherDir: dir,
      hook: ['/n', '/h'],
      toolProfile,
      codexTakesHookTrust: () => true,
    });
    guard.prepare(task({ agent: 'codex', command: ['codex'] }), dir);
    expect(toolProfile).not.toHaveBeenCalled();
  });
});

describe('settings and the CLI', () => {
  it('takes the project settings and shows a task line', () => {
    expect(
      ProjectSettingsPatchSchema.safeParse({
        toolPruning: true,
        toolPruningWindow: 20,
        toolKeep: ['cctop'],
      }).success
    ).toBe(true);
    expect(ProjectSettingsPatchSchema.safeParse({ toolPruningWindow: 0 }).success).toBe(false);
    expect(parseSettingValue('toolKeep', 'cctop, claude.ai')).toEqual(['cctop', 'claude.ai']);
    expect(
      toolsLine({
        startTokens: 39_829,
        pruned: { plugins: 6, mcpServers: 3, skills: 13, claudeAi: true },
      })
    ).toBe(
      'start context 39.8k tokens; pruned: 6 plugin(s), 3 MCP server(s), claude.ai connectors, 13 skill(s) by name only (ut project tools)'
    );
    expect(toolsLine({ pruned: null })).toBe('every tool loaded');
  });

  it('`ut project tools want` sends the names', async () => {
    const send = vi.fn(async () => ({
      ok: true,
      status: 'done',
      data: { action: 'want', repoPath: '/r', wanted: ['mcp:github'], unknown: [] },
    }));
    const out: string[] = [];
    const code = await runTaskCli('project', ['tools', 'want', 'github'], {
      cwd: '/r',
      env: {},
      task: send as never,
      out: (text: string) => out.push(text),
      err: () => {},
      readStdin: async () => '',
    } as never);
    expect(code).toBe(0);
    expect(send).toHaveBeenCalledWith(
      'project-tools',
      expect.objectContaining({ action: 'want', names: ['github'] }),
      {}
    );
    expect(out.join('\n')).toContain('get it back: mcp:github');
  });
});

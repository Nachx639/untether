import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import { type ClaudeStatus, parseProcessTable } from '../claude-chat.js';
import type { CodexChat, CodexSessionRef } from '../codex-chat.js';
import { forgetGeminiSession, type GeminiChat, readGeminiChat } from '../gemini-chat.js';
import {
  type AgentFinderDeps,
  liveClaudeConversations,
  MacAgentFinder,
  type MacAgentProcess,
  parsePsEnvironment,
  realAgentFinderDeps,
} from './agents.js';
import type { OwnershipContext } from './process-tree.js';

const LSTART = 'Fri Oct  2 09:00:00 2026';
const START_MS = Date.UTC(2026, 9, 2, 9, 0, 0);
const TERMINAL = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
const NVM = '/Users/me/.nvm/versions/node/v24.21.0';

/** A ps line with the extended columns; '??' is no terminal. */
const ps = (pid: number, ppid: number, tty: string, args: string, uid = 501) =>
  `${pid} ${ppid} ${pid} 0 ${tty} S ${uid} ${LSTART} ${args}`;

const TABLE = parseProcessTable(
  [
    ps(500, 1, '??', TERMINAL),
    ps(520, 500, '16/1', '-zsh'),
    ps(530, 520, '16/1', 'claude'),
    ps(531, 520, '16/1', 'claude --resume x'),
    // The gateway's bot: no terminal, and not started from the CLI.
    ps(540, 1, '??', 'claude -p --output-format stream-json'),
    ps(545, 520, '16/1', 'claude'),
    // Codex's npm launcher and the native binary it runs; a Codex without a TUI.
    ps(560, 520, '16/1', `node ${NVM}/bin/codex --model gpt-5`),
    ps(561, 560, '16/1', `${NVM}/lib/node_modules/@openai/codex/vendor/codex/codex --model gpt-5`),
    ps(570, 1, '??', `${NVM}/lib/node_modules/@openai/codex/vendor/codex/codex app-server`),
    // Gemini's launcher and the copy it relaunches with a bigger heap.
    ps(580, 520, '16/1', 'node /opt/homebrew/bin/gemini'),
    ps(
      581,
      580,
      '16/1',
      '/opt/homebrew/bin/node --max-old-space-size=8192 /opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js'
    ),
    ps(590, 1, '??', `node ${NVM}/bin/codex`),
    ps(600, 1, '16/2', 'claude', 502),
    // A user tmux pane running Claude.
    ps(700, 1, '??', 'tmux new -s 0'),
    ps(710, 700, '16/12', '-zsh'),
    ps(720, 710, '16/12', 'claude'),
    // An Untether session (pid 810) of this server (4000) running Claude.
    ps(4000, 1, '??', 'node untether --port 4020'),
    ps(810, 4000, '16/20', '-zsh'),
    ps(820, 810, '16/20', 'claude'),
  ].join('\n')
);

const CONTEXT: OwnershipContext = {
  serverPid: 4000,
  sessionPids: new Map([[810, 'web-1']]),
  uid: 501,
  socketDir: '/private/tmp/tmux-501',
  platform: 'darwin',
};

const claudeFiles: Record<number, { sessionId: string; entrypoint?: string; procStart?: string }> =
  {
    530: { sessionId: 'conv-a', entrypoint: 'cli' },
    // A file left by a crashed claude whose pid 531 now belongs to another process.
    531: { sessionId: 'conv-old', entrypoint: 'cli', procStart: 'Thu Oct  1 08:00:00 2026' },
    540: { sessionId: 'conv-bot', entrypoint: 'sdk-cli' },
    545: { sessionId: 'conv-sdk', entrypoint: 'sdk-cli' },
    600: { sessionId: 'conv-other-user', entrypoint: 'cli' },
    720: { sessionId: 'conv-tmux', entrypoint: 'cli' },
    820: { sessionId: 'conv-ut', entrypoint: 'cli' },
    999: { sessionId: 'conv-gone', entrypoint: 'cli' },
  };

const chat = (agent: 'codex' | 'gemini', title: string) => ({
  available: true,
  agent,
  status: 'busy',
  title,
  activity: { kind: 'tool' as const, tool: 'shell', target: 'pnpm test', since: START_MS + 5000 },
  messages: [
    { id: '1', role: 'user' as const, text: 'Fix the **tests**' },
    { id: '2', role: 'assistant' as const, text: 'On it: `pnpm test`' },
    { id: '3', role: 'tool' as const, text: 'pnpm test', tool: 'shell' },
  ],
});

describe('MacAgentFinder', () => {
  let claudeDir: string;
  let calls: {
    cwds: number[][];
    env: number[][];
    status: Array<[number, string]>;
    refs: CodexSessionRef[];
  };
  let marked: Set<number>;

  const deps = (): AgentFinderDeps => ({
    uid: 501,
    claudeDir: () => claudeDir,
    cwdsOf: async (pids) => {
      calls.cwds.push(pids);
      return new Map(pids.map((pid) => [pid, `/Users/me/p${pid}`]));
    },
    untetherEnvOf: async (pids) => {
      calls.env.push(pids);
      return new Set(pids.filter((pid) => marked.has(pid)));
    },
    claudeStatus: async (pid, dir): Promise<ClaudeStatus> => {
      calls.status.push([pid, dir]);
      return {
        status: 'waiting',
        waitingFor: 'permission',
        sessionId: 'conv-tmux',
        title: 'Refactor parser',
        since: START_MS + 1000,
      };
    },
    codexChat: (ref) => {
      calls.refs.push(ref);
      return chat('codex', 'Codex task') as CodexChat;
    },
    codexThreadId: (cwd, startedAt) =>
      cwd === '/Users/me/p560' && startedAt === START_MS ? 'thread-1' : null,
    geminiChat: (ref) => {
      calls.refs.push(ref);
      return chat('gemini', 'Gemini task') as GeminiChat;
    },
  });

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtm-agents-'));
    const sessions = path.join(claudeDir, 'sessions');
    fs.mkdirSync(sessions);
    for (const [pid, file] of Object.entries(claudeFiles)) {
      fs.writeFileSync(
        path.join(sessions, `${pid}.json`),
        JSON.stringify({
          pid: Number(pid),
          sessionId: file.sessionId,
          cwd: `/Users/me/c${pid}`,
          entrypoint: file.entrypoint,
          procStart: file.procStart ?? LSTART,
          status: 'idle',
        })
      );
    }
    fs.writeFileSync(path.join(sessions, '530.0f3a9c2b7d1e4a5b6c7d8e9f.key'), 'not for us');
    fs.writeFileSync(path.join(sessions, 'notes.txt'), 'x');
    calls = { cwds: [], env: [], status: [], refs: [] };
    marked = new Set();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(claudeDir, RM_TEST_DIR);
  });

  const pids = (agents: MacAgentProcess[]) =>
    agents.map((agent) => agent.pid).sort((a, b) => a - b);

  it('reads <pid>.json of running Claudes only, and never opens a .key file', async () => {
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const open = vi.spyOn(fs.promises, 'open');
    const agents = await new MacAgentFinder(deps()).find(TABLE, { includeHeadless: false });

    const opened = readFile.mock.calls.map(([file]) => path.basename(String(file))).sort();
    // Not 600's (another user) nor 999's (not running); never the .key file.
    expect(opened).toEqual([
      '530.json',
      '531.json',
      '540.json',
      '545.json',
      '720.json',
      '820.json',
    ]);
    expect(open).not.toHaveBeenCalled();

    const claude = agents.find((agent) => agent.pid === 530);
    expect(claude).toEqual({
      agent: 'claude',
      pid: 530,
      lstart: 'Fri Oct 2 09:00:00 2026',
      startSec: START_MS / 1000,
      startedAt: new Date(START_MS).toISOString(),
      tty: 'ttys001',
      cwd: '/Users/me/c530',
      conversationId: 'conv-a',
      claudeDir,
    });
    // 531's file names a process that started at another time: not that Claude.
    expect(agents.some((agent) => agent.pid === 531)).toBe(false);
  });

  it('hides agents without a terminal and Claudes not started from the CLI unless asked', async () => {
    const finder = new MacAgentFinder(deps());
    expect(pids(await finder.find(TABLE, { includeHeadless: false }))).toEqual([
      530, 560, 580, 720, 820,
    ]);
    expect(pids(await finder.find(TABLE, { includeHeadless: true }))).toEqual([
      530, 540, 545, 560, 580, 590, 720, 820,
    ]);
  });

  it('takes Codex’s and Gemini’s launcher, never the binary it runs or a Codex without a TUI', async () => {
    const agents = await new MacAgentFinder(deps()).find(TABLE, { includeHeadless: true });
    const cli = agents.filter((agent) => agent.agent !== 'claude');
    expect(cli.map((agent) => [agent.agent, agent.pid, agent.cwd])).toEqual([
      ['codex', 560, '/Users/me/p560'],
      ['gemini', 580, '/Users/me/p580'],
      ['codex', 590, '/Users/me/p590'],
    ]);
  });

  it('looks up a folder once per process, all new ones in one call', async () => {
    const finder = new MacAgentFinder(deps());
    await finder.find(TABLE, { includeHeadless: false });
    await finder.find(TABLE, { includeHeadless: false });
    expect(calls.cwds).toEqual([[560, 580]]);
  });

  it('finds nothing without the extended ps columns', async () => {
    const basic = parseProcessTable(`  530   520 ${LSTART} claude`);
    expect(await new MacAgentFinder(deps()).find(basic, { includeHeadless: true })).toEqual([]);
  });

  it('drops Untether’s agents and another instance’s, keeps tmux panes without asking', async () => {
    const finder = new MacAgentFinder(deps());
    const agents = await finder.find(TABLE, { includeHeadless: false });
    marked = new Set([580]);
    const placed = await finder.outsideUntether(agents, TABLE, CONTEXT);
    expect(placed.map((agent) => [agent.pid, agent.owner]).sort()).toEqual([
      [530, { owner: 'mac', app: 'Terminal' }],
      [560, { owner: 'mac', app: 'Terminal' }],
      [
        720,
        {
          owner: 'tmux',
          serverPid: 700,
          panePid: 710,
          socketPath: '/private/tmp/tmux-501/default',
        },
      ],
    ]);
    // Only the agents in a terminal had their environment checked, and only once.
    await finder.outsideUntether(agents, TABLE, CONTEXT);
    expect(calls.env).toEqual([[530, 560, 580]]);
  });

  it('reads the status from the agent’s own pid, not its pane’s', async () => {
    const finder = new MacAgentFinder(deps());
    const [inPane] = (await finder.find(TABLE, { includeHeadless: false })).filter(
      (agent) => agent.pid === 720
    );
    expect(await finder.state(inPane)).toEqual({
      status: {
        status: 'waiting',
        waitingFor: 'permission',
        title: 'Refactor parser',
        since: START_MS + 1000,
      },
      title: 'Refactor parser',
      conversationId: 'conv-tmux',
    });
    expect(calls.status).toEqual([[720, claudeDir]]);
  });

  it('reads Codex and Gemini by process, with the last message as the preview', async () => {
    const finder = new MacAgentFinder(deps());
    const agents = await finder.find(TABLE, { includeHeadless: false });
    const codex = agents.find((agent) => agent.pid === 560) as MacAgentProcess;
    const gemini = agents.find((agent) => agent.pid === 580) as MacAgentProcess;
    const activity = { kind: 'tool', tool: 'shell', target: 'pnpm test', since: START_MS + 5000 };
    expect(await finder.state(codex)).toEqual({
      status: {
        status: 'busy',
        title: 'Codex task',
        activity,
        since: START_MS + 5000,
        preview: { role: 'assistant', text: 'On it: pnpm test' },
      },
      title: 'Codex task',
      conversationId: 'thread-1',
    });
    expect((await finder.state(gemini)).conversationId).toBeUndefined();
    expect(calls.refs).toEqual([
      {
        id: `proc:560:${START_MS}`,
        workingDir: '/Users/me/p560',
        startedAt: new Date(START_MS).toISOString(),
      },
      {
        id: `proc:580:${START_MS}`,
        workingDir: '/Users/me/p580',
        startedAt: new Date(START_MS).toISOString(),
      },
    ]);
  });

  it('gives a Gemini’s chat back once it ends, for gemini --resume in the same terminal', async () => {
    const geminiDir = path.join(claudeDir, '.gemini');
    const chats = path.join(geminiDir, 'tmp', 'project', 'chats');
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(
      path.join(geminiDir, 'projects.json'),
      JSON.stringify({ projects: { '/Users/me/project': 'project' } })
    );
    const at = (sec: number) => new Date(START_MS + sec * 1000).toISOString();
    fs.writeFileSync(
      path.join(chats, 'session-2026-10-02T09-00-abcdef12.jsonl'),
      `${JSON.stringify({ sessionId: 'x', projectHash: 'h', startTime: at(0) })}\n${JSON.stringify({ id: 'u1', timestamp: at(10), type: 'user', content: [{ text: 'fix the login page' }] })}\n`
    );
    const finder = new MacAgentFinder({
      ...deps(),
      cwdsOf: async (pids) => new Map(pids.map((pid) => [pid, '/Users/me/project'])),
      geminiChat: (ref) => readGeminiChat(ref, geminiDir),
    });
    const gemini = (table: ReturnType<typeof parseProcessTable>) =>
      finder
        .find(table, { includeHeadless: false })
        .then((agents) => agents.find((agent) => agent.agent === 'gemini') as MacAgentProcess);
    const first = await gemini(TABLE);
    expect((await finder.state(first)).status?.title).toBe('fix the login page');

    // That Gemini ended; `gemini --resume latest` in the same shell writes to the same chat.
    const resumedTable = parseProcessTable(
      [
        ps(500, 1, '??', TERMINAL),
        ps(520, 500, '16/1', '-zsh'),
        `590 520 590 0 16/1 S 501 Fri Oct  2 09:05:00 2026 node /opt/homebrew/bin/gemini --resume latest`,
      ].join('\n')
    );
    const resumed = await gemini(resumedTable);
    expect(resumed.pid).toBe(590);
    try {
      expect((await finder.state(resumed)).status?.title).toBe('fix the login page');
    } finally {
      for (const agent of [first, resumed]) {
        forgetGeminiSession(`proc:${agent.pid}:${agent.startSec * 1000}`);
      }
    }
  });

  it('lists live Claude conversations outside Untether, with or without a terminal', async () => {
    const live = await liveClaudeConversations(TABLE, CONTEXT, {
      claudeDir,
      ids: (pid, lstart) => {
        expect(lstart).toBe('Fri Oct 2 09:00:00 2026');
        if (pid === 530) return { chatId: `a-530-${START_MS / 1000}` };
        if (pid === 720) {
          return { chatId: 'p-700-1-0', tmuxId: 't-700-1-0', tmuxName: 'work', windowIndex: 2 };
        }
        return undefined;
      },
    });
    expect(Object.fromEntries(live)).toEqual({
      'conv-a': { where: 'terminal', app: 'Terminal', chatId: `a-530-${START_MS / 1000}` },
      'conv-bot': { where: 'terminal' },
      'conv-sdk': { where: 'terminal', app: 'Terminal' },
      'conv-tmux': {
        where: 'tmux',
        chatId: 'p-700-1-0',
        tmuxId: 't-700-1-0',
        tmuxName: 'work',
        windowIndex: 2,
      },
    });
  });

  it("counts a Claude in another Untether's session as live, never one of this server's", async () => {
    const OWN_SHIELD = '/Users/me/.untether/control/.shield-tmux';
    const table = parseProcessTable(
      [
        ps(500, 1, '??', TERMINAL),
        ps(520, 500, '16/1', '-zsh'),
        // This server (4000): a session (810) running Claude, and its own shield running another.
        ps(4000, 1, '??', 'node untether --port 4020'),
        ps(810, 4000, '16/20', '-zsh'),
        ps(820, 810, '16/20', 'claude'),
        ps(850, 1, '??', `tmux -S ${OWN_SHIELD} new-session -d -s ut-1`),
        ps(851, 850, '16/21', '-zsh'),
        ps(852, 851, '16/21', 'claude'),
        // Another instance's shield (its own control dir), and a ut claude of another instance
        // in a Terminal tab: neither is one of this server's sessions.
        ps(900, 1, '??', 'tmux -S /Users/me/.untether-qa/control/.shield-tmux new-session -d'),
        ps(910, 900, '16/30', '-zsh'),
        ps(920, 910, '16/30', 'claude'),
        ps(930, 520, '16/1', '/Applications/Untether.app/Contents/Resources/untether-fwd'),
        ps(940, 930, '16/31', 'claude'),
      ].join('\n')
    );
    const sessions = path.join(claudeDir, 'sessions');
    for (const [pid, sessionId] of [
      [852, 'conv-own-shield'],
      [920, 'conv-other-shield'],
      [940, 'conv-other-ut'],
    ] as const) {
      fs.writeFileSync(
        path.join(sessions, `${pid}.json`),
        JSON.stringify({ pid, sessionId, entrypoint: 'cli', procStart: LSTART })
      );
    }
    const live = await liveClaudeConversations(
      table,
      { ...CONTEXT, ownShieldSocket: OWN_SHIELD },
      { claudeDir }
    );
    expect(Object.fromEntries(live)).toEqual({
      'conv-other-shield': { where: 'terminal', app: 'Untether' },
      'conv-other-ut': { where: 'terminal', app: 'Terminal' },
    });
  });
});

describe('parsePsEnvironment', () => {
  it('marks the processes whose environment has UNTETHER_SESSION_ID', () => {
    const output = [
      '  530 claude PATH=/usr/bin UNTETHER_SESSION_ID=web-9 TERM=xterm-256color',
      '  560 node /x/bin/codex --model gpt-5 PATH=/usr/bin TERM=xterm',
      // Named only in the arguments, not in the environment.
      '  580 node /opt/homebrew/bin/gemini UNTETHER_SESSION_ID=x HOME=/Users/me',
      // The pid runs something else now.
      '  720 vim notes.md UNTETHER_SESSION_ID=web-2',
    ].join('\n');
    const table = parseProcessTable(
      [
        ps(530, 1, '16/1', 'claude'),
        ps(560, 1, '16/1', 'node /x/bin/codex --model gpt-5'),
        ps(580, 1, '16/1', 'node /opt/homebrew/bin/gemini UNTETHER_SESSION_ID=x'),
        ps(720, 1, '16/1', 'claude'),
      ].join('\n')
    );
    expect([...parsePsEnvironment(output, table)]).toEqual([530]);
  });

  it('never runs the real scan under vitest', () => {
    expect(() => realAgentFinderDeps()).toThrow(/vitest/);
  });
});

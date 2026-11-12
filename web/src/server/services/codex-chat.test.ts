import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  codexRolloutFirstPrompt,
  execScriptPatches,
  findCodexRollout,
  findCodexRolloutAmong,
  findCodexRolloutById,
  forgetCodexSession,
  isCodexCommand,
  parseCodexLine,
  readCodexChat,
  rolloutKind,
} from './codex-chat.js';

const at = (offsetSec: number) => new Date(Date.UTC(2026, 9, 2, 10, 0, offsetSec)).toISOString();
const line = (timestamp: string, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp, type, payload });

const meta = (cwd: string, timestamp: string) =>
  line(timestamp, 'session_meta', {
    id: 'thread-1',
    timestamp,
    cwd,
    originator: 'codex_cli_rs',
    cli_version: '0.154.0',
    base_instructions: { text: 'x'.repeat(5000) },
  });
const userMessage = (timestamp: string, ...texts: string[]) =>
  line(timestamp, 'response_item', {
    type: 'message',
    role: 'user',
    content: texts.map((text) => ({ type: 'input_text', text })),
  });
const assistantMessage = (timestamp: string, text: string) =>
  line(timestamp, 'response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
    phase: 'final_answer',
  });
const shellCall = (timestamp: string, callId: string, command: string) =>
  line(timestamp, 'response_item', {
    type: 'function_call',
    name: 'shell_command',
    arguments: JSON.stringify({ command, workdir: '/w' }),
    call_id: callId,
  });
const shellOutput = (timestamp: string, callId: string, output: string) =>
  line(timestamp, 'response_item', { type: 'function_call_output', call_id: callId, output });
const event = (timestamp: string, type: string) =>
  line(timestamp, 'event_msg', { type, turn_id: 't1' });

describe('isCodexCommand', () => {
  it('spots codex as the command or inside a shell command string', () => {
    expect(isCodexCommand(['codex'])).toBe(true);
    expect(isCodexCommand(['/opt/homebrew/bin/codex', '--yolo'])).toBe(true);
    expect(isCodexCommand(['zsh', '-lic', 'codex resume'])).toBe(true);
    expect(isCodexCommand(['claude'])).toBe(false);
    expect(isCodexCommand(['zsh', '-c', 'cd ~/ut-agent-codex && ls'])).toBe(false);
    expect(isCodexCommand(undefined)).toBe(false);
    // Another agent that only names it in its arguments (2026-11-11).
    expect(isCodexCommand(['claude', 'review the codex integration'])).toBe(false);
    expect(isCodexCommand(['zsh', '-lic', 'claude "what is codex"'])).toBe(false);
    expect(isCodexCommand(['env', 'A=1', '/usr/local/bin/claude', '--model', 'codex'])).toBe(false);
    expect(isCodexCommand(['zsh', '-lc', 'exec env A=1 codex --yolo'])).toBe(true);
  });
});

describe('parseCodexLine', () => {
  it('keeps what the user typed and drops what Codex injects', () => {
    const parsed = parseCodexLine(
      userMessage(
        at(1),
        '<environment_context>\n  <cwd>/w</cwd>\n</environment_context>',
        '# AGENTS.md instructions for /w\n\nbe nice'
      )
    );
    expect(parsed.messages).toEqual([]);
    const [message] = parseCodexLine(userMessage(at(2), 'fix the build'), 7).messages;
    expect(message).toEqual({
      id: `${at(2)}:7`,
      role: 'user',
      text: 'fix the build',
      timestamp: at(2),
    });
  });

  it('turns shell calls into Bash tool rows and summarizes their output', () => {
    const [tool] = parseCodexLine(shellCall(at(3), 'c1', 'npm test')).messages;
    expect(tool).toMatchObject({
      role: 'tool',
      tool: 'Bash',
      text: 'npm test',
      detail: '$ npm test',
      toolUseId: 'c1',
    });
    const output = parseCodexLine(
      shellOutput(
        at(4),
        'c1',
        `Exit code: 1\nWall time: 2.1 seconds\nOutput:\n${'fail\n'.repeat(40)}`
      )
    ).result;
    expect(output?.isError).toBe(true);
    expect(output?.text.startsWith('fail\n')).toBe(true);
    expect(output?.text.split('\n')).toHaveLength(21);
    expect(output?.text.endsWith('…')).toBe(true);
  });

  it('reads exec_command arrays, JSON outputs and apply_patch edits', () => {
    const [array] = parseCodexLine(
      line(at(5), 'response_item', {
        type: 'function_call',
        name: 'shell',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la'] }),
        call_id: 'c2',
      })
    ).messages;
    expect(array.text).toBe('ls -la');
    expect(
      parseCodexLine(
        shellOutput(at(6), 'c2', JSON.stringify({ output: 'ok\n', metadata: { exit_code: 0 } }))
      ).result
    ).toEqual({ callId: 'c2', text: 'ok', isError: false });
    const [patch] = parseCodexLine(
      line(at(7), 'response_item', {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'c3',
        input: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch',
      })
    ).messages;
    expect(patch).toMatchObject({
      tool: 'Edit',
      text: 'app.ts',
      detail: 'src/app.ts',
      diff: ['-a', '+b'],
    });
  });

  it('shows a code-mode script that runs apply_patch as the edit, with its change', () => {
    // The exact shape gpt-6-astra wrote on 2026-10-03.
    const [edit] = parseCodexLine(
      line(at(9), 'response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'c9',
        input:
          'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /repo/notas.md\\n@@\\n-linea tres\\n+LINEA TRES\\n*** End Patch"));',
      })
    ).messages;
    expect(edit).toMatchObject({
      tool: 'Edit',
      text: 'notas.md',
      detail: '/repo/notas.md',
      diff: ['-linea tres', '+LINEA TRES'],
    });
    expect(
      execScriptPatches(
        'await tools.apply_patch(`*** Begin Patch\n*** Add File: a.md\n+uno \\`dos\\`\n*** End Patch`)'
      )
    ).toEqual(['*** Begin Patch\n*** Add File: a.md\n+uno `dos`\n*** End Patch']);
  });

  it('skips reasoning, token counts and broken lines', () => {
    expect(
      parseCodexLine(line(at(8), 'response_item', { type: 'reasoning', summary: [] })).messages
    ).toEqual([]);
    expect(parseCodexLine(line(at(8), 'event_msg', { type: 'token_count' })).messages).toEqual([]);
    expect(parseCodexLine('{not json').messages).toEqual([]);
  });
});

describe('readCodexChat', () => {
  let codexDir: string;
  let dayDir: string;
  const cwd = '/Users/someone/project';
  const sessionStart = at(0);

  beforeEach(() => {
    codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-chat-test-'));
    const day = new Date(sessionStart);
    dayDir = path.join(
      codexDir,
      'sessions',
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0')
    );
    fs.mkdirSync(dayDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(codexDir, RM_TEST_DIR);
  });

  const writeRollout = (name: string, lines: string[]) => {
    const file = path.join(dayDir, `rollout-${name}.jsonl`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  };

  it('matches the newest rollout started in the session directory after it began', () => {
    writeRollout('2026-10-02T09-00-00-old', [meta(cwd, at(-3600))]);
    writeRollout('2026-10-02T10-00-10-other', [meta('/elsewhere', at(10))]);
    const mine = writeRollout('2026-10-02T10-00-05-mine', [meta(cwd, at(5))]);
    expect(findCodexRollout(codexDir, cwd, Date.parse(sessionStart))).toBe(mine);
    expect(findCodexRollout(codexDir, cwd, Date.parse(sessionStart), new Set([mine]))).toBeNull();
    expect(findCodexRollout(codexDir, '/nowhere', Date.parse(sessionStart))).toBeNull();
  });

  it('takes the TUI’s own conversation, never a newer one-shot run or an internal thread', () => {
    // session_meta of codex-cli 0.164: `source` and `thread_source` say whose thread it is.
    const metaOf = (timestamp: string, extra: Record<string, unknown>) =>
      line(timestamp, 'session_meta', { id: 'thread', timestamp, cwd, ...extra });
    const mine = writeRollout('2026-10-02T10-00-05-tui', [
      metaOf(at(5), { source: 'cli', thread_source: 'user', originator: 'codex-tui' }),
    ]);
    // `codex exec` run in the same folder later: the newest rollout there, not the session's.
    const exec = writeRollout('2026-10-02T10-05-00-exec', [
      metaOf(at(300), { source: 'exec', thread_source: 'user', originator: 'codex_exec' }),
    ]);
    writeRollout('2026-10-02T10-06-00-subagent', [
      metaOf(at(360), { source: { subagent: { thread_spawn: { depth: 1 } } } }),
    ]);
    writeRollout('2026-10-02T10-07-00-guardian', [
      metaOf(at(420), { source: 'cli', thread_source: 'guardian' }),
    ]);
    const since = Date.parse(sessionStart);
    expect(findCodexRollout(codexDir, cwd, since)).toBe(mine);
    // A session started as `codex exec …`: its one-shot run, when nothing interactive is left.
    expect(findCodexRollout(codexDir, cwd, since, new Set([mine]))).toBe(exec);
    expect(findCodexRollout(codexDir, cwd, since, new Set([mine, exec]))).toBeNull();
    expect(rolloutKind(undefined, undefined)).toBe('interactive');
    expect(rolloutKind('vscode', 'user')).toBe('interactive');
    expect(rolloutKind('mcp', 'user')).toBe('oneshot');
    expect(rolloutKind({ internal: 'memory_consolidation' }, undefined)).toBe('internal');
  });

  it('matches through a symlinked folder (macOS /tmp is /private/tmp)', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-codex-real-'));
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    try {
      const mine = writeRollout('2026-10-02T10-00-05-linked', [meta(fs.realpathSync(real), at(5))]);
      expect(findCodexRollout(codexDir, link, Date.parse(sessionStart))).toBe(mine);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, RM_TEST_DIR);
    }
  });

  it('serves the conversation, follows appends and reports busy while a turn is open', () => {
    const file = writeRollout('2026-10-02T10-00-05-chat', [
      meta(cwd, at(5)),
      event(at(6), 'task_started'),
      userMessage(at(6), '<environment_context></environment_context>'),
      userMessage(at(7), 'list the files'),
      line(at(8), 'response_item', { type: 'reasoning', summary: [] }),
      shellCall(at(9), 'c1', 'ls'),
    ]);
    const session = { id: 'ut-1', workingDir: cwd, startedAt: sessionStart };
    const now = Date.now;
    Date.now = () => Date.parse(at(20));
    try {
      const busy = readCodexChat(session, codexDir);
      expect(busy).toMatchObject({ available: true, agent: 'codex', status: 'busy' });
      expect(busy.title).toBe('list the files');
      expect(busy.activity).toMatchObject({ kind: 'tool', tool: 'Bash', target: 'ls' });
      expect(busy.messages.map((m) => m.role)).toEqual(['user', 'tool']);

      fs.appendFileSync(
        file,
        `${[
          shellOutput(at(10), 'c1', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\na.txt\n'),
          assistantMessage(at(11), 'There is one file.'),
          event(at(12), 'task_complete'),
        ].join('\n')}\n`
      );
      const idle = readCodexChat(session, codexDir);
      expect(idle.status).toBe('idle');
      expect(idle.activity).toBeUndefined();
      expect(idle.messages.map((m) => [m.role, m.text, m.result])).toEqual([
        ['user', 'list the files', undefined],
        ['tool', 'ls', 'a.txt'],
        ['assistant', 'There is one file.', undefined],
      ]);
    } finally {
      Date.now = now;
      forgetCodexSession('ut-1');
    }
  });

  it('is an empty chat until Codex writes its rollout', () => {
    const chat = readCodexChat({ id: 'ut-2', workingDir: cwd, startedAt: sessionStart }, codexDir);
    expect(chat).toEqual({ available: true, agent: 'codex', status: 'idle', messages: [] });
    forgetCodexSession('ut-2');
  });

  it('gives two sessions in one directory different rollouts', () => {
    const first = writeRollout('2026-10-02T10-00-05-a', [
      meta(cwd, at(5)),
      userMessage(at(6), 'A'),
    ]);
    readCodexChat({ id: 'ut-a', workingDir: cwd, startedAt: sessionStart }, codexDir);
    writeRollout('2026-10-02T10-01-00-b', [meta(cwd, at(60)), userMessage(at(61), 'B')]);
    const b = readCodexChat({ id: 'ut-b', workingDir: cwd, startedAt: at(55) }, codexDir);
    const a = readCodexChat({ id: 'ut-a', workingDir: cwd, startedAt: sessionStart }, codexDir);
    expect(a.title).toBe('A');
    expect(b.title).toBe('B');
    expect(first).toContain('-a.jsonl');
    forgetCodexSession('ut-a');
    forgetCodexSession('ut-b');
  });

  // 2026-11-10, checked with Codex 0.164: `codex resume <id>` writes on in the thread's first
  // rollout, older than the session, so its start time found nothing and the chat stayed empty.
  describe('a resumed thread', () => {
    const thread = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

    it('is found by its id, whenever it started', () => {
      const old = writeRollout(`2026-10-02T08-00-00-${thread}`, [
        meta(cwd, at(-7200)),
        userMessage(at(-7190), 'the first prompt, hours ago'),
        assistantMessage(at(-7180), 'Done.'),
      ]);
      expect(findCodexRolloutById(codexDir, thread)).toBe(old);
      expect(findCodexRolloutById(codexDir, thread.toUpperCase())).toBe(old);
      expect(findCodexRolloutById(codexDir, '0199a1b2-0000-7e5f-8a9b-0c1d2e3f4a5b')).toBeNull();
    });

    it('a thread with no rollout is not looked for again on every ask (2026-11-10)', () => {
      const missing = '0199a1b2-1111-7e5f-8a9b-0c1d2e3f4a5b';
      const clock = vi.spyOn(Date, 'now');
      try {
        const start = Date.UTC(2026, 10, 10);
        clock.mockReturnValue(start);
        expect(findCodexRolloutById(codexDir, missing)).toBeNull();
        const late = writeRollout(`2026-10-02T09-00-00-${missing}`, [meta(cwd, at(0))]);
        // Within the recheck window the miss is answered from memory, with no scan.
        clock.mockReturnValue(start + 1000);
        expect(findCodexRolloutById(codexDir, missing)).toBeNull();
        clock.mockReturnValue(start + 6000);
        expect(findCodexRolloutById(codexDir, missing)).toBe(late);
      } finally {
        clock.mockRestore();
      }
    });

    it('is the chat of a session started as `codex resume <id>`, never a newer rollout there', () => {
      writeRollout(`2026-10-02T08-00-00-${thread}`, [
        meta(cwd, at(-7200)),
        userMessage(at(-7190), 'the first prompt, hours ago'),
      ]);
      // Another session's Codex, started in the same folder after the resume.
      writeRollout('2026-10-02T10-00-30-other', [meta(cwd, at(30)), userMessage(at(31), 'B')]);
      const resumed = { id: 'ut-r', workingDir: cwd, startedAt: sessionStart };
      expect(readCodexChat({ ...resumed, resumedThreadId: thread }, codexDir).title).toBe(
        'the first prompt, hours ago'
      );
      // The other session still gets its own.
      expect(
        readCodexChat({ id: 'ut-o', workingDir: cwd, startedAt: at(20) }, codexDir).title
      ).toBe('B');
      forgetCodexSession('ut-r');
      forgetCodexSession('ut-o');
    });
  });

  // 2026-11-10 (seen on the twin): two Codex in one folder, the older one idle; its session
  // showed the other's conversation.
  describe('two Codex in one folder', () => {
    it("a rollout is the Codex's that started just before it, not an older idle one's", () => {
      const made = writeRollout('2026-10-02T10-00-21-b', [
        meta(cwd, at(21)),
        userMessage(at(40), 'B'),
      ]);
      const idleStart = Date.parse(at(0));
      const busyStart = Date.parse(at(20));
      expect(findCodexRolloutAmong(codexDir, cwd, busyStart, [idleStart])).toBe(made);
      expect(findCodexRolloutAmong(codexDir, cwd, idleStart, [busyStart])).toBeNull();
      // Alone, the newest since its start, as before.
      expect(findCodexRolloutAmong(codexDir, cwd, idleStart, [])).toBe(made);
      // Its own, made before the other started.
      const own = writeRollout('2026-10-02T10-00-03-a', [meta(cwd, at(3))]);
      expect(findCodexRolloutAmong(codexDir, cwd, idleStart, [busyStart])).toBe(own);
      expect(findCodexRolloutAmong(codexDir, cwd, busyStart, [idleStart])).toBe(made);
      // The first one after its start: a later /new there could be the other's.
      writeRollout('2026-10-02T10-05-00-n', [meta(cwd, at(300))]);
      expect(findCodexRolloutAmong(codexDir, cwd, busyStart, [idleStart])).toBe(made);
      expect(
        findCodexRolloutAmong(codexDir, cwd, busyStart, [idleStart], new Set([made]))
      ).toContain('-n.jsonl');
    });

    it("the idle session's chat stays empty once the other one is known", () => {
      writeRollout('2026-10-02T10-00-21-b', [meta(cwd, at(21)), userMessage(at(40), 'B')]);
      const idle = { id: 'ut-idle', workingDir: cwd, startedAt: at(0) };
      const busy = { id: 'ut-busy', workingDir: cwd, startedAt: at(20) };
      expect(readCodexChat(busy, codexDir).title).toBe('B');
      expect(readCodexChat(idle, codexDir).messages).toEqual([]);
      forgetCodexSession('ut-idle');
      forgetCodexSession('ut-busy');
    });
  });

  describe('codexRolloutFirstPrompt', () => {
    it('reads the first prompt past the instructions and what Codex adds itself', () => {
      const file = writeRollout('2026-10-02T10-00-05-p', [
        meta(cwd, at(5)),
        userMessage(at(6), '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>'),
        userMessage(at(7), `fix   the\nlogin page ${'x'.repeat(200)}`),
        assistantMessage(at(8), 'On it.'),
        userMessage(at(9), 'a later prompt'),
      ]);
      const title = codexRolloutFirstPrompt(file);
      expect(title?.startsWith('fix the login page xxx')).toBe(true);
      expect(title?.length).toBe(80);
    });

    it('is nothing before the first prompt, or without the file', () => {
      expect(
        codexRolloutFirstPrompt(writeRollout('2026-10-02T10-00-05-e', [meta(cwd, at(5))]))
      ).toBeUndefined();
      expect(codexRolloutFirstPrompt(path.join(dayDir, 'rollout-gone.jsonl'))).toBeUndefined();
    });
  });
});

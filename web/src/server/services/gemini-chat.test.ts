import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  chatFileStart,
  findGeminiChat,
  forgetGeminiSession,
  geminiProjectDirs,
  geminiRecordMessages,
  isGeminiCommand,
  parseGeminiChatFile,
  readGeminiChat,
} from './gemini-chat.js';

const at = (sec: number) => new Date(Date.UTC(2026, 9, 2, 10, 0, sec)).toISOString();
/** File-name stamp of a time: UTC minute, `:` as `-`. */
const stamp = (iso: string) => iso.slice(0, 16).replace(/:/g, '-');

const user = (id: string, timestamp: string, text: string) => ({
  id,
  timestamp,
  type: 'user',
  content: [{ text }],
});
const gemini = (id: string, timestamp: string, text: string, toolCalls?: unknown[]) => ({
  id,
  timestamp,
  type: 'gemini',
  content: text,
  thoughts: [{ subject: 'Plan', description: 'thinking', timestamp }],
  tokens: { input: 1, output: 1, cached: 0, thoughts: 0, tool: 0, total: 2 },
  model: 'gemini-test',
  ...(toolCalls ? { toolCalls } : {}),
});
const shellCall = (id: string, command: string, output?: string) => ({
  id,
  name: 'run_shell_command',
  args: { command, description: 'run it' },
  ...(output === undefined
    ? {}
    : {
        status: 'success',
        result: [
          {
            functionResponse: {
              id,
              name: 'run_shell_command',
              response: {
                output: `Command: ${command}\nDirectory: (root)\nOutput: ${output}\nError: (none)\nExit Code: 0`,
              },
            },
          },
        ],
      }),
  timestamp: at(5),
  displayName: 'Shell',
});

describe('isGeminiCommand', () => {
  it('spots gemini as the command or inside a shell command string', () => {
    expect(isGeminiCommand(['gemini'])).toBe(true);
    expect(isGeminiCommand(['/opt/homebrew/bin/gemini', '-m', 'pro'])).toBe(true);
    expect(isGeminiCommand(['zsh', '-lic', 'gemini --yolo'])).toBe(true);
    expect(isGeminiCommand(['codex'])).toBe(false);
    expect(isGeminiCommand(['zsh', '-c', 'cd ~/gemini-notes && ls'])).toBe(false);
    expect(isGeminiCommand(undefined)).toBe(false);
    // Another agent that only names it in its arguments (2026-11-11).
    expect(isGeminiCommand(['claude', 'review the gemini integration'])).toBe(false);
    expect(isGeminiCommand(['zsh', '-lic', 'claude "what is gemini"'])).toBe(false);
    expect(isGeminiCommand(['env', 'A=1', '/usr/local/bin/claude', '--model', 'gemini'])).toBe(
      false
    );
    expect(isGeminiCommand(['zsh', '-lc', 'exec env A=1 gemini --yolo'])).toBe(true);
  });
});

describe('geminiRecordMessages', () => {
  it('maps prompts, answers and tool calls with short summaries and capped results', () => {
    expect(geminiRecordMessages(user('u1', at(0), 'fix the tests'))).toEqual([
      { id: 'u1', role: 'user', text: 'fix the tests', timestamp: at(0) },
    ]);
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const messages = geminiRecordMessages(
      gemini('g1', at(4), 'Running them.', [
        shellCall('c1', 'npm test', long),
        {
          id: 'c2',
          name: 'read_file',
          args: { file_path: '/w/src/a.ts' },
          status: 'error',
          result: [{ functionResponse: { response: { error: 'not found' } } }],
        },
        {
          id: 'c3',
          name: 'replace',
          args: { file_path: '/w/src/b.ts', old_string: 'x', new_string: 'y' },
          status: 'success',
          resultDisplay: { fileDiff: '…' },
        },
      ])
    );
    expect(messages.map((m) => [m.role, m.tool, m.text])).toEqual([
      ['assistant', undefined, 'Running them.'],
      ['tool', 'Bash', 'npm test'],
      ['tool', 'Read', 'a.ts'],
      ['tool', 'Edit', 'b.ts'],
    ]);
    expect(messages[1].result?.split('\n')).toHaveLength(21);
    expect(messages[1].result?.startsWith('line 0\nline 1')).toBe(true);
    expect(messages[1].result).not.toContain('Exit Code');
    expect(messages[2]).toMatchObject({ result: 'not found', isError: true });
    expect(messages[3].result).toBe('');
  });

  it('shows errors and warnings as notes and skips info lines', () => {
    expect(geminiRecordMessages({ id: 'i', type: 'info', content: 'Switched model' })).toEqual([]);
    expect(geminiRecordMessages({ id: 'e', type: 'error', content: 'Quota exceeded' })).toEqual([
      { id: 'e', role: 'note', text: 'Quota exceeded', timestamp: undefined },
    ]);
  });
});

describe('parseGeminiChatFile', () => {
  it('replays a JSONL log: replaced records, patches, rewinds and $set', () => {
    const lines = [
      { sessionId: 's', projectHash: 'h', startTime: at(0), lastUpdated: at(0), kind: 'main' },
      user('u1', at(1), 'first'),
      gemini('g1', at(2), 'partial'),
      gemini('g1', at(3), 'complete answer', [shellCall('c1', 'ls')]),
      {
        $patch: {
          id: 'g1',
          toolCalls: [
            {
              id: 'c1',
              status: 'success',
              result: [{ functionResponse: { response: { output: 'a.ts' } } }],
            },
          ],
        },
      },
      user('u2', at(4), 'oops'),
      { $rewindTo: 'u2' },
      user('u3', at(5), 'second'),
      '{"id":"half-writ',
    ].map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
    const records = parseGeminiChatFile(lines.join('\n'), true);
    expect(records.map((r) => r.id)).toEqual(['u1', 'g1', 'u3']);
    const tool = geminiRecordMessages(records[1])[1];
    expect(tool).toMatchObject({ tool: 'Bash', text: 'ls', result: 'a.ts' });

    const reset = parseGeminiChatFile(
      [...lines, JSON.stringify({ $set: { messages: [user('only', at(9), 'kept')] } })].join('\n'),
      true
    );
    expect(reset.map((r) => r.id)).toEqual(['only']);
  });

  it('reads the messages of a JSON document', () => {
    const doc = JSON.stringify({ sessionId: 's', messages: [user('u1', at(1), 'hi')] });
    expect(parseGeminiChatFile(doc, false).map((r) => r.id)).toEqual(['u1']);
    expect(parseGeminiChatFile('{"messages": [', false)).toEqual([]);
  });
});

describe('finding and reading a session chat', () => {
  let home: string;
  let geminiDir: string;
  let projectDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-chat-test-'));
    geminiDir = path.join(home, '.gemini');
    fs.mkdirSync(path.join(home, 'project'));
    projectDir = fs.realpathSync(path.join(home, 'project'));
  });

  afterEach(() => {
    forgetGeminiSession('s1');
    forgetGeminiSession('s2');
    fs.rmSync(home, RM_TEST_DIR);
  });

  const hashDir = (root: string) =>
    path.join(geminiDir, 'tmp', crypto.createHash('sha256').update(root).digest('hex'));
  const writeChat = (
    dir: string,
    name: string,
    messages: unknown[],
    jsonl = false,
    mtime?: Date
  ) => {
    const chats = path.join(dir, 'chats');
    fs.mkdirSync(chats, { recursive: true });
    const file = path.join(chats, `${name}.json${jsonl ? 'l' : ''}`);
    const head = { sessionId: name, projectHash: 'h', startTime: at(0), lastUpdated: at(0) };
    fs.writeFileSync(
      file,
      jsonl
        ? `${[head, ...messages].map((m) => JSON.stringify(m)).join('\n')}\n`
        : JSON.stringify({ ...head, messages })
    );
    if (mtime) fs.utimesSync(file, mtime, mtime);
    return file;
  };

  it('uses the projects.json short name, then the sha256 folder', () => {
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(
      path.join(geminiDir, 'projects.json'),
      JSON.stringify({ projects: { [projectDir]: 'project' } })
    );
    expect(geminiProjectDirs(geminiDir, projectDir)).toEqual([
      path.join(geminiDir, 'tmp', 'project'),
      hashDir(projectDir),
    ]);
  });

  it('parses the UTC minute of chat file names', () => {
    expect(chatFileStart('session-2026-10-02T10-01-abcd1234.jsonl')).toBe(
      Date.UTC(2026, 9, 2, 10, 1)
    );
    expect(chatFileStart('logs.json')).toBeUndefined();
  });

  it('picks the newest chat started after the session, skipping older and claimed ones', () => {
    const old = new Date(Date.UTC(2026, 9, 1));
    writeChat(hashDir(projectDir), `session-${stamp(at(-3600))}-aaaaaaaa`, [], false, old);
    const mine = writeChat(hashDir(projectDir), `session-${stamp(at(60))}-bbbbbbbb`, []);
    const other = writeChat(hashDir(projectDir), `session-${stamp(at(120))}-cccccccc`, []);
    expect(findGeminiChat(geminiDir, projectDir, Date.parse(at(0)))).toBe(other);
    expect(findGeminiChat(geminiDir, projectDir, Date.parse(at(0)), new Set([other]))).toBe(mine);
    // Nothing started or written after a later session start.
    expect(findGeminiChat(geminiDir, projectDir, Date.now() + 3_600_000)).toBeNull();
  });

  it('falls back to an older chat written after the session began (gemini --resume)', () => {
    const resumed = writeChat(hashDir(projectDir), 'session-2026-09-01T08-00-eeeeeeee', []);
    const since = Date.now() - 60_000;
    expect(findGeminiChat(geminiDir, projectDir, since)).toBe(resumed);
  });

  it('reads a session chat with its title and busy status', () => {
    const name = `session-${stamp(new Date().toISOString())}-dddddddd`;
    writeChat(
      path.join(geminiDir, 'tmp', 'project'),
      name,
      [user('u1', at(1), 'add  a\nlogin page')],
      true
    );
    fs.writeFileSync(
      path.join(geminiDir, 'projects.json'),
      JSON.stringify({ projects: { [projectDir]: 'project' } })
    );
    const session = {
      id: 's1',
      workingDir: projectDir,
      startedAt: new Date(Date.now() - 1000).toISOString(),
    };
    const chat = readGeminiChat(session, geminiDir);
    expect(chat).toMatchObject({
      available: true,
      agent: 'gemini',
      status: 'busy',
      title: 'add a login page',
    });
    expect(chat.activity?.kind).toBe('thinking');
    expect(chat.messages).toHaveLength(1);
  });

  it('is an empty idle chat until Gemini writes one', () => {
    const session = { id: 's2', workingDir: projectDir, startedAt: at(0) };
    expect(readGeminiChat(session, geminiDir)).toEqual({
      available: true,
      agent: 'gemini',
      status: 'idle',
      messages: [],
    });
  });
});

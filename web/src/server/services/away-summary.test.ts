import { describe, expect, it } from 'vitest';
import { buildAwaySummary } from './away-summary';
import {
  type ClaudeChat,
  type ClaudeChatMessage,
  parseToolResults,
  parseTranscriptLine,
} from './claude-chat';

const at = (minute: number) => `2026-10-02T10:${String(minute).padStart(2, '0')}:00.000Z`;
const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

const assistant = (minute: number, content: unknown[]) =>
  line({ type: 'assistant', uuid: `a${minute}`, timestamp: at(minute), message: { content } });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const toolResult = (minute: number, id: string, content: string, isError = false) =>
  line({
    type: 'user',
    uuid: `r${id}`,
    timestamp: at(minute),
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  });

/** A Claude Code session: a turn before the user left, then work while away. */
const TRANSCRIPT = [
  line({ type: 'user', uuid: 'u1', timestamp: at(0), message: { content: 'Fix the login bug' } }),
  assistant(1, [toolUse('t0', 'Edit', { file_path: '/repo/old.ts', old_string: 'a' })]),
  toolResult(1, 't0', 'ok'),
  assistant(2, [{ type: 'text', text: 'Before you left.' }]),
  // ---- the user stopped looking at 10:05 ----
  assistant(6, [toolUse('t1', 'Read', { file_path: '/repo/src/auth.ts' })]),
  toolResult(6, 't1', 'file contents'),
  assistant(7, [toolUse('t2', 'Edit', { file_path: '/repo/src/auth.ts', old_string: 'x' })]),
  toolResult(7, 't2', 'The file has been updated'),
  assistant(8, [
    toolUse('t3', 'MultiEdit', { file_path: '/repo/src/auth.ts', edits: [{ old_string: 'y' }] }),
    toolUse('t4', 'Write', { file_path: '/repo/src/auth.test.ts', content: 'test' }),
  ]),
  toolResult(8, 't3', 'ok'),
  toolResult(8, 't4', 'ok'),
  assistant(9, [
    toolUse('t5', 'Bash', { command: 'pnpm test auth', description: 'Run the auth tests' }),
  ]),
  toolResult(10, 't5', 'Exit code 1\nFAIL src/auth.test.ts\nExpected true', true),
  assistant(11, [{ type: 'text', text: 'One test fails: the **token** check was inverted.' }]),
  assistant(12, [toolUse('t6', 'Edit', { file_path: '/repo/src/auth.ts', old_string: 'z' })]),
  toolResult(12, 't6', 'ok'),
  assistant(13, [toolUse('t7', 'Bash', { command: 'pnpm test auth' })]),
  toolResult(14, 't7', 'PASS src/auth.test.ts'),
  assistant(15, [{ type: 'text', text: 'All green. Want me to commit?' }]),
];

/** Mirrors the chat reader: tool results attach to their tool call. */
function chatFrom(lines: string[], status: string): ClaudeChat {
  const messages: ClaudeChatMessage[] = [];
  const tools = new Map<string, ClaudeChatMessage>();
  for (const entry of lines) {
    for (const message of parseTranscriptLine(entry)) {
      messages.push(message);
      if (message.toolUseId) tools.set(message.toolUseId, message);
    }
    for (const result of parseToolResults(entry)) {
      const tool = tools.get(result.toolUseId);
      if (tool) {
        tool.result = result.text;
        tool.isError = result.isError;
      }
    }
  }
  return { available: true, status, messages };
}

describe('buildAwaySummary', () => {
  it('summarizes files, commands, errors and messages after `since` only', () => {
    const summary = buildAwaySummary(chatFrom(TRANSCRIPT, 'idle'), Date.parse(at(5)));
    expect(summary.files).toEqual([
      { path: '/repo/src/auth.ts', edits: 3 },
      { path: '/repo/src/auth.test.ts', edits: 1 },
    ]);
    expect(summary.commands).toEqual([
      expect.objectContaining({ command: 'pnpm test auth', isError: true, exitCode: 1 }),
      expect.objectContaining({ command: 'pnpm test auth' }),
    ]);
    expect(summary.commands[1].isError).toBeUndefined();
    expect(summary.errors).toEqual([
      expect.objectContaining({ tool: 'Bash', text: expect.stringContaining('FAIL') }),
    ]);
    // Read + 3 edits + Write + 2 Bash = 7 tool calls (the 10:01 edit was before `since`).
    expect(summary.toolCalls).toBe(7);
    expect(summary.messages).toBe(2);
    expect(summary.lastMessage).toBe('All green. Want me to commit?');
    expect(summary.lastActivityAt).toBe(at(15));
    expect(summary.status).toBe('done');
    expect(summary.files.some((f) => f.path === '/repo/old.ts')).toBe(false);
  });

  it('reports nothing when no work happened after `since`', () => {
    const summary = buildAwaySummary(chatFrom(TRANSCRIPT, 'idle'), Date.parse(at(30)));
    expect(summary.toolCalls + summary.messages).toBe(0);
    expect(summary.lastActivityAt).toBeUndefined();
    expect(summary.lastMessage).toBeUndefined();
  });

  it('maps the agent status, a running command and an open question', () => {
    const running = [
      ...TRANSCRIPT,
      assistant(16, [toolUse('t8', 'Bash', { command: 'pnpm build' })]),
    ];
    const busy = buildAwaySummary(chatFrom(running, 'busy'), Date.parse(at(5)));
    expect(busy.status).toBe('working');
    expect(busy.commands.at(-1)).toEqual(
      expect.objectContaining({ command: 'pnpm build', pending: true })
    );
    expect(buildAwaySummary(chatFrom(TRANSCRIPT, 'waiting'), 0).status).toBe('waiting');
    const asking = [
      ...TRANSCRIPT,
      assistant(16, [
        toolUse('q1', 'AskUserQuestion', {
          questions: [{ question: 'Commit?', options: [{ label: 'Yes' }, { label: 'No' }] }],
        }),
      ]),
    ];
    expect(buildAwaySummary(chatFrom(asking, 'busy'), 0).status).toBe('waiting');
  });

  it('reads Codex patches (one file per line) and an unavailable chat', () => {
    const codex: ClaudeChat = {
      available: true,
      status: 'idle',
      messages: [
        {
          id: 'c1',
          role: 'tool',
          tool: 'Edit',
          text: 'a.ts, b.ts',
          detail: '/r/a.ts\n/r/b.ts',
          timestamp: at(6),
          result: 'ok',
        },
      ],
    };
    (codex as { agent?: string }).agent = 'codex';
    const summary = buildAwaySummary(codex, Date.parse(at(5)));
    expect(summary.agent).toBe('codex');
    expect(summary.files.map((f) => f.path)).toEqual(['/r/a.ts', '/r/b.ts']);
    expect(buildAwaySummary({ available: false, messages: [] }, 0)).toEqual(
      expect.objectContaining({ available: false, toolCalls: 0, status: 'unknown' })
    );
  });
});

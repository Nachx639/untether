import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { parseProcessTable } from './claude-chat.js';
import type { CodexProcessDeps } from './codex-process.js';
import { forgetGeminiSession, readGeminiChat } from './gemini-chat.js';
import { findGeminiPid, geminiSessionRef, isGeminiProcessArgs } from './gemini-process.js';

const NPM = '/opt/homebrew/lib/node_modules/@google/gemini-cli';

// What `TZ=UTC ps -A -o pid=,ppid=,lstart=,args=` shows for `gemini` typed in an Untether zsh:
// the launcher and the copy it relaunches with a bigger heap.
const PS = [
  `  100     1 Fri Oct  2 09:59:00 2026     -zsh`,
  `  300   100 Fri Oct  2 10:00:20 2026     node /opt/homebrew/bin/gemini -m gemini-2.5-pro`,
  `  301   300 Fri Oct  2 10:00:21 2026     /opt/homebrew/bin/node --max-old-space-size=8192 ${NPM}/dist/index.js -m gemini-2.5-pro`,
  `  400     1 Fri Oct  2 09:00:00 2026     -zsh`,
  `  401   400 Fri Oct  2 09:00:01 2026     vim gemini.md`,
].join('\n');

describe('isGeminiProcessArgs', () => {
  it('spots the interactive CLI as launcher, relaunched child or binary', () => {
    expect(isGeminiProcessArgs('node /opt/homebrew/bin/gemini')).toBe(true);
    expect(isGeminiProcessArgs(`node --max-old-space-size=8192 ${NPM}/dist/index.js`)).toBe(true);
    expect(isGeminiProcessArgs('gemini --yolo')).toBe(true);
    expect(isGeminiProcessArgs('gemini -m pro -i "fix the tests"')).toBe(true);
    expect(isGeminiProcessArgs('gemini --resume latest')).toBe(true);
  });

  it('ignores one-shot runs, subcommands and other programs', () => {
    expect(isGeminiProcessArgs('gemini -p "summarize"')).toBe(false);
    expect(isGeminiProcessArgs('gemini --prompt=summarize')).toBe(false);
    expect(isGeminiProcessArgs('gemini -m pro mcp list')).toBe(false);
    expect(isGeminiProcessArgs('gemini --version')).toBe(false);
    expect(isGeminiProcessArgs('vim gemini.md')).toBe(false);
    expect(isGeminiProcessArgs('node /usr/lib/node_modules/other/index.js gemini')).toBe(false);
    expect(isGeminiProcessArgs('gemini-helper')).toBe(false);
  });
});

describe('findGeminiPid', () => {
  it('finds the launcher among the descendants of the session process', () => {
    const table = parseProcessTable(PS);
    expect(findGeminiPid(table, 100)).toBe(300);
    expect(findGeminiPid(table, 301)).toBe(301);
    expect(findGeminiPid(table, 400)).toBeUndefined();
  });
});

describe('geminiSessionRef', () => {
  let home: string;
  let geminiDir: string;
  const projectDir = '/Users/me/project';
  const deps = (ps = PS): CodexProcessDeps => ({
    table: async () => parseProcessTable(ps),
    cwdOf: async () => projectDir,
  });
  const at = (sec: number) => new Date(Date.UTC(2026, 9, 2, 10, 0, sec)).toISOString();
  const shell = {
    id: 'gemini-shell-session',
    command: ['zsh'],
    workingDir: '/Users/me',
    startedAt: at(-61),
    pid: 100,
    status: 'running',
  };
  // The launcher (pid 300) started at 10:00:20: its chat is claimed under the process.
  const geminiClaim = `proc:300:${Date.UTC(2026, 9, 2, 10, 0, 20)}`;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-process-test-'));
    geminiDir = path.join(home, '.gemini');
  });

  afterEach(() => {
    forgetGeminiSession(geminiClaim);
    fs.rmSync(home, RM_TEST_DIR);
  });

  /** A chat Gemini started at 10:00 in the project, with its first prompt. */
  function writeChat() {
    fs.mkdirSync(path.join(geminiDir, 'tmp', 'project', 'chats'), { recursive: true });
    fs.writeFileSync(
      path.join(geminiDir, 'projects.json'),
      JSON.stringify({ projects: { [projectDir]: 'project' } })
    );
    fs.writeFileSync(
      path.join(geminiDir, 'tmp', 'project', 'chats', 'session-2026-10-02T10-00-abcdef12.jsonl'),
      `${JSON.stringify({ sessionId: 'x', projectHash: 'h', startTime: at(20) })}\n${JSON.stringify({ id: 'u1', timestamp: at(30), type: 'user', content: [{ text: 'fix the login page' }] })}\n`
    );
  }

  it('uses the cwd and start of the Gemini typed in a shell to find its chat', async () => {
    writeChat();
    const ref = await geminiSessionRef(shell, deps());
    expect(ref).toEqual({ id: geminiClaim, workingDir: projectDir, startedAt: at(20) });
    const chat = readGeminiChat(ref as NonNullable<typeof ref>, geminiDir);
    expect(chat.agent).toBe('gemini');
    expect(chat.title).toBe('fix the login page');
  });

  it('gives every reader of one Gemini process the same chat', async () => {
    // A session attached to a tmux session and the Mac list's read of that pane.
    writeChat();
    const attached = await geminiSessionRef({ ...shell, id: 'attached-session' }, deps());
    const paneRead = await geminiSessionRef(
      { id: 'mac:p-1-2-3', workingDir: '/', startedAt: at(0), pid: 300, status: 'running' },
      deps()
    );
    for (const ref of [attached, paneRead]) {
      expect(ref?.id).toBe(geminiClaim);
      expect(readGeminiChat(ref as NonNullable<typeof ref>, geminiDir).title).toBe(
        'fix the login page'
      );
    }
  });

  it('gives a chat back once its process is gone, for gemini --resume in the same shell', async () => {
    writeChat();
    const first = await geminiSessionRef(shell, deps());
    expect(readGeminiChat(first as NonNullable<typeof first>, geminiDir).title).toBe(
      'fix the login page'
    );
    // That Gemini ended; `gemini --resume latest` in the same shell writes to the same chat.
    const resumedPs = [
      '  100     1 Fri Oct  2 09:59:00 2026     -zsh',
      '  310   100 Fri Oct  2 10:05:00 2026     node /opt/homebrew/bin/gemini --resume latest',
    ].join('\n');
    const resumed = await geminiSessionRef(shell, deps(resumedPs));
    expect(resumed?.id).not.toBe(first?.id);
    expect(readGeminiChat(resumed as NonNullable<typeof resumed>, geminiDir).title).toBe(
      'fix the login page'
    );
    forgetGeminiSession(resumed?.id ?? '');
  });

  it('never takes an attached tmux session for Gemini by its command line', async () => {
    // `tmux -L gemini attach`: the socket's name is the last word of an argument.
    const attached = {
      ...shell,
      id: 'attached-session',
      command: ['/usr/bin/tmux', '-u', '-N', '-S', '/tmp/tmux-501/gemini', 'attach-session'],
      multiplexer: {
        type: 'tmux' as const,
        socketPath: '/tmp/tmux-501/gemini',
        serverPid: 90,
        serverStartedAt: 1_790_000_000,
        sessionId: '$0',
        sessionName: '0',
        mode: 'control' as const,
        sizing: 'others' as const,
        source: 'mac-sessions' as const,
      },
    };
    // Its pid is the pane's program: Gemini only when one runs there.
    expect(await geminiSessionRef({ ...attached, pid: 400 }, deps())).toBeNull();
    expect((await geminiSessionRef({ ...attached, pid: 100 }, deps()))?.id).toBe(geminiClaim);
  });

  it('is nothing for a shell without Gemini or a session that exited', async () => {
    expect(await geminiSessionRef({ ...shell, pid: 400 }, deps())).toBeNull();
    expect(await geminiSessionRef({ ...shell, status: 'exited' }, deps())).toBeNull();
  });

  it('keeps sessions started with gemini as they are', async () => {
    const direct = { ...shell, command: ['gemini'] };
    expect(await geminiSessionRef(direct, deps())).toBe(direct);
  });
});

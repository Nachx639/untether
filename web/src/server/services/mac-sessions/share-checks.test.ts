import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import { parseProcessTable } from '../claude-chat.js';
import {
  hasBackgroundWork,
  hasPromptDraft,
  idleProblem,
  readClaudeSessionRecord,
  shellHasForeground,
  shellJobOf,
  transcriptState,
} from './share-checks.js';

const ID = '0b402254-352f-4532-b05e-1186d66e984a';
const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '..', '__fixtures__', 'claude-waiting', name), 'utf8');
const RULE = '─'.repeat(60);

// pid ppid pgid tpgid tdev stat uid lstart(5) args
const START = 'Thu Oct  2 10:00:00 2026';
const row = (pid: number, ppid: number, pgid: number, tpgid: number, tty: string, args: string) =>
  `${pid} ${ppid} ${pgid} ${tpgid} ${tty} S 501 ${START} ${args}`;
const LSTART = 'Thu Oct 2 10:00:00 2026';

function tab(extra: string[] = [], agentTpgid = 500) {
  return parseProcessTable(
    [
      row(
        200,
        1,
        200,
        -1,
        '??',
        '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'
      ),
      row(300, 200, 300, agentTpgid, '16/1', 'login -pf u'),
      row(400, 300, 400, agentTpgid, '16/1', '-zsh'),
      row(500, 400, 500, agentTpgid, '16/1', 'claude --dangerously-skip-permissions'),
      ...extra,
    ].join('\n')
  );
}

describe('shell job', () => {
  it('the agent leads the foreground group of its tab, its shell in a group of its own', () => {
    expect(shellJobOf(tab(), 500, LSTART)).toMatchObject({
      pid: 500,
      tty: 'ttys001',
      shellPid: 400,
      shellPgid: 400,
      shellArg0: '-zsh',
    });
  });

  it('refuses a process that is gone, in the background, or under ut or tmux', () => {
    expect(shellJobOf(tab(), 500, 'Thu Oct 2 11:00:00 2026')).toEqual({ problem: 'gone' });
    expect(shellJobOf(tab([], 400), 500, LSTART)).toEqual({ problem: 'not-shell-job' });
    const underUt = parseProcessTable(
      [
        row(400, 1, 400, 500, '16/1', '-zsh'),
        row(450, 400, 450, 500, '16/1', 'untether-fwd claude'),
        row(500, 450, 500, 500, '16/1', 'claude'),
      ].join('\n')
    );
    expect(shellJobOf(underUt, 500, LSTART)).toEqual({ problem: 'not-shareable' });
  });

  it('the shell has the tab back once the agent is gone', () => {
    const job = shellJobOf(tab(), 500, LSTART);
    if ('problem' in job) throw new Error(job.problem);
    expect(shellHasForeground(tab(), job)).toBe(false);
    expect(shellHasForeground(tab([], 400), job)).toBe(true);
  });

  it('a Bash-tool command still running is background work; an MCP server is not', () => {
    const mcp = row(600, 500, 500, 500, '16/1', 'node /x/mcp-server.js');
    expect(hasBackgroundWork(tab([mcp]), 500)).toBe(false);
    const bash = row(
      601,
      500,
      601,
      500,
      '16/1',
      '/bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh && sleep 300'
    );
    expect(hasBackgroundWork(tab([mcp, bash]), 500)).toBe(true);
  });
});

describe('session file and transcript', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-share-checks-'));
  });
  afterAll(() => {
    if (dir) fs.rmSync(dir, RM_TEST_DIR);
  });

  it('reads the session file of that very process only', () => {
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'sessions', '500.json'),
      JSON.stringify({
        pid: 500,
        procStart: 'Thu Oct  2 10:00:00 2026',
        status: 'idle',
        statusUpdatedAt: 5,
        kind: 'interactive',
        entrypoint: 'cli',
        sessionId: ID,
        cwd: '/x',
      })
    );
    const record = readClaudeSessionRecord(dir, 500, LSTART);
    expect(record).toMatchObject({ status: 'idle', sessionId: ID, statusUpdatedAt: 5 });
    expect(idleProblem(record)).toBeUndefined();
    expect(readClaudeSessionRecord(dir, 500, 'Thu Oct 2 11:00:00 2026')).toBeNull();
    expect(idleProblem(null)).toBe('busy');
    expect(idleProblem({ ...record, status: 'waiting' })).toBe('waiting');
    expect(idleProblem({ ...record, entrypoint: 'sdk-ts' })).toBe('not-shareable');
    expect(idleProblem({ ...record, sessionId: 'nope' })).toBe('no-conversation');
  });

  it('a transcript is flushed when it ends in a whole line of this conversation', () => {
    const file = path.join(dir, 't.jsonl');
    const line = (extra: object) => JSON.stringify({ sessionId: ID, ...extra });
    fs.writeFileSync(file, `${line({ a: 1 })}\n${line({ type: 'cost-state' })}\n`);
    expect(transcriptState(file, ID)).toMatchObject({ flushed: true });
    fs.writeFileSync(file, `${line({ a: 1 })}\n{"sessionId":"${ID}","par`);
    expect(transcriptState(file, ID)).toMatchObject({ flushed: false });
    fs.writeFileSync(file, `${line({ a: 1 })}\n{"sessionId":"other"}\n`);
    expect(transcriptState(file, ID)).toMatchObject({ flushed: false });
    fs.writeFileSync(file, `${line({ a: 1 })}\n{"type":"summary"}\n`);
    expect(transcriptState(file, ID)).toMatchObject({ flushed: true });
    expect(transcriptState(path.join(dir, 'missing.jsonl'), ID)).toBeNull();
  });
});

describe('draft in the prompt', () => {
  it('an empty prompt (❯ and a no-break space, as P1 showed) is not a draft', () => {
    expect(hasPromptDraft(`answer\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ bypass permissions on`)).toBe(
      false
    );
  });

  it('unsent text, also on a second line, is a draft', () => {
    expect(hasPromptDraft(fixture('prompt-draft.txt'))).toBe(true);
    expect(hasPromptDraft(`${RULE}\n❯ \n  more\n${RULE}`)).toBe(true);
  });

  it('a menu, a busy screen or contents without the box tell nothing', () => {
    expect(hasPromptDraft(fixture('trust-folder.txt'))).toBe(false);
    expect(hasPromptDraft('$ ls\nfile\n')).toBe(false);
    expect(hasPromptDraft(undefined)).toBe(false);
  });

  it('the older box with ">"', () => {
    expect(hasPromptDraft(fixture('busy.txt'))).toBe(false);
    expect(hasPromptDraft(`╭${'─'.repeat(30)}╮\n│ > hello      │\n╰${'─'.repeat(30)}╯`)).toBe(true);
  });
});

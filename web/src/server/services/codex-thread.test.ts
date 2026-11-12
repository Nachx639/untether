import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { parseProcessTable } from './claude-chat.js';
import { CODEX_INLINE_FLAG } from './codex-process.js';
import {
  carriedCodexArgs,
  codexExitHint,
  codexIdFromRollout,
  codexResumeCommand,
  codexThreadExists,
  codexThreadIsSure,
  codexThreadName,
  codexThreadTitle,
  liveCodexThreadPid,
  readCodexExitHint,
  recordCodexThreads,
  startsCodex,
} from './codex-thread.js';

const THREAD = '01a1c497-b56f-7ba1-9bc9-8fb6315bfb28';
const OTHER = '01a1c204-7c19-7253-aa06-1baf548cd87a';

describe('codexIdFromRollout', () => {
  it('reads the thread id from a rollout file name', () => {
    expect(
      codexIdFromRollout(
        '/h/.codex/sessions/2026/10/02/rollout-2026-10-02T10-00-00-0199A1B2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl'
      )
    ).toBe('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
    expect(codexIdFromRollout(null)).toBeNull();
    expect(codexIdFromRollout('/h/.codex/history.jsonl')).toBeNull();
  });
});

describe('startsCodex', () => {
  it('is a command whose program is Codex, not a shell around it', () => {
    expect(startsCodex(['codex'])).toBe(true);
    expect(startsCodex(['/opt/homebrew/bin/codex', '--yolo'])).toBe(true);
    expect(startsCodex(['zsh', '-lc', 'codex'])).toBe(false);
    expect(startsCodex(['claude'])).toBe(false);
    expect(startsCodex(undefined)).toBe(false);
  });
});

describe('carriedCodexArgs', () => {
  it('keeps the options, with their values, in their order', () => {
    expect(
      carriedCodexArgs([
        CODEX_INLINE_FLAG,
        '-m',
        'gpt-6',
        '-c',
        'model_reasoning_effort="high"',
        '--sandbox=workspace-write',
        '-a',
        'never',
        '--search',
        '--add-dir',
        '/tmp/with space',
        '-C',
        '/work',
        '--dangerously-bypass-approvals-and-sandbox',
      ])
    ).toEqual([
      CODEX_INLINE_FLAG,
      '-m',
      'gpt-6',
      '-c',
      'model_reasoning_effort="high"',
      '--sandbox=workspace-write',
      '-a',
      'never',
      '--search',
      '--add-dir',
      '/tmp/with space',
      '-C',
      '/work',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('drops the prompt, its images and what picks another conversation', () => {
    expect(carriedCodexArgs(['--yolo', 'fix the tests'])).toEqual(['--yolo']);
    expect(carriedCodexArgs(['-i', 'a.png', 'b.png', '--search', 'what is this'])).toEqual([
      '--search',
    ]);
    expect(carriedCodexArgs(['resume', '--last', '--all', '-m', 'o3'])).toEqual(['-m', 'o3']);
    expect(carriedCodexArgs(['--worktree', 'feature', '--oss'])).toEqual(['--oss']);
    expect(carriedCodexArgs(['--search', '--', '--not-a-flag'])).toEqual(['--search']);
  });

  it('drops the subcommand and the thread it had', () => {
    expect(carriedCodexArgs(['resume', CODEX_INLINE_FLAG, THREAD, '--yolo'])).toEqual([
      CODEX_INLINE_FLAG,
      '--yolo',
    ]);
    expect(carriedCodexArgs(['--search', 'fork', THREAD])).toEqual(['--search']);
  });

  it('keeps an option it does not know with its value, never the thread as one', () => {
    expect(carriedCodexArgs(['--some-new-option', 'value', 'the prompt'])).toEqual([
      '--some-new-option',
      'value',
    ]);
    expect(carriedCodexArgs(['--some-new-flag', 'resume', THREAD])).toEqual(['--some-new-flag']);
  });
});

describe('codexResumeCommand', () => {
  it('goes on with the same executable and options', () => {
    expect(
      codexResumeCommand(
        ['/opt/homebrew/bin/codex', CODEX_INLINE_FLAG, '-m', 'gpt-6', 'hi'],
        THREAD
      )
    ).toEqual(['/opt/homebrew/bin/codex', 'resume', THREAD, CODEX_INLINE_FLAG, '-m', 'gpt-6']);
  });

  it('resumes a resumed session once, on the thread asked for', () => {
    expect(codexResumeCommand(['codex', 'resume', CODEX_INLINE_FLAG, OTHER], THREAD)).toEqual([
      'codex',
      'resume',
      THREAD,
      CODEX_INLINE_FLAG,
    ]);
  });
});

describe('thread names and titles', () => {
  let codexDir: string;
  let dayDir: string;

  beforeEach(() => {
    codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-test-'));
    dayDir = path.join(codexDir, 'sessions', '2026', '11', '09');
    fs.mkdirSync(dayDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(codexDir, RM_TEST_DIR);
  });

  const index = (...entries: Array<Record<string, unknown> | string>) =>
    fs.writeFileSync(
      path.join(codexDir, 'session_index.jsonl'),
      `${entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n')}\n`
    );
  const rollout = (threadId: string, prompt?: string) =>
    fs.writeFileSync(
      path.join(dayDir, `rollout-2026-11-09T20-34-02-${threadId}.jsonl`),
      `${[
        JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: '/p' } }),
        ...(prompt
          ? [
              JSON.stringify({
                timestamp: '2026-11-09T19:34:03.000Z',
                type: 'response_item',
                payload: {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: prompt }],
                },
              }),
            ]
          : []),
      ].join('\n')}\n`
    );

  // The format Codex 0.164 writes (a real line of ~/.codex/session_index.jsonl, 2026-11-09).
  it('reads thread_name from session_index.jsonl, the last entry of a thread', () => {
    index(
      {
        id: OTHER,
        thread_name: 'Implementa estilo cyber-hacker',
        updated_at: '2026-11-09T20:34:02.98621Z',
      },
      { id: THREAD, thread_name: 'Primer nombre', updated_at: '2026-11-10T08:00:00Z' },
      '{"id": "half a line',
      {
        id: THREAD,
        thread_name: 'Nombre del laboratorio',
        updated_at: '2026-11-10T08:34:09.41852Z',
      }
    );
    expect(codexThreadName(THREAD, codexDir)).toBe('Nombre del laboratorio');
    expect(codexThreadName(OTHER.toUpperCase(), codexDir)).toBe('Implementa estilo cyber-hacker');
    expect(codexThreadName('01a1c228-cc81-77b0-a4b5-73234484ee65', codexDir)).toBeUndefined();
  });

  it('sees a rename made since the last read', () => {
    index({ id: THREAD, thread_name: 'Antes' });
    expect(codexThreadName(THREAD, codexDir)).toBe('Antes');
    index({ id: THREAD, thread_name: 'Antes' }, { id: THREAD, thread_name: 'Después, más largo' });
    expect(codexThreadName(THREAD, codexDir)).toBe('Después, más largo');
  });

  it('titles a thread with its name, else its first prompt, else nothing', () => {
    rollout(THREAD, 'hola primer mensaje del laboratorio');
    rollout(OTHER);
    expect(codexThreadTitle(THREAD, codexDir)).toBe('hola primer mensaje del laboratorio');
    expect(codexThreadTitle(OTHER, codexDir)).toBeUndefined();
    index({ id: THREAD, thread_name: 'Nombre del laboratorio' });
    expect(codexThreadTitle(THREAD, codexDir)).toBe('Nombre del laboratorio');
    // No index at all (a Codex that never named a thread).
    fs.rmSync(path.join(codexDir, 'session_index.jsonl'));
    expect(codexThreadTitle(THREAD, codexDir)).toBe('hola primer mensaje del laboratorio');
  });

  it('knows whether a thread is still there to resume', () => {
    rollout(THREAD, 'x');
    expect(codexThreadExists(THREAD, codexDir)).toBe(true);
    expect(codexThreadExists(OTHER, codexDir)).toBe(false);
  });
});

describe('liveCodexThreadPid', () => {
  const NATIVE =
    '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
  // As `ps` showed the lab's resumed Codex (2026-11-10), next to a new one and the daemon.
  const table = async () =>
    parseProcessTable(
      [
        '    1     0 Tue Nov 10 09:00:00 2026     /sbin/launchd',
        `  500     1 Tue Nov 10 09:34:20 2026     node /opt/homebrew/bin/codex resume ${CODEX_INLINE_FLAG} ${THREAD}`,
        `  501   500 Tue Nov 10 09:34:21 2026     ${NATIVE} resume ${CODEX_INLINE_FLAG} ${THREAD}`,
        `  600     1 Tue Nov 10 09:20:00 2026     ${NATIVE} ${CODEX_INLINE_FLAG}`,
        '  700     1 Tue Nov 10 09:10:00 2026     /h/.codex/packages/app-server-daemon/releases/0.164.0/bin/codex app-server --listen unix://',
        `  800     1 Tue Nov 10 09:10:00 2026     /usr/bin/vim resume ${OTHER}`,
        '',
      ].join('\n')
    );

  const none = { table, cwdOf: async () => null, codexDir: () => '/nowhere' };

  it('finds a Codex started as a resume of the thread', async () => {
    expect(await liveCodexThreadPid(THREAD, none)).toBe(500);
    expect(await liveCodexThreadPid(THREAD.toUpperCase(), none)).toBe(500);
  });

  it('is nothing for a thread no Codex resumed', async () => {
    expect(await liveCodexThreadPid(OTHER, none)).toBeNull();
  });

  // 2026-11-10 review: a Codex started without `resume` that made the thread and still runs.
  describe('the Codex that made the thread', () => {
    let codexDir: string;
    beforeEach(() => {
      codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-test-'));
      const dayDir = path.join(codexDir, 'sessions', '2026', '11', '10');
      fs.mkdirSync(dayDir, { recursive: true });
      // Made 4 s after process 600 started (09:20:00 UTC), in /work.
      const meta = { id: OTHER, timestamp: '2026-11-10T09:20:04.000Z', cwd: '/work' };
      fs.writeFileSync(
        path.join(dayDir, `rollout-2026-11-10T09-20-04-${OTHER}.jsonl`),
        `${JSON.stringify({ type: 'session_meta', payload: meta })}\n`
      );
    });
    afterEach(() => fs.rmSync(codexDir, RM_TEST_DIR));

    it("counts while it runs in the thread's folder", async () => {
      const cwdOf = vi.fn(async () => '/work');
      expect(await liveCodexThreadPid(OTHER, { table, cwdOf, codexDir: () => codexDir })).toBe(600);
      // Only the Codex started around then was asked for its folder.
      expect(cwdOf.mock.calls).toEqual([[600]]);
    });

    it('does not in another folder, nor one started at another time', async () => {
      const elsewhere = { table, cwdOf: async () => '/else', codexDir: () => codexDir };
      expect(await liveCodexThreadPid(OTHER, elsewhere)).toBeNull();
      const later = async () =>
        parseProcessTable(
          `  600     1 Tue Nov 10 09:25:00 2026     ${NATIVE} ${CODEX_INLINE_FLAG}\n`
        );
      const startedLater = { table: later, cwdOf: async () => '/work', codexDir: () => codexDir };
      expect(await liveCodexThreadPid(OTHER, startedLater)).toBeNull();
    });
  });
});

describe('codexExitHint', () => {
  // The end of a real recording: Codex 0.164 quitting with /quit on the twin (2026-11-10).
  const tail =
    '[156.243,"o","\\u001b[<1u\\u001b[<u\\u001b[>4;0m\\u001b[?2004l"]\n' +
    '[156.247,"o","Disconnected from this task. Any running work continues.\\r\\nTo reconnect, run:\\r\\n  \\u001b[36mcodex resume 01a1c4a4-e469-74f2-9628-53dedc274516\\u001b[39m\\r\\nStop the current turn: run \\u001b[36mcodex agents\\u001b[39m, select this task, and press x.\\r\\nToken usage so far: total=15 input=10 output=5\\r\\n"]\n' +
    '["exit",0,"1a309897-e39d-4671-a204-7569f3754013"]\n';

  it('reads the thread Codex names as it quits', () => {
    expect(codexExitHint(tail)).toBe('01a1c4a4-e469-74f2-9628-53dedc274516');
    // An older wording.
    expect(
      codexExitHint(`To continue this session, run codex resume ${THREAD.toUpperCase()}`)
    ).toBe(THREAD);
  });

  it('reads it past the colours and line breaks the recording carries in between', () => {
    const styled = `To reconnect, run:\\r\\n\\r\\n  \\u001b[1m\\u001b[38;2;171;223;167m\\u001b[48;2;30;30;30m\\u001b[4mcodex resume ${THREAD}\\u001b[0m`;
    expect(codexExitHint(styled)).toBe(THREAD);
  });

  it('takes the last one: what the conversation said before is not its word', () => {
    expect(codexExitHint(`try codex resume ${OTHER} some day\n${tail}`)).toBe(
      '01a1c4a4-e469-74f2-9628-53dedc274516'
    );
  });

  it('is nothing for a Codex that was killed (it says nothing), or a name', () => {
    expect(codexExitHint('[0.746,"o","\\u001b[?2026h"]\n["exit",0,"5b1906c2"]\n')).toBeNull();
    expect(codexExitHint('To reconnect, run: codex resume my-thread')).toBeNull();
  });

  // 2026-11-10 review: any "codex resume <id>" in the last output was taken as Codex's word.
  it("is nothing for the command alone: a command's output, or the conversation", () => {
    const listed = `[5,"o","$ history\\r\\n  codex resume ${OTHER}\\r\\n"]\n["exit",0,"x"]\n`;
    expect(codexExitHint(listed)).toBeNull();
    expect(codexExitHint(`[5,"o","you can run codex resume ${OTHER} later"]\n`)).toBeNull();
  });

  it('is nothing when more was printed after it: the session went on and was killed later', () => {
    const quoted = `[5,"o","To reconnect, run:\\r\\n  codex resume ${OTHER}\\r\\n"]\n`;
    const wentOn = `${quoted}[6,"o","more"]\n[7,"o","and more"]\n["exit",0,"x"]\n`;
    expect(codexExitHint(wentOn)).toBeNull();
    expect(codexExitHint(`${quoted}[6,"o","${'x'.repeat(700)}"]\n`)).toBeNull();
  });

  it('reads the end of a recording file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hint-test-'));
    try {
      const file = path.join(dir, 'stdout');
      fs.writeFileSync(file, `${'x'.repeat(64 * 1024)}\n${tail}`);
      expect(readCodexExitHint(file)).toBe('01a1c4a4-e469-74f2-9628-53dedc274516');
      expect(readCodexExitHint(path.join(dir, 'gone'))).toBeNull();
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });
});

describe('codexThreadIsSure (Blindar ends a Codex only for a thread that is sure)', () => {
  const session = (id: string, extra: Partial<Session> = {}): Session =>
    ({
      id,
      command: ['codex'],
      workingDir: '/p',
      startedAt: '2026-11-10T08:00:00.000Z',
      status: 'running',
      ...extra,
    }) as Session;
  const refOf = async (s: Session) =>
    s.command[0] === 'zsh' ? null : { id: s.id, workingDir: s.workingDir, startedAt: s.startedAt };

  it('is sure of the thread its command resumes, whoever else runs there', async () => {
    const resumed = session('s', { command: ['codex', 'resume', THREAD], codexThreadId: THREAD });
    expect(await codexThreadIsSure(resumed, [resumed, session('other')], refOf)).toBe(true);
  });

  it('is sure of the only Codex of its folder', async () => {
    const alone = session('s', { codexThreadId: THREAD });
    const others = [
      alone,
      session('elsewhere', { workingDir: '/q' }),
      session('shell', { command: ['zsh'] }),
      session('ended', { status: 'exited' }),
    ];
    expect(await codexThreadIsSure(alone, others, refOf)).toBe(true);
  });

  it('is not sure with another Codex running in the folder, nor without a thread', async () => {
    const guess = session('s', { codexThreadId: THREAD });
    expect(await codexThreadIsSure(guess, [guess, session('rival')], refOf)).toBe(false);
    expect(await codexThreadIsSure(session('none'), [], refOf)).toBe(false);
  });
});

describe('recordCodexThreads', () => {
  const session = (id: string, extra: Partial<Session> = {}): Session =>
    ({
      id,
      command: ['codex'],
      workingDir: '/p',
      startedAt: '2026-11-10T08:00:00.000Z',
      status: 'running',
      ...extra,
    }) as Session;
  const rolloutOf = (threadId: string) =>
    `/h/.codex/sessions/2026/11/10/rollout-x-${threadId}.jsonl`;
  const refOf = async (s: Session) => ({
    id: s.id,
    workingDir: s.workingDir,
    startedAt: s.startedAt,
  });

  it('records the thread of each running Codex, shielded or not, typed in a shell or not', async () => {
    const save = vi.fn();
    const sessions = [
      session('direct', { workingDir: '/a' }),
      session('shell', { command: ['zsh'], workingDir: '/b', shielded: true }),
      session('no-codex', { command: ['zsh'] }),
      session('ended', { status: 'exited' }),
    ];
    const saved = await recordCodexThreads({
      listSessions: () => sessions,
      rootPid: () => 1,
      save,
      ref: async (s) => (s.id === 'no-codex' ? null : refOf(s)),
      match: (ref) => (ref.id === 'direct' ? rolloutOf(THREAD) : rolloutOf(OTHER)),
    });
    expect(saved).toBe(2);
    expect(save.mock.calls).toEqual([
      ['direct', THREAD],
      ['shell', OTHER],
    ]);
  });

  it('takes the thread a resume names, without looking for a rollout', async () => {
    const save = vi.fn();
    const match = vi.fn(() => rolloutOf(OTHER));
    await recordCodexThreads({
      listSessions: () => [session('resumed')],
      rootPid: () => 1,
      save,
      ref: async (s) => ({ ...(await refOf(s)), resumedThreadId: THREAD }),
      match,
    });
    expect(save).toHaveBeenCalledWith('resumed', THREAD);
    expect(match).not.toHaveBeenCalled();
  });

  it('follows a new thread in the same session (/new) and saves nothing when it is the same', async () => {
    const save = vi.fn();
    const options = (threadId: string) => ({
      listSessions: () => [session('s', { codexThreadId: THREAD })],
      rootPid: () => 1,
      save,
      ref: refOf,
      match: () => rolloutOf(threadId),
    });
    expect(await recordCodexThreads(options(THREAD))).toBe(0);
    expect(await recordCodexThreads(options(OTHER))).toBe(1);
    expect(save.mock.calls).toEqual([['s', OTHER]]);
  });

  it('keeps what a session has when its Codex shows no rollout (yet, or any more)', async () => {
    const save = vi.fn();
    await recordCodexThreads({
      listSessions: () => [session('s', { codexThreadId: THREAD })],
      rootPid: () => 1,
      save,
      ref: refOf,
      match: () => null,
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('tells the matcher when the other Codex of the folder started, and the threads taken', async () => {
    const seen: Record<string, { rivals: number[]; taken: string[] }> = {};
    await recordCodexThreads({
      listSessions: () => [
        session('a', { startedAt: '2026-11-10T08:48:06.000Z' }),
        session('b', { startedAt: '2026-11-10T08:48:22.000Z' }),
        // Another folder, and a resumed one (its thread is known): no rivals of a and b.
        session('elsewhere', { workingDir: '/q' }),
        session('resumed', { command: ['codex', 'resume', OTHER] }),
        // An ended session's thread stays its own.
        session('ended', { status: 'exited', codexThreadId: THREAD }),
      ],
      rootPid: () => 1,
      save: vi.fn(),
      ref: async (s) => ({
        ...(await refOf(s)),
        ...(s.id === 'resumed' ? { resumedThreadId: OTHER } : {}),
      }),
      match: (ref, rivals, taken) => {
        seen[ref.id] = { rivals, taken: [...taken] };
        return null;
      },
    });
    expect(seen).toEqual({
      a: { rivals: [Date.parse('2026-11-10T08:48:22.000Z')], taken: [THREAD] },
      b: { rivals: [Date.parse('2026-11-10T08:48:06.000Z')], taken: [THREAD] },
      elsewhere: { rivals: [], taken: [THREAD] },
    });
  });

  // Seen on the twin (2026-11-10): two Codex in one folder, the older idle. The newest rollout
  // since each start is the same for both; the idle one took the other's conversation.
  describe('two Codex in one folder, against real rollouts', () => {
    let codexHome: string;
    let previous: string | undefined;
    const A = '01a1c4a4-b43b-7fe0-93d7-266c42fee5d2';
    const B = '01a1c4a4-e469-74f2-9628-53dedc274516';

    beforeEach(() => {
      codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rivals-test-'));
      previous = process.env.CODEX_HOME;
      process.env.CODEX_HOME = codexHome;
    });
    afterEach(() => {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      fs.rmSync(codexHome, RM_TEST_DIR);
    });
    const rollout = (threadId: string, createdAt: string, cwd = '/p') => {
      const dayDir = path.join(codexHome, 'sessions', '2026', '11', '10');
      fs.mkdirSync(dayDir, { recursive: true });
      fs.writeFileSync(
        path.join(dayDir, `rollout-${createdAt.slice(0, 19).replace(/:/g, '-')}-${threadId}.jsonl`),
        `${JSON.stringify({ type: 'session_meta', payload: { id: threadId, timestamp: createdAt, cwd } })}\n`
      );
    };
    const look = (sessions: Session[]) => {
      const save = vi.fn();
      return recordCodexThreads({
        listSessions: () => sessions,
        rootPid: () => 1,
        save,
        ref: refOf,
      }).then(() => save.mock.calls);
    };
    const idle = () => session('idle', { startedAt: '2026-11-10T08:48:06.000Z' });
    const busy = () => session('busy', { startedAt: '2026-11-10T08:48:22.000Z' });

    it('gives the conversation to the Codex that started just before it, never the idle one', async () => {
      rollout(B, '2026-11-10T08:48:23.145Z');
      expect(await look([idle(), busy()])).toEqual([['busy', B]]);
      expect(await look([busy(), idle()])).toEqual([['busy', B]]);
    });

    it('gives each its own once both have one', async () => {
      rollout(A, '2026-11-10T08:48:10.811Z');
      rollout(B, '2026-11-10T08:48:23.145Z');
      expect(await look([idle(), busy()])).toEqual([
        ['idle', A],
        ['busy', B],
      ]);
    });

    it("does not follow a /new while the other runs: it could be either one's", async () => {
      rollout(A, '2026-11-10T08:48:10.811Z');
      rollout(B, '2026-11-10T08:48:23.145Z');
      rollout(THREAD, '2026-11-10T09:30:00.000Z');
      expect(
        await look([
          { ...idle(), codexThreadId: A } as Session,
          { ...busy(), codexThreadId: B } as Session,
        ])
      ).toEqual([]);
    });

    it("alone in its folder, follows a /new and never takes an ended session's thread", async () => {
      rollout(A, '2026-11-10T08:48:10.811Z');
      rollout(B, '2026-11-10T08:48:23.145Z');
      const ended = session('busy', { status: 'exited', codexThreadId: B });
      expect(await look([idle(), ended])).toEqual([['idle', A]]);
      rollout(THREAD, '2026-11-10T09:30:00.000Z');
      expect(await look([{ ...idle(), codexThreadId: A } as Session, ended])).toEqual([
        ['idle', THREAD],
      ]);
    });
  });

  describe('what Codex said as it quit', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quit-test-'));
    });
    afterEach(() => fs.rmSync(dir, RM_TEST_DIR));
    const recording = (id: string, threadId?: string) => {
      fs.writeFileSync(
        path.join(dir, id),
        threadId
          ? `[1,"o","To reconnect, run:\\r\\n  codex resume ${threadId}\\r\\n"]\n["exit",0,"${id}"]\n`
          : `[1,"o","bye"]\n["exit",0,"${id}"]\n`
      );
    };
    const look = (sessions: Session[], hintsRead = new Set<string>()) => {
      const save = vi.fn();
      return recordCodexThreads({
        listSessions: () => sessions,
        rootPid: () => 1,
        save,
        ref: async () => null,
        recordingPath: (id) => path.join(dir, id),
        hintsRead,
      }).then(() => save.mock.calls);
    };

    it('is recorded on a session that ended, whatever was recorded before, once', async () => {
      recording('never', THREAD);
      recording('guessed', THREAD);
      recording('right', THREAD);
      recording('killed');
      const sessions = [
        session('never', { status: 'exited' }),
        session('guessed', { status: 'exited', codexThreadId: OTHER }),
        session('right', { status: 'exited', codexThreadId: THREAD }),
        session('killed', { status: 'exited', codexThreadId: OTHER }),
        // A shell's recording is not Codex's word.
        session('shell', { status: 'exited', command: ['zsh'] }),
      ];
      recording('shell', THREAD);
      const hintsRead = new Set<string>();
      expect(await look(sessions, hintsRead)).toEqual([
        ['never', THREAD],
        ['guessed', THREAD],
      ]);
      // Read once per session.
      expect(await look(sessions, hintsRead)).toEqual([]);
    });

    it('takes the thread back from a running session that had it by its rollout', async () => {
      recording('ended', THREAD);
      expect(
        await look([
          session('guesser', { codexThreadId: THREAD }),
          session('ended', { status: 'exited' }),
        ])
      ).toEqual([
        ['guesser', undefined],
        ['ended', THREAD],
      ]);
    });
  });

  it('goes on with the other sessions when one look fails', async () => {
    const save = vi.fn();
    await recordCodexThreads({
      listSessions: () => [
        session('broken', { workingDir: '/a' }),
        session('fine', { workingDir: '/b' }),
      ],
      rootPid: () => 1,
      save,
      ref: async (s) => {
        if (s.id === 'broken') throw new Error('ps failed');
        return refOf(s);
      },
      match: () => rolloutOf(THREAD),
    });
    expect(save.mock.calls).toEqual([['fine', THREAD]]);
  });
});

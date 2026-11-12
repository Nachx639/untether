import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { parseProcessTable } from './claude-chat.js';
import { readCodexChat } from './codex-chat.js';
import {
  CODEX_INLINE_FLAG,
  type CodexProcessDeps,
  codexInlineCommand,
  codexResumeTarget,
  codexSessionRef,
  findCodexPid,
  isCodexProcessArgs,
  parseUtcStart,
} from './codex-process.js';

const NVM = '/Users/me/.nvm/versions/node/v24.21.0';
const NATIVE = `${NVM}/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex`;

// What `TZ=UTC ps -A -o pid=,ppid=,lstart=,args=` shows for `codex` typed in an Untether zsh.
const PS = [
  '    1     0 Fri Oct  2 09:00:00 2026     /sbin/launchd',
  '  100     1 Fri Oct  2 09:59:00 2026     /usr/local/bin/untether fwd zsh',
  '  200   100 Fri Oct  2 09:59:01 2026     -zsh',
  `  300   200 Fri Oct  2 10:00:20 2026     node ${NVM}/bin/codex --model gpt-5`,
  `  301   300 Fri Oct  2 10:00:21 2026     ${NATIVE} --model gpt-5`,
  '  400     1 Fri Oct  2 09:30:00 2026     /bin/zsh -il',
  '  401   400 Fri Oct  2 09:30:05 2026     /usr/bin/vim notes.md',
  '',
].join('\n');

describe('codexInlineCommand', () => {
  const FLAG = CODEX_INLINE_FLAG;

  it('runs the TUI inline, the flag right after the program', () => {
    expect(codexInlineCommand(['codex'])).toEqual(['codex', FLAG]);
    expect(codexInlineCommand(['/opt/bin/codex', '--yolo', 'fix it'])).toEqual([
      '/opt/bin/codex',
      FLAG,
      '--yolo',
      'fix it',
    ]);
    expect(codexInlineCommand(['env', 'A=1', 'codex', '-m', 'o4'])).toEqual([
      'env',
      'A=1',
      'codex',
      FLAG,
      '-m',
      'o4',
    ]);
  });

  it('gives resume and fork the flag themselves (their own option)', () => {
    expect(codexInlineCommand(['codex', 'resume', 'abc', '--yolo'])).toEqual([
      'codex',
      'resume',
      FLAG,
      'abc',
      '--yolo',
    ]);
    expect(codexInlineCommand(['codex', '-c', 'a=b', 'fork', 'abc'])).toEqual([
      'codex',
      '-c',
      'a=b',
      'fork',
      FLAG,
      'abc',
    ]);
    // A prompt that merely starts with the word is a prompt.
    expect(codexInlineCommand(['codex', 'resume the work'])).toEqual([
      'codex',
      FLAG,
      'resume the work',
    ]);
  });

  it('adds it once, and leaves everything else alone', () => {
    const inline = ['codex', FLAG, '--yolo'];
    expect(codexInlineCommand(inline)).toBe(inline);
    for (const command of [
      ['codex', 'exec', 'summarize'],
      ['codex', '-m', 'o3', 'exec', 'x'],
      ['codex', 'login'],
      ['codex', 'app-server'],
      ['codex', '--version'],
      ['claude', '--resume', 'abc'],
      ['zsh', '-l', '-i'],
      ['zsh', '-lc', 'cd ~/app && exec codex'],
    ]) {
      expect(codexInlineCommand(command)).toBe(command);
    }
  });

  // A new way of starting a session that resolved its command itself would run Codex on the
  // alternate screen again, with nothing to scroll (user report, 2026-11-09).
  it('is the only way a session command is resolved', () => {
    const serverDir = path.resolve(__dirname, '..');
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/(?<!\.test)\.ts$/.test(entry.name)) {
          const uses = fs.readFileSync(file, 'utf8').match(/\bresolveCommand\(/g)?.length ?? 0;
          if (uses) callers.push(`${path.relative(serverDir, file)}: ${uses}`);
        }
      }
    };
    walk(serverDir);
    expect(callers.sort()).toEqual([
      'pty/process-utils.ts: 1', // its definition
      'pty/pty-manager/state.ts: 1', // PtyManager.resolveSpawn
    ]);
    const state = fs.readFileSync(path.join(serverDir, 'pty/pty-manager/state.ts'), 'utf8');
    expect(state).toContain('ProcessUtils.resolveCommand(codexInlineCommand(command))');
    // A shielded session is created without PtyManager.createSession's own resolving only by
    // restoring or waking it: both use resolveSpawn too.
    const shield = fs.readFileSync(path.join(serverDir, 'pty/pty-manager/shield.ts'), 'utf8');
    expect(shield.match(/this\.resolveSpawn\(/g)).toHaveLength(2);
    expect(shield.match(/this\.spawnCommand\(/g)).toHaveLength(2);
  });
});

describe('isCodexProcessArgs', () => {
  it('spots the npm launcher and the native binary', () => {
    expect(isCodexProcessArgs(`node ${NVM}/bin/codex`)).toBe(true);
    expect(isCodexProcessArgs(`/opt/homebrew/bin/node --no-warnings ${NVM}/bin/codex`)).toBe(true);
    expect(
      isCodexProcessArgs(`node ${NVM}/lib/node_modules/@openai/codex/bin/codex.js resume`)
    ).toBe(true);
    expect(isCodexProcessArgs(`${NATIVE} "fix the tests"`)).toBe(true);
    expect(isCodexProcessArgs('codex')).toBe(true);
  });

  it('ignores other programs and Codex runs without a TUI', () => {
    expect(isCodexProcessArgs('node server.js')).toBe(false);
    expect(isCodexProcessArgs('/usr/bin/vim codex')).toBe(false);
    expect(isCodexProcessArgs('-zsh')).toBe(false);
    expect(isCodexProcessArgs('codex exec "summarize"')).toBe(false);
    expect(isCodexProcessArgs(`${NATIVE} app-server`)).toBe(false);
    expect(isCodexProcessArgs('codex --version')).toBe(false);
    expect(isCodexProcessArgs('codex-helper')).toBe(false);
  });

  it('skips option values when looking for the subcommand', () => {
    expect(isCodexProcessArgs('codex -m o3 exec "summarize"')).toBe(false);
    expect(isCodexProcessArgs(`${NATIVE} -c model=o3 --cd /repo exec x`)).toBe(false);
    expect(isCodexProcessArgs(`node ${NVM}/bin/codex -p work -s read-only app-server`)).toBe(false);
    // A value that happens to be a subcommand name is still just a value.
    expect(isCodexProcessArgs('codex -m exec')).toBe(true);
    expect(isCodexProcessArgs('codex -m o3 "fix the tests"')).toBe(true);
    expect(isCodexProcessArgs('codex --oss --model=o3 resume')).toBe(true);
    expect(isCodexProcessArgs('codex -a never -i shot.png')).toBe(true);
  });
});

describe('findCodexPid', () => {
  it('finds the launcher among the descendants of the session process', () => {
    const table = parseProcessTable(PS);
    expect(findCodexPid(table, 100)).toBe(300);
    expect(findCodexPid(table, 301)).toBe(301);
    expect(findCodexPid(table, 400)).toBeUndefined();
    expect(table.starts.get(300)).toBe('Fri Oct 2 10:00:20 2026');
    expect(parseUtcStart(table.starts.get(300))).toBe(Date.UTC(2026, 9, 2, 10, 0, 20));
  });
});

describe('codexSessionRef', () => {
  let codexDir: string;
  let dayDir: string;
  let cwdLookups: number[];
  const projectDir = '/Users/me/project';
  const deps = (ps = PS): CodexProcessDeps => ({
    table: async () => parseProcessTable(ps),
    cwdOf: async (pid) => {
      cwdLookups.push(pid);
      return projectDir;
    },
  });
  const at = (sec: number) => new Date(Date.UTC(2026, 9, 2, 10, 0, sec)).toISOString();
  const shell = {
    id: 'shell-session',
    command: ['zsh'],
    workingDir: '/Users/me',
    startedAt: at(-61),
    pid: 100,
    status: 'running',
  };
  // The launcher (pid 300) started at 10:00:20: its rollout is claimed under the process.
  const codexClaim = `proc:300:${Date.UTC(2026, 9, 2, 10, 0, 20)}`;

  beforeEach(() => {
    cwdLookups = [];
    codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-process-test-'));
    const day = new Date(at(0));
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

  const rollout = (name: string, cwd: string, startedAt: string, prompt: string) =>
    fs.writeFileSync(
      path.join(dayDir, `rollout-${name}.jsonl`),
      `${[
        JSON.stringify({
          timestamp: startedAt,
          type: 'session_meta',
          payload: { id: name, timestamp: startedAt, cwd },
        }),
        JSON.stringify({
          timestamp: startedAt,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: prompt }],
          },
        }),
      ].join('\n')}\n`
    );

  it('uses the cwd and start of the Codex typed in a shell to find its rollout', async () => {
    rollout('earlier-run', projectDir, at(-120), 'an earlier Codex run');
    rollout('this-run', projectDir, at(25), 'fix the login page');
    const ref = await codexSessionRef(shell, deps());
    expect(ref).toEqual({ id: codexClaim, workingDir: projectDir, startedAt: at(20) });
    const chat = readCodexChat(ref as NonNullable<typeof ref>, codexDir);
    expect(chat.agent).toBe('codex');
    expect(chat.title).toBe('fix the login page');
    // The cwd is looked up once per process.
    await codexSessionRef(shell, deps());
    expect(cwdLookups).toEqual([300]);
  });

  it('is nothing for a shell without Codex or a session that exited', async () => {
    expect(await codexSessionRef({ ...shell, pid: 400 }, deps())).toBeNull();
    expect(await codexSessionRef({ ...shell, status: 'exited' }, deps())).toBeNull();
    expect(cwdLookups).toEqual([]);
  });

  it('keeps sessions started with codex as they are', async () => {
    const direct = { ...shell, command: ['codex'] };
    expect(await codexSessionRef(direct, deps())).toBe(direct);
  });

  it('gives every reader of one Codex process the same rollout', async () => {
    // A session attached to a tmux session and the Mac list's read of that pane: two readers,
    // one process. Claimed per reader, the second found the rollout taken and showed nothing.
    rollout('this-run', projectDir, at(25), 'fix the login page');
    const attached = await codexSessionRef({ ...shell, id: 'attached-session' }, deps());
    const paneRead = await codexSessionRef(
      { id: 'mac:p-1-2-3', workingDir: '/', startedAt: at(0), pid: 300, status: 'running' },
      deps()
    );
    expect(attached?.id).toBe(codexClaim);
    expect(paneRead?.id).toBe(codexClaim);
    for (const ref of [attached, paneRead]) {
      expect(readCodexChat(ref as NonNullable<typeof ref>, codexDir).title).toBe(
        'fix the login page'
      );
    }
  });

  it('never takes an attached tmux session for Codex by its command line', async () => {
    // `tmux -L codex attach`: the socket's name is the last word of an argument.
    const attached = {
      ...shell,
      id: 'attached-session',
      command: ['/usr/bin/tmux', '-u', '-N', '-S', '/tmp/tmux-501/codex', 'attach-session'],
      multiplexer: {
        type: 'tmux' as const,
        socketPath: '/tmp/tmux-501/codex',
        serverPid: 90,
        serverStartedAt: 1_790_000_000,
        sessionId: '$0',
        sessionName: '0',
        mode: 'control' as const,
        sizing: 'others' as const,
        source: 'mac-sessions' as const,
      },
    };
    // Its pid is the pane's program: Codex only when one runs there.
    expect(await codexSessionRef({ ...attached, pid: 400 }, deps())).toBeNull();
    expect((await codexSessionRef({ ...attached, pid: 200 }, deps()))?.id).toBe(codexClaim);
  });
});

describe('codexResumeTarget (2026-11-10)', () => {
  const thread = '01a1c497-b56f-7ba1-9bc9-8fb6315bfb28';

  it('reads the thread a command resumes, wherever the options are', () => {
    expect(codexResumeTarget(['codex', 'resume', thread])).toBe(thread);
    // What a session records: the resolved path, inline.
    expect(
      codexResumeTarget(['/opt/homebrew/bin/codex', 'resume', CODEX_INLINE_FLAG, thread])
    ).toBe(thread);
    expect(
      codexResumeTarget([
        'codex',
        '-m',
        'gpt-6',
        'resume',
        '-c',
        'a=b',
        thread,
        '--search',
        'go on',
      ])
    ).toBe(thread);
    expect(
      codexResumeTarget(['env', 'CODEX_HOME=/x', 'codex', 'resume', thread.toUpperCase()])
    ).toBe(thread);
  });

  it('reads it from a `ps` line of the npm launcher and of the native binary', () => {
    const words = (args: string) => args.split(/\s+/);
    expect(
      codexResumeTarget(words(`node ${NVM}/bin/codex resume ${CODEX_INLINE_FLAG} ${thread}`))
    ).toBe(thread);
    expect(codexResumeTarget(words(`${NATIVE} resume ${thread}`))).toBe(thread);
  });

  it('is nothing for a new Codex, a picker, a name, or another program', () => {
    expect(codexResumeTarget(['codex'])).toBeNull();
    expect(codexResumeTarget(['codex', 'resume'])).toBeNull();
    expect(codexResumeTarget(['codex', 'resume', '--last'])).toBeNull();
    // `codex resume <name>`: Codex decides which thread that is, not Untether.
    expect(codexResumeTarget(['codex', 'resume', 'my-thread'])).toBeNull();
    // A prompt that happens to say "resume".
    expect(codexResumeTarget(['codex', 'exec', 'resume', thread])).toBeNull();
    expect(codexResumeTarget(['claude', '--resume', thread])).toBeNull();
    expect(codexResumeTarget(['zsh', '-lc', `codex resume ${thread}`])).toBeNull();
    expect(codexResumeTarget(undefined)).toBeNull();
  });
});

describe('codexSessionRef of a resumed Codex (2026-11-10)', () => {
  const thread = '01a1c497-b56f-7ba1-9bc9-8fb6315bfb28';
  const at = (sec: number) => new Date(Date.UTC(2026, 9, 2, 10, 0, sec)).toISOString();

  it('says which thread a session started as `codex resume <id>` is on', async () => {
    const direct = {
      id: 'resumed',
      command: ['/opt/homebrew/bin/codex', 'resume', CODEX_INLINE_FLAG, thread],
      workingDir: '/Users/me/project',
      startedAt: at(0),
    };
    expect(await codexSessionRef(direct)).toEqual({ ...direct, resumedThreadId: thread });
  });

  it('…and one typed in a shell', async () => {
    const ps = PS.replace(
      `node ${NVM}/bin/codex --model gpt-5`,
      `node ${NVM}/bin/codex resume ${thread}`
    );
    const ref = await codexSessionRef(
      {
        id: 'shell-session',
        command: ['zsh'],
        workingDir: '/Users/me',
        startedAt: at(-61),
        pid: 100,
        status: 'running',
      },
      { table: async () => parseProcessTable(ps), cwdOf: async () => '/Users/me/project' }
    );
    expect(ref?.resumedThreadId).toBe(thread);
  });
});

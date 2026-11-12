import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { stopTestShieldServer } from '../../test/helpers/shield-teardown.js';
import { markedTempDir } from '../../test/helpers/test-dirs.js';
import { AsciinemaWriter } from '../pty/asciinema-writer.js';
import { recordedExitCode } from '../pty/process-utils.js';
import { PtyManager } from '../pty/pty-manager.js';
import { CODEX_INLINE_FLAG } from './codex-process.js';
import {
  awaitShieldVerify,
  carriedClaudeArgs,
  classifyHasSessionError,
  findTmuxBinary,
  isFocusReport,
  isMouseInput,
  isShieldServerExiting,
  lastCastSize,
  newSessionArgs,
  parseShieldExit,
  readShieldVerify,
  runtimeVarsInEnvironment,
  SHIELD_EXIT_HOOK,
  SHIELD_PREFLIGHT_SCRIPT,
  SHIELD_RESTORE_LIMIT,
  SHIELD_SERVER_OPTIONS,
  ShieldTmux,
  shieldAppliedLine,
  shieldClientEndReason,
  shieldEnvFileContent,
  shieldExitCommands,
  shieldExitFile,
  shieldLaunchdLabel,
  shieldLaunchdPlist,
  shieldPreflightCommand,
  shieldReopenPlan,
  shieldRestorePlan,
  shieldScrollsTmuxHistory,
  shieldSocketArgs,
  shieldStartupAction,
  shieldUsesLaunchd,
  tmuxEnv,
} from './shielded-tmux.js';
import { setShuttingDown } from './shutdown-state.js';

describe('shield tmux server under launchd (macOS)', () => {
  it('is used on macOS, not on Linux, never by tests unless asked, and can be turned off', () => {
    expect(shieldUsesLaunchd({}, 'darwin')).toBe(true);
    expect(shieldUsesLaunchd({}, 'linux')).toBe(false);
    expect(shieldUsesLaunchd({ VITEST: 'true' }, 'darwin')).toBe(false);
    expect(shieldUsesLaunchd({ VITEST: 'true', UNTETHER_SHIELD_LAUNCHD: '1' }, 'darwin')).toBe(
      true
    );
    expect(shieldUsesLaunchd({ UNTETHER_SHIELD_LAUNCHD: '0' }, 'darwin')).toBe(false);
  });

  it('has one label per control dir', () => {
    const label = shieldLaunchdLabel('/Users/me/.untether/control');
    expect(label).toMatch(/^com\.nachx639\.untether\.shield-tmux\.[0-9a-f]{12}$/);
    expect(shieldLaunchdLabel('/Users/me/.untether/control/')).toBe(label);
    expect(shieldLaunchdLabel('/Users/me/.untether-qa/control')).not.toBe(label);
  });

  it('writes a foreground tmux job: Interactive, not kept alive, with the global environment', () => {
    const plist = shieldLaunchdPlist({
      label: 'com.nachx639.untether.shield-tmux.abc',
      programArguments: ['/opt/homebrew/bin/tmux', '-S', '/c/.shield-tmux', '-D'],
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin',
        ODD: 'a&b <c> "d"',
        UNTETHER_SESSION_ID: 'per-session',
        UNTETHER_TASK_ID: 'per-session-task',
        COLORTERM: 'truecolor',
        BAD: 'bell\x07',
      },
      workingDirectory: '/Users/me',
    });
    expect(plist).toContain('<string>-D</string>');
    expect(plist).toContain('<key>ProcessType</key><string>Interactive</string>');
    expect(plist).toContain('<key>KeepAlive</key><false/>');
    expect(plist).toContain('<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>');
    expect(plist).toContain('<key>ODD</key><string>a&amp;b &lt;c&gt; "d"</string>');
    expect(plist).not.toContain('UNTETHER_SESSION_ID');
    // A task's marker is its session's own (new-session -e), never the server's (2026-11-02).
    expect(plist).not.toContain('UNTETHER_TASK_ID');
    expect(plist).not.toContain('COLORTERM');
    expect(plist).not.toContain('BAD');
  });

  // Starts a real launchd job; run with UT_LAUNCHD_IT=1 on a Mac.
  it.runIf(process.platform === 'darwin' && process.env.UT_LAUNCHD_IT === '1')(
    'starts the server as its own launchd job, which outlives whoever started it',
    async () => {
      const controlPath = markedTempDir('/tmp/ut-ld-');
      const label = shieldLaunchdLabel(controlPath);
      const domain = `gui/${process.getuid?.()}`;
      try {
        const shield = new ShieldTmux(controlPath, findTmuxBinary(), true);
        await shield.create({
          sessionId: 'ld-1',
          command: ['sh', '-c', 'exec sleep 60'],
          cwd: '/tmp',
          env: { ...(process.env as Record<string, string>), UNTETHER_SESSION_ID: 'ld-1' },
        });
        expect(await shield.has('ld-1')).toBe(true);
        const job = execFileSync('launchctl', ['print', `${domain}/${label}`], {
          encoding: 'utf8',
        });
        expect(job).toMatch(/^\tstate = running$/m);
        const jobPid = Number(/^\tpid = (\d+)$/m.exec(job)?.[1]);
        const programPid = (await shield.panePid('ld-1')) as number;
        // The program's parent is the tmux server launchd runs, not anything of ours.
        const parent = Number(
          execFileSync('ps', ['-o', 'ppid=', '-p', String(programPid)], { encoding: 'utf8' })
        );
        expect(parent).toBe(jobPid);
        // A second session joins the same server.
        await shield.create({
          sessionId: 'ld-2',
          command: ['sh', '-c', 'exec sleep 60'],
          cwd: '/tmp',
          env: process.env as Record<string, string>,
        });
        expect(await shield.has('ld-2')).toBe(true);
      } finally {
        try {
          execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
        } catch {
          // Not loaded.
        }
        fs.rmSync(controlPath, RM_TEST_DIR);
      }
    },
    20_000
  );
});

describe('Codex inline under the shield (2026-11-09)', () => {
  it('finds it by the flag every launch now carries', () => {
    expect(shieldScrollsTmuxHistory(['codex', CODEX_INLINE_FLAG])).toBe(true);
    expect(shieldScrollsTmuxHistory(['codex'])).toBe(false);
    expect(shieldScrollsTmuxHistory(['claude', '--resume', 'x'])).toBe(false);
  });

  it('tells mouse reports from typing', () => {
    for (const mouse of [
      '\u001b[<64;10;5M', // wheel
      '\u001b[<65;1;1M\u001b[<65;1;1M',
      '\u001b[<0;10;5M', // press
      '\u001b[<32;11;5M', // drag
      '\u001b[<0;11;5m', // release
      '\u001b[M`!!', // legacy wheel
      '\u001b[M !!', // legacy press
    ]) {
      expect(isMouseInput(mouse)).toBe(true);
    }
    for (const typed of ['x', 'q', '\r', '\u001b[A', '\u001b[I', '\u001b[<64;10;5Mx']) {
      expect(isMouseInput(typed)).toBe(false);
    }
    expect(isFocusReport('\u001b[I')).toBe(true);
    expect(isFocusReport('\u001b[O')).toBe(true);
    expect(isFocusReport('x')).toBe(false);
  });
});

describe('shield server options', () => {
  // 2026-10-31: apps copy with OSC 52 (Claude Code's mouse selection, vim, tmux); the web
  // terminal writes it to the clipboard (terminal-clipboard.ts). The shield tmux must pass it
  // on to its clients, whose TERM is xterm-256color.
  it('passes clipboard writes (OSC 52) on to the web terminal', () => {
    const option = (name: string) =>
      SHIELD_SERVER_OPTIONS.find((args) => args[0] === 'set-option' && args.at(-2) === name)?.at(
        -1
      );
    expect(option('set-clipboard')).toBe('on');
    expect(option('terminal-features')).toMatch(/^xterm\*:(?:[^:]*:)*clipboard(?::|$)/);
  });
});

describe('shieldStartupAction', () => {
  it('re-attaches a shielded session whose tmux session survived, whatever was recorded', () => {
    expect(shieldStartupAction({ shielded: true, status: 'running' }, true)).toBe('reattach');
    // A server shutting down may have recorded the SIGHUP of its client as an exit.
    expect(shieldStartupAction({ shielded: true, status: 'exited' }, true)).toBe('reattach');
  });

  it('recreates a shielded session that was still running when its tmux went away', () => {
    // Mac rebooted while the server was down or killed without recording anything.
    expect(shieldStartupAction({ shielded: true, status: 'running' }, false)).toBe('restore');
    // The tmux server died under a running server, which recorded it.
    expect(
      shieldStartupAction({ shielded: true, status: 'exited', shieldEnd: 'tmux-lost' }, false)
    ).toBe('restore');
  });

  it('never revives a session the user killed or whose program ended by itself', () => {
    for (const shieldEnd of ['killed', 'program-exit', 'restore-failed'] as const) {
      expect(shieldStartupAction({ shielded: true, status: 'exited', shieldEnd }, false)).toBe(
        'ignore'
      );
      // A crash between recording the kill and the exit leaves "running": finish it.
      expect(shieldStartupAction({ shielded: true, status: 'running', shieldEnd }, false)).toBe(
        'mark-exited'
      );
    }
    // Exited before this field existed: finished.
    expect(shieldStartupAction({ shielded: true, status: 'exited' }, false)).toBe('ignore');
  });

  it('stops restoring a session that keeps dying (restore loop)', () => {
    const now = 10 * 60 * 60 * 1000;
    const recent = Array.from({ length: SHIELD_RESTORE_LIMIT }, (_, i) => now - (i + 1) * 60_000);
    expect(
      shieldStartupAction({ shielded: true, status: 'running', shieldRestores: recent }, false, now)
    ).toBe('give-up');
    // Restores older than an hour don't count.
    const old = recent.map((t) => t - 60 * 60 * 1000);
    expect(
      shieldStartupAction({ shielded: true, status: 'running', shieldRestores: old }, false, now)
    ).toBe('restore');
  });

  it('leaves normal sessions to the existing cleanup', () => {
    expect(shieldStartupAction({ status: 'running' }, false)).toBe('ignore');
    expect(shieldStartupAction({ shielded: false, status: 'running' }, true)).toBe('ignore');
  });
});

describe('tmux arguments', () => {
  it('runs the command as argv, never through a shell', () => {
    const args = newSessionArgs({
      sessionId: 'abc',
      command: ['claude', '--resume', 'x; rm -rf ~'],
      cwd: '/tmp/a b',
      cols: 90,
      rows: 20,
      sessionEnv: { UNTETHER_SESSION_ID: 'abc' },
    });
    expect(args).toEqual([
      'new-session',
      '-d',
      '-s',
      'ut-abc',
      '-c',
      '/tmp/a b',
      '-x',
      '90',
      '-y',
      '20',
      '-e',
      'UNTETHER_SESSION_ID=abc',
      '--',
      'claude',
      '--resume',
      'x; rm -rf ~',
    ]);
    // tmux hands a single argument to `sh -c`: one-word commands go through env instead.
    expect(
      newSessionArgs({ sessionId: 'a', command: ['zsh'], cwd: '/', sessionEnv: {} }).slice(-2)
    ).toEqual(['/usr/bin/env', 'zsh']);
  });

  it('keeps the socket in the control dir, or a derived name when that path is too long', () => {
    expect(shieldSocketArgs('/tmp/ctl')).toEqual(['-S', '/tmp/ctl/.shield-tmux']);
    const long = shieldSocketArgs(`/tmp/${'x'.repeat(120)}`);
    expect(long[0]).toBe('-L');
    expect(long[1]).toMatch(/^untether-[0-9a-f]{12}$/);
  });

  it('never passes $TMUX on (a client inside tmux refuses to attach)', () => {
    expect(tmuxEnv({ TMUX: '/x,1,0', TMUX_PANE: '%1', PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });
});

// 2026-11-10: a clean exit was recorded as 1 (`exitCode || 1`), so every session that ended
// well showed as failed in the list and pushed "ended with errors".
describe('the exit code a session is recorded with (2026-11-10)', () => {
  it('keeps 0, keeps a failure, turns a signal into 128 + n, and is 1 only without a code', () => {
    expect(recordedExitCode({ exitCode: 0 })).toBe(0);
    expect(recordedExitCode({ exitCode: 0, signal: 0 })).toBe(0);
    expect(recordedExitCode({ exitCode: 3 })).toBe(3);
    expect(recordedExitCode({ exitCode: 0, signal: 15 })).toBe(143);
    expect(recordedExitCode({ signal: 9 })).toBe(137);
    expect(recordedExitCode({})).toBe(1);
    expect(recordedExitCode({ exitCode: null, signal: null })).toBe(1);
    expect(recordedExitCode({ exitCode: Number.NaN })).toBe(1);
  });

  it('reads what the pane-died hook wrote: a code, a signal by name or number, or nothing', () => {
    expect(parseShieldExit('0 \n')).toEqual({ exitCode: 0 });
    expect(parseShieldExit('3 \n')).toEqual({ exitCode: 3 });
    expect(parseShieldExit(' term\n')).toEqual({ signal: os.constants.signals.SIGTERM });
    expect(parseShieldExit(' kill\n')).toEqual({ signal: os.constants.signals.SIGKILL });
    expect(parseShieldExit(' 15\n')).toEqual({ signal: 15 });
    expect(parseShieldExit(' \n')).toBeNull();
    expect(parseShieldExit('')).toBeNull();
    expect(parseShieldExit('garbage here now\n')).toBeNull();
    expect(parseShieldExit(' nosuchsignal\n')).toBeNull();
  });

  it('asks tmux to keep the dead pane for the hook only, with the file path as an option value', () => {
    const commands = shieldExitCommands('abc', "/tmp/a b/it's #{x}/ut-abc.exit");
    // The path is an argv value of a user option, never part of a parsed command.
    expect(commands[0]).toEqual([
      'set-option',
      '-t',
      '=ut-abc:',
      '@ut_exit_file',
      "/tmp/a b/it's #{x}/ut-abc.exit",
    ]);
    expect(commands.at(-1)).toEqual([
      'set-hook',
      '-w',
      '-t',
      '=ut-abc:',
      'pane-died',
      SHIELD_EXIT_HOOK,
    ]);
    expect(SHIELD_EXIT_HOOK).toContain('#{q:@ut_exit_file}');
    // The pane always ends, whatever the write did.
    expect(SHIELD_EXIT_HOOK.endsWith('; kill-pane')).toBe(true);
    expect(shieldExitFile('/tmp/ctl', 'abc')).toBe('/tmp/ctl/ut-abc.exit');
  });
});

describe('per-session env file (2026-11-08)', () => {
  it('sets each variable exported and removes each name, nothing when empty', () => {
    expect(shieldEnvFileContent({}, [])).toBe('');
    const content = shieldEnvFileContent(
      { ANTHROPIC_BASE_URL: 'https://x/', ANTHROPIC_AUTH_TOKEN: 'sk-abc' },
      ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
    );
    expect(content).toBe(
      [
        "ANTHROPIC_BASE_URL='https://x/'; export ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN='sk-abc'; export ANTHROPIC_AUTH_TOKEN",
        'unset CLAUDE_CODE_OAUTH_TOKEN',
        'unset ANTHROPIC_API_KEY',
        '',
      ].join('\n')
    );
  });

  it('escapes a value so it is never run as code when sourced', () => {
    const content = shieldEnvFileContent({ K: "a'b; rm -rf ~ #" }, []);
    expect(content).toBe("K='a'\\''b; rm -rf ~ #'; export K\n");
    // What a POSIX shell sees after sourcing is the exact value, metacharacters and all.
    const out = execFileSync('/bin/sh', ['-c', `. "$0"; printf %s "$K"`, '/dev/stdin'], {
      input: content,
      encoding: 'utf8',
    });
    expect(out).toBe("a'b; rm -rf ~ #");
  });

  it('leaves out names that are not shell variables', () => {
    expect(shieldEnvFileContent({ 'BAD NAME': 'x', OK: 'y' }, ['1BAD', 'FINE'])).toBe(
      ["OK='y'; export OK", 'unset FINE', ''].join('\n')
    );
  });

  it('fails closed on the preflight verdict: only an explicit ok passes', () => {
    expect(readShieldVerify('ok\n')).toEqual({ ok: true });
    expect(readShieldVerify('fail:+CLAUDE_CODE_OAUTH_TOKEN env-not-applied\n')).toEqual({
      ok: false,
      problem: '+CLAUDE_CODE_OAUTH_TOKEN env-not-applied',
    });
    // Empty (not written yet) and anything unrecognised are failures, never a silent pass.
    expect(readShieldVerify('').ok).toBe(false);
    expect(readShieldVerify('  ').ok).toBe(false);
    expect(readShieldVerify('weird').ok).toBe(false);
    expect(readShieldVerify('fail:').problem).toBe('unspecified');
  });

  it('awaitShieldVerify fails closed when no verdict is written in time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-verify-'));
    onTestFinished(() => fs.rmSync(dir, RM_TEST_DIR));
    const missing = path.join(dir, 'never');
    expect(await awaitShieldVerify(missing, 120)).toEqual({
      ok: false,
      problem: 'the session did not confirm its environment in time',
    });
    const ok = path.join(dir, 'ok');
    fs.writeFileSync(ok, 'ok\n');
    expect(await awaitShieldVerify(ok, 120)).toEqual({ ok: true });
  });

  it('builds the preflight command with only valid names in the forbid list', () => {
    const argv = shieldPreflightCommand(
      '/c/ut-a.env',
      '/c/ut-a.verify',
      'nonce123',
      ['CLAUDE_CODE_OAUTH_TOKEN', 'BAD NAME'],
      ['claude', '--resume', 'x']
    );
    expect(argv).toEqual([
      '/bin/sh',
      '-c',
      SHIELD_PREFLIGHT_SCRIPT,
      '/c/ut-a.env',
      '/c/ut-a.verify',
      'nonce123',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'claude',
      '--resume',
      'x',
    ]);
  });

  it('the preflight checks the effective env and runs the agent only when it is right', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-preflight-'));
    onTestFinished(() => fs.rmSync(dir, RM_TEST_DIR));
    let n = 0;
    const run = (
      fileContent: string,
      forbid: string,
      extraEnv: NodeJS.ProcessEnv,
      nonce = 'N1'
    ) => {
      const id = `${n++}`;
      const envFile = path.join(dir, `e${id}.env`);
      const verify = path.join(dir, `v${id}`);
      const marker = path.join(dir, `ran${id}`);
      fs.writeFileSync(envFile, fileContent);
      execFileSync(
        '/bin/sh',
        [
          '-c',
          // The agent is `sleep`; replace it with an exit so a failing run never waits 30s.
          SHIELD_PREFLIGHT_SCRIPT.split('exec sleep 30').join('exit 0'),
          envFile,
          verify,
          nonce,
          forbid,
          '/usr/bin/touch',
          marker,
        ],
        { env: { ...process.env, ...extraEnv } }
      );
      return {
        verify: fs.existsSync(verify) ? fs.readFileSync(verify, 'utf8').trim() : '',
        ranAgent: fs.existsSync(marker),
        envFileGone: !fs.existsSync(envFile),
      };
    };
    const applied = shieldAppliedLine('N1');
    // Right env (nonce applied, an EMPTY override variable is valid, credential dropped): ok, runs.
    expect(
      run(
        `ANTHROPIC_BASE_URL='https://x/'; export ANTHROPIC_BASE_URL\nEMPTY_OK=''; export EMPTY_OK\nunset CLAUDE_CODE_OAUTH_TOKEN\n${applied}`,
        'CLAUDE_CODE_OAUTH_TOKEN',
        { CLAUDE_CODE_OAUTH_TOKEN: 'from-server-global', EMPTY_OK: 'leftover' }
      )
    ).toEqual({ verify: 'ok', ranAgent: true, envFileGone: true });
    // A credential still set (the file did not drop it): fail, never runs.
    const cred = run(
      `ANTHROPIC_BASE_URL='https://x/'; export ANTHROPIC_BASE_URL\n${applied}`,
      'EVIL',
      {
        EVIL: 'still-here',
      }
    );
    expect(cred.ranAgent).toBe(false);
    expect(cred.verify).toBe('fail: +EVIL');
    // The file never applied (no nonce line: a swallowed environment): fail, never runs.
    const notApplied = run("ANTHROPIC_BASE_URL='https://x/'; export ANTHROPIC_BASE_URL\n", '', {});
    expect(notApplied.ranAgent).toBe(false);
    expect(notApplied.verify).toBe('fail:env-not-applied');
    // The env file cannot be loaded (missing): fail, never runs.
    const envFile = path.join(dir, 'gone.env');
    const verify = path.join(dir, 'gone.verify');
    const marker = path.join(dir, 'gone.ran');
    execFileSync(
      '/bin/sh',
      [
        '-c',
        SHIELD_PREFLIGHT_SCRIPT.split('exec sleep 30').join('exit 0'),
        envFile,
        verify,
        'N1',
        '',
        '/usr/bin/touch',
        marker,
      ],
      { env: process.env }
    );
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(verify, 'utf8').trim()).toBe('fail:env-file');
  });
});

describe('runtimeVarsInEnvironment (2026-10-24)', () => {
  it("finds the server's runtime variables in `show-environment -g`, not removed ones", () => {
    const out = [
      'HOME=/Users/me',
      'NODE_ENV=development',
      'NODE_PATH=/repo/web/node_modules/.pnpm/node_modules',
      'npm_lifecycle_script=node scripts/dev.js --local-auth-token x',
      'PNPM_SCRIPT_SRC_DIR=/repo/web',
      '-NODE_OPTIONS',
      'PATH=/usr/bin',
      '',
    ].join('\n');
    expect(runtimeVarsInEnvironment(out)).toEqual([
      'NODE_ENV',
      'NODE_PATH',
      'npm_lifecycle_script',
      'PNPM_SCRIPT_SRC_DIR',
    ]);
  });
});

describe('shieldReopenPlan', () => {
  it('continues a Claude conversation and replaces the old session', () => {
    expect(
      shieldReopenPlan({
        command: ['/opt/homebrew/bin/claude', '--dangerously-skip-permissions'],
        claudeSessionId: 'c1',
      })
    ).toEqual({
      command: ['claude', '--resume', 'c1', '--dangerously-skip-permissions'],
      replacesOld: true,
      resumes: 'claude',
    });
  });

  // 2026-11-10: Blindar on a Codex session opened a new, empty Codex next to the old one.
  it('continues a Codex thread and replaces the old session', () => {
    const thread = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(
      shieldReopenPlan({
        command: [
          '/opt/homebrew/bin/codex',
          CODEX_INLINE_FLAG,
          '-m',
          'gpt-6',
          '--search',
          'fix it',
        ],
        codexThreadId: thread,
      })
    ).toEqual({
      command: [
        '/opt/homebrew/bin/codex',
        'resume',
        thread,
        CODEX_INLINE_FLAG,
        '-m',
        'gpt-6',
        '--search',
      ],
      replacesOld: true,
      resumes: 'codex',
    });
    // Already a resume of it (shielded twice, or reopened): the same thread, once.
    expect(
      shieldReopenPlan({
        command: ['codex', 'resume', CODEX_INLINE_FLAG, thread, '--yolo'],
        codexThreadId: thread,
      }).command
    ).toEqual(['codex', 'resume', thread, CODEX_INLINE_FLAG, '--yolo']);
  });

  it('starts a Codex without a known thread, or typed in a shell, again', () => {
    expect(shieldReopenPlan({ command: ['codex', '--yolo'] })).toEqual({
      command: ['codex', '--yolo'],
      replacesOld: false,
    });
    // The shell is the session's program: a new shell, as with Claude typed in one.
    expect(shieldReopenPlan({ command: ['zsh', '-l'], codexThreadId: 'thread' }).replacesOld).toBe(
      false
    );
  });

  it('a session with both goes on with its Claude conversation', () => {
    expect(
      shieldReopenPlan({ command: ['claude'], claudeSessionId: 'c1', codexThreadId: 't1' }).resumes
    ).toBe('claude');
  });

  it('starts anything else again and keeps the old session', () => {
    expect(shieldReopenPlan({ command: ['zsh', '-l'], claudeSessionId: 'c1' })).toEqual({
      command: ['zsh', '-l'],
      replacesOld: false,
    });
  });
});

describe('carrying the Claude flags (2026-10-20)', () => {
  it('keeps --allowedTools, --model and --permission-mode on Blindar', () => {
    const plan = shieldReopenPlan({
      command: [
        '/opt/homebrew/bin/claude',
        '--model',
        'opus',
        '--allowedTools',
        'Bash(ut task:*)',
        'Bash(ut task done:*)',
        '--permission-mode',
        'acceptEdits',
        '--dangerously-skip-permissions',
      ],
      claudeSessionId: 'c1',
    });
    expect(plan.command).toEqual([
      'claude',
      '--resume',
      'c1',
      '--model',
      'opus',
      '--allowedTools',
      'Bash(ut task:*)',
      'Bash(ut task done:*)',
      '--permission-mode',
      'acceptEdits',
      '--dangerously-skip-permissions',
    ]);
  });

  it('drops another conversation, a one-off run and the prompt', () => {
    expect(
      carriedClaudeArgs([
        '--resume',
        'old',
        '--session-id',
        'x',
        '-c',
        '-p',
        '--output-format',
        'json',
        '--model=sonnet',
        '--resume=other',
        'fix the bug',
      ])
    ).toEqual(['--model=sonnet']);
    expect(carriedClaudeArgs(['-r', '--verbose', '--', '--model', 'x'])).toEqual(['--verbose']);
  });

  it('keeps the value of a flag it does not know, drops prompts after known booleans (2026-10-20)', () => {
    expect(
      carriedClaudeArgs([
        '--append-system-prompt-file',
        '/tmp/p.md',
        '--some-new-flag',
        'value',
        '--dangerously-skip-permissions',
        'fix the bug',
      ])
    ).toEqual([
      '--append-system-prompt-file',
      '/tmp/p.md',
      '--some-new-flag',
      'value',
      '--dangerously-skip-permissions',
    ]);
    // Optional values are never taken: the word may be the prompt.
    expect(carriedClaudeArgs(['--debug', 'fix it', '--verbose', 'again'])).toEqual([
      '--debug',
      '--verbose',
    ]);
    expect(carriedClaudeArgs(['--new-bool', '--model', 'opus'])).toEqual([
      '--new-bool',
      '--model',
      'opus',
    ]);
  });

  it('a restore after a reboot keeps them too', () => {
    expect(
      shieldRestorePlan({
        command: ['/opt/homebrew/bin/claude', '--allowedTools', 'Bash(ut task:*)'],
        claudeSessionId: 'c1',
      }).command
    ).toEqual(['/opt/homebrew/bin/claude', '--resume', 'c1', '--allowedTools', 'Bash(ut task:*)']);
  });
});

describe('has-session failures (2026-10-20)', () => {
  const failure = (stderr: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error('Command failed'), { code: 1, stderr, ...extra });

  it('only "no such session" or "no server" mean gone', () => {
    expect(classifyHasSessionError(failure("can't find session: ut-a\n"))).toBe('gone');
    expect(
      classifyHasSessionError(
        failure('error connecting to /x/.shield-tmux (No such file or directory)\n')
      )
    ).toBe('gone');
    expect(classifyHasSessionError(failure('no server running on /x/.shield-tmux\n'))).toBe('gone');
    // A server with no session left (it is exiting) has none of ours either.
    expect(classifyHasSessionError(failure('no current target\n'))).toBe('gone');
  });

  it('tells a server on its way out from a slow or foreign one (2026-11-03)', () => {
    expect(isShieldServerExiting(failure('server exited unexpectedly\n'))).toBe(true);
    expect(isShieldServerExiting(failure('lost server\n'))).toBe(true);
    expect(isShieldServerExiting(failure('no current target\n'))).toBe(true);
    expect(isShieldServerExiting(failure('protocol version mismatch (client 8, server 7)'))).toBe(
      false
    );
    expect(isShieldServerExiting(failure("can't find session: ut-a\n"))).toBe(false);
    expect(
      isShieldServerExiting(
        failure('server exited unexpectedly', { code: null, killed: true, signal: 'SIGTERM' })
      )
    ).toBe(false);
  });

  /** A tmux that answers `exiting` for its first `n` calls, then runs `after` (sh). */
  function exitingTmux(n: number, after: string) {
    const dir = markedTempDir(path.join(os.tmpdir(), 'ut-fake-tmux-'));
    const fake = path.join(dir, 'tmux');
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(
      fake,
      [
        '#!/bin/sh',
        // printf, not echo: sh's echo turns a `\n` inside an argument (the exit hook) into a line.
        `printf '%s\\n' "$*" >> '${calls}'`,
        `if [ "$(wc -l < '${calls}')" -le ${n} ]; then echo 'server exited unexpectedly' >&2; exit 1; fi`,
        after,
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    onTestFinished(() => fs.rmSync(dir, RM_TEST_DIR));
    const callCount = () => fs.readFileSync(calls, 'utf8').trim().split('\n').length;
    return { dir, fake, callCount };
  }

  it('a probe right after the last session was killed says gone, not unknown (2026-11-03)', async () => {
    // The give-up path kills the session, then probes: tmux was still exiting, the probe read
    // "unknown" and the session was left running without a client (7 merge checks, 02-nov).
    const { dir, fake, callCount } = exitingTmux(2, "echo 'no server running' >&2; exit 1");
    const shield = new ShieldTmux(dir, fake, false);
    expect(await shield.probe('a')).toBe('gone');
    expect(callCount()).toBe(3);
  });

  it('starting a session while the server exits starts it on a fresh server (2026-11-03)', async () => {
    // sessions-api e2e: the session before had just ended (the server's last one), the create
    // reached the exiting server and answered 500; the program had not run.
    const { dir, fake, callCount } = exitingTmux(3, 'exit 0');
    const shield = new ShieldTmux(dir, fake, false);
    await shield.create({ sessionId: 's1', command: ['true'], cwd: '/tmp', env: {} });
    // show-environment (ignored), then the start-server chain: two exiting answers, then it ran.
    expect(callCount()).toBe(4);
  });

  it('a server that keeps answering exiting fails the create in the end', async () => {
    const { dir, fake } = exitingTmux(1000, 'exit 0');
    const shield = new ShieldTmux(dir, fake, false);
    await expect(
      shield.create({ sessionId: 's1', command: ['true'], cwd: '/tmp', env: {} })
    ).rejects.toThrow(/server exited unexpectedly/);
  });

  it('a provider session fails closed when the preflight never confirms its env (2026-11-08)', async () => {
    // create() waits for the verdict and, with none by the deadline, fails loudly and kills the
    // session instead of letting the agent run on the user's own Anthropic login. This fake tmux
    // starts no real pane, so nothing writes the verify file: the timeout fires deterministically.
    const { dir, fake } = exitingTmux(0, 'exit 0');
    const shield = new ShieldTmux(dir, fake, false);
    shield.verifyTimeoutMs = 200;
    await expect(
      shield.create({
        sessionId: 'no-verdict',
        command: ['true'],
        cwd: '/tmp',
        env: {},
        overrideEnv: { ANTHROPIC_BASE_URL: 'https://x/' },
        unsetEnv: ['CLAUDE_CODE_OAUTH_TOKEN'],
      })
    ).rejects.toThrow(/did not take effect.*in time/);
    // The 0600 env and verify files are not left behind.
    expect(fs.existsSync(path.join(dir, 'ut-no-verdict.env'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'ut-no-verdict.verify'))).toBe(false);
  });

  it('a timeout or a protocol mismatch says nothing about the session', () => {
    expect(classifyHasSessionError(failure('protocol version mismatch (client 8, server 7)'))).toBe(
      'unknown'
    );
    expect(
      classifyHasSessionError(failure('', { code: null, killed: true, signal: 'SIGTERM' }))
    ).toBe('unknown');
    expect(classifyHasSessionError(new Error('spawn EAGAIN'))).toBe('unknown');
  });

  it('has() counts a session it cannot tell about as alive, after asking again', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-fake-tmux-'));
    const fake = path.join(dir, 'tmux');
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(
      fake,
      `#!/bin/sh\necho x >> '${calls}'\necho 'protocol version mismatch' >&2\nexit 1\n`,
      { mode: 0o755 }
    );
    try {
      const shield = new ShieldTmux(dir, fake, false);
      expect(await shield.probe('a')).toBe('unknown');
      expect(await shield.has('a', { retries: 2, retryDelayMs: 1 })).toBe(true);
      // probe + 3 tries of has()
      expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(4);
      fs.writeFileSync(fake, '#!/bin/sh\necho "can\'t find session: ut-a" >&2\nexit 1\n', {
        mode: 0o755,
      });
      expect(await shield.has('a')).toBe(false);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });
});

describe('shieldRestorePlan', () => {
  it('resumes the Claude conversation, keeping --dangerously-skip-permissions', () => {
    expect(
      shieldRestorePlan({
        command: ['/opt/homebrew/bin/claude', '--dangerously-skip-permissions'],
        claudeSessionId: 'c1',
      })
    ).toEqual({
      command: ['/opt/homebrew/bin/claude', '--resume', 'c1', '--dangerously-skip-permissions'],
      kind: 'claude-resume',
    });
    // Started through the shell (an alias or function): resumed the same way.
    expect(
      shieldRestorePlan({ command: ['/bin/zsh', '-i', '-c', 'claude'], claudeSessionId: 'c3' })
        .command
    ).toEqual(['claude', '--resume', 'c3']);
    expect(shieldRestorePlan({ command: ['claude'], claudeSessionId: 'c2' }).command).toEqual([
      'claude',
      '--resume',
      'c2',
    ]);
  });

  it('starts Claude again when its conversation is unknown', () => {
    expect(shieldRestorePlan({ command: ['/x/claude'] })).toEqual({
      command: ['/x/claude'],
      kind: 'same-command',
    });
  });

  it('resumes a Codex thread when its rollout is known', () => {
    expect(
      shieldRestorePlan(
        { command: ['/opt/bin/codex', '--yolo', 'fix the tests'] },
        '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
      )
    ).toEqual({
      command: ['/opt/bin/codex', 'resume', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', '--yolo'],
      kind: 'codex-resume',
    });
    expect(shieldRestorePlan({ command: ['/opt/bin/codex'] }, null).kind).toBe('same-command');
    // A task's Codex resumes without its update prompt too (2026-10-23).
    expect(
      shieldRestorePlan(
        { command: ['/opt/bin/codex', '-c', 'check_for_update_on_startup=false', '--yolo'] },
        'id-1'
      ).command
    ).toEqual([
      '/opt/bin/codex',
      'resume',
      'id-1',
      '-c',
      'check_for_update_on_startup=false',
      '--yolo',
    ]);
    // The thread recorded while it ran is used when none is passed.
    expect(shieldRestorePlan({ command: ['codex'], codexThreadId: 'id-2' })).toEqual({
      command: ['codex', 'resume', 'id-2'],
      kind: 'codex-resume',
    });
    // And without its tooltips (2026-11-03).
    expect(
      shieldRestorePlan(
        {
          command: [
            '/opt/bin/codex',
            '-c',
            'check_for_update_on_startup=false',
            '-c',
            'tui.show_tooltips=false',
          ],
        },
        'id-1'
      ).command
    ).toEqual([
      '/opt/bin/codex',
      'resume',
      'id-1',
      '-c',
      'check_for_update_on_startup=false',
      '-c',
      'tui.show_tooltips=false',
    ]);
  });

  it('starts a shell (or anything else) again, as a fresh one', () => {
    expect(shieldRestorePlan({ command: ['/bin/zsh', '-l'], claudeSessionId: 'c1' })).toEqual({
      command: ['/bin/zsh', '-l'],
      kind: 'same-command',
    });
  });
});

describe('shieldClientEndReason', () => {
  it('tells a lost tmux server from a session that ended', () => {
    expect(shieldClientEndReason('\x1b[?1049l[exited]\r\n')).toBe('session-ended');
    expect(shieldClientEndReason('\x1b[?2031l[server exited]\r\n')).toBe('server-lost');
    expect(shieldClientEndReason('[server exited unexpectedly]\n')).toBe('server-lost');
    expect(shieldClientEndReason('[lost server]\n')).toBe('server-lost');
    expect(shieldClientEndReason('$ ')).toBe('unknown');
  });
});

describe('lastCastSize', () => {
  let dir: string;
  beforeAll(() => {
    dir = markedTempDir('/tmp/ut-size-');
  });
  afterAll(() => {
    if (dir) fs.rmSync(dir, RM_TEST_DIR);
  });

  it('uses the last resize, else the header', () => {
    const file = path.join(dir, 'stdout');
    fs.writeFileSync(file, `${JSON.stringify({ version: 2, width: 100, height: 40 })}\n`);
    expect(lastCastSize(file)).toEqual({ cols: 100, rows: 40 });
    fs.appendFileSync(file, '[1.0,"r","90x20"]\n[2.0,"o","hola"]\n[3.0,"r","70x25"]\n');
    expect(lastCastSize(file)).toEqual({ cols: 70, rows: 25 });
    expect(lastCastSize(path.join(dir, 'missing'))).toBeNull();
  });
});

describe('AsciinemaWriter.resume', () => {
  let dir: string;
  beforeAll(() => {
    dir = markedTempDir('/tmp/ut-cast-');
  });
  afterAll(() => {
    if (dir) fs.rmSync(dir, RM_TEST_DIR);
  });

  it('appends to the existing cast after a half-written line', async () => {
    const file = path.join(dir, 'stdout');
    const first = AsciinemaWriter.create(file, 80, 24);
    first.writeOutput(Buffer.from('antes\r\n'));
    await first.close();
    fs.appendFileSync(file, '[1.5, "o", "cut'); // server killed mid-write

    const resumed = AsciinemaWriter.resume(file);
    resumed.writeOutput(Buffer.from('despues'));
    await resumed.close();

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    expect(JSON.parse(lines[0]).version).toBe(2);
    expect(lines.filter((line) => line.includes('antes'))).toHaveLength(1);
    expect(JSON.parse(lines.filter(Boolean).at(-1) ?? '')[2]).toBe('despues');
  });
});

// The integration test needs real PTYs (the test setup mocks node-pty).
vi.unmock('node-pty');

const tmux = findTmuxBinary();

/** Generous deadline for waits on a condition, so load never fails them (2026-11-02). */
const WAIT = { timeout: 15_000, interval: 20 };

/**
 * Resolves once the session's tmux client has exited and PtyManager's exit handler has run up
 * to its first await (node-pty calls onExit listeners in order, the manager's first): the
 * "server shutting down" check has been made. 2026-11-02: replaces fixed 300 ms sleeps.
 */
function clientExited(manager: PtyManager, sessionId: string): Promise<void> {
  const pty = manager.getInternalSession(sessionId)?.ptyProcess;
  if (!pty) throw new Error(`no tmux client for ${sessionId}`);
  return new Promise((resolve) => pty.onExit(() => resolve()));
}

describe.skipIf(!tmux)('shielded session survives a server restart (real tmux)', () => {
  let controlPath: string;
  const managers: PtyManager[] = [];

  beforeAll(async () => {
    await PtyManager.initialize();
  });

  /**
   * Teardown as a server going down: every tmux client of `manager` dies and its exit has
   * reached the manager before the shutdown flag goes (2026-11-03: managers were never let
   * go; a client exit after the test read as a crash, attaching again or restoring on the
   * removed folder).
   */
  async function clientsGoWithServer(manager: PtyManager) {
    const sessionIds = manager.listSessions().map((s) => s.id);
    setShuttingDown(true);
    try {
      const exits = sessionIds.map((id) => {
        const client = manager.getInternalSession(id)?.ptyProcess;
        if (!client) return Promise.resolve();
        const exited = new Promise<void>((resolve) => client.onExit(() => resolve()));
        try {
          process.kill(client.pid, 'SIGKILL');
        } catch {
          return Promise.resolve(); // Already gone.
        }
        return exited;
      });
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(exits),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('a tmux client never exited')), 8_000);
        }),
      ]).finally(() => clearTimeout(deadline));
    } finally {
      setShuttingDown(false);
    }
  }

  afterEach(async () => {
    // The test's managers settle first, as a server going down: their clients' exits must not
    // set off attaching again or a restore once the tmux server and the folder are gone.
    for (const manager of managers.splice(0)) await clientsGoWithServer(manager);
    // 2026-10-20: also unloads this test's launchd job when one was made (kill-server alone
    // left it loaded); only the job of this test's own control dir.
    stopTestShieldServer(tmux as string, controlPath);
    fs.rmSync(controlPath, RM_TEST_DIR);
  });

  // 2026-11-09: tmux keeps Codex's inline history to itself, so its session takes the wheel.
  it('gives the mouse to tmux for an inline Codex alone, and typing leaves copy mode', async () => {
    controlPath = markedTempDir('/tmp/ut-sh-');
    const shield = new ShieldTmux(controlPath, tmux as string, false);
    const env = process.env as Record<string, string>;
    const start = (sessionId: string, command: string[]) =>
      shield.create({ sessionId, command, cwd: '/tmp', cols: 80, rows: 24, env });
    await start('inline', ['sh', '-c', 'exec sleep 60', CODEX_INLINE_FLAG]);
    await start('plain', ['sh', '-c', 'exec sleep 60']);
    const ask = (...args: string[]) =>
      execFileSync(tmux as string, [...shieldSocketArgs(controlPath), ...args], {
        env: tmuxEnv(process.env),
        encoding: 'utf8',
      }).trim();
    const mouse = (id: string) => ask('show-options', '-t', `=ut-${id}:`, '-Ag', 'mouse');
    expect(ask('show-options', '-t', '=ut-inline:', 'mouse')).toBe('mouse on');
    expect(ask('show-options', '-t', '=ut-plain:', 'mouse')).toBe('');
    expect(mouse('plain')).toBe('mouse off');

    ask('copy-mode', '-t', '=ut-inline:');
    const inMode = () => ask('display-message', '-p', '-t', '=ut-inline:', '#{pane_in_mode}');
    expect(inMode()).toBe('1');
    await shield.leaveCopyMode('inline');
    expect(inMode()).toBe('0');
    await shield.leaveCopyMode('inline'); // not in copy mode: nothing happens
  });

  it('re-attaches the same program under the same id', async () => {
    controlPath = markedTempDir('/tmp/ut-sh-');
    const first = new PtyManager(controlPath);
    managers.push(first);
    const { sessionId } = await first.createSession(['sh', '-c', 'echo antes; exec sleep 60'], {
      sessionId: 'shield-it',
      workingDir: '/tmp',
      cols: 80,
      rows: 24,
      shielded: true,
    });
    const shield = new ShieldTmux(controlPath);
    const programPid = await shield.panePid(sessionId);
    expect(programPid).toBeGreaterThan(0);

    // "Server shuts down": its tmux client goes away with it.
    const clientPid = first.getSession(sessionId)?.pid as number;
    setShuttingDown(true);
    try {
      const exited = clientExited(first, sessionId);
      process.kill(clientPid, 'SIGKILL');
      await exited;
    } finally {
      setShuttingDown(false);
    }
    expect(await shield.has(sessionId)).toBe(true);

    const second = new PtyManager(controlPath);
    managers.push(second);
    const result = await second.reattachShieldedSessions();
    expect(result.reattached).toEqual([sessionId]);
    expect(await shield.panePid(sessionId)).toBe(programPid);
    const session = second.getSession(sessionId);
    expect(session?.status).toBe('running');
    expect(session?.pid).not.toBe(clientPid);
    expect(fs.readFileSync(path.join(controlPath, sessionId, 'stdout'), 'utf8')).toContain('antes');

    // Closing it ends the program too.
    await second.killSession(sessionId);
    expect(await shield.has(sessionId)).toBe(false);
  }, 20_000);

  it('answers every pane pid in one list-panes, the same as asking each session (2026-11-02)', async () => {
    controlPath = markedTempDir('/tmp/ut-sh-');
    const manager = new PtyManager(controlPath);
    managers.push(manager);
    for (const sessionId of ['pp-one', 'pp-two']) {
      await manager.createSession(['sh', '-c', 'exec sleep 60'], {
        sessionId,
        workingDir: '/tmp',
        cols: 80,
        rows: 24,
        shielded: true,
      });
    }
    const shield = new ShieldTmux(controlPath);
    const pids = await shield.panePids(['pp-one', 'pp-two', 'pp-gone']);
    expect(pids.get('pp-one')).toBe(await shield.panePid('pp-one'));
    expect(pids.get('pp-two')).toBe(await shield.panePid('pp-two'));
    expect(pids.get('pp-one')).toBeGreaterThan(0);
    expect(pids.get('pp-one')).not.toBe(pids.get('pp-two'));
    expect(pids.get('pp-gone')).toBeNull();
    for (const sessionId of ['pp-one', 'pp-two']) await manager.killSession(sessionId);
  }, 20_000);

  it("a server started with the dev server's environment hands none of it on (2026-10-24)", async () => {
    // The shield tmux server started by `pnpm dev` kept NODE_ENV=development as its global
    // environment and every task's Claude got it (vite built React the development way).
    controlPath = markedTempDir('/tmp/ut-sh-');
    execFileSync(
      tmux as string,
      [...shieldSocketArgs(controlPath), 'new-session', '-d', '-s', 'older', 'sleep 60'],
      {
        env: {
          ...process.env,
          NODE_ENV: 'development',
          npm_lifecycle_script: 'node scripts/dev.js --local-auth-token secret',
        },
      }
    );
    const manager = new PtyManager(controlPath);
    managers.push(manager);
    const { sessionId } = await manager.createSession(
      ['sh', '-c', 'echo "env:${NODE_ENV-unset}:${npm_lifecycle_script-unset}"; exec sleep 60'],
      { sessionId: 'shield-env', workingDir: '/tmp', cols: 80, rows: 24, shielded: true }
    );
    const stdout = path.join(controlPath, sessionId, 'stdout');
    const deadline = Date.now() + 10_000;
    // The cast header holds the command itself (`env:${…`): wait for its output.
    while (!/env:[^$]/.test(fs.readFileSync(stdout, 'utf8')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fs.readFileSync(stdout, 'utf8')).toContain('env:unset:unset');
    const global = execFileSync(
      tmux as string,
      [...shieldSocketArgs(controlPath), 'show-environment', '-g'],
      { encoding: 'utf8' }
    );
    expect(runtimeVarsInEnvironment(global)).toEqual([]);
    await manager.killSession(sessionId);
  }, 20_000);

  it("a shielded session's own Node is its own: first on its PATH, never the server's (2026-11-02)", async () => {
    // 2026-11-02: run from a task's own session (which has a CLAUDE_ENV_FILE of its own), the
    // tmux server inherited it and the check below blamed the session's. Not the server's env.
    const savedEnvFile = process.env.CLAUDE_ENV_FILE;
    delete process.env.CLAUDE_ENV_FILE;
    onTestFinished(() => {
      if (savedEnvFile !== undefined) process.env.CLAUDE_ENV_FILE = savedEnvFile;
    });
    controlPath = markedTempDir('/tmp/ut-sh-');
    const manager = new PtyManager(controlPath);
    managers.push(manager);
    const bin = path.join(controlPath, 'node24-bin');
    const { sessionId } = await manager.createSession(
      ['sh', '-c', 'echo "first:${PATH%%:*}:${CLAUDE_ENV_FILE:+envfile}"; exec sleep 60'],
      {
        sessionId: 'shield-node',
        workingDir: '/tmp',
        cols: 80,
        rows: 24,
        shielded: true,
        pathPrepend: bin,
      }
    );
    const stdout = path.join(controlPath, sessionId, 'stdout');
    const deadline = Date.now() + 10_000;
    while (!/first:\//.test(fs.readFileSync(stdout, 'utf8')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fs.readFileSync(stdout, 'utf8')).toContain(`first:${bin}:envfile`);
    const global = execFileSync(
      tmux as string,
      [...shieldSocketArgs(controlPath), 'show-environment', '-g'],
      { encoding: 'utf8' }
    );
    expect(global).not.toContain(bin);
    expect(global).not.toContain('CLAUDE_ENV_FILE');
    // Kept on the session, so a restore puts it back.
    expect(manager.getSession(sessionId)?.pathPrepend).toBe(bin);
    await manager.killSession(sessionId);
  }, 20_000);

  it("a provider session's environment reaches the program, and the credentials it drops are gone (2026-11-08)", async () => {
    // The shield tmux server hands every session the environment it was started with: a provider
    // task once ran with the user's CLAUDE_CODE_OAUTH_TOKEN and none of its ANTHROPIC_* and
    // talked to the Anthropic API. The variables (the key among them) and the credentials it
    // drops are the session's own, applied to the program, not the shared server.
    controlPath = markedTempDir('/tmp/ut-sh-');
    // A server already running with the user's own login in its global environment.
    execFileSync(
      tmux as string,
      [...shieldSocketArgs(controlPath), 'new-session', '-d', '-s', 'older', 'sleep 60'],
      { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'user-oauth-should-vanish' } }
    );
    const manager = new PtyManager(controlPath);
    managers.push(manager);
    const { sessionId } = await manager.createSession(
      [
        'sh',
        '-c',
        'echo "base:${ANTHROPIC_BASE_URL-unset} tok:${ANTHROPIC_AUTH_TOKEN-unset} oauth:${CLAUDE_CODE_OAUTH_TOKEN-unset}"; exec sleep 60',
      ],
      {
        sessionId: 'prov-env',
        workingDir: '/tmp',
        cols: 80,
        rows: 24,
        shielded: true,
        env: { ANTHROPIC_BASE_URL: 'https://prov.example/', ANTHROPIC_AUTH_TOKEN: 'sk-secret-123' },
        unsetEnv: ['CLAUDE_CODE_OAUTH_TOKEN'],
      }
    );
    const stdout = path.join(controlPath, sessionId, 'stdout');
    const read = () => (fs.existsSync(stdout) ? fs.readFileSync(stdout, 'utf8') : '');
    const deadline = Date.now() + 10_000;
    while (!/base:[^$]/.test(read()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // The provider variables (the key too) reached it; the user's login did not.
    expect(read()).toContain('base:https://prov.example/ tok:sk-secret-123 oauth:unset');
    // The key is never in the server's global environment (its launchd plist on disk).
    const global = execFileSync(
      tmux as string,
      [...shieldSocketArgs(controlPath), 'show-environment', '-g'],
      { encoding: 'utf8' }
    );
    expect(global).not.toContain('sk-secret-123');
    expect(global).not.toContain('ANTHROPIC_BASE_URL');
    // The 0600 env file the program sourced is removed at once, so the key never lingers on disk.
    expect(fs.existsSync(path.join(controlPath, 'ut-prov-env.env'))).toBe(false);
    await manager.killSession(sessionId);
  }, 20_000);

  it('an empty override variable is valid and does not kill the session (2026-11-08)', async () => {
    // An environment variable set to the empty string is valid and different from an unset one:
    // the preflight checks the env took effect (its nonce) and the credentials are gone, not that
    // every variable has content, so a session that uses one is not killed.
    controlPath = markedTempDir('/tmp/ut-sh-');
    const manager = new PtyManager(controlPath);
    managers.push(manager);
    const { sessionId } = await manager.createSession(
      [
        'sh',
        '-c',
        'echo "base:${ANTHROPIC_BASE_URL-unset} empty:[${EMPTY_OK-unset}]"; exec sleep 60',
      ],
      {
        sessionId: 'empty-ok',
        workingDir: '/tmp',
        cols: 80,
        rows: 24,
        shielded: true,
        env: { ANTHROPIC_BASE_URL: 'https://x/', EMPTY_OK: '' },
        unsetEnv: ['CLAUDE_CODE_OAUTH_TOKEN'],
      }
    );
    const stdout = path.join(controlPath, sessionId, 'stdout');
    const read = () => (fs.existsSync(stdout) ? fs.readFileSync(stdout, 'utf8') : '');
    const deadline = Date.now() + 10_000;
    while (!/base:[^$]/.test(read()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // The session ran (not killed) and its empty variable is set, empty.
    expect(read()).toContain('base:https://x/ empty:[]');
    expect(manager.getSession(sessionId)?.status).toBe('running');
    await manager.killSession(sessionId);
  }, 20_000);

  it("an unshielded session (app, orchestrator, `ut claude`) never gets the server's runtime either (2026-10-24)", async () => {
    // The doctor found it in plain sessions too: every session goes through createSession.
    controlPath = markedTempDir('/tmp/ut-sh-');
    const saved = { NODE_ENV: process.env.NODE_ENV, script: process.env.npm_lifecycle_script };
    process.env.NODE_ENV = 'development';
    process.env.npm_lifecycle_script = 'node scripts/dev.js --local-auth-token secret';
    const manager = new PtyManager(controlPath);
    managers.push(manager);
    let sessionId: string;
    try {
      ({ sessionId } = await manager.createSession(
        ['sh', '-c', 'echo "env:${NODE_ENV-unset}:${npm_lifecycle_script-unset}"; exec sleep 60'],
        { sessionId: 'plain-env', workingDir: '/tmp', cols: 80, rows: 24 }
      ));
    } finally {
      process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.script === undefined) delete process.env.npm_lifecycle_script;
      else process.env.npm_lifecycle_script = saved.script;
    }
    const stdout = path.join(controlPath, sessionId, 'stdout');
    const read = () => (fs.existsSync(stdout) ? fs.readFileSync(stdout, 'utf8') : '');
    const deadline = Date.now() + 10_000;
    while (!/env:[^$]/.test(read()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(read()).toContain('env:unset:unset');
    await manager.killSession(sessionId);
  }, 20_000);

  it('giving up on a client that keeps exiting ends the program too (2026-10-20)', async () => {
    // It recorded the session as ended by its program while Claude kept running in tmux:
    // "Resume Claude" then started a second writer of the conversation.
    controlPath = markedTempDir('/tmp/ut-sh-');
    const manager = new PtyManager(controlPath);
    managers.push(manager);
    const { sessionId } = await manager.createSession(['sh', '-c', 'exec sleep 60'], {
      sessionId: 'shield-giveup',
      workingDir: '/tmp',
      cols: 80,
      rows: 24,
      shielded: true,
    });
    const shield = new ShieldTmux(controlPath);
    const internal = manager.getInternalSession(sessionId);
    expect(internal).toBeDefined();
    if (internal) internal.shieldReattachTimes = Array(5).fill(Date.now());
    const exited = new Promise((resolve) => manager.once('sessionExited', resolve));
    process.kill(manager.getSession(sessionId)?.pid as number, 'SIGKILL');
    await exited;
    expect(await shield.has(sessionId)).toBe(false);
    const info = manager.getSession(sessionId);
    expect(info?.status).toBe('exited');
    expect(info?.shieldEnd).toBe('restore-failed');
    // 2026-11-02: timed out in 7 merge checks. Not slowness: the probe after the kill met the
    // tmux server exiting (its last session was gone) and read "unknown", so the session was
    // left running with no client and sessionExited never came (ShieldTmux.probe asks again
    // now). The budget still covers has-session, kill-session and the probe under load.
  }, 60_000);

  /** Server goes down (its client dies), then the whole tmux server: a Mac reboot. */
  async function simulateReboot(manager: PtyManager, sessionIds: string[]) {
    setShuttingDown(true);
    try {
      const exits: Promise<void>[] = [];
      for (const id of sessionIds) {
        const pid = manager.getSession(id)?.pid;
        if (!pid) continue;
        exits.push(clientExited(manager, id));
        process.kill(pid, 'SIGKILL');
      }
      await Promise.all(exits);
    } finally {
      setShuttingDown(false);
    }
    try {
      execFileSync(tmux as string, [...shieldSocketArgs(controlPath), 'kill-server'], {
        stdio: 'ignore',
      });
    } catch {
      // Already gone.
    }
  }

  it('recreates running sessions after a reboot, but not the one the user killed', async () => {
    controlPath = markedTempDir('/tmp/ut-sh-');
    const binDir = markedTempDir('/tmp/ut-bin-');
    const argsFile = path.join(binDir, 'args');
    // A fake `claude` that records its arguments: the real one is never run.
    fs.writeFileSync(
      path.join(binDir, 'claude'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argsFile}'\necho fake-claude "$@"\nexec sleep 60\n`,
      { mode: 0o755 }
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath}`;
    try {
      const first = new PtyManager(controlPath);
      managers.push(first);
      const shell = await first.createSession(['sh', '-c', 'echo antes; exec sleep 60'], {
        sessionId: 'shield-shell',
        name: 'mi shell',
        workingDir: '/tmp',
        cols: 80,
        rows: 24,
        shielded: true,
      });
      const claude = await first.createSession(
        [path.join(binDir, 'claude'), '--dangerously-skip-permissions'],
        { sessionId: 'shield-claude', workingDir: binDir, cols: 80, rows: 24, shielded: true }
      );
      first.setClaudeSessionId(claude.sessionId, 'conv-123');
      const killed = await first.createSession(['sh', '-c', 'exec sleep 60'], {
        sessionId: 'shield-killed',
        workingDir: '/tmp',
        cols: 80,
        rows: 24,
        shielded: true,
      });
      // Both programs ran before the "reboot": the fake claude wrote its args and the shell
      // its output (2026-11-02: waited on, instead of a fixed 500 ms).
      const launches = () =>
        fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n') : [];
      const shellCast = path.join(controlPath, shell.sessionId, 'stdout');
      await vi.waitFor(() => {
        expect(launches()).toHaveLength(1);
        expect(fs.readFileSync(shellCast, 'utf8')).toContain('antes');
      }, WAIT);
      await first.killSession(killed.sessionId);
      await simulateReboot(first, [shell.sessionId, claude.sessionId]);
      const shield = new ShieldTmux(controlPath);
      expect(await shield.has(shell.sessionId)).toBe(false);

      const second = new PtyManager(controlPath);
      managers.push(second);
      const result = await second.reattachShieldedSessions();
      expect(result.restored.sort()).toEqual(['shield-claude', 'shield-shell']);
      expect(result.reattached).toEqual([]);

      const restoredShell = second.getSession(shell.sessionId);
      expect(restoredShell?.status).toBe('running');
      expect(restoredShell?.name).toBe('mi shell');
      expect(restoredShell?.restoredFrom).toBe('reboot');
      expect(restoredShell?.shieldRestores).toHaveLength(1);
      expect(await shield.has(shell.sessionId)).toBe(true);
      expect(second.getSession(killed.sessionId)?.status).toBe('exited');
      expect(second.getSession(killed.sessionId)?.shieldEnd).toBe('killed');
      expect(await shield.has(killed.sessionId)).toBe(false);

      // Both launches of the fake claude wrote their args (2026-11-02: a fixed 800 ms read the
      // file before the restored one ran, under load 17).
      for (const deadline = Date.now() + 15_000; launches().length < 2 && Date.now() < deadline; ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(launches()).toEqual([
        '--dangerously-skip-permissions',
        '--resume conv-123 --dangerously-skip-permissions',
      ]);
      const cast = fs.readFileSync(shellCast, 'utf8');
      expect(cast).toContain('antes');
      expect(cast).toContain('sesión restaurada tras reinicio');
      expect(cast.indexOf('antes')).toBeLessThan(cast.indexOf('sesión restaurada'));

      await second.killSession(shell.sessionId);
      await second.killSession(claude.sessionId);
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(binDir, RM_TEST_DIR);
    }
  }, 30_000);

  it('gives up on a session restored too often and marks it exited', async () => {
    controlPath = markedTempDir('/tmp/ut-sh-');
    const first = new PtyManager(controlPath);
    managers.push(first);
    const { sessionId } = await first.createSession(['sh', '-c', 'exec sleep 60'], {
      sessionId: 'shield-loop',
      workingDir: '/tmp',
      cols: 80,
      rows: 24,
      shielded: true,
    });
    await simulateReboot(first, [sessionId]);
    const infoPath = path.join(controlPath, sessionId, 'session.json');
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    info.shieldRestores = Array.from({ length: SHIELD_RESTORE_LIMIT }, () => Date.now() - 1000);
    fs.writeFileSync(infoPath, JSON.stringify(info));

    const second = new PtyManager(controlPath);
    managers.push(second);
    const result = await second.reattachShieldedSessions();
    expect(result.restored).toEqual([]);
    expect(result.finished).toEqual([sessionId]);
    expect(second.getSession(sessionId)?.status).toBe('exited');
    expect(second.getSession(sessionId)?.shieldEnd).toBe('restore-failed');
    expect(await new ShieldTmux(controlPath).has(sessionId)).toBe(false);
  }, 20_000);

  it('records a program that ended by itself so it is never revived', async () => {
    controlPath = markedTempDir('/tmp/ut-sh-');
    const manager = new PtyManager(controlPath);
    managers.push(manager);
    // 2026-11-02: the program ends by itself once the test says so (a file), not after a
    // fixed 0.5 s, so it is attached first and the test does not wait longer than needed.
    const go = path.join(controlPath, 'go');
    const { sessionId } = await manager.createSession(
      ['sh', '-c', `until [ -e '${go}' ]; do sleep 0.05; done`],
      { sessionId: 'shield-done', workingDir: '/tmp', cols: 80, rows: 24, shielded: true }
    );
    fs.writeFileSync(go, '');
    await vi.waitFor(() => expect(manager.getSession(sessionId)?.status).toBe('exited'), WAIT);
    const info = manager.getSession(sessionId);
    expect(info?.status).toBe('exited');
    expect(info?.shieldEnd).toBe('program-exit');
    expect(shieldStartupAction(info as Session, false)).toBe('ignore');
  }, 20_000);
  // 2026-11-10: `exitCode || 1` recorded every clean exit as 1. Real programs, real PTYs: the
  // session file, the cast's exit event and the sessionExited event all carry the same code.
  describe('the recorded exit code (2026-11-10)', () => {
    const ended = async (shielded: boolean, sessionId: string, script: string) => {
      controlPath = markedTempDir('/tmp/ut-sh-');
      const manager = new PtyManager(controlPath);
      managers.push(manager);
      const announced: Array<number | undefined> = [];
      manager.on('sessionExited', (id: string, _name: string, code?: number) => {
        if (id === sessionId) announced.push(code);
      });
      // The program ends once the test says so (a file): it is attached first.
      const go = path.join(controlPath, 'go');
      await manager.createSession(
        ['sh', '-c', `until [ -e '${go}' ]; do sleep 0.05; done; ${script}`],
        { sessionId, workingDir: '/tmp', cols: 80, rows: 24, shielded }
      );
      fs.writeFileSync(go, '');
      await vi.waitFor(() => {
        expect(manager.getSession(sessionId)?.status).toBe('exited');
        expect(announced).toHaveLength(1);
      }, WAIT);
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(controlPath, sessionId, 'session.json'), 'utf8')
      );
      // The cast is written behind a queue: under load its exit line lands after the session
      // is already 'exited', so it is waited for, never read once.
      const readCastExit = () =>
        fs
          .readFileSync(path.join(controlPath, sessionId, 'stdout'), 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('["exit"'))
          .map((line) => JSON.parse(line)[1]);
      await vi.waitFor(() => expect(readCastExit()).toHaveLength(1), WAIT);
      const castExit = readCastExit();
      return { code: onDisk.exitCode as number, announced: announced[0], castExit, manager };
    };

    for (const shielded of [false, true]) {
      const kind = shielded ? 'shielded' : 'plain';
      it(`${kind}: a clean exit is 0`, async () => {
        const result = await ended(shielded, `ec-ok-${kind}`, 'exit 0');
        expect(result.code).toBe(0);
        expect(result.announced).toBe(0);
        expect(result.castExit).toEqual([0]);
      }, 20_000);

      it(`${kind}: a failure keeps its own code`, async () => {
        const result = await ended(shielded, `ec-bad-${kind}`, 'exit 3');
        expect(result.code).toBe(3);
        expect(result.announced).toBe(3);
        expect(result.castExit).toEqual([3]);
      }, 20_000);

      it(`${kind}: ended by a signal is 128 + its number`, async () => {
        const result = await ended(shielded, `ec-sig-${kind}`, 'kill -TERM $$');
        expect(result.code).toBe(128 + os.constants.signals.SIGTERM);
        expect(result.announced).toBe(128 + os.constants.signals.SIGTERM);
      }, 20_000);
    }

    it('shielded: the exit file is taken once and "Pane is dead" never reaches the terminal', async () => {
      const result = await ended(true, 'ec-clean', 'echo adios; exit 0');
      expect(fs.existsSync(shieldExitFile(controlPath, 'ec-clean'))).toBe(false);
      const cast = fs.readFileSync(path.join(controlPath, 'ec-clean', 'stdout'), 'utf8');
      expect(cast).toContain('adios');
      expect(cast).not.toContain('Pane is dead');
      expect(result.code).toBe(0);
    }, 20_000);

    it('shielded: without a code (the session was killed, nothing was written) it is 1', async () => {
      controlPath = markedTempDir('/tmp/ut-sh-');
      const manager = new PtyManager(controlPath);
      managers.push(manager);
      const { sessionId } = await manager.createSession(['sh', '-c', 'exec sleep 60'], {
        sessionId: 'ec-killed',
        workingDir: '/tmp',
        cols: 80,
        rows: 24,
        shielded: true,
      });
      await manager.killSession(sessionId);
      await vi.waitFor(() => expect(manager.getSession(sessionId)?.status).toBe('exited'), WAIT);
      expect(manager.getSession(sessionId)?.exitCode).toBe(1);
      expect(fs.existsSync(shieldExitFile(controlPath, sessionId))).toBe(false);
    }, 20_000);

    it('shielded: a program that ended while no server ran is marked with its own code at the next start', async () => {
      controlPath = markedTempDir('/tmp/ut-sh-');
      const first = new PtyManager(controlPath);
      managers.push(first);
      const go = path.join(controlPath, 'go');
      const { sessionId } = await first.createSession(
        ['sh', '-c', `until [ -e '${go}' ]; do sleep 0.05; done; exit 7`],
        { sessionId: 'ec-away', workingDir: '/tmp', cols: 80, rows: 24, shielded: true }
      );
      // The server goes down; the program ends meanwhile.
      await clientsGoWithServer(first);
      managers.splice(managers.indexOf(first), 1);
      fs.writeFileSync(go, '');
      const shield = new ShieldTmux(controlPath);
      await vi.waitFor(async () => expect(await shield.has(sessionId)).toBe(false), WAIT);
      expect(fs.readFileSync(shieldExitFile(controlPath, sessionId), 'utf8')).toBe('7 \n');
      // Recorded as ended by itself (as a dying server may have left it): marked, not restored.
      const second = new PtyManager(controlPath);
      managers.push(second);
      const file = path.join(controlPath, sessionId, 'session.json');
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...info, shieldEnd: 'program-exit' }));
      const result = await second.reattachShieldedSessions();
      expect(result.finished).toEqual([sessionId]);
      expect(second.getSession(sessionId)?.exitCode).toBe(7);
      expect(fs.existsSync(shieldExitFile(controlPath, sessionId))).toBe(false);
    }, 20_000);
  });
});

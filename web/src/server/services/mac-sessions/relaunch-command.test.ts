import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAC_SHARE_CORPUS } from '../../../test/fixtures/mac-share-corpus.js';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import { findShells, type TestShell } from '../../../test/helpers/test-shells.js';
import {
  buildRelaunchCommand,
  MAX_RELAUNCH_LINE_BYTES,
  type RelaunchFs,
  type RelaunchInput,
  realRelaunchFs,
} from './relaunch-command.js';

const ID = '0b402254-352f-4532-b05e-1186d66e984a';
const HOME_CONTROL = '/Users/u/.untether/control';
/** What the ut and claude stand-ins print last: no corpus value or argv word is this. */
const LINE_END = '<ut-line-end>';

/** A filesystem where only `files` are executables and `dirs` folders; it records each ask. */
function fakeFs(files: string[] = [], dirs: string[] = ['/Users/u/My Project']) {
  const asked: string[] = [];
  const fsx: RelaunchFs = {
    isExecutableFile: (file) => {
      asked.push(file);
      return files.includes(file);
    },
    isDirectory: (dir) => {
      asked.push(dir);
      return dirs.includes(dir);
    },
  };
  return { fsx, asked };
}

function input(overrides: Partial<RelaunchInput> = {}): RelaunchInput {
  return {
    agent: 'claude',
    args: 'claude --dangerously-skip-permissions',
    conversationId: ID,
    cwd: '/Users/u/My Project',
    shell: '-zsh',
    launcher: 'ut',
    controlDir: HOME_CONTROL,
    defaultControlDir: HOME_CONTROL,
    ...overrides,
  };
}

function build(overrides: Partial<RelaunchInput> = {}, fsx = fakeFs().fsx) {
  return buildRelaunchCommand(input(overrides), fsx);
}

function command(overrides: Partial<RelaunchInput> = {}, fsx = fakeFs().fsx): string {
  const result = build(overrides, fsx);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.command;
}

describe('relaunch line: the agent word (R-BIN)', () => {
  it('a bare name is typed bare, and only the folder is looked at: no PATH or npm lookup', () => {
    const { fsx, asked } = fakeFs();
    expect(command({}, fsx)).toBe(
      `cd '/Users/u/My Project' && ut claude --resume '${ID}' --dangerously-skip-permissions`
    );
    expect(asked).toEqual(['/Users/u/My Project']);
  });

  it('an absolute path that still exists is typed quoted, spaces included', () => {
    const bin = '/Users/u/Apps and Tools/claude';
    const { fsx, asked } = fakeFs([bin]);
    expect(command({ args: `${bin} --verbose` }, fsx)).toBe(
      `cd '/Users/u/My Project' && ut '${bin}' --resume '${ID}' --verbose`
    );
    // Only runs of its own words were looked at, longest first: nothing found elsewhere.
    const args = `${bin} --verbose`;
    expect(asked.every((p) => p === '/Users/u/My Project' || args.startsWith(p))).toBe(true);
  });

  it('a versioned path an update removed becomes the command name, for the tab to resolve', () => {
    const result = build({ args: '/Users/u/.local/share/claude/versions/2.1.287 --verbose' });
    expect(result).toMatchObject({
      ok: true,
      agentWord: 'claude',
      command: `cd '/Users/u/My Project' && ut claude --resume '${ID}' --verbose`,
    });
  });

  it('a relative path or an odd word is not typed: the command name is', () => {
    expect(build({ args: './claude --verbose' })).toMatchObject({ ok: true, agentWord: 'claude' });
    expect(build({ args: '$(id) --verbose' })).toMatchObject({ ok: true, agentWord: 'claude' });
    expect(build({ args: 'claude-dev --verbose' })).toMatchObject({
      ok: true,
      agentWord: 'claude-dev',
    });
  });

  it('the real filesystem only stats: it never runs what it finds', () => {
    // /bin/sleep stands in for an agent binary: had it been run, this would take 60 s.
    const started = Date.now();
    const result = buildRelaunchCommand(
      input({ args: '/bin/sleep 60', cwd: os.tmpdir() }),
      realRelaunchFs
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ ok: true, agentWord: '/bin/sleep' });
  });

  describe('with the shell launcher, a path to the agent itself is typed as its name', () => {
    const shellLine = (agent: string) =>
      `[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ] && source "\${ZDOTDIR:-$HOME}/.zshrc"; cd '/Users/u/My Project' && ${agent} --resume '${ID}' --verbose`;

    it('a file named claude: the user function that wraps it with ut still runs', () => {
      const bin = '/Users/u/.local/bin/claude';
      const result = build({ args: `${bin} --verbose`, launcher: 'shell' }, fakeFs([bin]).fsx);
      expect(result).toMatchObject({ ok: true, agentWord: 'claude', command: shellLine('claude') });
    });

    it('a versioned Claude binary that still exists', () => {
      const bin = '/Users/u/.local/share/claude/versions/2.1.288';
      const result = build({ args: `${bin} --verbose`, launcher: 'shell' }, fakeFs([bin]).fsx);
      expect(result).toMatchObject({ ok: true, agentWord: 'claude', command: shellLine('claude') });
    });

    it('the ut launcher keeps the exact path: ut runs that file', () => {
      const bin = '/Users/u/.local/share/claude/versions/2.1.288';
      expect(command({ args: `${bin} --verbose` }, fakeFs([bin]).fsx)).toBe(
        `cd '/Users/u/My Project' && ut '${bin}' --resume '${ID}' --verbose`
      );
    });

    it('a path to some other program keeps its path, quoted', () => {
      const bin = '/Users/u/Apps and Tools/claude-dev';
      const result = build({ args: `${bin} --verbose`, launcher: 'shell' }, fakeFs([bin]).fsx);
      expect(result).toMatchObject({ ok: true, agentWord: bin, command: shellLine(`'${bin}'`) });
    });

    it('a versions folder of another tool is not taken for Claude', () => {
      const bin = '/Users/u/.local/share/other/versions/2.1.288';
      const result = build({ args: `${bin} --verbose`, launcher: 'shell' }, fakeFs([bin]).fsx);
      expect(result).toMatchObject({ ok: true, agentWord: bin });
    });
  });
});

describe('relaunch line: options carried over', () => {
  it("the owner's shape: the duplicated flag once, the old resume dropped silently", () => {
    const result = build({
      args: `claude --dangerously-skip-permissions --resume ${ID} --dangerously-skip-permissions`,
    });
    expect(result).toEqual({
      ok: true,
      command: `cd '/Users/u/My Project' && ut claude --resume '${ID}' --dangerously-skip-permissions`,
      shell: 'zsh',
      agentWord: 'claude',
      kept: ['--dangerously-skip-permissions'],
      dropped: [],
      droppedPrompt: false,
      warnings: [],
    });
  });

  it('a launch prompt and -w name are dropped; the prompt is not listed by its text', () => {
    const result = build({ args: 'claude -w feature --verbose say hi in one word' });
    expect(result).toMatchObject({
      ok: true,
      kept: ['--verbose'],
      dropped: ['-w'],
      droppedPrompt: true,
      warnings: ['flags-dropped'],
    });
    expect(result.ok && result.command).not.toContain('say');
    expect(result.ok && result.command).not.toContain('feature');
  });

  it('plain values are kept and quoted; brackets too (zsh globs)', () => {
    expect(command({ args: 'claude --model claude-opus-5-5[1m] --permission-mode plan' })).toBe(
      `cd '/Users/u/My Project' && ut claude --resume '${ID}' --model 'claude-opus-5-5[1m]' --permission-mode 'plan'`
    );
    expect(command({ args: 'claude --model=opus --effort high' })).toContain(
      "--model 'opus' --effort 'high'"
    );
    // Repeats with different values are all kept, identical ones once.
    expect(command({ args: 'claude --plugin-dir /a --plugin-dir /b --plugin-dir /a' })).toContain(
      "--plugin-dir '/a' --plugin-dir '/b'"
    );
  });

  it('values that are not one plain token are dropped and listed', () => {
    const cases: Array<[string, string[], string[]]> = [
      ['claude --model $(id)', [], ['--model']],
      ['claude --model', [], ['--model']],
      ['claude --model --verbose', ['--verbose'], ['--model']],
      ['claude --agent https://x.example/a', [], ['--agent']],
      ["claude --model it's", [], ['--model']],
    ];
    for (const [args, kept, dropped] of cases) {
      expect(build({ args }), args).toMatchObject({ ok: true, kept, dropped });
    }
  });

  it('free text is dropped with its words, listed, and flagged as inexact', () => {
    const result = build({
      args: 'claude --append-system-prompt be brief and kind --add-dir /a /b --verbose',
    });
    expect(result).toMatchObject({
      ok: true,
      kept: ['--verbose'],
      dropped: ['--append-system-prompt', '--add-dir'],
      droppedPrompt: false,
      warnings: ['flags-dropped', 'argv-inexact'],
    });
  });

  it('an unknown option is dropped with the word after it, which may be its value', () => {
    expect(build({ args: 'claude --foo bar --verbose' })).toMatchObject({
      ok: true,
      kept: ['--verbose'],
      dropped: ['--foo'],
      droppedPrompt: false,
    });
    expect(build({ args: 'claude --verbose=yes -x' })).toMatchObject({
      kept: [],
      dropped: ['--verbose', '-x'],
    });
  });

  it('modes never come back: print, background, tmux, teleport, debug file', () => {
    expect(
      build({ args: 'claude -p --bg --tmux=classic --teleport --debug-file /tmp/x --verbose' })
    ).toMatchObject({
      ok: true,
      kept: ['--verbose'],
      dropped: ['-p', '--bg', '--tmux', '--teleport', '--debug-file'],
    });
    expect(build({ args: `claude -c --session-id ${ID} --fork-session` })).toMatchObject({
      ok: true,
      kept: [],
      dropped: [],
      droppedPrompt: false,
    });
  });

  it('everything after -- is a prompt', () => {
    expect(build({ args: 'claude --verbose -- --model x' })).toMatchObject({
      kept: ['--verbose'],
      droppedPrompt: true,
    });
  });
});

describe('relaunch line: shells, launchers and the control dir', () => {
  const cases: Array<[string, Partial<RelaunchInput>, string]> = [
    ['zsh, ut', {}, `cd '/Users/u/My Project' && ut claude --resume '${ID}' --verbose`],
    [
      'zsh, shell',
      { launcher: 'shell' },
      `[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ] && source "\${ZDOTDIR:-$HOME}/.zshrc"; cd '/Users/u/My Project' && claude --resume '${ID}' --verbose`,
    ],
    [
      'zsh, ut, QA control dir',
      { controlDir: "/Users/u/.untether-qa/it's" },
      `cd '/Users/u/My Project' && UNTETHER_CONTROL_DIR='/Users/u/.untether-qa/it'\\''s' ut claude --resume '${ID}' --verbose`,
    ],
    [
      'zsh, shell, QA control dir',
      { launcher: 'shell', controlDir: '/qa/control' },
      `[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ] && source "\${ZDOTDIR:-$HOME}/.zshrc"; cd '/Users/u/My Project' && UNTETHER_CONTROL_DIR='/qa/control' claude --resume '${ID}' --verbose`,
    ],
    [
      'bash, ut path',
      { shell: '-bash', utPath: '/opt/ut tools/ut' },
      `cd '/Users/u/My Project' && '/opt/ut tools/ut' claude --resume '${ID}' --verbose`,
    ],
    [
      'bash, shell',
      { shell: '/bin/bash', launcher: 'shell' },
      `[ -f ~/.bashrc ] && source ~/.bashrc; cd '/Users/u/My Project' && claude --resume '${ID}' --verbose`,
    ],
    [
      'bash, ut, QA control dir',
      { shell: '-bash', controlDir: '/qa/control' },
      `cd '/Users/u/My Project' && UNTETHER_CONTROL_DIR='/qa/control' ut claude --resume '${ID}' --verbose`,
    ],
    [
      'fish, ut',
      { shell: '/opt/homebrew/bin/fish', cwd: "/Users/u/it's\\here" },
      `cd '/Users/u/it\\'s\\\\here' && ut claude --resume '${ID}' --verbose`,
    ],
    [
      'fish, shell, QA control dir',
      { shell: '-fish', launcher: 'shell', controlDir: '/qa/control' },
      `test -f ~/.config/fish/config.fish && source ~/.config/fish/config.fish; cd '/Users/u/My Project' && UNTETHER_CONTROL_DIR='/qa/control' claude --resume '${ID}' --verbose`,
    ],
  ];
  for (const [label, overrides, expected] of cases) {
    it(label, () => {
      const dirs = ['/Users/u/My Project', "/Users/u/it's\\here"];
      expect(command({ args: 'claude --verbose', ...overrides }, fakeFs([], dirs).fsx)).toBe(
        expected
      );
    });
  }

  it('the default control dir, however spelled, adds no prefix', () => {
    expect(command({ controlDir: `${HOME_CONTROL}/` })).not.toContain('UNTETHER_CONTROL_DIR');
  });
});

describe('relaunch line: refusals', () => {
  it('other agents, a bad id, other shells', () => {
    expect(build({ agent: 'gemini' })).toEqual({ ok: false, error: 'agent-not-supported' });
    // 2026-11-11: Codex was prepared behind a setting (macShareCodex) that the share itself
    // refused; the setting and the preparation are gone, and Codex is refused here too.
    expect(build({ agent: 'codex', args: 'codex --search' })).toEqual({
      ok: false,
      error: 'agent-not-supported',
    });
    for (const conversationId of ['', 'abc', `${ID}'`, ID.toUpperCase()]) {
      expect(build({ conversationId })).toEqual({ ok: false, error: 'no-conversation' });
    }
    expect(build({ shell: '-tcsh' })).toEqual({
      ok: false,
      error: 'unsupported-shell',
      shellName: 'tcsh',
    });
    expect(build({ shell: '/bin/sh' })).toMatchObject({ error: 'unsupported-shell' });
  });

  it('a folder that is gone or relative', () => {
    expect(build({ cwd: '/Users/u/gone' })).toEqual({ ok: false, error: 'cwd-missing' });
    expect(build({ cwd: 'My Project' })).toEqual({ ok: false, error: 'cwd-missing' });
  });

  it('control characters, :// and a line that is too long', () => {
    for (const cwd of ['/Users/u/a\nb', '/Users/u/a\u001bb', '/Users/u/a b', '/x/http://y']) {
      expect(build({ cwd }, fakeFs([], [cwd]).fsx), JSON.stringify(cwd)).toEqual({
        ok: false,
        error: 'unsafe-value',
      });
    }
    expect(build({ controlDir: '/qa/\ncontrol' })).toEqual({ ok: false, error: 'unsafe-value' });
    expect(build({ utPath: 'bin/ut' })).toEqual({ ok: false, error: 'unsafe-value' });
    const long = `/Users/u/${'x'.repeat(MAX_RELAUNCH_LINE_BYTES)}`;
    expect(build({ cwd: long }, fakeFs([], [long]).fsx)).toEqual({
      ok: false,
      error: 'unsafe-value',
    });
  });
});

describe('relaunch line through real shells', () => {
  let base: string;
  let bin: string;
  const shells: TestShell[] = findShells().filter((shell) =>
    ['zsh', 'bash', 'fish'].includes(shell.label)
  );

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-relaunch-test-')));
    bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    // Stand-ins for ut and claude: they print where they run, the control dir and their argv,
    // then LINE_END, so the lines one shell runs are told apart. 2026-11-02: `${0##*/}` instead
    // of `$(basename "$0")`, one process less per line.
    const printer = `#!/bin/sh\nprintf '%s\\0' "$PWD" "\${UNTETHER_CONTROL_DIR-unset}" "\${0##*/}" "$@" '${LINE_END}'\n`;
    for (const name of ['ut', 'claude']) {
      fs.writeFileSync(path.join(bin, name), printer, { mode: 0o755 });
    }
  });

  afterAll(() => {
    if (base?.includes('ut-relaunch-test-')) fs.rmSync(base, RM_TEST_DIR);
  });

  /**
   * Runs `lines` one after the other in one shell (2026-11-02: one shell per corpus value was
   * ~500 spawns, 5-6 s). Each line starts with its own absolute `cd`, and a line that broke
   * the parsing of the next one, or never reached the stand-in, shows up as a missing or wrong
   * group.
   */
  function runLines(shell: TestShell, lines: string[], interactive: boolean): string[][] {
    const script = lines.map((line) => `${line}\n`).join('');
    const groups: string[][] = [[]];
    for (const part of runLine(shell, script, interactive)) {
      if (part === LINE_END) groups.push([]);
      else groups[groups.length - 1].push(part);
    }
    groups.pop();
    return groups;
  }

  function runLine(shell: TestShell, line: string, interactive: boolean): string[] {
    const env = {
      HOME: base,
      ZDOTDIR: base,
      PATH: `${bin}:/usr/bin:/bin`,
      LC_ALL: 'en_US.UTF-8',
      TERM: 'dumb',
    };
    const result = interactive
      ? spawnSync(shell.bin, [...shell.flags, '-i'], { input: `${line}\nexit\n`, env, cwd: base })
      : spawnSync(shell.bin, [...shell.flags, '-c', line], { env, cwd: base });
    const parts = result.stdout.toString('utf8').split('\0');
    parts.pop();
    return parts;
  }

  /** The corpus as folder names under `base`; names the filesystem refuses are skipped. */
  function folders(): string[] {
    const made: string[] = [];
    for (const name of MAC_SHARE_CORPUS) {
      const dir = path.join(base, 'w', name.startsWith('/') ? name.slice(1) : name);
      if (dir.length > 1000 || name.includes('..')) continue;
      try {
        fs.mkdirSync(dir, { recursive: true });
        made.push(dir);
      } catch {
        // Too long for the filesystem.
      }
    }
    return made;
  }

  it('finds zsh and bash at least', () => {
    expect(shells.length).toBeGreaterThanOrEqual(2);
  });

  for (const shell of shells) {
    for (const interactive of [false, true]) {
      for (const launcher of ['ut', 'shell'] as const) {
        it(`${shell.label}${interactive ? ' typed' : ' -c'}, ${launcher}: cd and argv come through exactly`, () => {
          const dirs = folders();
          expect(dirs.length).toBeGreaterThan(MAC_SHARE_CORPUS.length - 3);
          const controlDirOf = (cwd: string) => `/qa/${path.basename(cwd)}/control`;
          const lines = dirs.map((cwd) => {
            const result = buildRelaunchCommand(
              input({
                shell: shell.bin,
                launcher,
                cwd,
                controlDir: controlDirOf(cwd),
                args: 'claude --model claude-opus-5-5[1m] --dangerously-skip-permissions --model=x:y',
              }),
              realRelaunchFs
            );
            if (!result.ok) throw new Error(`${cwd}: ${result.error}`);
            return result.command;
          });
          const printed = runLines(shell, lines, interactive);
          const program = launcher === 'ut' ? ['ut', 'claude'] : ['claude'];
          for (const [i, cwd] of dirs.entries()) {
            const controlDir = controlDirOf(cwd);
            expect(printed[i], JSON.stringify(cwd)).toEqual([
              cwd,
              controlDir,
              ...program,
              '--resume',
              ID,
              '--model',
              'claude-opus-5-5[1m]',
              '--dangerously-skip-permissions',
              '--model',
              'x:y',
            ]);
          }
          expect(printed).toHaveLength(dirs.length);
        });
      }
    }

    if (shell.label !== 'fish') {
      it(`${shell.label}, shell launcher: the startup file is read first, so its function runs`, () => {
        const home = path.join(base, `home-${shell.label}`);
        fs.mkdirSync(home, { recursive: true });
        const rc = shell.label === 'zsh' ? '.zshrc' : '.bashrc';
        // The user's wrapper, as a function of the same name (the owner's setup, in short).
        fs.writeFileSync(path.join(home, rc), 'claude() { printf \'%s\\0\' wrapped "$@"; }\n');
        const result = buildRelaunchCommand(
          input({ shell: shell.bin, launcher: 'shell', cwd: base, args: 'claude --verbose' }),
          realRelaunchFs
        );
        if (!result.ok) throw new Error(result.error);
        const env = { HOME: home, ZDOTDIR: home, PATH: `${bin}:/usr/bin:/bin`, TERM: 'dumb' };
        const out = spawnSync(shell.bin, [...shell.flags, '-c', result.command], {
          env,
          cwd: base,
        });
        expect(out.stdout.toString('utf8').split('\0').slice(0, -1)).toEqual([
          'wrapped',
          '--resume',
          ID,
          '--verbose',
        ]);
      });
    }

    it(`${shell.label}: the injection canary prints literally and runs nothing`, () => {
      const names = [
        "x'; touch CANARY1; echo '",
        'x$(touch CANARY2)',
        'x`touch CANARY3`',
        'x"; touch CANARY4; echo "',
        "x\\'; touch CANARY5; echo \\'",
      ];
      for (const name of names) {
        const cwd = path.join(base, 'canary', name);
        fs.mkdirSync(cwd, { recursive: true });
        const result = buildRelaunchCommand(
          input({ shell: shell.bin, cwd, args: 'claude' }),
          realRelaunchFs
        );
        if (!result.ok) throw new Error(result.error);
        for (const interactive of [false, true]) {
          expect(runLine(shell, result.command, interactive)[0], name).toBe(cwd);
        }
      }
      const created = spawnSync('find', [base, '-name', 'CANARY*'], { encoding: 'utf8' }).stdout;
      expect(created).toBe('');
    });
  }
});

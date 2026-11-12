import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAC_SHARE_CORPUS, MAC_SHARE_REJECTED } from '../../../test/fixtures/mac-share-corpus.js';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import { findShells, type TestShell } from '../../../test/helpers/test-shells.js';
import {
  quoteFish,
  quotePosix,
  shellFromArg0,
  UnsafeValueError,
  unsafeReason,
} from './shell-quote.js';

let home: string;

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-shell-quote-test-')));
});

afterAll(() => {
  if (home?.includes('ut-shell-quote-test-')) fs.rmSync(home, RM_TEST_DIR);
});

function env(): NodeJS.ProcessEnv {
  return { HOME: home, PATH: '/usr/bin:/bin', LC_ALL: 'en_US.UTF-8', TERM: 'dumb' };
}

/** Runs `script` with `-c`, or typed line by line into an interactive shell. */
function run(shell: TestShell, script: string, interactive = false): Buffer {
  const result = interactive
    ? spawnSync(shell.bin, [...shell.flags, '-i'], {
        input: `${script}\nexit\n`,
        env: env(),
        cwd: home,
      })
    : spawnSync(shell.bin, [...shell.flags, '-c', script], { env: env(), cwd: home });
  return result.stdout;
}

function split(output: Buffer): string[] {
  const parts = output.toString('utf8').split('\0');
  parts.pop();
  return parts;
}

describe('quoting', () => {
  it('wraps in single quotes and closes them around each quote', () => {
    expect(quotePosix('plain')).toBe("'plain'");
    expect(quotePosix("it's")).toBe("'it'\\''s'");
    expect(quotePosix("''")).toBe("''\\'''\\'''");
    expect(quotePosix('')).toBe("''");
    expect(quoteFish("it's")).toBe("'it\\'s'");
    expect(quoteFish('a\\b')).toBe("'a\\\\b'");
  });

  it('never leaves two quotes next to each other inside a quoted span (zsh RC_QUOTES)', () => {
    for (const value of MAC_SHARE_CORPUS) {
      const quoted = quotePosix(value).slice(1, -1);
      // Inside, every quote belongs to a '\'' sequence.
      expect(quoted.replaceAll("'\\''", ''), value).not.toContain("'");
    }
  });

  it('refuses control characters, line separators and lone surrogates', () => {
    for (const value of MAC_SHARE_REJECTED) {
      expect(unsafeReason(value), JSON.stringify(value)).toBeDefined();
      expect(() => quotePosix(value)).toThrow(UnsafeValueError);
      expect(() => quoteFish(value)).toThrow(UnsafeValueError);
    }
    expect(unsafeReason('a\uD800b')).toBe('surrogate');
    expect(unsafeReason('a\tb')).toBe('control');
    for (const value of MAC_SHARE_CORPUS) {
      expect(unsafeReason(value), value).toBeUndefined();
    }
  });

  it("names the tab's shell from its args[0]", () => {
    expect(shellFromArg0('-zsh')).toEqual({ shell: 'zsh', name: 'zsh' });
    expect(shellFromArg0('/bin/zsh -l')).toEqual({ shell: 'zsh', name: 'zsh' });
    expect(shellFromArg0('-bash')).toEqual({ shell: 'bash', name: 'bash' });
    expect(shellFromArg0('/opt/homebrew/bin/fish')).toEqual({ shell: 'fish', name: 'fish' });
    expect(shellFromArg0('-tcsh')).toEqual({ name: 'tcsh' });
    expect(shellFromArg0('/bin/sh')).toEqual({ name: 'sh' });
    expect(shellFromArg0('/x/<b>evil$(id)')).toEqual({ name: 'bevilid' });
  });
});

describe('quoting through real shells', () => {
  const shells = findShells();

  it('finds zsh and bash at least', () => {
    expect(shells.map((shell) => shell.label)).toEqual(expect.arrayContaining(['zsh', 'bash']));
  });

  for (const shell of shells) {
    const quote = shell.fish ? quoteFish : quotePosix;
    const line = `printf '%s\\0' ${MAC_SHARE_CORPUS.map(quote).join(' ')}`;

    it(`${shell.label} -c gives every corpus value back byte for byte`, () => {
      const back = split(run(shell, line));
      expect(back).toHaveLength(MAC_SHARE_CORPUS.length);
      MAC_SHARE_CORPUS.forEach((value, i) => {
        expect(Buffer.from(back[i]).toString('hex'), value).toBe(
          Buffer.from(value).toString('hex')
        );
      });
    });
  }

  for (const shell of shells.filter((candidate) => ['zsh', 'bash'].includes(candidate.label))) {
    it(`${shell.label} typed interactively, with history expansion on`, () => {
      // The control: unquoted, `!!` is expanded, so the check below means something.
      expect(split(run(shell, "printf '%s\\0' first\nprintf '%s\\0' !!", true))).toEqual([
        'first',
        'printf',
        '%s\\0',
        'first',
      ]);
      const line = `printf '%s\\0' ${MAC_SHARE_CORPUS.map(quotePosix).join(' ')}`;
      expect(split(run(shell, `printf '%s\\0' warm-up\n${line}`, true)).slice(1)).toEqual([
        ...MAC_SHARE_CORPUS,
      ]);
    });
  }

  it('zsh with RC_QUOTES, EXTENDED_GLOB and NO_NOMATCH changes nothing', () => {
    const zsh = shells.find((shell) => shell.label === 'zsh');
    if (!zsh) throw new Error('zsh missing');
    const options = 'setopt RC_QUOTES EXTENDED_GLOB NO_NOMATCH EQUALS';
    // The control: with RC_QUOTES, '' inside quotes is a quote.
    expect(split(run(zsh, `${options}\nprintf '%s\\0' 'a''b'`, true))).toEqual(["a'b"]);
    const line = `printf '%s\\0' ${MAC_SHARE_CORPUS.map(quotePosix).join(' ')}`;
    expect(split(run(zsh, `${options}\n${line}`, true))).toEqual([...MAC_SHARE_CORPUS]);
  });
});

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import {
  COMMAND_FILE_TTL_MS,
  type CommandFileFs,
  commandFileText,
  NEW_WINDOW_APP,
  newWindowCommand,
  openEnv,
  openInNewWindow,
  shellPathFor,
  writeCommandFile,
} from './new-window.js';

/** Values a folder or a relaunch line may hold: every one must come back byte for byte. */
const CORPUS = [
  'plain',
  'with space',
  "it's",
  "''",
  '"double"',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell text, never expanded here
  '$HOME ${HOME} $(id) `id`',
  '!! !$ ^a^b',
  '* ? [a-z] {a,b}',
  'back\\slash \\\\',
  '~ ~root =ls',
  'semi; colon && amp | pipe > redirect < in',
  '-n',
  '--',
  'ünïcödé 名前 🚀',
  '#hash',
  '\u202eRTL',
];

class MemoryFs implements CommandFileFs {
  files = new Map<string, { text: string; mode: number }>();
  dirs = new Map<string, number>();
  chmods: Array<[string, number]> = [];
  failWrite = false;
  private n = 0;
  async mkdtemp(prefix: string) {
    const dir = `${prefix}${String(++this.n).padStart(6, 'x')}`;
    this.dirs.set(dir, 0o700);
    return dir;
  }
  async writeFile(file: string, text: string, options: { mode: number; flag: string }) {
    if (this.failWrite) throw new Error('disk full');
    if (options.flag !== 'wx' || this.files.has(file)) throw new Error('must be a new file');
    this.files.set(file, { text, mode: options.mode });
  }
  async chmod(file: string, mode: number) {
    this.chmods.push([file, mode]);
  }
  async unlink(file: string) {
    if (!this.files.delete(file)) throw new Error('ENOENT');
  }
  async rmdir(dir: string) {
    if ([...this.files.keys()].some((file) => file.startsWith(`${dir}/`))) {
      throw new Error('ENOTEMPTY');
    }
    this.dirs.delete(dir);
  }
}

describe('new window: the command', () => {
  it('cd, then exec the shell with -lic and the relaunch line, all quoted', () => {
    expect(newWindowCommand('/Users/u/My Project', '/bin/zsh', "cd '/x' && ut claude")).toBe(
      `cd '/Users/u/My Project' && exec /bin/zsh -lic 'cd '\\''/x'\\'' && ut claude'`
    );
    // A shell path that isn't a plain word is quoted too.
    expect(newWindowCommand('/a', '/opt/my shells/zsh', 'x')).toBe(
      `cd '/a' && exec '/opt/my shells/zsh' -lic 'x'`
    );
  });

  it('refuses control characters, as the typed line does', () => {
    expect(() => newWindowCommand('/a\nb', '/bin/zsh', 'x')).toThrow();
    expect(() => newWindowCommand('/a', '/bin/zsh', 'x\ry')).toThrow();
  });

  it('the file: a shebang, then it deletes itself, then the one line', () => {
    const text = commandFileText('echo hi');
    expect(text.split('\n')).toEqual(['#!/bin/sh', 'rm -f -- "$0"', 'echo hi', '']);
    expect(() => commandFileText('a\nb')).toThrow();
  });

  it('iTerm2 agents reopen in Terminal (QA: iTerm2 never ran the file)', () => {
    expect(NEW_WINDOW_APP).toEqual({ Terminal: 'Terminal', iTerm: 'Terminal' });
  });
});

describe('new window: the shell path', () => {
  const exists =
    (...files: string[]) =>
    (file: string) =>
      files.includes(file);

  it('its own absolute args[0] first, then the login shell, then the usual place', () => {
    expect(
      shellPathFor('zsh', '/opt/homebrew/bin/zsh', exists('/opt/homebrew/bin/zsh', '/bin/zsh'))
    ).toBe('/opt/homebrew/bin/zsh');
    expect(
      shellPathFor('zsh', '-zsh', exists('/usr/local/bin/zsh', '/bin/zsh'), '/usr/local/bin/zsh')
    ).toBe('/usr/local/bin/zsh');
    expect(shellPathFor('zsh', '-zsh', exists('/bin/zsh'), '/bin/bash')).toBe('/bin/zsh');
    expect(shellPathFor('bash', '-bash', exists('/bin/bash'), undefined)).toBe('/bin/bash');
    expect(shellPathFor('fish', '-fish', exists('/opt/homebrew/bin/fish'), undefined)).toBe(
      '/opt/homebrew/bin/fish'
    );
  });

  it('null when nothing of that name exists', () => {
    expect(shellPathFor('fish', '-fish', exists('/bin/zsh'), '/bin/zsh')).toBeNull();
    // A login shell of another name is never used for this one.
    expect(shellPathFor('zsh', '-zsh', exists('/bin/bash'), '/bin/bash')).toBeNull();
  });
});

describe('new window: writing and opening (fakes)', () => {
  it('a new 0700 file in a new 0700 directory under the temp dir', async () => {
    const memory = new MemoryFs();
    const written = await writeCommandFile('#!/bin/sh\n', memory, '/var/folders/T');
    expect(written.dir.startsWith('/var/folders/T/ut-share-')).toBe(true);
    expect(written.file).toBe(`${written.dir}/reopen.command`);
    expect(memory.files.get(written.file)?.mode).toBe(0o700);
    expect(memory.chmods).toEqual([
      [written.dir, 0o700],
      [written.file, 0o700],
    ]);
  });

  it('a failed write leaves nothing behind', async () => {
    const memory = new MemoryFs();
    memory.failWrite = true;
    await expect(writeCommandFile('x', memory, '/T')).rejects.toThrow('disk full');
    expect(memory.dirs.size).toBe(0);
  });

  it('`open -a Terminal <file>` once, with a clean environment, and a late cleanup', async () => {
    const memory = new MemoryFs();
    const run = vi.fn(async () => 0);
    const later = vi.fn();
    const opened = await openInNewWindow('Terminal', "cd '/a' && exec /bin/zsh -lic 'x'", {
      fs: memory,
      tmpdir: '/T',
      run,
      env: { PATH: '/usr/bin:/bin', HOME: '/Users/u' },
      later,
    });
    expect(opened).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    const [args, env] = run.mock.calls[0] as unknown as [string[], NodeJS.ProcessEnv];
    const file = [...memory.files.keys()][0];
    expect(args).toEqual(['-a', 'Terminal', file]);
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/Users/u' });
    expect(memory.files.get(file)?.text).toBe(
      `#!/bin/sh\nrm -f -- "$0"\ncd '/a' && exec /bin/zsh -lic 'x'\n`
    );
    // The late cleanup removes the file (if it never ran) and its now empty directory.
    expect(later).toHaveBeenCalledWith(expect.any(Function), COMMAND_FILE_TTL_MS);
    (later.mock.calls[0][0] as () => void)();
    await new Promise((resolve) => setImmediate(resolve));
    expect(memory.files.size).toBe(0);
    expect(memory.dirs.size).toBe(0);
  });

  it('`open` failing: false, and the file is removed at once so nothing runs it later', async () => {
    const memory = new MemoryFs();
    const opened = await openInNewWindow('iTerm', 'x', {
      fs: memory,
      tmpdir: '/T',
      run: async () => 1,
      later: () => {},
    });
    expect(opened).toBe(false);
    expect(memory.files.size).toBe(0);
    expect(memory.dirs.size).toBe(0);
  });

  it('the environment of `open`: a login’s basics only, never the server’s variables', () => {
    expect(
      openEnv({
        HOME: '/Users/u',
        USER: 'u',
        LANG: 'es_ES.UTF-8',
        PATH: '/opt/homebrew/bin:/usr/bin',
        UNTETHER_CONTROL_DIR: '/x',
        CLAUDE_CODE_CHILD_SESSION: '1',
        NODE_OPTIONS: '--inspect',
      })
    ).toEqual({
      HOME: '/Users/u',
      USER: 'u',
      LANG: 'es_ES.UTF-8',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    });
  });
});

// Real files: modes, the self-delete, and the quoting parsed by real shells. The relaunch is
// never run: the "shell" exec'd is a stub that only writes down its arguments.
describe.runIf(process.platform !== 'win32')('new window: real files', () => {
  let root: string;
  let stub: string;
  const shells = ['/bin/sh', '/bin/bash', '/bin/zsh'].filter((shell) => fs.existsSync(shell));

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-new-window-test-'));
    stub = path.join(root, 'argv-stub');
    fs.writeFileSync(
      stub,
      '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done > "$ARGV_OUT"\npwd > "$PWD_OUT"\n',
      { mode: 0o700 }
    );
  });

  afterAll(() => {
    fs.rmSync(root, RM_TEST_DIR);
  });

  it('modes 0700 for the directory and the file, under the per-user temp dir', async () => {
    const written = await writeCommandFile(commandFileText('true'), undefined, root);
    expect(fs.statSync(written.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(written.file).mode & 0o777).toBe(0o700);
    expect(path.dirname(written.dir)).toBe(root);
    fs.unlinkSync(written.file);
    fs.rmdirSync(written.dir);
  });

  it('every shell parses the generated file (sh -n, bash -n, zsh -n)', async () => {
    for (const value of CORPUS) {
      const command = newWindowCommand(`/tmp/${value}`, '/bin/zsh', `echo ${value}`);
      const written = await writeCommandFile(commandFileText(command), undefined, root);
      for (const shell of shells) {
        expect(() => execFileSync(shell, ['-n', written.file]), `${shell}: ${value}`).not.toThrow();
      }
      fs.unlinkSync(written.file);
      fs.rmdirSync(written.dir);
    }
  });

  // macOS checks each freshly written executable before it runs (~80 ms apiece idle, about 1 s
  // with fseventsd busy: 2026-11-02, 10.5 s for 17 files). Only the first file is exec'd
  // directly (its shebang and mode); the others are handed to the /bin/sh that shebang names,
  // which runs the same text with the same $0, so every value still goes through a real shell.
  it('run directly: it deletes itself, cds into the folder and passes the line intact', async () => {
    for (const [i, value] of CORPUS.entries()) {
      const folder = path.join(root, `dir ${value.replace(/\//g, '_')}`);
      fs.mkdirSync(folder, { recursive: true });
      const line = `cd '${value}' && ut claude --resume ${value}`;
      const written = await writeCommandFile(
        commandFileText(newWindowCommand(folder, stub, line)),
        undefined,
        root
      );
      const argvOut = path.join(root, 'argv.out');
      const pwdOut = path.join(root, 'pwd.out');
      const env = { PATH: '/usr/bin:/bin', ARGV_OUT: argvOut, PWD_OUT: pwdOut };
      if (i === 0) execFileSync(written.file, [], { env });
      else execFileSync('/bin/sh', [written.file], { env });
      expect(fs.existsSync(written.file), value).toBe(false);
      const argv = fs.readFileSync(argvOut, 'utf8').split('\0').slice(0, -1);
      expect(argv, value).toEqual(['-lic', line]);
      expect(fs.realpathSync(fs.readFileSync(pwdOut, 'utf8').trim())).toBe(fs.realpathSync(folder));
      fs.rmdirSync(written.dir);
    }
  }, 60_000);
});

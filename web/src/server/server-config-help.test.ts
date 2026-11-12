import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { helpText, parseArgs } from './server-config.js';

// 2026-11-10 (scripts/docs audit): --help announced --username/--password and a binary called
// untether-server; the parser refuses those options ("Unknown argument", exit 1) and the package
// only installs `untether`. The help is held against the parser so the two cannot drift again.
describe('server --help', () => {
  const realArgv = process.argv;
  afterEach(() => {
    process.argv = realArgv;
    vi.restoreAllMocks();
  });

  const optionsIn = (text: string) => [...new Set(text.match(/--[a-z][a-z-]*/g) ?? [])];

  it('names only options the parser accepts', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const options = optionsIn(helpText());
    expect(options.length).toBeGreaterThan(20);
    for (const option of options) {
      process.argv = ['node', 'untether', option, '1'];
      expect(() => parseArgs(), option).not.toThrow();
    }
    expect(exit).not.toHaveBeenCalled();

    // The check itself tells an option the parser does not know.
    process.argv = ['node', 'untether', '--username', 'admin'];
    expect(() => parseArgs()).toThrow('exit 1');
    // The local token only comes in UNTETHER_LOCAL_AUTH_TOKEN (2026-10-27): as an argument
    // every user of the Mac read it with ps. The argument is refused, not taken.
    process.argv = ['node', 'untether', '--local-auth-token', 'tok'];
    expect(() => parseArgs()).toThrow('exit 1');
    // It did nothing (the keys are made when there are none): gone from the parser and the help.
    process.argv = ['node', 'untether', '--generate-vapid-keys'];
    expect(() => parseArgs()).toThrow('exit 1');
    expect(helpText()).not.toContain('--generate-vapid-keys');
  });

  it('names the environment variables the server reads for the login', () => {
    // The first fix of this help dropped them as if they were as dead as the options: the
    // password login does read both (services/auth-service.ts).
    const authService = fs.readFileSync(path.join(__dirname, 'services/auth-service.ts'), 'utf8');
    for (const name of ['UNTETHER_USERNAME', 'UNTETHER_PASSWORD']) {
      expect(authService).toContain(`process.env.${name}`);
      expect(helpText()).toContain(name);
    }
  });

  it('calls the command by the name the package installs', () => {
    expect(helpText()).toContain('Usage: untether [options]');
    expect(helpText()).not.toContain('untether-server');
  });

  // docs/security.md told readers to run `untether-server --allow-local-bypass --local-auth-token …`
  // and said the bypass needs no token. Every server command line the documentation shows uses
  // the real command and options the help names.
  it('is what the documentation shows', () => {
    const root = path.resolve(__dirname, '../../..');
    const known = new Set(optionsIn(helpText()));
    const files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file && !file.startsWith('web/node-pty/') && file !== 'CHANGELOG.md');
    expect(files.length).toBeGreaterThan(20);
    const wrong: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        const where = `${file}:${index + 1}: ${line.trim()}`;
        if (line.includes('untether-server')) wrong.push(where);
        // `untether --option …`, not its subcommands (`untether fwd --session-id …`).
        const command = line.match(/^\s*(?:\$ )?(?:[A-Z_]+=\S+ )*(?:\.\/|npx )?untether (--.*)$/);
        if (command && optionsIn(command[1]).some((option) => !known.has(option)))
          wrong.push(where);
      });
    }
    expect(wrong).toEqual([]);
  });

  // 2026-11-11 (decision): Linux is not where Untether runs. `untether systemd`, its installer
  // and the two documents that taught it are gone, and no document sends anyone to them.
  it('offers no systemd subcommand, in the CLI or in the documentation', () => {
    const root = path.resolve(__dirname, '../../..');
    expect(fs.readFileSync(path.join(root, 'web/src/cli.ts'), 'utf8')).not.toMatch(/systemd/i);
    for (const gone of [
      'web/src/server/services/systemd-installer.ts',
      'web/docs/systemd.md',
      'docs/linux.md',
    ]) {
      expect(fs.existsSync(path.join(root, gone)), gone).toBe(false);
    }
    const files = execFileSync('git', ['ls-files', '*.md', 'docs.json'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(
        (file) =>
          file &&
          !file.startsWith('web/node-pty/') &&
          !file.startsWith('apple/') &&
          file !== 'CHANGELOG.md' &&
          fs.existsSync(path.join(root, file))
      );
    expect(files.length).toBeGreaterThan(20);
    const wrong = files.filter((file) =>
      /untether systemd|docs\/systemd|linux\.md/.test(
        fs.readFileSync(path.join(root, file), 'utf8')
      )
    );
    expect(wrong).toEqual([]);
  });
});

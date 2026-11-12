import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findTmuxBinary } from '../shielded-tmux.js';
import { isNoTmuxServer, TMUX_FIELD_SEPARATOR } from '../tmux-manager.js';
import {
  assertMacTmuxAllowed,
  MacTmuxRefused,
  parseTmuxVersion,
  runMacTmux,
  tmuxVersion,
} from './tmux-run.js';

// Prints its arguments one per line, then whether TMUX or TMUX_PANE reached it (never values).
const FAKE_TMUX = [
  '#!/bin/sh',
  'for arg in "$@"; do printf "%s\\n" "$arg"; done',
  'printenv TMUX > /dev/null && echo "env: TMUX"',
  'printenv TMUX_PANE > /dev/null && echo "env: TMUX_PANE"',
  'exit 0',
  '',
].join('\n');

const TTY = '/dev/ttys012';

describe('runMacTmux', () => {
  let dir: string;
  let fakeTmux: string;
  const run = (args: string[], env: Record<string, string> = {}) =>
    runMacTmux('/tmp/vtm-test/s', args, {
      tmuxBin: fakeTmux,
      env: { PATH: '/usr/bin:/bin', ...env },
    });

  beforeAll(() => {
    // Short and under /tmp: these tests never start tmux, but the paths look like its sockets.
    dir = fs.mkdtempSync('/tmp/vtm-');
    fakeTmux = path.join(dir, 'tmux');
    fs.writeFileSync(fakeTmux, FAKE_TMUX, { mode: 0o755 });
  });

  afterAll(() => {
    fs.rmSync(fakeTmux, { force: true });
    fs.rmdirSync(dir);
  });

  it('always runs tmux -u -N -S <socket>, never inside the tmux it was started from', async () => {
    const output = await run(['list-panes', '-a', '-F', '#{pane_id}'], {
      TMUX: '/tmp/tmux-501/default,1,0',
      TMUX_PANE: '%1',
    });
    expect(output.trim().split('\n')).toEqual([
      '-u',
      '-N',
      '-S',
      '/tmp/vtm-test/s',
      'list-panes',
      '-a',
      '-F',
      '#{pane_id}',
    ]);
  });

  it('runs reads, and changes to one client named by its tty', async () => {
    for (const args of [
      ['list-panes', '-a', '-F', '#{pane_id}', ';', 'list-clients', '-F', '#{client_pid}'],
      ['has-session', '-t', '$3'],
      ['switch-client', '-E', '-c', TTY, '-t', '$3', '-r'],
      ['refresh-client', '-t', TTY, '-f', 'ignore-size'],
      ['refresh-client', '-t', '/dev/pts/4', '-f', '!ignore-size'],
      ['detach-client', '-t', TTY],
    ]) {
      await expect(run(args), JSON.stringify(args)).resolves.toContain(args[0]);
    }
  });

  it('refuses every other command, also after a ;', async () => {
    for (const args of [
      ['send-keys', '-t', '$0', 'ls', 'Enter'],
      ['kill-session', '-t', '$0'],
      ['kill-server'],
      ['new-session', '-d'],
      ['set-option', '-g', 'status', 'off'],
      ['display-message', '-p', '-t', '$7', '#{session_id}'],
      ['attach-session', '-t', '$0'],
      ['lsp'],
      [],
      ['list-panes', '-a', ';', 'send-keys', '-t', '$0', 'x'],
      // tmux ends a command at an argument ending in ";" too.
      ['list-panes', '-F', '#{pane_id};', 'kill-server'],
      ['list-panes', '-F', '#(touch /tmp/x)'],
    ]) {
      await expect(run(args), JSON.stringify(args)).rejects.toBeInstanceOf(MacTmuxRefused);
    }
    await expect(
      runMacTmux('default', ['list-panes'], { tmuxBin: fakeTmux })
    ).rejects.toBeInstanceOf(MacTmuxRefused);
  });

  it('refuses client commands that could reach any client but Untether’s own', () => {
    for (const args of [
      ['detach-client'],
      ['detach-client', '-t', ''],
      ['detach-client', '-a', '-t', TTY],
      ['detach-client', '-s', '$3'],
      ['detach-client', '-P', '-t', TTY],
      ['detach-client', '-E', 'sh', '-t', TTY],
      ['refresh-client', '-f', 'ignore-size'],
      ['refresh-client', '-t', TTY, '-f', 'active-pane'],
      ['refresh-client', '-t', TTY, '-f', '!read-only'],
      ['switch-client', '-E', '-t', '$3', '-r'],
      ['switch-client', '-E', '-c', TTY, '-r'],
      ['switch-client', '-E', '-c', TTY, '-t', '$3:1', '-r'],
      ['switch-client', '-E', '-c', TTY, '-t', '%4'],
      ['switch-client', '-E', '-c', TTY, '-t', '$3', '-n'],
      ['switch-client', '-E', '-rc', TTY, '-t', '$3'],
      ['switch-client', '-E', '-c', TTY, '-t', '$3', '-t', '$4'],
      // Without -E tmux copies Untether's environment into the user's session.
      ['switch-client', '-c', TTY, '-t', '$3', '-r'],
      ['switch-client', '-Ec', TTY, '-t', '$3', '-r'],
      ['list-clients', ';', 'detach-client', '-t', TTY, '-a'],
    ]) {
      expect(() => assertMacTmuxAllowed(args), JSON.stringify(args)).toThrow(MacTmuxRefused);
    }
  });
});

describe('tmux version', () => {
  it('can open from tmux 3.2 on, and from builds of its repository', () => {
    for (const output of ['tmux 3.7c\n', '3.2a', 'tmux next-3.8', 'tmux master', 'tmux 10.0']) {
      expect(parseTmuxVersion(output)?.canOpen, output).toBe(true);
    }
    for (const output of ['tmux 3.1c', '2.9a', 'tmux 3', 'tmux']) {
      expect(parseTmuxVersion(output)?.canOpen ?? false, output).toBe(false);
    }
    expect(parseTmuxVersion('tmux 3.7c\n')).toEqual({ version: '3.7c', canOpen: true });
  });

  describe('of the installed binary', () => {
    let dir: string;
    const files: string[] = [];
    const fakeTmux = (name: string, script: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `#!/bin/sh\necho run >> "${file}.runs"\n${script}\n`, { mode: 0o755 });
      files.push(file, `${file}.runs`);
      return file;
    };
    const runs = (file: string) =>
      fs.existsSync(`${file}.runs`)
        ? fs.readFileSync(`${file}.runs`, 'utf8').split('\n').length - 1
        : 0;

    beforeAll(() => {
      dir = fs.mkdtempSync('/tmp/vtm-');
    });

    afterAll(() => {
      for (const file of files) fs.rmSync(file, { force: true });
      fs.rmdirSync(dir);
    });

    it('asks tmux once, and again when the binary changes', async () => {
      const tmux = fakeTmux('upgraded', 'echo "tmux 3.1c"');
      const [first, second] = await Promise.all([tmuxVersion(tmux), tmuxVersion(tmux)]);
      expect(first).toEqual({ available: true, version: '3.1c', canOpen: false });
      expect(second).toEqual(first);
      expect(await tmuxVersion(tmux)).toEqual(first);
      expect(runs(tmux)).toBe(1);

      fs.writeFileSync(tmux, `#!/bin/sh\necho run >> "${tmux}.runs"\necho "tmux 3.7c"\n`);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(tmux, later, later);
      expect(await tmuxVersion(tmux)).toEqual({ available: true, version: '3.7c', canOpen: true });
      expect(runs(tmux)).toBe(2);
    });

    it('asks again after a run that failed', async () => {
      const marker = path.join(dir, 'failed-once');
      files.push(marker);
      const tmux = fakeTmux(
        'flaky',
        `if [ ! -e "${marker}" ]; then : > "${marker}"; exit 1; fi\necho "tmux 3.4"`
      );
      expect(await tmuxVersion(tmux)).toEqual({ available: false, canOpen: false });
      // 2026-11-11: with the Mac at a load of 55 the second run itself went over tmux -V's 2 s
      // limit: one more failed run, which is asked again just the same. Asked until it answers,
      // with a deadline, instead of trusting one run to be on time.
      await expect
        .poll(() => tmuxVersion(tmux), { timeout: 60_000, interval: 100 })
        .toEqual({ available: true, version: '3.4', canOpen: true });
      // And an answer is remembered: no further run.
      const asked = runs(tmux);
      expect(await tmuxVersion(tmux)).toEqual({ available: true, version: '3.4', canOpen: true });
      expect(runs(tmux)).toBe(asked);
    }, 90_000);

    it('is unavailable without a binary', async () => {
      expect(await tmuxVersion(null)).toEqual({ available: false, canOpen: false });
      expect(await tmuxVersion(path.join(dir, 'missing'))).toEqual({
        available: false,
        canOpen: false,
      });
    });
  });
});

const realTmux = findTmuxBinary();

/** A private tmux server on a socket of its own (-S), never the user's. */
describe.skipIf(!realTmux)('runMacTmux on a tmux server', () => {
  it('gets names back exact without a UTF-8 locale, and tells a server that is gone', async () => {
    const tmuxBin = realTmux as string;
    const dir = fs.mkdtempSync('/tmp/vtm-');
    const socket = path.join(dir, 's');
    // No LANG, LC_* or TMUX: without -u tmux would answer "caf_: 1".
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, TMUX_TMPDIR: dir };
    const tmux = (...args: string[]) =>
      execFileSync(tmuxBin, ['-u', '-S', socket, '-f', '/dev/null', ...args], {
        env,
        encoding: 'utf8',
      });
    try {
      tmux('new-session', '-d', '-s', 'café: 1', '-x', '80', '-y', '20', 'sleep 60');
      const output = await runMacTmux(
        socket,
        ['list-panes', '-a', '-F', ['#{session_id}', '#{session_name}'].join(TMUX_FIELD_SEPARATOR)],
        { tmuxBin, env }
      );
      expect(output.trim().split(TMUX_FIELD_SEPARATOR)).toEqual(['$0', 'café: 1']);

      const gone = await runMacTmux(path.join(dir, 'gone'), ['list-panes', '-a'], {
        tmuxBin,
        env,
      }).catch((error: unknown) => error);
      expect(isNoTmuxServer(gone)).toBe(true);
    } finally {
      try {
        tmux('kill-server');
      } catch {
        // already gone
      }
      // Only what this test made: its socket, then the directory if that left it empty.
      fs.rmSync(socket, { force: true });
      fs.rmdirSync(dir);
    }
  });
});

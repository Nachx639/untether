import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TMUX_FIELD_SEPARATOR } from './tmux-manager.js';

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * The separator of tmux's list output has to come back as sent. A control character did on
 * tmux 3.7c in a UTF-8 shell, but tmux turns it into "_" for a client without a UTF-8 locale
 * (and 3.4/3.5 escape it), where the session lists came back empty (review of 2026-10-03).
 * Runs a private tmux server on a socket of its own (-S), never the user's.
 */
describe.skipIf(!hasTmux)('tmux list output separator', () => {
  it('comes back as sent from a tmux without a UTF-8 locale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ut-sep-'));
    const socket = join(dir, 'tmux');
    // No LANG/LC_*/TMUX: tmux then treats its client as not UTF-8.
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' };
    const tmux = (...args: string[]) =>
      execFileSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8' });
    try {
      tmux('new-session', '-d', '-s', 'a|b', '-x', '80', '-y', '20', 'sleep 30');
      tmux('select-pane', '-t', 'a|b', '-T', 'build | watch');
      const line = tmux(
        'list-panes',
        '-a',
        '-F',
        ['#{session_name}', '#{pane_title}', '#{window_index}'].join(TMUX_FIELD_SEPARATOR)
      ).trim();
      expect(line.split(TMUX_FIELD_SEPARATOR)).toEqual(['a|b', 'build | watch', '0']);
    } finally {
      try {
        tmux('kill-server');
      } catch {
        // already gone
      }
      // Only what this test made: its socket, then the directory if that left it empty.
      rmSync(socket, { force: true });
      rmdirSync(dir);
    }
  });
});

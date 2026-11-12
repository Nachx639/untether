import { execFileSync } from 'child_process';
import * as fs from 'fs';
import type { IPty } from 'node-pty';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { attachCommand } from './mac-sessions/attach.js';
import { assertMacTmuxAllowed, parseTmuxVersion, runMacTmux } from './mac-sessions/tmux-run.js';
import { findTmuxBinary, tmuxEnv } from './shielded-tmux.js';
import {
  clientMode,
  modeCommands,
  parseTmuxClientLine,
  TMUX_CLIENT_FORMAT,
  type TmuxAttachError,
  TmuxAttachTracker,
  type TmuxClient,
} from './tmux-attach-tracker.js';
import { TMUX_FIELD_SEPARATOR } from './tmux-manager.js';

const client = (fields: Partial<TmuxClient> = {}): TmuxClient => ({
  clientPid: 500,
  tty: '/dev/ttys005',
  sessionId: '$0',
  windowId: '@1',
  paneId: '%1',
  panePid: 700,
  cwd: '/Users/me/project',
  readOnly: false,
  flags: ['attached', 'focused', 'ignore-size', 'UTF-8'],
  width: 80,
  height: 24,
  activity: 1_791_053_894,
  ...fields,
});

/** What `list-clients -F TMUX_CLIENT_FORMAT` prints for these clients. */
const listing = (...clients: TmuxClient[]) =>
  clients
    .map((c) =>
      [
        'C',
        c.clientPid,
        c.tty,
        c.sessionId,
        c.windowId,
        c.paneId,
        c.panePid,
        c.cwd,
        c.readOnly ? 1 : 0,
        c.flags.join(','),
        c.width,
        c.height,
        c.activity,
      ].join(TMUX_FIELD_SEPARATOR)
    )
    .map((line) => `${line}\n`)
    .join('');

const NO_SERVER = Object.assign(new Error('Command failed'), {
  stderr: 'no server running on /tmp/vtm-x/s\n',
});

describe('parseTmuxClientLine', () => {
  it('reads a client and the pane it shows', () => {
    const line = listing(client({ readOnly: true, flags: ['attached', 'read-only'] })).trim();
    expect(parseTmuxClientLine(line)).toEqual(
      client({ readOnly: true, flags: ['attached', 'read-only'] })
    );
  });

  it('keeps a separator that is part of the path', () => {
    const cwd = `/Users/me/odd${TMUX_FIELD_SEPARATOR}name`;
    expect(parseTmuxClientLine(listing(client({ cwd })).trim())?.cwd).toBe(cwd);
  });

  it('ignores anything that is not a client line', () => {
    for (const line of [
      '',
      'no clients',
      listing(client()).trim().replace(/^C/, 'P'),
      ['C', '500', '/dev/ttys005', '$0'].join(TMUX_FIELD_SEPARATOR),
      listing(client()).trim().replace(`C${TMUX_FIELD_SEPARATOR}500`, `C${TMUX_FIELD_SEPARATOR}x`),
    ]) {
      expect(parseTmuxClientLine(line), line).toBeNull();
    }
  });

  it('asks tmux for exactly the fields it reads', () => {
    expect(TMUX_CLIENT_FORMAT.split(TMUX_FIELD_SEPARATOR)).toHaveLength(13);
    expect(TMUX_CLIENT_FORMAT).not.toContain('#(');
  });
});

describe('modeCommands', () => {
  const tty = '/dev/ttys005';
  const switchR = ['switch-client', '-E', '-c', tty, '-t', '$0', '-r'];
  const refresh = (flag: string) => ['refresh-client', '-t', tty, '-f', flag];
  const watching = client({ readOnly: true, flags: ['attached', 'ignore-size', 'read-only'] });
  const controlOthers = client({ flags: ['attached', 'ignore-size'] });
  const controlHere = client({ flags: ['attached'] });

  it('clears read-only with switch-client -r, then sets the size flag back', () => {
    expect(modeCommands(watching, { mode: 'control', sizing: 'others' })).toEqual([
      switchR,
      refresh('ignore-size'),
    ]);
    expect(modeCommands(watching, { mode: 'control', sizing: 'here' })).toEqual([switchR]);
  });

  it('turns to watch with switch-client -r alone, which also ignores size', () => {
    expect(modeCommands(controlOthers, { mode: 'watch', sizing: 'others' })).toEqual([switchR]);
    expect(modeCommands(controlHere, { mode: 'watch', sizing: 'here' })).toEqual([switchR]);
  });

  it('changes only the size flag in control, and nothing that already is', () => {
    expect(modeCommands(controlOthers, { mode: 'control', sizing: 'here' })).toEqual([
      refresh('!ignore-size'),
    ]);
    expect(modeCommands(controlHere, { mode: 'control', sizing: 'others' })).toEqual([
      refresh('ignore-size'),
    ]);
    expect(modeCommands(controlOthers, { mode: 'control', sizing: 'others' })).toEqual([]);
    expect(modeCommands(watching, { mode: 'watch', sizing: 'here' })).toEqual([]);
  });

  it('keeps the client on the session it shows', () => {
    const elsewhere = client({ sessionId: '$4' });
    expect(modeCommands(elsewhere, { mode: 'watch', sizing: 'others' })).toEqual([
      ['switch-client', '-E', '-c', tty, '-t', '$4', '-r'],
    ]);
  });

  it('only plans commands Mac Sessions may run on a user’s server', () => {
    for (const from of [watching, controlOthers, controlHere]) {
      for (const mode of ['control', 'watch'] as const) {
        for (const sizing of ['others', 'here'] as const) {
          for (const args of modeCommands(from, { mode, sizing })) {
            expect(() => assertMacTmuxAllowed(args)).not.toThrow();
          }
        }
      }
    }
  });

  it('reads the mode back from what tmux lists', () => {
    expect(clientMode(watching)).toEqual({ mode: 'watch', sizing: 'others' });
    expect(clientMode(controlOthers)).toEqual({ mode: 'control', sizing: 'others' });
    expect(clientMode(controlHere)).toEqual({ mode: 'control', sizing: 'here' });
  });
});

describe('TmuxAttachTracker', () => {
  /** What each socket lists next (an Error is thrown), and every call made. */
  let outputs: Map<string, string | Error>;
  let calls: Array<{ socketPath: string; args: string[] }>;
  let tracker: TmuxAttachTracker;

  beforeEach(() => {
    outputs = new Map();
    calls = [];
    tracker = new TmuxAttachTracker({
      run: async (socketPath, args) => {
        calls.push({ socketPath, args });
        if (args[0] !== 'list-clients') return '';
        const output = outputs.get(socketPath) ?? '';
        if (output instanceof Error) throw output;
        return output;
      },
    });
  });

  afterEach(() => {
    for (const id of ['a', 'b', 'c']) tracker.untrack(id);
    vi.useRealTimers();
  });

  it("maps each session's client to the pane it shows, one listing per socket", async () => {
    tracker.track('a', { socketPath: '/tmp/s1', clientPid: 500 });
    tracker.track('b', { socketPath: '/tmp/s1', clientPid: 501 });
    tracker.track('c', { socketPath: '/tmp/s2', clientPid: 500 });
    outputs.set(
      '/tmp/s1',
      listing(
        // The user's own terminal on the same tmux session comes first.
        client({ clientPid: 499, tty: '/dev/ttys001', paneId: '%9', panePid: 999 }),
        client({ clientPid: 500, paneId: '%1', panePid: 701 }),
        client({ clientPid: 501, tty: '/dev/ttys006', paneId: '%2', panePid: 702 })
      )
    );
    outputs.set('/tmp/s2', listing(client({ clientPid: 500, paneId: '%1', panePid: 703 })));
    await tracker.refresh();

    expect([tracker.programPid('a'), tracker.programPid('b'), tracker.programPid('c')]).toEqual([
      701, 702, 703,
    ]);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.args).toEqual(['list-clients', '-F', TMUX_CLIENT_FORMAT]);
    expect(tracker.programPid('untracked')).toBeUndefined();
  });

  it('keeps the pane it was opened on until the client is listed, then follows the client', async () => {
    tracker.track('a', {
      socketPath: '/tmp/s1',
      clientPid: 500,
      seed: { panePid: 650, paneId: '%0' },
    });
    expect(tracker.programPid('a')).toBe(650);
    // Not attached yet right after opening.
    await tracker.refresh();
    expect(tracker.programPid('a')).toBe(650);

    outputs.set('/tmp/s1', listing(client({ paneId: '%0', panePid: 650 })));
    await tracker.refresh();
    expect(tracker.client('a')?.tty).toBe('/dev/ttys005');
    // Another window in the pane's session.
    outputs.set('/tmp/s1', listing(client({ windowId: '@2', paneId: '%3', panePid: 660 })));
    await tracker.refresh();
    expect(tracker.programPid('a')).toBe(660);
  });

  it('has no pane once the client is gone, or its server', async () => {
    tracker.track('a', { socketPath: '/tmp/s1', clientPid: 500 });
    tracker.track('c', { socketPath: '/tmp/s2', clientPid: 500 });
    outputs.set('/tmp/s1', listing(client()));
    outputs.set('/tmp/s2', listing(client()));
    await tracker.refresh();
    expect(tracker.programPid('a')).toBe(700);

    outputs.set('/tmp/s1', listing(client({ clientPid: 499, tty: '/dev/ttys001' })));
    outputs.set('/tmp/s2', NO_SERVER);
    await tracker.refresh();
    expect(tracker.programPid('a')).toBeUndefined();
    expect(tracker.client('a')).toBeUndefined();
    expect(tracker.programPid('c')).toBeUndefined();
  });

  it('keeps what it had when tmux fails for another reason', async () => {
    tracker.track('a', { socketPath: '/tmp/s1', clientPid: 500 });
    outputs.set('/tmp/s1', listing(client()));
    await tracker.refresh();
    outputs.set('/tmp/s1', Object.assign(new Error('Command failed'), { killed: true }));
    await tracker.refresh();
    expect(tracker.programPid('a')).toBe(700);
  });

  it('tells listeners about each change, not about each listing', async () => {
    const seen: Array<{ id: string; readOnly: boolean; cwd: string; previous?: string }> = [];
    tracker.onChange((id, now, previous) =>
      seen.push({ id, readOnly: now.readOnly, cwd: now.cwd, previous: previous?.cwd })
    );
    tracker.track('a', { socketPath: '/tmp/s1', clientPid: 500 });
    outputs.set('/tmp/s1', listing(client()));
    await tracker.refresh();
    outputs.set('/tmp/s1', listing(client({ activity: 1_791_060_000 })));
    await tracker.refresh();
    outputs.set('/tmp/s1', listing(client({ readOnly: true, cwd: '/Users/me/other' })));
    await tracker.refresh();
    expect(seen).toEqual([
      { id: 'a', readOnly: false, cwd: '/Users/me/project', previous: undefined },
      { id: 'a', readOnly: true, cwd: '/Users/me/other', previous: '/Users/me/project' },
    ]);
  });

  it('lists every 2 s while a session is tracked, and stops after the last one', async () => {
    vi.useFakeTimers();
    outputs.set('/tmp/s1', listing(client()));
    tracker.track('a', { socketPath: '/tmp/s1', clientPid: 500 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);
    tracker.untrack('a');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
  });

  it('detaches only its own client, found again by its pid', async () => {
    tracker.track('a', { socketPath: '/tmp/s1', clientPid: 500 });
    outputs.set(
      '/tmp/s1',
      listing(client({ clientPid: 499, tty: '/dev/ttys001' }), client({ tty: '/dev/ttys007' }))
    );
    await tracker.detach('a');
    expect(calls.map((call) => [call.socketPath, ...call.args])).toEqual([
      ['/tmp/s1', 'list-clients', '-F', TMUX_CLIENT_FORMAT],
      ['/tmp/s1', 'detach-client', '-t', '/dev/ttys007'],
    ]);
  });

  it('changes nothing when its client is not listed', async () => {
    tracker.track('a', { socketPath: '/tmp/s1', clientPid: 500 });
    outputs.set('/tmp/s1', listing(client({ clientPid: 499, tty: '/dev/ttys001' })));
    const errors = await Promise.all([
      tracker.detach('a').catch((error: TmuxAttachError) => error.code),
      tracker
        .setMode('a', { mode: 'watch', sizing: 'others' })
        .catch((e: TmuxAttachError) => e.code),
      tracker.detach('b').catch((error: TmuxAttachError) => error.code),
    ]);
    expect(errors).toEqual(['client-not-found', 'client-not-found', 'not-tracked']);
    expect(calls.every((call) => call.args[0] === 'list-clients')).toBe(true);
  });

  it('says so when tmux did not take a mode change', async () => {
    tracker.track('a', { socketPath: '/tmp/s1', clientPid: 500 });
    outputs.set('/tmp/s1', listing(client()));
    const error = await tracker
      .setMode('a', { mode: 'watch', sizing: 'others' })
      .catch((e: TmuxAttachError) => e);
    expect((error as TmuxAttachError).code).toBe('mode-failed');
    expect(calls.map((call) => call.args[0])).toEqual([
      'list-clients',
      'switch-client',
      'list-clients',
    ]);
  });
});

// The integration test needs real PTYs (the test setup mocks node-pty).
vi.unmock('node-pty');

const tmuxBin = findTmuxBinary();
// attach-session -f (client flags such as ignore-size) arrived in tmux 3.2.
const canAttach =
  !!tmuxBin && !!parseTmuxVersion(execFileSync(tmuxBin, ['-V'], { encoding: 'utf8' }))?.canOpen;

/** A private tmux server (`-L vtmac-b-<n>` under a temp TMUX_TMPDIR) and real tmux clients. */
describe.skipIf(!canAttach)('TmuxAttachTracker on a tmux server', () => {
  let pty: typeof import('node-pty');
  let dir: string;
  let env: Record<string, string>;
  let socketPath: string;
  let tracker: TmuxAttachTracker;
  const clients: IPty[] = [];
  let serverCount = 0;
  let serverName = '';

  const tmux = (...args: string[]) =>
    execFileSync(tmuxBin as string, ['-u', '-L', serverName, '-f', '/dev/null', ...args], {
      env,
      encoding: 'utf8',
    });

  /** A tmux client attached to `$0`, as Untether or as a terminal on the Mac. */
  function attach(flags: string | null, cols: number, rows: number) {
    const args = ['-u', '-N', '-S', socketPath, 'attach-session'];
    if (flags) args.push('-f', flags);
    const client = pty.spawn(tmuxBin as string, [...args, '-t', '$0'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: dir,
      env,
    });
    const exited = new Promise<void>((resolve) => client.onExit(() => resolve()));
    clients.push(client);
    return { client, exited };
  }

  async function until<T>(read: () => Promise<T | undefined> | T | undefined): Promise<T> {
    for (let i = 0; i < 60; i++) {
      const value = await read();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('timed out');
  }

  const windowSize = () =>
    tmux('display-message', '-p', '-t', '$0', '#{window_width}x#{window_height}').trim();

  beforeAll(async () => {
    pty = await import('node-pty');
  });

  beforeEach(() => {
    // Short: socket paths over ~104 bytes fail.
    dir = fs.mkdtempSync('/tmp/vtm.');
    env = tmuxEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, TMUX_TMPDIR: dir });
    env.TERM = 'xterm-256color';
    serverName = `vtmac-b-${++serverCount}`;
    socketPath = path.join(dir, `tmux-${process.getuid?.() ?? 0}`, serverName);
    tmux('new-session', '-d', '-s', 'café: 1', '-x', '160', '-y', '45', '-c', dir, 'sleep 300');
    tmux('new-window', '-t', '$0', '-c', dir, 'sleep 300');
    tracker = new TmuxAttachTracker({ run: (socket, args) => runMacTmux(socket, args, { env }) });
  });

  afterEach(() => {
    tracker.untrack('ut');
    for (const client of clients.splice(0)) {
      try {
        client.kill();
      } catch {
        // already exited
      }
    }
    try {
      tmux('kill-server');
    } catch {
      // already gone
    }
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('maps its client to the pane it shows, follows a window switch, and detaches only it', async () => {
    const { client, exited } = attach('ignore-size,read-only', 80, 24);
    tracker.track('ut', { socketPath, clientPid: client.pid });
    const listed = await until(async () => {
      await tracker.refresh();
      return tracker.client('ut');
    });
    const panes = tmux('list-panes', '-s', '-t', '$0', '-F', '#{window_id} #{pane_id} #{pane_pid}')
      .trim()
      .split('\n')
      .map((line) => line.split(' '));
    const current = panes.find(([windowId]) => windowId === listed.windowId);
    expect(listed.paneId).toBe(current?.[1]);
    expect(tracker.programPid('ut')).toBe(Number(current?.[2]));
    expect(listed.readOnly).toBe(true);
    expect(listed.cwd).toBe(fs.realpathSync(dir));

    const other = panes.find(([windowId]) => windowId !== listed.windowId);
    tmux('select-window', '-t', other?.[0] as string);
    await tracker.refresh();
    expect(tracker.client('ut')?.paneId).toBe(other?.[1]);
    expect(tracker.programPid('ut')).toBe(Number(other?.[2]));

    await tracker.detach('ut');
    await exited;
    expect(() => tmux('has-session', '-t', '$0')).not.toThrow();
  }, 20_000);

  it('switches between watch and control with switch-client -r, keeping ignore-size', async () => {
    const { client } = attach('ignore-size,read-only', 80, 24);
    tracker.track('ut', { socketPath, clientPid: client.pid });
    await until(async () => {
      await tracker.refresh();
      return tracker.client('ut');
    });

    const control = await tracker.setMode('ut', { mode: 'control', sizing: 'others' });
    expect(control.readOnly).toBe(false);
    expect(control.flags).toContain('ignore-size');
    expect(control.flags).not.toContain('read-only');

    const watch = await tracker.setMode('ut', { mode: 'watch', sizing: 'others' });
    expect(watch.readOnly).toBe(true);
    expect(watch.flags).toEqual(expect.arrayContaining(['ignore-size', 'read-only']));

    const here = await tracker.setMode('ut', { mode: 'control', sizing: 'here' });
    expect(clientMode(here)).toEqual({ mode: 'control', sizing: 'here' });
    expect(tracker.client('ut')?.flags).not.toContain('ignore-size');
  }, 20_000);

  it("never changes the session's environment, attaching or switching mode", async () => {
    // A session started from an SSH login with agent forwarding; Untether's own ssh agent differs.
    tmux('set-environment', '-t', '$0', 'SSH_AUTH_SOCK', '/tmp/forwarded-agent.sock');
    tmux('set-environment', '-t', '$0', 'SSH_CONNECTION', '10.0.0.1 22 10.0.0.2 22');
    const sessionEnv = () =>
      tmux('show-environment', '-t', '$0')
        .split('\n')
        .filter((line) => line.includes('SSH_'))
        .sort();
    const before = sessionEnv();
    expect(before).toContain('SSH_AUTH_SOCK=/tmp/forwarded-agent.sock');

    const [bin, ...args] = attachCommand(tmuxBin as string, socketPath, '$0', 'watch');
    const client = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: dir,
      env: { ...env, SSH_AUTH_SOCK: '/tmp/untether-agent.sock' },
    });
    clients.push(client);
    tracker.track('ut', { socketPath, clientPid: client.pid });
    await until(async () => {
      await tracker.refresh();
      return tracker.client('ut');
    });
    expect(sessionEnv()).toEqual(before);

    await tracker.setMode('ut', { mode: 'control', sizing: 'others' });
    await tracker.setMode('ut', { mode: 'watch', sizing: 'others' });
    expect(sessionEnv()).toEqual(before);
  }, 20_000);

  it('leaves the window the size of a terminal attached without ignore-size (F1)', async () => {
    const mac = attach(null, 160, 45);
    await until(
      () =>
        tmux('list-clients', '-F', '#{client_pid}').includes(String(mac.client.pid)) || undefined
    );
    const { client } = attach('ignore-size', 80, 24);
    tracker.track('ut', { socketPath, clientPid: client.pid });
    await until(async () => {
      await tracker.refresh();
      return tracker.client('ut');
    });
    // One line of the 45 is the status bar.
    expect(windowSize()).toBe('160x44');

    // With the Mac's terminal gone, the window takes Untether's size.
    mac.client.kill();
    await mac.exited;
    await until(() => (windowSize() === '80x23' ? true : undefined));
  }, 20_000);
});

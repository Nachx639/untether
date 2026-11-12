import { describe, expect, it } from 'vitest';
import { parseProcessTable } from '../claude-chat.js';
import {
  ancestors,
  assertRealScanAllowed,
  classifyProcess,
  hostAppForPid,
  hostAppOf,
  isForwarderArgs,
  isShieldSocket,
  isTmuxServerProcess,
  MAX_ANCESTORS,
  type OwnershipContext,
  shieldSocketPath,
  tmuxSocketFromArgs,
  ttyName,
} from './process-tree.js';

const SOCKET_DIR = '/private/tmp/tmux-501';
const UID = 501;

/** One `ps` line with the extended columns: pid, ppid, terminal ('??' for none), uid, args. */
function line(pid: number, ppid: number, tty: string, args: string, uid = UID): string {
  return `${pid} ${ppid} ${pid} 0 ${tty} S ${uid} Fri Oct  2 09:00:00 2026 ${args}`;
}

const table = (...lines: string[]) => parseProcessTable(lines.join('\n'));

const TERMINAL = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
const VSCODE_HELPER =
  '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility --utility-sub-type=node.mojom.NodeService';
const ITERM_SERVER =
  '/Users/me/Library/Application Support/iTerm2/iTermServer-3.5.4 /Users/me/Library/Application Support/iTerm2/iterm2-daemon-1.socket';
const FORWARDER = '/Applications/Untether.app/Contents/Resources/untether-fwd';

/** A Claude in a Terminal tab: claude ← -zsh ← login (root) ← Terminal. */
const terminalTab = () =>
  table(
    line(500, 1, '??', TERMINAL),
    line(510, 500, '16/1', 'login -pfl me /bin/bash -c exec -la zsh /bin/zsh', 0),
    line(520, 510, '16/1', '-zsh'),
    line(530, 520, '16/1', 'claude')
  );

const context = (overrides: Partial<OwnershipContext> = {}): OwnershipContext => ({
  serverPid: 4000,
  sessionPids: new Map(),
  uid: UID,
  socketDir: SOCKET_DIR,
  ownShieldSocket: '/Users/me/.untether/control/.shield-tmux',
  platform: 'darwin',
  ...overrides,
});

describe('ancestors', () => {
  it('lists the parents nearest first, without the process and without launchd', () => {
    expect(ancestors(terminalTab(), 530)).toEqual([520, 510, 500]);
    expect(ancestors(terminalTab(), 500)).toEqual([]);
    expect(ancestors(terminalTab(), 9999)).toEqual([]);
  });

  it(`stops after ${MAX_ANCESTORS} parents`, () => {
    const lines = [line(2, 1, '??', 'root')];
    for (let pid = 3; pid < 200; pid++) lines.push(line(pid, pid - 1, '??', `p${pid}`));
    const chain = ancestors(table(...lines), 199);
    expect(chain).toHaveLength(MAX_ANCESTORS);
    expect(chain[0]).toBe(198);
  });

  it('stops at a cycle', () => {
    const looped = table(line(10, 12, '??', 'a'), line(11, 10, '??', 'b'), line(12, 11, '??', 'c'));
    expect(ancestors(looped, 10)).toEqual([12, 11]);
  });

  it('also walks a table without the extended columns', () => {
    const basic = parseProcessTable(
      [
        '  500     1 Fri Oct  2 09:10:00 2026 /usr/bin/a',
        '  520   500 Fri Oct  2 09:10:01 2026 -zsh',
        '  530   520 Fri Oct  2 09:11:00 2026 claude',
      ].join('\n')
    );
    expect(ancestors(basic, 530)).toEqual([520, 500]);
    expect(ttyName(basic, 530)).toBeNull();
  });
});

describe('hostAppOf', () => {
  it('names Terminal for a tab (claude ← -zsh ← login ← Terminal.app)', () => {
    expect(hostAppOf(terminalTab(), 530, 'darwin')).toBe('Terminal');
  });

  it('takes the outermost app bundle, with spaces in its path (VS Code’s helper)', () => {
    const vscode = table(
      line(600, 1, '??', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'),
      line(610, 600, '??', VSCODE_HELPER),
      line(620, 610, '16/4', '/bin/zsh -il'),
      line(630, 620, '16/4', 'claude')
    );
    expect(hostAppOf(vscode, 630, 'darwin')).toBe('Visual Studio Code');
  });

  it('names iTerm from its shell server and SSH from the daemon', () => {
    const iterm = table(
      line(700, 1, '??', ITERM_SERVER),
      line(710, 700, '16/5', 'login -fp me', 0),
      line(720, 710, '16/5', '-zsh'),
      line(730, 720, '16/5', 'codex')
    );
    expect(hostAppOf(iterm, 730, 'darwin')).toBe('iTerm');
    const ssh = table(
      line(800, 1, '??', 'sshd-session: me [priv]', 0),
      line(810, 800, '??', 'sshd-session: me@ttys009'),
      line(820, 810, '16/9', '-zsh'),
      line(830, 820, '16/9', 'claude')
    );
    expect(hostAppOf(ssh, 830, 'darwin')).toBe('SSH');
    expect(
      hostAppOf(
        table(line(840, 1, '??', 'sshd: me@pts/1'), line(850, 840, 'pts/1', '-bash')),
        850,
        'linux'
      )
    ).toBe('SSH');
  });

  it('is null when nothing above is an app, and never takes a word after a space for one', () => {
    const unknown = table(
      line(900, 1, '??', '/bin/zsh /Users/me/My.app/Contents/run.sh'),
      line(910, 900, '16/2', 'claude')
    );
    expect(hostAppOf(unknown, 910, 'darwin')).toBeNull();
    // The process itself is not its own app.
    expect(hostAppOf(table(line(920, 1, '16/2', `${TERMINAL} --x`)), 920, 'darwin')).toBeNull();
  });

  it('on Linux, names the first process without a terminal above the ones in it', () => {
    const linux = table(
      line(1000, 1, '??', '/usr/lib/systemd/systemd --user'),
      line(1010, 1000, '??', '/usr/libexec/gnome-terminal-server'),
      line(1020, 1010, 'pts/3', 'bash'),
      line(1030, 1020, 'pts/3', 'claude')
    );
    expect(hostAppOf(linux, 1030, 'linux')).toBe('gnome-terminal-server');
  });

  it('skips Untether’s forwarder: the window belongs to the app above it', () => {
    const forwarded = table(
      line(500, 1, '??', TERMINAL),
      line(520, 500, '16/1', '-zsh'),
      line(525, 520, '16/1', '/bin/bash /usr/local/bin/ut claude'),
      line(527, 525, '16/1', `${FORWARDER} --title-mode filter claude`),
      line(530, 527, '16/3', 'claude')
    );
    expect(hostAppOf(forwarded, 530, 'darwin')).toBe('Terminal');
  });
});

describe('isForwarderArgs', () => {
  it('spots untether-fwd and untether fwd', () => {
    expect(isForwarderArgs(`${FORWARDER} --session-id fwd_1_2 claude`)).toBe(true);
    expect(isForwarderArgs('untether-fwd zsh')).toBe(true);
    expect(isForwarderArgs('/Applications/Untether.app/Contents/Resources/untether fwd zsh')).toBe(
      true
    );
    expect(isForwarderArgs('node --no-warnings /usr/local/bin/untether fwd claude')).toBe(true);
    expect(
      isForwarderArgs('/Applications/Untether.app/Contents/Resources/untether --port 4020')
    ).toBe(false);
    expect(isForwarderArgs('vim untether-fwd')).toBe(false);
    expect(isForwarderArgs('-zsh')).toBe(false);
  });
});

describe('tmux sockets', () => {
  it('reads -S and -L in both spellings, else the default socket', () => {
    expect(tmuxSocketFromArgs('tmux', SOCKET_DIR)).toBe(`${SOCKET_DIR}/default`);
    expect(tmuxSocketFromArgs('tmux new-session -d -s 0', SOCKET_DIR)).toBe(
      `${SOCKET_DIR}/default`
    );
    expect(tmuxSocketFromArgs('/opt/homebrew/bin/tmux -L work new -s x', SOCKET_DIR)).toBe(
      `${SOCKET_DIR}/work`
    );
    expect(tmuxSocketFromArgs('tmux -Lwork', SOCKET_DIR)).toBe(`${SOCKET_DIR}/work`);
    expect(tmuxSocketFromArgs('tmux -S /tmp/x/s attach', SOCKET_DIR)).toBe('/tmp/x/s');
    expect(tmuxSocketFromArgs('tmux -S/tmp/x/s', SOCKET_DIR)).toBe('/tmp/x/s');
    expect(tmuxSocketFromArgs('tmux -u -f /dev/null -S /tmp/x/s new', SOCKET_DIR)).toBe('/tmp/x/s');
    expect(tmuxSocketFromArgs('tmux -uS/tmp/x/s new', SOCKET_DIR)).toBe('/tmp/x/s');
    // A -L after the command is the command's, not tmux's.
    expect(tmuxSocketFromArgs('tmux new -L x', SOCKET_DIR)).toBe(`${SOCKET_DIR}/default`);
  });

  it('cannot tell a relative -S path or Linux’s "tmux: server"', () => {
    expect(tmuxSocketFromArgs('tmux -S rel/s new', SOCKET_DIR)).toBeNull();
    expect(tmuxSocketFromArgs('tmux: server', SOCKET_DIR)).toBeNull();
  });

  it('knows the shield sockets of any Untether instance', () => {
    expect(isShieldSocket('/Users/me/.untether-qa/control/.shield-tmux')).toBe(true);
    expect(isShieldSocket(`${SOCKET_DIR}/untether-0123456789ab`)).toBe(true);
    expect(isShieldSocket(`${SOCKET_DIR}/untether-work`)).toBe(false);
    expect(isShieldSocket(`${SOCKET_DIR}/default`)).toBe(false);
    expect(isShieldSocket('/tmp/ut/own', '/tmp/ut/own')).toBe(true);
    expect(shieldSocketPath('/Users/me/.untether/control', SOCKET_DIR)).toBe(
      '/Users/me/.untether/control/.shield-tmux'
    );
    expect(shieldSocketPath(`/tmp/${'x'.repeat(120)}`, SOCKET_DIR)).toMatch(
      /^\/private\/tmp\/tmux-501\/untether-[0-9a-f]{12}$/
    );
  });

  it('tells a tmux server from its clients by the terminal', () => {
    const tmux = table(
      line(600, 1, '??', '/opt/homebrew/bin/tmux new -s 0'),
      line(650, 520, '16/7', 'tmux attach -t 0'),
      line(660, 1, '??', 'tmux-helper')
    );
    expect(isTmuxServerProcess(tmux, 600)).toBe(true);
    expect(isTmuxServerProcess(tmux, 650)).toBe(false);
    expect(isTmuxServerProcess(tmux, 660)).toBe(false);
    expect(isTmuxServerProcess(table(line(800, 1, '??', 'tmux: server')), 800)).toBe(true);
  });
});

describe('classifyProcess', () => {
  // A user tmux pane: claude ← -zsh ← tmux server.
  const userTmux = [
    line(600, 1, '??', 'tmux new -s 0'),
    line(610, 600, '16/12', '-zsh'),
    line(620, 610, '16/12', 'claude'),
  ];

  it('this server comes first', () => {
    const tree = table(line(4000, 1, '??', 'node untether'), line(4010, 4000, '16/1', 'claude'));
    expect(classifyProcess(tree, 4010, context())).toEqual({ owner: 'untether', by: 'server' });
  });

  it('then an Untether session, itself or an ancestor', () => {
    const tree = table(...userTmux, line(630, 620, '16/12', 'node child'));
    const ctx = context({ sessionPids: new Map([[620, 'web-1']]) });
    expect(classifyProcess(tree, 620, ctx)).toEqual({
      owner: 'untether',
      by: 'session',
      sessionId: 'web-1',
    });
    expect(classifyProcess(tree, 630, ctx)).toMatchObject({ by: 'session', sessionId: 'web-1' });
  });

  it('then a shield tmux server, of any instance', () => {
    const shielded = (serverArgs: string) =>
      classifyProcess(
        table(line(700, 1, '??', serverArgs), line(710, 700, '16/3', 'claude')),
        710,
        context()
      );
    for (const [serverArgs, socketPath] of [
      [
        '/opt/homebrew/bin/tmux -S /Users/me/.untether-qa/control/.shield-tmux -D',
        '/Users/me/.untether-qa/control/.shield-tmux',
      ],
      [
        'tmux -L untether-0123456789ab new-session -d -s ut-x',
        `${SOCKET_DIR}/untether-0123456789ab`,
      ],
      [
        'tmux -S /Users/me/.untether/control/.shield-tmux start-server ; set-option -g status off',
        '/Users/me/.untether/control/.shield-tmux',
      ],
    ]) {
      expect(shielded(serverArgs), serverArgs).toEqual({
        owner: 'untether',
        by: 'shield',
        socketPath,
      });
    }
    // This server's own, whatever its name, and one whose socket was only found by lsof.
    const own = context({ ownShieldSocket: '/tmp/ut-own/s' });
    expect(
      classifyProcess(
        table(line(700, 1, '??', 'tmux -S /tmp/ut-own/s'), line(710, 700, '16/3', 'claude')),
        710,
        own
      )
    ).toEqual({ owner: 'untether', by: 'shield', socketPath: '/tmp/ut-own/s' });
    expect(
      classifyProcess(
        table(line(700, 1, '??', 'tmux: server'), line(710, 700, 'pts/3', 'claude')),
        710,
        context({ tmuxSockets: new Map([[700, '/home/me/.untether/control/.shield-tmux']]) })
      )
    ).toEqual({
      owner: 'untether',
      by: 'shield',
      socketPath: '/home/me/.untether/control/.shield-tmux',
    });
  });

  it('then a forwarder (ut <command> in a terminal window)', () => {
    const tree = table(
      line(500, 1, '??', TERMINAL),
      line(520, 500, '16/1', '-zsh'),
      line(527, 520, '16/1', `${FORWARDER} claude`),
      line(530, 527, '16/3', 'claude')
    );
    expect(classifyProcess(tree, 530, context())).toEqual({ owner: 'untether', by: 'forwarder' });
  });

  it('then a pane of one of the user’s tmux servers', () => {
    expect(classifyProcess(table(...userTmux), 620, context())).toEqual({
      owner: 'tmux',
      serverPid: 600,
      panePid: 610,
      socketPath: `${SOCKET_DIR}/default`,
    });
    // A tmux server of another user is not one of the user's.
    const other = table(line(600, 1, '??', 'tmux new -s 0', 502), ...userTmux.slice(1));
    expect(classifyProcess(other, 620, context())).toEqual({ owner: 'mac', app: null });
  });

  it('else the user’s own, in the app above it', () => {
    expect(classifyProcess(terminalTab(), 530, context())).toEqual({
      owner: 'mac',
      app: 'Terminal',
    });
  });

  it('an Untether server running in a user tmux pane still owns its own sessions', () => {
    const tree = table(
      ...userTmux.slice(0, 2),
      line(4000, 610, '16/12', 'node untether --port 4020'),
      line(4100, 4000, '16/20', '-zsh'),
      line(4110, 4100, '16/20', 'claude')
    );
    const own = { serverPid: 4000, sessionPids: new Map([[4100, 'web-2']]) };
    expect(classifyProcess(tree, 4110, context(own))).toEqual({
      owner: 'untether',
      by: 'session',
      sessionId: 'web-2',
    });
    // Before its session list has it, the server itself is still nearer than the tmux server.
    expect(classifyProcess(tree, 4110, context({ serverPid: 4000 }))).toEqual({
      owner: 'untether',
      by: 'server',
    });
    // Seen from another Untether, it is a program in the user's tmux pane.
    expect(classifyProcess(tree, 4110, context({ serverPid: 1234 }))).toMatchObject({
      owner: 'tmux',
      panePid: 610,
    });
  });
});

describe('hostAppForPid', () => {
  const forwarded = () =>
    table(
      line(500, 1, '??', TERMINAL),
      line(520, 500, '16/1', '-zsh'),
      line(525, 520, '16/1', '/bin/bash /usr/local/bin/ut claude'),
      line(527, 525, '16/1', `${FORWARDER} --title-mode filter /bin/zsh -i -c claude`),
      line(528, 527, '16/3', '/bin/zsh -i -c claude'),
      line(530, 528, '16/3', 'claude')
    );

  it('names the app of the window a ut session runs in, from its program or its forwarder', async () => {
    const options = { table: async () => forwarded(), platform: 'darwin' as const };
    expect(await hostAppForPid(528, options)).toBe('Terminal');
    expect(await hostAppForPid(527, options)).toBe('Terminal');
  });

  it('is null for a process it can’t see or whose app can’t be told', async () => {
    const options = { table: async () => forwarded(), platform: 'darwin' as const };
    expect(await hostAppForPid(9999, options)).toBeNull();
    const headless = table(
      line(300, 1, '??', `${FORWARDER} claude`),
      line(310, 300, '??', 'claude')
    );
    expect(
      await hostAppForPid(310, { table: async () => headless, platform: 'darwin' })
    ).toBeNull();
  });

  it('keeps the answer per process', async () => {
    let reads = 0;
    const vscode = () =>
      table(
        line(600, 1, '??', VSCODE_HELPER),
        line(620, 600, '16/4', `${FORWARDER} codex`),
        line(630, 620, '16/4', 'codex')
      );
    const options = {
      table: async () => {
        reads++;
        // Second read: the same process (pid and start), its parents no longer listed.
        return reads === 1 ? vscode() : table(line(630, 620, '16/4', 'codex'));
      },
      platform: 'darwin' as const,
    };
    expect(await hostAppForPid(630, options)).toBe('Visual Studio Code');
    expect(await hostAppForPid(630, options)).toBe('Visual Studio Code');
    expect(reads).toBe(2);
  });
});

describe('assertRealScanAllowed', () => {
  it('refuses under vitest', () => {
    expect(() => assertRealScanAllowed('tmux discovery')).toThrow(/vitest/);
    expect(() => assertRealScanAllowed('tmux discovery', {})).not.toThrow();
  });
});

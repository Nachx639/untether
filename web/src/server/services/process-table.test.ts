import { describe, expect, it } from 'vitest';
import {
  descendants,
  parseProcessTable,
  processTableColumns,
  readProcessTable,
  terminalName,
} from './claude-chat.js';

// What `TZ=UTC ps -A -o pid=,ppid=,pgid=,tpgid=,tdev=,stat=,uid=,lstart=,args=` shows on macOS
// for a Terminal tab running Claude Code, and the tmux server of the user's default socket.
const MAC_PS = [
  '    1     0     1    0   ?? Ss       0 Fri Oct  2 09:00:00 2026     /sbin/launchd',
  '  500     1   500    0   ?? S      501 Fri Oct  2 09:10:00 2026     /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
  '  510   500   510  530 16/1 Ss       0 Fri Oct  2 09:10:01 2026     login -pfl me /bin/bash -c exec -la zsh /bin/zsh',
  '  520   510   520  530 16/1 S      501 Fri Oct  2 09:10:01 2026     -zsh',
  '  530   520   530  530 16/1 S+     501 Fri Oct  2 09:11:00 2026     claude --model opus',
  '  600     1   600    0   ?? Ss     501 Fri Oct  2 08:00:00 2026     tmux new-session -d -s 0',
  '  610   600   610  610 16/12 Ss+    501 Fri Oct  2 08:00:00 2026     -zsh',
  '  700     1   700    0   ?? Z      501 Fri Oct  2 08:30:00 2026     ',
  '',
].join('\n');

// The same columns on Linux, with `tty=` instead of `tdev=`.
const LINUX_PS = [
  '    1     0     1    -1 ?        Ss       0 Fri Oct  2 09:00:00 2026 /sbin/init',
  '  800     1   800    -1 ?        Ss    1000 Fri Oct  2 09:00:05 2026 tmux: server',
  '  810   800   810   830 pts/3    Ss    1000 Fri Oct  2 09:00:06 2026 -bash',
  '  830   810   830   830 pts/3    Sl+   1000 Fri Oct  2 09:01:00 2026 node /usr/lib/node_modules/@openai/codex/bin/codex.js',
].join('\n');

describe('parseProcessTable', () => {
  it('reads the extended columns on macOS', () => {
    const table = parseProcessTable(MAC_PS);
    expect(table.extended).toBe(true);
    expect(table.procs.get(530)).toEqual({
      ppid: 520,
      pgid: 530,
      tpgid: 530,
      tty: 'ttys001',
      stat: 'S+',
      uid: 501,
    });
    expect(table.procs.get(610)?.tty).toBe('ttys012');
    expect(table.procs.get(600)).toMatchObject({ tty: null, tpgid: 0, uid: 501 });
    expect(table.procs.get(510)?.uid).toBe(0);
    expect(table.procs.get(700)?.stat).toBe('Z');
    // The fields every reader already uses keep their shape.
    expect(table.args.get(530)).toBe('claude --model opus');
    expect(table.args.get(500)).toBe(
      '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'
    );
    expect(table.args.has(700)).toBe(false);
    expect(table.starts.get(530)).toBe('Fri Oct 2 09:11:00 2026');
    expect(descendants(table, 500)).toEqual([500, 510, 520, 530]);
  });

  it('reads the extended columns on Linux', () => {
    const table = parseProcessTable(LINUX_PS);
    expect(table.extended).toBe(true);
    expect(table.procs.get(800)).toEqual({
      ppid: 1,
      pgid: 800,
      tpgid: -1,
      tty: null,
      stat: 'Ss',
      uid: 1000,
    });
    expect(table.procs.get(830)?.tty).toBe('pts/3');
    expect(table.args.get(800)).toBe('tmux: server');
    expect(descendants(table, 800)).toEqual([800, 810, 830]);
  });

  it('still reads the basic pid, ppid, lstart and args columns', () => {
    const table = parseProcessTable(
      [
        '  100     1 Fri Oct  2 09:59:00 2026     /usr/local/bin/untether fwd zsh',
        '  200   100 Fri Oct  2 09:59:01 2026     -zsh',
      ].join('\n')
    );
    expect(table.extended).toBe(false);
    expect(table.procs.size).toBe(0);
    expect(table.args.get(100)).toBe('/usr/local/bin/untether fwd zsh');
    expect(table.starts.get(200)).toBe('Fri Oct 2 09:59:01 2026');
    expect(table.children.get(100)).toEqual([200]);
  });

  it('keeps arguments with spaces, and a newline as ps writes it (\\012)', () => {
    const table = parseProcessTable(
      [
        '  900   520   900  900 16/1 S+     501 Fri Oct  2 10:00:00 2026     node -e run() x\\012y "a  b"',
        '  901   520   901  901 16/1 S+     501 Fri Oct  2 10:00:01 2026     /Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=renderer',
      ].join('\n')
    );
    expect(table.args.get(900)).toBe('node -e run() x\\012y "a  b"');
    expect(table.args.get(901)).toBe(
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=renderer'
    );
  });

  it('skips lines it cannot read', () => {
    const table = parseProcessTable(
      [
        'garbage',
        '  PID  PPID STARTED',
        '  12 Fri Oct  2 09:00:00 2026 truncated',
        '  530   520   530  530 16/1 S+     501 Fri Oct  2 09:11:00 2026     claude',
      ].join('\n')
    );
    expect([...table.starts.keys()]).toEqual([530]);
  });
});

describe('terminalName', () => {
  it('names macOS ptys, keeps Linux names and drops "no terminal"', () => {
    expect(terminalName('16/1')).toBe('ttys001');
    expect(terminalName('16/123')).toBe('ttys123');
    expect(terminalName('16/1000')).toBe('ttys1000');
    expect(terminalName('pts/3')).toBe('pts/3');
    expect(terminalName('??')).toBeNull();
    expect(terminalName('?')).toBeNull();
  });
});

describe('readProcessTable', () => {
  it('asks for the terminal as tdev on macOS and as tty on Linux', () => {
    expect(processTableColumns('darwin')).toBe(
      'pid=,ppid=,pgid=,tpgid=,tdev=,stat=,uid=,lstart=,args='
    );
    expect(processTableColumns('linux')).toBe(
      'pid=,ppid=,pgid=,tpgid=,tty=,stat=,uid=,lstart=,args='
    );
  });

  it('runs one ps with the extended columns', async () => {
    const runs: string[] = [];
    const table = await readProcessTable(async (columns) => {
      runs.push(columns);
      return MAC_PS;
    }, 'darwin');
    expect(runs).toEqual([processTableColumns('darwin')]);
    expect(table.extended).toBe(true);
  });

  it('falls back to the basic columns when ps refuses the extended ones', async () => {
    const runs: string[] = [];
    const table = await readProcessTable(async (columns) => {
      runs.push(columns);
      if (columns.includes('tdev')) throw new Error('ps: tdev: keyword not found');
      return '  530   520 Fri Oct  2 09:11:00 2026     claude\n';
    }, 'darwin');
    expect(runs).toEqual([processTableColumns('darwin'), 'pid=,ppid=,lstart=,args=']);
    expect(table.extended).toBe(false);
    expect(table.args.get(530)).toBe('claude');
  });
});

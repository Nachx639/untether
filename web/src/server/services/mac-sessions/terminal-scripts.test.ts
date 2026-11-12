import { describe, expect, it } from 'vitest';
import {
  ITERM_PROBE,
  ITERM_TYPE,
  outcomeProblem,
  parseProbe,
  parseType,
  probeArgs,
  probeProblem,
  sameTab,
  scriptTty,
  type TabRef,
  TERMINAL_PROBE,
  TERMINAL_SCRIPTS,
  TERMINAL_TYPE,
  typeArgs,
} from './terminal-scripts.js';

// Unit tests only: these scripts are never run here. Running them sends Apple Events to
// Terminal or iTerm2, which hang while the screen is locked; that is for the manual probes.

const SID = 'w0t1p0:6A5B4C3D-1111-2222-3333-444455556666';

describe('the scripts', () => {
  it('are fixed text that takes every value from argv', () => {
    for (const script of TERMINAL_SCRIPTS) {
      expect(Object.isFrozen(script.lines), script.name).toBe(true);
      expect(script.lines[0]).toBe('on run argv');
      expect(script.lines.at(-1)).toBe('end run');
      for (const line of script.lines) {
        expect(line, script.name).not.toMatch(/\$\{|\{\{|%s/);
      }
    }
  });

  it('never use System Events, keystrokes, activate, launch or the front window', () => {
    for (const script of TERMINAL_SCRIPTS) {
      const text = script.lines.join('\n');
      expect(text, script.name).not.toMatch(
        /System Events|keystroke|key code|\bactivate\b|\blaunch\b|\breopen\b|front window|frontmost|selected tab|current session|current window/i
      );
      // Apps only by bundle id, so a renamed or missing app is never looked up or launched.
      expect(text.match(/application\s+(?!id\b)/g), script.name).toBeNull();
    }
  });

  it('check the app is running before any tell, and keep every tell inside with timeout', () => {
    for (const script of TERMINAL_SCRIPTS) {
      const lines = script.lines;
      const running = lines.findIndex((line) => /is running\) then return/.test(line));
      const timeout = lines.indexOf('with timeout of 4 seconds');
      const tell = lines.findIndex((line) => line.startsWith('tell application id'));
      expect(running, script.name).toBeGreaterThan(0);
      expect(running).toBeLessThan(timeout);
      expect(timeout).toBeLessThan(tell);
      expect(lines.lastIndexOf('end timeout')).toBeGreaterThan(lines.lastIndexOf('end tell'));
      expect(lines.filter((line) => line.startsWith('tell application'))).toHaveLength(1);
    }
  });

  it('have balanced blocks', () => {
    const opens: Array<[RegExp, string]> = [
      [/^tell application id "[\w.]+"$/, 'end tell'],
      [/^repeat with /, 'end repeat'],
      [/^try$/, 'end try'],
      [/^with timeout of /, 'end timeout'],
      [/^on run argv$/, 'end run'],
    ];
    for (const script of TERMINAL_SCRIPTS) {
      const stack: string[] = [];
      for (const line of script.lines) {
        const open = opens.find(([re]) => re.test(line));
        if (open) stack.push(open[1]);
        else if (line.startsWith('end ')) expect(stack.pop(), `${script.name}: ${line}`).toBe(line);
        else if (line.startsWith('on error')) expect(stack.at(-1)).toBe('end try');
        // A one-line if never opens a block: none of ours spans lines.
        if (line.startsWith('if ')) expect(line, script.name).toMatch(/ then \S/);
      }
      expect(stack, script.name).toEqual([]);
    }
  });

  it('address their own app only', () => {
    for (const script of [TERMINAL_PROBE, TERMINAL_TYPE]) {
      expect(script.lines.join('\n').match(/application id "[^"]+"/g)).toEqual([
        'application id "com.apple.Terminal"',
        'application id "com.apple.Terminal"',
      ]);
    }
    for (const script of [ITERM_PROBE, ITERM_TYPE]) {
      expect(new Set(script.lines.join('\n').match(/application id "[^"]+"/g))).toEqual(
        new Set(['application id "com.googlecode.iterm2"'])
      );
    }
  });

  it('type only after checking the tab: same tty, not busy, the agent gone', () => {
    const terminal = TERMINAL_TYPE.lines.join('\n');
    const typed = terminal.indexOf('do script');
    for (const check of ['result=moved', 'result=busy', 'result=agent-running', 'result=gone']) {
      expect(terminal.indexOf(check)).toBeGreaterThan(0);
      expect(terminal.indexOf(check)).toBeLessThan(typed);
    }
    expect(terminal).toContain('do script lineText in tab idx of window id wid');
    const iterm = ITERM_TYPE.lines.join('\n');
    expect(iterm.indexOf('result=moved')).toBeLessThan(iterm.indexOf('write text'));
    expect(iterm).toContain('tell s to write text lineText');
  });
});

describe('script arguments', () => {
  it('give the tty as /dev/…, and refuse anything that is not a tty', () => {
    expect(scriptTty('ttys001')).toBe('/dev/ttys001');
    expect(scriptTty('/dev/ttys012')).toBe('/dev/ttys012');
    for (const bad of ['', '/dev/', '../ttys001', '/dev/ttys001 x', '/dev/null', '-ttys001']) {
      expect(scriptTty(bad), bad).toBeUndefined();
    }
  });

  it('probe: Terminal gets tty, agent name and the contents flag; iTerm2 tty and flag', () => {
    expect(probeArgs('Terminal', 'ttys001', 'claude', true)).toEqual({
      script: TERMINAL_PROBE,
      args: ['/dev/ttys001', 'claude', '1'],
    });
    expect(probeArgs('iTerm', '/dev/ttys004', 'claude', false)).toEqual({
      script: ITERM_PROBE,
      args: ['/dev/ttys004', '0'],
    });
    expect(probeArgs('Terminal', 'ttys001', 'Claude Code', true)).toBeUndefined();
  });

  it('type: the tab found by the probe, and the line last', () => {
    const line = "cd '/a b' && ut claude --resume 'x'";
    expect(
      typeArgs({ app: 'Terminal', windowId: 7, tabIndex: 2 }, 'ttys001', 'claude', line)
    ).toEqual({ script: TERMINAL_TYPE, args: ['/dev/ttys001', '7', '2', 'claude', line] });
    expect(
      typeArgs(
        { app: 'iTerm', windowId: 3, tabIndex: 1, sessionId: SID },
        '/dev/ttys004',
        'claude',
        line
      )
    ).toEqual({ script: ITERM_TYPE, args: ['/dev/ttys004', SID, line] });
    const terminal: TabRef = { app: 'Terminal', windowId: 7, tabIndex: 2 };
    expect(typeArgs(terminal, 'ttys001', 'claude', '')).toBeUndefined();
    expect(typeArgs(terminal, 'ttys001', 'claude', '-rf')).toBeUndefined();
    expect(
      typeArgs({ app: 'iTerm', windowId: 3, tabIndex: 1, sessionId: '-x' }, 'ttys1', 'claude', line)
    ).toBeUndefined();
  });
});

describe('parsing what the scripts answer', () => {
  it('Terminal: one tab found, busy, with the agent in it', () => {
    expect(
      parseProbe('Terminal', 'result=found\nwindow=1234\ntab=2\nbusy=true\nagent=true')
    ).toEqual({
      kind: 'found',
      tab: { app: 'Terminal', windowId: 1234, tabIndex: 2 },
      busy: true,
      agentPresent: true,
    });
  });

  it('keeps the contents whole, even when they look like keys or the marker', () => {
    const screen = 'result=typed\nwindow=9\n--contents--\n❯  \n\n';
    const parsed = parseProbe(
      'Terminal',
      `result=found\nwindow=1\ntab=1\nbusy=false\nagent=false\n--contents--\n${screen}`
    );
    expect(parsed).toMatchObject({ kind: 'found', contents: screen, busy: false });
    expect(
      parseProbe('Terminal', 'result=found\nwindow=1\ntab=1\nbusy=true\nagent=true\n--contents--\n')
    ).toMatchObject({ contents: '' });
  });

  it('iTerm2: the session id', () => {
    expect(
      parseProbe('iTerm', `result=found\nwindow=5\ntab=3\nsession=${SID}\n--contents--\nhi`)
    ).toEqual({
      kind: 'found',
      tab: { app: 'iTerm', windowId: 5, tabIndex: 3, sessionId: SID },
      contents: 'hi',
    });
  });

  it('no tab or several, the app not running, and anything unreadable', () => {
    expect(parseProbe('Terminal', 'result=matches\nmatches=0')).toEqual({
      kind: 'matches',
      count: 0,
    });
    expect(parseProbe('iTerm', 'result=matches\nmatches=2')).toEqual({ kind: 'matches', count: 2 });
    expect(parseProbe('Terminal', 'result=not-running')).toEqual({ kind: 'not-running' });
    for (const stdout of [
      '',
      'garbage',
      'result=matches\nmatches=1',
      'result=matches',
      'result=found\nwindow=x\ntab=1\nbusy=true\nagent=true',
      'result=found\nwindow=1\ntab=0\nbusy=true\nagent=true',
      'result=found\nwindow=1\ntab=1\nbusy=yes\nagent=true',
      'result=found\nwindow=1\ntab=1',
      '--contents--\nresult=found\nwindow=1\ntab=1\nbusy=true\nagent=true',
    ]) {
      expect(parseProbe('Terminal', stdout), stdout).toEqual({ kind: 'unparsable' });
    }
    expect(parseProbe('iTerm', 'result=found\nwindow=1\ntab=1\nsession=-bad')).toEqual({
      kind: 'unparsable',
    });
  });

  it('the typing results', () => {
    for (const result of ['typed', 'moved', 'busy', 'agent-running', 'gone', 'not-running']) {
      expect(parseType(`result=${result}`)).toBe(result);
    }
    expect(parseType('result=typed\r\n')).toBe('typed');
    for (const stdout of ['', 'typed', 'result=done', 'result=']) {
      expect(parseType(stdout), stdout).toBe('unparsable');
    }
  });

  it('the same tab is the same window, tab and (iTerm2) session', () => {
    const terminal: TabRef = { app: 'Terminal', windowId: 1, tabIndex: 2 };
    expect(sameTab(terminal, { ...terminal })).toBe(true);
    expect(sameTab(terminal, { ...terminal, tabIndex: 3 })).toBe(false);
    const iterm: TabRef = { app: 'iTerm', windowId: 1, tabIndex: 2, sessionId: SID };
    expect(sameTab(iterm, { ...iterm })).toBe(true);
    expect(sameTab(iterm, { ...iterm, sessionId: `${SID}x` })).toBe(false);
    expect(sameTab(terminal, iterm)).toBe(false);
  });

  it('maps a failed probe or call to the plan error', () => {
    expect(probeProblem({ kind: 'matches', count: 0 })).toBe('tab-not-found');
    expect(probeProblem({ kind: 'matches', count: 2 })).toBe('tab-ambiguous');
    expect(probeProblem({ kind: 'not-running' })).toBe('tab-not-found');
    expect(probeProblem({ kind: 'unparsable' })).toBe('unresponsive');
    expect(outcomeProblem({ kind: 'ok', stdout: '', pid: 1 })).toBeUndefined();
    expect(outcomeProblem({ kind: 'error', error: 'denied', code: -1743 })).toBe(
      'automation-denied'
    );
    expect(outcomeProblem({ kind: 'error', error: 'gone', code: -1728 })).toBe('tab-not-found');
    expect(outcomeProblem({ kind: 'error', error: 'event-timeout', code: -1712 })).toBe(
      'unresponsive'
    );
    expect(outcomeProblem({ kind: 'timeout', pid: 1 })).toBe('unresponsive');
    expect(outcomeProblem({ kind: 'in-flight' })).toBe('unresponsive');
  });
});

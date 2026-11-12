import { describe, expect, it, vi } from 'vitest';
import { ITERM_CLOSE_IDLE, TERMINAL_CLOSE_IDLE } from './mac-sessions/terminal-scripts.js';
import {
  claudeAtWork,
  closeIdleTerminalWindow,
  leaveTerminalWindow,
  windowNoticeText,
} from './move-to-untether.js';
import { SessionReplacements } from './session-replacements.js';

// Llevar a Untether (2026-10-25): a `ut claude` session leaves its terminal window for a
// shielded Untether session (the route is tested in routes/sessions-move-to-untether.test.ts).

describe('claudeAtWork', () => {
  it('asks only while Claude works or waits for an answer', () => {
    expect(claudeAtWork(undefined)).toBeNull();
    expect(claudeAtWork({ status: 'idle' })).toBeNull();
    expect(claudeAtWork({ status: 'busy' })).toBe('busy');
    expect(claudeAtWork({ status: 'busy', waitingForBackground: true })).toBe('busy');
    expect(claudeAtWork({ status: 'waiting' })).toBe('waiting');
  });
});

describe('windowNoticeText', () => {
  it('writes one printable line, never an escape sequence', () => {
    expect(windowNoticeText('Sigue en Untether.\u001b]0;pwned\u0007\nok', 'x')).toBe(
      'Sigue en Untether. ]0;pwned ok'
    );
    expect(windowNoticeText('a'.repeat(1000), 'x')).toHaveLength(300);
  });

  it('falls back to English with the session name', () => {
    expect(windowNoticeText(undefined, 'bakery')).toBe(
      'Untether: this session continues in Untether («bakery»).'
    );
    expect(windowNoticeText('\u001b\u0007', '')).toBe(
      'Untether: this session continues in Untether.'
    );
  });
});

describe('leaveTerminalWindow', () => {
  const delay = async () => {};
  const ttyOpen = () => true;

  it('writes the notice into the window for a forwarder that did not, then closes it', async () => {
    const writeTty = vi.fn();
    const closeWindow = vi.fn(async () => 'closed' as const);
    const result = await leaveTerminalWindow(
      { tty: '/dev/ttys007', app: 'Terminal', notice: 'Sigue en Untether.' },
      { writeTty, ttyOpen, closeWindow, delay, forwarderWroteNotice: () => false }
    );
    expect(result).toEqual({ notice: 'server', closed: 'closed' });
    expect(writeTty).toHaveBeenCalledWith(
      '/dev/ttys007',
      '\r\n\u001b[1mSigue en Untether.\u001b[0m\r\n'
    );
    expect(closeWindow).toHaveBeenCalledWith('Terminal', '/dev/ttys007');
  });

  it('never writes it twice: the forwarder wrote it once it had ended', async () => {
    let ended = false;
    let looks = 0;
    const writeTty = vi.fn();
    const result = await leaveTerminalWindow(
      { tty: '/dev/ttys007', app: 'Terminal', notice: 'n' },
      {
        writeTty,
        ttyOpen,
        closeWindow: async () => 'kept',
        delay,
        forwarderEnded: () => {
          looks++;
          if (looks === 3) ended = true;
          return ended;
        },
        // Only on disk once the forwarder has written its exit.
        forwarderWroteNotice: () => ended,
      }
    );
    expect(result).toEqual({ notice: 'forwarder', closed: 'kept' });
    expect(writeTty).not.toHaveBeenCalled();
  });

  // 2026-10-25, first real move: `ut` exited 166, the zsh wrapper exited its shell and the tab
  // closed before the server's write ("notice not written, unavailable").
  it('a tab its shell closed reads gone, whoever wrote the notice', async () => {
    const closeWindow = vi.fn(async () => 'closed' as const);
    const writeTty = vi.fn(() => {
      throw new Error('ENXIO');
    });
    const gone = () => false;
    expect(
      await leaveTerminalWindow(
        { tty: '/dev/ttys007', app: 'Terminal', notice: 'n' },
        { writeTty, ttyOpen: gone, closeWindow, delay, forwarderWroteNotice: () => true }
      )
    ).toEqual({ notice: 'forwarder', closed: 'gone' });
    expect(
      await leaveTerminalWindow(
        { tty: '/dev/ttys007', app: 'Terminal', notice: 'n' },
        { writeTty, ttyOpen: gone, closeWindow, delay }
      )
    ).toEqual({ notice: 'none', closed: 'gone' });
    // It closed between the look and the write.
    let open = true;
    expect(
      await leaveTerminalWindow(
        { tty: '/dev/ttys007', app: 'Terminal', notice: 'n' },
        {
          writeTty: () => {
            open = false;
            throw new Error('EIO');
          },
          ttyOpen: () => open,
          closeWindow,
          delay,
        }
      )
    ).toEqual({ notice: 'none', closed: 'gone' });
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it('leaves the notice when the window can not be closed', async () => {
    const kept = await leaveTerminalWindow(
      { tty: '/dev/ttys007', app: 'Visual Studio Code', notice: 'n' },
      { writeTty: () => {}, ttyOpen, closeWindow: async () => 'unavailable', delay }
    );
    expect(kept).toEqual({ notice: 'server', closed: 'unavailable' });
  });
});

describe('closeIdleTerminalWindow', () => {
  it('runs the close script of Terminal or iTerm2 with the tty as argv', async () => {
    const run = vi.fn(async () => ({ kind: 'ok' as const, stdout: 'result=closed\n', pid: 1 }));
    expect(await closeIdleTerminalWindow(run, 'Terminal', 'ttys007')).toBe('closed');
    expect(run).toHaveBeenLastCalledWith('Terminal', TERMINAL_CLOSE_IDLE, ['/dev/ttys007']);
    expect(await closeIdleTerminalWindow(run, 'iTerm', '/dev/ttys007')).toBe('closed');
    expect(run).toHaveBeenLastCalledWith('iTerm', ITERM_CLOSE_IDLE, ['/dev/ttys007']);
  });

  it('keeps a window with other tabs or a program, and never scripts other apps', async () => {
    const answer = (stdout: string) => async () => ({ kind: 'ok' as const, stdout, pid: 1 });
    expect(await closeIdleTerminalWindow(answer('result=kept'), 'Terminal', 'ttys1')).toBe('kept');
    expect(
      await closeIdleTerminalWindow(answer('result=matches\nmatches=0'), 'Terminal', 'ttys1')
    ).toBe('not-found');
    expect(await closeIdleTerminalWindow(answer('garbage'), 'Terminal', 'ttys1')).toBe(
      'unavailable'
    );
    const run = vi.fn();
    expect(await closeIdleTerminalWindow(run, 'Visual Studio Code', 'ttys1')).toBe('unavailable');
    expect(await closeIdleTerminalWindow(run, 'Terminal', '../../etc')).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
    expect(
      await closeIdleTerminalWindow(
        async () => ({ kind: 'error', error: 'denied' }),
        'Terminal',
        'ttys1'
      )
    ).toBe('unavailable');
  });
});

describe('SessionReplacements', () => {
  it('tells every store in order, whatever one of them throws', async () => {
    const log = vi.fn();
    const replacements = new SessionReplacements(log);
    const heard: string[] = [];
    replacements.followedBy('broken', {
      replacing: () => {
        throw new Error('boom');
      },
      replaced: () => {
        throw new Error('boom');
      },
      references: () => {
        throw new Error('boom');
      },
    });
    replacements.followedBy('tasks', {
      replacing: (id) => heard.push(`replacing ${id}`),
      notReplaced: (id) => heard.push(`kept ${id}`),
      replaced: async (from, to, options) => {
        heard.push(`replaced ${from} → ${to} ${options.resumed ? 'resumed' : ''}`.trim());
        return from === 'a' ? 2 : 0;
      },
      references: () => ['a', 'x', ''],
    });
    replacements.followedBy('links', { replaced: () => 0, references: () => ['x'] });
    replacements.replacing('a');
    // The stores that moved something, and how many.
    expect(await replacements.replaced('a', 'b')).toEqual([{ name: 'tasks', moved: 2 }]);
    expect(await replacements.replaced('c', 'd', { resumed: true })).toEqual([]);
    replacements.notReplaced('e');
    expect(heard).toEqual(['replacing a', 'replaced a → b', 'replaced c → d resumed', 'kept e']);
    expect(replacements.references()).toEqual(['a', 'x']);
    expect(log).toHaveBeenCalledTimes(4);
    expect(replacements.names()).toEqual(['broken', 'tasks', 'links']);
  });
});

import { execFile } from 'child_process';
import type * as Pty from 'node-pty';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseForegroundPgids, readForegroundPgids } from './foreground-pgids.js';

const execFileAsync = promisify(execFile);

describe('parseForegroundPgids', () => {
  it('maps pids to their terminal foreground group and skips pids without a terminal', () => {
    expect(parseForegroundPgids('  101   205\n  102     0\n 103    -1\ngarbage\n')).toEqual(
      new Map([[101, 205]])
    );
  });
});

describe('readForegroundPgids', () => {
  let shell: Pty.IPty | undefined;
  afterEach(() => {
    shell?.kill('SIGKILL');
    shell = undefined;
  });

  // 2026-10-23: failed in a project check on a loaded Mac ("foreground group never changed"). The
  // shell owns its terminal from the moment the pty exists, before sh has started, so the command was
  // typed into a shell still starting up, and the wait gave up after 100 polls however slow the Mac
  // was. It now waits for the prompt before typing and polls until a deadline.
  it('sees a command take over the terminal and give it back', { timeout: 60000 }, async () => {
    if (process.platform === 'win32') return;
    // The test setup mocks node-pty; this needs a real terminal.
    const pty = await vi.importActual<typeof Pty>('node-pty');
    const term = pty.spawn('/bin/sh', ['-i'], {
      cols: 80,
      rows: 24,
      env: { PATH: '/bin:/usr/bin', PS1: '$ ' },
    });
    shell = term;
    let output = '';
    term.onData((data) => {
      output += data;
    });
    const foreground = async () => (await readForegroundPgids([term.pid])).get(term.pid);
    const waitFor = async (what: string, check: (pgid: number | undefined) => boolean) => {
      const deadline = Date.now() + 15000;
      let pgid: number | undefined;
      while (Date.now() < deadline) {
        pgid = await foreground();
        if (check(pgid)) return pgid;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `${what}: foreground group stayed ${pgid}, shell ${term.pid}, output ${JSON.stringify(output)}`
      );
    };

    // An interactive shell owns its terminal…
    await waitFor('shell at its prompt', (pgid) => pgid === term.pid && output.includes('$ '));
    term.write('sleep 30\r');
    // …a job it runs gets its own foreground group…
    const job = await waitFor(
      'job in the foreground',
      (pgid) => pgid !== undefined && pgid !== term.pid
    );
    expect(job).toBeGreaterThan(0);
    // 2026-10-24: under load the new group was still the forked shell, before its exec of
    // sleep, with the shell's SIGINT handler: the ^C was swallowed and sleep ran on. ^C once
    // the job runs sleep.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const { stdout } = await execFileAsync('ps', ['-o', 'comm=', '-p', String(job)]).catch(
        () => ({ stdout: '' })
      );
      if (stdout.trim().endsWith('sleep')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    term.write('\x03');
    // …and the shell gets the terminal back when the job ends.
    await waitFor('shell back in the foreground', (pgid) => pgid === term.pid);
  });

  it('leaves out pids that are gone', async () => {
    expect(await readForegroundPgids([2 ** 22 + 12345])).toEqual(new Map());
    expect(await readForegroundPgids([])).toEqual(new Map());
  });
});

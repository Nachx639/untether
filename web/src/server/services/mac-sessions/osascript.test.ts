import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAC_SHARE_CORPUS } from '../../../test/fixtures/mac-share-corpus.js';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import {
  classifyOsascriptError,
  defineOsascript,
  isSafeOsascriptArg,
  OSASCRIPT_PATH,
  OSASCRIPT_TIMEOUT_MS,
  OsascriptRunner,
} from './osascript.js';

/**
 * No test here sends an Apple Event. The real osascript only runs scripts with no `tell`: they
 * return their own argv, which is safe even with the Mac locked. Everything else runs fakes.
 */

let dir: string;
let sleeper: string;

function fake(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Processes whose arguments mention our temp folder: the fakes and their sleeps. */
function leftovers(): string {
  const result = spawnSync('pgrep', ['-fl', dir], { encoding: 'utf8' });
  return result.stdout.trim();
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-osascript-test-'));
  // A sleep whose own argv[0] names our folder, so pgrep finds it even as a grandchild.
  sleeper = path.join(dir, 'ut-fake-sleep');
  fs.symlinkSync('/bin/sleep', sleeper);
});

afterAll(() => {
  if (dir?.includes('ut-osascript-test-')) fs.rmSync(dir, RM_TEST_DIR);
});

const ECHO = defineOsascript('echo-argv', ['on run argv', 'return argv', 'end run']);

describe('osascript runner: what it runs', () => {
  it('passes each fixed line after its own -e, then the arguments, untouched', async () => {
    const printArgs = fake('print-args', `printf '%s\\0' "$@"`);
    const runner = new OsascriptRunner({ binary: printArgs });
    const script = defineOsascript('two-lines', ['on run argv', 'end run']);
    const outcome = await runner.run('Terminal', script, ['/dev/ttys001', "it's", '']);
    expect(outcome.kind).toBe('ok');
    const stdout = outcome.kind === 'ok' ? outcome.stdout : '';
    expect(stdout.split('\0')).toEqual([
      '-e',
      'on run argv',
      '-e',
      'end run',
      '/dev/ttys001',
      "it's",
      '',
      '',
    ]);
  });

  it('refuses a script it did not define, an argument starting with - or holding NUL', async () => {
    const marker = path.join(dir, 'ran');
    const runner = new OsascriptRunner({ binary: fake('touch-marker', `touch '${marker}'`) });
    const lookalike = { name: 'echo-argv', lines: ECHO.lines };
    expect(await runner.run('Terminal', lookalike, [])).toEqual({
      kind: 'refused',
      why: 'unknown-script',
    });
    for (const bad of ['-e', '--', '-', 'a\0b']) {
      expect(await runner.run('Terminal', ECHO, ['ok', bad]), bad).toEqual({
        kind: 'refused',
        why: 'bad-arg',
      });
    }
    expect(fs.existsSync(marker)).toBe(false);
    expect(isSafeOsascriptArg('a-b')).toBe(true);
    expect(isSafeOsascriptArg(' -x')).toBe(true);
    expect(isSafeOsascriptArg(3)).toBe(false);
    expect(() =>
      defineOsascript(
        'broken',
        ['say "a', 'b"'].map((l) => `${l}\n`)
      )
    ).toThrow();
  });

  it('never runs the real osascript in tests unless asked', () => {
    expect(() => new OsascriptRunner()).toThrow(/vitest/);
    expect(() => new OsascriptRunner({ allowRealInTests: true })).not.toThrow();
  });

  it('reads the error number osascript prints', () => {
    const line = (code: number) => `0:42: execution error: Terminal got an error: x. (${code})\n`;
    expect(classifyOsascriptError(line(-1743))).toEqual({ error: 'denied', code: -1743 });
    expect(classifyOsascriptError(line(-1712))).toEqual({ error: 'event-timeout', code: -1712 });
    expect(classifyOsascriptError(line(-600))).toEqual({ error: 'not-running', code: -600 });
    expect(classifyOsascriptError(line(-1728))).toEqual({ error: 'gone', code: -1728 });
    expect(classifyOsascriptError(line(-1719))).toEqual({ error: 'gone', code: -1719 });
    expect(classifyOsascriptError(line(-2741))).toEqual({ error: 'failed', code: -2741 });
    expect(classifyOsascriptError('osascript: something odd')).toEqual({ error: 'failed' });
  });

  it('turns a failing osascript into its error, and logs no argument or output', async () => {
    const log = vi.fn();
    const denied = fake(
      'denied',
      `echo 'secret-out'; echo 'execution error: Not authorized to send Apple events to Terminal. (-1743)' >&2; exit 1`
    );
    const runner = new OsascriptRunner({ binary: denied, log });
    const outcome = await runner.run('Terminal', ECHO, ['secret-arg']);
    expect(outcome).toMatchObject({ kind: 'error', error: 'denied', code: -1743 });
    const logged = log.mock.calls.map((call) => call[0]).join('\n');
    expect(logged).toContain('echo-argv');
    expect(logged).toContain('Terminal');
    expect(logged).not.toContain('secret');
  });

  it('keeps the whole output of a call that writes a lot just before exiting', async () => {
    const big = fake('big', `head -c 300000 /dev/zero | tr '\\0' x`);
    const outcome = await new OsascriptRunner({ binary: big }).run('Terminal', ECHO, []);
    expect(outcome.kind === 'ok' ? outcome.stdout.length : outcome.kind).toBe(300000);
  });

  it('answers failed when the binary cannot start', async () => {
    const runner = new OsascriptRunner({ binary: path.join(dir, 'missing') });
    expect(await runner.run('Terminal', ECHO, [])).toMatchObject({
      kind: 'error',
      error: 'failed',
    });
    // The app is free again afterwards.
    expect(await runner.run('Terminal', ECHO, [])).toMatchObject({ kind: 'error' });
  });
});

describe('osascript runner: it never hangs and leaves nothing behind', () => {
  it('kills a hung osascript at 5 s, also one that ignores SIGTERM and has a child', async () => {
    // exec: the fake is the sleep itself. The stubborn one ignores SIGTERM, and so does its
    // child, which only the process-group SIGKILL reaches.
    const hung = fake('hung', `exec '${sleeper}' 60`);
    const stubborn = fake('stubborn', `trap '' TERM\n'${sleeper}' 61\necho never`);
    // 2026-11-02: the 5 s default is counted on fake timers (setTimeout/clearTimeout only), so
    // the test no longer waits 5 real seconds; the children, the kill and the exits stay real.
    // vi.waitFor would advance the fake clock on each check, so the wait polls on a real timer.
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const settled: string[] = [];
      const calls = [
        new OsascriptRunner({ binary: hung }).run('Terminal', ECHO, []),
        new OsascriptRunner({ binary: stubborn }).run('iTerm', ECHO, []),
      ].map((call, i) => call.finally(() => settled.push(String(i))));
      // Both hang for real first: the stubborn one has set its trap and started its child.
      const deadline = Date.now() + 10_000;
      let running = leftovers();
      while (!(running.includes(`${sleeper} 60`) && running.includes(`${sleeper} 61`))) {
        if (Date.now() > deadline) throw new Error(`the fakes never started: ${running}`);
        await new Promise((resolve) => realSetTimeout(resolve, 20));
        running = leftovers();
      }
      expect(OSASCRIPT_TIMEOUT_MS).toBe(5000);
      vi.advanceTimersByTime(OSASCRIPT_TIMEOUT_MS - 1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toEqual([]);
      expect(leftovers()).toContain(`${sleeper} 61`);
      // At 5 s both are killed: what answers now is their real exit.
      vi.advanceTimersByTime(1);
      const [a, b] = await Promise.all(calls);
      expect(a.kind).toBe('timeout');
      expect(b.kind).toBe('timeout');
      for (const outcome of [a, b]) {
        if (outcome.kind === 'timeout') expect(gone(outcome.pid)).toBe(true);
      }
      expect(leftovers()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('runs one call per app: a second one while the first is pending is refused', async () => {
    const runner = new OsascriptRunner({
      // The pending checks below are synchronous, so the call only has to outlive this tick.
      binary: fake('slow', `exec '${sleeper}' 0.05`),
      timeoutMs: 2000,
    });
    const first = runner.run('Terminal', ECHO, []);
    expect(runner.inFlight).toBe(1);
    expect(await runner.run('Terminal', ECHO, [])).toEqual({ kind: 'in-flight' });
    // Another app is not blocked by it.
    const other = runner.run('iTerm', ECHO, []);
    expect(runner.inFlight).toBe(2);
    expect((await first).kind).toBe('ok');
    expect((await other).kind).toBe('ok');
    // And the app is free once the first one ended.
    expect((await runner.run('Terminal', ECHO, [])).kind).toBe('ok');
  });

  it('dispose kills a call in flight at once and refuses new ones', async () => {
    const runner = new OsascriptRunner({ binary: fake('hung2', `trap '' TERM\n'${sleeper}' 62`) });
    const call = runner.run('Terminal', ECHO, []);
    // 2026-11-02: waits for the fake's child instead of a fixed 100 ms, which under load could
    // end before the trap was set.
    await vi.waitFor(() => expect(leftovers()).toContain(`${sleeper} 62`), {
      timeout: 10_000,
      interval: 20,
    });
    const started = Date.now();
    runner.dispose();
    const outcome = await call;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(outcome.kind).toBe('disposed');
    if (outcome.kind === 'disposed' && outcome.pid) expect(gone(outcome.pid)).toBe(true);
    expect(runner.inFlight).toBe(0);
    expect(await runner.run('Terminal', ECHO, [])).toEqual({ kind: 'disposed' });
    expect(leftovers()).toBe('');
  });

  it('a short custom timeout works the same way', async () => {
    const runner = new OsascriptRunner({
      binary: fake('hung3', `exec '${sleeper}' 63`),
      timeoutMs: 200,
    });
    const started = Date.now();
    const outcome = await runner.run('Terminal', ECHO, []);
    expect(outcome.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(leftovers()).toBe('');
  });
});

describe.skipIf(process.platform !== 'darwin')(
  'the real osascript, with no tell (no Apple Event)',
  () => {
    // Joins argv with U+001F, which the corpus never holds, after their count.
    const ROUND_TRIP = defineOsascript('argv-round-trip', [
      'on run argv',
      'set sep to character id 31',
      "set AppleScript's text item delimiters to sep",
      'return ((count of argv) as text) & sep & (argv as text)',
      'end run',
    ]);
    const ITEM_4 = defineOsascript('argv-item-4', [
      'on run argv',
      'return item 4 of argv',
      'end run',
    ]);

    it('the script text has no tell, no application and no event', () => {
      for (const script of [ROUND_TRIP, ITEM_4]) {
        expect(script.lines.join('\n')).not.toMatch(/\btell\b|application|activate|System Events/i);
      }
    });

    it('gives back every corpus value byte for byte, and in order', async () => {
      const runner = new OsascriptRunner({ allowRealInTests: true });
      const values = [...MAC_SHARE_CORPUS, '', 'end run', 'on run argv'];
      const outcome = await runner.run('argv', ROUND_TRIP, values);
      expect(outcome.kind).toBe('ok');
      const parts = outcome.kind === 'ok' ? outcome.stdout.split('\u001f') : [];
      expect(parts[0]).toBe(String(values.length));
      const back = parts.slice(1);
      for (let i = 0; i < values.length; i++) {
        expect(Buffer.from(back[i] ?? '<missing>').toString('hex'), JSON.stringify(values[i])).toBe(
          Buffer.from(values[i]).toString('hex')
        );
      }
      expect(back).toHaveLength(values.length);
    });

    it('item 4 of argv is the fourth argument', async () => {
      const runner = new OsascriptRunner({ allowRealInTests: true });
      const outcome = await runner.run('argv', ITEM_4, [
        '/dev/ttys001',
        '7',
        '2',
        "cd '/a b' && ut claude",
      ]);
      expect(outcome).toMatchObject({ kind: 'ok', stdout: "cd '/a b' && ut claude" });
      expect(OSASCRIPT_PATH).toBe('/usr/bin/osascript');
      // Sanity: the real binary is the one at that path.
      expect(execFileSync('/usr/bin/which', ['osascript'], { encoding: 'utf8' }).trim()).toBe(
        OSASCRIPT_PATH
      );
    });
  }
);

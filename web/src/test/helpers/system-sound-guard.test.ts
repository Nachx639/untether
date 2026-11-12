import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from './rm-test-dir';
import {
  chainTo,
  describeSounds,
  markAt,
  type ProcessInfo,
  parseLogTimestamp,
  readMarks,
  type SystemSound,
  soundFromLogLine,
  watchSystemSounds,
} from './system-sound-guard.js';

// As `log stream --style ndjson` printed them on 2026-11-03 (WebKit's Cmd+C with nothing selected).
const serverLine = (
  pid: number,
  name = 'Playwright',
  timestamp = '2026-11-03 01:52:32.501093+0100'
) =>
  JSON.stringify({
    processImagePath: '/usr/sbin/systemsoundserverd',
    processID: 1805,
    timestamp,
    eventMessage: `          SSServerImp.cpp:740   -> Incoming Request : actionID 4096, inClientPID ${pid}(${name}), inBehavior 1, customVibeDataProvided 0, loop 0`,
  });
const clientLine = (pid: number, timestamp = '2026-11-03 01:52:32.494699+0100') =>
  JSON.stringify({
    processImagePath:
      '/Users/x/Library/Caches/ms-playwright/webkit-2370/Playwright.app/Contents/MacOS/Playwright',
    processID: pid,
    timestamp,
    eventMessage:
      '[0x7835861900] activating connection: mach=true listener=false peer=false name=com.apple.audio.SystemSoundServer-OSX',
  });

/** `ms` as log stream prints it, in UTC: "2026-11-03 00:52:32.501000+0000". */
const logStamp = (ms: number) =>
  `${new Date(ms).toISOString().replace('T', ' ').replace('Z', '')}000+0000`;

describe('system sound guard', () => {
  it('reads the sound request from systemsoundserverd and the client connection', () => {
    expect(soundFromLogLine(serverLine(42361))).toEqual({
      at: Date.parse('2026-11-03T00:52:32.501Z'),
      pid: 42361,
      process: 'Playwright',
      chain: [],
    });
    expect(soundFromLogLine(clientLine(42361))).toEqual({
      at: Date.parse('2026-11-03T00:52:32.494Z'),
      pid: 42361,
      process: 'Playwright',
      chain: [],
    });
  });

  it('ignores the stream header and other lines', () => {
    expect(soundFromLogLine('Filtering the log data using "…"')).toBeNull();
    expect(
      soundFromLogLine(
        JSON.stringify({ timestamp: '2026-11-03 01:00:00.0+0100', eventMessage: 'x' })
      )
    ).toBeNull();
  });

  it('parses log timestamps with their offset', () => {
    expect(parseLogTimestamp('2026-11-03 01:25:55.733786+0100')).toBe(
      Date.parse('2026-11-03T00:25:55.733Z')
    );
    expect(parseLogTimestamp('2026-11-03 01:25:55-0500')).toBe(Date.parse('2026-11-03T06:25:55Z'));
    expect(parseLogTimestamp('nonsense')).toBeNaN();
  });

  it('climbs the parents to the run, and nothing else counts', () => {
    const table = new Map<number, ProcessInfo>([
      [10, { ppid: 1, name: 'node' }], // the run
      [11, { ppid: 10, name: 'node' }], // a vitest worker
      [12, { ppid: 11, name: 'tsx' }],
      [13, { ppid: 12, name: 'Playwright' }], // its browser (another process group)
      [20, { ppid: 1, name: 'Playwright' }], // another worktree's browser
    ]);
    expect(chainTo(13, 10, table)).toEqual([
      { pid: 13, name: 'Playwright' },
      { pid: 12, name: 'tsx' },
      { pid: 11, name: 'node' },
    ]);
    expect(chainTo(20, 10, table)).toBeNull();
    expect(chainTo(99, 10, table)).toBeNull();
  });

  it('names the test the nearest marked process ran then', () => {
    const sound: SystemSound = {
      at: 1000,
      pid: 13,
      process: 'Playwright',
      chain: [
        { pid: 13, name: 'Playwright' },
        { pid: 11, name: 'node' },
      ],
    };
    const marks = [
      { pid: 11, at: 100, label: 'a.test.ts > first' },
      { pid: 11, at: 900, label: 'a.test.ts > copies' },
      { pid: 11, at: 2000, label: 'a.test.ts > later' },
      { pid: 12, at: 950, label: 'another worker' },
    ];
    expect(markAt(sound, marks)).toBe('a.test.ts > copies');
    expect(describeSounds([sound], (s) => markAt(s, marks))).toBe(
      `system alert sound (NSBeep) at ${new Date(1000).toISOString()} from Playwright(13) ← node(11), during "a.test.ts > copies"`
    );
  });

  it('reads marks written by workers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-marks-'));
    const file = path.join(dir, 'marks.tsv');
    fs.writeFileSync(file, '11\t900\ta.test.ts > copies\n12\t950\tb.test.ts (beforeAll)\n');
    expect(readMarks(file)).toEqual([
      { pid: 11, at: 900, label: 'a.test.ts > copies' },
      { pid: 12, at: 950, label: 'b.test.ts (beforeAll)' },
    ]);
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('catches a sound from a process this one started, not from others (fake log, no sound)', async () => {
    const browser = spawn('sleep', ['30'], { stdio: 'ignore' });
    const pid = browser.pid as number;
    // Stamped after the mark below however long the guard takes to start: 2026-11-08, with the
    // Mac at load 46 it took over 350 ms and this sound came out older than the mark.
    const at = Date.now() + 120_000;
    const lines = [
      'Filtering the log data using "…"',
      clientLine(pid, logStamp(at)),
      serverLine(pid, 'sleep', logStamp(at + 7)), // the same sound
      serverLine(1, 'launchd', logStamp(at + 10)), // not this run's
    ];
    const script = `setTimeout(() => console.log(${JSON.stringify(lines.slice(1).join('\n'))}), 300); console.log(${JSON.stringify(lines[0])}); setTimeout(() => {}, 30000);`;
    try {
      const guard = await watchSystemSounds({ source: [process.execPath, '-e', script] });
      expect(guard.watching).toBe(true);
      guard.mark('the step that beeps');
      // The fake log prints it when its process gets to run: a deadline, not a fixed wait.
      const deadline = Date.now() + 20_000;
      while (!(await guard.sounds()).length && Date.now() < deadline);
      const sounds = await guard.stop();
      expect(sounds.map((s) => s.pid)).toEqual([pid]);
      expect(sounds[0].chain[0]).toEqual({ pid, name: 'sleep' });
      expect(guard.describe(sounds)).toContain(`from sleep(${pid}), during "the step that beeps"`);
    } finally {
      browser.kill();
    }
  }, 30_000);

  // UNTETHER_TEST_REAL_BEEP=1: WebKit really beeps once (Cmd+C on a page with nothing selected);
  // the real `log stream` must catch it. Plays a sound: never in the normal run.
  it.runIf(process.env.UNTETHER_TEST_REAL_BEEP === '1' && process.platform === 'darwin')(
    'catches a real WebKit beep',
    async () => {
      process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(
        os.userInfo().homedir,
        'Library/Caches/ms-playwright'
      );
      const { webkit } = await import('@playwright/test');
      const guard = await watchSystemSounds();
      expect(guard.watching).toBe(true);
      const browser = await webkit.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent('<p>nothing selected</p>');
        guard.mark('Cmd+C with nothing selected');
        await page.keyboard.press('Meta+c');
        await page.waitForTimeout(300);
      } finally {
        await browser.close();
      }
      const sounds = await guard.stop();
      expect(sounds.length).toBe(1);
      expect(guard.describe(sounds)).toContain('during "Cmd+C with nothing selected"');
    },
    60_000
  );
});

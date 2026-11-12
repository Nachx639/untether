import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { serverCrashesCheck } from '../services/doctor-checks.js';
import { UntetherDoctor } from '../services/untether-doctor.js';
import {
  CRASH_MARKS_MAX,
  crashMarkOf,
  crashMarksFile,
  readCrashMarks,
  recordCrash,
} from './crash-marks.js';

describe('the server leaves a mark when an uncaught exception stops it (2026-11-11)', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-crash-marks-'));
    file = crashMarksFile(path.join(tmp, 'log.txt'));
  });

  afterEach(() => {
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  /** The incident's exception, thrown for real so it has a trace. */
  const incident = (): Error => {
    try {
      const ledger = {
        messages: new Map<string, string>(),
        waiting(this: { messages: Map<string, string> }) {
          return this.messages.size;
        },
      };
      const waiting = ledger.waiting as () => number;
      waiting();
    } catch (error) {
      return error as Error;
    }
    throw new Error('it did not throw');
  };

  it('sits next to the log, keeps the error and the top of its trace, and survives a cut line', () => {
    expect(file).toBe(path.join(tmp, 'crashes.jsonl'));
    const at = Date.parse('2026-11-10T18:32:00.000Z');
    recordCrash(file, crashMarkOf('uncaughtException', incident(), at));
    fs.appendFileSync(file, '{"at":"2026-11-10T18:3');
    recordCrash(file, crashMarkOf('unhandledRejection', 'a plain reason', at + 60_000));
    expect(readCrashMarks(file)).toMatchObject([
      {
        at: '2026-11-10T18:32:00.000Z',
        kind: 'uncaughtException',
        error: expect.stringMatching(/^TypeError: Cannot read properties of undefined/),
        stack: expect.stringContaining('crash-marks.test.ts'),
      },
      { at: '2026-11-10T18:33:00.000Z', kind: 'unhandledRejection', error: 'a plain reason' },
    ]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps only the newest marks, and a file it cannot write does not throw', () => {
    for (let index = 0; index < CRASH_MARKS_MAX + 5; index++) {
      recordCrash(file, crashMarkOf('uncaughtException', new Error(`crash ${index}`), index));
    }
    const marks = readCrashMarks(file);
    expect(marks).toHaveLength(CRASH_MARKS_MAX);
    expect(marks[marks.length - 1].error).toBe(`Error: crash ${CRASH_MARKS_MAX + 4}`);
    const blocked = path.join(tmp, 'a-file');
    fs.writeFileSync(blocked, 'x');
    expect(() =>
      recordCrash(path.join(blocked, 'crashes.jsonl'), crashMarkOf('uncaughtException', 'x'))
    ).not.toThrow();
    expect(readCrashMarks(path.join(tmp, 'none.jsonl'))).toEqual([]);
  });

  it('the doctor says how many times it stopped in the last 24 h and on what, per error', async () => {
    const now = Date.parse('2026-11-11T10:10:00.000Z');
    const error = incident();
    // The incident: eight stops in 16 hours on one exception; one older than a day; another error once.
    recordCrash(file, crashMarkOf('uncaughtException', error, Date.parse('2026-11-09T09:00:00Z')));
    for (const at of [
      '2026-11-10T18:32:00Z',
      '2026-11-10T18:33:00Z',
      '2026-11-10T18:35:00Z',
      '2026-11-10T18:36:00Z',
      '2026-11-10T18:37:00Z',
      '2026-11-11T06:01:00Z',
      '2026-11-11T10:04:00Z',
      '2026-11-11T10:06:00Z',
    ]) {
      recordCrash(file, crashMarkOf('uncaughtException', error, Date.parse(at)));
    }
    recordCrash(
      file,
      crashMarkOf('unhandledRejection', new Error('ENOSPC'), Date.parse('2026-11-11T02:00:00Z'))
    );
    const told: string[] = [];
    const pushed: string[] = [];
    let clock = now;
    const make = (takes: boolean) =>
      new UntetherDoctor({
        checks: [serverCrashesCheck({ file: () => file, now: () => clock })],
        tellOrchestrator: (text) => {
          told.push(text);
          return takes;
        },
        push: (_title, body) => pushed.push(body),
        log: () => {},
        now: () => clock,
      });
    const report = await make(false).runOnce();
    expect(report.findings.map((finding) => [finding.severity, finding.problem])).toEqual([
      [
        'critical',
        expect.stringMatching(
          /^the server stopped 8 times in the last 24 h on an uncaught exception \(uncaughtException, last at 2026-11-11T10:06:00\.000Z\): TypeError: Cannot read properties of undefined \(reading 'messages'\) \(at .*crash-marks\.test\.ts/
        ),
      ],
      [
        'critical',
        expect.stringContaining(
          'the server stopped 1 time in the last 24 h on an uncaught exception (unhandledRejection, last at 2026-11-11T02:00:00.000Z): Error: ENOSPC'
        ),
      ],
    ]);
    // Nobody took it (no orchestrator of Untether's runs): the phone hears.
    expect(told).toHaveLength(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain('the server stopped 8 times');
    // A day with no stop: nothing to tell.
    clock = now + 25 * 60 * 60_000;
    expect((await make(true).runOnce()).findings).toEqual([]);
  });
});

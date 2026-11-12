import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loopFailuresCheck } from '../services/doctor-checks.js';
import { UntetherDoctor } from '../services/untether-doctor.js';
import { every, forgetLoopFailuresForTests, loopFailures, loopStep } from './periodic-loop.js';

describe('a periodic loop whose step throws does not stop the server (2026-11-11)', () => {
  let uncaught: unknown[];
  const onUncaught = (error: unknown) => uncaught.push(error);

  beforeEach(() => {
    forgetLoopFailuresForTests();
    uncaught = [];
    // What cli.ts stops the server on.
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
  });

  it('a step that throws every turn: the loop goes on, nothing reaches the process, the failures are counted', () => {
    let turns = 0;
    const timer = every(
      'test watch',
      () => {
        turns++;
        // The incident's own failure: a method taken off its object.
        const ledger = {
          messages: new Map(),
          waiting(this: { messages: Map<string, string> }) {
            return this.messages.size;
          },
        };
        const waiting = ledger.waiting as () => number;
        waiting();
      },
      1000
    );
    vi.advanceTimersByTime(3000);
    clearInterval(timer);
    expect(turns).toBe(3);
    expect(uncaught).toEqual([]);
    expect(loopFailures()).toMatchObject([
      {
        name: 'test watch',
        count: 3,
        error: expect.stringMatching(/^TypeError: Cannot read properties of undefined/),
        stack: expect.stringContaining('periodic-loop.test.ts'),
      },
    ]);
  });

  it('an async step that rejects is caught too, and the loop goes on', async () => {
    let turns = 0;
    const timer = every(
      'test async',
      async () => {
        turns++;
        throw new Error(`turn ${turns} failed`);
      },
      1000
    );
    await vi.advanceTimersByTimeAsync(2000);
    clearInterval(timer);
    // Past the microtasks an unhandled rejection is reported on.
    vi.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve));
    expect(turns).toBe(2);
    expect(uncaught).toEqual([]);
    expect(loopFailures()).toMatchObject([
      { name: 'test async', count: 2, error: 'Error: turn 2 failed' },
    ]);
  });

  it('a step that works leaves nothing, and gets its arguments', () => {
    const seen: number[] = [];
    loopStep('test fine', (value: number) => seen.push(value))(7);
    expect(seen).toEqual([7]);
    expect(loopFailures()).toEqual([]);
  });

  it('the doctor tells the loop, its count and its error, and clears it once it runs clean', async () => {
    vi.useRealTimers();
    let clock = Date.now();
    loopStep('orchestrator watch', () => {
      throw new TypeError("Cannot read properties of undefined (reading 'messages')");
    })();
    loopStep('orchestrator watch', () => {
      throw new TypeError("Cannot read properties of undefined (reading 'messages')");
    })();
    const told: string[] = [];
    const doctor = new UntetherDoctor({
      checks: [loopFailuresCheck({ failures: loopFailures, now: () => clock })],
      tellOrchestrator: (text) => {
        told.push(text);
        return true;
      },
      push: () => {},
      log: () => {},
      now: () => clock,
    });
    const report = await doctor.runOnce();
    expect(report.findings).toMatchObject([
      {
        key: 'loop-failed:orchestrator watch',
        severity: 'warning',
        problem: expect.stringContaining(
          `the loop "orchestrator watch" failed 2 times since the server started`
        ),
      },
    ]);
    expect(report.findings[0].problem).toContain(
      "TypeError: Cannot read properties of undefined (reading 'messages')"
    );
    expect(report.findings[0].problem).toContain('periodic-loop.test.ts');
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('the loop "orchestrator watch" failed 2 times');
    // No failure for half an hour: no longer a finding.
    clock += 31 * 60_000;
    expect((await doctor.runOnce()).findings).toEqual([]);
  });
});

/**
 * Every repeating timer of the server goes through `every` (or guards its step with
 * `loopStep`): a raw setInterval is a loop whose first exception stops the whole server.
 */
describe('no raw setInterval in the server', () => {
  const SERVER = path.resolve(__dirname, '..');
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return files(full);
      return entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name) ? [full] : [];
    });

  it('finds none outside periodic-loop.ts', () => {
    const raw: string[] = [];
    for (const file of [...files(SERVER), path.resolve(SERVER, '..', 'cli.ts')]) {
      if (file === path.join(__dirname, 'periodic-loop.ts')) continue;
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/\bsetInterval\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
            raw.push(`${path.relative(SERVER, file)}:${index + 1}`);
          }
        });
    }
    expect(
      raw,
      "use every(name, step, ms) from utils/periodic-loop.ts: its step can't stop the server"
    ).toEqual([]);
  });
});

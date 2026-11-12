/**
 * Fails the Playwright run when a test makes its browser play the macOS alert sound (NSBeep:
 * an editing command with nothing to act on, a key WebKit or Chrome refuses). 2026-11-03: the
 * user heard it every so often while task checks ran browser tests. See system-sound-guard.ts.
 */
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import {
  describeSounds,
  type SystemSoundGuard,
  watchSystemSounds,
} from '../helpers/system-sound-guard.js';

export default class SystemSoundReporter implements Reporter {
  private guard: Promise<SystemSoundGuard> | undefined;
  private readonly started = new Map<string, number>();
  private readonly windows: Array<{ title: string; from: number; to: number }> = [];

  onBegin() {
    // Playwright does not wait for onBegin; the log is listening within a second or so.
    this.guard = watchSystemSounds();
  }

  onTestBegin(test: TestCase, result: TestResult) {
    this.started.set(`${test.id}#${result.retry}`, Date.now());
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const key = `${test.id}#${result.retry}`;
    const from = this.started.get(key) ?? result.startTime.getTime();
    this.started.delete(key);
    this.windows.push({
      title: test.titlePath().filter(Boolean).join(' › '),
      from,
      to: Date.now(),
    });
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    const sounds = (await (await this.guard)?.stop()) ?? [];
    if (sounds.length === 0) return undefined;
    console.error('\nBrowser tests played the system alert sound (NSBeep); tests never may:');
    console.error(
      describeSounds(sounds, (sound) => {
        // Tests run in parallel: every test running then is named (a margin for the log's lag).
        const during = this.windows
          .filter((w) => w.from - 100 <= sound.at && sound.at <= w.to + 100)
          .map((w) => w.title);
        return during.join(' | ') || 'outside any test (setup or teardown)';
      })
    );
    console.error(
      'Select something before copying or cutting, focus an editable element before typing.'
    );
    return { status: result.status === 'passed' ? 'failed' : result.status };
  }
}

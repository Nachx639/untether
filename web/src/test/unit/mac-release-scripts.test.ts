import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '../../../../mac/scripts/test-release-scripts.sh');

/**
 * The Mac build and release scripts are tested by mac/scripts/test-release-scripts.sh with
 * stand-ins for codesign, security, xcrun and xcodebuild (nothing is signed, notarized,
 * built or released). Running it from here puts it in the check every change goes through.
 */
describe.runIf(process.platform === 'darwin')('mac build and release scripts', () => {
  it('pass their tests with doubles', () => {
    let output: string;
    try {
      output = execFileSync('bash', [script], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 110_000,
      });
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      output = `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
    }
    expect(output.split('\n').filter((line) => line.startsWith('FAIL'))).toEqual([]);
    expect(output).toContain('Release script tests passed');
  }, 120_000);

  // custom-node-policy.sh decides which Node the app build embeds; its test had no caller.
  it('the custom Node policy passes its tests', () => {
    const policyTest = path.resolve(path.dirname(script), 'test-custom-node-policy.sh');
    expect(execFileSync('zsh', [policyTest], { encoding: 'utf8', stdio: 'pipe' })).toContain(
      'Custom Node policy tests passed'
    );
  });
});

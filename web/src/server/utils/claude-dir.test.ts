import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { claudeConfigDir } from './claude-dir.js';

describe('claudeConfigDir', () => {
  it('is CLAUDE_CONFIG_DIR when it is set', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/data/claude' })).toBe('/data/claude');
  });

  it('trims the variable', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '  /data/claude \n' })).toBe('/data/claude');
  });

  it('falls back to ~/.claude when the variable is unset or blank', () => {
    const home = path.join(os.homedir(), '.claude');
    expect(claudeConfigDir({})).toBe(home);
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' })).toBe(home);
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '   ' })).toBe(home);
  });

  // Unless a run asks for the real home on purpose.
  it.skipIf(!!process.env.UNTETHER_TEST_REAL_HOME)(
    "in server tests is under the test's own home, whatever the developer's shell sets",
    () => {
      // src/test/setup.ts moves HOME to a temp folder and drops the agents' folder overrides.
      expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(process.env.CODEX_HOME).toBeUndefined();
      expect(process.env.GEMINI_CLI_HOME).toBeUndefined();
      const testRoot = process.env.UNTETHER_TEST_RUN_DIR ?? os.tmpdir();
      expect(claudeConfigDir().startsWith(testRoot)).toBe(true);
    }
  );
});

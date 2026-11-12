/**
 * Runs the session list drag check in real Chromium (src/test/session-list-drag.browser.ts)
 * with the server tests, so the 2026-11-07 regressions (the title selected instead of dragged,
 * no order inside a group, a drop with no undo, «⌘2» painted over the title) cannot come back
 * unnoticed. Skipped only where Playwright's Chromium is not installed.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// The tests run with a HOME of their own (setup.ts): the browsers stay in the user's cache.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(
  os.userInfo().homedir,
  process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright'
);
// Loaded after that: Playwright reads where its browsers are when it is imported.
const { chromium } = await import('@playwright/test');
const chromiumInstalled = (() => {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!chromiumInstalled)('session list drag in Chromium', () => {
  it('drags rows from the title, reorders, moves between groups, Escape, undo; no overlaps', async () => {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        path.join(webRoot, 'node_modules/.bin/tsx'),
        ['src/test/session-list-drag.browser.ts'],
        { cwd: webRoot, timeout: 150_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
          else resolve(stdout);
        }
      );
    });
    expect(output).toContain('chromium: session list drag ok');
  }, 180_000);
});

/**
 * Runs the terminal copy check in real Chromium and WebKit (src/test/terminal-copy.browser.ts)
 * with the server tests, so the 2026-10-31 regression ("-" pasted after selecting and Cmd+C)
 * cannot come back unnoticed. Skipped only where Playwright's browsers are not installed.
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
const { chromium, webkit } = await import('@playwright/test');
const browsersInstalled = [chromium, webkit].every((type) => {
  try {
    return fs.existsSync(type.executablePath());
  } catch {
    return false;
  }
});

describe.skipIf(!browsersInstalled)('terminal copy in Chromium and WebKit', () => {
  it('copies the whole selection, apps get drags, OSC 52 reaches the clipboard', async () => {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        path.join(webRoot, 'node_modules/.bin/tsx'),
        ['src/test/terminal-copy.browser.ts'],
        { cwd: webRoot, timeout: 150_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
          else resolve(stdout);
        }
      );
    });
    expect(output).toContain('chromium: terminal copy ok');
    expect(output).toContain('webkit: terminal copy ok');
  }, 180_000);
});

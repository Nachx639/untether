import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';

// `ut open` (a client command) deleted the running server's log.txt: the server kept writing
// into the unlinked file and the log on disk stayed empty (2026-10-03).
describe('initLogger and the log file', () => {
  let dir: string;
  afterEach(async () => {
    const logger = await import('./logger.js');
    logger.closeLogger?.();
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(dir, RM_TEST_DIR);
  });

  async function loggerWithExistingLog() {
    dir = mkdtempSync(path.join(tmpdir(), 'ut-log-'));
    vi.stubEnv('UNTETHER_CONTROL_DIR', dir);
    vi.resetModules();
    const logger = await import('./logger.js');
    writeFileSync(logger.getLogFilePath(), 'line from the running server\n');
    return logger;
  }

  it('creates the log file readable by its owner only', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ut-log-'));
    vi.stubEnv('UNTETHER_CONTROL_DIR', dir);
    vi.resetModules();
    const logger = await import('./logger.js');
    logger.initLogger(false);
    await vi.waitFor(() => expect(existsSync(logger.getLogFilePath())).toBe(true));
    expect(statSync(logger.getLogFilePath()).mode & 0o777).toBe(0o600);
  });

  it('a client command appends and leaves the server log in place', async () => {
    const logger = await loggerWithExistingLog();
    logger.initLogger(false, undefined, { fresh: false });
    expect(readFileSync(logger.getLogFilePath(), 'utf8')).toContain('line from the running server');
  });

  it('a server start keeps the earlier runs below a start marker', async () => {
    const logger = await loggerWithExistingLog();
    logger.initLogger(false);
    await logger.flushLogger();
    // Waits for the marker with a deadline: a fixed 20 ms read before it at load ~50 (2026-11-02).
    const text = await vi.waitFor(
      () => {
        const content = readFileSync(logger.getLogFilePath(), 'utf8');
        if (!content.includes('===== server start')) throw new Error('no start marker yet');
        return content;
      },
      { timeout: 10_000, interval: 20 }
    );
    expect(text).toContain('line from the running server');
    expect(text.indexOf('===== server start')).toBeGreaterThan(
      text.indexOf('line from the running server')
    );
  });

  it('a client command never rotates the log, even past 50 MB', async () => {
    const logger = await loggerWithExistingLog();
    const file = logger.getLogFilePath();
    truncateSync(file, 50 * 1024 * 1024 + 10);
    logger.initLogger(false, undefined, { fresh: false });
    logger.createLogger('client').log('a line from ut status');
    await logger.flushLogger();
    expect(existsSync(`${file}.1`)).toBe(false);
    expect(statSync(file).size).toBeGreaterThan(50 * 1024 * 1024);
  });
});

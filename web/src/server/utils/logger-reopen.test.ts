import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';

// The Mac app's old CLI (`ut status`, `ut title`…) deletes ~/.untether/log.txt each time it
// runs; the server kept writing into the unlinked file and log.txt stayed empty (2026-10-03).
describe('server log survives its file being deleted under it', () => {
  let dir: string;
  afterEach(async () => {
    const logger = await import('./logger.js');
    logger.closeLogger?.();
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(dir, RM_TEST_DIR);
  });

  it('writes the next line into a new log.txt at the same path', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ut-log-reopen-'));
    vi.stubEnv('UNTETHER_CONTROL_DIR', dir);
    vi.resetModules();
    const logger = await import('./logger.js');
    logger.initLogger(false);
    const file = logger.getLogFilePath();
    const log = logger.createLogger('test');

    log.log('before the file was deleted');
    await vi.waitFor(() =>
      expect(existsSync(file) && readFileSync(file, 'utf8')).toContain('before')
    );

    unlinkSync(file); // what `ut status` from the Mac app does
    logger.checkLogFileOnNextWriteForTests();
    log.log('after the file was deleted');
    await vi.waitFor(() =>
      expect(existsSync(file) ? readFileSync(file, 'utf8') : '').toContain(
        'after the file was deleted'
      )
    );
  });
});

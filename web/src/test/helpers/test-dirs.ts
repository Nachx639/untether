import fs from 'fs';
import { writeTestMarker } from '../../server/services/stray-tmux.js';

/**
 * A throwaway dir straight in /tmp (for a short socket path) with the test harness's marker:
 * the run's teardown, the next run and the doctor may remove it, and only because of the
 * marker (2026-11-02, stray-tmux.ts). Use it instead of a bare mkdtempSync('/tmp/…').
 */
export function markedTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(prefix);
  writeTestMarker(dir, process.env.UNTETHER_TEST_RUN_DIR);
  return dir;
}

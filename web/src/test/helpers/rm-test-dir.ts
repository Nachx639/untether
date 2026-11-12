/**
 * Options for removing a test's temp dir in a teardown: retried, because the code under test
 * may still be writing into it (a timer's save landing between rm's readdir and rmdir gives
 * ENOTEMPTY under load, 2026-11-02, push-notification-service.test.ts). Pass it to the file's
 * own rmSync (`fs.rmSync(dir, RM_TEST_DIR)`), so tests that mock fs keep their mock. Wait for
 * the service to settle first where it can tell you; this is the floor for everything else.
 * test/unit/rm-test-dir.test.ts fails on a recursive rmSync in a test file without it.
 */
export const RM_TEST_DIR = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 50,
} as const;

/**
 * Test files of each mode of vitest.config.ts (`test:client`, `test:server`). Together they must take every
 * *.test.ts under src: CI and the coverage scripts run only these two modes.
 * 2026-11-02: src/test/helpers, src/shared, src/test/{integration,server,utils} matched neither
 * and ran only under plain `vitest`; src/test/unit/test-modes-cover-all-tests.test.ts fails when
 * a test file matches no mode again.
 */
export const testModes = {
  client: {
    include: ['src/client/**/*.test.ts', 'src/test/client/**/*.test.ts'],
    exclude: [] as string[],
  },
  server: {
    include: ['src/server/**/*.test.ts', 'src/shared/**/*.test.ts', 'src/test/**/*.test.ts'],
    // Client tests under src/test need happy-dom: they run in the client mode.
    exclude: ['src/test/client/**'],
  },
};

/**
 * Test files that run real processes end to end: servers, tmux servers, the untether-fwd
 * forwarder, the `untether` CLI, browsers. They are the slowest files and the ones that fail when
 * the Mac is loaded (2026-11-02: load 20-70 during task checks). Plain `vitest` and both modes
 * still run them; the lane variable splits a run in two:
 * `UNTETHER_TEST_LANE=fast` (pnpm run test:fast) runs every other file and
 * `UNTETHER_TEST_LANE=real` (pnpm run test:real) only these, e.g. on its own with fewer workers.
 * test-modes-cover-all-tests.test.ts fails on a pattern that matches no file.
 */
export const realProcessTests = [
  // Playwright browsers, test servers, tmux, ut-fwd: end to end by design.
  'src/test/e2e/**/*.test.ts',
  'src/test/integration/**/*.test.ts',
  // Hung forwarders and their programs, spawned and killed for real.
  'src/server/pty/forwarder-kill.test.ts',
  // The real `untether fwd --update-title` CLI in a session.
  'src/test/server/ut-title-integration.test.ts',
  // Real tmux servers left by a failed run, and the teardown that kills them.
  'src/test/unit/run-cleanup.test.ts',
  'src/test/helpers/run-teardown.test.ts',
  // Marked process trees on this machine, reparented and reaped.
  'src/server/services/task-processes.test.ts',
  // The twin's real server and real WebKit and Chromium.
  'src/test/unit/ui-shots.test.ts',
  // Several real esbuild builds of Monaco at once.
  'src/test/unit/monaco-plugin-concurrent.test.ts',
];

export type TestLane = 'fast' | 'real';

/** The lane of `UNTETHER_TEST_LANE`, if any ('' or another value: no lane, every file). */
export function testLane(value: string | undefined): TestLane | undefined {
  return value === 'fast' || value === 'real' ? value : undefined;
}

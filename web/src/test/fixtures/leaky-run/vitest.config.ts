import path from 'path';
import { defineConfig } from 'vitest/config';

// A test run of its own for run-cleanup.test.ts: the real global setup, one leaky test.
export default defineConfig({
  test: {
    include: ['leaky.fixture.ts'],
    globalSetup: [path.resolve(__dirname, '../../global-setup.ts')],
    testTimeout: 60_000,
  },
});

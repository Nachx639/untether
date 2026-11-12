import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';
import { readFileSync } from 'fs';
import { availableParallelism } from 'os';
// Test files of each mode (test:client, test:server); test-modes-cover-all-tests.test.ts checks them.
import { realProcessTests, testLane, testModes } from './src/test/test-modes';

// Get version from package.json for __APP_VERSION__ definition
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const version = packageJson.version;
// Half the cores: see maxWorkers below.
const workers = Math.max(2, Math.floor(availableParallelism() / 2));

// For Vitest 3.x, we need to use workspace configuration instead of projects
// Create separate configs that can be selected via CLI flags

export default defineConfig(({ mode }) => {
  const isClient = mode === 'client' || (typeof process !== 'undefined' && process.env?.VITEST_MODE === 'client');
  const isServer = mode === 'server' || (typeof process !== 'undefined' && process.env?.VITEST_MODE === 'server');
  
  // Default to running all tests if no mode specified
  const modeInclude = isClient
    ? testModes.client.include
    : isServer
    ? testModes.server.include
    : ['src/**/*.test.ts'];
  const modeExclude = [
    ...configDefaults.exclude,
    ...(isClient ? testModes.client.exclude : isServer ? testModes.server.exclude : []),
  ];
  // The real-process lane (test-modes.ts): `fast` leaves those files out, `real` runs only them.
  const lane = testLane(process.env.UNTETHER_TEST_LANE);
  const testInclude = lane === 'real' ? realProcessTests : modeInclude;
  const testExclude = lane === 'fast' ? [...modeExclude, ...realProcessTests] : modeExclude;
  // The real lane on half of the usual workers: its tests time real processes, and a loaded Mac
  // is what fails them.
  const laneWorkers = lane === 'real' ? Math.max(1, Math.floor(workers / 2)) : workers;
    
  const coverageInclude = isClient
    ? ['src/client/**/*.ts']
    : isServer
    ? ['src/server/**/*.ts']
    : ['src/**/*.ts'];
    
  const coverageDir = isClient
    ? './coverage/client'
    : isServer
    ? './coverage/server'
    : './coverage';
    
  // No thresholds - we just want to report coverage without failing builds
  
  // Add memory reporter when MEMORY_LOG env var is set
  const reporters = process.env.MEMORY_LOG 
    ? ['default', './src/test/memory-reporter.ts']
    : ['default'];

  return {
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    poolOptions: {
      // Same cap as maxWorkers.
      threads: {
        maxThreads: laneWorkers,
        minThreads: 1,
      },
      forks: {
        maxForks: laneWorkers,
        minForks: 1,
      },
    },
    test: {
      globals: true,
      include: testInclude,
      exclude: testExclude,
      globalSetup: ['./src/test/global-setup.ts'],
      setupFiles: ['./src/test/setup.ts'],
      environment: isClient ? 'happy-dom' : 'node',
      // Half the cores (2026-10-23: two task checks at once, each on every core, took the Mac
      // to a load of ~270 and timing tests failed).
      maxWorkers: laneWorkers,
      testTimeout: 10000, // 10s for tests
      // Hooks load the modules under test (36 test files `await import(…)` in a beforeAll), and
      // that is the part that slows down with the machine, not what a test measures. 2026-11-10:
      // at a load of 100-140 session-list.test.ts's beforeAll took over 10 s importing the client
      // and failed the check of a task that had not touched it. A hook that hangs still fails.
      hookTimeout: 60000,
      reporters,
      isolate: true, // Isolate tests in separate contexts
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
        exclude: [
          'node_modules/',
          'src/test/',
          'dist/',
          'public/',
          '*.config.ts',
          '*.config.js',
          '**/*.test.ts',
          '**/*.spec.ts',
        ],
        include: coverageInclude,
        all: true,
        reportsDirectory: coverageDir,
        // No thresholds - just report coverage
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
});

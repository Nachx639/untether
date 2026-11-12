import { defineConfig, devices } from '@playwright/test';
import { testConfig } from './src/test/playwright/test-config';

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

/** PLAYWRIGHT_WORKERS=<n> overrides; a value that is not a positive number is an error. */
function workers(): number {
  const given = process.env.PLAYWRIGHT_WORKERS;
  if (given === undefined || given === '') return 4;
  const parsed = Number(given);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`PLAYWRIGHT_WORKERS must be a positive number, got "${given}"`);
  }
  return parsed;
}

/**
 * The whole suite in one pass, files and tests in parallel, against one test server of its own:
 * scripts/test-server.js starts it in a throwaway HOME on a free port (test-config.ts) and it is
 * never shared with another run. Tests therefore share that server among themselves: each one
 * works with the sessions it created (names starting with "test-") and never counts on being
 * alone. See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './src/test/playwright',
  globalSetup: require.resolve('./src/test/playwright/global-setup.ts'),
  globalTeardown: require.resolve('./src/test/playwright/global-teardown.ts'),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: workers(),
  timeout: process.env.CI ? 60_000 : 45_000,
  reporter: [
    ['html', { open: 'never' }],
    process.env.CI ? ['github'] : ['list'],
    // A test that makes the browser beep (macOS alert sound) fails the run.
    ['./src/test/playwright/system-sound-reporter.ts'],
  ],
  use: {
    baseURL: testConfig.baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // System Chromium runs do not install Playwright's separate ffmpeg bundle.
    video: process.env.CI && !chromiumExecutablePath ? 'retain-on-failure' : 'off',
    actionTimeout: process.env.CI ? 15_000 : 10_000,
    navigationTimeout: process.env.CI ? 30_000 : 20_000,
    headless: true,
    viewport: { width: 1280, height: 1200 },
    ignoreHTTPSErrors: true,
    launchOptions: {
      ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
      args: [
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-images',
        '--disable-javascript-harmony-shipping',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `node scripts/test-server.js --no-auth --port ${testConfig.port}`,
    port: testConfig.port,
    // Never another run's server: it would be another checkout's build and sessions.
    reuseExistingServer: false,
    stdout: process.env.CI ? 'inherit' : 'ignore',
    stderr: process.env.CI ? 'inherit' : 'pipe',
    timeout: 120_000, // it builds the server and the client first when they are older than the code
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      UNTETHER_DISABLE_PUSH_NOTIFICATIONS: 'true',
      SUPPRESS_CLIENT_ERRORS: 'true',
      SHELL: '/bin/bash',
      TERM: 'xterm',
    },
  },
});

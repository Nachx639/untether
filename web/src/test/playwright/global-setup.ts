import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type FullConfig } from '@playwright/test';
import { testConfig } from './test-config';

/**
 * No sessions are cleaned up here: every run starts its own server in a throwaway HOME
 * (scripts/test-server.js), so there is nothing from an earlier run to find.
 */
async function globalSetup(config: FullConfig) {
  console.time('Total test duration');

  fs.mkdirSync(path.join(process.cwd(), 'test-results', 'screenshots'), { recursive: true });

  if (process.env.CI) {
    try {
      const browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {}),
      });
      await browser.close();
    } catch (error) {
      console.error('Browser launch failed:', error);
      throw new Error(
        'Playwright browsers not installed. Run: pnpm exec playwright install chromium'
      );
    }
  }

  // `use` lives on each project in the resolved config (all share the top-level baseURL).
  process.env.PLAYWRIGHT_TEST_BASE_URL = config.projects[0]?.use.baseURL || testConfig.baseURL;
  console.log(`Global setup complete. Base URL: ${process.env.PLAYWRIGHT_TEST_BASE_URL}`);
}

export default globalSetup;

import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures/test.fixture';
import { assertTerminalReady } from '../helpers/assertion.helper';
import { createAndNavigateToSession } from '../helpers/session-lifecycle.helper';
import { TestSessionManager } from '../helpers/test-data-manager.helper';
import { TestDataFactory } from '../utils/test-utils';

// Use a unique prefix for this test suite
const TEST_PREFIX = TestDataFactory.getTestSpecificPrefix('file-browser-basic');

// These tests create their own sessions and can run in parallel
test.describe.configure({ mode: 'parallel' });

/**
 * Creates a session and opens the file browser from the session header's "Files" button.
 * The test server runs in web/, so that is the folder the browser opens on.
 */
async function openFileBrowserInNewSession(page: Page, sessionManager: TestSessionManager) {
  const { sessionName, sessionId } = await createAndNavigateToSession(page, {
    name: sessionManager.generateSessionName('file-browser'),
  });
  sessionManager.trackSession(sessionName, sessionId);
  await assertTerminalReady(page, 15000);

  const fileBrowser = page.locator('[data-testid="file-browser"]');
  await expect(fileBrowser).toBeHidden();
  await page.locator('[data-testid="header-files-button"]').click();
  await expect(fileBrowser).toBeVisible();
  return fileBrowser;
}

/**
 * The row of a file or folder, by its name alone. 2026-11-11: matched by the row's whole text,
 * "package.json" was not found in a checkout where the file was modified (the row then reads
 * "package.json M", its git status), so the suite passed or failed with the state of the tree.
 */
function row(fileBrowser: Locator, name: string): Locator {
  return fileBrowser
    .locator('.fb-row')
    .filter({ has: fileBrowser.page().locator(`span[title="${name}"]`) });
}

test.describe('File Browser Basic Tests', () => {
  let sessionManager: TestSessionManager;

  test.beforeEach(async ({ page }) => {
    sessionManager = new TestSessionManager(page, TEST_PREFIX);
  });

  test.afterEach(async () => {
    await sessionManager.cleanupAllSessions();
  });

  test('should open file browser from session view', async ({ page }) => {
    const fileBrowser = await openFileBrowserInNewSession(page, sessionManager);

    // Its back button closes it and the session is there again.
    await fileBrowser.locator('[data-testid="file-browser-back"]').click();
    await expect(fileBrowser).toBeHidden();
    await expect(page.locator('#session-terminal')).toBeVisible();
  });

  // The back button's tooltip and the preview pane both name Esc as the way out.
  test('should close file browser with Escape', async ({ page }) => {
    const fileBrowser = await openFileBrowserInNewSession(page, sessionManager);

    await page.keyboard.press('Escape');
    await expect(fileBrowser).toBeHidden();
    await expect(page.locator('#session-terminal')).toBeVisible();
  });

  test('should show file browser elements', async ({ page }) => {
    const fileBrowser = await openFileBrowserInNewSession(page, sessionManager);

    // The path, ending in the session's folder.
    await expect(fileBrowser.locator('.fb-crumb').last()).toHaveText('web');
    // The search field.
    await expect(fileBrowser.locator('#file-browser-search')).toBeVisible();
    // The folder's contents: the way up, a folder and a file.
    const rows = fileBrowser.locator('.fb-row');
    await expect(rows.filter({ hasText: /^\s*\.\.\s*$/ })).toBeVisible();
    await expect(row(fileBrowser, 'src')).toBeVisible();
    await expect(row(fileBrowser, 'package.json')).toBeVisible();
  });

  test('should handle file browser navigation', async ({ page }) => {
    const fileBrowser = await openFileBrowserInNewSession(page, sessionManager);
    const rows = fileBrowser.locator('.fb-row');
    const lastCrumb = fileBrowser.locator('.fb-crumb').last();
    await expect(lastCrumb).toHaveText('web');

    // Into a folder: the path follows and its contents replace the list.
    await row(fileBrowser, 'src').click();
    await expect(lastCrumb).toHaveText('src');
    await expect(row(fileBrowser, 'client')).toBeVisible();
    await expect(row(fileBrowser, 'package.json')).toHaveCount(0);

    // And back up through "..".
    await rows.filter({ hasText: /^\s*\.\.\s*$/ }).click();
    await expect(lastCrumb).toHaveText('web');
    await expect(row(fileBrowser, 'package.json')).toBeVisible();
  });
});

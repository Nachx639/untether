import { expect, test } from '../fixtures/test.fixture';
import { TestSessionManager } from '../helpers/test-data-manager.helper';

test.describe('File Browser in Session Create Form', () => {
  let sessionManager: TestSessionManager;

  test.beforeEach(async ({ page }) => {
    sessionManager = new TestSessionManager(page);
    await page.goto('/');
  });

  test.afterEach(async () => {
    await sessionManager.cleanupAllSessions();
  });

  test('file browser should appear above session create modal', async ({ page }) => {
    // Open create session modal
    const createButton = page.locator('[data-testid="create-session-button"]');
    await createButton.click();

    // Wait for modal to be visible
    const sessionModal = page.locator('[data-testid="session-create-modal"]');
    await expect(sessionModal).toBeVisible({ timeout: 5000 });

    // Click browse button
    const browseButton = page.locator('button[title="Browse directories"]');
    await expect(browseButton).toBeVisible();
    await browseButton.click();

    // File browser should be visible
    const fileBrowser = page.locator('[data-testid="file-browser"]');
    await expect(fileBrowser).toBeVisible({ timeout: 5000 });

    // Verify file browser is actually on top (not blocked by modal)
    const isOnTop = await fileBrowser.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      return top ? el.contains(top) : false;
    });
    expect(isOnTop).toBe(true);

    // Verify we can interact with file browser (not blocked by modal)
    const backButton = page.locator('button:has-text("Back")').first();
    await expect(backButton).toBeVisible();

    // Close file browser
    await backButton.click();
    await expect(fileBrowser).not.toBeVisible({ timeout: 5000 });

    // Session create modal should still be visible
    await expect(sessionModal).toBeVisible();
  });

  test('should select directory from file browser', async ({ page }) => {
    // Open create session modal
    const createButton = page.locator('[data-testid="create-session-button"]');
    await createButton.click();

    // Wait for modal
    await expect(page.locator('[data-testid="session-create-modal"]')).toBeVisible();

    // Get initial working directory value
    const workingDirInput = page.locator('[data-testid="working-dir-input"]');
    const initialValue = await workingDirInput.inputValue();

    // Open file browser
    const browseButton = page.locator('button[title="Browse directories"]');
    await browseButton.click();

    // Wait for file browser
    const fileBrowser = page.locator('[data-testid="file-browser"]');
    await expect(fileBrowser).toBeVisible({ timeout: 5000 });

    // Up one folder through ".."
    const lastCrumb = fileBrowser.locator('.fb-crumb').last();
    const startFolder = await lastCrumb.innerText();
    await fileBrowser
      .locator('.fb-row')
      .filter({ hasText: /^\s*\.\.\s*$/ })
      .click();
    await expect(lastCrumb).not.toHaveText(startFolder);

    // "Select Directory" closes the browser and fills the form's working directory
    await fileBrowser.locator('button:has-text("Select Directory")').click();
    await expect(fileBrowser).not.toBeVisible({ timeout: 5000 });
    await expect(workingDirInput).not.toHaveValue(initialValue);
    await expect(page.locator('[data-testid="session-create-modal"]')).toBeVisible();
  });

  test('file browser cancel should return to session create modal', async ({ page }) => {
    // Open create session modal
    const createButton = page.locator('[data-testid="create-session-button"]');
    await createButton.click();

    // Open file browser
    const browseButton = page.locator('button[title="Browse directories"]');
    await browseButton.click();

    // Wait for file browser
    const fileBrowser = page.locator('[data-testid="file-browser"]');
    await expect(fileBrowser).toBeVisible({ timeout: 5000 });

    // Click cancel button
    const cancelButton = page.locator('button:has-text("Cancel")').last();
    await cancelButton.click();

    // File browser should close
    await expect(fileBrowser).not.toBeVisible({ timeout: 5000 });

    // Session create modal should still be visible
    const sessionModal = page.locator('[data-testid="session-create-modal"]');
    await expect(sessionModal).toBeVisible();
  });
});

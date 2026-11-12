import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/test.fixture';
import { TestSessionManager } from '../helpers/test-data-manager.helper';

// These tests create their own sessions and can run in parallel
test.describe.configure({ mode: 'parallel' });

/** Opens the create form from the header's "New session" button and waits for its fields. */
async function openCreateForm(page: Page) {
  await page.locator('[data-testid="create-session-button"]').first().click();
  await expect(page.locator('[data-testid="session-create-modal"]')).toBeVisible();
  await expect(page.locator('[data-testid="command-input"]')).toBeVisible();
}

/** The session name lives in the form's "Options" section, closed by default. */
async function openCreateOptions(page: Page) {
  const optionsButton = page.locator('#session-options-button');
  if ((await optionsButton.getAttribute('aria-expanded')) !== 'true') {
    await optionsButton.click();
  }
  await expect(page.locator('[data-testid="session-name-input"]')).toBeVisible();
}

test.describe('UI Features', () => {
  let sessionManager: TestSessionManager;

  test.beforeEach(async ({ page }) => {
    sessionManager = new TestSessionManager(page);
  });

  test.afterEach(async () => {
    await sessionManager.cleanupAllSessions();
  });

  test('should use quick start commands', async ({ page }) => {
    await openCreateForm(page);

    const commandInput = page.locator('[data-testid="command-input"]');
    const zshPill = page.locator('[data-testid="quick-start-pills"] button[title="zsh"]');
    await expect(zshPill).toBeVisible();

    // A quick start pill fills the command field, whatever was typed there.
    await commandInput.fill('bash');
    await expect(zshPill).toHaveAttribute('aria-pressed', 'false');
    await zshPill.click();
    await expect(commandInput).toHaveValue('zsh');
    await expect(zshPill).toHaveAttribute('aria-pressed', 'true');

    // The session it creates opens.
    const sessionName = sessionManager.generateSessionName('quick-start');
    await openCreateOptions(page);
    await page.locator('[data-testid="session-name-input"]').fill(sessionName);
    await page.locator('[data-testid="create-session-submit"]').click();
    await page.waitForURL(/\/session\//, { timeout: 15000 });

    const sessionId = page.url().match(/\/session\/([^/?]+)/)?.[1] ?? '';
    expect(sessionId).not.toBe('');
    sessionManager.trackSession(sessionName, sessionId);
    await expect(page.locator('[data-testid="session-title-container"]')).toContainText(
      sessionName
    );
  });

  test('should display notification options', async ({ page }) => {
    // The header's settings button (notification-status) leads to the notification options.
    const settingsButton = page.locator('full-header notification-status button');
    await expect(settingsButton).toBeVisible();
    await settingsButton.click();

    await page.locator('[data-testid="settings-nav-notifications"]').click();
    const section = page.locator('[data-testid="settings-section-notifications"]');
    await expect(section).toBeVisible();
    await expect(section.locator('[data-testid="settings-notifications-status"]')).toBeVisible();
    await expect(section.locator('[data-testid="settings-notifications-action"]')).toBeVisible();
  });

  test('should show session count in sidebar header', async ({ page }) => {
    await sessionManager.createTrackedSession();

    // In a session the sidebar's brand counts the running sessions: the server's, shared with
    // whatever other tests run at the same time. 2026-11-11: compared with what it read before
    // ("one more than a moment ago"), it failed in a parallel run when another test's session
    // ended in between. It is compared with what the server says now, and with this test's own.
    const count = page.locator('sidebar-header .ut-brand-count-short');
    const shown = async () => Number((await count.textContent())?.trim() || Number.NaN);
    const running = async () => {
      const sessions: Array<{ status: string }> = await (
        await page.request.get('/api/sessions')
      ).json();
      return sessions.filter((session) => session.status === 'running').length;
    };
    const showsTheServerCount = (own: number) =>
      expect(async () => {
        const value = await shown();
        expect(value).toBeGreaterThanOrEqual(own);
        expect(value).toBe(await running());
      }).toPass({ timeout: 10_000 });
    await showsTheServerCount(1);

    await sessionManager.createTrackedSession();
    await showsTheServerCount(2);
  });

  test('should drop unsent edits when the create dialog is cancelled', async ({ page }) => {
    await openCreateForm(page);
    await openCreateOptions(page);

    const nameInput = page.locator('[data-testid="session-name-input"]');
    const commandInput = page.locator('[data-testid="command-input"]');
    const dirInput = page.locator('[data-testid="working-dir-input"]');
    const defaultDir = await dirInput.inputValue();
    await expect(commandInput).toHaveValue('zsh');

    await nameInput.fill('Preserve Test');
    await commandInput.fill('python3');
    await dirInput.fill('/usr/local');

    // Cancel: nothing was created, so nothing is remembered.
    await page.locator('#session-cancel-button').click();
    await expect(page.locator('[data-testid="session-create-modal"]')).toBeHidden();

    await openCreateForm(page);
    await expect(commandInput).toHaveValue('zsh');
    await expect(dirInput).toHaveValue(defaultDir);
    await openCreateOptions(page);
    await expect(nameInput).toHaveValue('');
  });

  test('should show terminal preview in session cards', async ({ page }) => {
    const { sessionName } = await sessionManager.createTrackedSession();

    await page.goto('/');
    const sessionCard = page.locator('session-card').filter({ hasText: sessionName }).first();
    await expect(sessionCard).toBeVisible({ timeout: 20000 });

    // The closed card has no preview; "More" opens the terminal's last lines.
    const preview = sessionCard.locator('ut-terminal-buffer');
    await expect(preview).toHaveCount(0);
    await sessionCard.locator('[data-testid="session-card-more"]').click();
    await expect(preview).toBeVisible({ timeout: 20000 });
  });
});

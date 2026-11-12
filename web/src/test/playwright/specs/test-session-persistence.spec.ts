import { expect, test } from '../fixtures/test.fixture';
import { assertSessionInList } from '../helpers/assertion.helper';
import { createAndNavigateToSession } from '../helpers/session-lifecycle.helper';
import { TestSessionManager } from '../helpers/test-data-manager.helper';
import { ensureAllSessionsVisible } from '../helpers/ui-state.helper';

// These tests create their own sessions and can run in parallel
test.describe.configure({ mode: 'parallel' });

test.describe('Session Persistence Tests', () => {
  let sessionManager: TestSessionManager;

  test.beforeEach(async ({ page }) => {
    sessionManager = new TestSessionManager(page);
  });

  test.afterEach(async () => {
    await sessionManager.cleanupAllSessions();
  });
  test('should create and find a long-running session', async ({ page }) => {
    test.setTimeout(30000); // Increase timeout
    // Create a session with a command that runs longer
    const { sessionName, sessionId } = await createAndNavigateToSession(page, {
      name: sessionManager.generateSessionName('long-running'),
      command: 'sleep 60', // Keep session running without shell operators
    });

    // Track the session for cleanup
    if (sessionId) {
      sessionManager.trackSession(sessionName, sessionId);
    }

    // Navigate back to home
    await page.goto('/');
    await page.waitForSelector('session-card', { state: 'visible', timeout: 10000 });

    // Verify session is visible in the list
    await assertSessionInList(page, sessionName);
  });

  test('should handle session with error gracefully', async ({ page }) => {
    // Create a session with a command that will fail
    const { sessionName, sessionId } = await createAndNavigateToSession(page, {
      name: sessionManager.generateSessionName('error-test'),
      command: 'false', // Simple command that exits with error code
    });

    // Track the session for cleanup
    if (sessionId) {
      sessionManager.trackSession(sessionName, sessionId);
    }

    // Navigate back to home
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Exited sessions live in the "Finished" section, which can be closed.
    await expect(page.locator('[data-testid="exited-section"]')).toBeVisible({ timeout: 15000 });
    await ensureAllSessionsVisible(page);

    // The failed session is still listed, as exited
    const card = page.locator(`session-card:has-text("${sessionName}")`).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.locator('[data-testid="session-card"]')).toHaveAttribute(
      'data-session-status',
      'exited',
      { timeout: 15000 }
    );
  });
});

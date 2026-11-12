import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures/test.fixture';
import { TestSessionManager } from '../helpers/test-data-manager.helper';

const androidUserAgent =
  'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile Safari/537.36';

// Centred controls land on half pixels (a 36 px button in the 35 px row under the hairline).
const SUBPIXEL = 1;

/**
 * Retried until it holds: after setViewportSize the header is laid out again over a frame or two
 * (2026-11-11: with several workers the portrait check read the 36 px landscape tile once).
 */
async function expectInsideViewport(page: Page, locator: Locator, minimumSize = 44): Promise<void> {
  await expect(() => checkInsideViewport(page, locator, minimumSize)).toPass({ timeout: 5000 });
}

async function checkInsideViewport(
  page: Page,
  locator: Locator,
  minimumSize: number
): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();

  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;

  expect(box.x).toBeGreaterThanOrEqual(-SUBPIXEL);
  expect(box.y).toBeGreaterThanOrEqual(-SUBPIXEL);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + SUBPIXEL);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + SUBPIXEL);
  expect(box.width).toBeGreaterThanOrEqual(minimumSize);
  expect(box.height).toBeGreaterThanOrEqual(minimumSize);
}

test.describe('mobile session header', () => {
  test.use({
    viewport: { width: 434, height: 965 },
    userAgent: androidUserAgent,
    isMobile: true,
    hasTouch: true,
  });

  let sessionManager: TestSessionManager;
  let sessionName: string;

  test.beforeEach(async ({ page }) => {
    sessionManager = new TestSessionManager(page, 'header-mobile');
    sessionName =
      'Issue 516 iPhone session title that is intentionally very long to verify truncation and visibility';
    // The phone list starts sessions through its own sheets; the header is what is under
    // test here, so the session comes from the API.
    const response = await page.request.post('/api/sessions', {
      data: { command: ['bash'], name: sessionName, shielded: false },
    });
    expect(response.ok()).toBe(true);
    const { sessionId } = await response.json();
    sessionManager.trackSession(sessionName, sessionId);
    await page.goto(`/session/${sessionId}`);
    await expect(page.locator('session-header')).toBeVisible();
  });

  test.afterEach(async () => {
    await sessionManager.cleanupAllSessions();
  });

  test('keeps navigation, chat, menu, and keyboard controls reachable at narrow widths', async ({
    page,
  }) => {
    const headerControls = [
      page.getByTestId('session-back-button'),
      page.getByTestId('chat-mode-toggle-button-compact'),
      page.getByRole('button', { name: 'More actions menu', exact: true }),
    ];
    const titleContainer = page.getByTestId('session-title-container');
    const titleText = titleContainer.locator('.ut-ph-title-text');

    // Landscape gets the one-line header: 36 x 28 tiles whose ::after keeps the 44 px tap
    // target (session.css, 2026-10-14). Portrait controls are 44 px themselves.
    for (const { minimumSize, ...viewport } of [
      { width: 700, height: 500, minimumSize: 28 },
      { width: 434, height: 965, minimumSize: 44 },
      { width: 390, height: 844, minimumSize: 44 },
      { width: 360, height: 800, minimumSize: 44 },
    ]) {
      await page.setViewportSize(viewport);

      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(viewport.width);

      for (const control of headerControls) {
        await expect(control).toBeVisible();
        await expectInsideViewport(page, control, minimumSize);
      }

      await expect(titleContainer).toBeVisible();
      await expectInsideViewport(page, titleContainer, 0);
      await expect(titleText).toHaveAttribute('title', sessionName);
    }

    await page.setViewportSize({ width: 360, height: 800 });
    await expect
      .poll(() =>
        titleText.evaluate((element) => {
          const styles = getComputedStyle(element);
          return {
            isTruncated: element.scrollWidth > element.clientWidth,
            textOverflow: styles.textOverflow,
            whiteSpace: styles.whiteSpace,
          };
        })
      )
      .toEqual({
        isTruncated: true,
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      });

    // The menu opens as a sheet and closes with its Cancel.
    await page.setViewportSize({ width: 434, height: 965 });
    const menuButton = page.getByRole('button', { name: 'More actions menu', exact: true });
    await menuButton.click();
    await expect(page.getByTestId('compact-file-browser')).toBeVisible();
    await page.getByTestId('compact-menu-cancel').click();
    await expect(page.getByTestId('compact-file-browser')).toBeHidden();

    // The action bar's keyboard button brings up the quick keys, which take the bar's place.
    // A transparent field covers the button (iOS only opens the keyboard for a finger on a
    // real field), so that field is what a tap lands on.
    const actionBar = page.getByTestId('mobile-action-bar');
    const keyboardButton = actionBar.getByTestId('action-bar-keyboard');
    await expect(keyboardButton).toBeVisible();
    await expectInsideViewport(page, keyboardButton);
    await actionBar.locator('.keyboard-proxy').tap();
    await expect(page.locator('.terminal-quick-keys-container')).toBeVisible();
    await expect(actionBar).toBeHidden();
  });
});

test.describe('desktop session header', () => {
  test.use({
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
    isMobile: false,
    hasTouch: false,
  });

  let sessionManager: TestSessionManager;

  test.beforeEach(async ({ page }) => {
    sessionManager = new TestSessionManager(page, 'header-desktop');
  });

  test.afterEach(async () => {
    await sessionManager.cleanupAllSessions();
  });

  test('preserves desktop header spacing and session details', async ({ page }) => {
    const { sessionName } = await sessionManager.createTrackedSession();
    const header = page.locator('.session-header-container');

    await expect(header).toBeVisible();
    await expect(header).toContainText(sessionName);
    await expect
      .poll(() =>
        header.evaluate((element) => {
          const styles = getComputedStyle(element);
          return {
            paddingLeft: styles.paddingLeft,
            paddingRight: styles.paddingRight,
            scrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
          };
        })
      )
      .toEqual({
        paddingLeft: '10px',
        paddingRight: '8px',
        scrollWidth: 1280,
        viewportWidth: 1280,
      });
  });
});

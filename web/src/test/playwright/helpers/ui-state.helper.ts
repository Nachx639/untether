import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Opens the list's "Finished" section when it is closed, so assertions can see sessions that
 * have exited. The section (and its toggle) only exists while there are exited sessions:
 * `exited-section-toggle` on desktop, `show-exited-toggle` on the phone list. A caller that
 * knows there is an exited session waits for the section itself first; here the toggle gets
 * a short moment to render and its absence means there is nothing to open.
 */
export async function ensureAllSessionsVisible(page: Page): Promise<void> {
  const toggle = page
    .locator('[data-testid="exited-section-toggle"], [data-testid="show-exited-toggle"]')
    .first();

  const present = await toggle
    .waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (!present) return;
  if ((await toggle.getAttribute('aria-expanded')) === 'true') return;

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

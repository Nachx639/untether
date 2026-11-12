// Settings and the new-session form, over the list.
import { DESKTOP, PHONE, askHeader, openList } from './helpers.mjs';

async function openSettings(page, ctx) {
  await openList(page, ctx);
  await askHeader(page, 'open-settings');
  await page.getByTestId('settings-sheet').waitFor({ state: 'visible' });
}

/** The form with its intended initial focus, on the element with that test id. */
const openCreate = (focused) => async (page, ctx) => {
  await openList(page, ctx);
  await askHeader(page, 'create-session');
  await page.getByTestId('create-session-submit').first().waitFor({ state: 'visible' });
  // Match the form's intended initial focus: on touch, the sheet avoids raising the
  // keyboard; desktop starts in the command. A late focus trap otherwise changes a
  // seemingly settled screenshot between runs. Exercise focus, never paint it away.
  await page.getByTestId(focused).first().focus();
};

export default [
  { name: 'settings', ...PHONE, base: true, open: openSettings },
  { name: 'settings-desktop', ...DESKTOP, base: true, open: openSettings },
  { name: 'create', ...PHONE, base: true, open: openCreate('session-create-modal') },
  { name: 'create-desktop', ...DESKTOP, base: true, open: openCreate('command-input') },
  // 390x844, the style picker; on request: --views appearance.
  {
    name: 'appearance',
    ...PHONE,
    async open(page, ctx) {
      await openSettings(page, ctx);
      await page.getByTestId('settings-nav-appearance').click();
      await page.locator('[data-testid^="settings-look-"][data-ready]').first().waitFor({ state: 'visible' });
      await page.getByTestId('settings-look-grid').scrollIntoViewIfNeeded();
    },
  },
];

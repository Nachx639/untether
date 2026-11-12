// A task's sheet, on the phone and the desktop.
import { DESKTOP, PHONE, openList } from './helpers.mjs';

async function openTaskSheet(page, ctx) {
  const { rich, look } = ctx;
  await openList(page, ctx);
  // Click only after the look's geometry is applied. Otherwise click() scrolls a card
  // using the previous layout, and the backdrop differs even when the sheet is identical.
  if (look && look !== 'original') {
    await page.waitForFunction(look => document.documentElement.dataset.look === look, look);
  }
  await page.evaluate(() => document.fonts.ready.then(() => true));
  // On the title: the middle of the row can be one of its buttons, depending on the type's width.
  await page
    .locator(`[data-testid="task-row"][data-task-id="${rich.taskForSheet}"]`)
    .first()
    .click({ position: { x: 90, y: 16 } });
  await page.getByTestId('task-detail-sheet').waitFor({ state: 'visible' });
}

export default [
  // 390x844, the sheet of a task.
  { name: 'task', ...PHONE, base: true, open: openTaskSheet },
  { name: 'task-desktop', ...DESKTOP, open: openTaskSheet },
];

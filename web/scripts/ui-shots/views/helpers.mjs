// What the views share: the devices, the two ways into the app, and how a view frames its picture.
//
// A view is one entry of a file in this folder:
//   name       the picture's name: <browser>-<name>-<style>.png, and what --views takes
//   viewport, phone   its device (spread PHONE, PHONE_NARROW, PHONE_WIDE, DESKTOP or DESKTOP_WIDE)
//   open(page, ctx)   takes the page to the view; ctx is { url, rich, look, options, name }
//   frame(page, ctx)  optional: scrolls to what the picture is about, once fonts and style are in
//   patch(body, ctx)  optional: changes what the browser receives from the twin's list endpoints
//                     (ctx.pathname says which), never the twin's own state
//   base       in the default set of pictures
//   audit      added by --audit-layout when no --views is given
//   crops      one crop per project header besides the picture (projectCrops)
//   folded     the layout audit fails if the view shows no folded project
//   terminal   shows a terminal: --check-untouchables waits for its canvas
//   scroll     --measure-scroll measures its list

export const PHONE = { viewport: { width: 390, height: 844 }, phone: true };
export const DESKTOP = { viewport: { width: 1440, height: 900 }, phone: false };
// A wide window (2026-11-11): what a full-width bar does at its two ends shows here.
export const DESKTOP_WIDE = { viewport: { width: 2000, height: 900 }, phone: false };
// An iPhone SE-sized phone, where the least fits.
export const PHONE_NARROW = { viewport: { width: 320, height: 693 }, phone: true };
// An iPhone Pro Max (2026-11-09): from 430 pt the project header's "Orquestador" shows its
// word, which 390 pt hides; a labelled button with an icon's width only shows here.
export const PHONE_WIDE = { viewport: { width: 440, height: 956 }, phone: true };

/** The list, up: its first session title is on the page. */
export async function openList(page, { url, rich }) {
  await page.goto(`${url}/`);
  await page.getByText(rich.sessionTitles[0]).first().waitFor({ state: 'visible' });
}

/** A session. On a phone session-view is display: contents, never "visible": wait for its header's button. */
export async function openSession(page, { url, rich }, toggle = 'chat-mode-toggle-button') {
  await page.goto(`${url}/session/${rich.sessionForDesktop}`);
  await page.getByTestId(toggle).first().waitFor({ state: 'visible' });
}

/** A session on the desktop, once its sidebar shows its rows. */
export async function openSessionWithSidebar(page, ctx) {
  await openSession(page, ctx);
  await page.locator('compact-session-card').first().waitFor({ state: 'visible' });
}

/** Asks the app to open a dialog, as its header's buttons do (the phone keeps them in a menu). */
export async function askHeader(page, eventName) {
  await page.locator('app-header').first().waitFor({ state: 'attached' });
  await page.evaluate((event) => {
    document.querySelector('app-header').dispatchEvent(new CustomEvent(event, { bubbles: true }));
  }, eventName);
}

/** Scrolls the phone list so the element sits `gap` px below the sticky header. */
export function scrollBelowHeader(locator, gap) {
  return locator.evaluate((el, gap) => {
    const scroller = document.querySelector('.main-list-scroll');
    const header = document.querySelector('.ut-phone-header').getBoundingClientRect();
    scroller.scrollTop = Math.round(scroller.scrollTop + el.getBoundingClientRect().top - header.bottom - gap);
  }, gap);
}

/** One crop per project header, with the end of the project before it (the line between them). */
export async function projectCrops(page, shotFile, phone) {
  const heads = page.locator(phone ? '[data-testid="project-header"]' : '[data-testid="sidebar-group"] [data-testid="repo-header"]');
  for (let index = 0; index < await heads.count(); index++) {
    const clip = await heads.nth(index).evaluate((el, phone) => {
      const scroller = el.closest(phone ? '.main-list-scroll' : '.ut-side-list');
      const top = phone ? document.querySelector('.ut-phone-header').getBoundingClientRect().bottom : scroller.getBoundingClientRect().top;
      for (let node = scroller; node; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight) node.scrollTop = Math.round(node.scrollTop + el.getBoundingClientRect().top - top - 72);
      }
      const r = el.getBoundingClientRect();
      // A list too short to bring this header whole into view, or a header that is not shown.
      if (r.width < 8 || r.height < 8 || r.top < top || r.bottom > innerHeight || r.right > innerWidth) return null;
      const x = Math.max(0, Math.floor(r.left - 16));
      const y = Math.max(Math.ceil(top), Math.floor(r.top - 64));
      return {
        x,
        y,
        width: Math.min(innerWidth, Math.ceil(r.right + 16)) - x,
        height: Math.min(innerHeight, Math.ceil(r.bottom + 12)) - y,
      };
    }, phone);
    if (!clip) continue;
    const file = shotFile.replace(/\.png$/, `-project-${index + 1}.png`);
    // A crop is an extra: one the browser cannot take (a header its sidebar keeps out of the
    // picture) is said and skipped, the view's own picture and audit stand.
    try {
      await page.screenshot({ path: file, clip, animations: 'disabled', caret: 'hide' });
      console.log(`ui-shots: ${file}`);
    } catch (error) {
      console.log(`ui-shots: no crop for project ${index + 1}: ${String(error.message).split('\n')[0]}`);
    }
  }
}

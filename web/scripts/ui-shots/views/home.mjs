// The home: the session list on the phone and the desktop, as it comes and at its particular places.
import { DESKTOP, DESKTOP_WIDE, PHONE, PHONE_NARROW, PHONE_WIDE, openList, openSessionWithSidebar, scrollBelowHeader } from './helpers.mjs';

// The twin's paths reach the browser as «~/…» (the same in every run), which the board takes
// for no project at all: every task fell in «Sin repositorio». Here they are absolute again, so
// each project holds its own tasks beside its sessions: projects of one, two and more columns.
const absolute = (value) => {
  if (typeof value === 'string') return value.startsWith('~/') ? `/Users/twin/${value.slice(2)}` : value;
  if (Array.isArray(value)) return value.map(absolute);
  if (value && typeof value === 'object') { for (const key of Object.keys(value)) value[key] = absolute(value[key]); }
  return value;
};
const desktopBoard = {
  audit: true,
  open: openList,
  patch(body) {
    absolute(body);
  },
  // The projects' grid from its first header, below «Te necesitan» and the sticky toolbar.
  frame: (page) => scrollBelowToolbar(page.locator('[data-testid="repo-group"]').first()),
};
// Only the list scrolls: scrollIntoView also moves boxes that clip without scrolling, and what
// they cut then reads as clipped controls.
const scrollList = (locator, place) => locator.evaluate((el, place) => {
  const scroller = document.querySelector('.main-list-scroll');
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop = Math.round(scroller.scrollTop + top - (place === 'center' ? scroller.clientHeight / 2 : 96));
}, place);
const scrollBelowToolbar = (locator) => scrollList(locator, 'top');

export default [
  // 390x844, the session list.
  { name: 'mobile', ...PHONE, base: true, scroll: true, open: openList },
  // 1440x900, the compact sidebar next to a session.
  { name: 'desktop', ...DESKTOP, base: true, terminal: true, open: openSessionWithSidebar },
  // The home's two bars, one over the other (header, list toolbar), are one surface (2026-11-11:
  // each drew its own bottom corners and edge, the page's background showing between them at
  // the ends; widest at 2000 px).
  { name: 'desktop-home', ...DESKTOP, audit: true, scroll: true, open: openList },
  { name: 'desktop-home-wide', ...DESKTOP_WIDE, audit: true, open: openList },
  // The whole home on a wide and on a narrower desktop window, its projects of different sizes
  // side by side (2026-11-11: a project with one task took two columns, its header twice as
  // wide as its cards, while its neighbours' names were cut to «b…» and «ia-s…»).
  { name: 'desktop-home-1600', viewport: { width: 1600, height: 1000 }, phone: false, ...desktopBoard },
  { name: 'desktop-home-1280', viewport: { width: 1280, height: 900 }, phone: false, ...desktopBoard },
  // The sections that fold under the projects, «Hechas» and «Terminadas» among them: one
  // header piece for all (2026-11-11: «Hechas» had its chevron on a line of its own and no hairline).
  {
    name: 'desktop-home-sections',
    viewport: { width: 1600, height: 1000 },
    phone: false,
    ...desktopBoard,
    frame: (page) => scrollList(page.getByTestId('done-toggle'), 'center'),
  },
  {
    name: 'desktop-selected',
    ...DESKTOP,
    async open(page, ctx) {
      await openSessionWithSidebar(page, ctx);
      await page.locator('compact-session-card .ut-side-row').first().click();
      await page.locator('compact-session-card .ut-side-row.is-selected').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'mobile-rows',
    ...PHONE,
    async open(page, ctx) {
      await openList(page, ctx);
      await page.locator('[data-testid="phone-session-row"]').first().scrollIntoViewIfNeeded();
    },
    // A full ordinary session row (with its menu), below sticky chrome, also after
    // safe-area geometry is applied. The first row can instead be a waiting reply card.
    frame: (page) => scrollBelowHeader(page.locator('[data-testid="phone-session-row"]').filter({ has: page.locator('.psr-menu') }).first(), 16),
  },
  // The list on a wide phone (PHONE_WIDE says why).
  { name: 'mobile-wide', ...PHONE_WIDE, audit: true, open: openList },
  // The top of the list, with the strip "Te necesita", on a narrow phone (2026-11-10: its titles
  // cut in the middle lost letters with no «…» in the styles with large type); 390 and 440 are
  // mobile and mobile-wide.
  { name: 'mobile-320', ...PHONE_NARROW, audit: true, open: openList },
  // "Hechas" open and scrolled, with image avatars (2026-11-09: on a real iPhone the avatars of
  // a long list of merged tasks were painted out of their rows).
  {
    name: 'mobile-done',
    ...PHONE_WIDE,
    audit: true,
    async open(page, ctx) {
      await openList(page, ctx);
      await page.getByTestId('done-toggle').click();
      await page.getByTestId('done-list').waitFor({ state: 'visible' });
      await page.locator('[data-testid="done-list"] .psr-avatar img').first().waitFor({ state: 'attached' });
      // Down the whole list and part of the way back, a frame at a time, as a finger would.
      await page.evaluate(async () => {
        const scroller = document.querySelector('.main-list-scroll');
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        for (let last = -1; scroller.scrollTop !== last; await frame()) { last = scroller.scrollTop; scroller.scrollTop += 90; }
        for (let step = 0; step < 6; step++, await frame()) scroller.scrollTop -= 70;
      });
    },
    // The seed's config has no image avatars (every other view keeps the app's marks).
    patch(body, { pathname, rich }) {
      if (pathname === '/api/config') body.avatarIcons = rich.avatarIcons;
    },
  },
  {
    name: 'mobile-composer',
    ...PHONE,
    open: openList,
    frame: (page) => scrollBelowHeader(page.getByTestId('ask-claude'), 16),
  },
];

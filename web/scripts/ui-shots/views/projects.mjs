// The projects of the task board: their headers, a project's queue, and projects folded.
import { DESKTOP, PHONE, PHONE_NARROW, PHONE_WIDE, openList, openSessionWithSidebar, scrollBelowHeader } from './helpers.mjs';

// The project headers of the phone list on a narrow, an ordinary and a wide phone, and the
// sidebar's (2026-11-10: names cut to three letters beside whole action labels, and nothing
// between one project and the next). Besides the picture, one crop per header:
// <picture>-project-<n>.png, with the end of the project before it.
const phoneProjects = {
  audit: true,
  crops: true,
  open: openList,
  // Where one project ends and the next begins, below the sticky header.
  frame: (page) => scrollBelowHeader(page.locator('[data-testid="project-header"]').nth(1), 200),
};

// The queued tasks of one project, whose titles share their start (2026-11-10: a real iPhone
// read the same title three times), on a narrow, an ordinary and a wide phone.
const phoneQueue = {
  audit: true,
  open: openList,
  frame: (page) => scrollBelowHeader(page.locator('[data-testid="task-row"][data-state="queued"]').first(), 16),
};

// One project folded and the others open (2026-11-10), on the three phones and in the sidebar:
// a project and "Otras", which in the twin holds the queued tasks and the ones waiting for the
// user, so its summary says both.
// Folded only in what the browser receives (GET /api/tasks): the twin's state stays as it is.
const folded = {
  audit: true,
  crops: true,
  folded: true,
  patch(body) {
    if (Array.isArray(body.tasks)) body.collapsedGroups = [body.tasks.find(task => task.state === 'queued').repoPath, '(others)'];
  },
};
const phoneFolded = {
  ...folded,
  async open(page, { url }) {
    await page.goto(`${url}/`);
    // A folded view hides the list's first title inside "Otras": its folded projects say the list is up.
    await page.locator('[data-testid="project-group"][data-folded="true"] [data-testid="project-fold-summary"]').nth(1).waitFor({ state: 'visible' });
  },
  // The folded project below the sticky header, with the end of the one before it.
  frame: (page) => scrollBelowHeader(page.locator('[data-testid="project-group"][data-folded="true"] [data-testid="project-header"]').first(), 200),
};

export default [
  { name: 'mobile-projects', ...PHONE, ...phoneProjects },
  { name: 'mobile-projects-320', ...PHONE_NARROW, ...phoneProjects },
  { name: 'mobile-projects-440', ...PHONE_WIDE, ...phoneProjects },
  { name: 'desktop-projects', ...DESKTOP, audit: true, crops: true, open: openSessionWithSidebar },
  { name: 'mobile-queue', ...PHONE, ...phoneQueue },
  { name: 'mobile-queue-320', ...PHONE_NARROW, ...phoneQueue },
  { name: 'mobile-queue-440', ...PHONE_WIDE, ...phoneQueue },
  { name: 'mobile-folded', ...PHONE, ...phoneFolded },
  { name: 'mobile-folded-320', ...PHONE_NARROW, ...phoneFolded },
  { name: 'mobile-folded-440', ...PHONE_WIDE, ...phoneFolded },
  {
    name: 'desktop-folded',
    ...DESKTOP,
    ...folded,
    async open(page, ctx) {
      await openSessionWithSidebar(page, ctx);
      await page.locator('[data-testid="sidebar-group"][data-folded="true"]').first().waitFor({ state: 'visible' });
    },
  },
];

// The registry of views: every view of every file listed here, by name. A new view is one entry
// in its group's file (what an entry holds: helpers.mjs); only a new group adds a line here.
// The order of the groups and of the entries inside them is the order the pictures are taken in.
import coverage from './coverage.mjs';
import dialogs from './dialogs.mjs';
import home from './home.mjs';
import projects from './projects.mjs';
import session from './session.mjs';
import task from './task.mjs';

const all = [...home, ...task, ...session, ...dialogs, ...projects, ...coverage];
for (const [index, view] of all.entries()) {
  if (all.findIndex((other) => other.name === view.name) !== index) throw new Error(`ui-shots: two views are named ${view.name}`);
  if (typeof view.open !== 'function' || !view.viewport) throw new Error(`ui-shots: the view ${view.name} lacks open() or a device`);
}

export const VIEWS = Object.fromEntries(all.map((view) => [view.name, view]));
/** The default set of pictures. */
export const BASE_VIEWS = all.filter((view) => view.base).map((view) => view.name);
/** Not in the default set; a layout audit with no --views adds them. */
export const AUDIT_VIEWS = all.filter((view) => view.audit).map((view) => view.name);

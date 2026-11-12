/**
 * The home by project (pure): sessions and worktree tasks grouped by git repository (worktree
 * family), "Otras" (null key) for what runs outside any repository.
 *
 * - One group per repo family: the key is the main repo path (sessionRepoKey, normalized); a
 *   repo inside another group's path, or listed among another group's worktrees, joins that
 *   group, so the same repo is never split (2026-10-12, moved here from session-list).
 * - A task's session is shown only inside its task row, never again as a loose session row.
 * - A project folder without git (2026-10-18: ~/Projects/tele-ambiente fell into "Otras") is a
 *   group of its own, without tasks: see folderGroupKey.
 * - A session the user anchored to a group (Session.groupPin, its menu) is there, whatever
 *   the automatic grouping says (2026-11-04).
 * - Groups with something waiting for the user climb (sticky otherwise, see stickyGroupOrder);
 *   "Otras" is always last.
 * - The order the user chose (dragging a header, «Subir» / «Bajar», 2026-11-07; TaskStore
 *   groupOrder, kept on the server) wins over that: see withManualOrder.
 * - Inside a group, the sessions the user ordered by dragging a row keep that order among
 *   themselves; any other (a new one) stays where the automatic order puts it (TaskStore
 *   sessionOrder, withManualSessionOrder).
 */
import type { TaskRecord } from '../../shared/tasks.js';
import type { Session } from '../../shared/types.js';
import { normalizeRepoPath, sessionRepoKey } from './repo-key.js';
import { deriveSessionStatus, lastActivityAt } from './session-status.js';
import {
  isBoardTask,
  isDoneTask,
  sortBoardTasks,
  sortDoneTasks,
  taskWantsUser,
} from './task-status.js';

/** "Hechas" lists at most this many (the newest). */
export const DONE_LIMIT = 20;
/** A group climbs past the one above it only when its activity leads by more than this. */
export const GROUP_LEAD_MS = 120_000;

export interface WorktreeLike {
  path: string;
}

/**
 * The family (root key) of each repo key: nested paths and known worktrees fold into their
 * main repo. Shorter keys win, so a nested repo joins its parent.
 */
export function repoFamilies(
  keys: Iterable<string>,
  worktrees: ReadonlyMap<string, readonly WorktreeLike[]> = new Map()
): (key: string) => string {
  const all = new Set(keys);
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  const union = (main: string, other: string) => {
    const a = find(main);
    const b = find(other);
    if (a !== b) parent.set(b, a);
  };
  const sorted = [...all].sort((a, b) => a.length - b.length);
  for (const key of sorted) {
    for (const worktree of worktrees.get(key) ?? []) {
      const path = normalizeRepoPath(worktree.path);
      if (path !== key && all.has(path)) union(key, path);
    }
    for (const other of sorted) {
      if (other !== key && other.startsWith(`${key}/`)) union(key, other);
    }
  }
  return find;
}

/**
 * The group the user anchored a session to (2026-11-04, "Anclar a este grupo" / "Mover a…"):
 * its key, null for "Otras"; undefined when it is grouped automatically.
 */
export function anchoredGroupKey(session: Pick<Session, 'groupPin'>): string | null | undefined {
  const pin = session.groupPin;
  if (!pin || typeof pin !== 'object') return undefined;
  return typeof pin.repoPath === 'string' && pin.repoPath.startsWith('/')
    ? normalizeRepoPath(pin.repoPath)
    : null;
}

/**
 * Sessions by repo family, in the order their groups first appear; no repo under null. A
 * running orchestrator's session goes to its project (`orchestrators`, as buildProjectBoard):
 * 2026-10-25, the split-view sidebar put juego-de-cartas's orchestrator under tele-ambiente.
 */
export function groupSessionsByRepo(
  sessions: readonly Session[],
  worktrees: ReadonlyMap<string, readonly WorktreeLike[]> = new Map(),
  orchestrators: ReadonlyArray<{ repoPath: string; sessionId: string }> = []
): Map<string | null, Session[]> {
  return groupSessionsAndTasksByRepo(sessions, [], worktrees, orchestrators).sessions;
}

/**
 * Sessions and tasks by the same repo families (2026-11-08, the split-view sidebar): a task's
 * repo counts as a family too, so a project with only tasks has its group and a task never
 * lands apart from its project's sessions.
 */
export function groupSessionsAndTasksByRepo(
  sessions: readonly Session[],
  tasks: readonly TaskRecord[],
  worktrees: ReadonlyMap<string, readonly WorktreeLike[]> = new Map(),
  orchestrators: ReadonlyArray<{ repoPath: string; sessionId: string }> = []
): { sessions: Map<string | null, Session[]>; tasks: Map<string | null, TaskRecord[]> } {
  const orchestrating = new Map(
    orchestrators.map((entry) => [entry.sessionId, normalizeRepoPath(entry.repoPath)])
  );
  const keyOf = (session: Session) => {
    const anchored = anchoredGroupKey(session);
    if (anchored !== undefined) return anchored;
    return (
      orchestrating.get(session.id) ?? suspendedOrchestratorRepo(session) ?? sessionRepoKey(session)
    );
  };
  const keys = [...sessions.map(keyOf), ...tasks.map(taskRepoKey)].filter(Boolean) as string[];
  const family = repoFamilies(keys, worktrees);
  const add = <T>(groups: Map<string | null, T[]>, key: string | null | undefined, item: T) => {
    const groupKey = key ? family(key) : null;
    const group = groups.get(groupKey);
    if (group) group.push(item);
    else groups.set(groupKey, [item]);
  };
  const bySession = new Map<string | null, Session[]>();
  for (const session of sessions) add(bySession, keyOf(session), session);
  const byTask = new Map<string | null, TaskRecord[]>();
  for (const task of tasks) add(byTask, taskRepoKey(task), task);
  return { sessions: bySession, tasks: byTask };
}

/**
 * The project a paused orchestrator belongs to (2026-10-31): a suspended session is no longer a
 * running orchestrator, so without this one opened in ~/Projects fell under "Sin repositorio"
 * instead of staying in its project.
 */
function suspendedOrchestratorRepo(session: Session): string | undefined {
  const repo = session.suspended?.orchestratorOf;
  return typeof repo === 'string' && repo.startsWith('/') ? normalizeRepoPath(repo) : undefined;
}

/** The home folder `dir` is in (/Users/<name>, /home/<name>), null outside one. */
function homeOf(dir: string): string | null {
  return dir.match(/^\/(?:Users|home)\/[^/]+/)?.[0] ?? null;
}

/** How deep `dir` is under its home folder (~/Projects/app: 2), -1 outside one. */
function depthUnderHome(dir: string): number {
  const home = homeOf(dir);
  return home ? dir.slice(home.length).split('/').filter(Boolean).length : -1;
}

/**
 * The folder group of a session outside git: its project's folder (at least two levels under
 * the home folder, ~/Projects/tele-ambiente) rather than the home folder, a folder of folders
 * (~/Projects) or one outside the home folder. Null otherwise.
 *
 * Where its agent works now (Session.workDir: the folder of the last file it wrote) counts
 * first, as its project's root: the session's own folder when that holds it, else the folder
 * two levels under home. 2026-10-20: a session in ~/Projects/tele-ambiente writing src/a.js
 * made a group "src".
 */
export function folderGroupKey(
  session: Pick<Session, 'workingDir'> & Partial<Pick<Session, 'workDir'>>
): string | null {
  const started =
    typeof session.workingDir === 'string' ? normalizeRepoPath(session.workingDir) : '';
  const now = typeof session.workDir === 'string' ? normalizeRepoPath(session.workDir) : '';
  if (now && depthUnderHome(now) >= 2) {
    if (
      started &&
      depthUnderHome(started) >= 2 &&
      (now === started || now.startsWith(`${started}/`))
    ) {
      return started;
    }
    const home = homeOf(now) as string;
    return [home, ...now.slice(home.length).split('/').filter(Boolean).slice(0, 2)].join('/');
  }
  return started && depthUnderHome(started) >= 2 ? started : null;
}

/**
 * The repo group of a session on the board: sessionRepoKey, except that a session without a
 * repository of its own whose agent now works in a project folder outside git has none (it
 * goes to that folder's group). A session in a repository stays in it (2026-10-25, repo-key).
 */
function sessionRepoKeyOf(session: Session): string | null {
  if (
    !session.gitMainRepoPath &&
    !session.gitRepoPath &&
    session.workDir &&
    !session.workRepoPath &&
    folderGroupKey({ workingDir: session.workDir })
  ) {
    return null;
  }
  return sessionRepoKey(session);
}

/** The repo a task belongs to: its main checkout, else the folder it was asked for. */
export function taskRepoKey(task: Pick<TaskRecord, 'repoPath' | 'workingDir'>): string | null {
  const path = task.repoPath || task.workingDir;
  return path && path.startsWith('/') ? normalizeRepoPath(path) : null;
}

/**
 * Groups climbing past each other only when it matters (2026-10-12): starting from the
 * previous order, a group moves above the one before it when it has something waiting for
 * the user and that one doesn't, or when its activity leads by more than GROUP_LEAD_MS. New
 * groups enter by activity, then name.
 */
export function stickyGroupOrder(
  keys: readonly string[],
  info: {
    activity: ReadonlyMap<string, number>;
    needsYou: ReadonlyMap<string, boolean>;
    previous: readonly string[];
    name: (key: string) => string;
  }
): string[] {
  const { activity, needsYou, previous, name } = info;
  const present = new Set(keys);
  const order = previous.filter((key) => present.has(key));
  const known = new Set(order);
  const fresh = keys
    .filter((key) => !known.has(key))
    .sort(
      (a, b) => (activity.get(b) ?? 0) - (activity.get(a) ?? 0) || name(a).localeCompare(name(b))
    );
  const rank = (key: string) => (needsYou.get(key) ? 0 : 1);
  const ahead = (a: string, b: string) =>
    rank(a) < rank(b) ||
    (rank(a) === rank(b) && (activity.get(a) ?? 0) > (activity.get(b) ?? 0) + GROUP_LEAD_MS);
  const result: string[] = [];
  for (const key of [...order, ...fresh]) {
    let i = result.length;
    while (i > 0 && ahead(key, result[i - 1])) i--;
    result.splice(i, 0, key);
  }
  return result;
}

/**
 * Groups in the order the user chose (2026-11-07): those in `manual`, in its order, after the
 * ones it does not hold yet (a new project shows on top, in `keys`' automatic order).
 */
export function withManualOrder(keys: readonly string[], manual: readonly string[]): string[] {
  if (!manual.length) return [...keys];
  const rank = new Map(manual.map((key, index) => [key, index]));
  const unknown = keys.filter((key) => !rank.has(key));
  const known = keys
    .filter((key) => rank.has(key))
    .sort((a, b) => (rank.get(a) as number) - (rank.get(b) as number));
  return [...unknown, ...known];
}

/** At most this many groups are remembered (server/services/group-order.ts GROUP_ORDER_MAX). */
export const GROUP_ORDER_MAX = 200;

/**
 * The saved order after moving group `key` before or after `target` (null: to the end, just
 * above "Otras") among the groups `shown` now, in their shown order. Groups not shown keep
 * their place among the others, so a group that comes back later is where the user left it.
 */
export function moveGroupInOrder(
  manual: readonly string[],
  shown: readonly string[],
  key: string,
  target: string | null,
  place: 'before' | 'after'
): string[] {
  if (!shown.includes(key)) return [...manual];
  const moved = shown.filter((entry) => entry !== key);
  const at = target === null ? -1 : moved.indexOf(target);
  if (at < 0) moved.push(key);
  else moved.splice(place === 'before' ? at : at + 1, 0, key);
  const shownSet = new Set(shown);
  // The whole order as shown: the groups not saved yet first (withManualOrder), then the rest.
  const full = [...shown.filter((entry) => !manual.includes(entry)), ...manual];
  let next = 0;
  return full
    .map((entry) => (shownSet.has(entry) ? moved[next++] : entry))
    .slice(0, GROUP_ORDER_MAX);
}

/** At most this many sessions are remembered (server/services/group-order.ts). */
export const SESSION_ORDER_MAX = 1000;

/**
 * Sessions in the order the user chose (2026-11-07, dragging a row). `sessions` comes in the
 * automatic order: the places of the sessions in `manual` are filled by them in its order, and
 * every other session keeps its own place, so a new one shows where it would without any manual
 * order (on top while it is the most active, as by activity).
 */
export function withManualSessionOrder<T extends { id: string }>(
  sessions: readonly T[],
  manual: readonly string[]
): T[] {
  if (!manual.length) return [...sessions];
  const rank = new Map(manual.map((id, index) => [id, index]));
  const known = sessions
    .filter((session) => rank.has(session.id))
    .sort((a, b) => (rank.get(a.id) as number) - (rank.get(b.id) as number));
  let next = 0;
  return sessions.map((session) => (rank.has(session.id) ? known[next++] : session));
}

/** The ids of a group in their new order once `id` goes before or after `target` (null: last). */
export function placeInGroup(
  shown: readonly string[],
  id: string,
  target: string | null,
  place: 'before' | 'after'
): string[] {
  const group = shown.filter((entry) => entry !== id);
  const at = target === null ? -1 : group.indexOf(target);
  if (at < 0) group.push(id);
  else group.splice(place === 'before' ? at : at + 1, 0, id);
  return group;
}

/**
 * The saved session order after dropping session `id` before or after `target` (null: at the
 * end) in a group that shows `shown` now, in its shown order (`id` may come from another group).
 * The whole group is saved in its new order, so it stays as the user left it; ids of sessions
 * that no longer exist (`known`) are dropped, the oldest first past SESSION_ORDER_MAX.
 */
export function moveSessionInOrder(
  manual: readonly string[],
  shown: readonly string[],
  id: string,
  target: string | null,
  place: 'before' | 'after',
  known?: ReadonlySet<string>
): string[] {
  const group = placeInGroup(shown, id, target, place);
  const moved = new Set(group);
  const next = [
    ...manual.filter((entry) => !moved.has(entry) && (!known || known.has(entry))),
    ...group,
  ];
  return next.slice(Math.max(0, next.length - SESSION_ORDER_MAX));
}

export interface ProjectGroup {
  /** The repo family's main path; null for "Otras". */
  key: string | null;
  /** A folder outside git (folderGroupKey): no branch, no tasks, no orchestrator. */
  folder?: boolean;
  /** Pinned on top by the user: first, in pin order, shown even with nothing in it. */
  pinned?: boolean;
  /** Open board tasks, te necesita first (task-status sortBoardTasks). */
  tasks: TaskRecord[];
  /** Sessions that are not a board task's, in the caller's order. */
  sessions: Session[];
  /** A task or a session waits for the user. */
  needsYou: boolean;
}

export interface ProjectBoard {
  groups: ProjectGroup[];
  /** "Hechas": merged and discarded tasks, newest first, at most DONE_LIMIT. */
  done: TaskRecord[];
  /** Sessions shown inside a task row (open or in "Hechas"): no row of their own. */
  taskSessionIds: Set<string>;
  /** The group keys in display order ("Otras" left out): pass back as `previousOrder`. */
  order: string[];
}

/**
 * The board: open worktree tasks and the remaining sessions per project. `sessions` are the
 * rows to show (already filtered and ordered by the caller); `allSessions` finds a task's
 * session among every session, finished ones included, so it never shows twice.
 */
export function buildProjectBoard(input: {
  sessions: readonly Session[];
  tasks: readonly TaskRecord[];
  allSessions?: readonly Session[];
  worktrees?: ReadonlyMap<string, readonly WorktreeLike[]>;
  previousOrder?: readonly string[];
  name?: (key: string) => string;
  /**
   * Running orchestrators: an orchestrator's session belongs to its project, wherever it was
   * opened (2026-10-18: one opened in ~ showed pinned in its project and again in "Otras").
   */
  orchestrators?: ReadonlyArray<{ repoPath: string; sessionId: string }>;
  /** Projects the user pinned on top (2026-10-18), the first pinned first. */
  pinned?: ReadonlyArray<{ repoPath: string; git: boolean }>;
  /** The group order the user chose (withManualOrder), among the pinned and among the rest. */
  manualOrder?: readonly string[];
  /** The order of the sessions inside their groups the user chose (withManualSessionOrder). */
  manualSessionOrder?: readonly string[];
}): ProjectBoard {
  const { sessions, worktrees = new Map(), previousOrder = [] } = input;
  const orchestrating = new Map(
    (input.orchestrators ?? []).map((entry) => [entry.sessionId, normalizeRepoPath(entry.repoPath)])
  );
  const repoKeyOf = (session: Session) => {
    const anchored = anchoredGroupKey(session);
    if (anchored !== undefined) return anchored;
    return (
      orchestrating.get(session.id) ??
      suspendedOrchestratorRepo(session) ??
      sessionRepoKeyOf(session)
    );
  };
  const name = input.name ?? ((key: string) => key.split('/').filter(Boolean).pop() ?? key);
  const board = input.tasks.filter(isBoardTask);
  const open = sortBoardTasks(board.filter((task) => !isDoneTask(task)));
  const done = sortDoneTasks(board.filter(isDoneTask)).slice(0, DONE_LIMIT);
  const taskSessionIds = new Set(
    [...open, ...done].map((task) => task.sessionId).filter(Boolean) as string[]
  );
  const loose = sessions.filter((session) => !taskSessionIds.has(session.id));

  const keys = new Set<string>();
  for (const session of loose) {
    const key = repoKeyOf(session);
    if (key) keys.add(key);
  }
  for (const task of open) {
    const key = taskRepoKey(task);
    if (key) keys.add(key);
  }
  // Pinned projects are families too: a folder or repo inside one joins it (2026-10-20).
  for (const { repoPath } of input.pinned ?? []) keys.add(normalizeRepoPath(repoPath));
  // Folders outside git, unless one holds a repo (a folder of projects). A folder inside
  // another joins it (repoFamilies).
  const folderOf = new Map<string, string>();
  for (const session of loose) {
    if (repoKeyOf(session) || anchoredGroupKey(session) !== undefined) continue;
    const folder = folderGroupKey(session);
    if (folder) folderOf.set(session.id, folder);
  }
  const folders = new Set(folderOf.values());
  for (const folder of folders) {
    const holds = (other: string) => other.startsWith(`${folder}/`);
    if ([...keys].some(holds)) folders.delete(folder);
  }
  for (const folder of folders) keys.add(folder);
  const family = repoFamilies(keys, worktrees);

  const groups = new Map<string | null, ProjectGroup>();
  const group = (key: string | null) => {
    let entry = groups.get(key);
    if (!entry) {
      entry = { key, tasks: [], sessions: [], needsYou: false };
      groups.set(key, entry);
    }
    return entry;
  };
  const activity = new Map<string, number>();
  const bump = (key: string | null, at: number) => {
    if (key !== null) activity.set(key, Math.max(activity.get(key) ?? 0, at));
  };
  for (const task of open) {
    const key = taskRepoKey(task);
    const entry = group(key ? family(key) : null);
    entry.tasks.push(task);
    if (taskWantsUser(task)) entry.needsYou = true;
    bump(entry.key, Date.parse(task.stateSince || task.createdAt) || 0);
  }
  for (const session of loose) {
    const folder = folderOf.get(session.id);
    const key = repoKeyOf(session) ?? (folder && folders.has(folder) ? folder : null);
    const entry = group(key ? family(key) : null);
    if (folder && !repoKeyOf(session) && entry.key && folders.has(entry.key)) {
      entry.folder = true;
    }
    // Anchored to a project folder outside git: a folder group (no branch, no tasks).
    if (session.groupPin?.repoPath && !session.groupPin.git && entry.key && !entry.tasks.length) {
      entry.folder = true;
    }
    entry.sessions.push(session);
    if (deriveSessionStatus(session) === 'needs-input') entry.needsYou = true;
    bump(entry.key, lastActivityAt(session) ?? 0);
  }

  // Pinned projects first, in pin order, with or without anything in them; the rest after.
  const pinnedKeys: string[] = [];
  for (const { repoPath, git } of input.pinned ?? []) {
    const key = family(normalizeRepoPath(repoPath));
    if (pinnedKeys.includes(key)) continue;
    pinnedKeys.push(key);
    const entry = group(key);
    entry.pinned = true;
    if (!git && !entry.tasks.length) entry.folder = true;
  }
  const repoKeys = [...groups.keys()].filter(
    (key): key is string => key !== null && !pinnedKeys.includes(key)
  );
  const needsYou = new Map(repoKeys.map((key) => [key, groups.get(key)?.needsYou ?? false]));
  const manual = input.manualOrder ?? [];
  const order = withManualOrder(
    stickyGroupOrder(repoKeys, { activity, needsYou, previous: previousOrder, name }),
    manual
  );
  const ordered = [...withManualOrder(pinnedKeys, manual), ...order].map(
    (key) => groups.get(key) as ProjectGroup
  );
  const others = groups.get(null);
  if (others) ordered.push(others);
  if (input.manualSessionOrder?.length) {
    for (const entry of ordered) {
      entry.sessions = withManualSessionOrder(entry.sessions, input.manualSessionOrder);
    }
  }
  return { groups: ordered, done, taskSessionIds, order };
}

/** A group a session can be anchored to (its menu's "Mover a…"). */
export interface GroupChoice {
  /** The group's key (a project's folder), null for "Otras". */
  key: string | null;
  name: string;
  /** A folder outside git. */
  folder: boolean;
}

/** What a session's group menu needs: the groups of the home and the one each session is in. */
export interface GroupMenu {
  choices: GroupChoice[];
  groupOf: Map<string, string | null>;
}

/**
 * The home's groups as anchor choices ("Otras" last, always offered) and each shown session's
 * group, from a board (buildProjectBoard).
 */
export function groupMenuOf(board: ProjectBoard, name: (key: string) => string): GroupMenu {
  const choices: GroupChoice[] = board.groups
    .filter((group): group is ProjectGroup & { key: string } => group.key !== null)
    .map((group) => ({ key: group.key, name: name(group.key), folder: group.folder === true }));
  choices.push({ key: null, name: '', folder: false });
  const groupOf = new Map<string, string | null>();
  for (const group of board.groups) {
    for (const session of group.sessions) groupOf.set(session.id, group.key);
  }
  return { choices, groupOf };
}

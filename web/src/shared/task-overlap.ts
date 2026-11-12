/**
 * Tasks of one project that change the same files (2026-11-11). 10/11 Nov: four improvements
 * of bakery started together on the same core; two of them spent 1 h 28 min and 1 h 53 min
 * on conflicts in two rounds each, with their work already done and reviewed, and Untether's
 * own tasks collided three times in a day (ui-shots.mjs, list.css, user-input-guard.ts). Each
 * task learned what the others had merged only at its own merge, all of it at once.
 *
 * The words of it, shared by the server (task-scheduler-overlap.ts) and the CLI: what
 * `ut task status` and `ut task list` show, what the project's orchestrator is told once per
 * pair, and what a working agent is told when its base moved in files it touches.
 */
import type { TaskBaseSync, TaskOverlap, TaskRecord } from './tasks.js';

/** Files kept per overlap and per pending base merge; the count says how many there are. */
export const TASK_OVERLAP_FILES_KEPT = 20;

const shortId = (id: string) => id.slice(0, 8);

/** The files of `mine` that are in `theirs` too, sorted. */
export function sharedFiles(mine: Iterable<string>, theirs: ReadonlySet<string>): string[] {
  const shared: string[] = [];
  for (const file of mine) if (theirs.has(file)) shared.push(file);
  return shared.sort();
}

/** "a.ts, b.ts (+3 more)". */
export function fileList(files: readonly string[], count = files.length, show = 5): string {
  const shown = files.slice(0, show);
  return `${shown.join(', ')}${count > shown.length ? ` (+${count - shown.length} more)` : ''}`;
}

/** `ut task status`: "1a2b3c4d «Other task»: a.ts, b.ts (+3 more)". */
export function overlapLine(overlap: TaskOverlap): string {
  return `${shortId(overlap.taskId)} «${overlap.name}»: ${fileList(overlap.files, overlap.count)}`;
}

/** `ut task list`: "touches too: 1a2b3c4d · a.ts (+3 more); 5e6f7a8b · b.ts". */
export function overlapsShort(overlaps: readonly TaskOverlap[] | undefined): string | undefined {
  if (!overlaps?.length) return undefined;
  const each = overlaps
    .slice(0, 3)
    .map((overlap) => `${shortId(overlap.taskId)} · ${fileList(overlap.files, overlap.count, 1)}`);
  const more = overlaps.length > each.length ? `; +${overlaps.length - each.length} task(s)` : '';
  return `touches too: ${each.join('; ')}${more}`;
}

/** `ut task status`: where its branch stands against its base while it works. */
export function baseSyncLines(sync: TaskBaseSync | undefined, base = 'the base'): string[] {
  if (!sync) return [];
  const lines: string[] = [];
  if (sync.merges) {
    lines.push(
      `${base} merged into it ${sync.merges}× by Untether while it worked${sync.at ? ` (up to date at ${sync.at})` : ''}`
    );
  }
  if (sync.pending) {
    const why = sync.conflict
      ? `it conflicts in ${fileList(sync.conflict.files)}: its agent was told at ${sync.conflict.toldAt} to merge ${base} and resolve it now`
      : sync.waiting === 'dirty'
        ? 'waits for a gap with nothing uncommitted in its tracked files'
        : sync.waiting === 'busy'
          ? 'waits for a gap of its agent (a tool running, or a merge of its own under way)'
          : 'goes in at the next gap of its agent (no tool running, nothing uncommitted)';
    lines.push(
      `${base} moved in files it touches (${fileList(sync.pending.files)}; merged by ${sync.pending.from.map(shortId).join(', ')}) since ${sync.pending.since}: ${why}`
    );
  }
  return lines;
}

type Named = Pick<TaskRecord, 'id' | 'name'>;
const called = (task: Named) => `${shortId(task.id)} «${task.name}»`;

/** What the project's orchestrator is told, once per pair of tasks. */
export function overlapNoticeText(
  a: Named,
  b: Named,
  files: readonly string[],
  count: number
): string {
  return `Tasks ${called(a)} and ${called(b)} both change ${fileList(files, count)}. Whichever merges second has to take in the other's work there. Untether brings a task that still works up to date as soon as the other merges (the project's baseSync), so there is usually nothing to do; if both rewrite the same code, \`ut task send\` one of them what the other does, or let one finish first. \`ut task status ${shortId(a.id)}\` shows the files.`;
}

const merger = (from: readonly Named[]) =>
  from.length === 1 ? `task ${called(from[0])}` : `tasks ${from.map(called).join(', ')}`;

/** Typed into a working agent after Untether merged its base into its branch. */
export function baseSyncMergedText(
  base: string,
  from: readonly Named[],
  shared: readonly string[],
  changed: readonly string[]
): string {
  return `[untether] ${base} moved while you work: ${merger(from)} merged and changed files you also touch (${fileList(shared)}). Untether merged ${base} into your branch just now: a clean merge, made while you ran no tool and had nothing uncommitted in tracked files; your commits are untouched. ${changed.length} file(s) changed in your folder (${fileList(changed, changed.length, 10)}): read again any of them you had open before you edit it, and build on what is there now. Nothing else to do: go on with the task.`;
}

/** Typed into a working agent whose base no longer merges cleanly into its branch. */
export function baseSyncConflictText(
  base: string,
  from: readonly Named[],
  files: readonly string[]
): string {
  return `[untether] ${base} moved while you work: ${merger(from)} merged and changed files you also touch, and merging ${base} into your branch now conflicts in:\n${files.map((file) => `- ${file}`).join('\n')}\nResolve it now, while what you are doing is fresh: commit your work in progress, run \`git merge ${base}\`, resolve the conflicts keeping what both sides meant, commit, then go on with the task. Untether changed nothing in your folder. Left for later, the same conflict comes back when you finish, with whatever merges until then on top.`;
}

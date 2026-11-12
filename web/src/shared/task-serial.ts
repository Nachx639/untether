/**
 * Tasks of one project started in series (2026-11-11, part 2 of shared/task-overlap.ts). Part 1
 * shows two tasks that change the same files and brings a working one up to date; what was
 * left depended on the orchestrator remembering to start the second after the first merged
 * (10/11 Nov: four bakery tasks on one core, 1 h 28 min and 1 h 53 min on conflicts).
 *
 * - `ut task new --after <id>[,<id>…]`: the task waits queued (its place in the line, no slot)
 *   until each of those is merged or done, then starts from a base that holds their work. One
 *   that is discarded, fails or never runs keeps it waiting: whoever it reports to is told and
 *   decides. Only tasks that exist can be named, so no chain of waits leads back to its start.
 * - `ut task new --zone <name>`, or the project's `zones` rules ("path pattern=name") matched
 *   on the paths the prompt names: two tasks of a project that share a zone never work at
 *   once, the later one waits for the earlier as with --after. Nothing is guessed: no zone
 *   named and no rule matched means no zone.
 * - `ut task new` says when its prompt names files or folders an open task of the project
 *   already changes (part 1's known files), without holding anything back.
 *
 * The words and the path matching, shared by the server (task-scheduler-queue.ts,
 * task-scheduler-overlap.ts) and the CLI.
 */
import { fileList } from './task-overlap.js';
import type { TaskOverlap, TaskRecord, TaskState, TaskWaitFor } from './tasks.js';

/** `--after` takes at most this many tasks, a task at most this many zones. */
export const TASK_AFTER_MAX = 20;
export const TASK_ZONES_MAX = 10;

/** A zone's name: a short word (letters, digits, `.`, `_`, `-`). */
const ZONE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,39}$/u;

export function isZoneName(name: string): boolean {
  return ZONE_NAME.test(name);
}

/** States a waited-for task never merges from by itself: the waiting one asks for a decision. */
export const WAIT_STOPPED_STATES: readonly TaskState[] = ['failed', 'discarded', 'missed'];

/** States in which a waited-for task's work is in the base (or its folder): nothing to wait for. */
export const WAIT_OVER_STATES: readonly TaskState[] = ['merged', 'done'];

/** An open task whose known files a new task's prompt names (`ut task new`). */
export type TaskTouch = Pick<TaskOverlap, 'taskId' | 'name' | 'files' | 'count'>;

const shortId = (id: string) => id.slice(0, 8);

// --- zones ------------------------------------------------------------------------------------

/** A project's zone rule, "web/src/client/**=client": the path pattern and the zone's name. */
export function parseZoneRule(rule: string): { pattern: string; zone: string } | null {
  const at = rule.lastIndexOf('=');
  if (at <= 0) return null;
  const pattern = rule.slice(0, at).trim().replace(/^\.\//, '');
  const zone = rule.slice(at + 1).trim();
  return pattern && isZoneName(zone) ? { pattern, zone } : null;
}

/** The pattern as a regular expression: `**` any folders, `*` and `?` within one name. */
function patternRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      // "**/" also stands for no folder at all.
      if (pattern[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += char.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether a path named in a prompt falls under a zone's pattern: the pattern matches it, it is
 * inside the folder the pattern names, or it names a folder the pattern reaches into
 * ("web/src/client" for "web/src/client/**").
 */
export function zonePatternMatches(pattern: string, named: string): boolean {
  const clean = pattern.replace(/\/+$/, '');
  if (!/[*?]/.test(clean)) return named === clean || named.startsWith(`${clean}/`);
  const expression = patternRegExp(clean);
  return expression.test(named) || expression.test(`${named}/`);
}

/** The zones a prompt falls in by the project's rules, in the rules' order. */
export function zonesNamed(prompt: string, rules: readonly string[] | undefined): string[] {
  if (!rules?.length) return [];
  const named = namedPaths(prompt);
  if (!named.length) return [];
  const zones: string[] = [];
  for (const rule of rules) {
    const parsed = parseZoneRule(rule);
    if (!parsed || zones.includes(parsed.zone)) continue;
    if (named.some((name) => zonePatternMatches(parsed.pattern, name))) zones.push(parsed.zone);
  }
  return zones;
}

// --- the paths a prompt names -----------------------------------------------------------------

const WEB_ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** What separates words in a prompt: spaces, quotes, brackets, list punctuation. */
const SEPARATORS = /[\s"'`()[\]{}<>,;:«»“”‘’|=!?]+/u;
/** A file's name on its own: "list.css", "ui-shots.mjs". */
const FILE_NAME = /^[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const PATH = /^[\w.@+~-]+(?:\/[\w.@+~*-]+)+$/;

/**
 * The files and folders a prompt names, as written: words with a `/` ("web/src/client",
 * "src/a.ts:12") and file names with an extension ("list.css"). Web addresses are no paths.
 */
export function namedPaths(prompt: string): string[] {
  const named = new Set<string>();
  for (const word of prompt.replace(WEB_ADDRESS, ' ').split(SEPARATORS)) {
    const clean = word
      .replace(/^\.\//, '')
      .replace(/[.]+$/, '')
      .replace(/(?:\/\*{1,2})+$/, '')
      .replace(/\/+$/, '');
    if (clean.length < 3 || clean.startsWith('/') || clean.startsWith('~')) continue;
    // "y/o", "s/n": no folder or file has a name that short on both sides.
    const path = clean.includes('/');
    if (path && !clean.split('/').some((part) => part.length > 2)) continue;
    if (path ? PATH.test(clean) : FILE_NAME.test(clean)) named.add(clean);
  }
  return [...named];
}

/**
 * Whether `named` (a word of namedPaths) names `file` (a path from the repository's root): the
 * file itself, by its whole path or its end ("list.css", "styles/list.css"), or a folder it
 * is in ("web/src/client", "src/client").
 */
export function namesPath(named: string, file: string): boolean {
  return (
    file === named ||
    file.endsWith(`/${named}`) ||
    file.startsWith(`${named}/`) ||
    file.includes(`/${named}/`)
  );
}

/** The files of `files` a prompt's named paths name, sorted. */
export function filesNamed(named: readonly string[], files: Iterable<string>): string[] {
  const out: string[] = [];
  for (const file of files) if (named.some((name) => namesPath(name, file))) out.push(file);
  return out.sort();
}

// --- the words --------------------------------------------------------------------------------

const called = (wait: Pick<TaskWaitFor, 'taskId' | 'name'>) =>
  `${shortId(wait.taskId)} «${wait.name}»`;

function waitEntry(wait: TaskWaitFor): string {
  const zone = wait.why === 'zone' && wait.zone ? `, zone ${wait.zone}` : '';
  return `${called(wait)} (${wait.state.replace('_', ' ')}${zone})`;
}

/** `ut task list`: "waits for 1a2b3c4d, 5e6f7a8b". */
export function waitsForShort(waits: readonly TaskWaitFor[] | undefined): string | undefined {
  if (!waits?.length) return undefined;
  const stopped = waits.some((wait) => wait.stopped) ? ' (stopped: decide)' : '';
  return `waits for ${waits.map((wait) => shortId(wait.taskId)).join(', ')}${stopped}`;
}

const mergeOrClose = (count: number) =>
  count === 1 ? 'it merges or closes' : 'they merge or close';

/** What a decision about a waiting task whose waited-for task stopped can be. */
export function stoppedChoices(
  task: Pick<TaskRecord, 'id'>,
  stopped: readonly TaskWaitFor[]
): string {
  const id = shortId(task.id);
  const failed = stopped.filter((wait) => wait.state === 'failed');
  const again = failed.length
    ? ` \`ut task retry ${shortId(failed[0].taskId)}\` tries the failed one again (this one then starts by itself once it merges);`
    : '';
  return `Decide:${again} \`ut task retry ${id} --force\` starts it now without that work; \`ut task discard ${id}\` drops it.`;
}

/** What whoever the task reports to hears when it starts waiting. */
export function waitingText(waits: readonly TaskWaitFor[]): string {
  return `Waits for ${waits.map(waitEntry).join(', ')}: it starts by itself once ${mergeOrClose(waits.length)}, from a base with that work.`;
}

/** … and when a task it waits for was discarded, failed or never ran. */
export function stoppedText(task: Pick<TaskRecord, 'id'>, waits: readonly TaskWaitFor[]): string {
  const stopped = waits.filter((wait) => wait.stopped);
  return `It waits for ${stopped.map(waitEntry).join(', ')}, which will not merge by itself: it does not start on its own. ${stoppedChoices(task, stopped)}`;
}

/** `ut task status` and `ut task new`: what a waiting task waits for and what can be done. */
export function waitsForNote(task: Pick<TaskRecord, 'id' | 'queued'>): string {
  const waits = task.queued?.waitsFor ?? [];
  if (!waits.length) return '';
  const id = shortId(task.id);
  if (waits.some((wait) => wait.stopped)) return stoppedText(task, waits);
  return `${waitingText(waits)} It keeps its place in line (${task.queued?.position ?? '?'} of ${task.queued?.of ?? '?'}) and holds no slot. 'ut task retry ${id} --force' starts it now without that work, 'ut task discard ${id}' drops it.`;
}

/** `ut task new`: the open tasks already changing what its prompt names. */
export function touchLine(task: Pick<TaskRecord, 'id'>, touch: TaskTouch): string {
  const other = shortId(touch.taskId);
  return `Touches the same as ${other} «${touch.name}» (${fileList(touch.files, touch.count)}): use --after ${other} (discard this one first: 'ut task discard ${shortId(task.id)}') or leave it running.`;
}

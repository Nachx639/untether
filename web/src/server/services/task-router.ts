/**
 * Routing a prompt typed on the home screen: does it belong to one of the repo's open tasks
 * («→ añadido a login-google · Cambiar»), is it a new task, or should we ask
 * («¿Va con X o es nueva?»)?
 *
 * Pure and cheap (runs on every submit). Only open tasks count: preparing, working, needs_you,
 * verifying, ready, failed. Merged, discarded, scheduled and missed tasks never match.
 *
 * Score per task, 0..1:
 *  - explicit mention = 1.0: the branch (`ut/login-google`), a hyphenated slug (`login-google`),
 *    or «la tarea de <title>» / «the task for <title>».
 *  - otherwise the best IDF-weighted Jaccard between the prompt's words and each field of the
 *    task (title + branch words, prompt, each follow-up, file names/folders), where IDF is over
 *    the open tasks so words every task shares weigh less;
 *    + 0.4 per file/path word that hits one of the task's files (cap 0.6);
 *    + 0.1 to the most recently active task when the prompt continues something («también»,
 *      «además», «lo de», «eso», «y que», also, as well…) and it overlaps at all.
 *  «nueva tarea», «aparte», «otra cosa», new task, separately… force a new task.
 * Decision on the best two scores s1 ≥ s2: match when s1 ≥ 0.35 and s1 − s2 ≥ 0.15; new when
 * s1 < 0.12; ask otherwise.
 */
import { normalizeForMatch } from '../../shared/name-match.js';
import type { TaskRecord } from '../../shared/tasks.js';

/** The fields routing needs; a subset of the task record, kept local on purpose. */
export interface RoutableTask {
  id: string;
  title: string;
  prompt: string;
  followUps?: readonly { text: string }[];
  branch?: string;
  files?: readonly string[];
  state: string;
  /** ms epoch or ISO string. */
  lastActivityAt?: number | string;
}

/** A task record as routing sees it; its last activity is its newest follow-up or state change. */
export function toRoutable(task: TaskRecord): RoutableTask {
  const times = [task.stateSince, task.startedAt, task.followUps[task.followUps.length - 1]?.at]
    .map((value) => (value ? Date.parse(value) : 0))
    .filter((value) => Number.isFinite(value));
  return {
    id: task.id,
    title: task.name,
    prompt: task.prompt,
    followUps: task.followUps,
    ...(task.branch ? { branch: task.branch } : {}),
    files: task.files,
    state: task.state,
    lastActivityAt: Math.max(0, ...times),
  };
}

export interface RouteScore {
  taskId: string;
  score: number;
}

export type RouteDecision =
  | { kind: 'match'; taskId: string; reason: 'explicit' | 'similar'; scores: RouteScore[] }
  | { kind: 'new'; reason: 'no-open-tasks' | 'forced-new' | 'no-match'; scores: RouteScore[] }
  | { kind: 'ask'; candidates: string[]; scores: RouteScore[] };

export const OPEN_TASK_STATES: ReadonlySet<string> = new Set([
  'preparing',
  'working',
  'needs_you',
  'paused',
  'verifying',
  'ready',
  'failed',
]);

export const MATCH_MIN = 0.35;
export const MATCH_MARGIN = 0.15;
export const NEW_BELOW = 0.12;
const FILE_HIT = 0.4;
const FILE_HIT_CAP = 0.6;
const CONTINUATION_BONUS = 0.1;
/** Candidates offered in the «¿Va con X o es nueva?» choice. */
const ASK_CANDIDATES = 3;

const STOPWORDS = new Set(
  // es
  (
    'el la los las lo un una unos unas de del al a en y e o u que se le les por para con sin ' +
    'sobre como mas pero si no ni es son ser esta estan este estos estas esto ese esa esos esas ' +
    'eso aquel ya hay muy tambien ademas mi mis tu tus su sus me te nos os porque cuando donde ' +
    'cual quien todo toda todos todas otra otro otras otros algo ahi aqui asi tarea tareas nueva ' +
    'nuevo hazlo haz hace hacer arregla arreglar anade anadir pon poner quita quitar cambia ' +
    'cambiar mira revisa revisar crea crear mete meter usa usar porfa favor ahora luego bien ' +
    'tiene tener puede puedes debe quiero queremos necesito vale ok ' +
    // en
    'the an of to in on for and or with without is are be been it its this that these those ' +
    'also too please make add fix change update remove use can could should would just now ' +
    'then so do does did my your our as at by from into about task tasks new want need some ' +
    'any all there here when where which who what how not'
  ).split(/\s+/)
);

/** Generic file stems that say nothing about which task is meant. */
const GENERIC_STEMS = new Set([
  'index',
  'main',
  'utils',
  'util',
  'types',
  'test',
  'tests',
  'readme',
  'package',
  'config',
  'app',
  'lib',
  'src',
]);

const CONTINUATION = /\b(tambien|ademas|lo de|eso|y que|also|as well|too|and also)\b/;
const FORCE_NEW =
  /\b(nueva tarea|tarea nueva|otra tarea|aparte|por separado|otra cosa|new task|separate task|separately|another task|something else)\b/;

/** Lower case, no accents, punctuation → spaces, collapsed. */
function phrase(text: string): string {
  return normalizeForMatch(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Light plural stemming so «botones»/«boton», «tests»/«test» meet. */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function routeTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of phrase(text).split(' ')) {
    if (word.length < 2 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    out.add(stem(word));
  }
  return out;
}

function branchSlug(branch: string): string {
  return branch.replace(/^ut\//, '');
}

function fileWords(files: readonly string[]): Set<string> {
  const words = new Set<string>();
  for (const file of files) {
    for (const part of file.split('/')) {
      for (const t of routeTokens(part.replace(/\.[^.]+$/, ''))) words.add(t);
    }
  }
  return words;
}

interface TaskFields {
  task: RoutableTask;
  fields: Set<string>[];
  all: Set<string>;
}

function fieldsOf(task: RoutableTask): TaskFields {
  const head = routeTokens(task.title);
  if (task.branch) for (const t of routeTokens(branchSlug(task.branch))) head.add(t);
  const fields = [head, routeTokens(task.prompt)];
  for (const f of task.followUps ?? []) fields.push(routeTokens(f.text));
  if (task.files?.length) fields.push(fileWords(task.files));
  const all = new Set<string>();
  for (const f of fields) for (const t of f) all.add(t);
  return { task, fields, all };
}

function weightedJaccard(query: Set<string>, field: Set<string>, idf: (t: string) => number) {
  let inter = 0;
  let union = 0;
  for (const t of query) {
    const w = idf(t);
    union += w;
    if (field.has(t)) inter += w;
  }
  for (const t of field) if (!query.has(t)) union += idf(t);
  return union > 0 ? inter / union : 0;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isExplicit(task: RoutableTask, text: string): boolean {
  const lower = normalizeForMatch(text);
  if (task.branch) {
    const slug = branchSlug(task.branch);
    const slugs = new Set([slug, slug.replace(/-[a-d]$/, '')]);
    for (const s of slugs) {
      if (!s) continue;
      const bounded = (p: string) => new RegExp(`(^|[^\\w/-])${p}($|[^\\w-])`).test(lower);
      if (bounded(`ut/${escapeRegExp(s)}`)) return true;
      // A one-word slug («login») is too common to count as a mention without `ut/`.
      if (s.includes('-') && bounded(escapeRegExp(s))) return true;
    }
  }
  const title = phrase(task.title);
  if (title.length >= 3) {
    const p = ` ${phrase(text)} `;
    const lead = [
      'tarea',
      'tarea de',
      'tarea del',
      'tarea sobre',
      'tarea para',
      'task',
      'task for',
    ];
    if ([...lead, 'task about', 'task on'].some((l) => p.includes(` ${l} ${title} `))) return true;
  }
  return false;
}

/** Words in the prompt that look like paths or name a task file; distinct hits. */
export function fileHits(task: RoutableTask, text: string): number {
  const files = (task.files ?? []).map((f) => normalizeForMatch(f));
  if (!files.length) return 0;
  const hits = new Set<string>();
  const raw = normalizeForMatch(text).match(/[\w./-]+/g) ?? [];
  for (const word of raw) {
    const w = word.replace(/^[./]+|[./]+$/g, '');
    if (w.length < 3) continue;
    const pathLike = w.includes('/') || /\.\w{1,6}$/.test(w);
    if (pathLike) {
      if (files.some((f) => f === w || f.endsWith(`/${w}`) || f.includes(`${w}/`))) hits.add(w);
      continue;
    }
    if (w.length < 4 || GENERIC_STEMS.has(w)) continue;
    const named = files.some((f) => {
      const base = f.slice(f.lastIndexOf('/') + 1);
      return base.replace(/\.[^.]+$/, '') === w;
    });
    if (named) hits.add(w);
  }
  return hits.size;
}

function activityMs(task: RoutableTask): number {
  const v = task.lastActivityAt;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v) || 0;
  return 0;
}

/** Scores for every open task, best first (ties keep input order). */
export function scoreTasks(text: string, openTasks: readonly RoutableTask[]): RouteScore[] {
  const tasks = openTasks.filter((t) => OPEN_TASK_STATES.has(t.state)).map(fieldsOf);
  if (!tasks.length) return [];
  const query = routeTokens(text);
  const df = new Map<string, number>();
  for (const { all } of tasks) for (const t of all) df.set(t, (df.get(t) ?? 0) + 1);
  const n = tasks.length;
  const idf = (t: string) => Math.log(1 + (n + 1) / ((df.get(t) ?? 0) + 1));

  const continuing = CONTINUATION.test(phrase(text));
  let recent: RoutableTask | undefined;
  for (const { task } of tasks) {
    if (!recent || activityMs(task) > activityMs(recent)) recent = task;
  }

  const scores = tasks.map(({ task, fields }) => {
    if (isExplicit(task, text)) return { taskId: task.id, score: 1 };
    const similarity = Math.max(...fields.map((f) => weightedJaccard(query, f, idf)));
    const hits = fileHits(task, text);
    let score = similarity + Math.min(FILE_HIT_CAP, hits * FILE_HIT);
    if (continuing && task === recent && (similarity > 0 || hits > 0)) score += CONTINUATION_BONUS;
    return { taskId: task.id, score: Math.min(1, score) };
  });
  return scores.sort((a, b) => b.score - a.score);
}

/** The thresholds alone, over scores sorted best first. */
export function decideRoute(scores: readonly RouteScore[]): RouteDecision {
  const sorted = [...scores];
  if (!sorted.length) return { kind: 'new', reason: 'no-open-tasks', scores: sorted };
  const s1 = sorted[0].score;
  const s2 = sorted[1]?.score ?? 0;
  // Small epsilon: 0.5 − 0.35 must count as a 0.15 margin despite floating point.
  const EPS = 1e-9;
  if (s1 + EPS >= MATCH_MIN && s1 - s2 + EPS >= MATCH_MARGIN) {
    return {
      kind: 'match',
      taskId: sorted[0].taskId,
      reason: s1 >= 1 ? 'explicit' : 'similar',
      scores: sorted,
    };
  }
  if (s1 < NEW_BELOW) return { kind: 'new', reason: 'no-match', scores: sorted };
  const candidates = sorted
    .filter((s) => s.score >= NEW_BELOW)
    .slice(0, ASK_CANDIDATES)
    .map((s) => s.taskId);
  return { kind: 'ask', candidates, scores: sorted };
}

/** Where a prompt typed on the home screen goes. `openTasks`: the repo's tasks (any state). */
export function route(text: string, openTasks: readonly RoutableTask[]): RouteDecision {
  const scores = scoreTasks(text, openTasks);
  if (!scores.length) return { kind: 'new', reason: 'no-open-tasks', scores };
  if (FORCE_NEW.test(phrase(text))) return { kind: 'new', reason: 'forced-new', scores };
  return decideRoute(scores);
}

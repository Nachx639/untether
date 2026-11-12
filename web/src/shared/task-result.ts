/**
 * The structured result a task's agent gives with `ut task done --result` (2026-11-01): what
 * came of it (outcome), the files it touched and why, the tests it ran with their result, the
 * risks it knows of, what is left (follow-ups) and optional measurements. Before, `ut task
 * done` took only prose (summary, verified, undo): the pipeline and the reviewer read prose,
 * and a summary cut short lost its measurements without a word.
 *
 * Validated here (shared by the server, which is the gate, and the CLI): anything missing or
 * malformed is named by its path, for the agent to complete and run `ut task done` again.
 * Used by the scheduler and the merge pipeline (outcome decides "no change", "partial" or
 * "blocked", not the prose), the AI review (what the agent says it did, against the diff),
 * the board's card, `ut task show` and the orchestrator's note.
 */

import type { TaskBlocker } from './tasks.js';

export type TaskOutcome = 'done' | 'partial' | 'blocked' | 'no-change';
export const TASK_OUTCOMES: readonly TaskOutcome[] = ['done', 'partial', 'blocked', 'no-change'];

export type TaskTestResult = 'passed' | 'failed' | 'skipped';
export const TASK_TEST_RESULTS: readonly TaskTestResult[] = ['passed', 'failed', 'skipped'];

export interface TaskResultFile {
  path: string;
  /** Why the agent touched it. */
  why: string;
}

export interface TaskResultTest {
  /** The command it ran, as typed. */
  command: string;
  result: TaskTestResult;
  /** What it printed that matters ("212 passed", the failing test). */
  detail?: string;
}

export interface TaskResultMeasurement {
  name: string;
  value: string | number;
  unit?: string;
  /** The value before the change, when it compares. */
  before?: string | number;
}

/**
 * Something future sessions of the project should know (an incident, its root cause and the
 * guard left), as a note for the project's agent memory (2026-11-03: task agents kept writing
 * into the user's Claude memory folder, the task guard blocked it and every task asked its
 * orchestrator to save it by hand). Untether saves it when the task merges, in the project's
 * memoryDir (server/services/task-memory-note.ts), or hands it to the orchestrator.
 */
export interface TaskMemoryNote {
  /** Kebab-case slug: the note's file is <name>.md (TASK_MEMORY_NAME). */
  name: string;
  /** One line: what the note is about, read to decide whether it is relevant. */
  description: string;
  /** The note itself (Markdown). */
  body: string;
}

/** A memory note's name: lower-case letters, digits and dashes, starting with a letter or digit. */
export const TASK_MEMORY_NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface TaskResult {
  outcome: TaskOutcome;
  files: TaskResultFile[];
  tests: TaskResultTest[];
  risks: string[];
  followUps: string[];
  measurements?: TaskResultMeasurement[];
  memoryNote?: TaskMemoryNote;
}

export const TASK_RESULT_LIMITS = {
  files: 200,
  tests: 50,
  risks: 30,
  followUps: 30,
  measurements: 50,
  path: 500,
  text: 1000,
  name: 200,
  unit: 40,
  memoryDescription: 300,
  memoryBody: 8000,
} as const;

/** The whole result as JSON, at most (the API rejects a bigger one). */
export const TASK_RESULT_JSON_MAX = 64_000;

/** An example the agent is shown (the task's instructions and every validation error). */
export const TASK_RESULT_EXAMPLE =
  '{"outcome":"done","files":[{"path":"src/a.ts","why":"fix the off-by-one"}],"tests":[{"command":"pnpm test","result":"passed","detail":"212 passed"}],"risks":[],"followUps":[],"measurements":[{"name":"p95 latency","value":120,"unit":"ms","before":180}]}';

/** The rules in one line, for the agent (instructions and errors). */
export const TASK_RESULT_RULES =
  'outcome is done | partial | blocked | no-change; files [{path, why}] and tests [{command, result: passed | failed | skipped, detail?}] need at least one entry when outcome is done (no-change lists no files); risks [strings] and followUps [strings] are required (may be []), and partial or blocked needs at least one followUp saying what is left or what blocks it; measurements [{name, value, unit?, before?}] is optional; memoryNote {name: kebab-case slug, description: one line, body: Markdown} is optional (what future sessions of the project should know); no other keys';

export type TaskResultValidation =
  | { ok: true; result: TaskResult }
  | { ok: false; errors: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks a result as the agent sent it (parsed JSON). Every problem is named by its path
 * ("result.files[0].why: …"); strings are trimmed.
 */
export function validateTaskResult(input: unknown): TaskResultValidation {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['result: must be a JSON object'] };
  const L = TASK_RESULT_LIMITS;
  const known = ['outcome', 'files', 'tests', 'risks', 'followUps', 'measurements', 'memoryNote'];
  for (const key of Object.keys(input)) {
    if (!known.includes(key))
      errors.push(`result.${key}: unknown key (allowed: ${known.join(', ')})`);
  }

  const outcome = input.outcome;
  const outcomeOk = typeof outcome === 'string' && TASK_OUTCOMES.includes(outcome as TaskOutcome);
  if (!outcomeOk) {
    errors.push(
      `result.outcome: ${outcome === undefined ? 'required' : 'invalid'}; one of ${TASK_OUTCOMES.join(', ')}`
    );
  }
  // Only a finished change must list its files and its tests: partial work may be an
  // investigation half done with nothing changed yet (2026-11-01 review).
  const needsWork = outcome === 'done';

  const text = (
    value: unknown,
    where: string,
    max: number,
    required = true
  ): string | undefined => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`${where}: ${value === undefined ? 'required' : 'must be a non-empty string'}`);
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
      errors.push(`${where}: at most ${max} characters (${trimmed.length})`);
      return undefined;
    }
    return trimmed;
  };
  const list = (key: string, max: number): unknown[] | undefined => {
    const value = input[key];
    if (value === undefined) {
      errors.push(`result.${key}: required (an array, [] when there is none)`);
      return undefined;
    }
    if (!Array.isArray(value)) {
      errors.push(`result.${key}: must be an array`);
      return undefined;
    }
    if (value.length > max) errors.push(`result.${key}: at most ${max} entries (${value.length})`);
    return value.slice(0, max);
  };

  const files: TaskResultFile[] = [];
  const rawFiles = list('files', L.files);
  rawFiles?.forEach((entry, i) => {
    const where = `result.files[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${where}: must be {path, why}`);
      return;
    }
    const path = text(entry.path, `${where}.path`, L.path);
    const why = text(entry.why, `${where}.why`, L.text);
    if (path && why) files.push({ path, why });
  });
  if (rawFiles && needsWork && rawFiles.length === 0) {
    errors.push(
      `result.files: list every file you changed with why (outcome ${String(outcome)} needs at least one; nothing changed: outcome no-change)`
    );
  }
  if (rawFiles && outcome === 'no-change' && rawFiles.length > 0) {
    errors.push(
      'result.files: outcome no-change lists no files (you changed some: outcome done or partial)'
    );
  }

  const tests: TaskResultTest[] = [];
  const rawTests = list('tests', L.tests);
  rawTests?.forEach((entry, i) => {
    const where = `result.tests[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${where}: must be {command, result, detail?}`);
      return;
    }
    const command = text(entry.command, `${where}.command`, L.path);
    const result = entry.result;
    const resultOk =
      typeof result === 'string' && TASK_TEST_RESULTS.includes(result as TaskTestResult);
    if (!resultOk) {
      errors.push(
        `${where}.result: ${result === undefined ? 'required' : 'invalid'}; one of ${TASK_TEST_RESULTS.join(', ')}`
      );
    }
    const detail = text(entry.detail, `${where}.detail`, L.text, false);
    if (command && resultOk) {
      tests.push({ command, result: result as TaskTestResult, ...(detail ? { detail } : {}) });
    }
  });
  if (rawTests && needsWork && rawTests.length === 0) {
    errors.push(
      `result.tests: name the commands you ran to check the work and their result (outcome ${String(outcome)} needs at least one)`
    );
  }

  const strings = (key: 'risks' | 'followUps', max: number): string[] => {
    const out: string[] = [];
    list(key, max)?.forEach((entry, i) => {
      const value = text(entry, `result.${key}[${i}]`, L.text);
      if (value) out.push(value);
    });
    return out;
  };
  const risks = strings('risks', L.risks);
  const followUps = strings('followUps', L.followUps);
  if (
    (outcome === 'partial' || outcome === 'blocked') &&
    Array.isArray(input.followUps) &&
    input.followUps.length === 0
  ) {
    errors.push(
      `result.followUps: outcome ${outcome} needs at least one: ${outcome === 'partial' ? 'what is left to do' : 'what blocks it and what you need'}`
    );
  }

  let measurements: TaskResultMeasurement[] | undefined;
  if (input.measurements !== undefined) {
    measurements = [];
    const raw = input.measurements;
    if (!Array.isArray(raw)) errors.push('result.measurements: must be an array');
    else {
      if (raw.length > L.measurements) {
        errors.push(`result.measurements: at most ${L.measurements} entries (${raw.length})`);
      }
      raw.slice(0, L.measurements).forEach((entry, i) => {
        const where = `result.measurements[${i}]`;
        if (!isObject(entry)) {
          errors.push(`${where}: must be {name, value, unit?, before?}`);
          return;
        }
        const name = text(entry.name, `${where}.name`, L.name);
        const value = scalar(entry.value, `${where}.value`, true);
        const before = scalar(entry.before, `${where}.before`, false);
        const unit = text(entry.unit, `${where}.unit`, L.unit, false);
        if (name && value !== undefined) {
          measurements?.push({
            name,
            value,
            ...(unit ? { unit } : {}),
            ...(before !== undefined ? { before } : {}),
          });
        }
      });
    }
  }

  let memoryNote: TaskMemoryNote | undefined;
  if (input.memoryNote !== undefined) {
    const raw = input.memoryNote;
    if (!isObject(raw)) errors.push('result.memoryNote: must be {name, description, body}');
    else {
      for (const key of Object.keys(raw)) {
        if (!['name', 'description', 'body'].includes(key)) {
          errors.push(`result.memoryNote.${key}: unknown key (allowed: name, description, body)`);
        }
      }
      const name = text(raw.name, 'result.memoryNote.name', L.name);
      if (name && !TASK_MEMORY_NAME.test(name)) {
        errors.push(
          'result.memoryNote.name: a kebab-case slug (lower-case letters, digits and dashes, at most 80), e.g. "flaky-check-under-load"'
        );
      }
      const description = text(
        raw.description,
        'result.memoryNote.description',
        L.memoryDescription
      );
      if (description && /[\r\n]/.test(description)) {
        errors.push('result.memoryNote.description: one line');
      }
      const body = text(raw.body, 'result.memoryNote.body', L.memoryBody);
      if (
        name &&
        TASK_MEMORY_NAME.test(name) &&
        description &&
        !/[\r\n]/.test(description) &&
        body
      ) {
        memoryNote = { name, description, body };
      }
    }
  }

  function scalar(value: unknown, where: string, required: boolean): string | number | undefined {
    if (value === undefined && !required) return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && value.trim().length <= L.name) {
      return value.trim();
    }
    errors.push(
      `${where}: ${value === undefined ? 'required' : 'must be a number or a short string'}`
    );
    return undefined;
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    result: {
      outcome: outcome as TaskOutcome,
      files,
      tests,
      risks,
      followUps,
      ...(measurements?.length ? { measurements } : {}),
      ...(memoryNote ? { memoryNote } : {}),
    },
  };
}

/** The error the agent reads: every problem, the rules and an example, to complete it. */
export function taskResultErrorMessage(errors: readonly string[]): string {
  return [
    `The result is not complete, nothing was recorded. Fix ${errors.length === 1 ? 'this' : 'these'} and run 'ut task done' again:`,
    ...errors.slice(0, 30).map((error) => `- ${error}`),
    ...(errors.length > 30 ? [`- … and ${errors.length - 30} more`] : []),
    `Rules: ${TASK_RESULT_RULES}.`,
    `Example: ${TASK_RESULT_EXAMPLE}`,
  ].join('\n');
}

/** One measurement: "p95 latency: 180 → 120 ms". */
export function measurementLine(m: TaskResultMeasurement): string {
  const unit = m.unit ? ` ${m.unit}` : '';
  return `${m.name}: ${m.before !== undefined ? `${m.before} → ` : ''}${m.value}${unit}`;
}

/** One test: "pnpm test: passed (212 passed)". */
export function testLine(test: TaskResultTest): string {
  return `${test.command}: ${test.result}${test.detail ? ` (${test.detail})` : ''}`;
}

/**
 * What the tests say, as the report's "verified" text when the agent gave none: the old
 * readers (push, card) keep working from the result.
 */
export function verifiedFromResult(result: TaskResult): string | undefined {
  return result.tests.length ? result.tests.map(testLine).join('; ') : undefined;
}

/**
 * The result in lines (the reviewer, the orchestrator's note), what matters most first: the
 * outcome, what is left, the risks, the measurements, the tests (failed first), then the files.
 * A reader that cuts it (fitResultLines) loses files, never the follow-ups or measurements
 * (2026-11-01 review: they came last and were the first to go).
 */
export function taskResultLines(result: TaskResult): string[] {
  const lines = [`outcome: ${result.outcome}`];
  for (const next of result.followUps) lines.push(`follow-up: ${next}`);
  for (const risk of result.risks) lines.push(`risk: ${risk}`);
  for (const m of result.measurements ?? []) lines.push(`measurement ${measurementLine(m)}`);
  // Its body goes apart (the merged event, `ut task status`): here only what it is about.
  if (result.memoryNote) {
    lines.push(`memory note ${result.memoryNote.name}: ${result.memoryNote.description}`);
  }
  const tests = [...result.tests].sort(
    (a, b) => Number(b.result === 'failed') - Number(a.result === 'failed')
  );
  for (const test of tests) lines.push(`test ${testLine(test)}`);
  for (const file of result.files) lines.push(`file ${file.path}: ${file.why}`);
  return lines;
}

/**
 * Whole lines from the start that fit in `max` characters (joined by `separator`), then how
 * many were left out: nothing is cut mid-line, and the cut is said.
 */
export function fitResultLines(lines: readonly string[], max: number, separator = '\n'): string {
  const kept: string[] = [];
  let size = 0;
  for (const [i, line] of lines.entries()) {
    const left = lines.length - i;
    const note = `… and ${left} more line${left === 1 ? '' : 's'} (ut task status)`;
    const next = size + (kept.length ? separator.length : 0) + line.length;
    const room = max - note.length - separator.length;
    if (next > (i === lines.length - 1 ? max : room)) {
      kept.push(kept.length ? note : `${line.slice(0, Math.max(0, max - 1))}…`);
      break;
    }
    kept.push(line);
    size = next;
  }
  return kept.join(separator);
}

/** Its agent's result says it cannot go on: what blocks it, from its follow-ups. */
export function blockedBlocker(result: TaskResult): TaskBlocker {
  return {
    kind: 'question',
    message: `The agent is blocked: ${result.followUps[0] ?? 'see its result'}`,
    ...(result.followUps.length > 1 ? { detail: result.followUps.slice(1) } : {}),
  };
}

/** Its agent's result says the work is partial: what is left, from its follow-ups. */
export function partialBlocker(result: TaskResult): TaskBlocker {
  return {
    kind: 'partial',
    message: `The agent says the work is partial; left to do: ${result.followUps[0] ?? 'see its result'}`,
    ...(result.followUps.length > 1 ? { detail: result.followUps.slice(1) } : {}),
  };
}

/** The agent says it changed nothing, yet its branch has changes: never merged on its own. */
export function saysNoChangeButChanged(
  result: TaskResult | undefined,
  hasChanges: boolean
): boolean {
  return result?.outcome === 'no-change' && hasChanges;
}

/**
 * Where what the agent says does not match its branch: it says it changed nothing but there
 * is a diff, it says it changed files but there is none, or it names files the diff does not
 * hold (or leaves out files it does). Undefined when they agree. `diffFiles` undefined: the
 * diff is not known (no check of the file lists).
 */
export function resultMismatch(
  result: TaskResult,
  hasChanges: boolean,
  diffFiles?: readonly string[],
  renamed?: readonly { from: string; to: string }[]
): string | undefined {
  if (result.outcome === 'no-change' && hasChanges) {
    return `The agent's result says no-change, but its branch has changes${diffFiles?.length ? ` (${listed(diffFiles)})` : ''}`;
  }
  if (result.outcome !== 'no-change' && result.files.length > 0 && !hasChanges) {
    return `The agent's result lists changed files (${listed(result.files.map((f) => f.path))}), but its branch has no change`;
  }
  if (!diffFiles || !hasChanges) return undefined;
  // 2026-11-02 (a7e6e180): a codemod's result named `web/src/**/*.test.ts and web/src/test/**
  // (146 more files)` and was held as naming files its diff did not change. Each entry is read
  // as the paths or patterns it names (see namedPaths); a pattern is fine once it matches a
  // changed file, a renamed file may be named by its old path, a note adds no file.
  const sources = new Map<string, string>();
  for (const r of renamed ?? []) sources.set(r.to, r.from);
  const entries = result.files.map((file) => ({ raw: file.path, ...namedPaths(file.path) }));
  const hits = (named: string, inDiff: string) =>
    pathMatches(named, inDiff) || pathMatches(named, sources.get(inDiff));
  // The whole entry first (a file whose name holds " and " or a space), else every part of it.
  const names = (entry: (typeof entries)[number]) =>
    entry.whole && diffFiles.some((d) => hits(entry.whole as string, d))
      ? [entry.whole]
      : entry.paths;
  const missing = entries
    .filter((entry) => names(entry).some((named) => !diffFiles.some((d) => hits(named, d))))
    .map((entry) => entry.raw);
  if (missing.length) {
    return `The agent's result names files its diff does not change: ${listed(missing)}`;
  }
  const unnamed = diffFiles.filter(
    (d) => !entries.some((entry) => names(entry).some((named) => hits(named, d)))
  );
  // "(12 more files)": the agent said it left that many out of its list.
  const leftOut = entries.reduce((sum, entry) => sum + entry.more, 0);
  if (unnamed.length > leftOut) {
    return `The diff changes files the agent's result does not name: ${listed(unnamed)}`;
  }
  return undefined;
}

const GLOB_CHARS = /[*?[{]/;

/**
 * The paths (or glob patterns) one entry of the result's file list names, and how many more
 * files a note in it says were left out. An entry is usually one path, but agents also write
 * `a.ts and b.ts`, `old.ts -> new.ts`, `` `src/x.ts` `` or `src/** (146 more files)`.
 */
export function namedPaths(entry: string): { paths: string[]; more: number; whole?: string } {
  let text = entry.trim();
  let more = 0;
  // Trailing notes: "(146 more files)", "(codemod)", "and 3 more".
  for (;;) {
    const paren = text.match(/^(.*\S)\s+\(([^()]*)\)$|^\(([^()]*)\)$/s);
    const plain = text.match(/^(.*?)[\s,;]*(?:\band\b|\+)?\s*(\d+)\s+more(?:\s+files?)?\.?$/is);
    if (paren) {
      const note = paren[2] ?? paren[3] ?? '';
      const count = note.match(/(\d+)\s+(?:more|others?|files?)/i);
      if (count) more += Number.parseInt(count[1], 10);
      text = (paren[1] ?? '').trim();
    } else if (plain) {
      more += Number.parseInt(plain[2], 10);
      text = plain[1].trim();
    } else break;
  }
  const whole = cleanPath(text);
  // No word in it ("…", "--"): a note, it names nothing.
  if (!/[\w*?]/.test(whole)) return { paths: [], more };
  // Split only at separators an agent writes between paths, never at a bare space (a file may
  // be "docs/setup guide.md"); commas inside `{a,b}` belong to the pattern. Every part is kept:
  // "src/a.ts and Dockerfile" names Dockerfile too.
  const parts = text
    .split(/\s*(?:,(?![^{}]*\})|;|->|=>|→)\s*|\s+(?:and|y|&|\+)\s+/)
    .map(cleanPath)
    .filter((part) => /[\w*?]/.test(part));
  return { paths: parts.length ? parts : [whole], more, whole };
}

/** A named path without quotes, `./`, `../`, Windows separators or a trailing `:`. */
function cleanPath(raw: string): string {
  let p = raw
    .trim()
    .replace(/^[`'"]+|[`'":,.;]+$/g, '')
    .replace(/\\/g, '/');
  while (p.startsWith('./') || p.startsWith('../')) p = p.replace(/^\.\.?\//, '');
  return p;
}

/**
 * Whether a path named in the result is the changed (repository-relative) file `inDiff`: the
 * same path, the path given from a subfolder (web/src/a.ts named src/a.ts) or as an absolute
 * one, a folder holding it (`web/src/test/`), or a glob pattern matching it.
 */
function pathMatches(named: string, inDiff: string | undefined): boolean {
  if (!inDiff) return false;
  // Literal first: "web/app/[slug]/page.tsx" is a file, not a character class.
  if (named === inDiff || inDiff.endsWith(`/${named}`)) return true;
  if (named.startsWith('/') && named.endsWith(`/${inDiff}`)) return true;
  if (named.endsWith('/')) {
    const dir = named.replace(/^\/+/, '');
    if (inDiff.startsWith(dir) || inDiff.includes(`/${dir}`)) return true;
  }
  if (!GLOB_CHARS.test(named)) return false;
  // A pattern that is no valid glob ("src/[z-a].ts") only matches literally (above).
  return globRegExp(named.replace(/^\/+/, ''))?.test(inDiff) ?? false;
}

/** A glob (`**`, `*`, `?`, `{a,b}`, `[ab]`) as a regex over a repository path, from any folder. */
function globRegExp(glob: string): RegExp | undefined {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        out += '(?:.*/)?';
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close < 0) out += '\\{';
      else {
        out += `(?:${glob
          .slice(i + 1, close)
          .split(',')
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
          .join('|')})`;
        i = close;
      }
    } else if (c === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close < 0) out += '\\[';
      else {
        out += `[${glob
          .slice(i + 1, close)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else out += c.replace(/[.+^$()|\]\\}]/g, '\\$&');
  }
  // From the repository root or from a subfolder (src/** named from web/).
  try {
    return new RegExp(`^(?:.*/)?${out}$`);
  } catch {
    return undefined;
  }
}

function listed(files: readonly string[]): string {
  return files.slice(0, 5).join(', ') + (files.length > 5 ? `, … (${files.length})` : '');
}

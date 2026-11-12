/**
 * Summarised test and check output for task agents (2026-11-03, opt-in per project:
 * projects.json `summarizeOutput`). A task agent that runs its tests reads their whole output,
 * and that output stays in its context for every later turn. With the setting on, the command
 * guard's PreToolUse hook (task-guard-hook.ts) rewrites a recognised test/check command (Claude
 * Code only: it reads a hook's `updatedInput`) so that:
 *
 * - it runs as written, in the same shell (a `cd` in it still holds), its stdout and stderr
 *   both going to a log in the task's folder outside git (~/.untether/agent-hooks/tasks/<id>/
 *   output/);
 * - then `untether guard-hook --summarize <log> <exit code> <kind> <label>` prints the exit code,
 *   the summary lines, the first failures in full (bounded) and the log's path;
 * - and the shell ends with the command's own exit code.
 *
 * Never changes what runs or its exit code. A short output is printed whole; a failing command
 * whose failures no parser recognised gets its last lines and every error-looking line (its
 * stderr is never hidden); a passing one gets just its summary. `UT_FULL_OUTPUT=1` in the
 * command (or in the environment) opts out for that call.
 *
 * Only node built-ins and task-guard.ts' shell reader are imported: the hook starts on every tool
 * call.
 */
import * as fs from 'fs';
import * as path from 'path';
import { tokenize, type Word } from './task-guard.js';

// ─── Recognising a test / check command ────────────────────────────────────────────────────────

export const OUTPUT_KINDS = [
  'vitest',
  'jest',
  'bun',
  'pytest',
  'go',
  'cargo',
  'tsc',
  'xcodebuild',
  'auto',
] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/** What the hook needs from the project (policy.json `summarize`). */
export interface SummarizeSettings {
  /** Where the logs go (outside git). */
  logDir: string;
  /** The command that prints the summary: the guard hook, `--summarize` is appended. */
  runner: string[];
  /** The project's own check commands (checkCommand, fastCheckCommand). */
  checks?: string[];
  /** Project patterns (regular expressions): a command that matches one is summarised too. */
  patterns?: string[];
}

/** The variable that opts a call out (`UT_FULL_OUTPUT=1 pnpm test`). */
export const FULL_OUTPUT_ENV = 'UT_FULL_OUTPUT';

const RUN_SCRIPT = /^(test|check|lint|typecheck|type-check|types|tsc|verify|ci)(:[\w:.-]+)?$/;
const XCODE_ACTIONS = new Set([
  'test',
  'build',
  'build-for-testing',
  'test-without-building',
  'analyze',
]);
export const WATCH_WORDS = new Set([
  '--watch',
  '-w',
  'watch',
  'dev',
  '--ui',
  'serve',
  '--watchAll',
]);
/** Words in front of the program that only change how it runs. */
const PREFIXES = new Set(['env', 'nice', 'time', 'timeout', 'gtimeout', 'command', 'caffeinate']);

/** A simple command's program words: past NAME=value, env/timeout and npx / pnpm exec. */
export function programWords(words: string[]): string[] {
  let rest = words;
  for (let guard = 0; guard < 6 && rest.length; guard++) {
    while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1);
    const name = path.basename(rest[0] ?? '');
    if (PREFIXES.has(name)) {
      let i = 1;
      while (i < rest.length && (rest[i].startsWith('-') || /^[A-Za-z_]\w*=/.test(rest[i]))) i++;
      if (name === 'timeout' || name === 'gtimeout') i++; // its duration
      rest = rest.slice(i);
    } else if (name === 'npx' || name === 'bunx' || name === 'pnpx') {
      let i = 1;
      while (i < rest.length && rest[i].startsWith('-')) i++;
      rest = rest.slice(i);
    } else if ((name === 'pnpm' || name === 'yarn' || name === 'npm') && rest[1] === 'exec') {
      let i = 2;
      while (i < rest.length && rest[i].startsWith('-')) i++;
      if (rest[i] === '--') i++;
      rest = rest.slice(i);
    } else if ((name === 'python' || name === 'python3') && rest[1] === '-m') {
      rest = rest.slice(2);
    } else {
      return rest;
    }
  }
  return rest;
}

/** The kind of one simple command (its words), or null when it is not a test/check run. */
export function kindOfCommand(words: string[]): OutputKind | null {
  const argv = programWords(words);
  const name = path.basename(argv[0] ?? '');
  const args = argv.slice(1);
  if (args.some((arg) => WATCH_WORDS.has(arg))) return null;
  switch (name) {
    case 'vitest':
      return 'vitest';
    case 'jest':
      return 'jest';
    case 'pytest':
    case 'py.test':
      return 'pytest';
    case 'tsc':
    case 'vue-tsc':
      return 'tsc';
    case 'go':
      return args[0] === 'test' || args[0] === 'vet' ? 'go' : null;
    case 'cargo':
      return ['test', 'nextest', 'clippy', 'check'].includes(args[0] ?? '') ? 'cargo' : null;
    case 'xcodebuild':
      return args.some((arg) => XCODE_ACTIONS.has(arg)) ? 'xcodebuild' : null;
    case 'swift':
      return args[0] === 'test' || args[0] === 'build' ? 'auto' : null;
    case 'bun':
      if (args[0] === 'test') return 'bun';
      return args[0] === 'run' && RUN_SCRIPT.test(args[1] ?? '') ? 'auto' : null;
    case 'pnpm':
    case 'npm':
    case 'yarn': {
      const rest = args.filter((arg) => !arg.startsWith('-'));
      // `pnpm --filter web run test`: the filter's value comes before the script.
      const runAt = rest.indexOf('run');
      const script = runAt >= 0 ? rest[runAt + 1] : rest[0];
      if (script === 't') return 'auto';
      return RUN_SCRIPT.test(script ?? '') ? 'auto' : null;
    }
    case 'eslint':
    case 'biome':
    case 'ruff':
    case 'mypy':
    case 'pyright':
    case 'swiftlint':
    case 'golangci-lint':
      return 'auto';
    case 'make':
      return args.some((arg) => RUN_SCRIPT.test(arg)) ? 'auto' : null;
    default:
      return null;
  }
}

const SPACES = /\s+/g;

/**
 * Whether a Bash command should run summarised, and with which parser: its kind, or null to run
 * it as it is. Left as it is: an opt-out (UT_FULL_OUTPUT=1), a pipe or a stdout redirection (the
 * agent already chose what to see), a background `&`, a watch mode, or nothing recognised.
 */
export function summarizeKind(
  command: string,
  settings: Pick<SummarizeSettings, 'checks' | 'patterns'> = {}
): OutputKind | null {
  if (!command.trim() || command.length > 20_000) return null;
  if (new RegExp(`\\b${FULL_OUTPUT_ENV}=(1|true|yes)\\b`).test(command)) return null;
  const commands: string[][] = [];
  let words: Word[] = [];
  try {
    const state = { cwd: '/', vars: {}, home: '/', nested: [] };
    for (const token of tokenize(command, state)) {
      if (token.kind === 'word') {
        words.push(token.word);
      } else if (token.kind === 'redir') {
        // `>`, `>>`, `&>`, `>|`: the output goes somewhere the agent chose. `2>&1` is not one.
        if (token.op !== '<' && token.op !== '<<<' && token.op !== '<>') return null;
      } else {
        if (token.op === '|' || token.op === '|&' || token.op === '&') return null;
        if (words.length) commands.push(words.map((word) => word.text));
        words = [];
      }
    }
  } catch {
    return null;
  }
  if (words.length) commands.push(words.map((word) => word.text));
  if (commands.some((argv) => argv.some((arg) => WATCH_WORDS.has(arg) && arg !== 'dev'))) {
    // `vitest --watch`, `tsc -w`: never ends, nothing would be printed.
    if (commands.some((argv) => kindOfCommand(argv.filter((a) => !WATCH_WORDS.has(a))) !== null))
      return null;
  }
  const kinds = commands.map((argv) => kindOfCommand(argv)).filter((kind) => kind !== null);
  if (kinds.length) return kinds.length === 1 ? kinds[0] : 'auto';
  const flat = command.replace(SPACES, ' ').trim();
  for (const check of settings.checks ?? []) {
    const wanted = check.replace(SPACES, ' ').trim();
    if (wanted && flat.includes(wanted)) return 'auto';
  }
  for (const pattern of settings.patterns ?? []) {
    try {
      if (new RegExp(pattern).test(command)) return 'auto';
    } catch {
      // checked when set
    }
  }
  return null;
}

// ─── The rewrite ───────────────────────────────────────────────────────────────────────────────

export function quote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The log's name: when, which call, and a slug of the command. */
export function logFileName(command: string, now = new Date(), unique = process.pid): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const slug =
    command
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'command';
  return `${stamp}-${unique}-${slug}.log`;
}

/** How many logs a task keeps (the oldest go first). */
export const LOGS_KEPT = 40;

/** Removes the oldest logs past `keep` (named by time, so their names sort by age). */
export function pruneLogs(dir: string, keep = LOGS_KEPT): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.log'));
  } catch {
    return;
  }
  names.sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // tried again next time
    }
  }
}

/**
 * The command, rewritten to run summarised: in the same shell (a brace group, so `cd` and
 * variables hold), everything to `log`, then the summary, then the command's own exit code
 * (`(exit N)`: the shell is not left, Claude's own lines after it still run). If the summary
 * itself fails, the log's last lines are printed instead.
 */
export function summarizedCommand(
  command: string,
  kind: OutputKind,
  log: string,
  runner: string[]
): string {
  const label = command.replace(SPACES, ' ').trim().slice(0, 120);
  const summarize = [...runner, '--summarize', '"$__ut_log"', '"$__ut_rc"', kind, quote(label)]
    .map((part, index) => (index < runner.length + 1 ? quote(part) : part))
    .join(' ');
  return [
    `__ut_log=${quote(log)}`,
    `{ ${command}`,
    `} >"$__ut_log" 2>&1`,
    '__ut_rc=$?',
    `${summarize} || { echo "[untether] full output ($__ut_rc): $__ut_log"; tail -n 80 "$__ut_log"; }`,
    '(exit $__ut_rc)',
  ].join('\n');
}

/**
 * The rewrite of a Bash call, or null to leave it: makes the log folder, prunes old logs and
 * names this call's log.
 */
export function rewriteForSummary(
  command: string,
  settings: SummarizeSettings,
  now = new Date()
): string | null {
  const kind = summarizeKind(command, settings);
  if (!kind) return null;
  try {
    fs.mkdirSync(settings.logDir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  pruneLogs(settings.logDir, LOGS_KEPT - 1);
  const unique = `${process.pid}${Math.floor(Math.random() * 1000)}`;
  const log = path.join(settings.logDir, logFileName(command, now, Number(unique)));
  return summarizedCommand(command, kind, log, settings.runner);
}

// ─── Parsers ───────────────────────────────────────────────────────────────────────────────────

/** A failure: its lines, and where it starts in the log (1-based). */
export interface Failure {
  line: number;
  lines: string[];
}

export interface Parsed {
  summary: string[];
  failures: Failure[];
}

export type Parser = (lines: string[]) => Parsed | null;

/** ANSI colours and cursor codes, and a line's progress redraws (`\r`): the last one stays. */
export function cleanLines(text: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters
  const plain = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
  return plain.split('\n').map((line) => {
    const cut = line.replace(/\r+$/, '');
    const at = cut.lastIndexOf('\r');
    return at >= 0 ? cut.slice(at + 1) : cut;
  });
}

/** Blocks that start at a line `start` matches and end before the next start or an `end`. */
function blocks(
  lines: string[],
  start: (line: string) => boolean,
  end: (line: string) => boolean,
  from = 0,
  to = lines.length
): Failure[] {
  const out: Failure[] = [];
  let current: Failure | null = null;
  for (let i = from; i < to; i++) {
    const line = lines[i];
    if (start(line)) {
      if (current) out.push(current);
      current = { line: i + 1, lines: [line] };
    } else if (current && end(line)) {
      out.push(current);
      current = null;
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push(current);
  return out.map((failure) => ({ ...failure, lines: trimBlank(failure.lines) }));
}

function trimBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 1 && !lines[end - 1].trim()) end--;
  return lines.slice(0, end);
}

function matching(lines: string[], pattern: RegExp, max = 12): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (pattern.test(line)) out.push(line.trim());
    if (out.length >= max) break;
  }
  return out;
}

const VITEST_SEP = /^\s*⎯{3,}/;

export const parseVitest: Parser = (lines) => {
  if (!lines.some((line) => /^\s*(Test Files\s|RUN\s+v\d)/.test(line))) return null;
  const summary = matching(lines, /^\s*(Test Files|Tests|Type Errors|Errors|Duration)\s{2,}\S/);
  // The detail of each failure, after "⎯⎯ Failed Tests N ⎯⎯", and the unhandled errors.
  const detail = lines.findIndex((line) => /⎯\s*(Failed Tests|Failed Suites|Unhandled)/.test(line));
  const unhandled = (line: string) => /⎯\s*Unhandled (Error|Rejection)/.test(line);
  const failures = blocks(
    lines,
    (line) => /^\s*FAIL\s+\S/.test(line) || unhandled(line),
    (line) => (VITEST_SEP.test(line) && !unhandled(line)) || /^\s*Test Files\s/.test(line),
    Math.max(0, detail)
  );
  return { summary, failures };
};

export const parseJest: Parser = (lines) => {
  if (!lines.some((line) => /^Test Suites:\s/.test(line))) return null;
  const summary = matching(lines, /^(Test Suites|Tests|Snapshots|Time):\s/);
  const failures = blocks(
    lines,
    (line) => /^\s{2}● (?!Console)/.test(line),
    (line) => /^(PASS|FAIL)\s|^Test Suites:|^\s{2}● Console/.test(line)
  );
  return { summary, failures };
};

export const parseBun: Parser = (lines) => {
  if (!lines.some((line) => /^\s*\d+ (pass|fail)$/.test(line) || line.startsWith('bun test v')))
    return null;
  const summary = matching(
    lines,
    /^\s*\d+ (pass|fail|skip|todo|snapshots?|expect\(\) calls)\b|^Ran \d+ tests?/
  );
  // Bun prints a failing test's error before its "(fail) name" line.
  const failures: Failure[] = [];
  let since = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\((pass|skip|todo)\)/.test(line) || /^\S.*\.(test|spec)\.[cm]?[jt]sx?:$/.test(line)) {
      since = i + 1;
    } else if (line.startsWith('(fail)')) {
      const start = Math.max(since, i - 60);
      failures.push({ line: start + 1, lines: trimBlank([line, ...lines.slice(start, i)]) });
      since = i + 1;
    }
  }
  return { summary, failures };
};

export const parsePytest: Parser = (lines) => {
  let last = lines.length - 1;
  const final = /^=+ .*\b(passed|failed|error|errors|skipped|no tests ran)\b.* in [\d.]+s.* =+$/;
  while (last >= 0 && !final.test(lines[last])) last--;
  if (last < 0 && !lines.some((line) => /^=+ test session starts =+$/.test(line))) return null;
  const summary = [
    ...matching(lines, /^(FAILED|ERROR) \S+/, 10),
    ...(last >= 0 ? [lines[last].trim()] : []),
  ];
  const section = lines.findIndex((line) => /^=+ (FAILURES|ERRORS) =+$/.test(line));
  const failures =
    section < 0
      ? []
      : blocks(
          lines,
          (line) => /^_{3,} .+ _{3,}$/.test(line),
          (line) => /^=+ .+ =+$/.test(line),
          section + 1
        );
  return { summary, failures };
};

export const parseGo: Parser = (lines) => {
  if (!lines.some((line) => /^(--- FAIL:|ok\s+\S+\s|FAIL\s+\S+\s|=== RUN\s|PASS$)/.test(line)))
    return null;
  const summary = matching(lines, /^(ok|FAIL)\s+\S+\s+(\(cached\)|[\d.]+s)|^FAIL$|^PASS$/, 20);
  const failures = blocks(
    lines,
    // Top level only: a subtest's "    --- FAIL:" stays inside its parent.
    (line) => line.startsWith('--- FAIL:') || line.startsWith('panic: '),
    (line) => /^(=== |--- (PASS|SKIP)|ok\s|FAIL\s|FAIL$|PASS$)/.test(line)
  );
  return { summary, failures };
};

export const parseCargo: Parser = (lines) => {
  if (!lines.some((line) => /^test result: |^running \d+ tests?$|^\s*Compiling \S+ v/.test(line)))
    return null;
  const summary = matching(lines, /^test result: |^error: (test failed|could not compile)/, 12);
  const tests = blocks(
    lines,
    (line) => /^---- .+ stdout ----$/.test(line),
    (line) => /^(failures:|test result: )/.test(line)
  );
  const compile = blocks(
    lines,
    (line) => /^error(\[E\d+\])?: (?!test failed|could not compile)/.test(line),
    (line) => !line.trim()
  );
  return { summary, failures: [...compile, ...tests] };
};

const TSC_ERROR = /^(\S.*?)(\(\d+,\d+\):|:\d+:\d+ -) error TS\d+:/;

export const parseTsc: Parser = (lines) => {
  if (!lines.some((line) => TSC_ERROR.test(line) || /^Found \d+ errors?\b/.test(line))) return null;
  const found = matching(lines, /^Found \d+ errors?\b/, 1);
  const count = lines.filter((line) => TSC_ERROR.test(line)).length;
  const summary = found.length ? found : [`${count} TypeScript error${count === 1 ? '' : 's'}`];
  const failures = blocks(
    lines,
    (line) => TSC_ERROR.test(line),
    (line) => /^\S/.test(line) && !TSC_ERROR.test(line) && !/^\d+\s/.test(line)
  ).map((failure) => ({ ...failure, lines: failure.lines.slice(0, 12) }));
  return { summary, failures };
};

const XCODE_ERROR =
  /^(\/\S.*?):\d+(:\d+)?: (error|fatal error): |^Test Case '.*' failed|^✘ Test .* (recorded an issue|failed)/;
/** What follows an error: the compiler's code frame, the test case's verdict. */
const XCODE_MORE = /^\s*\d*\s*\||^Test Case '.*' failed/;

export const parseXcodebuild: Parser = (lines) => {
  if (
    !lines.some((line) =>
      /^\*\* (BUILD|TEST|ANALYZE|CLEAN) (SUCCEEDED|FAILED|INTERRUPTED) \*\*|^Test Suite '.*' (started|passed|failed)|^Command line invocation:|^[✔✘] Test run with/.test(
        line
      )
    )
  )
    return null;
  const summary = matching(
    lines,
    /^\*\* \w+ (SUCCEEDED|FAILED|INTERRUPTED) \*\*|^[✔✘] Test run with/,
    8
  );
  // "Executed N tests" is printed per suite: the last one is the whole run's.
  const executed = lines.filter((line) => /^\s*Executed \d+ tests?, with/.test(line)).pop();
  if (executed) summary.push(executed.trim());
  for (const header of [
    'Failing tests:',
    'Testing failed:',
    'The following build commands failed:',
  ]) {
    const at = lines.findIndex((line) => line === header);
    if (at < 0) continue;
    summary.push(header);
    for (let i = at + 1; i < lines.length && /^\s+\S/.test(lines[i]) && i <= at + 10; i++) {
      summary.push(`  ${lines[i].trim()}`);
    }
  }
  const failures: Failure[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!XCODE_ERROR.test(lines[i])) continue;
    const block = [lines[i]];
    let j = i + 1;
    while (j < lines.length && j < i + 16 && XCODE_MORE.test(lines[j])) {
      block.push(lines[j]);
      j++;
    }
    // xcodebuild repeats an error (its summary, another architecture): shown once.
    if (!seen.has(lines[i])) failures.push({ line: i + 1, lines: trimBlank(block) });
    seen.add(lines[i]);
    i = j - 1;
  }
  return { summary, failures };
};

export const PARSERS: Record<Exclude<OutputKind, 'auto'>, Parser> = {
  vitest: parseVitest,
  jest: parseJest,
  bun: parseBun,
  pytest: parsePytest,
  go: parseGo,
  cargo: parseCargo,
  tsc: parseTsc,
  xcodebuild: parseXcodebuild,
};

const ERRORISH = /\bFAIL(ED|URE)?\b|\bError\b|\berror(\[\w+\])?:|\bERR!|\bERROR\b|ELIFECYCLE|✗|✘|×/;

/** The generic fallback: lines that look like errors (outside the tail), with their place. */
export function errorLines(lines: string[], before: number, max = 30): Failure[] {
  const out: Failure[] = [];
  for (let i = 0; i < before && out.length < max; i++) {
    if (ERRORISH.test(lines[i])) out.push({ line: i + 1, lines: [lines[i]] });
  }
  return out;
}

// ─── The summary ───────────────────────────────────────────────────────────────────────────────

export const SUMMARY_LIMITS = {
  /** An output this short is printed whole. */
  wholeLines: 40,
  /** Failures shown in full. */
  failures: 3,
  /** Lines of failures, all of them together. */
  failureLines: 150,
  /** Lines of one failure. */
  oneFailureLines: 70,
  /** The tail of a failing command no parser understood. */
  tailLines: 60,
  /** A printed line's length. */
  lineChars: 400,
};

function clip(line: string): string {
  const max = SUMMARY_LIMITS.lineChars;
  return line.length > max ? `${line.slice(0, max)}… (${line.length - max} more chars)` : line;
}

export interface SummaryInput {
  output: string;
  exitCode: number;
  kind: OutputKind;
  label: string;
  log: string;
}

/** The parsers to try: the command's own first, then those its output looks like. */
function parsedOutput(lines: string[], kind: OutputKind): Parsed {
  const order = (
    kind === 'auto'
      ? Object.keys(PARSERS)
      : [kind, ...Object.keys(PARSERS).filter((k) => k !== kind)]
  ) as Array<keyof typeof PARSERS>;
  const merged: Parsed = { summary: [], failures: [] };
  for (const name of order) {
    const parsed = PARSERS[name](lines);
    if (!parsed) continue;
    for (const line of parsed.summary)
      if (!merged.summary.includes(line)) merged.summary.push(line);
    for (const failure of parsed.failures) {
      if (!merged.failures.some((other) => other.line === failure.line))
        merged.failures.push(failure);
    }
  }
  merged.failures.sort((a, b) => a.line - b.line);
  return merged;
}

/** What the agent reads instead of the whole output. */
export function summarizeOutput(input: SummaryInput): string {
  const lines = trimBlank(cleanLines(input.output));
  const count = lines.length === 1 && !lines[0].trim() ? 0 : lines.length;
  const failed = input.exitCode !== 0;
  const status = failed ? `FAILED, exit code ${input.exitCode}` : 'passed, exit code 0';
  const out: string[] = [];
  const head = `[untether] \`${input.label}\`: ${status} · ${count} lines`;
  if (count <= SUMMARY_LIMITS.wholeLines) {
    // Nothing to cut: the whole output.
    out.push(...lines.filter((_, i) => count > 0 || i > 0).map(clip));
    out.push(`${head} (whole output above; also in ${input.log})`);
    return `${out.join('\n')}\n`;
  }
  const parsed = parsedOutput(lines, input.kind);
  out.push(`${head} · full output: ${input.log}`);
  if (parsed.summary.length) {
    out.push('Summary:');
    for (const line of parsed.summary.slice(0, 25)) out.push(`  ${clip(line)}`);
  }
  if (!failed) {
    if (!parsed.summary.length) {
      out.push('Last lines:');
      for (const line of lines.filter((l) => l.trim()).slice(-5)) out.push(`  ${clip(line)}`);
    }
    return `${out.join('\n')}\n`;
  }
  let budget = SUMMARY_LIMITS.failureLines;
  const shown = parsed.failures.slice(0, SUMMARY_LIMITS.failures);
  shown.forEach((failure, index) => {
    if (budget <= 0) return;
    const take = Math.min(failure.lines.length, SUMMARY_LIMITS.oneFailureLines, budget);
    out.push(`── Failure ${index + 1} of ${parsed.failures.length} (log line ${failure.line}) ──`);
    for (const line of failure.lines.slice(0, take)) out.push(clip(line));
    if (take < failure.lines.length)
      out.push(`… ${failure.lines.length - take} more lines of this failure in the log`);
    budget -= take;
  });
  if (parsed.failures.length > shown.length) {
    out.push(
      `… ${parsed.failures.length - shown.length} more failures (log lines ${parsed.failures
        .slice(shown.length, shown.length + 10)
        .map((failure) => failure.line)
        .join(', ')}${parsed.failures.length - shown.length > 10 ? ', …' : ''})`
    );
  }
  if (!parsed.failures.length) {
    // No failure recognised: never hide what went wrong. Error-looking lines, then the tail.
    const tailFrom = Math.max(0, lines.length - SUMMARY_LIMITS.tailLines);
    const errors = errorLines(lines, tailFrom);
    if (errors.length) {
      out.push('Error lines:');
      for (const error of errors) out.push(`  ${error.line}: ${clip(error.lines[0])}`);
    }
    out.push(`── Last ${lines.length - tailFrom} lines ──`);
    for (const line of lines.slice(tailFrom)) out.push(clip(line));
  }
  out.push(
    `More: sed -n '<from>,<to>p' ${input.log} · grep -n 'FAIL\\|Error' ${input.log} · or run again with ${FULL_OUTPUT_ENV}=1 in front for the whole output`
  );
  return `${out.join('\n')}\n`;
}

/**
 * `--summarize <log> <exit code> <kind> <label>`: prints the summary (or, with UT_FULL_OUTPUT=1
 * in the environment, the whole log). Exit 0 whatever the command's code (the shell gives that).
 */
export function summarizeMain(
  args: string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
  env: NodeJS.ProcessEnv = process.env
): number {
  const [log = '', code = '', kind = 'auto', label = ''] = args;
  let output: string;
  try {
    output = fs.readFileSync(log, 'utf8');
  } catch (error) {
    write(`[untether] could not read the output log ${log}: ${String(error)}\n`);
    return 1;
  }
  const exitCode = Number.parseInt(code, 10);
  if (/^(1|true|yes)$/.test(env[FULL_OUTPUT_ENV] ?? '')) {
    write(output.endsWith('\n') || !output ? output : `${output}\n`);
    write(`[untether] exit code ${code} · also in ${log}\n`);
    return 0;
  }
  write(
    summarizeOutput({
      output,
      exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
      kind: (OUTPUT_KINDS as readonly string[]).includes(kind) ? (kind as OutputKind) : 'auto',
      label: label || 'command',
      log,
    })
  );
  return 0;
}

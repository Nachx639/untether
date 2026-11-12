/**
 * Heavy check runs started by a task's agent take a check slot (2026-11-10).
 *
 * Several tasks of bakery at once: each agent ran scripts/check.sh while it worked, on top
 * of Untether's own verification runs, and the 12-core Mac reached a load of 250; blocks with
 * a time limit failed by load, and each task spent rounds and budget running them again. The
 * same day in untether: load 100-250, tests ending in "Hook timed out". Untether's own checks
 * already ran in a slot (task-verify.ts checkLimiter: checkLoad.maxConcurrent per Mac, none
 * while the load is over checkLoad.maxLoadPerCore); the agents' runs did not.
 *
 * The command guard's PreToolUse hook (task-guard-hook.ts) recognises a heavy run (`heavyCheck`:
 * the project's checkCommand or relatedTestCommand, a whole test suite, scripts/check.sh) and
 * rewrites the Bash call (Claude Code, `updatedInput`) so that its shell takes a slot first
 * (`ut check-slot acquire`, check-slot-cli.ts: it waits its turn and says so), runs the
 * command as written, and gives the slot back. A run focused on a few files does not wait.
 * Codex does not read `updatedInput`: its heavy run is refused once with the command to use
 * instead (`ut check-slot run -- …`).
 *
 * A run that is a check and nothing else (`onlyCheck`) says so when it asks for its slot
 * (`--command`): when the same command passed on the very same files before, it is not run
 * again (check-results.ts; `acquire` ends with SLOT_REUSED_EXIT and says so), and its own pass
 * is kept when it ends with exit code 0.
 *
 * Only node built-ins, task-guard.ts' shell reader and task-output.ts' helpers are imported:
 * the hook starts on every tool call.
 */
import * as path from 'path';
import { tokenize } from './task-guard.js';
import { programWords, quote, WATCH_WORDS } from './task-output.js';

/**
 * Set (to the ticket's id) for a command that runs in a check slot: a `ut check-slot run`
 * inside it runs at once instead of waiting for a second slot. Untether's own verification
 * runs carry it too (task-verify.ts runCheck).
 */
export const CHECK_SLOT_ENV = 'UNTETHER_CHECK_SLOT';

/** `ut check-slot acquire` ends with this when the run is not to be made (a kept pass). */
export const SLOT_REUSED_EXIT = 10;

/** A test run that names at most this many files or filters is focused: it does not wait. */
export const FOCUSED_MAX = 3;

/** What the hook needs from the project (policy.json `checkSlot`). */
export interface CheckSlotSettings {
  /** The Untether CLI of the running server: `<cli> check-slot …`. */
  cli: string[];
  /** The project's whole check (checkCommand). */
  checks?: string[];
  /** The project's relatedTestCommand, with its `{files}` placeholder. */
  related?: string;
  /**
   * 'wrap' (Claude Code): the call is rewritten. 'ask' (Codex, which does not read a hook's
   * updatedInput): the call is refused with the command to run instead.
   */
  mode: 'wrap' | 'ask';
}

const SPACES = /\s+/g;
const HEAVY_SCRIPT = /^(t|test(:[\w:.-]+)?|check|ci|verify)$/;
const CHECK_SCRIPT_FILE = /^(check|ci|test|verify)\.sh$/;
const TEST_RUNNERS = new Set(['vitest', 'jest', 'pytest', 'py.test']);
/** Flags of test runners and package managers whose next word is their value. */
const VALUE_FLAGS = new Set([
  '-t',
  '--testNamePattern',
  '-c',
  '--config',
  '--project',
  '--reporter',
  '--pool',
  '--maxWorkers',
  '--minWorkers',
  '--root',
  '--dir',
  '--shard',
  '--environment',
  '--outputFile',
  '--testTimeout',
  '--hookTimeout',
  '--bail',
  '--retry',
  '-k',
  '-m',
  '-n',
  '-p',
  '-o',
  '--rootdir',
  '--filter',
  '-F',
  '-C',
  '--prefix',
  '--cwd',
]);

/** The words that are neither flags nor a flag's value. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') continue;
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

type Weight = 'heavy' | 'focused' | null;

const byCount = (count: number): Weight =>
  count > 0 && count <= FOCUSED_MAX ? 'focused' : 'heavy';

/**
 * One simple command (its words): 'heavy' for a whole test suite or check, 'focused' for a
 * test run that names a few files or filters, null for anything else.
 */
export function weightOfCommand(words: string[]): Weight {
  const argv = programWords(words);
  const name = path.basename(argv[0] ?? '');
  const args = argv.slice(1);
  if (!name || args.some((arg) => WATCH_WORDS.has(arg))) return null;
  if (CHECK_SCRIPT_FILE.test(name)) return 'heavy';
  switch (name) {
    case 'bash':
    case 'sh':
    case 'zsh': {
      const script = args.find((arg) => !arg.startsWith('-'));
      return script && CHECK_SCRIPT_FILE.test(path.basename(script)) ? 'heavy' : null;
    }
    case 'vitest':
    case 'jest': {
      const rest = positionals(args);
      if (rest[0] === 'bench' || rest[0] === 'list' || rest[0] === 'init') return null;
      if (rest[0] === 'run' || rest[0] === 'related') rest.shift();
      return byCount(rest.length);
    }
    case 'pytest':
    case 'py.test':
      return byCount(positionals(args).length);
    case 'bun':
      if (args[0] === 'test') return byCount(positionals(args.slice(1)).length);
      if (args[0] === 'run' && HEAVY_SCRIPT.test(args[1] ?? '')) {
        return byCount(positionals(args.slice(2)).length);
      }
      return null;
    case 'pnpm':
    case 'npm':
    case 'yarn': {
      // The script: the first word that is not a flag, a flag's value or `run`.
      let at = 0;
      for (; at < args.length; at++) {
        const arg = args[at];
        if (arg.startsWith('-')) {
          if (!arg.includes('=') && VALUE_FLAGS.has(arg)) at++;
          continue;
        }
        if (arg !== 'run' && arg !== 'run-script') break;
      }
      const script = args[at];
      if (!script) return null;
      const after = args.slice(at + 1);
      if (TEST_RUNNERS.has(script)) return weightOfCommand([script, ...after]);
      return HEAVY_SCRIPT.test(script) ? byCount(positionals(after).length) : null;
    }
    case 'go': {
      if (args[0] !== 'test') return null;
      const packages = positionals(args.slice(1));
      return !packages.length || packages.some((pkg) => pkg.includes('...')) ? 'heavy' : 'focused';
    }
    case 'cargo': {
      if (args[0] !== 'test' && args[0] !== 'nextest') return null;
      const rest = positionals(args.slice(1));
      if (args[0] === 'nextest' && rest[0] === 'run') rest.shift();
      return rest.length ? 'focused' : 'heavy';
    }
    case 'xcodebuild':
      if (!args.some((arg) => ['test', 'build-for-testing', 'test-without-building'].includes(arg)))
        return null;
      return args.some((arg) => arg.startsWith('-only-testing')) ? 'focused' : 'heavy';
    case 'swift':
      if (args[0] !== 'test') return null;
      return args.includes('--filter') ? 'focused' : 'heavy';
    case 'make':
      return args.some((arg) => /^(test|check|ci|verify)$/.test(arg)) ? 'heavy' : null;
    default:
      return null;
  }
}

/** The project's relatedTestCommand in `flat`: how many files it names there; null: not in it. */
function relatedFiles(flat: string, template: string): number | null {
  const [before = '', after = ''] = template.split('{files}');
  const prefix = before.replace(SPACES, ' ').trim();
  if (!prefix) return null;
  const at = flat.indexOf(prefix);
  if (at < 0) return null;
  const rest = flat.slice(at + prefix.length).split(/[|;&<>]/)[0];
  const suffix = new Set(after.replace(SPACES, ' ').trim().split(' ').filter(Boolean));
  // `2>&1` cut at its `>` leaves a bare "2": not a file.
  return positionals(rest.trim().split(' ').filter(Boolean)).filter(
    (word) => !suffix.has(word) && !/^\d+$/.test(word)
  ).length;
}

/**
 * Whether a Bash command is a heavy check run that takes a slot: the project's checkCommand or
 * its relatedTestCommand over more than a few files, a whole test suite (`pnpm run test`,
 * `vitest run` without a filter, `scripts/check.sh`…), also behind a pipe or a redirection.
 * Not: a run focused on a few files, a watch mode, a background `&` (its shell ends before the
 * run does, so nothing would hold the slot), or one that goes through `check-slot` already.
 */
export function heavyCheck(
  command: string,
  settings: Pick<CheckSlotSettings, 'checks' | 'related'> = {}
): boolean {
  if (!command.trim() || command.length > 20_000) return false;
  const commands: string[][] = [];
  let words: string[] = [];
  try {
    const state = { cwd: '/', vars: {}, home: '/', nested: [] };
    // The word after a redirection is its file, not an argument (`pnpm test > out.log`).
    let target = false;
    for (const token of tokenize(command, state)) {
      if (token.kind === 'word') {
        if (!target) words.push(token.word.text);
        target = false;
      } else if (token.kind === 'redir') {
        target = true;
      } else {
        target = false;
        if (token.op === '&') return false;
        if (words.length) commands.push(words);
        words = [];
      }
    }
  } catch {
    return false;
  }
  if (words.length) commands.push(words);
  // Goes through a slot already: `<cli> check-slot …` run as a program (2026-11-10 review: the
  // word anywhere, in a comment or an echo, let a heavy run skip the slot).
  const throughSlot = (argv: string[]) => {
    const [program = '', sub] = programWords(argv);
    return sub === 'check-slot' && /^(ut|untether(-dev)?)$/.test(path.basename(program));
  };
  if (commands.some(throughSlot)) return false;
  const weights = commands.map((argv) => weightOfCommand(argv));
  if (weights.includes('heavy')) return true;
  const flat = command.replace(SPACES, ' ').trim();
  if (settings.related) {
    const files = relatedFiles(flat, settings.related);
    if (files !== null) return byCount(files) === 'heavy';
  }
  if (weights.includes('focused')) return false;
  return (settings.checks ?? []).some((check) => {
    const wanted = check.replace(SPACES, ' ').trim();
    return !!wanted && flat.includes(wanted);
  });
}

/**
 * Whether `command` is a check and nothing else, so that a kept pass can stand for running it
 * and its exit code is the check's: test or check runs (or the project's own check, written
 * exactly), joined by `&&`, with `cd` in front and parentheses at most. Not: a pipe (the exit
 * code would be the filter's), `;` or `||` (a failure could end in 0), output sent to a file
 * (something reads it afterwards), a word the shell computes, or any other command (skipping
 * it would lose what it does).
 */
export function onlyCheck(
  command: string,
  settings: Pick<CheckSlotSettings, 'checks'> = {}
): boolean {
  const flat = command.replace(SPACES, ' ').trim();
  if (!flat || command.length > 20_000) return false;
  if ((settings.checks ?? []).some((check) => check.replace(SPACES, ' ').trim() === flat)) {
    return true;
  }
  const commands: string[][] = [];
  let words: string[] = [];
  try {
    const state = { cwd: '/', vars: {}, home: '/', nested: [] };
    let target = false;
    for (const token of tokenize(command.trim(), state)) {
      if (token.kind === 'word') {
        if (token.word.dynamic) return false;
        if (target) {
          if (token.word.text !== '/dev/null') return false;
        } else {
          words.push(token.word.text);
        }
        target = false;
      } else if (token.kind === 'redir') {
        if (token.op.includes('<')) return false;
        target = true;
      } else {
        if (target) return false;
        if (token.op !== '&&' && token.op !== '(' && token.op !== ')') return false;
        if (words.length) commands.push(words);
        words = [];
      }
    }
    if (target) return false;
  } catch {
    return false;
  }
  if (words.length) commands.push(words);
  let checks = 0;
  for (const argv of commands) {
    if (argv[0] === 'cd' && argv.length === 2) continue;
    if (weightOfCommand(argv) === null) return false;
    checks++;
  }
  return checks > 0;
}

/** What the slot is asked for, as its holder shows it. */
export function slotLabel(command: string): string {
  return command.replace(SPACES, ' ').trim().slice(0, 120);
}

/**
 * `body` (the command as written, or its summarised form) run in a check slot, in the same
 * shell (a brace group: `cd` and variables hold): the shell takes the slot (`acquire` waits and
 * says so on stderr, and prints the ticket; none when the server cannot be asked: the command
 * runs anyway), runs the body, gives the slot back and ends with the body's own exit code. A
 * shell that ends before the release (an `exit` in the body, a timeout) frees it too: the
 * server watches the shell's pid.
 *
 * `reusable` (the command is a check and nothing else, `onlyCheck`): `acquire` is told the
 * command; when it ends with SLOT_REUSED_EXIT the same command passed on these very files and
 * the body is not run (said on stderr, exit code 0); else the release carries the exit code,
 * so a pass is kept for the next time.
 */
export function slotCommand(
  body: string,
  command: string,
  cli: string[],
  reusable = false
): string {
  const ut = cli.map(quote).join(' ');
  const acquire = `${ut} check-slot acquire --pid $$ --label ${quote(slotLabel(command))}`;
  if (!reusable) {
    return [
      `__ut_slot=$(${acquire})`,
      `[ -n "$__ut_slot" ] && export ${CHECK_SLOT_ENV}="$__ut_slot"`,
      `{ ${body}`,
      '}',
      '__ut_slot_rc=$?',
      `[ -n "$__ut_slot" ] && { ${ut} check-slot release "$__ut_slot"; unset ${CHECK_SLOT_ENV}; }`,
      '(exit $__ut_slot_rc)',
    ].join('\n');
  }
  return [
    `__ut_slot=$(${acquire} --command ${quote(command.trim())})`,
    `if [ $? -eq ${SLOT_REUSED_EXIT} ]; then __ut_slot_rc=0; else`,
    `[ -n "$__ut_slot" ] && export ${CHECK_SLOT_ENV}="$__ut_slot"`,
    `{ ${body}`,
    '}',
    '__ut_slot_rc=$?',
    `[ -n "$__ut_slot" ] && { ${ut} check-slot release "$__ut_slot" --exit "$__ut_slot_rc"; unset ${CHECK_SLOT_ENV}; }`,
    'fi',
    '(exit $__ut_slot_rc)',
  ].join('\n');
}

/** What a Codex agent is told instead of running a heavy check outside a slot. */
export function slotAskText(command: string, cli: string[]): string {
  const ut = cli.map(quote).join(' ');
  // One argument: `run` hands it to sh -c, and knows the command it is (a kept pass of the same
  // check on the same files stands for it).
  return `Untether runs heavy checks one slot at a time on this Mac (several at once made them fail by load). Run it through the slot, it waits its turn and then runs the same command:\n  ${ut} check-slot run -- ${quote(command)}\n`;
}

/**
 * The command guard of task agents (2026-11-02). Task agents run with
 * --dangerously-skip-permissions (Claude) or --dangerously-bypass-approvals-and-sandbox (Codex) so
 * they never stop on a prompt nobody sees; until now nothing stopped a destructive command outside
 * their worktree. A PreToolUse hook, only on the sessions Untether starts for a task
 * (task-guard-setup.ts), asks this module about every tool call and blocks, with the reason told
 * to the agent (never a question to the user):
 *
 *   delete-outside   rm / rmdir / unlink / find -delete / mv of anything outside the task's folder
 *                    (temporary folders excepted), the folder itself or its .git
 *   git-push         any push: Untether merges the branch itself. And a release: `gh release`
 *                    writes, and Untether's own mac/scripts/release.sh without --dry-run (a
 *                    version is published by hand, on the owner's order)
 *   git-base         switching branches, writing the base branch (branch -f/-d, update-ref,
 *                    reset --hard onto it), git writes in another checkout, worktree remove/move/prune,
 *                    files written in the repository's main checkout (Write/Edit, apply_patch, cp…)
 *   git-rebase-skip  git rebase --skip (it drops commits)
 *   private-paths    ~/.untether and ~/.claude written to, credentials read or written (~/.ssh,
 *                    ~/.aws, auth files, the keychain and `security`'s password commands)
 *   kill-foreign     kill / pkill / killall of a process that is not the task's: neither under its
 *                    agent, nor carrying its marker (task-processes.ts: UNTETHER_TASK_ID, inherited
 *                    reparented or not), nor on the agent's terminal, nor, for a hidden
 *                    environment, in a shell group the task recorded or the group of one that is
 *   sudo             sudo, doas, su, osascript with administrator privileges
 *
 * Per project (projects.json `guardOff`, `guardDeny`, `guardAllow`): rules turned off, extra
 * patterns to block, patterns never blocked. Everything here is pure but for the process table
 * (passed in) so each rule is tested with a blocked command and a similar allowed one.
 *
 * A NET AGAINST THE AGENT'S MISTAKES, NOT A SANDBOX: reading shell is never complete, and a command
 * built to hide what it does (base64 | sh, a script file it wrote) gets past it. The real boundary
 * would be an OS sandbox (seatbelt), left for another task. So, in doubt, it lets the call run:
 * a command it cannot understand (a path or pid known only when it runs) goes through and is
 * written to the task's record as `uncertain`, never blocked (2026-11-02, the orchestrator: the
 * goal is not to get in the way).
 *
 * It reads shell the way an agent writes it (lists, pipes, quotes, `cd x && …` with subshells
 * ending their own cd, `$(…)`, `bash -c`, `xargs`, `env`, variables set earlier in the same
 * command), runs from the tool's own folder (Codex exec_command's `workdir`), and judges paths by
 * where they really lead (realpath of what exists): a symlink in the worktree does not take a
 * delete out of it, nor a read or write to ~/.claude or the keychain.
 */
import * as os from 'os';
import * as path from 'path';
import type { CheckSlotSettings } from './check-slot-wrap.js';
import type { SummarizeSettings } from './task-output.js';
import { inShellGroup, type ProcessMark, TASK_MARKER_VAR } from './task-processes.js';

export const GUARD_RULES = [
  'delete-outside',
  'git-push',
  'git-base',
  'git-rebase-skip',
  'private-paths',
  'kill-foreign',
  'sudo',
] as const;

export type GuardRuleId = (typeof GUARD_RULES)[number];

/** What the hook knows about the task (written by task-guard-setup.ts, one file per task). */
/**
 * The file in a task's guard folder (next to its policy) that holds its agent's tool calls
 * back for a moment (2026-11-11): while Untether merges the base into its branch, no call of
 * its agent starts. `{"until": <epoch ms>}`: past that time the file means nothing, so a hold
 * nobody lifted (a server killed mid-merge) ends by itself. Well under the hook's own timeout.
 */
export const TOOL_HOLD_FILE = 'tools-hold.json';
export const TOOL_HOLD_MAX_MS = 8_000;

/** Until when the hold in `dir` lasts (epoch ms), 0 when there is none. */
export function toolHoldUntil(dir: string, read: (file: string) => string): number {
  try {
    const until = Number(
      (JSON.parse(read(`${dir}/${TOOL_HOLD_FILE}`)) as { until?: unknown }).until
    );
    return Number.isFinite(until) ? until : 0;
  } catch {
    return 0;
  }
}

export interface GuardPolicy {
  taskId: string;
  /** The task's folder: its worktree, or the folder of a task without one. */
  root: string;
  /** The branch it merges into, and its own (worktree tasks). */
  baseBranch?: string;
  branch?: string;
  home: string;
  /**
   * The repository's main checkout (worktree tasks): its files are the base branch's, so a task
   * writes its worktree, never there (git-base).
   */
  baseRoot?: string;
  /** Rules the project turned off. */
  off?: string[];
  /** Project patterns (regular expressions) that block a shell command they match. */
  deny?: string[];
  /** Project patterns: a shell command that matches one is never blocked. */
  allow?: string[];
  /** Where the hook appends what it blocked (one JSON line each). */
  blockedLog?: string;
  /**
   * Claude Code: each Bash shell records its group in the task's folder, by a line the
   * SessionStart hook writes into Claude's env file (task-guard-hook.ts `--shell-env`), never
   * inside the agent's command.
   */
  recordShellGroups?: boolean;
  /**
   * Claude Code, the project's `summarizeOutput` on: recognised test/check commands run with
   * their output in a log and a summary printed (task-output.ts).
   */
  summarize?: SummarizeSettings;
  /**
   * Heavy check runs take a check slot first (check-slot-wrap.ts, 2026-11-10): rewritten for
   * Claude Code, refused with the command to use instead for Codex.
   */
  checkSlot?: CheckSlotSettings;
}

/** The hook's input (Claude Code and Codex send the same shape). */
export interface GuardInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface GuardDecision {
  rule: GuardRuleId | 'project';
  /** Told to the agent: what was blocked and what to do instead. */
  reason: string;
  /** The guard could not tell (a path or pid known only at run time): let through, recorded. */
  uncertain?: boolean;
}

export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Its process group. */
  pgid?: number;
  /** When it started (ms). */
  start?: number;
  /** Its controlling terminal (`ttys004`; `??` for none). */
  tty?: string;
  command: string;
}

/** A process's task marker, and its folder when the system hides its environment. */
export type { ProcessMark } from './task-processes.js';

export interface GuardContext {
  /** The machine's processes (only read for a kill). */
  processes?: () => ProcessEntry[];
  /** The hook's own pid (its ancestors lead to the agent). */
  selfPid?: number;
  /** The task markers of some processes (ps -E). */
  marks?: (pids: number[]) => Map<number, ProcessMark>;
  /** The task's recorded shell groups: pgid → its shell's start (task-processes.ts). */
  shellGroups?: () => ReadonlyMap<number, number>;
  /**
   * The pids `pkill` / `killall` with these arguments would signal (pgrep / killall -s: the
   * same matching); null when it cannot tell.
   */
  matches?: (tool: 'pkill' | 'killall', args: string[]) => number[] | null;
  /** Whether a path exists (git checkout <arg>: a file, or a branch). */
  exists?: (file: string) => boolean;
  /** $TMPDIR. */
  tmpdir?: string;
  /** Where an existing path really leads (fs.realpathSync); throws for a missing one. */
  realpath?: (file: string) => string;
}

// ─── Shell reading ─────────────────────────────────────────────────────────────────────────────

/** A word of a command: its text after quotes, and whether part of it is unknown ($X, $(…)). */
export interface Word {
  text: string;
  dynamic: boolean;
  /** Had an unquoted glob character (* ? [). */
  glob: boolean;
  /** The text was a temporary path from a variable (X=$(mktemp …)). */
  temp?: boolean;
}

export interface SimpleCommand {
  words: Word[];
  redirects: Array<{ op: string; target: Word }>;
  /** The folder it runs in, as far as the `cd`s before it tell. */
  cwd: string;
}

interface Vars {
  [name: string]: { value: string; dynamic: boolean; temp?: boolean };
}

interface ReadState {
  cwd: string;
  vars: Vars;
  home: string;
  /** Commands found inside $(…), `…`, bash -c and eval. */
  nested: Array<{ src: string; cwd: string }>;
}

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n', '(', ')'];
const KNOWN_VARS = new Set(['HOME', 'PWD', 'TMPDIR']);

/** Reads `$NAME`, `${NAME}`, `$(…)` and backticks at `i`; returns the text and the next index. */
function readDollar(
  src: string,
  i: number,
  state: ReadState
): { text: string; dynamic: boolean; temp?: boolean; next: number } {
  const next = src[i + 1];
  if (next === '(') {
    const end = matchParen(src, i + 1);
    const inner = src.slice(i + 2, end);
    if (inner.startsWith('(')) return { text: '', dynamic: true, next: end + 1 }; // $(( math ))
    state.nested.push({ src: inner, cwd: state.cwd });
    return { text: '', dynamic: true, temp: /^\s*mktemp\b/.test(inner), next: end + 1 };
  }
  let name = '';
  let j = i + 1;
  if (next === '{') {
    const close = src.indexOf('}', i + 2);
    const body = close < 0 ? src.slice(i + 2) : src.slice(i + 2, close);
    name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(body) ? body : '';
    j = close < 0 ? src.length : close + 1;
    // "${TMPDIR:-/tmp}/rv": a variable known here with a default is that variable (2026-11-10:
    // read as empty, the path became /rv and a scratch folder under $TMPDIR was blocked as a
    // delete outside the task, bakery 3dc243e4). An unknown one stays unknown.
    const defaulted = name ? null : /^([A-Za-z_][A-Za-z0-9_]*):?[-=]/.exec(body);
    if (defaulted && (state.vars[defaulted[1]] || KNOWN_VARS.has(defaulted[1]))) {
      name = defaulted[1];
    }
    if (!name) return { text: '', dynamic: true, next: j };
  } else {
    const match = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(i + 1));
    if (!match) return { text: '$', dynamic: false, next: i + 1 };
    name = match[1];
    j = i + 1 + name.length;
  }
  const own = state.vars[name];
  if (own) return { text: own.value, dynamic: own.dynamic, temp: own.temp, next: j };
  if (name === 'HOME') return { text: state.home, dynamic: false, next: j };
  if (name === 'PWD') return { text: state.cwd, dynamic: false, next: j };
  if (name === 'TMPDIR') return { text: os.tmpdir(), dynamic: false, temp: true, next: j };
  return { text: `$${name}`, dynamic: !KNOWN_VARS.has(name), next: j };
}

/** The index of the `)` closing the `(` at `open`, quotes and nesting followed. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      i = close < 0 ? src.length : close;
    } else if (c === '"') {
      i = skipDouble(src, i);
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

function skipDouble(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '"') return i;
    else if (src[i] === '$' && src[i + 1] === '(') i = matchParen(src, i + 1);
  }
  return src.length;
}

type Token =
  | { kind: 'word'; word: Word }
  | { kind: 'op'; op: string }
  | { kind: 'redir'; op: string };

/**
 * Splits shell source into words, operators and redirections (heredoc bodies skipped). Lazily:
 * a word is expanded once the commands before it were read, so `T=…; rm "$T"` and `cd x; $PWD`
 * see what came first.
 */
export function* tokenize(src: string, state: ReadState): Generator<Token> {
  const heredocs: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n' && heredocs.length) {
      // Skip each pending heredoc's body up to its delimiter line.
      let pos = i + 1;
      for (const delimiter of heredocs.splice(0)) {
        while (pos < src.length) {
          const eol = src.indexOf('\n', pos);
          const line = src.slice(pos, eol < 0 ? src.length : eol);
          pos = eol < 0 ? src.length : eol + 1;
          if (line.replace(/^\t+/, '') === delimiter) break;
        }
      }
      yield { kind: 'op', op: '\n' };
      i = pos;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;&|()]/.test(src[i - 1]))) {
      const eol = src.indexOf('\n', i);
      i = eol < 0 ? src.length : eol;
      continue;
    }
    // Redirections: [n]> >> &> <, <<, <<<, >&n.
    const redir = /^(\d*)(&>>|&>|>>|>\||>&|<<<|<<-|<<|<&|<>|>|<)/.exec(src.slice(i));
    if (redir && (redir[1] === '' || i === 0 || /[\s;&|()]/.test(src[i - 1]))) {
      const op = redir[2];
      i += redir[0].length;
      if (op === '<<' || op === '<<-') {
        while (src[i] === ' ' || src[i] === '\t') i++;
        const delim = /^(['"]?)([^\s'";&|<>()]+)\1/.exec(src.slice(i));
        if (delim) {
          heredocs.push(delim[2]);
          i += delim[0].length;
        }
        continue;
      }
      if ((op === '>&' || op === '<&') && /^[\d-]/.test(src[i] ?? '')) {
        while (/[\d-]/.test(src[i] ?? '')) i++;
        continue;
      }
      yield { kind: 'redir', op };
      continue;
    }
    const op = OPERATORS.find((candidate) => src.startsWith(candidate, i));
    if (op) {
      yield { kind: 'op', op };
      i += op.length;
      continue;
    }
    // A word.
    let text = '';
    let dynamic = false;
    let glob = false;
    let temp = false;
    const start = i;
    while (i < src.length) {
      const ch = src[i];
      if (/[\s;&|()<>]/.test(ch)) {
        // `<(…)` / `>(…)`: process substitution, read as a nested command.
        if ((ch === '<' || ch === '>') && src[i + 1] === '(' && i === start) {
          const end = matchParen(src, i + 1);
          state.nested.push({ src: src.slice(i + 2, end), cwd: state.cwd });
          dynamic = true;
          i = end + 1;
          continue;
        }
        break;
      }
      if (ch === '\\') {
        text += src[i + 1] ?? '';
        i += 2;
      } else if (ch === "'") {
        const close = src.indexOf("'", i + 1);
        text += src.slice(i + 1, close < 0 ? src.length : close);
        i = close < 0 ? src.length : close + 1;
      } else if (ch === '$' && src[i + 1] === "'") {
        const close = src.indexOf("'", i + 2);
        text += src.slice(i + 2, close < 0 ? src.length : close);
        i = close < 0 ? src.length : close + 1;
      } else if (ch === '"') {
        const close = skipDouble(src, i);
        const inner = src.slice(i + 1, close);
        const read = expandDouble(inner, state);
        text += read.text;
        dynamic ||= read.dynamic;
        temp ||= read.temp;
        i = close + 1;
      } else if (ch === '$') {
        const read = readDollar(src, i, state);
        text += read.text;
        dynamic ||= read.dynamic;
        temp ||= !!read.temp;
        i = read.next;
      } else if (ch === '`') {
        const close = src.indexOf('`', i + 1);
        state.nested.push({
          src: src.slice(i + 1, close < 0 ? src.length : close),
          cwd: state.cwd,
        });
        dynamic = true;
        i = close < 0 ? src.length : close + 1;
      } else if (ch === '~' && i === start) {
        const rest = src.slice(i + 1);
        if (rest === '' || /^[/\s;&|)]/.test(rest)) {
          text += state.home;
        } else {
          text += '~';
          dynamic = true; // ~user
        }
        i++;
      } else {
        if (ch === '*' || ch === '?' || ch === '[') glob = true;
        text += ch;
        i++;
      }
    }
    yield { kind: 'word', word: { text, dynamic, glob, ...(temp ? { temp } : {}) } };
  }
}

function expandDouble(
  inner: string,
  state: ReadState
): { text: string; dynamic: boolean; temp: boolean } {
  let text = '';
  let dynamic = false;
  let temp = false;
  for (let i = 0; i < inner.length; ) {
    const ch = inner[i];
    if (ch === '\\' && /[$`"\\\n]/.test(inner[i + 1] ?? '')) {
      text += inner[i + 1];
      i += 2;
    } else if (ch === '$') {
      const read = readDollar(inner, i, state);
      text += read.text;
      dynamic ||= read.dynamic;
      temp ||= !!read.temp;
      i = read.next;
    } else if (ch === '`') {
      const close = inner.indexOf('`', i + 1);
      state.nested.push({
        src: inner.slice(i + 1, close < 0 ? inner.length : close),
        cwd: state.cwd,
      });
      dynamic = true;
      i = close < 0 ? inner.length : close + 1;
    } else {
      text += ch;
      i++;
    }
  }
  return { text, dynamic, temp };
}

/** Words that run the words after them as a command. */
const PREFIX_COMMANDS: Record<string, { flagsWithValue?: string[]; skipFirst?: boolean }> = {
  command: {},
  builtin: {},
  exec: { flagsWithValue: ['-a'] },
  nohup: {},
  time: {},
  nice: { flagsWithValue: ['-n'] },
  caffeinate: { flagsWithValue: ['-t', '-w'] },
  timeout: { flagsWithValue: ['-s', '-k', '--signal', '--kill-after'], skipFirst: true },
  gtimeout: { flagsWithValue: ['-s', '-k', '--signal', '--kill-after'], skipFirst: true },
  env: { flagsWithValue: ['-u', '-C', '-S'] },
  xargs: { flagsWithValue: ['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-J', '-R'] },
  sudo: { flagsWithValue: ['-u', '-g', '-C', '-D', '-h', '-p', '-U', '-r', '-t'] },
  doas: { flagsWithValue: ['-u', '-C'] },
};

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** Reads `src` into simple commands, the `cd`s and variables before each one followed. */
export function readCommands(src: string, cwd: string, home: string, depth = 0): SimpleCommand[] {
  const state: ReadState = { cwd, vars: {}, home, nested: [] };
  return readWith(src, state, depth);
}

function readWith(src: string, state: ReadState, depth: number): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  const tokens = tokenize(src, state);
  let words: Word[] = [];
  let redirects: SimpleCommand['redirects'] = [];
  let pendingRedir: string | null = null;
  const subshells: string[] = [];
  const flush = () => {
    if (words.length || redirects.length) finishCommand(words, redirects, state, out, depth);
    words = [];
    redirects = [];
  };
  for (const token of tokens) {
    if (token.kind === 'word') {
      if (pendingRedir) {
        redirects.push({ op: pendingRedir, target: token.word });
        pendingRedir = null;
      } else {
        words.push(token.word);
      }
    } else if (token.kind === 'redir') {
      pendingRedir = token.op;
    } else {
      flush();
      // A subshell's cd ends with it: `(cd /x && …) && rm -rf y` removes y here.
      if (token.op === '(') subshells.push(state.cwd);
      else if (token.op === ')' && subshells.length) state.cwd = subshells.pop() as string;
    }
  }
  flush();
  if (depth < 4) {
    // Each nested command ($(…), bash -c, eval) runs in the folder it was written in.
    const nested = state.nested.splice(0);
    for (const inner of nested) {
      out.push(...readWith(inner.src, { ...state, cwd: inner.cwd, nested: [] }, depth + 1));
    }
  }
  return out;
}

function finishCommand(
  rawWords: Word[],
  redirects: SimpleCommand['redirects'],
  state: ReadState,
  out: SimpleCommand[],
  depth: number
): void {
  let words = rawWords;
  // Leading NAME=value words: alone they set a variable for what follows.
  let k = 0;
  while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].text) && !words[k].glob) k++;
  if (k === words.length && k > 0) {
    for (const word of words) setVar(word, state);
    return;
  }
  words = words.slice(k);
  if (
    (words[0]?.text === 'export' || words[0]?.text === 'local' || words[0]?.text === 'declare') &&
    words.length > 1
  ) {
    for (const word of words.slice(1)) if (word.text.includes('=')) setVar(word, state);
    return;
  }
  words = unwrap(stripKeywords(words));
  const command: SimpleCommand = { words, redirects, cwd: state.cwd };
  out.push(command);
  const name = words[0]?.text ?? '';
  // cd changes the folder of what comes after it.
  if ((name === 'cd' || name === 'pushd') && words.length <= 2) {
    const target = words[1];
    if (!target) state.cwd = state.home;
    else if (target.text !== '-' && (!target.dynamic || target.text.startsWith('/')))
      state.cwd = path.resolve(state.cwd, target.text);
  }
  // A shell running a string, or eval: read that string too.
  if (depth < 4) {
    const base = path.basename(name);
    if (SHELLS.has(base)) {
      const flag = words.findIndex(
        (word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word.text)
      );
      if (flag > 0 && words[flag + 1])
        state.nested.push({ src: words[flag + 1].text, cwd: state.cwd });
    } else if (name === 'eval') {
      state.nested.push({
        src: words
          .slice(1)
          .map((word) => word.text)
          .join(' '),
        cwd: state.cwd,
      });
    }
  }
}

/** Shell keywords before a command (`if`, `then`, `{`, `!` …) and a closing `}`. */
const KEYWORDS = new Set([
  '{',
  '}',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'time',
  'esac',
]);

function stripKeywords(words: Word[]): Word[] {
  let start = 0;
  while (start < words.length && KEYWORDS.has(words[start].text) && !words[start].dynamic) start++;
  let end = words.length;
  if (end > start && words[end - 1].text === '}') end--;
  return words.slice(start, end);
}

function setVar(word: Word, state: ReadState): void {
  const eq = word.text.indexOf('=');
  const name = word.text.slice(0, eq);
  state.vars[name] = { value: word.text.slice(eq + 1), dynamic: word.dynamic, temp: word.temp };
}

/** Past `env`, `nohup`, `xargs -0`, `timeout 5`…: the command that really runs (sudo stays). */
export function unwrap(words: Word[]): Word[] {
  let rest = words;
  for (let guard = 0; guard < 8 && rest.length; guard++) {
    const name = path.basename(rest[0].text);
    const spec = PREFIX_COMMANDS[name];
    if (!spec || name === 'sudo' || name === 'doas') return rest;
    let i = 1;
    while (i < rest.length) {
      const text = rest[i].text;
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
        i++;
      } else if (text.startsWith('-') && text !== '-') {
        i += spec.flagsWithValue?.includes(text) ? 2 : 1;
      } else {
        break;
      }
    }
    if (spec.skipFirst) i++;
    rest = rest.slice(i);
  }
  return rest;
}

// ─── Paths ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Folders an agent may delete in freely: /tmp and its own $TMPDIR, not all of /var/folders (its
 * other folders hold other programs' caches).
 */
function tempRoots(context: GuardContext): string[] {
  const roots = ['/tmp', '/private/tmp'];
  const own = context.tmpdir ?? os.tmpdir();
  if (own) roots.push(path.resolve(own));
  return roots;
}

function inside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function strictlyInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Where `file` really leads: the realpath of its longest existing part, the rest appended.
 * `followLast` false keeps the last part as it is (rm removes a symlink, not what it points to).
 */
export function realOf(
  file: string,
  realpath: ((file: string) => string) | undefined,
  followLast = true
): string {
  if (!realpath) return file;
  const glob = file.endsWith('\0glob');
  const base = glob ? path.dirname(file) : file;
  const follow = glob || followLast;
  let head = follow ? base : path.dirname(base);
  const tail: string[] = follow ? [] : [path.basename(base)];
  for (;;) {
    try {
      const real = path.join(realpath(head), ...tail);
      return glob ? path.join(real, '\0glob') : real;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return file;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Where `text` (relative to `cwd`) leads on disk, walked part by part as the system does: a
 * symlink is followed before a later `..` (wt/link/../x, link -> /elsewhere/docs, is
 * /elsewhere/x, not wt/x). Parts that don't exist yet are appended as they are. `followLast`
 * false keeps the last part unresolved (rm removes a symlink, not what it points to).
 */
export function physicalPath(
  cwd: string,
  text: string,
  realpath: ((file: string) => string) | undefined,
  followLast = true
): string {
  if (!realpath) return path.resolve(cwd, text);
  let current = text.startsWith('/') ? '/' : realOf(path.resolve(cwd), realpath);
  const parts = text.split('/').filter((part) => part !== '' && part !== '.');
  let exists = true;
  parts.forEach((part, i) => {
    if (part === '..') {
      current = path.dirname(current);
      return;
    }
    const next = path.join(current, part);
    if (!exists || (i === parts.length - 1 && !followLast)) {
      current = next;
      return;
    }
    try {
      current = realpath(next);
    } catch {
      current = next;
      exists = false;
    }
  });
  return current;
}

/** The text of a word up to its first glob segment (`dir/*` names dir's content). */
function globFree(word: Word): string {
  if (!word.glob) return word.text;
  const parts = word.text.split('/');
  const first = parts.findIndex((part) => /[*?[]/.test(part));
  return parts.slice(0, first).join('/') || (word.text.startsWith('/') ? '/' : '.');
}

/** Where a word really leads (physicalPath); a glob as its folder plus the glob mark. */
function realWord(word: Word, cwd: string, ctx: RuleContext, followLast = true): string {
  const file = physicalPath(cwd, globFree(word), ctx.context.realpath, word.glob || followLast);
  return word.glob ? path.join(file, '\0glob') : file;
}

/** A word as an absolute path; with a glob, the folder before the first glob segment. */
function resolveWord(word: Word, cwd: string): string {
  let text = word.text;
  if (word.glob) {
    const parts = text.split('/');
    const first = parts.findIndex((part) => /[*?[]/.test(part));
    text = parts.slice(0, first).join('/') || (text.startsWith('/') ? '/' : '.');
    // `dir/*` empties dir but leaves it: judged as dir's content (inside dir).
    return path.join(path.resolve(cwd, text), '\0glob');
  }
  return path.resolve(cwd, text);
}

interface Protected {
  /** Folders whose writes are blocked (Untether's and Claude's own state). */
  noWrite: string[];
  /** Credentials: any use is blocked. */
  secrets: string[];
}

function protectedPaths(home: string): Protected {
  const h = (rel: string) => path.join(home, rel);
  return {
    noWrite: [h('.untether'), h('.claude'), h('.claude.json'), h('.codex')],
    secrets: [
      h('.ssh'),
      h('.aws'),
      h('.gnupg'),
      h('.netrc'),
      h('.git-credentials'),
      h('.config/gh'),
      h('.docker/config.json'),
      h('.kube'),
      h('.npmrc'),
      h('Library/Keychains'),
      h('.claude/.credentials.json'),
      h('.codex/auth.json'),
      h('.untether/auth'),
      h('.untether/secrets'),
      '/Library/Keychains',
    ],
  };
}

function isSecret(file: string, prot: Protected): boolean {
  return prot.secrets.some((dir) => inside(file, dir));
}

function isNoWrite(file: string, prot: Protected): boolean {
  return prot.noWrite.some((dir) => inside(file, dir));
}

// ─── Rules ─────────────────────────────────────────────────────────────────────────────────────

const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash']);
/** Commands that write to the paths among their words. */
const WRITERS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'mv',
  'cp',
  'tee',
  'touch',
  'mkdir',
  'chmod',
  'chown',
  'chflags',
  'ln',
  'truncate',
  'install',
  'rsync',
  'dd',
  'ditto',
  'trash',
  'xattr',
]);
/** git subcommands that change a checkout, its branches or its history. */
const GIT_WRITES = new Set([
  'add',
  'am',
  'apply',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'merge',
  'mv',
  'pull',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
  'tag',
  'update-ref',
  'worktree',
  'fetch',
  'gc',
  'prune',
  'filter-branch',
  'replace',
  'symbolic-ref',
]);

interface RuleContext {
  policy: GuardPolicy;
  context: GuardContext;
  root: string;
  prot: Protected;
  temps: string[];
  /** The main checkout, as written and where it really is (none without policy.baseRoot). */
  baseRoots: string[];
}

type Finding = GuardDecision | null;

function block(rule: GuardRuleId, reason: string): GuardDecision {
  return { rule, reason };
}

function displayPath(file: string, home: string): string {
  const clean = file.replace(/\/?\0glob$/, '/*');
  return inside(clean, home) ? `~/${path.relative(home, clean)}` : clean;
}

/** delete-outside: what a deleting command (or mv's sources) would remove. */
function checkDelete(cmd: SimpleCommand, ctx: RuleContext): Finding {
  const name = path.basename(cmd.words[0]?.text ?? '');
  let targets: Word[] = [];
  // find deletes what it finds under its folders, not the folders: the task folder may be one.
  let rootAllowed = false;
  if (DELETERS.has(name)) {
    targets = operands(cmd.words.slice(1));
  } else if (name === 'mv') {
    const ops = operands(cmd.words.slice(1), ['-t', '--target-directory']);
    targets = ops.slice(0, -1);
  } else if (
    name === 'find' &&
    cmd.words.some(
      (w) => w.text === '-delete' || w.text === '-exec' || w.text === '-execdir' || w.text === '-ok'
    )
  ) {
    const deletes =
      cmd.words.some((w) => w.text === '-delete') ||
      cmd.words.some(
        (w, i) =>
          /^-(exec|execdir|ok)$/.test(w.text) &&
          /^(rm|rmdir|unlink|shred)$/.test(path.basename(cmd.words[i + 1]?.text ?? ''))
      );
    if (!deletes) return null;
    targets = [];
    for (const word of cmd.words.slice(1)) {
      if (/^[-!(]/.test(word.text)) break;
      targets.push(word);
    }
    if (!targets.length) targets = [{ text: '.', dynamic: false, glob: false }];
    rootAllowed = true;
  } else {
    return null;
  }
  let uncertain: Finding = null;
  for (const target of targets) {
    if (target.temp) continue;
    if (target.dynamic) {
      uncertain ??= {
        rule: 'delete-outside',
        reason: `\`${name}\` on "${target.text || '$…'}", a path known only when it runs: let through unjudged.`,
        uncertain: true,
      };
      continue;
    }
    const finding = deleteTarget(
      name,
      target.text,
      realWord(target, cmd.cwd, ctx, false),
      ctx,
      rootAllowed
    );
    if (finding) return finding;
  }
  return uncertain;
}

/** delete-outside for one removed path (already resolved to where it really is). */
function deleteTarget(
  name: string,
  said: string,
  file: string,
  ctx: RuleContext,
  rootAllowed = false
): Finding {
  const gitDir = path.join(ctx.root, '.git');
  // The task folder and its .git first: a worktree under /tmp is still protected.
  if (strictlyInside(file, ctx.root) && !inside(file, gitDir)) return null;
  if (rootAllowed && file === ctx.root) return null;
  if (!inside(file, ctx.root) && ctx.temps.some((dir) => strictlyInside(file, dir))) return null;
  const shown = displayPath(file, ctx.policy.home);
  if (inside(file, gitDir)) {
    return block(
      'delete-outside',
      `\`${name} ${said}\` would remove the task's git data (${shown}). Leave .git alone.`
    );
  }
  if (file === ctx.root) {
    return block(
      'delete-outside',
      `\`${name} ${said}\` would remove your whole task folder (${shown}). Remove only files inside it.`
    );
  }
  return block(
    'delete-outside',
    `\`${name}\` would remove ${shown}, outside your task folder ${ctx.root}. Tasks may only delete inside their own folder (and in temporary folders).`
  );
}

/** The non-option words (after `--` all are operands). */
function operands(words: Word[], flagsWithValue: string[] = []): Word[] {
  const out: Word[] = [];
  let rest = false;
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text;
    if (!rest && text === '--') {
      rest = true;
    } else if (!rest && text.startsWith('-') && text.length > 1) {
      if (flagsWithValue.includes(text)) out.push(words[++i]);
    } else {
      out.push(words[i]);
    }
  }
  return out.filter(Boolean);
}

interface GitCall {
  sub: string;
  args: Word[];
  /** Where it runs (-C, then the command's folder). */
  dir: string;
  dirDynamic: boolean;
}

function readGit(cmd: SimpleCommand): GitCall | null {
  if (path.basename(cmd.words[0]?.text ?? '') !== 'git') return null;
  let dir = cmd.cwd;
  let dirDynamic = false;
  let i = 1;
  while (i < cmd.words.length) {
    const word = cmd.words[i];
    if (word.text === '-C') {
      const target = cmd.words[i + 1];
      if (target) {
        dirDynamic ||= target.dynamic;
        dir = path.resolve(dir, target.text);
      }
      i += 2;
    } else if (
      word.text === '-c' ||
      word.text === '--git-dir' ||
      word.text === '--work-tree' ||
      word.text === '--namespace'
    ) {
      if (word.text !== '-c') {
        const target = cmd.words[i + 1];
        if (target) {
          dirDynamic ||= target.dynamic;
          dir = path.resolve(cmd.cwd, target.text);
        }
      }
      i += 2;
    } else if (/^--(git-dir|work-tree)=/.test(word.text)) {
      dirDynamic ||= word.dynamic;
      dir = path.resolve(cmd.cwd, word.text.slice(word.text.indexOf('=') + 1));
      i++;
    } else if (word.text.startsWith('-')) {
      i++;
    } else {
      break;
    }
  }
  const sub = cmd.words[i]?.text;
  if (!sub) return null;
  return { sub, args: cmd.words.slice(i + 1), dir, dirDynamic };
}

/** git-push. */
function checkGitPush(cmd: SimpleCommand): Finding {
  const git = readGit(cmd);
  if (git?.sub === 'push' || git?.sub === 'send-pack') {
    return block(
      'git-push',
      '`git push` is not for tasks: Untether reviews your branch and merges it itself. Commit your work and report with `ut task done`.'
    );
  }
  if (
    path.basename(cmd.words[0]?.text ?? '') === 'gh' &&
    cmd.words[1]?.text === 'repo' &&
    cmd.words[2]?.text === 'sync'
  ) {
    return block(
      'git-push',
      '`gh repo sync` pushes to a remote: Untether merges your branch itself.'
    );
  }
  // 2026-11-12: a release is published only when the owner orders it, by hand.
  if (
    path.basename(cmd.words[0]?.text ?? '') === 'gh' &&
    cmd.words[1]?.text === 'release' &&
    ['create', 'upload', 'edit', 'delete', 'delete-asset'].includes(cmd.words[2]?.text ?? '')
  ) {
    return block(
      'git-push',
      `\`gh release ${cmd.words[2]?.text}\` publishes: a task never publishes a release. The owner orders one, by hand.`
    );
  }
  const script = cmd.words
    .slice(0, 2)
    .findIndex((w) => path.resolve(cmd.cwd, w.text).endsWith(`${path.sep}mac/scripts/release.sh`));
  if (
    script >= 0 &&
    !cmd.words.slice(script + 1).some((w) => ['--dry-run', '--help', '-h'].includes(w.text))
  ) {
    return block(
      'git-push',
      '`mac/scripts/release.sh` publishes a version: a task never does. Rehearse with `--dry-run`; the owner orders the real one, by hand.'
    );
  }
  return null;
}

/** git-rebase-skip. */
function checkRebaseSkip(cmd: SimpleCommand): Finding {
  const git = readGit(cmd);
  if (git?.sub === 'rebase' && git.args.some((w) => w.text === '--skip')) {
    return block(
      'git-rebase-skip',
      '`git rebase --skip` drops a commit and its changes. Resolve the conflict (edit, git add, git rebase --continue) or `git rebase --abort`.'
    );
  }
  return null;
}

/** A ref naming the base branch (main, origin/main, refs/heads/main). */
function namesBase(ref: string, base: string | undefined): boolean {
  if (!base) return false;
  const clean = ref
    .replace(/^\+/, '')
    .replace(/[~^].*$/, '')
    .replace(/@\{.*$/, '');
  if (clean === base || clean === `refs/heads/${base}`) return true;
  // origin/main, refs/remotes/origin/main
  const remote = /^(?:refs\/remotes\/)?[^/]+\/(.+)$/.exec(clean);
  return remote?.[1] === base;
}

/** git-base. */
function checkGitBase(cmd: SimpleCommand, ctx: RuleContext): Finding {
  const git = readGit(cmd);
  if (!git) return null;
  const { sub, args } = git;
  const base = ctx.policy.baseBranch;
  const baseName = base ?? 'the base branch';
  const texts = args.map((w) => w.text);
  if (args.some((w) => w.text === '-h' || w.text === '--help')) return null;
  // Another checkout (the main one, another task's worktree): no git writes there.
  if (GIT_WRITES.has(sub) && sub !== 'worktree' && (git.dirDynamic || !inside(git.dir, ctx.root))) {
    const readOnly =
      (sub === 'branch' &&
        !texts.some((t) =>
          /^-([dDmMcCf]|-delete|-move|-copy|-force|-set-upstream-to|-unset-upstream)/.test(t)
        ) &&
        operands(args).length === 0) ||
      (sub === 'stash' && /^(list|show)$/.test(texts[0] ?? '')) ||
      (sub === 'tag' && operands(args).length === 0) ||
      sub === 'fetch';
    if (!readOnly) {
      return block(
        'git-base',
        `\`git ${sub}\` in ${displayPath(git.dir, ctx.policy.home)}, outside your task folder ${ctx.root}. A task changes only its own worktree and branch; Untether merges it into ${baseName}.`
      );
    }
  }
  if (sub === 'switch') {
    return block(
      'git-base',
      `\`git switch\` would change your task's branch. Stay on ${ctx.policy.branch ?? 'the task branch'}: Untether merges it into ${baseName} itself.`
    );
  }
  if (sub === 'checkout') {
    const dash = texts.indexOf('--');
    if (texts.some((t) => /^-(b|B|-orphan|-detach)$/.test(t) || t === '--track' || t === '-t')) {
      return block(
        'git-base',
        `\`git checkout ${texts.join(' ')}\` changes branch. Stay on ${ctx.policy.branch ?? 'the task branch'}.`
      );
    }
    const before = operands(dash < 0 ? args : args.slice(0, dash));
    if (dash < 0 && before.length === 1) {
      const target = before[0];
      const file = path.resolve(git.dir, target.text);
      const isFile =
        target.glob || target.text === '.' || (ctx.context.exists ?? (() => false))(file);
      if (!isFile) {
        return block(
          'git-base',
          `\`git checkout ${target.text}\` switches branch. Stay on ${ctx.policy.branch ?? 'the task branch'}; to restore a file, write \`git checkout -- <file>\` (or \`git restore <file>\`).`
        );
      }
    }
    return null;
  }
  if (sub === 'reset' && texts.includes('--hard')) {
    const target = operands(args).find((w) => w.text !== '--hard');
    if (target && namesBase(target.text, base)) {
      return block(
        'git-base',
        `\`git reset --hard ${target.text}\` would throw away your task's commits onto ${baseName}. To pick up ${baseName}, merge it: \`git merge ${base}\`.`
      );
    }
    return null;
  }
  if (sub === 'branch') {
    const changes = texts.some((t) => /^-([dDmMcCf]|-delete|-move|-copy|-force)$/.test(t));
    if (changes && operands(args).some((w) => namesBase(w.text, base) || w.text === base)) {
      return block(
        'git-base',
        `\`git branch ${texts.join(' ')}\` would change ${baseName}. Only Untether moves ${baseName}.`
      );
    }
    if (texts.some((t) => /^-(f|-force)$/.test(t)) && base && operands(args)[0]?.text === base) {
      return block(
        'git-base',
        `\`git branch -f ${base}\` would move ${baseName}. Only Untether moves it.`
      );
    }
    return null;
  }
  if (sub === 'update-ref' || sub === 'symbolic-ref') {
    const ref = operands(args)[0]?.text ?? '';
    if (sub === 'symbolic-ref' && ref === 'HEAD' && operands(args).length > 1) {
      return block(
        'git-base',
        '`git symbolic-ref HEAD …` changes branch. Stay on the task branch.'
      );
    }
    if (namesBase(ref, base) || (base && ref === `refs/heads/${base}`)) {
      return block(
        'git-base',
        `\`git ${sub} ${ref}\` would move ${baseName}. Only Untether moves it.`
      );
    }
    return null;
  }
  if (sub === 'worktree' && /^(remove|move|prune)$/.test(texts[0] ?? '')) {
    return block(
      'git-base',
      `\`git worktree ${texts[0]}\` changes the repository's worktrees (other tasks' among them). Untether removes your worktree itself when the task ends.`
    );
  }
  return null;
}

/** private-paths, for a shell command. */
function checkPrivateShell(cmd: SimpleCommand, ctx: RuleContext): Finding {
  const name = path.basename(cmd.words[0]?.text ?? '');
  if (name === 'security') {
    const sub = cmd.words[1]?.text ?? '';
    if (
      /^(find|add|delete|set)-(generic|internet)-password$|^dump-keychain$|^export$|^import$|^unlock-keychain$|^delete-keychain$|^set-keychain-|^create-keychain$|^find-key$|^set-key-partition-list$/.test(
        sub
      )
    ) {
      return block(
        'private-paths',
        `\`security ${sub}\` reads or changes the keychain. Tasks never touch credentials; if the task needs one, ask with \`ut task ask\`.`
      );
    }
  }
  if (name === 'git' && cmd.words.slice(1).some((w) => w.text === 'credential')) {
    return block(
      'private-paths',
      '`git credential` reads stored credentials. Tasks never touch credentials.'
    );
  }
  if (
    name === 'gh' &&
    cmd.words[1]?.text === 'auth' &&
    /^(token|refresh|login|logout|setup-git)$/.test(cmd.words[2]?.text ?? '')
  ) {
    return block(
      'private-paths',
      `\`gh auth ${cmd.words[2]?.text}\` reads or changes GitHub credentials. Tasks never touch credentials.`
    );
  }
  const words = [...cmd.words.slice(1), ...cmd.redirects.map((r) => r.target)];
  for (const word of words) {
    for (const candidate of pathCandidates(word, cmd.cwd, ctx)) {
      if (isSecret(candidate, ctx.prot)) {
        return block(
          'private-paths',
          `${displayPath(candidate, ctx.policy.home)} holds credentials: tasks never read or change them. If the task needs one, ask with \`ut task ask\`.`
        );
      }
    }
  }
  const writeTargets = [
    ...writtenWords(name, cmd.words),
    ...cmd.redirects.filter((r) => r.op.includes('>')).map((r) => r.target),
  ];
  for (const word of writeTargets) {
    for (const candidate of pathCandidates(word, cmd.cwd, ctx)) {
      if (isNoWrite(candidate, ctx.prot)) {
        return block(
          'private-paths',
          `${displayPath(candidate, ctx.policy.home)} is Untether's or the agents' own state: tasks don't write there. Change files inside your task folder ${ctx.root}.`
        );
      }
    }
  }
  return null;
}

/** git-base: a write into the repository's main checkout (outside the task's own folder). */
function baseWrite(candidates: string[], ctx: RuleContext, what: string): Finding {
  if (!ctx.baseRoots.length) return null;
  for (const candidate of candidates) {
    if (inside(candidate, ctx.root)) continue;
    const base = ctx.baseRoots.find((dir) => inside(candidate, dir));
    if (!base) continue;
    const rel = path.relative(base, candidate);
    return block(
      'git-base',
      `${what} ${displayPath(candidate, ctx.policy.home)}, in the repository's main checkout (the base branch's files). Tasks change only their own worktree: write ${path.join(ctx.root, rel)} instead.`
    );
  }
  return null;
}

/** git-base, for a shell command: what it writes or removes in the main checkout. */
function checkBaseShell(cmd: SimpleCommand, ctx: RuleContext): Finding {
  if (!ctx.baseRoots.length) return null;
  const name = path.basename(cmd.words[0]?.text ?? '');
  const targets = [
    ...writtenWords(name, cmd.words),
    ...cmd.redirects.filter((r) => r.op.includes('>')).map((r) => r.target),
  ];
  for (const word of targets) {
    const finding = baseWrite(pathCandidates(word, cmd.cwd, ctx), ctx, `\`${name}\` would change`);
    if (finding) return finding;
  }
  return null;
}

/** Copiers write only their destination (their last operand); the others every word. */
const COPIERS = new Set(['cp', 'ln', 'install', 'rsync', 'ditto']);

/** The words naming what a command writes. */
function writtenWords(name: string, words: Word[]): Word[] {
  if (COPIERS.has(name)) {
    const target = words.findIndex((w) => w.text === '-t' || w.text === '--target-directory');
    if (target > 0 && words[target + 1]) return [words[target + 1]];
    const ops = operands(words.slice(1));
    return ops.length > 1 ? ops.slice(-1) : [];
  }
  if (WRITERS.has(name)) return words.slice(1);
  if (name === 'sed' && words.some((w) => w.text.startsWith('-i') || w.text === '--in-place'))
    return words.slice(1);
  if (name === 'perl' && words.some((w) => /^-[a-z]*i/.test(w.text))) return words.slice(1);
  return [];
}

/** The paths a word may name: itself, and the value of `--opt=value` / `of=…`. */
function pathCandidates(word: Word, cwd: string, ctx: RuleContext): string[] {
  if (word.dynamic && !word.text.startsWith('/')) return [];
  let text = word.text;
  const eq = /^(?:--?[A-Za-z][\w-]*|of|if)=(.+)$/.exec(text);
  if (eq) text = eq[1];
  if (!text || (text.startsWith('-') && !eq)) return [];
  // A bare word is a file only relative to the folder (cd ~/.ssh && cat id_rsa).
  const named = { ...word, text };
  const lexical = resolveWord(named, cwd).replace(/\/?\0glob$/, '');
  const real = realWord(named, cwd, ctx).replace(/\/?\0glob$/, '');
  return [...new Set([lexical, real])];
}

/** kill-foreign. */
function checkKill(cmd: SimpleCommand, ctx: RuleContext): Finding {
  const name = path.basename(cmd.words[0]?.text ?? '');
  if (name === 'pkill' || name === 'killall') return checkKillByName(name, cmd, ctx);
  if (
    name === 'launchctl' &&
    /^(kill|stop|remove|bootout|unload)$/.test(cmd.words[1]?.text ?? '')
  ) {
    return block(
      'kill-foreign',
      `\`launchctl ${cmd.words[1]?.text}\` stops the user's services. Tasks only stop processes they started.`
    );
  }
  if (name !== 'kill') return null;
  const targets: Word[] = [];
  let probe = false;
  let signal = false;
  let dashes = false;
  for (let i = 1; i < cmd.words.length; i++) {
    const text = cmd.words[i].text;
    if (!dashes) {
      if (text === '--') {
        dashes = true;
        continue;
      }
      if (text === '-l' || text === '-L') return null;
      if (text === '-s' || text === '-n') {
        if (cmd.words[i + 1]?.text === '0') probe = true;
        signal = true;
        i++;
        continue;
      }
      if (text === '-0' || text === '-s0') {
        probe = true;
        signal = true;
        continue;
      }
      // The signal: the first dash word (kill -9 123, kill -TERM 123, kill -9 -123 = group).
      if (!signal && targets.length === 0 && /^-([A-Za-z]+|\d+)$/.test(text)) {
        signal = true;
        continue;
      }
    }
    targets.push(cmd.words[i]);
  }
  if (probe) return null;
  // A doubt on one operand doesn't stop the others being judged (kill "$PID" 900).
  let uncertain: Finding = null;
  const pids: number[] = [];
  for (const target of targets) {
    if (target.text.startsWith('%')) continue; // a job of this shell
    if (target.text === '$!' || target.text === '$$') continue;
    if (target.dynamic || !/^-?\d+$/.test(target.text)) {
      uncertain ??= {
        rule: 'kill-foreign',
        reason: `\`kill ${target.text || '$(…)'}\`: whose process is known only when it runs; let through unjudged.`,
        uncertain: true,
      };
      continue;
    }
    const pid = Math.abs(Number(target.text));
    if (pid <= 1 || target.text.startsWith('-')) {
      return block(
        'kill-foreign',
        `\`kill ${target.text}\` signals a whole process group or every process. Kill only processes you started, by pid.`
      );
    }
    pids.push(pid);
  }
  const foreign = foreignOf(pids, ctx);
  if (foreign !== undefined) {
    return block(
      'kill-foreign',
      `Process ${foreign} is not one this task started (not under its agent, without its ${TASK_MARKER_VAR}). Leave the user's and other tasks' processes alone; kill only processes you started.`
    );
  }
  return uncertain;
}

/** The first of `pids` that is not this task's; undefined when all are. */
function foreignOf(pids: number[], ctx: RuleContext): number | undefined {
  if (!pids.length) return undefined;
  const own = taskProcesses(pids, ctx.context, ctx.policy);
  return pids.find((pid) => !own.has(pid));
}

/**
 * pkill / killall: allowed when every process it would signal is the task's (2026-11-02,
 * bakery: `pkill yes` for 12 `yes` of its own, reparented to launchd). What it would
 * signal is asked of the system with the same arguments (pgrep, killall -s); words known only
 * at run time are not judged.
 */
function checkKillByName(name: 'pkill' | 'killall', cmd: SimpleCommand, ctx: RuleContext): Finding {
  const refuse = (why: string) =>
    block(
      'kill-foreign',
      `\`${name}\` ${why} Kill only processes you started: by pid (\`kill $!\` after starting one in the background, or \`kill <pid>\`), or by name when every match is this task's.`
    );
  const words = cmd.words.slice(1);
  // Words known only when it runs: what it would match cannot be asked, so it stays blocked
  // as before (\`name=node; pkill "$name"\` must not get past the check; AI review, 2026-11-02).
  if (words.some((word) => word.dynamic)) {
    return refuse('with words known only when it runs matches processes nobody can check first.');
  }
  let args = words.map((word) => word.text);
  // pkill's signal (pkill -9, pkill -TERM, pkill -SIGTERM) is not pgrep's.
  if (name === 'pkill' && /^-(\d+|[A-Z][A-Z0-9]*)$/.test(args[0] ?? '')) args = args.slice(1);
  if (!args.length) return null;
  // The hook itself is gone by the time the command runs.
  const pids = ctx.context.matches?.(name, args)?.filter((pid) => pid !== ctx.context.selfPid);
  if (!pids) return refuse("matches processes by name, the user's and other tasks' too.");
  const foreign = foreignOf(pids, ctx);
  if (foreign === undefined) return null;
  return refuse(
    `would also signal process ${foreign}, which is not this task's (the user's or another task's).`
  );
}

/** The hook's ancestors, and the agent among them (the nearest claude or codex). */
function agentOf(
  table: Map<number, ProcessEntry>,
  context: GuardContext
): { agent?: number; ancestors: Set<number> } {
  const ancestors = new Set<number>();
  let agent: number | undefined;
  let at = table.get(context.selfPid ?? process.pid)?.ppid;
  for (let hops = 0; at && at > 1 && hops < 64; hops++) {
    ancestors.add(at);
    const entry = table.get(at);
    if (!entry) break;
    if (!agent && /(^|\/)(claude|codex)(\s|$)|claude-code|@openai\/codex/.test(entry.command)) {
      agent = at;
    }
    at = entry.ppid;
  }
  return { agent, ancestors };
}

/** Whether `pid` runs under this task's agent (the agent itself excluded). */
export function ownProcess(pid: number, context: GuardContext): boolean {
  const table = context.processes?.() ?? [];
  if (!table.length) return false;
  const parent = new Map(table.map((entry) => [entry.pid, entry]));
  return underAgent(pid, parent, agentOf(parent, context).agent);
}

function underAgent(pid: number, table: Map<number, ProcessEntry>, agent?: number): boolean {
  if (!agent || pid === agent) return false;
  let cursor = table.get(pid)?.ppid;
  for (let hops = 0; cursor && cursor > 1 && hops < 64; hops++) {
    if (cursor === agent) return true;
    cursor = table.get(cursor)?.ppid;
  }
  return false;
}

/**
 * Which of `pids` are this task's: under its agent; carrying its marker (UNTETHER_TASK_ID,
 * inherited reparented or not); on the agent's terminal; or, when the system hides its
 * environment (a platform binary such as `yes`), in a shell group the task recorded or the
 * process group of a living one of those. Never the agent, nor the processes the hook runs under.
 */
export function taskProcesses(
  pids: number[],
  context: GuardContext,
  policy: Pick<GuardPolicy, 'taskId'>
): Set<number> {
  const own = new Set<number>();
  const list = context.processes?.() ?? [];
  const table = new Map(list.map((entry) => [entry.pid, entry]));
  const { agent, ancestors } = agentOf(table, context);
  const candidates = pids.filter(
    (pid) => pid > 1 && pid !== agent && !ancestors.has(pid) && pid !== context.selfPid
  );
  // The agent's terminal (the task session's pane): what still has it is the task's.
  const tty = agent ? table.get(agent)?.tty : undefined;
  const onTaskTerminal = (pid: number) =>
    !!tty && tty.startsWith('tty') && table.get(pid)?.tty === tty;
  const rest: number[] = [];
  for (const pid of candidates) {
    if (underAgent(pid, table, agent) || onTaskTerminal(pid)) own.add(pid);
    else rest.push(pid);
  }
  if (!rest.length || !context.marks) return own;
  // Their group leaders are judged too (kill of a child whose group is the task's).
  const leaders = new Map<number, number>();
  for (const pid of rest) {
    const pgid = table.get(pid)?.pgid;
    if (pgid && pgid > 1 && pgid !== pid) leaders.set(pid, pgid);
  }
  const marks = context.marks([...new Set([...rest, ...leaders.values()])]);
  // Only the marker proves it: a hidden environment (a platform binary) is not the task's on a
  // guess from its folder (another program may work there; AI review, 2026-11-02).
  const ownMark = (pid: number) => marks.get(pid)?.marker === policy.taskId;
  const groups = context.shellGroups?.() ?? new Map<number, number>();
  for (const pid of rest) {
    if (ownMark(pid)) {
      own.add(pid);
      continue;
    }
    // A process whose environment was read and carries another task's marker or none is not
    // the task's, whatever its group.
    if (marks.get(pid)?.marker !== undefined) continue;
    // Hidden (a platform binary): a shell group the task recorded proves it (task-processes.ts),
    // unless its leader is alive with an environment that says otherwise.
    const entry = table.get(pid);
    const leaderPid = entry?.pgid;
    const leaderMark = leaderPid && leaderPid !== pid ? marks.get(leaderPid) : undefined;
    if (
      entry &&
      (leaderMark?.marker === undefined || leaderMark.marker === policy.taskId) &&
      inShellGroup(entry, groups, leaderPid ? table.get(leaderPid) : undefined)
    ) {
      own.add(pid);
      continue;
    }
    const leader = leaders.get(pid);
    if (
      leader &&
      leader !== agent &&
      !ancestors.has(leader) &&
      (underAgent(leader, table, agent) || ownMark(leader))
    ) {
      own.add(pid);
    }
  }
  return own;
}

/** sudo. */
function checkSudo(cmd: SimpleCommand): Finding {
  const name = path.basename(cmd.words[0]?.text ?? '');
  if (name === 'sudo' || name === 'doas' || name === 'su' || name === 'pkexec') {
    return block(
      'sudo',
      `\`${name}\` runs as another user (root). Tasks never raise their privileges; if the task needs it, ask with \`ut task ask\`.`
    );
  }
  if (name === 'osascript' && cmd.words.some((w) => /administrator privileges/i.test(w.text))) {
    return block(
      'sudo',
      'osascript "with administrator privileges" asks for root. Tasks never raise their privileges.'
    );
  }
  return null;
}

// ─── Tools ─────────────────────────────────────────────────────────────────────────────────────

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const SHELL_TOOLS = new Set([
  'Bash',
  'shell',
  'local_shell',
  'exec_command',
  'container.exec',
  'unified_exec',
]);

/** The shell command of a tool call (Claude Bash, Codex's shell tools), or null. */
export function shellCommandOf(input: GuardInput): string | null {
  const tool = input.tool_name ?? '';
  const args = input.tool_input ?? {};
  if (!SHELL_TOOLS.has(tool) && typeof args.command !== 'string' && !Array.isArray(args.command)) {
    return null;
  }
  const command = args.command ?? args.cmd;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
    const argv = command as string[];
    // ["bash", "-lc", "…"]: the script is the command.
    if (
      argv.length >= 3 &&
      SHELLS.has(path.basename(argv[0])) &&
      /^-[a-z]*c[a-z]*$/.test(argv[1])
    ) {
      return argv[2];
    }
    return argv
      .map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`))
      .join(' ');
  }
  return null;
}

/** Files a Codex apply_patch writes, and the ones it deletes. */
function patchFiles(patch: string): { writes: string[]; deletes: string[] } {
  const writes: string[] = [];
  const deletes: string[] = [];
  for (const match of patch.matchAll(
    /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm
  )) {
    const file = (match[2] ?? match[3]).trim();
    writes.push(file);
    if (match[1] === 'Delete') deletes.push(file);
  }
  return { writes, deletes };
}

/** The files a non-shell tool call reads or writes. */
function toolFiles(input: GuardInput): { writes: string[]; reads: string[]; deletes?: string[] } {
  const tool = input.tool_name ?? '';
  const args = input.tool_input ?? {};
  const str = (value: unknown) => (typeof value === 'string' && value ? [value] : []);
  if (WRITE_TOOLS.has(tool))
    return { writes: [...str(args.file_path), ...str(args.notebook_path)], reads: [] };
  if (READ_TOOLS.has(tool))
    return {
      writes: [],
      reads: [...str(args.file_path), ...str(args.path), ...str(args.notebook_path)],
    };
  if (tool === 'apply_patch' || tool === 'ApplyPatch') {
    const patch =
      typeof args.input === 'string'
        ? args.input
        : typeof args.patch === 'string'
          ? args.patch
          : '';
    return { ...patchFiles(patch), reads: [] };
  }
  return { writes: [], reads: [] };
}

// ─── The decision ──────────────────────────────────────────────────────────────────────────────

const SHELL_RULES: Array<[GuardRuleId, (cmd: SimpleCommand, ctx: RuleContext) => Finding]> = [
  ['sudo', checkSudo],
  ['git-push', checkGitPush],
  ['git-rebase-skip', checkRebaseSkip],
  ['git-base', checkGitBase],
  ['git-base', checkBaseShell],
  ['private-paths', checkPrivateShell],
  ['delete-outside', checkDelete],
  ['kill-foreign', checkKill],
];

function compile(patterns: string[] | undefined): RegExp[] {
  const out: RegExp[] = [];
  for (const pattern of patterns ?? []) {
    try {
      out.push(new RegExp(pattern));
    } catch {
      // An invalid pattern never matches (the settings refuse one; a hand edit may not).
    }
  }
  return out;
}

/** Whether a tool call is blocked, and why; null lets it run. */
export function decide(
  input: GuardInput,
  policy: GuardPolicy,
  context: GuardContext = {}
): GuardDecision | null {
  const off = new Set(policy.off ?? []);
  const real = (file: string, followLast = true) => realOf(file, context.realpath, followLast);
  const root = real(path.resolve(policy.root));
  const prot = protectedPaths(policy.home);
  // The protected folders where they really are too (~/.claude may be a symlink).
  const withReal = (dirs: string[]) => [...new Set([...dirs, ...dirs.map((dir) => real(dir))])];
  const ctx: RuleContext = {
    policy,
    context,
    root,
    prot: { noWrite: withReal(prot.noWrite), secrets: withReal(prot.secrets) },
    temps: withReal(tempRoots(context)),
    baseRoots:
      policy.baseRoot && path.resolve(policy.baseRoot) !== path.resolve(policy.root)
        ? withReal([path.resolve(policy.baseRoot)])
        : [],
  };
  const base = input.cwd && path.isAbsolute(input.cwd) ? input.cwd : root;
  // Codex's exec_command runs in its own workdir, not the session's folder.
  const args = input.tool_input ?? {};
  const workdir = typeof args.workdir === 'string' && args.workdir ? args.workdir : undefined;
  const cwd = workdir ? path.resolve(base, workdir) : base;
  const shell = shellCommandOf(input);
  if (shell !== null) {
    if (compile(policy.allow).some((re) => re.test(shell))) return null;
    const denied = compile(policy.deny).find((re) => re.test(shell));
    if (denied) {
      return {
        rule: 'project',
        reason: `This project blocks commands matching /${denied.source}/ for its tasks (project setting guardDeny).`,
      };
    }
    // A block anywhere wins over a doubt earlier in the same command line.
    let uncertain: GuardDecision | null = null;
    for (const cmd of readCommands(shell, cwd, policy.home)) {
      const rules: typeof SHELL_RULES = cmd.words.length
        ? SHELL_RULES
        : SHELL_RULES.filter(([id]) => id === 'private-paths');
      for (const [id, rule] of rules) {
        if (off.has(id)) continue;
        const finding = rule(cmd, ctx);
        if (finding?.uncertain) uncertain ??= finding;
        else if (finding) return finding;
      }
    }
    return uncertain;
  }
  const { writes, reads, deletes = [] } = toolFiles(input);
  const expand = (file: string) =>
    file.startsWith('~/') ? path.join(policy.home, file.slice(2)) : file;
  const abs = (file: string) => path.resolve(cwd, expand(file));
  const phys = (file: string, followLast = true) =>
    physicalPath(cwd, expand(file), context.realpath, followLast);
  // apply_patch's Delete File: the rules of rm.
  if (!off.has('delete-outside')) {
    for (const file of deletes) {
      const finding = deleteTarget('apply_patch Delete File', file, phys(file, false), ctx);
      if (finding) return finding;
    }
  }
  // Write / Edit and Add / Update / Delete File into the main checkout.
  if (!off.has('git-base')) {
    for (const file of writes) {
      const finding = baseWrite([abs(file), phys(file)], ctx, `${input.tool_name} would change`);
      if (finding) return finding;
    }
  }
  if (off.has('private-paths')) return null;
  // Add / Update / Delete File and Write / Edit: the rules of Write.
  for (const file of [...writes, ...reads]) {
    for (const candidate of new Set([abs(file), phys(file)])) {
      if (isSecret(candidate, ctx.prot)) {
        return block(
          'private-paths',
          `${displayPath(candidate, policy.home)} holds credentials: tasks never read or change them. If the task needs one, ask with \`ut task ask\`.`
        );
      }
      if (writes.includes(file) && isNoWrite(candidate, ctx.prot)) {
        return block(
          'private-paths',
          `${displayPath(candidate, policy.home)} is Untether's or the agents' own state: tasks don't write there. Change files inside your task folder ${root}.`
        );
      }
    }
  }
  return null;
}

/** One line of the blocked log (what the task record and the review show). */
export interface GuardBlockEntry {
  at: string;
  /**
   * guard-error: the guard itself failed and let the call run; uncertain: it could not tell
   * (a path or pid known only at run time) and let it run. Neither was blocked.
   */
  rule: GuardRuleId | 'project' | 'guard-error' | 'uncertain';
  tool: string;
  /** The command or file, cut to size. */
  what: string;
  reason: string;
}

export const GUARD_WHAT_MAX = 300;

/** What a tool call was about, for the log: its command, else its file. */
export function describeCall(input: GuardInput): string {
  const shell = shellCommandOf(input);
  const args = input.tool_input ?? {};
  const text =
    shell ??
    (typeof args.file_path === 'string'
      ? args.file_path
      : typeof args.path === 'string'
        ? args.path
        : JSON.stringify(args));
  return text.length > GUARD_WHAT_MAX ? `${text.slice(0, GUARD_WHAT_MAX)}…` : text;
}

/**
 * Share with phone: the line typed into the agent's own tab to reopen it, once it has closed.
 *
 *   [<reload>; ]cd <cwd> && [UNTETHER_CONTROL_DIR=<dir> ][ut ]<agent> --resume <id> <kept>
 *
 * - <reload>: only with the `shell` launcher. The tab's startup file is read again, so the
 *   user's own function (which already wraps the agent with ut) is the current one; skipped
 *   when the file is missing, and joined with `;` so a failing last line doesn't block.
 * - UNTETHER_CONTROL_DIR: only when this server's control dir isn't the default one, so the
 *   reopened agent registers with this server (QA, several instances).
 * - ut: the `ut` launcher (default) types `ut`, or macShareUtPath when set.
 * - <agent>, rule R-BIN: the running process's own args[0], never anything the server looks
 *   up itself. A bare name (`claude`) is typed bare and the tab's shell resolves it, as it did
 *   when the user started it (function, alias or PATH). An absolute path that still exists is
 *   typed quoted. Anything else, such as a versioned binary an update removed, becomes the
 *   agent's command name. With the `shell` launcher, an absolute path that is only where the
 *   agent's own command leads (`…/claude`, or a versioned Claude under
 *   ~/.local/share/claude/versions/) is typed as that bare name, so the user's function runs.
 *   The server never resolves agents through its own PATH, `npm root -g`, Homebrew or a
 *   guessed install, and never runs an agent binary (a stale global Codex was quarantined by
 *   XProtect when it was run for a version check).
 *
 * The options come from `ps -o args`, which joins the arguments with spaces and loses their
 * boundaries: only options from the tables below are carried, with values that can't hide a
 * space. Free-text options are dropped and reported (argv-inexact); unknown ones are dropped
 * with a following non-option word, which may be their value. A positional prompt is never
 * typed again.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MacAgentKind } from '../../../shared/mac-sessions.js';
import {
  isMacShareConversationId,
  type MacShareLauncher,
  type MacShareShell,
  type MacShareWarning,
} from '../../../shared/mac-share.js';
import { quoteFor, shellFromArg0, unsafeReason } from './shell-quote.js';

/** Longer lines are refused: a tab's line editor and a human reading it both suffer. */
export const MAX_RELAUNCH_LINE_BYTES = 2048;

export interface RelaunchInput {
  agent: MacAgentKind;
  /** The agent's `ps -o args=`: args[0] and its options, joined with spaces. */
  args: string;
  conversationId: string;
  /** The folder the agent reported; absolute, and it must still exist. */
  cwd: string;
  /** args[0] of the tab's shell (the agent's parent): `-zsh`, `/bin/bash`… */
  shell: string;
  launcher: MacShareLauncher;
  utPath?: string;
  /** This server's control dir, and the one `ut` uses when nothing says otherwise. */
  controlDir: string;
  defaultControlDir: string;
}

/** What the builder may ask of the filesystem: never more than a stat. */
export interface RelaunchFs {
  isExecutableFile(file: string): boolean;
  isDirectory(dir: string): boolean;
}

export const realRelaunchFs: RelaunchFs = {
  isExecutableFile(file) {
    try {
      if (!fs.statSync(file).isFile()) return false;
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory(dir) {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
};

export type RelaunchError =
  | 'agent-not-supported'
  | 'no-conversation'
  | 'cwd-missing'
  | 'unsupported-shell'
  | 'unsafe-value';

export type RelaunchResult =
  | {
      ok: true;
      command: string;
      shell: MacShareShell;
      /** How the agent is named in the line (R-BIN). */
      agentWord: string;
      /** Option names carried over, and dropped (each once, in order). */
      kept: string[];
      dropped: string[];
      droppedPrompt: boolean;
      warnings: MacShareWarning[];
    }
  | { ok: false; error: RelaunchError; shellName?: string };

type FlagKind =
  /** Replaced by our own --resume: dropped without a word. */
  | 'replaced'
  | 'replaced-value'
  | 'replaced-optional'
  /** A mode or one-off that must not come back: dropped and listed. */
  | 'never'
  | 'never-value'
  | 'never-optional'
  | 'never-variadic'
  /** Carried once. */
  | 'bool'
  /** Carried when its one value is a plain token. */
  | 'value'
  /** Free text `ps` can't give back exactly: dropped, listed, argv-inexact. */
  | 'inexact';

/**
 * Flags a `claude --help` lists that the table below doesn't know (Untether's doctor reports
 * them after a Claude Code update: unknown ones are dropped on relaunch, with the next word).
 */
export function unknownClaudeFlags(help: string): string[] {
  const listed = new Set<string>();
  for (const line of help.split('\n')) {
    // An option's own line is indented a little; its description's lines a lot.
    const match = /^ {1,4}(-[A-Za-z],\s+)?(--[A-Za-z][A-Za-z0-9-]*)/.exec(line);
    if (match) listed.add(match[2]);
  }
  return Array.from(listed).filter(
    (flag) => !CLAUDE_FLAGS.has(flag) && flag !== '--help' && flag !== '--version'
  );
}

function table(entries: Record<FlagKind, string[]>): Map<string, FlagKind> {
  const map = new Map<string, FlagKind>();
  for (const [kind, flags] of Object.entries(entries) as Array<[FlagKind, string[]]>) {
    for (const flag of flags) map.set(flag, kind);
  }
  return map;
}

/** Claude Code 2.1.304 (`claude --help`; 2026-10-20 review: six flags it didn't know). */
const CLAUDE_FLAGS = table({
  replaced: ['-c', '--continue', '--fork-session'],
  'replaced-value': ['--session-id'],
  'replaced-optional': ['-r', '--resume'],
  never: [
    '-p',
    '--print',
    '--bg',
    '--background',
    '--desktop',
    '--forward-subagent-text',
    '--include-hook-events',
    '--include-partial-messages',
    '--replay-user-messages',
    '--no-session-persistence',
    // Its value only ever comes with `=`.
    '--tmux',
  ],
  'never-value': [
    '--environment',
    '--output-format',
    '--input-format',
    '--json-schema',
    '--max-budget-usd',
    '--max-turns',
    '--debug-file',
  ],
  'never-optional': ['-w', '--worktree', '--from-pr', '--teleport', '--cloud'],
  'never-variadic': ['--file'],
  bool: [
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--strict-mcp-config',
    '--ide',
    '--chrome',
    '--no-chrome',
    '--verbose',
    '--bare',
    '--safe-mode',
    '--restricted',
    '--brief',
    '--disable-slash-commands',
    '--ax-screen-reader',
    '--exclude-dynamic-system-prompt-sections',
  ],
  value: [
    '--model',
    '--fallback-model',
    '--permission-mode',
    '--effort',
    '--agent',
    '--autocompact',
    '--setting-sources',
    '--system-prompt-snapshot',
    '--plugin-dir',
    '--plugin-url',
    '--permission-prompts',
    '--remote-control-session-name-prefix',
  ],
  inexact: [
    '--add-dir',
    '--mcp-config',
    '--allowedTools',
    '--allowed-tools',
    '--disallowedTools',
    '--disallowed-tools',
    '--tools',
    '--betas',
    '--settings',
    '--append-system-prompt',
    '--system-prompt',
    '--agents',
    '-n',
    '--name',
    '-d',
    '--debug',
    '--remote-control',
    '--prompt-suggestions',
  ],
});

/** A value carried over: one plain token, which a lost argument boundary can't hide in. */
const PLAIN_VALUE = /^[A-Za-z0-9._:/@+=,[\]-]{1,200}$/;

function isPlainValue(value: string): boolean {
  return PLAIN_VALUE.test(value) && !value.startsWith('-') && !value.includes('://');
}

interface ParsedFlags {
  /** Literal flag names, each followed by its value when it has one. */
  carried: Array<{ flag: string; value?: string }>;
  kept: string[];
  dropped: string[];
  droppedPrompt: boolean;
  inexact: boolean;
}

/**
 * Reads the options after args[0] (`tokens`, already split on spaces) against `flags`.
 */
function parseFlags(tokens: string[], flags: Map<string, FlagKind>): ParsedFlags {
  const out: ParsedFlags = {
    carried: [],
    kept: [],
    dropped: [],
    droppedPrompt: false,
    inexact: false,
  };
  const seen = new Set<string>();
  const drop = (name: string) => {
    if (!out.dropped.includes(name)) out.dropped.push(name);
  };
  const keep = (flag: string, value?: string) => {
    const key = value === undefined ? flag : `${flag}\0${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.carried.push(value === undefined ? { flag } : { flag, value });
    if (!out.kept.includes(flag)) out.kept.push(flag);
  };
  const isOption = (token: string | undefined) => token?.startsWith('-') === true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      if (i + 1 < tokens.length) out.droppedPrompt = true;
      break;
    }
    if (!isOption(token) || token === '-') {
      out.droppedPrompt = true;
      continue;
    }
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    const inline = eq > 0 ? token.slice(eq + 1) : undefined;
    const kind = flags.get(name);
    // The next word, when it isn't an option and the value wasn't given with `=`.
    const takeNext = (): string | undefined => {
      if (inline !== undefined) return inline;
      if (i + 1 < tokens.length && !isOption(tokens[i + 1])) return tokens[++i];
      return undefined;
    };
    const takeAll = () => {
      while (i + 1 < tokens.length && !isOption(tokens[i + 1])) i++;
    };
    switch (kind) {
      case 'replaced':
        break;
      case 'replaced-value':
      case 'replaced-optional':
        takeNext();
        break;
      case 'never':
        drop(name);
        break;
      case 'never-value':
      case 'never-optional':
        takeNext();
        drop(name);
        break;
      case 'never-variadic':
        takeAll();
        drop(name);
        break;
      case 'bool':
        if (inline !== undefined) drop(name);
        else keep(name);
        break;
      case 'value': {
        const value = takeNext();
        if (value !== undefined && isPlainValue(value)) keep(name, value);
        else drop(name);
        break;
      }
      case 'inexact':
        takeAll();
        drop(name);
        out.inexact = true;
        break;
      default:
        // Unknown: it may take a value, so the next plain word goes with it.
        if (inline === undefined && i + 1 < tokens.length && !isOption(tokens[i + 1])) i++;
        drop(name);
    }
  }
  return out;
}

const AGENT_WORD = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;

/**
 * R-BIN: how the agent is named in the line, and how many tokens of `tokens` that took.
 * An absolute path may contain spaces, which `ps` doesn't mark: the longest run of tokens that
 * names an existing executable file wins.
 */
function agentWord(
  tokens: string[],
  agent: MacAgentKind,
  fsx: RelaunchFs
): { word: string; quoted: boolean; used: number } {
  const first = tokens[0] ?? '';
  if (first.startsWith('/')) {
    for (let end = tokens.length; end >= 1; end--) {
      const candidate = tokens.slice(0, end).join(' ');
      if (fsx.isExecutableFile(candidate)) return { word: candidate, quoted: true, used: end };
    }
    return { word: agent, quoted: false, used: 1 };
  }
  if (AGENT_WORD.test(first)) return { word: first, quoted: false, used: 1 };
  return { word: agent, quoted: false, used: 1 };
}

/** Where Claude Code's native installer keeps its binaries, one file per version. */
const CLAUDE_VERSIONS_DIR = /\/\.local\/share\/claude\/versions\/[^/]+$/;

/**
 * Whether an absolute args[0] is just where the user's own `<agent>` command led: a file named
 * like the agent (`/…/bin/claude`), or a versioned Claude under ~/.local/share/claude/versions/
 * (what `~/.local/bin/claude` links to). A wrapper function that runs `ut "$(whence -p claude)"`
 * leaves such a path behind; typing it with the `shell` launcher would skip that function.
 */
function isAgentCommandPath(file: string, agent: MacAgentKind): boolean {
  if (path.basename(file) === agent) return true;
  return agent === 'claude' && CLAUDE_VERSIONS_DIR.test(file);
}

/** The startup file read again by the `shell` launcher, skipped when missing. */
const RELOAD: Record<MacShareShell, string> = {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell text, expanded by the tab's zsh
  zsh: '[ -f "${ZDOTDIR:-$HOME}/.zshrc" ] && source "${ZDOTDIR:-$HOME}/.zshrc"',
  bash: '[ -f ~/.bashrc ] && source ~/.bashrc',
  fish: 'test -f ~/.config/fish/config.fish && source ~/.config/fish/config.fish',
};

export function buildRelaunchCommand(
  input: RelaunchInput,
  fsx: RelaunchFs = realRelaunchFs
): RelaunchResult {
  // Only Claude is shared (2026-11-11: the Codex preparation, never reachable, is gone).
  if (input.agent !== 'claude') return { ok: false, error: 'agent-not-supported' };
  if (!isMacShareConversationId(input.conversationId)) {
    return { ok: false, error: 'no-conversation' };
  }
  const detected = shellFromArg0(input.shell);
  if (!detected.shell) return { ok: false, error: 'unsupported-shell', shellName: detected.name };
  const shell = detected.shell;

  const { cwd, utPath, controlDir, defaultControlDir } = input;
  for (const value of [cwd, utPath ?? '', controlDir]) {
    // `://` makes zsh's url-quote-magic rewrite the typed word, quotes or not.
    if (unsafeReason(value) || value.includes('://')) return { ok: false, error: 'unsafe-value' };
  }
  if (!path.isAbsolute(cwd) || !fsx.isDirectory(cwd)) return { ok: false, error: 'cwd-missing' };
  if (utPath !== undefined && !path.isAbsolute(utPath)) return { ok: false, error: 'unsafe-value' };

  // Splitting on spaces is all `ps` allows; control characters in it are refused below.
  const tokens = input.args.split(' ').filter((token) => token !== '');
  const named = agentWord(tokens, input.agent, fsx);
  // The `shell` launcher exists so the user's own function (which wraps the agent with ut)
  // runs: an absolute path to the agent itself would bypass it, so its command name is typed.
  if (input.launcher === 'shell' && named.quoted && isAgentCommandPath(named.word, input.agent)) {
    named.word = input.agent;
    named.quoted = false;
  }
  const parsed = parseFlags(tokens.slice(named.used), CLAUDE_FLAGS);
  for (const { value } of parsed.carried) {
    if (value !== undefined && unsafeReason(value)) return { ok: false, error: 'unsafe-value' };
  }
  if (unsafeReason(named.word)) return { ok: false, error: 'unsafe-value' };

  const q = (value: string) => quoteFor(shell, value);
  const parts: string[] = [];
  if (input.launcher === 'shell') parts.push(`${RELOAD[shell]};`);
  parts.push('cd', q(cwd), '&&');
  if (path.resolve(controlDir) !== path.resolve(defaultControlDir)) {
    parts.push(`UNTETHER_CONTROL_DIR=${q(controlDir)}`);
  }
  if (input.launcher === 'ut') parts.push(utPath ? q(utPath) : 'ut');
  parts.push(named.quoted ? q(named.word) : named.word);
  parts.push('--resume', q(input.conversationId));
  for (const { flag, value } of parsed.carried) {
    parts.push(flag);
    if (value !== undefined) parts.push(q(value));
  }
  const command = parts.join(' ');
  if (Buffer.byteLength(command, 'utf8') > MAX_RELAUNCH_LINE_BYTES) {
    return { ok: false, error: 'unsafe-value' };
  }

  const warnings: MacShareWarning[] = [];
  if (parsed.dropped.length > 0) warnings.push('flags-dropped');
  if (parsed.inexact) warnings.push('argv-inexact');
  return {
    ok: true,
    command,
    shell,
    agentWord: named.word,
    kept: parsed.kept,
    dropped: parsed.dropped,
    droppedPrompt: parsed.droppedPrompt,
    warnings,
  };
}

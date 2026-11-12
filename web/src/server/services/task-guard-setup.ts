/**
 * Puts the command guard (task-guard.ts) on a task's agent, and only there: the user's
 * ~/.claude/settings.json, ~/.codex/config.toml and every session that is not a task stay as
 * they are.
 *
 * Per task, in ~/.untether/agent-hooks/tasks/<task id>/: `policy.json` (its folder, branches,
 * the project's guard settings), `blocked.jsonl` (what the hook blocked, read back into the task's
 * record) and, for Claude, `claude-settings.json`: Untether's event hooks (claude-hooks.ts) plus
 * the guard's PreToolUse hook, passed with `--settings` (the spawn rewriter leaves a command
 * with Untether's own settings as it is and still counts it hooked).
 *
 * Codex (0.164 has PreToolUse hooks with Claude's input shape): `-c hooks.PreToolUse=[…]` and
 * `--dangerously-bypass-hook-trust`, without which Codex skips a hook nobody reviewed in its TUI.
 * That flag lets the user's own unreviewed hooks run too in that session, and `-c` replaces the
 * PreToolUse hooks of the user's config.toml for it. A Codex without the flag (older) runs
 * unguarded, said in the log and on the task.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type SavingAutoOff, taskSavingOn } from '../../shared/saving-features.js';
import type { TaskRecord } from '../../shared/tasks.js';
import {
  claudeHookFiles,
  ensureClaudeHookFiles,
  hookSettings,
  shellQuote,
} from './claude-hooks.js';
import {
  type GuardBlockEntry,
  type GuardPolicy,
  TOOL_HOLD_FILE,
  TOOL_HOLD_MAX_MS,
} from './task-guard.js';
import { agentExecutable, type TaskCommandGuard } from './task-launcher.js';
import { SHELL_GROUPS_DIR } from './task-processes.js';
import { pruningNote, pruningSettings, type ToolPruning } from './tool-pruning.js';

/** Seconds Claude / Codex give the guard (it takes about 0.1 s). */
const GUARD_TIMEOUT_S = 15;
/** How a session without its guard is recorded in the task's log (unguarded). */
const UNGUARDED_REASON = 'the agent runs without the command guard';

export interface TaskGuardSettings {
  guardOff?: string[];
  guardDeny?: string[];
  guardAllow?: string[];
  /** Summarised test/check output for Claude task agents (task-output.ts). */
  summarizeOutput?: boolean;
  summarizeCommands?: string[];
  /** What the quality guard turned off (a task from before metrics falls back on it). */
  savingAutoOff?: SavingAutoOff[];
  checkCommand?: string;
  fastCheckCommand?: string;
  relatedTestCommand?: string;
}

export interface TaskGuardFiles {
  dir: string;
  policy: string;
  blocked: string;
  claudeSettings: string;
  /** The shell groups its Bash commands recorded (task-processes.ts). */
  shellGroups: string;
  /** Its tool list, fixed at its first start (tool-pruning.ts). */
  toolProfile: string;
  /** The full output of its summarised test/check commands (task-output.ts), outside git. */
  output: string;
}

export function taskGuardFiles(taskId: string, untetherDir: string): TaskGuardFiles {
  const dir = path.join(
    untetherDir,
    'agent-hooks',
    'tasks',
    taskId.replace(/[^A-Za-z0-9_-]/g, '_')
  );
  return {
    dir,
    policy: path.join(dir, 'policy.json'),
    blocked: path.join(dir, 'blocked.jsonl'),
    claudeSettings: path.join(dir, 'claude-settings.json'),
    shellGroups: path.join(dir, SHELL_GROUPS_DIR),
    toolProfile: path.join(dir, 'tool-profile.json'),
    output: path.join(dir, 'output'),
  };
}

/** tsx's loader flags of this process (a dev server), to run the hook's .ts the same way. */
function loaderArgs(execArgv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    if ((arg === '--require' || arg === '--import' || arg === '--loader') && execArgv[i + 1]) {
      out.push(arg, execArgv[++i]);
    } else if (/^--(require|import|loader)=/.test(arg)) {
      out.push(arg);
    }
  }
  return out;
}

/**
 * How the hook is run: the app's binary (`untether guard-hook`), or this Node with its loader on
 * task-guard-hook.ts (a dev server, 0.1 s a call), or this Node on the server's entry.
 */
export function guardHookCommand(
  options: {
    sea?: boolean;
    execPath?: string;
    execArgv?: readonly string[];
    entry?: string;
    hookSource?: string;
  } = {}
): string[] {
  const execPath = options.execPath ?? process.execPath;
  const sea = options.sea ?? process.env.UNTETHER_SEA === 'true';
  if (sea) return [execPath, 'guard-hook'];
  const hookSource = options.hookSource ?? path.join(__dirname, 'task-guard-hook.ts');
  if (fs.existsSync(hookSource)) {
    return [execPath, ...loaderArgs(options.execArgv ?? process.execArgv), hookSource];
  }
  return [execPath, options.entry ?? process.argv[1], 'guard-hook'];
}

/** The hook as one shell command line for `policy`. */
export function guardHookLine(hook: readonly string[], policyPath: string): string {
  return [...hook, policyPath].map(shellQuote).join(' ');
}

/**
 * What only serves a human watching the terminal, off in a task's session (2026-11-03): nobody
 * watches it, and some of it costs tokens. Prompt suggestions send a request after every turn,
 * the away recap one after an idle spell; the spinner tips and the quality survey are screen
 * noise (the survey a prompt nobody answers). Each key's per-session variable is set too, so
 * one exported in the shell Untether started from can't turn it back on.
 * Left on on purpose: the session title (CLAUDE_CODE_DISABLE_TERMINAL_TITLE would also stop
 * it; Untether shows it as the session's claudeTitle), nonessential traffic (that switch also
 * turns tools off) and everything about the agent's work: model, effort, thinking, compaction
 * (idle compaction included), tools.
 */
export const TASK_UNATTENDED_CLAUDE_SETTINGS = {
  promptSuggestionEnabled: false,
  awaySummaryEnabled: false,
  spinnerTipsEnabled: false,
  feedbackSurveyRate: 0,
  env: {
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  },
} as const;

/** The guard's SessionStart hook line: the shell-group record into Claude's env file. */
export function shellEnvHookLine(hook: readonly string[], policyPath: string): string {
  return [...hook, '--shell-env', policyPath].map(shellQuote).join(' ');
}

/**
 * The Claude settings of a guarded task: Untether's event hooks plus the guard first, its
 * SessionStart hook that has every Bash shell record its group (`shellEnvLine`), and the
 * watcher-only features off (TASK_UNATTENDED_CLAUDE_SETTINGS).
 */
export function guardedClaudeSettings(
  eventScript: string,
  hookLine: string,
  shellEnvLine?: string
): object {
  const events = hookSettings(eventScript) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
  };
  const guard = { type: 'command', command: hookLine, timeout: GUARD_TIMEOUT_S };
  events.hooks.PreToolUse = [{ matcher: '*', hooks: [guard] }, ...(events.hooks.PreToolUse ?? [])];
  if (shellEnvLine) {
    const shellEnv = { type: 'command', command: shellEnvLine, timeout: GUARD_TIMEOUT_S };
    events.hooks.SessionStart = [{ hooks: [shellEnv] }, ...(events.hooks.SessionStart ?? [])];
  }
  return { ...structuredClone(TASK_UNATTENDED_CLAUDE_SETTINGS), ...events };
}

/** Codex's flags for the guard (its TOML: a JSON string is a TOML basic string). */
export function codexGuardArgs(hookLine: string): string[] {
  // `-c` here is Codex's config override (TOML key=value), not a shell script; hookLine is a
  // JSON-quoted TOML string and Codex runs it as the hook command it already is.
  const hooksToml = `hooks.PreToolUse=[{matcher="*", hooks=[{type="command", command=${JSON.stringify(hookLine)}, timeout=${GUARD_TIMEOUT_S}}]}]`;
  return ['--dangerously-bypass-hook-trust', '-c', hooksToml];
}

const codexSupport = new Map<string, boolean>();

/** Whether this Codex takes --dangerously-bypass-hook-trust (asked once per program). */
export function codexTakesHookTrust(program: string): boolean {
  const known = codexSupport.get(program);
  if (known !== undefined) return known;
  let ok = false;
  try {
    const help = execFileSync(program, ['--help'], { encoding: 'utf8', timeout: 10_000 });
    ok = help.includes('--dangerously-bypass-hook-trust');
  } catch {
    ok = false;
  }
  codexSupport.set(program, ok);
  return ok;
}

function writeFile(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface TaskGuardOptions {
  untetherDir?: string;
  /** The task's project's guard settings. */
  settings?: (task: TaskRecord) => TaskGuardSettings | undefined;
  hook?: string[];
  log?: (message: string) => void;
  home?: string;
  /** Whether a Codex program takes --dangerously-bypass-hook-trust (tests). */
  codexTakesHookTrust?: (program: string) => boolean;
  /**
   * The task's tool list (tool-pruning.ts, 2026-11-03): what its Claude goes without, fixed
   * at its first start; null = everything.
   */
  toolProfile?: (task: TaskRecord) => ToolPruning | null;
  /**
   * The Untether CLI of this server (`<cli> check-slot …`), for the agents' heavy checks
   * (check-slot-wrap.ts); none: they run without a slot.
   */
  cli?: () => string[] | undefined;
  /**
   * The `/model` picker settings for a provider task (model-providers.ts), merged into its
   * Claude settings so `/model` offers only the provider's models; undefined for a plain task.
   */
  providerSettings?: (task: TaskRecord) => object | undefined;
}

export type TaskGuard = ReturnType<typeof createTaskGuard>;

/** Writes the task's guard files; null when they can't be written (the task runs unguarded). */
export function createTaskGuard(options: TaskGuardOptions = {}) {
  const untetherDir = options.untetherDir ?? path.join(os.homedir(), '.untether');
  const home = options.home ?? os.homedir();
  const log = options.log ?? (() => {});
  const hook = () => options.hook ?? guardHookCommand();

  const prepare = (task: TaskRecord, root: string): TaskCommandGuard | null => {
    const files = taskGuardFiles(task.id, untetherDir);
    try {
      fs.mkdirSync(files.dir, { recursive: true, mode: 0o700 });
      const settings = options.settings?.(task) ?? {};
      const policy: GuardPolicy = {
        taskId: task.id,
        root,
        ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
        ...(task.branch ? { branch: task.branch } : {}),
        ...(task.repoPath && task.worktreePath ? { baseRoot: task.repoPath } : {}),
        home,
        ...(settings.guardOff?.length ? { off: settings.guardOff } : {}),
        ...(settings.guardDeny?.length ? { deny: settings.guardDeny } : {}),
        ...(settings.guardAllow?.length ? { allow: settings.guardAllow } : {}),
        blockedLog: files.blocked,
      };
      // Heavy check runs of its agent take a check slot (check-slot-wrap.ts): rewritten for
      // Claude, refused with the command to use for Codex.
      const agentName = agentExecutable(task.command).name;
      let cli: string[] | undefined;
      try {
        cli = options.cli?.();
      } catch {
        cli = undefined;
      }
      if (cli?.length && (agentName === 'claude' || agentName === 'codex')) {
        const check = settings.checkCommand?.trim();
        const related = settings.relatedTestCommand?.trim();
        policy.checkSlot = {
          cli,
          mode: agentName === 'claude' ? 'wrap' : 'ask',
          ...(check ? { checks: [check] } : {}),
          ...(related ? { related } : {}),
        };
      }
      // Claude runs its env file in each Bash shell and reads a PreToolUse hook's updatedInput;
      // Codex does neither (so no shell groups, no summaries).
      if (agentExecutable(task.command).name === 'claude') {
        policy.recordShellGroups = true;
        // As the task recorded it (holdout, the quality guard: shared/saving-features.ts).
        if (taskSavingOn(task, 'test-summary', settings)) {
          const checks = [settings.checkCommand, settings.fastCheckCommand].filter(
            (check): check is string => typeof check === 'string' && check.trim() !== ''
          );
          policy.summarize = {
            logDir: files.output,
            runner: hook(),
            ...(checks.length ? { checks } : {}),
            ...(settings.summarizeCommands?.length ? { patterns: settings.summarizeCommands } : {}),
          };
        }
      }
      writeFile(files.policy, `${JSON.stringify(policy, null, 2)}\n`);
      const hookLine = guardHookLine(hook(), files.policy);
      const events = ensureClaudeHookFiles(claudeHookFiles(untetherDir), log);
      if (!events) throw new Error('the event hooks could not be written');
      const { index, name } = agentExecutable(task.command);
      // Its tool list goes in the same file (the hooks stay: the pruning has no hooks key).
      let pruning: ToolPruning | null = null;
      if (name === 'claude') {
        try {
          pruning = options.toolProfile?.(task) ?? null;
        } catch (error) {
          log(`[tool-pruning] ${task.id}: every tool kept: ${error}`);
        }
      }
      // A provider task's `/model` picker (model-providers.ts): only the provider's models.
      const providerSettings = name === 'claude' ? options.providerSettings?.(task) : undefined;
      writeFile(
        files.claudeSettings,
        `${JSON.stringify(
          {
            ...guardedClaudeSettings(
              events.script,
              hookLine,
              policy.recordShellGroups ? shellEnvHookLine(hook(), files.policy) : undefined
            ),
            ...(pruning ? pruningSettings(pruning) : {}),
            ...(providerSettings ?? {}),
          },
          null,
          2
        )}\n`
      );
      const takesHooks =
        name === 'codex' &&
        (options.codexTakesHookTrust ?? codexTakesHookTrust)(task.command[index]);
      return {
        claudeSettings: files.claudeSettings,
        codexArgs: takesHooks ? codexGuardArgs(hookLine) : null,
        ...(pruning && pruningNote(pruning) ? { toolNote: pruningNote(pruning) as string } : {}),
      };
    } catch (error) {
      log(
        `[task-guard] ${task.id}: guard files could not be written, the task runs unguarded: ${error}`
      );
      return null;
    }
  };

  /** What the hook blocked for the task so far (oldest first), from its log. */
  const blocked = (taskId: string): GuardBlockEntry[] => {
    let text = '';
    try {
      text = fs.readFileSync(taskGuardFiles(taskId, untetherDir).blocked, 'utf8');
    } catch {
      return [];
    }
    const entries: GuardBlockEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as GuardBlockEntry;
        if (typeof entry.rule === 'string' && typeof entry.reason === 'string') entries.push(entry);
      } catch {
        // a line cut by a crash
      }
    }
    return entries;
  };

  /** The blocked log's size and time: read again only when it changed. */
  const blockedStamp = (taskId: string): string | null => {
    try {
      const stat = fs.statSync(taskGuardFiles(taskId, untetherDir).blocked);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  };

  /** The task runs without its guard: logged, and on its record as a guard-error entry. */
  const unguarded = (task: TaskRecord, why: string): void => {
    log(`[task-guard] ${task.id}: runs WITHOUT the command guard: ${why}`);
    const files = taskGuardFiles(task.id, untetherDir);
    const entry: GuardBlockEntry = {
      at: new Date().toISOString(),
      rule: 'guard-error',
      tool: '-',
      what: '',
      reason: `${UNGUARDED_REASON}: ${why}`,
    };
    try {
      fs.mkdirSync(files.dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(files.blocked, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // logged above
    }
  };

  /**
   * Holds the task's agent's tool calls back (TOOL_HOLD_FILE, at most TOOL_HOLD_MAX_MS) and
   * returns what lifts the hold; null when its session is not guarded (no hook would wait).
   */
  const holdTools = (taskId: string): (() => void) | null => {
    const files = taskGuardFiles(taskId, untetherDir);
    const file = path.join(files.dir, TOOL_HOLD_FILE);
    try {
      if (!fs.existsSync(files.policy)) return null;
      // A session that runs without its guard (an older Codex) has no hook that would wait.
      if (blocked(taskId).some((entry) => entry.reason.startsWith(UNGUARDED_REASON))) return null;
      fs.writeFileSync(file, JSON.stringify({ until: Date.now() + TOOL_HOLD_MAX_MS }), {
        mode: 0o600,
      });
    } catch (error) {
      log(`[task-guard] ${taskId}: its tools could not be held: ${error}`);
      return null;
    }
    return () => fs.rmSync(file, { force: true });
  };

  return { prepare, unguarded, blocked, blockedStamp, holdTools, untetherDir };
}

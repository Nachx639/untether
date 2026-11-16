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
 * PreToolUse hooks of the user's config.toml for it. A Codex whose --help answers without the
 * flag (older) runs unguarded, said in the log and on the task. One that cannot be asked at all
 * (not on the session's PATH, --help timed out or said nothing) fails the launch instead of
 * running unguarded, and is asked again on the next one (2026-11-13).
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type SavingAutoOff, taskSavingOn } from '../../shared/saving-features.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { terminalSessionEnv } from '../utils/session-env.js';
import {
  claudeHookFiles,
  ensureClaudeHookFiles,
  hookSettings,
  shellQuote,
} from './claude-hooks.js';
import { ensureQoderHookFiles } from './qoder-hooks.js';
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
  qoderSettings: string;
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
    qoderSettings: path.join(dir, 'qoder-settings.json'),
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

/** The flag Codex needs to run a hook nobody reviewed in its TUI (codexGuardArgs). */
const HOOK_TRUST_FLAG = '--dangerously-bypass-hook-trust';

/** Codex's flags for the guard (its TOML: a JSON string is a TOML basic string). */
export function codexGuardArgs(hookLine: string): string[] {
  // `-c` here is Codex's config override (TOML key=value), not a shell script; hookLine is a
  // JSON-quoted TOML string and Codex runs it as the hook command it already is.
  const hooksToml = `hooks.PreToolUse=[{matcher="*", hooks=[{type="command", command=${JSON.stringify(hookLine)}, timeout=${GUARD_TIMEOUT_S}}]}]`;
  return [HOOK_TRUST_FLAG, '-c', hooksToml];
}

/** What asking a Codex about HOOK_TRUST_FLAG answered. */
export type CodexHookTrust =
  /** Its --help lists the flag: the guard goes on. */
  | { kind: 'yes' }
  /** Its --help answered without the flag: an older Codex (update Codex). Cached. */
  | { kind: 'no' }
  /**
   * It could not be asked (not on the session's PATH, --help timed out or said nothing).
   * Never cached: the next launch asks again, and the task does not start unguarded on it.
   */
  | { kind: 'unasked'; why: string };

export interface CodexProbeOptions {
  /** The folder the task's session starts in (a relative program is resolved against it). */
  cwd?: string;
  /** The bin the session puts first on PATH (its project's Node, node-runtime.ts). */
  pathPrepend?: string;
  /** How long --help may take (tests). */
  timeoutMs?: number;
}

/** Definitive answers, by the program's real path and the file's stamp (an upgrade re-asks). */
const codexSupport = new Map<string, { stamp: string; supported: boolean }>();

const CODEX_HELP_TIMEOUT_MS = 10_000;
/** A Codex that could not be asked is asked again this many times before the launch fails. */
const CODEX_ASK_ATTEMPTS = 3;
const CODEX_ASK_RETRY_MS = 1_000;

function executableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The program as the task's session would run it: on the session's PATH, its Node first. */
function resolveProgram(program: string, cwd: string, pathEnv: string): string | null {
  if (program.includes(path.sep)) {
    const file = path.resolve(cwd, program);
    return executableFile(file) ? file : null;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, program);
    if (executableFile(file)) return file;
  }
  return null;
}

/** One `--help`, told apart: an answer (yes/no) from a failure to ask (unasked). */
function askCodexHelp(
  resolved: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<CodexHookTrust> {
  return new Promise((resolve) => {
    execFile(
      resolved,
      ['--help'],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, env },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        if (err?.killed || err?.code === 'ETIMEDOUT') {
          resolve({
            kind: 'unasked',
            why: `codex --help did not respond within ${Math.round(timeoutMs / 1000)} s`,
          });
          return;
        }
        const help = String(stdout ?? '');
        if (help.trim()) {
          resolve({ kind: help.includes(HOOK_TRUST_FLAG) ? 'yes' : 'no' });
          return;
        }
        if (err) {
          const detail =
            String(stderr ?? '')
              .trim()
              .split('\n')[0] || err.message;
          resolve({ kind: 'unasked', why: `codex --help failed: ${detail}` });
          return;
        }
        resolve({ kind: 'unasked', why: 'codex --help said nothing' });
      }
    );
  });
}

/**
 * Whether this Codex takes HOOK_TRUST_FLAG, asked the way the task's session runs it: the
 * program resolved on the session's PATH (its project's Node first), the answer cached by the
 * real file's path and stamp, never by name. A failure to ask is not cached (2026-11-13: a
 * codex that moved with an nvm Node update was cached as "too old" until the server restarted,
 * and every Codex task ran unguarded on a transient ENOENT).
 */
export async function codexTakesHookTrust(
  program: string,
  options: CodexProbeOptions = {}
): Promise<CodexHookTrust> {
  const env = terminalSessionEnv(process.env, {});
  if (options.pathPrepend) {
    env.PATH = [
      options.pathPrepend,
      ...(env.PATH ?? '').split(path.delimiter).filter((p) => p && p !== options.pathPrepend),
    ].join(path.delimiter);
  }
  const resolved = resolveProgram(program, options.cwd ?? process.cwd(), env.PATH ?? '');
  if (!resolved) {
    return {
      kind: 'unasked',
      why: program.includes(path.sep)
        ? `${program} does not exist or is not executable`
        : `${program} is not on the PATH its session starts with`,
    };
  }
  let real: string;
  let stamp: string;
  try {
    real = fs.realpathSync(resolved);
    const stat = fs.statSync(real);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return { kind: 'unasked', why: `${resolved} could not be read` };
  }
  const known = codexSupport.get(real);
  if (known && known.stamp === stamp) return { kind: known.supported ? 'yes' : 'no' };
  const answer = await askCodexHelp(resolved, env, options.timeoutMs ?? CODEX_HELP_TIMEOUT_MS);
  if (answer.kind !== 'unasked') {
    codexSupport.set(real, { stamp, supported: answer.kind === 'yes' });
  }
  return answer;
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
  codexTakesHookTrust?: (program: string, options?: CodexProbeOptions) => Promise<CodexHookTrust>;
  /** The wait between asks of a Codex that could not be asked (tests). */
  codexRetryMs?: number;
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

/**
 * Writes the task's guard files; null when they can't be written (the task runs unguarded).
 * Throws when a Codex could not be asked about its hook flag after retries: the launch fails
 * instead of running unguarded, and the next launch asks again.
 */
export function createTaskGuard(options: TaskGuardOptions = {}) {
  const untetherDir = options.untetherDir ?? path.join(os.homedir(), '.untether');
  const home = options.home ?? os.homedir();
  const log = options.log ?? (() => {});
  const hook = () => options.hook ?? guardHookCommand();

  const prepare = async (
    task: TaskRecord,
    root: string,
    pathPrepend?: string
  ): Promise<TaskCommandGuard | null> => {
    const { index, name } = agentExecutable(task.command);
    // Codex is asked before anything is written, the way its session runs it (its Node first
    // on PATH). A failure to ask is retried, then fails the launch: the task never starts
    // unguarded on it (a "too old" answer, by contrast, runs unguarded and is cached).
    let takesHooks = false;
    if (name === 'codex') {
      const ask = options.codexTakesHookTrust ?? codexTakesHookTrust;
      const probe = () => ask(task.command[index], { cwd: root, pathPrepend });
      let trust = await probe();
      for (let attempt = 1; trust.kind === 'unasked' && attempt < CODEX_ASK_ATTEMPTS; attempt++) {
        log(`[task-guard] ${task.id}: ${trust.why}; asking Codex again`);
        await new Promise((resolve) =>
          setTimeout(resolve, options.codexRetryMs ?? CODEX_ASK_RETRY_MS)
        );
        trust = await probe();
      }
      if (trust.kind === 'unasked') {
        throw new Error(`the command guard could not be mounted: ${trust.why}`);
      }
      takesHooks = trust.kind === 'yes';
    }
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
      let cli: string[] | undefined;
      try {
        cli = options.cli?.();
      } catch {
        cli = undefined;
      }
      if (cli?.length && (name === 'claude' || name === 'codex' || name === 'qodercli')) {
        const check = settings.checkCommand?.trim();
        const related = settings.relatedTestCommand?.trim();
        policy.checkSlot = {
          cli,
          mode: name === 'claude' ? 'wrap' : 'ask',
          ...(check ? { checks: [check] } : {}),
          ...(related ? { related } : {}),
        };
      }
      // Claude runs its env file in each Bash shell and reads a PreToolUse hook's updatedInput;
      // Codex does neither (so no shell groups, no summaries).
      if (name === 'claude') {
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
      if (name === 'qodercli') {
        const qoder = ensureQoderHookFiles(untetherDir, log);
        if (!qoder) throw new Error('Qoder event hooks could not be written');
        const settings = hookSettings(qoder.script) as { hooks: Record<string, unknown[]> };
        settings.hooks.PreToolUse.push({
          matcher: '*',
          hooks: [{ type: 'command', command: hookLine, timeout: GUARD_TIMEOUT_S }],
        });
        writeFile(files.qoderSettings, `${JSON.stringify(settings)}\n`);
      }
      return {
        claudeSettings: files.claudeSettings,
        ...(name === 'qodercli' ? { qoderSettings: files.qoderSettings } : {}),
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

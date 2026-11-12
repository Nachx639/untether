/**
 * Starts a task's session: the agent's command in the task's folder, or in its own worktree
 * (shielded in tmux when asked), then the prompt typed by the same "Ask Claude" path once the
 * agent is ready.
 *
 * A worktree task's Claude may run `ut task done` / `ut task ask` without a permission prompt,
 * and the trust dialog for the folder the engine just made is answered for it: nobody is
 * looking at a new task's screen.
 *
 * 2026-10-18: a worktree task runs shielded whenever tmux is there. Two atlas tasks died
 * mid-work when the dev server restarted (their PTYs went with it), and the engine checked and
 * offered for merging what they had left. `resume` reopens a task's Claude conversation in its
 * worktree when that happens anyway.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { TaskRecord } from '../../shared/tasks.js';
import type { PtyManager } from '../pty/index.js';
import { detectGitInfo } from '../utils/git-info.js';
import { type NodeRuntime, nodeRuntimeBrief, resolveNodeRuntime } from '../utils/node-runtime.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';
import type { InitialInputAgent } from './claude-initial-input.js';
import type { ProviderLaunch } from './model-provider-launch.js';
import type { LaunchedSession } from './task-scheduler.js';

/**
 * Resolves the provider launch (environment, key, model picker) of a provider task
 * (model-providers.ts). Throws when the provider is gone or its key cannot be read, so the task
 * fails loudly instead of running with the user's own Anthropic login.
 */
export type TaskProviderEnv = (task: TaskRecord) => Promise<ProviderLaunch>;

/** The createSession options for a provider task; empty for a plain one. */
async function providerSessionOptions(
  task: TaskRecord,
  providerEnv: TaskProviderEnv | undefined
): Promise<
  | {
      env: Record<string, string>;
      unsetEnv: string[];
      modelProvider: { id: string; model: string };
    }
  | Record<string, never>
> {
  if (!task.modelProvider) return {};
  if (!providerEnv) {
    throw new Error(`Task ${task.id}: no model-provider launcher is wired`);
  }
  const launch = await providerEnv(task);
  return { env: launch.env, unsetEnv: launch.unset, modelProvider: launch.marker };
}

export interface DeliverInitialInputOptions {
  /** Answer "Yes, I trust this folder" if Claude asks (only for folders the engine made). */
  trustFolder?: boolean;
  /** Typed while Claude works too (see InitialInputOptions.whileBusy); menus still wait. */
  whileBusy?: boolean;
  /** See InitialInputOptions.onDialogWaiting. */
  onDialogWaiting?: () => void;
  /**
   * Not the user's own text (a task's follow-up, another agent's message): it waits while the
   * user writes in that session or has unsent text there (user-input-guard.ts).
   */
  notUsers?: boolean;
  /** The user's own input holds the typing back, and why (once per reason; notUsers only). */
  onUserHold?: (why: string) => void;
}

/** Resolves to whether the text was typed (the agent never got ready: false). */
export type DeliverInitialInput = (
  sessionId: string,
  text: string,
  agent: InitialInputAgent,
  options?: DeliverInitialInputOptions
) => Promise<boolean>;

/** What a worktree task's Claude may run without asking. */
export const TASK_ALLOWED_TOOLS = [
  'Bash(ut task done:*)',
  'Bash(ut task ask:*)',
  'Bash(ut task handoff:*)',
  'Bash(ut project tools want:*)',
];

/**
 * Codex's own update check, off for a task's session (`-c`, its config.toml key). 2026-10-23:
 * a task's Codex opened on "Update available · 1. Update now / 2. Skip …", a menu nobody saw;
 * its brief waited 30 min, then an Enter on it updated Codex, which quit ("Please restart").
 */
export const CODEX_NO_UPDATE_CHECK = ['-c', 'check_for_update_on_startup=false'];

/**
 * Codex's welcome-screen tooltips, off for a task's session: they only serve someone watching
 * the TUI, and nobody watches a task's (2026-11-03, with Claude's prompt suggestions, recap,
 * tips and survey in task-guard-setup.ts). Codex has no prompt suggestions or away recap.
 */
export const CODEX_NO_TOOLTIPS = ['-c', 'tui.show_tooltips=false'];

/**
 * The program a command line runs: past `env` and its VAR=value words (a runner with an
 * account of its own, e.g. `env CLAUDE_CONFIG_DIR=~/.claude-work claude`).
 */
export function agentExecutable(command: readonly string[]): { index: number; name: string } {
  let index = 0;
  if (path.basename(command[0] ?? '') === 'env') {
    index = 1;
    while (index < command.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index])) index++;
  }
  return { index, name: path.basename(command[index] ?? '') };
}

/**
 * The command line with `model` as its agent's model: a model flag already in it (the user's
 * quick start may carry one) gets the task's value, so what runs is what the card says;
 * otherwise the flag goes right after the program. Only a plain claude or codex is touched (a
 * shell wrapping it is left as it is).
 */
function withModel(
  command: string[],
  index: number,
  executable: string,
  model: string | undefined
): string[] {
  if (!model || (executable !== 'claude' && executable !== 'codex')) return command;
  const flags = executable === 'codex' ? ['-m', '--model'] : ['--model'];
  const out = [...command];
  for (let i = index + 1; i < out.length; i++) {
    const flag = flags.find((f) => out[i] === f || out[i].startsWith(`${f}=`));
    if (!flag) continue;
    if (out[i] === flag && i + 1 < out.length) out[i + 1] = model;
    else out[i] = `${flag}=${model}`;
    return out;
  }
  const flag = executable === 'codex' ? '-m' : '--model';
  return [...out.slice(0, index + 1), flag, model, ...out.slice(index + 1)];
}

/** The command guard of a task's session (task-guard-setup.ts), when it could be set up. */
export interface TaskCommandGuard {
  /** Claude: the task's settings file (Untether's event hooks and the guard). */
  claudeSettings: string;
  /** Codex: its flags; null when this Codex can't run an unreviewed hook (too old). */
  codexArgs: string[] | null;
  /** Told with its brief: the tools its session goes without (tool-pruning.ts). */
  toolNote?: string;
}

/**
 * The task's command line: its model (TaskRecord.model, 2026-11-01), the task tools allowed
 * when it starts Claude itself, Codex without its update prompt and tooltips, and the command guard
 * (2026-11-02) when it starts Claude or Codex itself (a shell wrapping it is left as it is).
 */
export function taskCommand(
  task: Pick<TaskRecord, 'command' | 'agent' | 'isolation' | 'model'>,
  guard?: TaskCommandGuard | null
): string[] {
  const { index, name: executable } = agentExecutable(task.command);
  let command = withModel(task.command, index, executable, task.model);
  const insert = (args: string[]) => [
    ...command.slice(0, index + 1),
    ...args,
    ...command.slice(index + 1),
  ];
  if (executable === 'codex') {
    if (guard?.codexArgs && !command.some((arg) => arg.startsWith('hooks.PreToolUse'))) {
      command = insert(guard.codexArgs);
    }
    const has = (key: string) => command.some((arg) => arg.includes(key));
    const quiet = [
      ...(has('check_for_update_on_startup') ? [] : CODEX_NO_UPDATE_CHECK),
      ...(has('show_tooltips') ? [] : CODEX_NO_TOOLTIPS),
    ];
    return quiet.length ? insert(quiet) : command;
  }
  if (executable === 'claude' && guard && !hasSettingsFlag(command)) {
    command = insert(['--settings', guard.claudeSettings]);
  }
  if (task.isolation !== 'worktree' || task.agent !== 'claude' || executable !== 'claude') {
    return command;
  }
  return [...command, '--allowedTools', ...TASK_ALLOWED_TOOLS];
}

function hasSettingsFlag(command: readonly string[]): boolean {
  return command.some((arg) => arg === '--settings' || arg.startsWith('--settings='));
}

/**
 * Whether the task's command line carries its guard: false when it could not be put on it
 * (guard files not written, a shell wrapping the agent, the user's own --settings, a Codex
 * too old for unreviewed hooks).
 */
export function guardApplied(command: readonly string[], guard: TaskCommandGuard | null): boolean {
  if (!guard) return false;
  const { name } = agentExecutable(command);
  if (name === 'claude') return command.includes(guard.claudeSettings);
  if (name === 'codex') return !!guard.codexArgs && command.includes(guard.codexArgs[0]);
  return false;
}

/** Sets up a task's guard in `cwd`; null when it could not be (said through `unguarded`). */
export interface TaskGuardPreparer {
  prepare: (task: TaskRecord, cwd: string) => TaskCommandGuard | null;
  /** The task runs without its guard, and why (logged, and recorded on the task). */
  unguarded?: (task: TaskRecord, why: string) => void;
}

/** The task's command line with its guard, or without it and said so (and its tool note). */
function guardedCommand(
  task: TaskRecord,
  cwd: string,
  guard: TaskGuardPreparer | undefined
): { command: string[]; toolNote?: string } {
  if (!guard) return { command: taskCommand(task) };
  const prepared = guard.prepare(task, cwd);
  const command = taskCommand(task, prepared);
  if (!guardApplied(command, prepared)) {
    const { name } = agentExecutable(task.command);
    const why = !prepared
      ? 'its guard files could not be written'
      : name !== 'claude' && name !== 'codex'
        ? `its command does not start claude or codex itself (${name || 'empty'})`
        : name === 'codex'
          ? 'this Codex has no --dangerously-bypass-hook-trust (update Codex)'
          : 'its command names its own --settings';
    guard.unguarded?.(task, why);
  }
  return {
    command,
    ...(prepared?.toolNote && guardApplied(command, prepared)
      ? { toolNote: prepared.toolNote }
      : {}),
  };
}

/** Typed into a task's resumed conversation. */
export const TASK_RESUME_TEXT =
  '[untether] Untether restarted and interrupted you. Carry on with the task where you left off: check what is already done (git status, git log), finish the rest, then report with `ut task done` as before.';

/** Before a follow-up typed into a task whose session had ended (send / fix reopen it). */
export const TASK_REOPENED_NOTE =
  '[untether] Your session had ended and was reopened for this message. When you are done, report with `ut task done` as before.';

/** The ptyManager options for a task's session in `cwd`. */
async function sessionOptions(
  task: TaskRecord,
  cwd: string,
  ptyManager: Pick<PtyManager, 'isShieldAvailable'>,
  node: NodeRuntime
) {
  const gitInfo = await detectGitInfo(cwd);
  const sweep = task.security?.kind === 'sweep';
  return {
    name: task.name,
    workingDir: cwd,
    // Its processes carry UNTETHER_TASK_ID (task-processes.ts): its guard lets it kill them,
    // Untether ends those left behind when it closes (2026-11-02).
    taskId: task.id,
    cols: 120,
    rows: 30,
    // Every task, with or without a worktree (2026-10-20: a session started in a plain folder
    // ran unshielded and the home asked the user to shield it by hand). Not a security sweep's
    // agent (2026-10-23): it runs without the user's credentials, and a shield's tmux server
    // hands every session the environment it was started with.
    ...(sweep
      ? { shielded: false, withoutSecrets: true }
      : { shielded: task.shielded || ptyManager.isShieldAvailable() }),
    // The Node its project asks for when the default one does not fit (2026-11-02).
    ...(node.kind === 'switch' ? { pathPrepend: node.node.bin } : {}),
    ...gitInfo,
  };
}

/** How a task's Node is chosen (utils/node-runtime.ts); tests hand their own. */
export type TaskNodeResolver = (cwd: string) => Promise<NodeRuntime>;

/**
 * Reopen a worktree task's Claude conversation (`claude … --resume <id>`) in its worktree and
 * tell it to carry on, or type `followUp` (a send / fix to a task whose session had ended).
 */
/** What a reopened conversation is told: carry on, or the follow-up it was reopened for. */
export function resumeText(followUp?: string): string {
  return followUp ? `${TASK_REOPENED_NOTE}\n\n${followUp}` : TASK_RESUME_TEXT;
}

export function createTaskResumer(deps: {
  ptyManager: Pick<PtyManager, 'createSession' | 'isShieldAvailable'>;
  deliverInitialInput: () => DeliverInitialInput | null;
  guard?: TaskGuardPreparer;
  nodeRuntime?: TaskNodeResolver;
  providerEnv?: TaskProviderEnv;
}) {
  return async (
    task: TaskRecord,
    conversationId: string,
    sessionId: string,
    followUp?: string
  ): Promise<LaunchedSession> => {
    const deliver = deps.deliverInitialInput();
    if (!deliver) throw new Error('Session routes are not ready');
    // A task without a worktree reopens in its folder (2026-10-20: one cut off by a restart
    // could not be resumed and was called ready half done).
    const inWorktree = task.isolation === 'worktree';
    if (inWorktree && !task.worktreePath) throw new Error('The task has no worktree');
    const cwd = resolveAbsolutePath(inWorktree ? (task.worktreePath as string) : task.workingDir);
    if (!fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
    // The provider launch first (warms the pricing cache before the guard's `/model` picker).
    const providerOptions = await providerSessionOptions(task, deps.providerEnv);
    // The id the scheduler recorded first (task journal): a restart looks for this one.
    await deps.ptyManager.createSession(
      [...guardedCommand(task, cwd, deps.guard).command, '--resume', conversationId],
      {
        ...(await sessionOptions(
          task,
          cwd,
          deps.ptyManager,
          await (deps.nodeRuntime ?? resolveNodeRuntime)(cwd)
        )),
        ...providerOptions,
        sessionId,
      }
    );
    const text = resumeText(followUp);
    const typed = Promise.resolve()
      .then(() => deliver(sessionId, text, task.agent, { trustFolder: true }))
      .catch(() => false);
    return { sessionId, typed, text };
  };
}

export function createTaskLauncher(deps: {
  ptyManager: Pick<PtyManager, 'createSession' | 'isShieldAvailable'>;
  /** Types the first message once the agent is ready (set by the session routes). */
  deliverInitialInput: () => DeliverInitialInput | null;
  /** The command guard (task-guard-setup.ts); unset: tasks run unguarded. */
  guard?: TaskGuardPreparer;
  nodeRuntime?: TaskNodeResolver;
  /** The provider launch for a provider task (model-providers.ts); unset: no providers. */
  providerEnv?: TaskProviderEnv;
}) {
  return async (task: TaskRecord, prompt: string, sessionId: string): Promise<LaunchedSession> => {
    const deliver = deps.deliverInitialInput();
    if (!deliver) throw new Error('Session routes are not ready');
    if (task.shielded && task.security?.kind !== 'sweep' && !deps.ptyManager.isShieldAvailable()) {
      throw new Error('Shielded sessions need tmux, which is not installed on this Mac');
    }
    const inWorktree = task.isolation === 'worktree';
    if (inWorktree && !task.worktreePath) throw new Error('The task has no worktree');
    const cwd = resolveAbsolutePath(inWorktree ? (task.worktreePath as string) : task.workingDir);
    if (!fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
    const node = await (deps.nodeRuntime ?? resolveNodeRuntime)(cwd);
    // The provider launch first, so its `/v1/models` fetch warms the pricing cache before the
    // guard writes the `/model` picker (it reads the discovered models from the cache).
    const providerOptions = await providerSessionOptions(task, deps.providerEnv);
    // The id the scheduler recorded first (task journal): a restart looks for this one.
    const guarded = guardedCommand(task, cwd, deps.guard);
    await deps.ptyManager.createSession(guarded.command, {
      ...(await sessionOptions(task, cwd, deps.ptyManager, node)),
      ...providerOptions,
      sessionId,
    });
    // Its agent is told once, with the task, which Node it has, or that none fits (2026-11-02:
    // without it, `pnpm run build` only said the engine was unsupported), and which tools its
    // session goes without (2026-11-03, tool-pruning.ts).
    const notes = [nodeRuntimeBrief(node), guarded.toolNote].filter(Boolean);
    const text = notes.length ? `${notes.join('\n\n')}\n\n${prompt}` : prompt;
    const typed = Promise.resolve()
      .then(() =>
        inWorktree
          ? deliver(sessionId, text, task.agent, { trustFolder: true })
          : deliver(sessionId, text, task.agent)
      )
      .catch(() => false);
    return { sessionId, typed, text };
  };
}

/** Claude's fast model when the installation names none (config taskModels). */
export const DEFAULT_FAST_MODELS: Partial<Record<TaskRecord['agent'], string>> = {
  claude: 'sonnet',
};

/** The installation's model for an agent's level; undefined = the agent's own default. */
export function modelForLevel(
  taskModels: Partial<Record<TaskRecord['agent'], { fast?: string; capable?: string }>> | undefined,
  agent: TaskRecord['agent'],
  tier: 'fast' | 'capable'
): string | undefined {
  const own = taskModels?.[agent]?.[tier];
  if (own) return own;
  return tier === 'fast' ? DEFAULT_FAST_MODELS[agent] : undefined;
}

export interface TaskRunnerConfig {
  name: string;
  agent: TaskRecord['agent'];
  command?: string;
  model?: string;
}

/**
 * Who a task may go on with when its agent hits its usage limit (config taskFallbacks, else
 * each agent with the user's quick start), only those whose program is on this Mac.
 */
export function taskRunners(options: {
  fallbacks: TaskRunnerConfig[] | undefined;
  /** The user's quick start for an agent as argv. */
  agentCommand: (agent: TaskRecord['agent']) => string[];
  /** A command string as argv for `agent` (task-commands quickStartArgv). */
  argv: (command: string, agent: TaskRecord['agent']) => string[];
  /** Programs found on this Mac: { name: found }. */
  available: Record<string, boolean | undefined>;
}): Array<{ name: string; agent: TaskRecord['agent']; command: string[]; model?: string }> {
  const plain = (['claude', 'codex'] as const).map((agent) => ({
    name: agent as string,
    agent,
    command: options.agentCommand(agent),
  }));
  const configured = options.fallbacks?.map((entry) => ({
    name: entry.name,
    agent: entry.agent,
    command: entry.command
      ? options.argv(entry.command, entry.agent)
      : options.agentCommand(entry.agent),
    ...(entry.model ? { model: entry.model } : {}),
  }));
  // The configured ones first, then the plain agents (the one a task starts on is skipped by
  // the scheduler; a name configured twice keeps its first).
  const all = [...(configured ?? []), ...(configured ? [] : plain)];
  const seen = new Set<string>();
  return all.filter((runner) => {
    if (seen.has(runner.name) || !runner.command.length) return false;
    seen.add(runner.name);
    const program = agentExecutable(runner.command).name;
    return options.available[program] !== false;
  });
}

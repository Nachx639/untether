/**
 * Per-project (git repository) settings of the task engine, kept in ~/.untether/projects.json
 * keyed by the repository's main checkout. Outside the repository on purpose: an agent working
 * in it can't rewrite its own check. Shared by the server and the phone's settings sheet.
 */
import type { SavingAutoOff } from './saving-features.js';
import type { SecuritySweepSettings } from './security.js';
import type { TaskAgent, TaskMergePolicy } from './tasks.js';

export const VERIFY_TIMEOUT_DEFAULT_SEC = 900;
/** The highest maxActiveTasks a project may set. */
export const MAX_ACTIVE_TASKS_MAX = 50;
/** Task sessions the tool pruning looks back over (ProjectSettings.toolPruningWindow). */
export const TOOL_PRUNING_WINDOW_DEFAULT = 20;

/** ProjectSettings.memoryDir: Claude Code's memory folder of the project, when it exists. */
export const MEMORY_DIR_AUTO = 'auto';

export type AgentFallbackMode = 'off' | 'offer' | 'auto';

/** Why the circuit breaker paused a project's auto-merge (ProjectSettings.autoMergePausedCode). */
export type AutoMergePauseCode = 'reverts' | 'failures';
export const VERIFY_TIMEOUT_MAX_SEC = 4 * 60 * 60;

/**
 * The security sweep's keys (shared/security.ts): `securitySweep` is the one switch, off by
 * default; the rest are advanced and hidden (deduced when unset).
 */
export interface ProjectSettings extends SecuritySweepSettings {
  /** 'auto': a finished task merges on its own when all is well; 'ask': it waits for the user. */
  mergePolicy: TaskMergePolicy;
  /** The check a task must pass (zsh -lc in the worktree); detected per package when unset. */
  checkCommand?: string;
  /**
   * Two-level checks (2026-11-02, opt-in: set relatedTestCommand). A task's own check is then
   * `fastCheckCommand` (lint, typecheck, format) and `relatedTestCommand` with `{files}` replaced
   * by the task's changed files (absolute, shell-quoted), e.g. `cd web && pnpm exec vitest
   * related {files} --run --passWithNoTests`. The whole check (checkCommand, else the detected
   * one) still guards the base: the merge batch runs it once on the combined result before the
   * base moves, and a failure is pinned on the task that broke it (merge-train.ts). The whole
   * check runs for the task itself when the related set can't be computed: a changed file not
   * matching `relatedTestFiles` (a regular expression, default code files) or matching
   * `relatedFullPaths` (default: manifests, lockfiles, tool configs, test setup and helpers),
   * a deleted or renamed file, or more than `relatedMaxFiles` (default 40) files.
   */
  fastCheckCommand?: string;
  relatedTestCommand?: string;
  relatedTestFiles?: string;
  relatedFullPaths?: string;
  relatedMaxFiles?: number;
  /** Runs in a new worktree instead of the detected install. */
  setupCommand?: string;
  /** Folders cloned from the main checkout into a new worktree (default node_modules). */
  cloneDirs?: string[];
  /**
   * Ignored paths (globs, or `folder/`) that are local by nature, never a reason to refuse a
   * check: a file git ignores that the task created among versioned files stops its check
   * (task-ignored-inputs.ts), unless it is declared here.
   */
  artifactPaths?: string[];
  /** The branch tasks start from and merge into (default: the checked-out branch). */
  baseBranch?: string;
  /** Where task worktrees go (default <repo parent>/.untether-worktrees/<repo name>). */
  worktreeRoot?: string;
  /** Globs exempt from the risk rules. */
  riskIgnore?: string[];
  /** Merge on its own even when there is no check to run. */
  allowMergeWithoutCheck: boolean;
  verifyTimeoutSec: number;
  /**
   * An AI (Claude Sonnet) reviews each task's diff before it merges (task-review.ts). On by
   * default since 2026-10-20: nothing merges without an AI review.
   */
  aiReview: boolean;
  /**
   * The AI review is done by the other model family than the task's agent (2026-11-01): Codex
   * reviews Claude's tasks, Claude reviews Codex's, so the reviewer's blind spots are not the
   * author's. Unset = on. When the other family can't answer (not installed, not logged in, out
   * of quota), Claude reviews as before and the review says so (TaskReview.fallback).
   */
  crossReview?: boolean;
  /**
   * The circuit breaker (2026-10-20): too many of the project's auto-merged tasks were undone,
   * or too many tasks failed after Untether's automatic fixes, so its tasks wait for the user
   * before merging until then (ISO). Cleared by the server once past, or by the user.
   */
  autoMergePausedUntil?: string;
  /** Why auto-merge is paused, in plain words (English, for logs). */
  autoMergePausedReason?: string;
  /**
   * Why auto-merge is paused, for the phone to say in its language (2026-10-20: only the
   * English reason existed): 'reverts' = auto-merged tasks undone, 'failures' = tasks still
   * failing after the automatic fixes; `autoMergePausedCount` of them in the last 24 hours.
   */
  autoMergePausedCode?: AutoMergePauseCode;
  autoMergePausedCount?: number;
  /**
   * When the user last turned a paused auto-merge back on: the circuit breaker only counts
   * what happened after it (2026-10-20: the same old undos paused it again at once).
   */
  autoMergeResumedAt?: string;
  defaultAgent?: TaskAgent;
  /**
   * At most this many of the project's tasks run at once (2026-11-01, opt-in; unset = no
   * limit). Holding a slot: preparing, working, checking, merging, and needs_you while its
   * session runs (for TASK_QUEUE_NEEDS_YOU_HOLD_MS). Ready, paused and finished tasks do not.
   * A task due beyond it waits queued and starts by itself, first in first out.
   */
  maxActiveTasks?: number;
  /**
   * Model by difficulty (2026-11-01, opt-in): a cheap classification of each task's prompt
   * picks the fast model (simple, mechanical work) or the capable one (anything else; when
   * unsure, capable). The models per agent are the installation's (config taskModels).
   */
  modelRouting?: boolean;
  /**
   * An agent cut short by its usage limit and another configured (the other agent, or the
   * installation's taskFallbacks): 'offer' (default) pauses as before and offers it, 'auto'
   * carries the task on with it in the same worktree, 'off' never offers it.
   */
  agentFallback?: AgentFallbackMode;
  /**
   * The budget of the project's tasks over the defaults (shared/task-budget.ts, 2026-11-01):
   * "wall=3h,agent=2h,rounds=6,tokens=100M,warn=75", any of them; 0 or off = no limit.
   */
  taskBudget?: string;
  /**
   * Minutes without progress, its agent waiting on one thing (a Monitor, background work, a
   * sleep), before its orchestrator is told and the agent nudged (2026-11-02). Default
   * STALL_MINUTES_DEFAULT (20); 0 = never.
   */
  stallMinutes?: number;
  /**
   * A task's agent that fails the same way again and again (the same command, the same error,
   * 3 times in one turn) is typed a note once per turn to try another approach, and its
   * orchestrator told if it goes on (2026-11-03). Default on; false = never.
   */
  failureLoopNudge?: boolean;
  /**
   * A working task is brought up to date when another task of the project merges files it
   * touches too (2026-11-11, task-scheduler-overlap.ts): at a gap of its agent (no tool
   * running, nothing uncommitted in tracked files) Untether merges the base into its branch
   * when that is clean, and tells the agent the files when it conflicts. Default on; false =
   * each task meets the others' work only at its own merge.
   */
  baseSync?: boolean;
  /**
   * The project's zones (2026-11-11, shared/task-serial.ts): rules "path pattern=zone name"
   * (`web/src/client/**=client`; `**` any folders, `*` within one name, a plain folder covers
   * what is in it). A new task whose prompt names a path under a rule's pattern is in that
   * zone, like `ut task new --zone`: two tasks of a zone never work at once, the later one
   * waits for the earlier. Nothing is guessed from a prompt that names no such path.
   */
  zones?: string[];
  /**
   * Minutes between the digests of informational task notes typed into the project's
   * orchestrator (queued, started, merged, being fixed, still working with progress); notes
   * that need it go at once and take the digest along (2026-11-02). Default
   * DIGEST_MINUTES_DEFAULT (15); 0 = every note at once.
   */
  digestMinutes?: number;
  /**
   * The command guard of the project's tasks (2026-11-02, server/services/task-guard.ts): rules
   * turned off (delete-outside, git-push, git-base, git-rebase-skip, private-paths,
   * kill-foreign, sudo), regular expressions that block a shell command they match, and ones
   * that let a command they match through every rule. Unset = every rule on, nothing extra.
   */
  guardOff?: string[];
  /**
   * Where a merged task's memory note goes (TaskResult.memoryNote, 2026-11-03; opt-in, unset =
   * off: the note goes to the orchestrator in the merged event). An absolute folder, or 'auto':
   * Claude Code's memory folder of the project (~/.claude/projects/<encoded path>/memory),
   * only when that folder exists (server/services/task-memory-note.ts).
   */
  memoryDir?: string;
  /**
   * Tool pruning of the project's Claude task sessions (2026-11-03, opt-in;
   * server/services/tool-pruning.ts): plugins, MCP servers and skills that none of the last
   * `toolPruningWindow` (default TOOL_PRUNING_WINDOW_DEFAULT) task sessions used are left out
   * of a new task's session. Never: language plugins, Untether's hooks, `toolKeep` (plugin,
   * MCP server or skill names, or "claude.ai"), anything used or wanted in the window.
   */
  toolPruning?: boolean;
  toolPruningWindow?: number;
  toolKeep?: string[];
  guardDeny?: string[];
  guardAllow?: string[];
  /**
   * The share of its tasks (0-100, default 10) run without the token-saving features
   * (shared/saving-features.ts, 2026-11-03: summarizeOutput, failureLoopNudge) as a baseline.
   */
  savingHoldoutPct?: number;
  /**
   * Feature versions the quality guard turned off for the project, with the numbers why (the
   * server writes them; clearing them, savingAutoOff=, turns them on again).
   */
  savingAutoOff?: SavingAutoOff[];
  /**
   * Summarised test/check output for the project's Claude task agents (2026-11-03, opt-in,
   * server/services/task-output.ts): a recognised test or check command (vitest, jest, bun test,
   * pytest, go test, cargo test, tsc, xcodebuild, pnpm/npm run test|check|lint|typecheck, the
   * project's checkCommand / fastCheckCommand) runs with its whole output in a log in the
   * task's folder and the agent reads the exit code, the summary and the first failures.
   * `summarizeCommands`: more commands, regular expressions. `UT_FULL_OUTPUT=1` opts a call out.
   */
  summarizeOutput?: boolean;
  summarizeCommands?: string[];
  orchestratorSessionId?: string;
  /** The orchestrator is a session the user made one (adopt): stopping it leaves it open. */
  orchestratorAdopted?: boolean;
  /** Pinned on top of the home (2026-10-18), and when; a project folder without git too. */
  pinnedAt?: string;
  /**
   * The project's icon: an image inside the repository, relative to it, that its orchestrator
   * picked when it started (2026-10-20). Shown on the orchestrator's row; never detected.
   */
  icon?: string;
  /**
   * Who the project is, kept by the server (never set by hand): the repository's root commit
   * and the folder's name, so a renamed or moved folder is found again (2026-10-20: skylark
   * renamed to inkwell left a dead "SKYLARK" project on the home).
   */
  gitRoot?: string;
  folderName?: string;
  /** Where it was before the server followed it to this folder, and when. */
  movedFrom?: string;
  movedAt?: string;
  /** Every folder it was in before, oldest first (an old name or path still finds it). */
  formerPaths?: string[];
  /** Its folder is gone and was not found elsewhere ("carpeta no encontrada"), since when. */
  missingSince?: string;
}

/** Settings only the server writes (identity and moves): never part of a user's change. */
export const PROJECT_INTERNAL_KEYS = [
  'gitRoot',
  'folderName',
  'movedFrom',
  'movedAt',
  'formerPaths',
  'missingSince',
] as const;

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  mergePolicy: 'auto',
  allowMergeWithoutCheck: false,
  verifyTimeoutSec: VERIFY_TIMEOUT_DEFAULT_SEC,
  aiReview: true,
};

/** Auto-merge is paused for the project right now (circuit breaker). */
export function autoMergePaused(
  settings: Pick<ProjectSettings, 'autoMergePausedUntil'>,
  now = Date.now()
): boolean {
  const until = settings.autoMergePausedUntil
    ? Date.parse(settings.autoMergePausedUntil)
    : Number.NaN;
  return Number.isFinite(until) && until > now;
}

/** A project as GET /api/projects lists it. */
export interface ProjectSummary {
  repoPath: string;
  name: string;
  settings: ProjectSettings;
  /** Its tasks still open (not merged, discarded or missed). */
  openTasks: number;
}

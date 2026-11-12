/**
 * Tasks: a prompt for Claude (or Codex) in a folder, run now or at a set time, optionally
 * shielded, with a push when it finishes. A worktree task runs in its own branch and folder
 * and is merged back into the base branch when done. Shared by the server (scheduler, API)
 * and the phone. Templates are prompts with placeholders; built-ins live in the client's
 * locales.
 */

/**
 * This file only lists the areas: each type, limit and field of a task lives in its area's file
 * under tasks/.
 */

export * from './tasks/admission.js';
export * from './tasks/agents.js';
export * from './tasks/autofix.js';
export * from './tasks/blockers.js';
export * from './tasks/checks.js';
export * from './tasks/core.js';
export * from './tasks/guard.js';
export * from './tasks/merge.js';
export * from './tasks/metrics.js';
export * from './tasks/overlap.js';
export * from './tasks/progress.js';
export * from './tasks/queue.js';
export * from './tasks/record.js';
export * from './tasks/report.js';
export * from './tasks/review.js';
export * from './tasks/session.js';

/**
 * What a worktree task's agent is told after the user's prompt: it works on a branch of its
 * own that the engine merges back, and it reports through `ut task done` / `ut task ask`
 * (allowed without a permission prompt) instead of leaving the engine to guess from silence.
 */

import { TASK_RESULT_EXAMPLE } from './task-result.js';

export interface TaskPromptContext {
  /** The task's own branch (ut/<slug>). */
  branch: string;
  /** The branch it will be merged into. */
  baseBranch: string;
}

/** What a compaction of the task's conversation must keep. */
export const TASK_COMPACT_INSTRUCTIONS =
  'Compact instructions: when this conversation is compacted, keep this task and the rules above as they are; the output of failing tests and checks verbatim (command, failing test names, error messages, stack lines); the diffs and the paths of the files changed or still to change; the commits made; and the decisions taken with their reasons, including approaches tried and dropped. Passing output and files only read can be summarised.';

export function taskPromptSuffix({ branch, baseBranch }: TaskPromptContext): string {
  return [
    '---',
    // 2026-10-20: "do not … merge" contradicted the conflict fix, which asks to merge the base
    // into the branch; and the `ut task done` example used double quotes, which break on `$`.
    `You are working in an isolated git worktree on branch \`${branch}\`, made from \`${baseBranch}\` for this task only. It will be merged back into \`${baseBranch}\` for you: do not switch branches, do not merge into \`${baseBranch}\` or push, do not rebase. Merging \`${baseBranch}\` INTO your branch to resolve conflicts is fine.`,
    'Commit your work as you go with clear messages. Keep the diff to what the task needs; never put secrets in code or commits; never skip, weaken or delete tests to make them pass.',
    // 2026-11-11: every agent ran the project's whole check while it worked and Untether ran it
    // again to verify: the same code checked twice or more, several tasks at once, the Mac over
    // its load threshold. The whole check is Untether's, once; the agent's own runs are focused.
    'While you work, run only the tests focused on what you touch (the test files of the code you change, or a filter by name), not the project\'s whole check or whole test suite: Untether runs the whole check once when you report done, on exactly what you committed, and hands you its output if it fails. If you do need a whole run, make it once: it waits for one of the Mac\'s check slots, and a run that already passed on the very same files is not made again ("check: reused").',
    // 2026-10-20: "done" with a one-line claim was all the user and the reviewer got; the
    // report proves the work (what ran and what it printed) and says how to take it back.
    // 2026-11-01: as a structured result (shared/task-result.ts): the pipeline decides by its
    // outcome and the reviewer compares it with the diff, instead of reading prose.
    `When you are done, report with a structured result, all of it as JSON on stdin: \`ut task done --result - <<'EOF'\` on one line, then the JSON, then \`EOF\`. Its keys: summary (what changed, a few lines), verified (the commands you ran and what they printed), undo (how to undo it), outcome (done, partial if part of it is left, blocked if you cannot go on without someone, no-change if nothing needed changing), files (every file you changed, its path from the repository root: [{"path","why"}]), tests (every check you ran: [{"command","result":"passed"|"failed"|"skipped","detail"}]), risks (what could still go wrong, [] if none), followUps (what is left or what blocks you, [] if none) and, when you measured something, measurements ([{"name","value","unit","before"}]). Example: ${TASK_RESULT_EXAMPLE.replace(/^\{/, '{"summary":"…","verified":"pnpm test: 212 passed","undo":"git revert <sha>",')}. Prove it, do not claim it: tests and verified name real commands you ran and what they printed. If it says the result is not complete, fix what it names and run it again.`,
    // 2026-11-03: agents wrote incident notes into the user's agent memory folder, outside the
    // worktree; the guard blocked it and every task asked its orchestrator to save them.
    'Do not write any agent memory folder (such as ~/.claude/projects/<project>/memory or a MEMORY.md outside this worktree): when something is worth remembering in future sessions of this project (an incident, its root cause, the guard you left), add memoryNote to the result: {"name":"kebab-case-slug","description":"one line","body":"the note, Markdown"}. Untether saves it in the project\'s memory when the task merges.',
    "If you need a decision from the user, run `ut task ask - <<'EOF'` with your question on the next lines and `EOF` after it, then stop until they answer.",
    "If the user asks for something about another project or folder, do not do it here and do not send them elsewhere: run `ut task handoff --dir <that folder> - <<'EOF'` with their request (complete on its own) on the next lines and `EOF` after it, which opens a session there on their phone (after the user's OK when you run under an orchestrator), and tell them.",
    // 2026-11-03: Claude Code has no settings key for compaction guidance; it reads a "Compact
    // instructions" section from what is in context (its docs put one in CLAUDE.md), so the
    // brief carries it. Codex's compaction summarises this conversation too.
    TASK_COMPACT_INSTRUCTIONS,
  ].join('\n');
}

/** The prompt typed into a worktree task's session. */
export function buildTaskPrompt(prompt: string, context: TaskPromptContext): string {
  return `${prompt.trimEnd()}\n\n${taskPromptSuffix(context)}`;
}

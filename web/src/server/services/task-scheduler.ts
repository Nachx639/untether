/**
 * Tasks: a prompt for Claude (or Codex) in a folder, now or at a set time. A worktree task
 * runs in a folder and branch of its own (task-worktree.ts) and is left ready to merge back.
 *
 * Tasks are kept in `<control dir>/tasks.json` so they survive a server restart. One timer is
 * armed for the nearest scheduled task and re-armed after each run and on start. A task whose
 * time passed while the server was down runs on start when it is at most TASK_LATE_GRACE_MS
 * late; older ones are marked missed and a "Task not run" push goes out.
 *
 * One state machine follows each task's session through the Claude status notifier's
 * transitions (muted sessions included): busy → working; waiting → needs_you; idle for
 * IDLE_HOLD_MS after working → finish(). `ut task done` finishes at once, `ut task ask` asks
 * the user. Codex reports no status: its tasks finish on `ut task done`, when the session
 * exits, or after CODEX_IDLE_MS without output.
 *
 * A finished worktree task with commits goes through the merge pipeline (task-merge.ts):
 * verifying → merging → merged, or it stops at ready / needs_you / failed with the reason. The
 * user can merge, re-check or have the agent fix it (merge(), verify(), fix()). A worktree is
 * made in the background: a new task is returned while still `preparing`.
 *
 * A task without a worktree has nothing to merge (2026-10-24: they sat "ready" for days and
 * `ut task merge` refused them, so only «Descartar» closed them). Finished with a report
 * (`ut task done`, or idle with a last reply) and nothing blocking (no question, no follow-up
 * still to be typed), it ends `done` with a "Task done" push; otherwise it is ready, and
 * `ut task merge` (complete()) closes it as done. Once one is done, older failed ones with the
 * same prompt in the same folder close as done too (supersededBy). At start, ready ones over
 * PLAIN_READY_SWEEP_MS old whose session ended close as done, quietly.
 *
 * An agent cut short by something outside its task (2026-11-01, bakery 0cbedf19 and
 * ce86f31b: two Codex tasks hit the usage limit 4 minutes in; one went ready with nothing done,
 * the other through the pipeline and an automatic fix that hit the limit again): when a turn
 * ends without `ut task done`, the session's screen is read first (agent-halt.ts). A usage
 * limit, an API error or a lost login there pauses the task (state paused, TaskRecord.halt):
 * never ready or done, no pipeline, no fix round, no "changed nothing". Whoever it reports to
 * hears it once; at the time the agent gave (plus HALT_RESUME_MARGIN_MS), or after
 * HALT_RETRY_DELAYS_MS when it gave none, the same session is told to go on (a session gone
 * meanwhile is reopened), at most HALT_MAX_TRIES times in a row (a halt within HALT_STREAK_MS
 * of being sent on is the same streak; a later one starts over and is told again). While an agent is at its
 * limit, new tasks of that agent wait as scheduled until then (heldFor), with the other agent
 * offered. `ut task retry` sends a paused task on now, or starts a held one (--agent).
 * The end of a turn is not the only time it is looked for (2026-11-09, f3719fe5: a limit in a
 * fix round typed into the turn still open went unread for 54 min): a working task quiet for
 * HALT_LOOK_QUIET_MS is looked at every HALT_LOOK_EVERY_MS (watchHalts), in any phase.
 *
 * A task that reaches a final state (done, merged, discarded, missed) by any path has its
 * agent's session stopped FINISHED_SESSION_GRACE_MS later (2026-10-24: done tasks kept their
 * Claude running, RAM and CPU, until the orchestrator killed them by hand), unless the user
 * reopened it by hand (keepSessionId) or it is an orchestrator's. lingeringSessions() lists the
 * ones that slipped through, for the doctor.
 *
 * Merging on its own after a countdown the user can stop («Parar», `ut task hold`): a security
 * task past every gate (shared/security.ts), and, since 2026-10-24, a risky task (auth or
 * session code) of a project with policy auto that a second, risk-focused review confirmed
 * (riskReview, riskMerges); CI, signing, credentials, config files and reverts never. A
 * re-check the user asked for (verify()) that ends with nothing blocking goes on like the
 * agent had finished: merged, counted down or reviewed again without a tap.
 *
 * The user's autoApprove setting (config.json, opt-in, 2026-10-24): a task that would stop
 * only for the user's merge OK (risky changes the second review did not confirm, a security
 * fix held for «Fusionar», no check, a review that still could not run after its retries)
 * counts down the same way and then merges as if the user had tapped «Fusionar»
 * (autoApprovedMerge). Never a broken change (a failed check, real review issues once
 * Untether's own fixes ran out), a conflict, a parallel group, a project with policy ask or
 * the circuit breaker's pause: those still wait for the user.
 */

import { TaskSchedulerCommands } from './task-scheduler-commands.js';

export {
  autoFixPrompt,
  conflictOf,
  fixPrompt,
  lateReviewPrompt,
  withSendingTime,
} from './task-scheduler-prompts.js';
export {
  autoFixReasonOf,
  BASE_WAIT_POLL_MS,
  BREAKER_GAVE_UP,
  BREAKER_REVERTS,
  BREAKER_WINDOW_MS,
  BUDGET_CONTINUE_TEXT,
  BUDGET_SAVE_EVERY_MS,
  BUDGET_TOKENS_EVERY_MS,
  budgetAdvice,
  CODEX_IDLE_MS,
  clockText,
  FINISHED_SESSION_BUSY_MS,
  FINISHED_SESSION_GRACE_MS,
  FINISHED_SESSION_LINGER_MS,
  fairest,
  fitsSlots,
  HALT_LIMIT_GUESS_MS,
  HALT_LOOK_EVERY_MS,
  HALT_LOOK_QUIET_MS,
  HALT_MAX_TRIES,
  HALT_RESUME_MARGIN_MS,
  HALT_RETRY_DELAYS_MS,
  HALT_SLOT_RETRY_MS,
  HALT_STREAK_MS,
  IDLE_HOLD_MS,
  INPUT_BUSY_NOTICE_MS,
  INPUT_GIVE_UP_MS,
  INPUT_RETRY_MAX_MS,
  INPUT_RETRY_MS,
  INTERNAL_RETRY_DELAYS_MS,
  LATE_INPUT_MS,
  MAX_TASK_RESUMES,
  outboxPayload,
  PLAIN_READY_SWEEP_MS,
  RESTART_WINDOW_MS,
  REVIEW_RETRY_DELAYS_MS,
  REVIEW_UNAVAILABLE_NOTIFY_MS,
  runnerLabel,
  runnerOf,
  SETUP_RETRY_MS,
  STALE_REMIND_MAX_MS,
  STALE_REMIND_MS,
  TASK_RETRY_TEXT,
  TASK_START_CUTS_MAX,
} from './task-scheduler-rules.js';
export {
  gitTaskWorktrees,
  type LaunchedSession,
  type MergeOptions,
  type NewTask,
  type TaskActionResult,
  type TaskLogKind,
  type TaskRunner,
  type TaskSchedulerDeps,
  type TaskWorktreeSetup,
  type TaskWorktrees,
} from './task-scheduler-types.js';

/**
 * The task scheduler. Its code is split into layers, each a class extending the one before
 * (all state lives in the first; a layer calls the ones above through abstract declarations
 * there):
 * - task-scheduler-core.ts: The scheduler's state and what every part leans on: the fields, saving
 *   and loading tasks.json, state changes and the pushes they send.
 * - task-scheduler-budgets.ts: Task budgets: the time, rounds and tokens a worktree task may spend,
 *   counted, warned about and cut (2026-11-01).
 * - task-scheduler-stall.ts: Progress and stalls: an agent waiting on one thing without progress
 *   is nudged and its orchestrator told.
 * - task-scheduler-loops.ts: Failure loops: an agent failing the same way 3 times in a turn is
 *   nudged once per turn, its orchestrator told if it goes on (2026-11-03).
 * - task-scheduler-breaker.ts: The circuit breaker: a project whose merged tasks keep being
 *   reverted or given up on stops merging on its own for a while.
 * - task-scheduler-queue.ts: Queue and admission: the per-project task limit, the wait for memory
 *   and the order queued tasks start in.
 * - task-scheduler-agents.ts: Agents: which runner and model a task gets, an agent halted by a
 *   limit or an error (pause, resume), and the hand-off to another agent.
 * - task-scheduler-input.ts: Talking to a running agent: typing follow-ups (and retrying them), and
 *   telling when it is busy, waiting or idle long enough to finish.
 * - task-scheduler-overlap.ts: Overlap: open tasks of a project that change the same files are
 *   shown and told once, and a working one is brought up to date when another merges (2026-11-11).
 * - task-scheduler-sessions.ts: Sessions: preparing a task's worktree and starting, reopening,
 *   resuming and stopping its agent's session.
 * - task-scheduler-finish.ts: Finishing: an agent that is done (or quiet, or gone) ends its task,
 *   plain tasks close as done, and waiting ones are reminded.
 * - task-scheduler-autofix.ts: Auto-fix rounds: a check, review or conflict the agent fixes on its
 *   own, how many rounds are left, fresh conflicts and late reviews.
 * - task-scheduler-pipeline.ts: The verify/merge hand-off: the merge pipeline run (task-merge.ts),
 *   its waits (dirty base, review, internal retries), risky and security merges and the merge OK.
 * - task-scheduler-commands.ts: The commands: start and stop, the timer, creating tasks and what
 *   the user and the agent do with them (send, retry, fix, merge, discard, revert, moves).
 */
export class TaskScheduler extends TaskSchedulerCommands {}

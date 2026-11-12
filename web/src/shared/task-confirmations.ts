/**
 * Task-engine actions that wait for the user's OK. A `ut task …` / `ut project
 * set|orchestrate|forget|new` from inside a session (an agent, an orchestrator) that would merge
 * risky changes, throw work away, change a project's check, start its orchestrator, forget
 * a project or create one does not happen at once: the server
 * keeps it pending, pushes "task-confirm" (deep link /?confirm=<id>) and runs it only when the
 * user approves it from the app (GET /api/confirmations, POST /api/confirmations/:id { approve }).
 * With the user's autoApprove setting on (config.json, off by default; 2026-10-24) none waits:
 * each is approved at once, runs as the user and a "task-auto-approved" push says what was done.
 * Shared by the server and the phone's confirm sheet.
 */

/** A pending action is dropped after this long without an answer. */
export const CONFIRMATION_TTL_MS = 30 * 60 * 1000;
/** At most this many wait at once (the oldest goes first). */
export const MAX_PENDING_CONFIRMATIONS = 50;

export type ConfirmationKind =
  /** Merge a task (from a session that may not merge on its own). */
  | 'merge'
  /** Merge a task letting its flagged (risky) changes in. */
  | 'merge-risk'
  /** Merge a task past the AI reviewer's concerns. */
  | 'merge-review'
  /** Throw a task away (its session, worktree and branch). */
  | 'discard'
  /** Keep one task of a parallel group: merge it, discard the others. */
  | 'keep'
  /** Type a message into a task's session. */
  | 'send'
  /** Type a task's blocker into its agent ("Que lo arregle"). */
  | 'fix'
  /** Try a failed task again ("Reintentar"). */
  | 'retry'
  /** Undo a merged task with a revert task ("Deshacer"). */
  | 'revert'
  /** Change a project's task settings (merge policy, check command …). */
  | 'project-set'
  /**
   * Start a session without a worktree (`ut task new --no-worktree`, `ut task handoff`) for an
   * orchestrator: it runs in any folder, unchecked (2026-10-20).
   */
  | 'start'
  /**
   * Start a project's orchestrator, or give the running one a goal (`ut project orchestrate`
   * from an agent, a script or a request without a login; 2026-10-23).
   */
  | 'project-orchestrate'
  /**
   * Forget a project: its record (settings, pin, orchestrator) goes, its folder is never
   * touched (`ut project forget` from an agent or a script; 2026-10-24).
   */
  | 'project-forget'
  /**
   * Create a project: a new folder with git and a first commit, pinned on the home, and with
   * a goal its orchestrator started (`ut project new` from an agent or a script; 2026-10-24).
   */
  | 'project-new'
  /**
   * Turn on the user's autoApprove setting (`ut project auto-approve on` from an agent or a
   * script): the one OK that removes all the others (2026-10-24).
   */
  | 'auto-approve'
  /**
   * Activate a connector token an agent or a script made (`ut project connector add`): an
   * external app may then send requests to the project's orchestrator (2026-10-31).
   */
  | 'connector-add';

export const CONFIRMATION_KINDS: readonly ConfirmationKind[] = [
  'merge',
  'merge-risk',
  'merge-review',
  'discard',
  'keep',
  'send',
  'fix',
  'retry',
  'revert',
  'project-set',
  'start',
  'project-orchestrate',
  'project-forget',
  'project-new',
  'auto-approve',
  'connector-add',
];

export interface TaskConfirmation {
  id: string;
  kind: ConfirmationKind;
  createdAt: string;
  expiresAt: string;
  /** What it is about: the task's name or the project's folder name. */
  where: string;
  taskId?: string;
  repoPath?: string;
  /** One English line saying what happens (CLI output, logs). */
  summary: string;
  /** What exactly: the text to send, the settings changed, the work that would be lost. */
  detail: string[];
  /** The session that asked (its name when it has one). */
  requestedBy: { sessionId?: string; name?: string };
  /** Approved at once by the user's autoApprove setting: it never waited. */
  autoApproved?: true;
}

/** What the CLI or an API call gets back while the action waits for the user. */
export interface PendingConfirmationResult {
  status: 'pending-confirmation';
  confirmation: TaskConfirmation;
}

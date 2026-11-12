/** Settings of sessions: shielding, idle and updated agents, recordings, cleanup. */

/** Its part of config.json (UntetherConfig, config/untether-config.ts). */
export interface SessionsConfig {
  /** Remove exited sessions older than this many days; 0 or missing = off (never on by default). */
  autoCleanupExitedAfterDays?: number;

  /**
   * New sessions created from the web/phone run shielded (in tmux) so a server restart or
   * update can't kill them. Missing = on (2026-10-03).
   */
  shieldNewSessions?: boolean;

  /**
   * Idle Claude sessions running an older version than the installed one are restarted on it
   * (2026-10-31, claude-update-restart.ts). Missing = off.
   */
  restartUpdatedClaude?: boolean;

  /**
   * Idle Claude sessions are suspended to free memory and wake on a tap or on input
   * (2026-10-31, session-suspender.ts). Missing = off.
   */
  suspendIdleClaude?: boolean;

  /**
   * The home's cards say in one line what each agent session does, written by a cheap model
   * from the end of its conversation (2026-11-08, agent-explain.ts). Missing = on.
   */
  agentExplain?: boolean;

  /** Minutes without activity before a session is suspended (default 120, at least 15). */
  suspendIdleMinutes?: number;

  /**
   * Untether's disposable folders (task worktrees, control dir, task logs, voice models) marked
   * excluded from Time Machine with `tmutil addexclusion` (2026-11-02; missing = on).
   */
  excludeFromBackups?: boolean;

  /**
   * The code signing identity (SHA-1 of a certificate in the user's keychain) of the stable
   * tmux copy (2026-10-31, stable-tmux.ts): Untether keeps ~/.untether/bin/tmux, a copy of the
   * installed tmux signed with it as dev.untether.tmux, so macOS permissions given to tmux
   * survive tmux upgrades. Missing = off: the installed tmux, as before.
   */
  tmuxSigningIdentity?: string;

  /**
   * Session recordings on disk (2026-11-01, session-recordings.ts): a live session's is rotated
   * once it uses rotateMB of disk (default 64; its newest half and a snapshot of the terminal
   * state stay), a finished session's is trimmed to its last screen finishedDays after it
   * ended (default 2; 0 = never; session.json and the folder stay), and the doctor warns when
   * the control dir passes controlWarnGB (default 3).
   */
  recordings?: { rotateMB?: number; finishedDays?: number; controlWarnGB?: number };
}

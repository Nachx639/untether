/**
 * Shared type definitions used by both frontend and backend
 */

import type { MacOpenMode, MacSizing } from './mac-sessions.js';

/**
 * HTTP methods enum
 */
export enum HttpMethod {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  DELETE = 'DELETE',
  PATCH = 'PATCH',
  HEAD = 'HEAD',
  OPTIONS = 'OPTIONS',
}

/**
 * Types of server events delivered over WebSocket v3 `EVENT` frames.
 * Matches the Swift ServerEventType enum for type safety across platforms.
 */
export enum ServerEventType {
  SessionStart = 'session-start',
  SessionExit = 'session-exit',
  CommandFinished = 'command-finished',
  CommandError = 'command-error',
  Bell = 'bell',
  Connected = 'connected',
  TestNotification = 'test-notification',
  /** `ut open` in a session: viewers of that session show its dev-server preview. */
  PreviewOpen = 'preview-open',
}

/**
 * Server event delivered over WebSocket v3 `EVENT` frames.
 * Matches the Swift ServerEvent struct for cross-platform compatibility.
 */
export interface ServerEvent {
  type: ServerEventType;
  sessionId?: string;
  sessionName?: string;
  command?: string;
  exitCode?: number;
  duration?: number;
  processInfo?: string;
  message?: string;
  timestamp: string; // ISO 8601 format
  // Test notification specific fields
  title?: string;
  body?: string;
  // Preview open specific fields
  port?: number;
  path?: string;
  /** The persistent preview (its view is /preview/<previewId>). */
  previewId?: string;
}

/**
 * Session status enum
 */
export type SessionStatus = 'starting' | 'running' | 'exited';

/**
 * A tmux session outside Untether that a session is attached to: its PTY runs a tmux client
 * of that session, opened from "On this Mac". Disconnecting detaches that client; the tmux
 * session keeps running.
 */
export interface SessionMultiplexer {
  type: 'tmux';
  socketPath: string;
  /** The tmux server process, and its start time in epoch seconds (a restarted one differs). */
  serverPid: number;
  serverStartedAt: number;
  /** tmux's id of the session ("$3"), and its name. */
  sessionId: string;
  sessionName: string;
  mode: MacOpenMode;
  sizing: MacSizing;
  source: 'mac-sessions' | 'multiplexer-modal';
}

/**
 * Core session information stored in session.json
 * Minimal, clean data persisted to disk
 */
/** The `model` of Claude's settings.json when a claude started, and that claude's pid. */
export interface ClaudeStartSettings {
  pid?: number;
  /** Taken when the session's own command launched this claude, before its pid is known. */
  spawned?: boolean;
  model?: string;
  /** The conversations that claude has run (a /clear or /resume adds one). */
  conversations?: string[];
}

export interface SessionInfo {
  id: string;
  name: string;
  command: string[];
  workingDir: string;
  status: SessionStatus;
  exitCode?: number;
  startedAt: string;
  pid?: number;
  initialCols?: number;
  initialRows?: number;
  /**
   * Byte offset of the last clear event in the session stdout file.
   * Used to quickly seek to the most recent content when replaying casts.
   */
  lastClearOffset?: number;
  version?: string; // Untether version that created this session
  gitRepoPath?: string; // Repository root path
  gitBranch?: string; // Current branch name
  gitAheadCount?: number; // Commits ahead of upstream
  gitBehindCount?: number; // Commits behind upstream
  gitHasChanges?: boolean; // Has uncommitted changes
  gitIsWorktree?: boolean; // Is a worktree (not main repo)
  gitMainRepoPath?: string; // Main repository path (same as gitRepoPath if not worktree)
  // Git status details (not persisted to disk, fetched dynamically)
  gitModifiedCount?: number; // Number of modified files
  gitUntrackedCount?: number; // Number of untracked files
  gitStagedCount?: number; // Number of staged files
  gitAddedCount?: number; // Number of added files
  gitDeletedCount?: number; // Number of deleted files
  gitInsertionCount?: number; // Number of inserted lines
  gitDeletionCount?: number; // Number of deleted lines
  /**
   * Whether this session was spawned from within Untether itself.
   * Used to distinguish between direct terminal sessions and nested Untether sessions.
   * Sessions with attachedViaUT=true are spawned from within an existing Untether session.
   */
  attachedViaUT?: boolean;
  /** Claude Code conversation last seen running in this session (resumable with --resume). */
  claudeSessionId?: string;
  /** What Claude's settings.json said when this session's claude started (the doctor's reference). */
  claudeStartSettings?: ClaudeStartSettings;
  /** Claude's conversation title, kept after the session exits. */
  claudeTitle?: string;
  /**
   * The title the user gave the session (rename on the phone). Shown instead of the agent's
   * conversation title and the generated `name`; absent means automatic (shared/session-title.ts).
   */
  userTitle?: string;
  /** The user muted notifications (push, toasts, badge) for this session. */
  muted?: boolean;
  /**
   * Untether restarted its idle Claude on the installed version (2026-10-31, the user's
   * restartUpdatedClaude setting): the session shows "updated to <to>".
   */
  claudeUpdatedTo?: { from?: string; to: string; at: string };
  /** Current DEC private modes set by the app (e.g. mouse reporting), restored on replay. */
  terminalModes?: Record<string, boolean>;
  /**
   * A session this server does not run (a Mac window forwarded by ut-fwd) has no
   * terminalModes: the modes its cast had set by `offset` (a line start) are read from the
   * cast instead, and only what was appended is read on the next replay. `cast` names the
   * cast they were read from (its header's timestamp).
   */
  castModes?: { cast: string; offset: number; modes: Record<string, boolean> };
  /**
   * Shielded session: the program runs in a private tmux session and survives restarts of the
   * Untether server, which attaches to it again on start.
   */
  shielded?: boolean;
  /** Its environment has no credentials (a security sweep's agent, SessionCreateOptions). */
  withoutSecrets?: boolean;
  /** The task it runs (SessionCreateOptions.taskId): its processes carry UNTETHER_TASK_ID. */
  taskId?: string;
  /**
   * The session runs its Claude Code against an external provider (model-providers.ts): its
   * id and model, so a shield restore/wake rebuilds the provider environment (the key is never
   * stored here, only re-read from the Keychain/env). Its row and header show the provider.
   */
  modelProvider?: ProviderSessionMarker;
  /** Put first on its PATH, also when a shield restores it (SessionCreateOptions). */
  pathPrepend?: string;
  /**
   * Its program was started with Untether's Claude Code hooks (claude-hooks.ts): its state
   * comes from their events, and the doctor tells when none come.
   */
  agentHooks?: boolean;
  /**
   * How a shielded session ended: killed by the user, its program ended by itself, its tmux
   * server went away under it (Mac reboot, tmux killed) or restoring it kept failing. Only
   * 'tmux-lost' (and a session still marked running) is brought back on the next start.
   */
  shieldEnd?: 'killed' | 'program-exit' | 'tmux-lost' | 'restore-failed' | 'suspended';
  /** When this shielded session was recreated after its tmux session was lost. */
  restoredAt?: string;
  /** Why it was recreated: the Mac rebooted (found gone at start) or tmux died while running. */
  restoredFrom?: 'reboot' | 'tmux-lost';
  /** Times (epoch ms) of recent automatic restores, to stop restore loops. */
  shieldRestores?: number[];
  /** Attached to a tmux session outside Untether (never shielded). */
  multiplexer?: SessionMultiplexer;
  /**
   * When the session's PTY process started (ProcessUtils.processStartTime), set by the server
   * that spawned it. It tells a pid that still is that process from one the kernel reused, and
   * marks the session as a PTY of a server (it dies with that server).
   */
  pidStartTime?: string;
  /**
   * The ut-fwd process that runs this session in a terminal window of the Mac (written by
   * ut-fwd). Its presence marks the session as forwarded (shared/forwarded-session.ts).
   */
  forwarderPid?: number;
  /**
   * The notice a Kill carried (Llevar a Untether) reached the window, written by ut-fwd once
   * the program ended; the server writes it itself only without this (move-to-untether.ts).
   */
  windowNoticeWritten?: boolean;
  /**
   * The Codex thread the session runs or last ran (its command, or `codex` typed in its shell;
   * services/codex-thread.ts): what "Resume", Blindar and a restore continue with
   * `codex resume <id>`.
   */
  codexThreadId?: string;
  /**
   * Claude Code seen running inside this terminal at the last look (services/terminal-claude.ts):
   * gone when it ended, so a shielded terminal comes back on it only if it was still running.
   */
  terminalClaude?: TerminalClaude;
  /**
   * Untether suspended this idle Claude session to free memory (2026-10-31,
   * services/session-suspender.ts): its Claude ended, the session stays listed as paused and
   * wakes (same id, `claude --resume`) when tapped or when something is typed into it.
   */
  suspended?: SessionSuspension;
  /** The user said never to suspend this session ("keep awake" in its menu). */
  keepAwake?: boolean;
  /**
   * The group the user anchored the session to (its menu: "Anclar a este grupo", "Mover a…"),
   * winning over the automatic grouping; absent means automatic ("Quitar ancla"). Follows the
   * Claude conversation like userTitle. UI only: the running program is never touched.
   */
  groupPin?: SessionGroupPin;
}

/** A project's folder (its main checkout, or a folder outside git), or null for "Otras". */
export interface SessionGroupPin {
  repoPath: string | null;
  /** repoPath is a git repository (else a project folder outside git). */
  git?: boolean;
}

/** What a suspended session keeps to wake again (SessionInfo.suspended). */
export interface SessionSuspension {
  /** When it was suspended (ISO). */
  at: string;
  /** The Claude conversation it resumes. */
  claudeSessionId: string;
  /** The command it ran, and where (its flags come back with the resume). */
  command: string[];
  workingDir: string;
  shielded: true;
  /** How long Claude had been idle when it was suspended. */
  idleMinutes: number;
  /** Suspended because the user asked (its menu), not by the idle look. */
  byUser?: true;
  /** The project it orchestrated, and the tasks linked to it, when it was suspended. */
  orchestratorOf?: string;
  tasks?: string[];
  /**
   * Input that came while it was being stopped, kept on disk until a wake types it (any
   * wake: the immediate one, or a later tap if that one failed).
   */
  pendingInput?: SessionInput[];
  /** A wake on its way (ISO): Claude is starting again. */
  wakingAt?: string;
  /** The last wake failed: why, and when (the session stays suspended, with a retry). */
  resumeError?: string;
  resumeErrorAt?: string;
}

/**
 * Session as returned by API endpoints
 * Includes everything from SessionInfo plus additional runtime/computed fields
 */
export interface Session extends SessionInfo {
  lastModified: string;
  active?: boolean;

  activityStatus?: {
    isActive: boolean;
    lastActivityAt?: string;
  };

  /** Claude Code running in this session: "idle", "busy" or "waiting" (for the user). */
  /** Exited Claude session whose conversation can be resumed (`claude --resume`). */
  claudeResumable?: boolean;

  /** Exited Codex session whose thread can be resumed (`codex resume <id>`). */
  codexResumable?: boolean;

  /**
   * Where the session's Claude works now, when it moved away from the folder the session
   * started in (a session opened in ~ or ~/Projects whose recent work is mostly, and for a
   * while, in one project; a burst of commands there does not count: claude-chat.ts
   * trackWork), and that folder's repository (main checkout). The home groups the session there.
   */
  workDir?: string;
  workRepoPath?: string;

  claudeStatus?: {
    status: string;
    waitingFor?: string;
    /** Conversation title generated by Claude Code. */
    title?: string;
    /** Last user or assistant message, one line. */
    preview?: { role: 'user' | 'assistant'; text: string };
    /**
     * While waiting: the menu on screen (permission prompts), answered through /answer, and what
     * it is about ("Bash command", the command), which tells apart prompts with the same options.
     */
    choices?: { question: string; options: string[]; detail?: string[]; key?: string };
    /** When the current status began (epoch ms). */
    since?: number;
    /**
     * While busy: what Claude is doing right now. `kind` "tool" names the tool still running
     * and its short subject (command, file name, pattern, host…); `since` is when that began.
     */
    activity?: {
      kind: 'thinking' | 'writing' | 'tool';
      tool?: string;
      target?: string;
      since?: number;
    };
    /**
     * Busy only because background agents or tasks still run: Claude's reply is over and it
     * waits for the user (Claude Code says "busy" until they all end).
     */
    waitingForBackground?: boolean;
  };

  /**
   * Running Codex session (started directly or typed in a shell): its state from what Codex
   * itself records, its rollout (server codex-session-status.ts), in the words of
   * `claudeStatus.status`. Absent while its rollout says nothing yet (no turn so far, a resumed
   * thread): the session's output time decides then, as for a shell.
   */
  agentStatus?: SessionAgentStatus;

  /**
   * Running agent session: what it is doing now or why it stopped, in ≤ 80 characters and the
   * client's language (GET /sessions?lang=…, server agent-explain.ts). Only while it fits the
   * session's current status; the card shows its own short status without it.
   */
  explain?: { text: string; at: number };

  /**
   * Running non-Claude session: the last line of output on screen, without the shell prompt
   * (plain text, at most 120 characters). Only for authenticated list requests.
   */
  lastLine?: string;

  /**
   * OpenAI Codex session, running or ended: its thread's name (Codex's own, or the user's
   * `/rename`), else its first prompt, as the conversation title.
   */
  codexTitle?: string;

  /** OpenAI Codex runs in this session (its command, or typed inside its shell). */
  codexActive?: boolean;

  /** Running Google Gemini CLI session: its first prompt, as the conversation title. */
  geminiTitle?: string;

  /** Gemini CLI runs in this session (its command, or typed inside its shell). */
  geminiActive?: boolean;

  /** Dev servers seen in this session (announced in its output or opened with `ut open`). */
  previewPorts?: PreviewPort[];

  /**
   * Opened with ut in a terminal window on this computer (isForwardedSession): the app that
   * window belongs to ("Terminal", "iTerm", "Visual Studio Code"…), from the forwarder's
   * ancestors, or null when it can't be told. The phone shows it under "On this Mac", not
   * among the running sessions.
   */
  macWindow?: { app: string | null };

  // Source information (for HQ mode)
  source?: 'local' | 'remote';
  remoteId?: string;
  remoteName?: string;
  remoteUrl?: string;
}

/** How a preview got into the list: `ut open`, a URL in a session's output, or by hand. */
export type PreviewSource = 'detected' | 'ut-open' | 'manual';

/** A dev server a session opened or announced (its preview chip). */
export interface PreviewPort {
  /** The persistent preview's id: its view is `/preview/<id>`. */
  id?: string;
  port: number;
  /** URL as the dev server printed it. */
  url?: string;
  source: PreviewSource;
  /** Last opened or announced (epoch ms). */
  at: number;
  /** Server-side health check (every ~10 s): answering or not; absent until first checked. */
  state?: 'live' | 'down';
  /** The app's page <title> (or the name the user gave it). */
  title?: string;
}

/**
 * A persistent preview (GET /api/previews, 2026-10-03): one per loopback port, kept across
 * sessions and server restarts in previews.json.
 */
export interface PreviewItem {
  id: string;
  port: number;
  /** Page inside the app to open. */
  path: string;
  /** The app's page <title>, when the health check could read it. */
  title?: string;
  /** Name the user gave it (Rename). */
  customName?: string;
  createdAt: number;
  /** Last time its dev server answered (epoch ms). */
  lastSeenAt?: number;
  /** Last `ut open`, announcement or manual add (epoch ms): newest first. */
  lastOpenedAt: number;
  /** Session that opened or announced it last (a link; it may be gone). */
  sessionId?: string;
  sessionName?: string;
  /** That session still exists on this server. */
  sessionAlive?: boolean;
  pinned: boolean;
  source: PreviewSource;
  /** Absent until the first health check. */
  state?: 'live' | 'down';
}

/**
 * A web server listening on this Mac that isn't a preview yet (GET /api/previews/candidates):
 * one item of the "+ Añadir vista previa" sheet.
 */
export interface PreviewCandidate {
  port: number;
  /** Its page <title>, when `/` is an HTML page that has one. */
  title?: string;
  /** Process name as lsof reports it ("node", "Python"). */
  process?: string;
  /** Last part of the process's working directory (the project folder, usually). */
  folder?: string;
}

/**
 * Terminal title management modes
 */
export enum TitleMode {
  NONE = 'none', // No title management
  FILTER = 'filter', // Block all title changes from apps
  STATIC = 'static', // Static title: path — command — session
}

/**
 * Session creation options
 */
export interface SessionCreateOptions {
  sessionId?: string;
  name?: string;
  workingDir?: string;
  cols?: number;
  rows?: number;
  titleMode?: TitleMode;
  gitRepoPath?: string;
  gitBranch?: string;
  gitAheadCount?: number;
  gitBehindCount?: number;
  gitHasChanges?: boolean;
  gitIsWorktree?: boolean;
  gitMainRepoPath?: string;
  /** Run the program in a shielded (tmux-backed) session that survives server restarts. */
  shielded?: boolean;
  /** Attach to a tmux session outside Untether; never together with `shielded`. */
  multiplexer?: SessionMultiplexer;
  /**
   * Titles carried over from the session this one replaces ("Blindar"). A command resuming a
   * Claude conversation inherits them on its own (shared/session-title.ts `inheritedTitles`).
   */
  userTitle?: string;
  claudeTitle?: string;
  groupPin?: SessionGroupPin;
  /**
   * A security sweep's agent (2026-10-23): its environment loses every variable that looks
   * like a credential (session-env.ts withoutSecrets), also when a shield restores it.
   */
  withoutSecrets?: boolean;
  /**
   * A task's session (2026-11-02): UNTETHER_TASK_ID=<id> in its environment, inherited by every
   * process it starts, reparented or not, also when a shield restores or wakes it; the task's
   * guard lets it kill them and Untether ends those left behind (task-processes.ts).
   */
  taskId?: string;
  /**
   * Extra environment for the program, merged last over the session environment (model
   * providers: ANTHROPIC_BASE_URL/_AUTH_TOKEN and the provider's model variables). The key is
   * passed here, never on argv.
   */
  env?: Record<string, string>;
  /** Variables removed from the inherited environment (the user's own Anthropic credentials). */
  unsetEnv?: string[];
  /** The provider this session runs against (model-providers.ts), for restore and the UI. */
  modelProvider?: ProviderSessionMarker;
  /**
   * A folder put first on the program's PATH, after its login profile too (2026-11-02: a task
   * whose project asks for another Node than the default, utils/node-runtime.ts).
   */
  pathPrepend?: string;
}

/**
 * A Claude Code running in a terminal, whatever launched it. Never an environment value: only
 * variable names, and the configured provider that can rebuild them.
 */
export interface TerminalClaude {
  conversationId: string;
  pid: number;
  /** The folder Claude runs in (its conversation belongs to that folder). */
  cwd: string;
  /** The flags a resume carries (allow-listed, services/terminal-claude.ts). */
  flags: string[];
  /** Names of the backend variables a plain resume would not reproduce (empty: none). */
  customEnv: string[];
  /** The configured provider that can bring those variables back on a restore, when one can. */
  modelProvider?: ProviderSessionMarker;
  /**
   * The configured provider this Claude talks to, by the host of its base URL: the row's mark
   * (sessionProviderMarker), also when a restore could not reproduce its environment.
   */
  detectedProvider?: ProviderSessionMarker;
}

/** A session running against an external model provider (model-providers.ts). */
export interface ProviderSessionMarker {
  /** The provider id (UntetherConfig.modelProviders). */
  id: string;
  /** The model the session runs on. */
  model: string;
}

/**
 * Session input (keyboard/special keys)
 */
export interface SessionInput {
  text?: string;
  key?: SpecialKey;
}

/**
 * Special keys that can be sent to sessions
 */
export type SpecialKey =
  | 'arrow_up'
  | 'arrow_down'
  | 'arrow_left'
  | 'arrow_right'
  | 'escape'
  | 'enter'
  | 'ctrl_enter'
  | 'shift_enter'
  | 'backspace'
  | 'tab'
  | 'shift_tab'
  | 'page_up'
  | 'page_down'
  | 'home'
  | 'end'
  | 'delete'
  | 'f1'
  | 'f2'
  | 'f3'
  | 'f4'
  | 'f5'
  | 'f6'
  | 'f7'
  | 'f8'
  | 'f9'
  | 'f10'
  | 'f11'
  | 'f12';

/**
 * Push notification subscription
 */
export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Stored push subscription with metadata
 */
export interface StoredPushSubscription extends PushSubscription {
  id: string;
  deviceId: string;
  userAgent?: string;
  createdAt: string;
  lastUsed: string;
}

/**
 * Push notification preferences
 */
export interface PushNotificationPreferences {
  enabled: boolean;
  sessionExit: boolean;
  sessionStart: boolean;
  sessionError: boolean;
  commandNotifications: boolean;
  systemAlerts: boolean;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
}

/**
 * Push notification types
 */
export type PushNotificationType =
  | 'session_exit'
  | 'session_start'
  | 'session_error'
  | 'system_alert'
  | 'test';

/**
 * Push notification data
 */
export interface PushNotificationData {
  type: PushNotificationType;
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: Record<string, unknown>;
  actions?: Array<{
    action: string;
    title: string;
    icon?: string;
  }>;
  requireInteraction?: boolean;
  silent?: boolean;
}

/**
 * Push notification history entry
 */
export interface PushNotificationHistoryEntry {
  id: string;
  timestamp: string;
  type: PushNotificationType;
  title: string;
  body: string;
  success: boolean;
  error?: string;
  deviceId?: string;
}

/**
 * Device registration for push notifications
 */
export interface PushDeviceRegistration {
  deviceId: string;
  subscription: PushSubscription;
  userAgent?: string;
}

/**
 * Server status information
 */
export interface ServerStatus {
  macAppConnected: boolean;
  isHQMode: boolean;
  version: string;
}

/** An agent's state for the session list when it is not Claude Code (Session.agentStatus). */
export interface SessionAgentStatus {
  agent: 'codex';
  status: 'busy' | 'waiting' | 'idle';
  /** When this status began (epoch ms). */
  since?: number;
  /** While waiting: what it asks, one line. */
  waitingFor?: string;
  /**
   * While waiting on a menu of its own (approval, trust this folder, update): the menu on
   * screen, answered through /answer like Claude's (`claudeStatus.choices`).
   */
  choices?: { question: string; options: string[]; detail?: string[]; key?: string };
  /** Idle because its turn was cut short (a usage limit, an API error, a lost login). */
  halted?: 'usage-limit' | 'api-error' | 'auth' | 'model';
}

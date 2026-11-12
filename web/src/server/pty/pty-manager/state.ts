/** Fields, construction and small shared helpers of PtyManager. Part of PtyManager (pty-manager.ts). */

import { execFile } from 'child_process';
import { EventEmitter } from 'events';

import type * as net from 'net';

import { promisify } from 'util';
import type { ProviderSessionMarker, SessionInfo, SessionInput } from '../../../shared/types.js';
import { codexInlineCommand } from '../../services/codex-process.js';
import { ProcessTreeAnalyzer } from '../../services/process-tree-analyzer.js';
import type { SessionMonitor } from '../../services/session-monitor.js';
import { ShieldTmux } from '../../services/shielded-tmux.js';
import { TmuxAttachTracker, type TmuxClient } from '../../services/tmux-attach-tracker.js';
import { ProcessUtils } from '../process-utils.js';
import { SessionManager } from '../session-manager.js';
import { ShieldProgramPids } from '../shield-program-pids.js';
import { SizeOwners } from '../size-owner.js';
import type {
  KillControlMessage,
  PtySession,
  ResetSizeControlMessage,
  ResizeControlMessage,
} from '../types.js';
import { logger, setPty } from './helpers.js';

export abstract class PtyManagerState extends EventEmitter {
  protected sessions = new Map<string, PtySession>();
  // Sessions whose foreground command is tracked; one shared timer polls all of them.
  protected foregroundTracked = new Set<PtySession>();
  protected foregroundPollTimer: NodeJS.Timeout | null = null;
  protected foregroundPollRunning = false;
  protected sessionManager: SessionManager;
  protected defaultTerm = 'xterm-256color';
  protected inputSocketClients = new Map<string, net.Socket>(); // Cache socket connections
  protected lastInputTimestamps = new Map<string, number>();
  /** The user's own keys per session (noteUserInput), apart from what Untether types. */
  protected userInputTimestamps = new Map<string, number>();
  /** Sessions being suspended, and the input that came meanwhile (suspendShieldedSession). */
  protected inputDuringSuspend = new Map<string, SessionInput[]>();
  protected sessionResizeSources = new Map<
    string,
    { cols: number; rows: number; timestamp: number }
  >();
  /** Who owns each session's size, and the sizes sent to it (size-owner.ts). */
  protected sizeOwners = new SizeOwners();
  /** Whether a page (client-id.ts) shows a session on a visible page now (ws-v3-hub). */
  protected clientViewing: (clientId: string, sessionId: string) => boolean = () => true;
  /**
   * How long a page (client-id.ts) has been away from a session (ws-v3-hub clientAwayMs):
   * 0 while it shows it on a visible page, null when the server knows nothing of that page.
   */
  protected clientAway: (clientId: string, sessionId: string) => number | null = () => null;
  /** Whether a page other than `exceptClientId` really looks at a session (ws-v3-hub). */
  protected viewedElsewhere: (sessionId: string, exceptClientId: string) => boolean = () => false;
  /** Checks page-owned Mac-window sessions for an owner gone away (sweepSizeOwners). */
  protected sizeSweepTimer: NodeJS.Timeout | null = null;
  protected static initialized = false;
  protected sessionEventListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  /** Shielded sessions whose last input scrolled tmux's history (shieldScrollsTmuxHistory). */
  protected shieldCopyMode = new Set<string>();
  protected sessionExitTimes = new Map<string, number>(); // Track session exit times to avoid false bells
  protected processTreeAnalyzer = new ProcessTreeAnalyzer(); // Process tree analysis for bell source identification
  protected sessionMonitor: SessionMonitor | null = null; // Reference to SessionMonitor for notification tracking

  protected shieldTmux: ShieldTmux;
  /** pid of the program inside each shielded session (the session's pid is the tmux client). */
  protected shieldProgramPids: ShieldProgramPids;
  /** The pane each session attached to a user's tmux session shows (`multiplexer`). */
  protected attachTracker: TmuxAttachTracker;

  /**
   * Rewrites the command a session's program is spawned with (the server adds Untether's
   * Claude Code hooks: claude-hooks.ts). Only the spawn: the session keeps its own command, so
   * a resume or a restore that reads it is rewritten again, never twice.
   */
  protected spawnRewriter: (command: string[]) => string[] = (command) => command;

  setSpawnRewriter(rewrite: (command: string[]) => string[]): void {
    this.spawnRewriter = rewrite;
  }

  /**
   * Rebuilds the environment of a session running against an external model provider
   * (model-providers.ts), re-reading the key from the Keychain/env. Set by the server; a shield
   * restore or wake uses it so the session comes back with the provider variables, not the
   * user's own Anthropic login. Null when the provider is gone or the key cannot be read.
   */
  public providerEnvResolver?: (
    marker: ProviderSessionMarker
  ) => Promise<{ env: Record<string, string>; unset: string[] } | null>;

  setProviderEnvResolver(
    resolver: (
      marker: ProviderSessionMarker
    ) => Promise<{ env: Record<string, string>; unset: string[] } | null>
  ): void {
    this.providerEnvResolver = resolver;
  }

  /**
   * Applies a provider marker's environment onto `env` in place: the provider's variables
   * merged over it and the user's own Anthropic credentials removed. Returns the resolved
   * provider launch (its variables and the names it removes) so a shielded session can apply
   * them to the program itself, never to the shared tmux server; null when there is no marker or
   * no resolver, or the provider could not be resolved.
   */
  protected async applyProviderEnv(
    env: Record<string, string>,
    marker: ProviderSessionMarker | undefined
  ): Promise<{ env: Record<string, string>; unset: string[] } | null> {
    if (!marker || !this.providerEnvResolver) return null;
    let resolved: { env: Record<string, string>; unset: string[] } | null = null;
    try {
      resolved = await this.providerEnvResolver(marker);
    } catch (error) {
      logger.warn(`provider env for ${marker.id} could not be rebuilt: ${error}`);
    }
    if (!resolved) return null;
    for (const key of resolved.unset) delete env[key];
    Object.assign(env, resolved.env);
    return resolved;
  }

  /** The command to spawn; with a session, whether it got hooks is noted on it (agentHooks). */
  /**
   * The one place a session's command is resolved before it runs, whichever way it starts: new
   * sessions, tasks, orchestrators, restores and wake-ups (codex-process.test.ts fails on a new
   * caller of ProcessUtils.resolveCommand). Codex runs inline here (codexInlineCommand).
   */
  protected resolveSpawn(command: string[]): ReturnType<typeof ProcessUtils.resolveCommand> {
    return ProcessUtils.resolveCommand(codexInlineCommand(command));
  }

  protected spawnCommand(command: string[], sessionId?: string): string[] {
    let spawned = command;
    try {
      spawned = this.spawnRewriter(command);
    } catch (error) {
      logger.warn(`spawn command rewrite failed, spawning it as it is: ${error}`);
    }
    if (sessionId)
      this.patchSessionInfo(sessionId, { agentHooks: spawned !== command || undefined });
    return spawned;
  }

  constructor(controlPath?: string, options: { attachTracker?: TmuxAttachTracker } = {}) {
    super();
    this.sessionManager = new SessionManager(controlPath);
    this.shieldTmux = new ShieldTmux(this.sessionManager.getControlPath());
    this.shieldProgramPids = new ShieldProgramPids(
      (sessionId) => this.shieldTmux.panePid(sessionId),
      (pid) => ProcessUtils.isProcessRunning(pid),
      undefined,
      (sessionIds) => this.shieldTmux.panePids(sessionIds)
    );
    this.processTreeAnalyzer = new ProcessTreeAnalyzer();
    this.attachTracker = options.attachTracker ?? new TmuxAttachTracker();
    this.attachTracker.onChange((sessionId, client) => this.reconcileAttached(sessionId, client));

    // Initialize node-pty if not already done
    if (!PtyManagerState.initialized) {
      throw new Error('PtyManager not initialized. Call PtyManager.initialize() first.');
    }
  }

  /**
   * Initialize PtyManager with fallback support for node-pty
   */
  public static async initialize(): Promise<void> {
    if (PtyManagerState.initialized) {
      return;
    }

    try {
      logger.log('Initializing PtyManager...');
      setPty(await import('node-pty'));
      PtyManagerState.initialized = true;
      logger.log('✅ PtyManager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize PtyManager:', error);
      throw new Error(
        `Cannot load node-pty: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Set the SessionMonitor instance for notification tracking
   */
  public setSessionMonitor(monitor: SessionMonitor): void {
    this.sessionMonitor = monitor;
  }

  /** Extra reader of every session's raw output (dev-server URL detection for previews). */
  protected outputObserver: ((sessionId: string, data: string) => void) | null = null;
  public setOutputObserver(observer: (sessionId: string, data: string) => void): void {
    this.outputObserver = observer;
  }

  /**
   * Input for shielded sessions between two tmux clients, typed once the next one attaches.
   * Each chunk keeps its own time (2026-10-20: the age counted from the first chunk, so a
   * fresh keystroke was dropped with an old one, or an old one typed with a fresh one).
   */
  protected pendingShieldInput = new Map<string, Array<{ at: number; data: string }>>();
  /** Shielded sessions whose next tmux client is on its way, until when (ms). */
  protected shieldReattachPendingUntil = new Map<string, number>();

  protected terminalModesSaveTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Create environment variables for sessions
   */
  protected createEnvVars(term: string): Record<string, string> {
    const envVars: Record<string, string> = {
      TERM: term,
    };

    // Include other important terminal-related environment variables if they exist
    const importantVars = ['SHELL', 'LANG', 'LC_ALL', 'PATH', 'USER', 'HOME'];
    for (const varName of importantVars) {
      const value = process.env[varName];
      if (value) {
        envVars[varName] = value;
      }
    }

    return envVars;
  }

  /** Merge fields into a session's session.json (and its in-memory copy). */
  protected patchSessionInfo(sessionId: string, patch: Partial<SessionInfo>): void {
    try {
      const info = this.sessionManager.loadSessionInfo(sessionId);
      if (!info) return;
      Object.assign(info, patch);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete (info as unknown as Record<string, unknown>)[key];
      }
      this.sessionManager.saveSessionInfo(sessionId, info);
      const memory = this.sessions.get(sessionId);
      if (memory) Object.assign(memory.sessionInfo, patch);
    } catch (error) {
      logger.warn(`cannot update session.json of ${sessionId}:`, error);
    }
  }

  /**
   * Get session manager instance
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Track and emit events for proper cleanup
   */
  protected trackAndEmit(event: string, sessionId: string, ...args: unknown[]): void {
    const listeners = this.listeners(event) as ((...args: unknown[]) => void)[];
    if (!this.sessionEventListeners.has(sessionId)) {
      this.sessionEventListeners.set(sessionId, new Set());
    }
    const sessionListeners = this.sessionEventListeners.get(sessionId);
    if (!sessionListeners) {
      return;
    }
    listeners.forEach((listener) => {
      sessionListeners.add(listener);
    });
    this.emit(event, sessionId, ...args);
  }

  protected execFileAsync = promisify(execFile);

  // Implemented by the later layers (pty-manager/*.ts), called from earlier ones.
  protected abstract sendControlMessage(
    sessionId: string,
    message: ResizeControlMessage | KillControlMessage | ResetSizeControlMessage
  ): boolean;
  protected abstract scheduleTerminalModesSave(session: PtySession): void;
  protected abstract cleanupSessionResources(session: PtySession): void;
  protected abstract loadSessionInfoSafe(sessionId: string): SessionInfo | null;
  abstract updateSessionName(sessionId: string, name: string): string;
  abstract reattachShieldedSession(
    sessionId: string,
    reattachTimes?: number[],
    banner?: string
  ): Promise<boolean>;
  abstract restoreOrFinishShieldedSession(
    sessionId: string,
    from: 'reboot' | 'tmux-lost'
  ): Promise<boolean>;
  protected abstract reconcileAttached(sessionId: string, client: TmuxClient): void;
}

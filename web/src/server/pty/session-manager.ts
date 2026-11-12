/**
 * SessionManager - Centralized management for terminal session lifecycle and persistence
 *
 * This class provides a comprehensive solution for managing terminal sessions in Untether.
 * It handles session directory structure, metadata persistence, process tracking, and
 * file operations while maintaining compatibility with the tty-fwd format.
 *
 * ## Key Features:
 * - **Session Lifecycle Management**: Create, track, and cleanup terminal sessions
 * - **Persistent Storage**: Store session metadata and I/O streams in filesystem
 * - **Process Tracking**: Monitor running processes and detect zombie sessions
 * - **Version Management**: Handle cleanup across Untether version upgrades
 * - **Unique Naming**: Ensure session names are unique with automatic suffix handling
 * - **Atomic Operations**: Use temp files and rename for safe metadata updates
 *
 * ## Directory Structure:
 * ```
 * ~/.untether/control/
 * ├── .version                    # Untether version tracking
 * └── [session-id]/              # Per-session directory
 *     ├── session.json           # Session metadata
 *     ├── stdout                 # Process output stream
 *     └── ipc.sock               # Live input and control commands
 * ```
 *
 * ## Session States:
 * - `starting`: Session is being initialized
 * - `running`: Process is active and accepting input
 * - `exited`: Process has terminated
 *
 * @example
 * ```typescript
 * // Initialize session manager
 * const manager = new SessionManager();
 *
 * // Create a new session
 * const paths = manager.createSessionDirectory('session-123');
 *
 * // Save session metadata
 * manager.saveSessionInfo('session-123', {
 *   name: 'Development Server',
 *   status: 'starting',
 *   pid: 12345,
 *   startedAt: new Date().toISOString()
 * });
 *
 * // Update session status when process starts
 * manager.updateSessionStatus('session-123', 'running', 12345);
 *
 * // List all sessions
 * const sessions = manager.listSessions();
 * console.log(`Found ${sessions.length} sessions`);
 *
 * // Cleanup when done
 * manager.updateSessionStatus('session-123', 'exited', undefined, 0);
 * manager.cleanupSession('session-123');
 * ```
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Session, SessionInfo } from '../../shared/types.js';
import { colors } from '../utils/colors.js';
import { createLogger } from '../utils/logger.js';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './private-perms.js';
import { ProcessUtils } from './process-utils.js';
import { PtyError } from './types.js';

const logger = createLogger('session-manager');

/** How often a running session's pid is checked against its recorded start time. */
const PID_VERIFY_INTERVAL_MS = 60_000;

/**
 * Fields others change in session.json while the server holds a copy of it in memory: a rename
 * or a title on the phone, mute, the Claude conversation or Codex thread found running.
 */
export const CONCURRENT_SESSION_FIELDS = [
  'name',
  'userTitle',
  'claudeTitle',
  'claudeSessionId',
  'codexThreadId',
  'terminalClaude',
  'muted',
  'groupPin',
] as const satisfies ReadonlyArray<keyof SessionInfo>;

/**
 * Take into `memory` what session.json says now for CONCURRENT_SESSION_FIELDS (set or
 * cleared), before `memory` is written back whole.
 *
 * 2026-10-20: createSession wrote its in-memory copy after several awaits (tmux, spawn), and a
 * rename or title set meanwhile was lost.
 */
export function mergeConcurrentFields(memory: SessionInfo, disk: SessionInfo | null): SessionInfo {
  if (!disk) return memory;
  const target = memory as unknown as Record<string, unknown>;
  const source = disk as unknown as Record<string, unknown>;
  for (const key of CONCURRENT_SESSION_FIELDS) {
    if (source[key] === undefined) delete target[key];
    else target[key] = source[key];
  }
  return memory;
}

export class SessionManager {
  private controlPath: string;
  private static readonly SESSION_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
  private sessionInfoCache = new Map<string, { key: string; info: SessionInfo | null }>();

  constructor(controlPath?: string) {
    this.controlPath = controlPath || path.join(os.homedir(), '.untether', 'control');
    logger.debug(`initializing session manager with control path: ${this.controlPath}`);
    this.ensureControlDirectory();
  }

  /**
   * Validate session ID format for security
   */
  private validateSessionId(sessionId: string): void {
    if (!SessionManager.SESSION_ID_REGEX.test(sessionId)) {
      throw new PtyError(
        `Invalid session ID format: "${sessionId}". Session IDs must only contain letters, numbers, hyphens (-), and underscores (_).`,
        'INVALID_SESSION_ID'
      );
    }
  }

  /**
   * Ensure the control directory exists
   */
  private ensureControlDirectory(): void {
    if (!fs.existsSync(this.controlPath)) {
      fs.mkdirSync(this.controlPath, { recursive: true, mode: PRIVATE_DIR_MODE });
      logger.debug(colors.green(`control directory created: ${this.controlPath}`));
    }
  }

  /**
   * Create a new session directory structure
   */
  createSessionDirectory(sessionId: string): {
    controlDir: string;
    stdoutPath: string;
    sessionJsonPath: string;
  } {
    this.validateSessionId(sessionId);
    const controlDir = path.join(this.controlPath, sessionId);

    // Create session directory
    if (!fs.existsSync(controlDir)) {
      fs.mkdirSync(controlDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    }

    const paths = this.getSessionPaths(sessionId, true);
    if (!paths) {
      throw new Error(`Session ${sessionId} not found`);
    }

    logger.debug(colors.green(`session directory created for ${sessionId}`));
    return paths;
  }

  /**
   * Save session info to JSON file
   */
  saveSessionInfo(sessionId: string, sessionInfo: SessionInfo): void {
    this.validateSessionId(sessionId);
    try {
      const sessionDir = path.join(this.controlPath, sessionId);
      const sessionJsonPath = path.join(sessionDir, 'session.json');
      const tempPath = `${sessionJsonPath}.tmp`;

      // Ensure session directory exists before writing
      if (!fs.existsSync(sessionDir)) {
        logger.warn(`Session directory ${sessionDir} does not exist, creating it`);
        fs.mkdirSync(sessionDir, { recursive: true, mode: PRIVATE_DIR_MODE });
      }

      const sessionInfoStr = JSON.stringify(sessionInfo, null, 2);

      // Write to temporary file first, then move to final location (atomic write)
      fs.writeFileSync(tempPath, sessionInfoStr, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });

      // Double-check directory still exists before rename (handle race conditions)
      if (!fs.existsSync(sessionDir)) {
        logger.error(`Session directory ${sessionDir} was deleted during save operation`);
        // Clean up temp file if it exists
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
        throw new PtyError(
          `Session directory was deleted during save operation`,
          'SESSION_DIR_DELETED'
        );
      }

      fs.renameSync(tempPath, sessionJsonPath);
      logger.debug(
        `session.json file saved for session ${sessionId} with name: ${sessionInfo.name}`
      );
    } catch (error) {
      if (error instanceof PtyError) {
        throw error;
      }
      throw new PtyError(
        `Failed to save session info: ${error instanceof Error ? error.message : String(error)}`,
        'SAVE_SESSION_FAILED'
      );
    }
  }

  /**
   * Load session info from JSON file
   */
  loadSessionInfo(sessionId: string): SessionInfo | null {
    const sessionJsonPath = path.join(this.controlPath, sessionId, 'session.json');
    try {
      if (!fs.existsSync(sessionJsonPath)) {
        return null;
      }

      const content = fs.readFileSync(sessionJsonPath, 'utf8');
      const parsed = JSON.parse(content) as SessionInfo;

      // Defensive: legacy session.json files might have unexpected types.
      if (typeof parsed.gitRepoPath !== 'string') {
        delete (parsed as Partial<SessionInfo>).gitRepoPath;
      }
      if (typeof parsed.gitMainRepoPath !== 'string') {
        delete (parsed as Partial<SessionInfo>).gitMainRepoPath;
      }
      if (typeof parsed.gitBranch !== 'string') {
        delete (parsed as Partial<SessionInfo>).gitBranch;
      }

      return parsed;
    } catch (error) {
      logger.warn(`failed to load session info for ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Update session status
   */
  updateSessionStatus(sessionId: string, status: string, pid?: number, exitCode?: number): void {
    const sessionInfo = this.loadSessionInfo(sessionId);
    if (!sessionInfo) {
      throw new PtyError('Session info not found', 'SESSION_NOT_FOUND');
    }

    if (pid !== undefined) {
      sessionInfo.pid = pid;
    }
    sessionInfo.status = status as 'starting' | 'running' | 'exited';
    if (exitCode !== undefined) {
      sessionInfo.exitCode = exitCode;
    }

    this.saveSessionInfo(sessionId, sessionInfo);
    logger.debug(
      `session ${sessionId} status updated to ${status}${pid ? ` (pid: ${pid})` : ''}${exitCode !== undefined ? ` (exit code: ${exitCode})` : ''}`
    );
  }

  /**
   * Ensure a session name is unique by adding a suffix if necessary
   */
  private ensureUniqueName(desiredName: string, excludeSessionId?: string): string {
    const sessions = this.listSessions();
    let finalName = desiredName;
    let suffix = 2;

    // Keep checking until we find a unique name
    while (true) {
      const nameExists = sessions.some(
        (session) => session.name === finalName && session.id !== excludeSessionId
      );

      if (!nameExists) {
        break;
      }

      // Add or increment suffix
      finalName = `${desiredName} (${suffix})`;
      suffix++;
    }

    return finalName;
  }

  /**
   * Update session name
   */
  updateSessionName(sessionId: string, name: string): string {
    logger.debug(
      `[SessionManager] updateSessionName called for session ${sessionId} with name: ${name}`
    );

    const sessionInfo = this.loadSessionInfo(sessionId);
    if (!sessionInfo) {
      logger.error(`[SessionManager] Session info not found for ${sessionId}`);
      throw new PtyError('Session info not found', 'SESSION_NOT_FOUND');
    }

    logger.debug(`[SessionManager] Current session info: ${JSON.stringify(sessionInfo)}`);

    // Ensure the name is unique
    const uniqueName = this.ensureUniqueName(name, sessionId);

    if (uniqueName !== name) {
      logger.debug(`[SessionManager] Name "${name}" already exists, using "${uniqueName}" instead`);
    }

    sessionInfo.name = uniqueName;

    logger.debug(`[SessionManager] Updated session info: ${JSON.stringify(sessionInfo)}`);
    logger.debug(`[SessionManager] Calling saveSessionInfo`);

    this.saveSessionInfo(sessionId, sessionInfo);
    logger.debug(`[SessionManager] session ${sessionId} name updated to: ${uniqueName}`);

    return uniqueName;
  }

  /**
   * List all sessions
   */
  listSessions(): Session[] {
    return this.scanSessions().sessions;
  }

  /**
   * List all sessions, and which running sessions were just found dead (and marked exited).
   */
  listSessionsAndZombies(): { sessions: Session[]; zombies: string[] } {
    return this.scanSessions();
  }

  /**
   * session.json of a session, re-parsed only when the file changed (inode, mtime or size).
   * The returned object is shared with the cache: callers must not mutate it.
   *
   * 2026-10-02: GET /sessions (polled every second by each client) read and parsed every
   * session.json twice per request with sync fs (existsSync + readFileSync, plus a second full
   * scan for zombies): ~6 ms of blocked event loop per poll with 110 sessions.
   */
  private cachedSessionInfo(sessionId: string): SessionInfo | null {
    const sessionJsonPath = path.join(this.controlPath, sessionId, 'session.json');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sessionJsonPath);
    } catch {
      this.sessionInfoCache.delete(sessionId);
      return null;
    }
    const key = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    const cached = this.sessionInfoCache.get(sessionId);
    if (cached?.key === key) return cached.info;
    // An unreadable file is cached too: it is not re-read (and re-logged) until it changes.
    const info = this.loadSessionInfo(sessionId);
    this.sessionInfoCache.set(sessionId, { key, info });
    return info;
  }

  private scanSessions(): { sessions: Session[]; zombies: string[] } {
    try {
      const sessions: Session[] = [];
      const zombies: string[] = [];
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(this.controlPath, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.sessionInfoCache.clear();
          return { sessions, zombies };
        }
        throw error;
      }

      const seen = new Set<string>();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionId = entry.name;
        seen.add(sessionId);
        let sessionInfo = this.cachedSessionInfo(sessionId);
        if (!sessionInfo) continue;

        // Determine active state for running processes
        if (sessionInfo.status === 'running' && sessionInfo.pid) {
          // Update status if process is no longer alive (or its pid now names another one)
          if (!this.pidStillTheSession(sessionId, sessionInfo)) {
            logger.debug(
              colors.yellow(`process ${sessionInfo.pid} no longer running for session ${sessionId}`)
            );
            sessionInfo = {
              ...sessionInfo,
              status: 'exited',
              exitCode: sessionInfo.exitCode ?? 1, // Default exit code for dead processes
            };
            this.saveSessionInfo(sessionId, sessionInfo);
            zombies.push(sessionId);
          }
        }

        let lastModified = sessionInfo.startedAt;
        try {
          lastModified = fs
            .statSync(path.join(this.controlPath, sessionId, 'stdout'))
            .mtime.toISOString();
        } catch {
          // No output yet
        }
        sessions.push({ ...sessionInfo, id: sessionId, lastModified });
      }
      for (const sessionId of this.sessionInfoCache.keys()) {
        if (!seen.has(sessionId)) this.sessionInfoCache.delete(sessionId);
      }

      // Sort by startedAt timestamp (newest first)
      sessions.sort((a, b) => {
        const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return bTime - aTime;
      });

      // No log line here: the list is scanned on every client poll (each phone and tab, every
      // 1-3 s) and debug lines always reach the log file. A line per session filled the 50 MB
      // log in minutes; even one per call was ~30 MB/day per client (2026-10-02).
      return { sessions, zombies };
    } catch (error) {
      throw new PtyError(
        `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`,
        'LIST_SESSIONS_FAILED'
      );
    }
  }

  /** Last time a session's pid was found to still be its process (pid + start time). */
  private verifiedPids = new Map<string, { pid: number; at: number }>();

  /**
   * Whether a running session's pid is still its process. With a recorded start time the pid
   * is checked against it once a minute (one `ps`), else only for existence (kill 0).
   */
  private pidStillTheSession(sessionId: string, info: SessionInfo): boolean {
    const pid = info.pid;
    if (!pid || !ProcessUtils.isProcessRunning(pid)) return false;
    // Shielded: the pid is whichever tmux client attached last, tmux says whether it lives.
    // 2026-10-20: a re-attach kept the first client's start time, so the next listing called
    // the live session exited (Resume Claude then started a second writer).
    if (!info.pidStartTime || info.shielded) return true;
    const verified = this.verifiedPids.get(sessionId);
    const now = Date.now();
    if (verified?.pid === pid && now - verified.at < PID_VERIFY_INTERVAL_MS) return true;
    if (!ProcessUtils.isSameProcess(pid, info.pidStartTime)) {
      this.verifiedPids.delete(sessionId);
      logger.warn(`pid ${pid} of session ${sessionId} now belongs to another process`);
      return false;
    }
    this.verifiedPids.set(sessionId, { pid, at: now });
    return true;
  }

  /**
   * Run once when the server starts, before anything reads the sessions: what the previous
   * server left behind.
   *  - 'starting' sessions with nothing alive behind them: that server crashed while creating
   *    them (2026-10-20: they stayed 'starting' for ever).
   *  - 'running' sessions that were a PTY of that server (pidStartTime recorded, neither
   *    shielded nor run by a forwarder): their terminal ended with it, whatever their pid
   *    names now (2026-10-20: pid reuse after a reboot).
   * Returns the ids marked exited.
   */
  sweepSessionsOfPreviousServer(isForwarded: (info: SessionInfo) => boolean) {
    const swept: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.controlPath, { withFileTypes: true });
    } catch {
      return swept;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const info = this.loadSessionInfo(entry.name);
      if (!info || info.status === 'exited' || info.shielded) continue;
      const forwarded = isForwarded({ ...info, id: entry.name });
      let stale = false;
      if (info.status === 'starting') {
        const alive = [info.pid, info.forwarderPid].some(
          (pid) => typeof pid === 'number' && ProcessUtils.isProcessRunning(pid)
        );
        stale = !alive;
      } else if (info.status === 'running' && info.pidStartTime && !forwarded) {
        stale = true;
      }
      if (!stale) continue;
      try {
        this.saveSessionInfo(entry.name, {
          ...info,
          status: 'exited',
          exitCode: info.exitCode ?? 1,
        });
        swept.push(entry.name);
      } catch (error) {
        logger.warn(`could not mark session ${entry.name} exited: ${error}`);
      }
    }
    if (swept.length) {
      logger.log(colors.yellow(`marked ${swept.length} sessions of the previous server exited`));
    }
    return swept;
  }

  /**
   * Check if a session exists
   */
  sessionExists(sessionId: string): boolean {
    const sessionDir = path.join(this.controlPath, sessionId);
    const sessionJsonPath = path.join(sessionDir, 'session.json');
    return fs.existsSync(sessionJsonPath);
  }

  /**
   * cleanupSession for a batch: a directory whose name is no valid session id (say "a.b") is
   * skipped with a warning instead of aborting the whole run (2026-10-04). False if skipped.
   */
  private cleanupListedSession(sessionId: string): boolean {
    try {
      this.cleanupSession(sessionId);
      return true;
    } catch (error) {
      if (error instanceof PtyError && error.code === 'INVALID_SESSION_ID') {
        logger.warn(`skipping "${sessionId}" in ${this.controlPath}: not a valid session id`);
        return false;
      }
      throw error;
    }
  }

  /**
   * Cleanup a specific session
   */
  cleanupSession(sessionId: string): void {
    if (!sessionId) {
      throw new PtyError('Session ID is required for cleanup', 'INVALID_SESSION_ID');
    }

    // The id comes straight from the URL (DELETE /api/sessions/:id/cleanup): "%2E%2E" decodes
    // to "..", which joined to the control dir removed its parent (~/.untether), and
    // "uploads" removed the pasted-images folder (2026-10-02).
    this.validateSessionId(sessionId);

    try {
      const sessionDir = path.join(this.controlPath, sessionId);

      if (
        fs.existsSync(sessionDir) &&
        !fs.existsSync(path.join(sessionDir, 'session.json')) &&
        !fs.existsSync(path.join(sessionDir, 'stdout'))
      ) {
        logger.warn(`Not removing ${sessionDir}: it is not a session directory`);
      } else if (fs.existsSync(sessionDir)) {
        logger.debug(`Cleaning up session directory: ${sessionDir}`);

        // Log session info before cleanup for debugging
        const sessionInfo = this.loadSessionInfo(sessionId);
        if (sessionInfo) {
          logger.debug(`Cleaning up session ${sessionId} with status: ${sessionInfo.status}`);
        }

        // Remove directory and all contents
        fs.rmSync(sessionDir, { recursive: true, force: true });
        logger.debug(colors.green(`session ${sessionId} cleaned up`));
      } else {
        logger.debug(`Session directory ${sessionDir} does not exist, nothing to clean up`);
      }
    } catch (error) {
      throw new PtyError(
        `Failed to cleanup session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        'CLEANUP_FAILED',
        sessionId
      );
    }
  }

  /**
   * Cleanup all exited sessions
   */
  cleanupExitedSessions(): string[] {
    const cleanedSessions: string[] = [];

    try {
      const sessions = this.listSessions();

      for (const session of sessions) {
        if (session.status === 'exited' && session.id) {
          if (this.cleanupListedSession(session.id)) cleanedSessions.push(session.id);
        }
      }

      if (cleanedSessions.length > 0) {
        logger.debug(colors.green(`cleaned up ${cleanedSessions.length} exited sessions`));
      }
      return cleanedSessions;
    } catch (error) {
      throw new PtyError(
        `Failed to cleanup exited sessions: ${error instanceof Error ? error.message : String(error)}`,
        'CLEANUP_EXITED_FAILED'
      );
    }
  }

  /**
   * Get session paths for a given session ID
   */
  getSessionPaths(
    sessionId: string,
    checkExists: boolean = false
  ): {
    controlDir: string;
    stdoutPath: string;
    sessionJsonPath: string;
  } | null {
    const sessionDir = path.join(this.controlPath, sessionId);

    if (checkExists && !fs.existsSync(sessionDir)) {
      logger.debug(`[SessionManager] Session directory does not exist: ${sessionDir}`);
      return null;
    }

    return {
      controlDir: sessionDir,
      stdoutPath: path.join(sessionDir, 'stdout'),
      sessionJsonPath: path.join(sessionDir, 'session.json'),
    };
  }

  /**
   * Update sessions that have zombie processes
   */
  updateZombieSessions(): string[] {
    try {
      // The scan marks running sessions whose process is gone as exited.
      return this.scanSessions().zombies;
    } catch (error) {
      logger.warn('failed to update zombie sessions:', error);
      return [];
    }
  }

  /**
   * Get control path
   */
  getControlPath(): string {
    return this.controlPath;
  }
}

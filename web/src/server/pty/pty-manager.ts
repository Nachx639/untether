/**
 * PtyManager - Core PTY management using node-pty
 *
 * This class handles PTY creation, process management, and I/O operations
 * using the node-pty library while maintaining compatibility with tty-fwd.
 *
 * The class is built in layers, one module each under pty-manager/ (each extends the one before):
 * state (fields, construction) → foreground (command tracking) → sizing → io
 * (IPC socket, input) → spawn (createSession, PTY handlers) → lifecycle (metadata, kill,
 * cleanup) → shield (shielded tmux sessions). Shared constants and helpers: pty-manager/helpers.ts.
 */

import { PtyManagerShield } from './pty-manager/shield.js';

export {
  type ExitedKeepReason,
  exitedCleanupKeepReason,
  foregroundPollDue,
  keptByExitedCleanup,
  SHIELD_INPUT_QUEUE_MAX,
  SHIELD_INPUT_QUEUE_MS,
  SHIELD_REATTACH_RETRY_MS,
  SIZE_SWEEP_INTERVAL_MS,
  spawnFailureHint,
  spawnRetrying,
} from './pty-manager/helpers.js';

/**
 * PtyManager handles the lifecycle and I/O operations of pseudo-terminal (PTY) sessions.
 *
 * This class provides comprehensive terminal session management including:
 * - Creating and managing PTY processes using node-pty
 * - Handling terminal input/output with proper buffering and queuing
 * - Managing terminal resizing (size owners: a page or the session's Mac window)
 * - Recording sessions in asciinema format for playback
 * - Communicating with external sessions via Unix domain sockets
 * - Session persistence and recovery across server restarts
 *
 * The PtyManager supports both in-memory sessions (where the PTY is managed directly)
 * and external sessions (where communication happens via IPC sockets).
 *
 * @extends EventEmitter
 *
 * @fires PtyManager#sessionExited - When a session terminates
 * @fires PtyManager#sessionNameChanged - When a session name is updated
 * @fires PtyManager#bell - When a bell character is detected in terminal output
 *
 * @example
 * ```typescript
 * // Create a PTY manager instance
 * const ptyManager = new PtyManager('/path/to/control/dir');
 *
 * // Create a new session
 * const { sessionId, sessionInfo } = await ptyManager.createSession(
 *   ['bash', '-l'],
 *   {
 *     name: 'My Terminal',
 *     workingDir: '/home/user',
 *     cols: 80,
 *     rows: 24,
 *     titleMode: TitleMode.STATIC
 *   }
 * );
 *
 * // Send input to the session
 * ptyManager.sendInput(sessionId, { text: 'ls -la\n' });
 *
 * // Resize the terminal
 * ptyManager.resizeSession(sessionId, 100, 30);
 *
 * // Kill the session gracefully
 * await ptyManager.killSession(sessionId);
 * ```
 */
export class PtyManager extends PtyManagerShield {}

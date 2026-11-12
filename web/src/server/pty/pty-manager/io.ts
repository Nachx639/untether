/** Session I/O: the IPC socket, input and control messages. Part of PtyManager (pty-manager.ts). */

import * as fs from 'fs';

import * as net from 'net';

import * as path from 'path';

import type { SessionInput, SpecialKey } from '../../../shared/types.js';
import {
  isFocusReport,
  isMouseInput,
  shieldScrollsTmuxHistory,
} from '../../services/shielded-tmux.js';
import {
  type ControlCommand,
  frameMessage,
  MessageParser,
  MessageType,
  parsePayload,
} from '../socket-protocol.js';
import {
  type KillControlMessage,
  PtyError,
  type PtySession,
  type ResetSizeControlMessage,
  type ResizeControlMessage,
} from '../types.js';
import { logger, SHIELD_INPUT_QUEUE_MAX, SHIELD_INPUT_QUEUE_MS } from './helpers.js';
import { PtyManagerSizing } from './sizing.js';

export abstract class PtyManagerIO extends PtyManagerSizing {
  /**
   * Setup Unix socket for all IPC communication
   */
  protected setupIPCSocket(session: PtySession): void {
    const ptyProcess = session.ptyProcess;
    if (!ptyProcess) {
      logger.error(`No PTY process found for session ${session.id}`);
      return;
    }

    // Create Unix domain socket for all IPC
    // IMPORTANT: macOS has a 104 character limit for Unix socket paths, including null terminator.
    // This means the actual usable path length is 103 characters. To avoid EINVAL errors:
    // - Use short socket names (e.g., 'ipc.sock' instead of 'untether-ipc.sock')
    // - Keep session directories as short as possible
    // - Avoid deeply nested directory structures
    const socketPath = path.join(session.controlDir, 'ipc.sock');

    // Verify the socket path isn't too long
    if (socketPath.length > 103) {
      const error = new Error(`Socket path too long: ${socketPath.length} characters`);
      logger.error(`Socket path too long (${socketPath.length} chars): ${socketPath}`);
      logger.error(
        `macOS limit is 103 characters. Consider using shorter session IDs or control paths.`
      );
      throw error; // Fail fast instead of returning silently
    }

    try {
      // Remove existing socket if it exists
      try {
        fs.unlinkSync(socketPath);
      } catch (_e) {
        // Socket doesn't exist, this is expected
      }

      // Initialize connected clients set if not already present
      if (!session.connectedClients) {
        session.connectedClients = new Set<net.Socket>();
      }

      // Create Unix domain socket server with framed message protocol
      const inputServer = net.createServer((client) => {
        const parser = new MessageParser();
        client.setNoDelay(true);

        // Add client to connected clients set
        session.connectedClients?.add(client);
        logger.debug(
          `Client connected to session ${session.id}, total clients: ${session.connectedClients?.size}`
        );

        client.on('data', (chunk) => {
          try {
            parser.addData(chunk);

            for (const { type, payload } of parser.parseMessages()) {
              this.handleSocketMessage(session, type, payload);
            }
          } catch (error) {
            logger.warn(`Rejecting invalid socket frame for session ${session.id}:`, error);
            client.destroy();
          }
        });

        client.on('error', (err) => {
          logger.debug(`Client socket error for session ${session.id}:`, err);
        });

        client.on('close', () => {
          // Remove client from connected clients set
          session.connectedClients?.delete(client);
          logger.debug(
            `Client disconnected from session ${session.id}, remaining clients: ${session.connectedClients?.size}`
          );
        });
      });

      inputServer.listen(socketPath, () => {
        // Only this user may type into the session (2026-10-20: it was 0666, writable by
        // every local account). The server, ut-fwd and the Mac app all run as the user.
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch (e) {
          logger.debug(`Failed to chmod input socket for session ${session.id}:`, e);
        }
        logger.debug(`Input socket created for session ${session.id}`);
      });

      // Store server reference for cleanup
      session.inputSocketServer = inputServer;
    } catch (error) {
      logger.error(`Failed to create input socket for session ${session.id}:`, error);
    }

    // All IPC goes through this socket
  }

  /**
   * Handle incoming socket messages
   */
  protected handleSocketMessage(session: PtySession, type: MessageType, payload: Buffer): void {
    try {
      const data = parsePayload(type, payload);

      switch (type) {
        case MessageType.STDIN_DATA: {
          const text = data as string;
          if (session.ptyProcess && session.inputQueue) {
            const inputTimestamp = Date.now();
            session.lastInputTimestamp = inputTimestamp;
            this.lastInputTimestamps.set(session.id, inputTimestamp);

            // Queue input write to prevent race conditions
            session.inputQueue.enqueue(() => {
              if (session.ptyProcess) {
                session.ptyProcess.write(text);
              }
              // Record it (non-blocking)
              session.asciinemaWriter?.writeInput(text);
            });
          }
          break;
        }

        case MessageType.CONTROL_CMD: {
          const cmd = data as ControlCommand;
          this.handleControlMessage(session, cmd);
          break;
        }

        case MessageType.STATUS_UPDATE: {
          logger.debug(`Ignoring status update for session ${session.id}`);
          break;
        }

        case MessageType.HEARTBEAT:
          // Heartbeat received - no action needed for now
          break;

        default:
          logger.debug(`Unknown message type ${type} for session ${session.id}`);
      }
    } catch (error) {
      // Don't log the full error object as it might contain buffers or circular references
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to handle socket message for session ${session.id}: ${errorMessage}`);
    }
  }

  /**
   * Handle control messages from control pipe
   */
  protected handleControlMessage(session: PtySession, message: Record<string, unknown>): void {
    if (
      message.cmd === 'resize' &&
      typeof message.cols === 'number' &&
      typeof message.rows === 'number'
    ) {
      try {
        if (session.ptyProcess) {
          session.ptyProcess.resize(message.cols, message.rows);
          session.asciinemaWriter?.writeResize(message.cols, message.rows);
        }
      } catch (error) {
        logger.warn(
          `Failed to resize session ${session.id} to ${message.cols}x${message.rows}:`,
          error
        );
      }
    } else if (message.cmd === 'kill') {
      const signal =
        typeof message.signal === 'string' || typeof message.signal === 'number'
          ? message.signal
          : 'SIGTERM';
      try {
        if (session.ptyProcess) {
          session.ptyProcess.kill(signal as string);
        }
      } catch (error) {
        logger.warn(`Failed to kill session ${session.id} with signal ${signal}:`, error);
      }
    } else if (message.cmd === 'update-title' && typeof message.title === 'string') {
      // Handle title update via IPC (used by ut title command)
      logger.debug(`[IPC] Received title update for session ${session.id}: "${message.title}"`);
      logger.debug(`[IPC] Current session name before update: "${session.sessionInfo.name}"`);
      this.updateSessionName(session.id, message.title);
    }
  }

  /**
   * Send text input to a session
   */
  sendInput(sessionId: string, input: SessionInput): void {
    // Typed while it is being suspended: held, never typed into a Claude about to end; the
    // suspender wakes the session again and types it (2026-10-31 review).
    const held = this.inputDuringSuspend.get(sessionId);
    if (held) {
      held.push(input);
      return;
    }
    try {
      let dataToSend = '';
      if (input.text !== undefined) {
        dataToSend = input.text;
        logger.debug(
          `Received text input: ${JSON.stringify(input.text)} -> sending: ${JSON.stringify(dataToSend)}`
        );
      } else if (input.key !== undefined) {
        dataToSend = this.convertSpecialKey(input.key);
        logger.debug(
          `Received special key: "${input.key}" -> converted to: ${JSON.stringify(dataToSend)}`
        );
      } else {
        throw new PtyError('No text or key specified in input', 'INVALID_INPUT');
      }

      // If we have an in-memory session with active PTY, use it
      const memorySession = this.sessions.get(sessionId);
      if (memorySession?.ptyProcess && memorySession.inputQueue) {
        const inputTimestamp = Date.now();
        memorySession.lastInputTimestamp = inputTimestamp;
        this.lastInputTimestamps.set(sessionId, inputTimestamp);

        // Queue input write to prevent race conditions
        const mouse = isMouseInput(dataToSend);
        if (mouse && shieldScrollsTmuxHistory(memorySession.sessionInfo.command)) {
          this.shieldCopyMode.add(sessionId);
        }
        const leaveCopyMode =
          !mouse && !isFocusReport(dataToSend) && this.shieldCopyMode.delete(sessionId);
        memorySession.inputQueue.enqueue(async () => {
          // Typed after scrolling back: copy mode would swallow it (shieldScrollsTmuxHistory).
          if (leaveCopyMode) await this.shieldTmux.leaveCopyMode(sessionId).catch(() => {});
          if (memorySession.ptyProcess) {
            memorySession.ptyProcess.write(dataToSend);
          }
          memorySession.asciinemaWriter?.writeInput(dataToSend);
        });

        return; // Important: return here to avoid socket path
      } else {
        const sessionPaths = this.sessionManager.getSessionPaths(sessionId);
        if (!sessionPaths) {
          throw new PtyError(
            `Session ${sessionId} paths not found`,
            'SESSION_PATHS_NOT_FOUND',
            sessionId
          );
        }

        // A shielded session between two tmux clients (re-attach in progress): its program
        // runs, so the input waits for the next client instead of being lost.
        const info = this.loadSessionInfoSafe(sessionId);
        if (info?.shielded && info.status !== 'exited') {
          // 2026-10-20: input was queued (and answered 200) even when no re-attach was coming
          // (the 5-minute retry after tmux could not be reached): it was always lost. Only a
          // re-attach really on its way gets a queue; otherwise the caller hears it failed.
          if (!this.isShieldReattachPending(sessionId)) {
            throw new PtyError(
              `Shielded session ${sessionId} has no tmux client right now`,
              'NO_SOCKET_CONNECTION',
              sessionId
            );
          }
          this.queueShieldInput(sessionId, dataToSend);
          return;
        }

        // For forwarded sessions, we need to use socket communication
        const socketPath = path.join(sessionPaths.controlDir, 'ipc.sock');

        // Check if we have a cached socket connection
        let socketClient = this.inputSocketClients.get(sessionId);

        // 2026-10-20: connecting is async, so a missing socket (forwarder gone, session
        // ended) only failed after this returned: the input (a push answer) was lost while
        // the caller got 200. No socket file, or a session recorded as ended, is an error now.
        if (!socketClient || socketClient.destroyed) {
          if (!fs.existsSync(socketPath) || info?.status === 'exited') {
            throw new PtyError(
              `No socket connection available for session ${sessionId}`,
              'NO_SOCKET_CONNECTION',
              sessionId
            );
          }
        }

        if (!socketClient || socketClient.destroyed) {
          // Try to connect to the socket
          try {
            socketClient = this.openInputSocket(sessionId, socketPath);
          } catch (error) {
            logger.debug(`Failed to connect to input socket for session ${sessionId}:`, error);
            socketClient = undefined;
          }
        }

        if (socketClient && !socketClient.destroyed) {
          this.lastInputTimestamps.set(sessionId, Date.now());
          // Send stdin data using framed message protocol
          const message = frameMessage(MessageType.STDIN_DATA, dataToSend);
          const canWrite = socketClient.write(message);
          if (!canWrite) {
            // Socket buffer is full
            logger.debug(`Socket buffer full for session ${sessionId}, data queued`);
          }
        } else {
          throw new PtyError(
            `No socket connection available for session ${sessionId}`,
            'NO_SOCKET_CONNECTION',
            sessionId
          );
        }
      }
    } catch (error) {
      throw new PtyError(
        `Failed to send input to session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        'SEND_INPUT_FAILED',
        sessionId
      );
    }
  }

  /** A re-attach of `sessionId` is on its way (for at most `forMs`). */
  markShieldReattachPending(sessionId: string, forMs = SHIELD_INPUT_QUEUE_MS): void {
    this.shieldReattachPendingUntil.set(sessionId, Date.now() + forMs);
  }

  clearShieldReattachPending(sessionId: string): void {
    this.shieldReattachPendingUntil.delete(sessionId);
  }

  isShieldReattachPending(sessionId: string): boolean {
    const until = this.shieldReattachPendingUntil.get(sessionId);
    if (until === undefined) return false;
    if (Date.now() <= until) return true;
    this.shieldReattachPendingUntil.delete(sessionId);
    return false;
  }

  protected queueShieldInput(sessionId: string, data: string): void {
    const now = Date.now();
    const pending = (this.pendingShieldInput.get(sessionId) ?? []).filter(
      (chunk) => now - chunk.at <= SHIELD_INPUT_QUEUE_MS
    );
    this.pendingShieldInput.set(sessionId, pending);
    const queued = pending.reduce((total, chunk) => total + chunk.data.length, 0);
    if (queued + data.length > SHIELD_INPUT_QUEUE_MAX) {
      throw new PtyError(
        `Session ${sessionId} is re-attaching and its input queue is full`,
        'NO_SOCKET_CONNECTION',
        sessionId
      );
    }
    pending.push({ at: now, data });
    this.lastInputTimestamps.set(sessionId, now);
    logger.debug(`session ${sessionId} is re-attaching: input queued (${data.length} bytes)`);
  }

  /** Type what was queued while the session had no tmux client, the chunks still fresh. */
  protected flushShieldInput(session: PtySession): void {
    const pending = this.pendingShieldInput.get(session.id);
    this.pendingShieldInput.delete(session.id);
    this.clearShieldReattachPending(session.id);
    const now = Date.now();
    for (const { at, data } of pending ?? []) {
      if (now - at > SHIELD_INPUT_QUEUE_MS) continue;
      session.inputQueue?.enqueue(() => {
        session.ptyProcess?.write(data);
        session.asciinemaWriter?.writeInput(data);
      });
    }
  }

  /** Forget a shielded session's queued input: no client is coming to type it. */
  protected dropShieldInput(sessionId: string, reason: string): void {
    this.clearShieldReattachPending(sessionId);
    const pending = this.pendingShieldInput.get(sessionId);
    this.pendingShieldInput.delete(sessionId);
    if (pending?.length) {
      logger.warn(
        `session ${sessionId}: ${pending.length} queued input chunk(s) dropped (${reason})`
      );
    }
  }

  /**
   * Before input goes to a session served by another process (a ut window's forwarder): makes
   * sure its ipc.sock answers. 2026-10-20: a forwarder killed with -9 leaves ipc.sock behind;
   * connecting fails only asynchronously, so sendInput returned and the caller got 200 for
   * input that went nowhere. Awaiting the connection (shortly) turns that into an error.
   */
  async connectInput(sessionId: string, timeoutMs = 1500): Promise<void> {
    if (this.sessions.get(sessionId)?.ptyProcess) return;
    const cached = this.inputSocketClients.get(sessionId);
    if (cached && !cached.destroyed && !cached.connecting) return;
    const info = this.loadSessionInfoSafe(sessionId);
    if (info?.shielded) return; // sendInput queues or refuses it (see there).
    const sessionPaths = this.sessionManager.getSessionPaths(sessionId);
    if (!sessionPaths) return; // sendInput reports it.
    const socketPath = path.join(sessionPaths.controlDir, 'ipc.sock');
    if (!fs.existsSync(socketPath)) return; // sendInput reports it.
    const socket =
      cached && !cached.destroyed ? cached : this.openInputSocket(sessionId, socketPath);
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        cleanup();
        socket.destroy();
        if (this.inputSocketClients.get(sessionId) === socket) {
          this.inputSocketClients.delete(sessionId);
        }
        reject(
          new PtyError(
            `No socket connection available for session ${sessionId}: ${error.message}`,
            'NO_SOCKET_CONNECTION',
            sessionId
          )
        );
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => fail(error);
      const timer = setTimeout(() => fail(new Error('connect timed out')), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };
      if (!socket.connecting) {
        cleanup();
        if (socket.destroyed) fail(new Error('socket closed'));
        else resolve();
        return;
      }
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  protected openInputSocket(sessionId: string, socketPath: string): net.Socket {
    const socketClient = net.createConnection(socketPath);
    socketClient.setNoDelay(true);
    // Keep socket alive for better performance
    socketClient.setKeepAlive(true, 0);
    this.inputSocketClients.set(sessionId, socketClient);
    socketClient.on('error', () => {
      if (this.inputSocketClients.get(sessionId) === socketClient) {
        this.inputSocketClients.delete(sessionId);
      }
    });
    socketClient.on('close', () => {
      if (this.inputSocketClients.get(sessionId) === socketClient) {
        this.inputSocketClients.delete(sessionId);
      }
    });
    return socketClient;
  }

  /**
   * Send a control message to an external session via socket
   */
  protected sendControlMessage(
    sessionId: string,
    message: ResizeControlMessage | KillControlMessage | ResetSizeControlMessage
  ): boolean {
    const sessionPaths = this.sessionManager.getSessionPaths(sessionId);
    if (!sessionPaths) {
      return false;
    }

    try {
      const socketPath = path.join(sessionPaths.controlDir, 'ipc.sock');
      let socketClient = this.inputSocketClients.get(sessionId);

      if (!socketClient || socketClient.destroyed) {
        // No socket file: nobody to take it (the async connect error came too late, and the
        // message counted as sent; 2026-10-20).
        if (!fs.existsSync(socketPath)) return false;
        // Try to connect to the socket
        try {
          socketClient = net.createConnection(socketPath);
          socketClient.setNoDelay(true);
          socketClient.setKeepAlive(true, 0);
          this.inputSocketClients.set(sessionId, socketClient);

          socketClient.on('error', () => {
            this.inputSocketClients.delete(sessionId);
          });

          socketClient.on('close', () => {
            this.inputSocketClients.delete(sessionId);
          });
        } catch (error) {
          logger.debug(`Failed to connect to control socket for session ${sessionId}:`, error);
          return false;
        }
      }

      if (socketClient && !socketClient.destroyed) {
        const frameMsg = frameMessage(MessageType.CONTROL_CMD, message);
        return socketClient.write(frameMsg);
      }
    } catch (error) {
      logger.error(`Failed to send control message to session ${sessionId}:`, error);
    }
    return false;
  }

  /**
   * Convert special key names to escape sequences
   */
  protected convertSpecialKey(key: SpecialKey): string {
    const keyMap: Record<SpecialKey, string> = {
      arrow_up: '\x1b[A',
      arrow_down: '\x1b[B',
      arrow_right: '\x1b[C',
      arrow_left: '\x1b[D',
      escape: '\x1b',
      enter: '\r',
      ctrl_enter: '\n',
      shift_enter: '\r\n',
      backspace: '\x7f',
      tab: '\t',
      shift_tab: '\x1b[Z',
      page_up: '\x1b[5~',
      page_down: '\x1b[6~',
      home: '\x1b[H',
      end: '\x1b[F',
      delete: '\x1b[3~',
      f1: '\x1bOP',
      f2: '\x1bOQ',
      f3: '\x1bOR',
      f4: '\x1bOS',
      f5: '\x1b[15~',
      f6: '\x1b[17~',
      f7: '\x1b[18~',
      f8: '\x1b[19~',
      f9: '\x1b[20~',
      f10: '\x1b[21~',
      f11: '\x1b[23~',
      f12: '\x1b[24~',
    };

    const sequence = keyMap[key];
    if (!sequence) {
      throw new PtyError(`Unknown special key: ${key}`, 'UNKNOWN_KEY');
    }

    return sequence;
  }
}

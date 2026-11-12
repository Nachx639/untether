import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import { createLogger } from '../utils/logger.js';
import type { ControlCategory, ControlMessage } from './control-protocol.js';
import { createControlEvent, createControlResponse } from './control-protocol.js';

const logger = createLogger('control-unix');

interface MessageHandler {
  handleMessage(message: ControlMessage): Promise<ControlMessage | null>;
}

// 2026-10-20: a TerminalHandler answered `terminal.spawn` requests from the Mac app by running
// `untether launch --command <string>`, a CLI command that no longer exists; the Mac app never
// sends them (spawns go server → app, with argv). Removed with the `command` string.

class SystemHandler implements MessageHandler {
  async handleMessage(message: ControlMessage): Promise<ControlMessage | null> {
    logger.debug(`System handler: ${message.action}, type: ${message.type}, id: ${message.id}`);

    switch (message.action) {
      case 'ping':
        // Already handled in handleMacMessage
        return null;

      case 'ready':
        // Event, no response needed
        return null;

      default:
        logger.warn(`Unknown system action: ${message.action}`);
        return createControlResponse(message, null, `Unknown action: ${message.action}`);
    }
  }
}

/**
 * Handles Unix domain socket communication between the Untether web server and macOS app.
 *
 * This class manages a Unix socket server that provides bidirectional communication
 * between the web server and the native macOS application. It implements a message-based
 * protocol with length-prefixed framing for reliable message delivery and supports
 * multiple message categories including terminal control and system events.
 *
 * Key features:
 * - Unix domain socket server with automatic cleanup on restart
 * - Length-prefixed binary protocol for message framing
 * - Message routing based on categories (terminal, system)
 * - Request/response pattern with timeout support
 * - WebSocket bridge for browser clients
 * - Automatic socket permission management (0600)
 *
 * @example
 * ```typescript
 * // Create and start the handler
 * const handler = new ControlUnixHandler();
 * await handler.start();
 *
 * // Check if Mac app is connected
 * if (handler.isMacAppConnected()) {
 *   // Send a control message
 *   const response = await handler.sendControlMessage({
 *     id: 'msg-123',
 *     type: 'request',
 *     category: 'terminal',
 *     action: 'spawn',
 *     payload: {
 *       sessionId: 'session-456',
 *       workingDirectory: '/Users/alice',
 *       command: 'vim'
 *     }
 *   });
 * }
 *
 * // Handle browser WebSocket connections
 * ws.on('connection', (socket) => {
 *   handler.handleBrowserConnection(socket, userId);
 * });
 * ```
 */
export class ControlUnixHandler {
  private pendingRequests = new Map<string, (response: ControlMessage) => void>();
  private macSocket: net.Socket | null = null;
  private unixServer: net.Server | null = null;
  private readonly socketPath: string;
  private handlers = new Map<ControlCategory, MessageHandler>();

  constructor() {
    // Use control directory from environment or default
    const home = process.env.HOME || '/tmp';
    const controlDir = process.env.UNTETHER_CONTROL_DIR || path.join(home, '.untether');
    const socketDir = controlDir;

    // Ensure directory exists
    try {
      // Private (2026-10-20): created after the one-time perms pass, it must not be 0755.
      fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    } catch (_e) {
      // Ignore if already exists
    }

    this.socketPath = path.join(socketDir, 'control.sock');

    // Initialize handlers
    this.handlers.set('system', new SystemHandler());
  }

  async start(): Promise<void> {
    logger.log('🚀 Starting control Unix socket handler');
    logger.log(`📂 Socket path: ${this.socketPath}`);

    // Clean up any existing socket file to prevent EADDRINUSE errors on restart.
    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
        logger.log('🧹 Removed existing stale socket file.');
      } else {
        logger.log('✅ No existing socket file found');
      }
    } catch (error) {
      logger.warn('⚠️ Failed to remove stale socket file:', error);
    }

    // Create UNIX socket server
    const unixServer = net.createServer((socket) => {
      this.handleMacConnection(socket);
    });
    this.unixServer = unixServer;

    // Start listening
    await new Promise<void>((resolve, reject) => {
      unixServer.listen(this.socketPath, () => {
        logger.log(`Control UNIX socket server listening at ${this.socketPath}`);

        // Set restrictive permissions - only owner can read/write
        fs.chmod(this.socketPath, 0o600, (err) => {
          if (err) {
            logger.error('Failed to set socket permissions:', err);
            unixServer.close(() => {
              if (this.unixServer === unixServer) {
                this.unixServer = null;
              }
              try {
                fs.unlinkSync(this.socketPath);
              } catch (_error) {
                // Ignore cleanup errors after failed startup.
              }
              reject(err);
            });
            return;
          }

          logger.log('Socket permissions set to 0600 (owner read/write only)');
          resolve();
        });
      });

      unixServer.on('error', (error) => {
        logger.error('UNIX socket server error:', error);
        reject(error);
      });
    });
  }

  stop(): void {
    if (this.macSocket) {
      this.macSocket.destroy();
      this.macSocket = null;
    }

    if (this.unixServer) {
      this.unixServer.close();
      this.unixServer = null;
    }

    // Clean up socket file
    try {
      fs.unlinkSync(this.socketPath);
    } catch (_error) {
      // Ignore
    }
  }

  isMacAppConnected(): boolean {
    return this.macSocket !== null && !this.macSocket.destroyed;
  }

  private handleMacConnection(socket: net.Socket) {
    logger.log('🔌 New Mac connection via UNIX socket');
    logger.debug(`🔍 Socket info: local=${socket.localAddress}, remote=${socket.remoteAddress}`);

    // Close any existing Mac connection
    if (this.macSocket) {
      logger.log('⚠️ Closing existing Mac connection');
      this.macSocket.destroy();
    }

    this.macSocket = socket;
    let messageBuffer = Buffer.alloc(0);
    logger.debug('✅ Mac socket stored');

    // Set socket options for better handling of large messages
    socket.setNoDelay(true); // Disable Nagle's algorithm for lower latency
    logger.debug('✅ Socket options set: NoDelay=true');

    // Increase the buffer size for receiving large messages
    const bufferSize = 1024 * 1024; // 1MB
    try {
      const socketWithState = socket as net.Socket & {
        _readableState?: { highWaterMark: number };
      };
      if (socketWithState._readableState) {
        socketWithState._readableState.highWaterMark = bufferSize;
        logger.debug(`Set socket receive buffer to ${bufferSize} bytes`);
      }
    } catch (error) {
      logger.warn('Failed to set socket buffer size:', error);
    }

    socket.on('data', (data) => {
      if (socket !== this.macSocket) {
        return;
      }

      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);

      // Append new data to our buffer
      messageBuffer = Buffer.concat([messageBuffer, chunk]);

      logger.debug(
        `📥 Received from Mac: ${chunk.length} bytes, buffer size: ${messageBuffer.length}`
      );

      // Log first few bytes for debugging
      if (chunk.length > 0) {
        const preview = chunk.subarray(0, Math.min(chunk.length, 50));
        logger.debug(`📋 Data preview (first ${preview.length} bytes):`, preview.toString('hex'));
      }

      // Process as many messages as we can from the buffer
      while (true) {
        // A message needs at least 4 bytes for the length header
        if (messageBuffer.length < 4) {
          break;
        }

        // Read the length of the message
        const messageLength = messageBuffer.readUInt32BE(0);

        // Validate message length
        if (messageLength <= 0) {
          logger.error(`Invalid message length: ${messageLength}`);
          // Clear the buffer to recover from this error
          messageBuffer = Buffer.alloc(0);
          break;
        }

        // Sanity check: messages shouldn't be larger than 10MB
        const maxMessageSize = 10 * 1024 * 1024; // 10MB
        if (messageLength > maxMessageSize) {
          logger.error(`Message too large: ${messageLength} bytes (max: ${maxMessageSize})`);
          // Clear the buffer to recover from this error
          messageBuffer = Buffer.alloc(0);
          break;
        }

        // Check if we have the full message in the buffer
        if (messageBuffer.length < 4 + messageLength) {
          // Not enough data yet, wait for more
          logger.debug(
            `Waiting for more data: have ${messageBuffer.length}, need ${4 + messageLength}`
          );
          break;
        }

        // Extract the message data
        const messageData = messageBuffer.subarray(4, 4 + messageLength);

        // Remove the message (header + body) from the buffer
        messageBuffer = messageBuffer.subarray(4 + messageLength);

        try {
          const messageStr = messageData.toString('utf-8');
          logger.debug(
            `📨 Parsing message (${messageLength} bytes): ${messageStr.substring(0, 100)}...`
          );

          const message: ControlMessage = JSON.parse(messageStr);
          // The app pings every 30 s: at log level that was 15 % of the log (2026-10-03).
          // Anything else it sends is rare and worth seeing.
          const isPing = message.category === 'system' && message.action === 'ping';
          (isPing ? logger.debug : logger.log)(
            `✅ Parsed Mac message: category=${message.category}, action=${message.action}, id=${message.id}`
          );

          this.handleMacMessage(message);
        } catch (error) {
          logger.error('❌ Failed to parse Mac message:', error);
          logger.error('Message length:', messageLength);
          logger.error('Raw message buffer:', messageData.toString('utf-8'));
        }
      }
    });

    socket.on('error', (error) => {
      logger.error('❌ Mac socket error:', error);
      const errorObj = error as NodeJS.ErrnoException;
      logger.error('Error details:', {
        code: errorObj.code,
        syscall: errorObj.syscall,
        errno: errorObj.errno,
        message: errorObj.message,
      });

      // Check if it's a write-related error
      if (errorObj.code === 'EPIPE' || errorObj.code === 'ECONNRESET') {
        logger.error('🔴 Connection broken - Mac app likely closed the connection');
      }
    });

    socket.on('close', (hadError) => {
      logger.log(`🔌 Mac disconnected (hadError: ${hadError})`);
      logger.debug(
        `📊 Socket state: destroyed=${socket.destroyed}, readable=${socket.readable}, writable=${socket.writable}`
      );

      if (socket === this.macSocket) {
        this.macSocket = null;
        logger.debug('🧹 Cleared Mac socket reference');
      }
    });

    // Handle drain event for backpressure
    socket.on('drain', () => {
      logger.log('Mac socket drained - ready for more data');
    });

    // Add event for socket end (clean close)
    socket.on('end', () => {
      logger.debug('📴 Mac socket received FIN packet (clean close)');
    });

    // Send ready event to Mac
    logger.debug('📤 Sending initial system:ready event to Mac');
    this.sendToMac(createControlEvent('system', 'ready'));
    // Untether.app (1.0.0-beta.18) never resets its last-pong time when it reconnects: once a
    // server restart left it over 60 s without a pong, every keep-alive tick found the pong
    // stale and reconnected BEFORE sending a ping, every ~31 s for good (2026-10-03: 86 % of
    // the log, and "No pong received" in the app's own log). A pong right away restarts its
    // clock; from then on its real pings get real pongs. The app checks only type, category
    // and action.
    this.sendToMac(
      createControlResponse(
        { id: `connect-pong-${Date.now()}`, type: 'request', category: 'system', action: 'ping' },
        { status: 'ok' }
      )
    );
  }

  handleBrowserConnection(ws: WebSocket, userId?: string) {
    logger.log('🌐 New browser WebSocket connection for control messages');
    logger.log(`👤 User ID: ${userId || 'unknown'}`);
    logger.log(
      `🔌 Mac socket status on browser connect: ${this.macSocket ? 'CONNECTED' : 'NOT CONNECTED'}`
    );

    ws.on('message', async (data) => {
      try {
        const rawMessage = data.toString();
        logger.log(
          `📨 Browser message received (${rawMessage.length} chars): ${rawMessage.substring(0, 200)}...`
        );
        const message: ControlMessage = JSON.parse(rawMessage);
        logger.log(
          `📥 Parsed browser message - type: ${message.type}, category: ${message.category}, action: ${message.action}`
        );

        // Handle browser -> Mac messages
        logger.warn(`⚠️ Browser sent message for category: ${message.category}`);
      } catch (error) {
        logger.error('❌ Failed to parse browser message:', error);
        ws.send(
          JSON.stringify(
            createControlEvent('system', 'error', {
              error: error instanceof Error ? error.message : String(error),
            })
          )
        );
      }
    });

    ws.on('close', () => {
      logger.log('Browser disconnected');
    });

    ws.on('error', (error) => {
      logger.error('Browser WebSocket error:', error);
    });
  }

  private async handleMacMessage(message: ControlMessage) {
    logger.debug(
      `Mac message - category: ${message.category}, action: ${message.action}, type: ${message.type}, id: ${message.id}`
    );

    // Handle ping keep-alive from Mac client
    if (message.category === 'system' && message.action === 'ping') {
      const pong = createControlResponse(message, { status: 'ok' });
      this.sendToMac(pong);
      return;
    }

    // Check if this is a response to a pending request
    if (message.type === 'response' && this.pendingRequests.has(message.id)) {
      const resolver = this.pendingRequests.get(message.id);
      if (resolver) {
        logger.debug(`Resolving pending request for id: ${message.id}`);
        this.pendingRequests.delete(message.id);
        resolver(message);
      }
      return;
    }

    // Skip processing for response messages that aren't pending requests
    // This prevents response loops where error responses get processed again
    if (message.type === 'response') {
      logger.debug(
        `Ignoring response message that has no pending request: ${message.id}, action: ${message.action}`
      );
      return;
    }

    const handler = this.handlers.get(message.category);
    if (!handler) {
      logger.warn(`No handler for category: ${message.category}`);
      if (message.type === 'request') {
        const response = createControlResponse(
          message,
          null,
          `Unknown category: ${message.category}`
        );
        this.sendToMac(response);
      }
      return;
    }

    try {
      const response = await handler.handleMessage(message);
      if (response) {
        this.sendToMac(response);
      }
    } catch (error) {
      logger.error(`Handler error for ${message.category}:${message.action}:`, error);
      if (message.type === 'request') {
        const response = createControlResponse(
          message,
          null,
          error instanceof Error ? error.message : 'Handler error'
        );
        this.sendToMac(response);
      }
    }
  }

  async sendControlMessage(
    message: ControlMessage,
    timeoutMs = 10_000
  ): Promise<ControlMessage | null> {
    // If Mac is not connected, return null immediately
    if (!this.isMacAppConnected()) {
      return null;
    }

    return new Promise((resolve) => {
      // Store the pending request
      this.pendingRequests.set(message.id, resolve);

      // Send the message
      this.sendToMac(message);

      // Set a timeout
      setTimeout(() => {
        if (this.pendingRequests.has(message.id)) {
          this.pendingRequests.delete(message.id);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  sendToMac(message: ControlMessage): void {
    if (!this.macSocket) {
      logger.warn('⚠️ Cannot send to Mac - no socket connection');
      return;
    }

    if (this.macSocket.destroyed) {
      logger.warn('⚠️ Cannot send to Mac - socket is destroyed');
      this.macSocket = null;
      return;
    }

    try {
      // Convert message to JSON
      const jsonStr = JSON.stringify(message);
      const jsonData = Buffer.from(jsonStr, 'utf-8');

      // Create a buffer with 4-byte length header + JSON data
      const lengthBuffer = Buffer.allocUnsafe(4);
      lengthBuffer.writeUInt32BE(jsonData.length, 0);

      // Combine length header and data
      const fullData = Buffer.concat([lengthBuffer, jsonData]);

      // Log message details
      logger.debug(
        `📤 Sending to Mac: ${message.category}:${message.action}, header: 4 bytes, payload: ${jsonData.length} bytes, total: ${fullData.length} bytes`
      );
      logger.debug(`📋 Message ID being sent: ${message.id}`);
      logger.debug(`📝 Message content: ${jsonStr.substring(0, 200)}...`);

      // Log the actual bytes for the first few messages
      if (message.category === 'system' || message.action === 'get-initial-data') {
        logger.debug(`🔍 Length header bytes: ${lengthBuffer.toString('hex')}`);
        logger.debug(
          `🔍 First 50 bytes of full data: ${fullData.subarray(0, Math.min(50, fullData.length)).toString('hex')}`
        );
      }

      if (jsonData.length > 65536) {
        logger.warn(`⚠️ Large message to Mac: ${jsonData.length} bytes`);
      }

      // Write with error handling
      const result = this.macSocket.write(fullData, (error) => {
        if (error) {
          logger.error('❌ Error writing to Mac socket:', error);
          logger.error('Error details:', {
            // biome-ignore lint/suspicious/noExplicitAny: error object has non-standard properties
            code: (error as any).code,
            // biome-ignore lint/suspicious/noExplicitAny: error object has non-standard properties
            syscall: (error as any).syscall,
            message: error.message,
          });
          // Close the connection on write error
          this.macSocket?.destroy();
          this.macSocket = null;
        } else {
          logger.debug('✅ Write to Mac socket completed successfully');
        }
      });

      // Check if write was buffered (backpressure)
      if (!result) {
        logger.warn('⚠️ Socket write buffered - backpressure detected');
      } else {
        logger.debug('✅ Write immediate - no backpressure');
      }
    } catch (error) {
      logger.error('❌ Exception while sending to Mac:', error);
      this.macSocket?.destroy();
      this.macSocket = null;
    }
  }
}

export const controlUnixHandler = new ControlUnixHandler();

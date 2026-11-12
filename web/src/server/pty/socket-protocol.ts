/**
 * Unix socket protocol for Untether IPC
 *
 * Message format (binary):
 * [1 byte: message type]
 * [4 bytes: payload length (big-endian)]
 * [N bytes: payload]
 */

import { Buffer } from 'buffer';
import type { TaskConfirmation } from '../../shared/task-confirmations.js';
import type { BuildInfo } from '../build-info.js';

export const MAX_MESSAGE_PAYLOAD_SIZE = 10 * 1024 * 1024;

/**
 * Message types for the socket protocol
 */
export enum MessageType {
  STDIN_DATA = 0x01, // Raw stdin data (keyboard input)
  CONTROL_CMD = 0x02, // Control commands (resize, kill, etc)
  STATUS_UPDATE = 0x03, // Legacy status updates (ignored)
  HEARTBEAT = 0x04, // Keep-alive ping/pong
  ERROR = 0x05, // Error messages
  // Reserved for future use
  STDOUT_SUBSCRIBE = 0x10,
  METRICS = 0x11,
  // Status operations
  STATUS_REQUEST = 0x20, // Request server status
  STATUS_RESPONSE = 0x21, // Server status response
  // Git operations
  GIT_FOLLOW_REQUEST = 0x30, // Enable/disable Git follow mode
  GIT_FOLLOW_RESPONSE = 0x31, // Response to follow request
  GIT_EVENT_NOTIFY = 0x32, // Git event notification
  GIT_EVENT_ACK = 0x33, // Git event acknowledgment
  // Dev-server preview (`ut open`)
  PREVIEW_OPEN_REQUEST = 0x40,
  PREVIEW_OPEN_RESPONSE = 0x41,
  // Task engine (`ut task …`, `ut project …`)
  TASK_REQUEST = 0x50,
  TASK_RESPONSE = 0x51,
}

/**
 * Control command types
 */
export interface ControlCommand {
  cmd: string;
  [key: string]: unknown;
}

export interface ResizeCommand extends ControlCommand {
  cmd: 'resize';
  cols: number;
  rows: number;
}

export interface KillCommand extends ControlCommand {
  cmd: 'kill';
  signal?: string | number;
}

export interface ResetSizeCommand extends ControlCommand {
  cmd: 'reset-size';
}

export interface UpdateTitleCommand extends ControlCommand {
  cmd: 'update-title';
  title: string;
}

/**
 * Status update payload
 */
export interface StatusUpdate {
  app: string;
  status: string;
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * Error message payload
 */
export interface ErrorMessage {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Server status request. `cwd`: the folder of whoever asks (`ut status`), whose repository's
 * follow mode the answer tells.
 */
export interface StatusRequest {
  cwd?: string;
}

/**
 * Server status response
 */
export interface StatusResponse {
  running: boolean;
  port?: number;
  url?: string;
  version?: string;
  buildDate?: string;
  /** Which build the server is and the `ut` commands it knows (build-info.ts). */
  build?: BuildInfo;
  /** What the installed app's own update is doing, in one line (installed-app-updater.ts). */
  appUpdate?: string;
  followMode?: {
    enabled: boolean;
    branch?: string;
    repoPath?: string;
  };
}

/**
 * Git follow mode request
 */
export interface GitFollowRequest {
  repoPath?: string; // Main repo path (for backward compatibility)
  branch?: string; // Optional - branch name (for backward compatibility)
  enable: boolean;
  // New fields for worktree-based follow mode
  worktreePath?: string; // The worktree path to follow
  mainRepoPath?: string; // The main repository path
}

/**
 * Git follow mode response
 */
export interface GitFollowResponse {
  success: boolean;
  currentBranch?: string;
  previousBranch?: string;
  error?: string;
}

/**
 * Git event notification
 */
export interface GitEventNotify {
  repoPath: string;
  type: 'checkout' | 'commit' | 'merge' | 'rebase' | 'other';
}

/**
 * Git event acknowledgment
 */
export interface GitEventAck {
  handled: boolean;
}

/** `ut open <port|url>` from inside a session. */
export interface PreviewOpenRequest {
  sessionId: string;
  target: string;
}

export interface PreviewOpenResponse {
  success: boolean;
  /** The persistent preview's id (its view is /preview/<id>). */
  id?: string;
  port?: number;
  path?: string;
  error?: string;
}

/** `ut task <op>` / `ut project <op>`: one task command (services/task-commands.ts). */
export interface TaskRequest {
  op: string;
  args: Record<string, unknown>;
  /** UNTETHER_SESSION_ID of the caller, when it runs inside a session. */
  callerSessionId?: string;
}

export type TaskResponse =
  | { ok: true; status: 'done'; data: Record<string, unknown> }
  | {
      ok: true;
      status: 'pending-confirmation';
      confirmation: TaskConfirmation;
      /** What the caller gets at once while it waits (a connector token, inactive until then). */
      data?: Record<string, unknown>;
    }
  | {
      ok: false;
      code: string;
      message: string;
      commits?: number;
      data?: Record<string, unknown>;
    };

/**
 * Type-safe mapping of message types to their payload types
 */
export type MessagePayloadMap = {
  [MessageType.STDIN_DATA]: string;
  [MessageType.CONTROL_CMD]: ControlCommand;
  [MessageType.STATUS_UPDATE]: StatusUpdate;
  [MessageType.HEARTBEAT]: Record<string, never>;
  [MessageType.ERROR]: ErrorMessage;
  [MessageType.STATUS_REQUEST]: StatusRequest;
  [MessageType.STATUS_RESPONSE]: StatusResponse;
  [MessageType.GIT_FOLLOW_REQUEST]: GitFollowRequest;
  [MessageType.GIT_FOLLOW_RESPONSE]: GitFollowResponse;
  [MessageType.GIT_EVENT_NOTIFY]: GitEventNotify;
  [MessageType.GIT_EVENT_ACK]: GitEventAck;
  [MessageType.PREVIEW_OPEN_REQUEST]: PreviewOpenRequest;
  [MessageType.PREVIEW_OPEN_RESPONSE]: PreviewOpenResponse;
  [MessageType.TASK_REQUEST]: TaskRequest;
  [MessageType.TASK_RESPONSE]: TaskResponse;
};

/**
 * Get the payload type for a given message type
 */
export type MessagePayload<T extends MessageType> = T extends keyof MessagePayloadMap
  ? MessagePayloadMap[T]
  : never;

/**
 * Frame a message for transmission
 */
export function frameMessage(type: MessageType, payload: Buffer | string | object): Buffer {
  const payloadBuffer = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');

  if (payloadBuffer.length > MAX_MESSAGE_PAYLOAD_SIZE) {
    throw new RangeError(
      `Socket message payload is ${payloadBuffer.length} bytes; maximum is ${MAX_MESSAGE_PAYLOAD_SIZE}`
    );
  }

  const message = Buffer.allocUnsafe(5 + payloadBuffer.length);
  message[0] = type;
  message.writeUInt32BE(payloadBuffer.length, 1);
  payloadBuffer.copy(message, 5);

  return message;
}

/**
 * Parse messages from a buffer
 */
export class MessageParser {
  private buffer = Buffer.alloc(0);

  /**
   * Add data to the parser
   */
  addData(chunk: Buffer | Uint8Array | string): void {
    const bufferChunk = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(typeof chunk === 'string' ? chunk : chunk);
    this.buffer = Buffer.concat([this.buffer, bufferChunk]);
  }

  /**
   * Parse complete messages from the buffer
   */
  *parseMessages(): Generator<{ type: MessageType; payload: Buffer }> {
    while (this.buffer.length >= 5) {
      const messageType = this.buffer[0] as MessageType;
      const payloadLength = this.buffer.readUInt32BE(1);

      if (payloadLength > MAX_MESSAGE_PAYLOAD_SIZE) {
        this.clear();
        throw new RangeError(
          `Socket message payload is ${payloadLength} bytes; maximum is ${MAX_MESSAGE_PAYLOAD_SIZE}`
        );
      }

      // Check if we have the complete message
      if (this.buffer.length < 5 + payloadLength) {
        break;
      }

      // Extract the message
      const payload = this.buffer.subarray(5, 5 + payloadLength);
      this.buffer = this.buffer.subarray(5 + payloadLength);

      yield { type: messageType, payload };
    }
  }

  /**
   * Get the number of bytes waiting to be parsed
   */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * High-level message creation helpers
 */
export const MessageBuilder = {
  stdin(data: string): Buffer {
    return frameMessage(MessageType.STDIN_DATA, data);
  },

  resize(cols: number, rows: number): Buffer {
    return frameMessage(MessageType.CONTROL_CMD, { cmd: 'resize', cols, rows });
  },

  kill(signal?: string | number): Buffer {
    return frameMessage(MessageType.CONTROL_CMD, { cmd: 'kill', signal });
  },

  resetSize(): Buffer {
    return frameMessage(MessageType.CONTROL_CMD, { cmd: 'reset-size' });
  },

  updateTitle(title: string): Buffer {
    return frameMessage(MessageType.CONTROL_CMD, { cmd: 'update-title', title });
  },

  status(app: string, status: string, extra?: Record<string, unknown>): Buffer {
    return frameMessage(MessageType.STATUS_UPDATE, { app, status, ...extra });
  },

  heartbeat(): Buffer {
    return frameMessage(MessageType.HEARTBEAT, Buffer.alloc(0));
  },

  error(code: string, message: string, details?: unknown): Buffer {
    return frameMessage(MessageType.ERROR, { code, message, details });
  },

  gitFollowRequest(request: GitFollowRequest): Buffer {
    return frameMessage(MessageType.GIT_FOLLOW_REQUEST, request);
  },

  gitFollowResponse(response: GitFollowResponse): Buffer {
    return frameMessage(MessageType.GIT_FOLLOW_RESPONSE, response);
  },

  gitEventNotify(event: GitEventNotify): Buffer {
    return frameMessage(MessageType.GIT_EVENT_NOTIFY, event);
  },

  gitEventAck(ack: GitEventAck): Buffer {
    return frameMessage(MessageType.GIT_EVENT_ACK, ack);
  },

  previewOpenRequest(request: PreviewOpenRequest): Buffer {
    return frameMessage(MessageType.PREVIEW_OPEN_REQUEST, request);
  },

  previewOpenResponse(response: PreviewOpenResponse): Buffer {
    return frameMessage(MessageType.PREVIEW_OPEN_RESPONSE, response);
  },

  taskRequest(request: TaskRequest): Buffer {
    return frameMessage(MessageType.TASK_REQUEST, request);
  },

  taskResponse(response: TaskResponse): Buffer {
    return frameMessage(MessageType.TASK_RESPONSE, response);
  },

  statusRequest(request: StatusRequest = {}): Buffer {
    return frameMessage(MessageType.STATUS_REQUEST, request);
  },

  statusResponse(response: StatusResponse): Buffer {
    return frameMessage(MessageType.STATUS_RESPONSE, response);
  },
} as const;

/**
 * Parse payload based on message type
 */
export function parsePayload(type: MessageType, payload: Buffer): unknown {
  switch (type) {
    case MessageType.STDIN_DATA:
      return payload.toString('utf8');

    case MessageType.CONTROL_CMD:
    case MessageType.STATUS_UPDATE:
    case MessageType.ERROR:
    case MessageType.STATUS_REQUEST:
    case MessageType.STATUS_RESPONSE:
    case MessageType.GIT_FOLLOW_REQUEST:
    case MessageType.GIT_FOLLOW_RESPONSE:
    case MessageType.GIT_EVENT_NOTIFY:
    case MessageType.GIT_EVENT_ACK:
    case MessageType.PREVIEW_OPEN_REQUEST:
    case MessageType.PREVIEW_OPEN_RESPONSE:
    case MessageType.TASK_REQUEST:
    case MessageType.TASK_RESPONSE:
      try {
        return JSON.parse(payload.toString('utf8'));
      } catch (e) {
        throw new Error(
          `Failed to parse JSON payload for message type ${type}: ${e instanceof Error ? e.message : String(e)}`
        );
      }

    case MessageType.HEARTBEAT:
      return null;

    default:
      return payload;
  }
}

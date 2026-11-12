/**
 * Socket API client for Untether control operations
 * Used by the ut command to communicate with the server via Unix socket
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BuildInfo } from './build-info.js';
import { UntetherSocketClient } from './pty/socket-client.js';
import {
  type GitEventAck,
  type GitEventNotify,
  type GitFollowRequest,
  type GitFollowResponse,
  type MessagePayload,
  MessageType,
  type PreviewOpenRequest,
  type PreviewOpenResponse,
  type TaskRequest,
  type TaskResponse,
} from './pty/socket-protocol.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('socket-api');

/**
 * A task command answers at once (merges and checks go on in the background); creating a
 * worktree task only waits for its record. Longer than the default for a busy server.
 */
const TASK_REQUEST_TIMEOUT_MS = 15_000;

/**
 * How long a task command waits for a server that is restarting: the socket is missing or
 * refuses the connection meanwhile. A dev reload takes about a second, a crashed server the
 * Mac app restarts up to a minute. 2026-10-18: reloads failed `ut task wait` and `ut task
 * merge` at once with "connect ECONNREFUSED". Only the connection is retried: a request that
 * reached the server is never sent twice.
 */
export const TASK_CONNECT_RETRY_MS = 60_000;
const CONNECT_RETRY_INTERVAL_MS = 500;

/** The server is not there right now (not running, or restarting). */
export function isServerUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOENT' ||
    /ECONNREFUSED|ENOENT|Untether server is not running/.test(error.message)
  );
}

export interface ServerStatus {
  running: boolean;
  port?: number;
  url?: string;
  /** Which build the server is and the `ut` commands it knows (build-info.ts). */
  build?: BuildInfo;
  /** What the installed app's own update is doing, in one line. */
  appUpdate?: string;
  followMode?: {
    enabled: boolean;
    branch?: string;
    repoPath?: string;
  };
}

/**
 * Client for control socket operations
 */
export class SocketApiClient {
  private readonly controlSocketPath: string;
  private readonly controlDir: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onWaiting?: () => void;

  constructor(
    options: {
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      /** Told once while a request waits for a restarting server. */
      onWaiting?: () => void;
    } = {}
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.onWaiting = options.onWaiting;
    // Use control directory from environment or default
    this.controlDir = process.env.UNTETHER_CONTROL_DIR || path.join(os.homedir(), '.untether');
    // Use api.sock instead of control.sock to avoid conflicts with Mac app
    this.controlSocketPath = path.join(this.controlDir, 'api.sock');

    logger.debug(`SocketApiClient initialized with control directory: ${this.controlDir}`);
    logger.debug(`Socket path: ${this.controlSocketPath}`);
  }

  /**
   * Check if the control socket exists
   */
  private isSocketAvailable(): boolean {
    const available = fs.existsSync(this.controlSocketPath);
    logger.debug(
      `Socket availability check: ${this.controlSocketPath} - ${available ? 'available' : 'not available'}`
    );
    return available;
  }

  /**
   * Send a request and wait for response
   */
  private async sendRequest<TRequest extends MessageType, TResponse>(
    type: TRequest,
    payload: MessagePayload<TRequest>,
    responseType: MessageType,
    timeout = 5000,
    connectRetryMs = 0
  ): Promise<TResponse> {
    const client = await this.connect(connectRetryMs);

    try {
      const response = await client.sendMessageWithResponse(type, payload, responseType, timeout);
      return response as TResponse;
    } catch (error) {
      if (error instanceof Error && error.message.includes('ENOENT')) {
        throw new Error('Untether server is not running');
      }
      throw error;
    } finally {
      client.disconnect();
    }
  }

  /**
   * A connected client; while the server is unavailable, tried again for `retryMs`.
   */
  private async connect(retryMs: number): Promise<UntetherSocketClient> {
    const deadline = this.now() + retryMs;
    let waiting = false;
    for (;;) {
      try {
        if (!this.isSocketAvailable()) throw new Error('Untether server is not running');
        const client = new UntetherSocketClient(this.controlSocketPath);
        try {
          await client.connect();
        } catch (error) {
          client.disconnect();
          throw error;
        }
        return client;
      } catch (error) {
        if (!isServerUnavailable(error) || this.now() >= deadline) {
          throw isServerUnavailable(error) ? new Error('Untether server is not running') : error;
        }
        if (!waiting) {
          waiting = true;
          logger.debug(`Untether server unavailable (${String(error)}); retrying`);
          this.onWaiting?.();
        }
        await this.sleep(CONNECT_RETRY_INTERVAL_MS);
      }
    }
  }

  /**
   * Get server status
   */
  async getStatus(): Promise<ServerStatus> {
    if (!this.isSocketAvailable()) {
      return { running: false };
    }

    try {
      // Send STATUS_REQUEST and wait for STATUS_RESPONSE
      const response = await this.sendRequest<MessageType.STATUS_REQUEST, ServerStatus>(
        MessageType.STATUS_REQUEST,
        { cwd: process.cwd() },
        MessageType.STATUS_RESPONSE
      );
      return response;
    } catch (error) {
      logger.error('Failed to get server status:', error);
      return { running: false };
    }
  }

  /**
   * Enable or disable Git follow mode
   */
  async setFollowMode(request: GitFollowRequest): Promise<GitFollowResponse> {
    return this.sendRequest<MessageType.GIT_FOLLOW_REQUEST, GitFollowResponse>(
      MessageType.GIT_FOLLOW_REQUEST,
      request,
      MessageType.GIT_FOLLOW_RESPONSE
    );
  }

  /**
   * Send Git event notification
   */
  async sendGitEvent(event: GitEventNotify): Promise<GitEventAck> {
    return this.sendRequest<MessageType.GIT_EVENT_NOTIFY, GitEventAck>(
      MessageType.GIT_EVENT_NOTIFY,
      event,
      MessageType.GIT_EVENT_ACK
    );
  }

  /**
   * `ut task <op>` / `ut project <op>`: one task command, answered at once (a long wait, like
   * `ut task wait`, is the caller polling `status`).
   */
  async task(
    op: string,
    args: Record<string, unknown>,
    caller: { sessionId?: string } = {}
  ): Promise<TaskResponse> {
    const request: TaskRequest = {
      op,
      args,
      ...(caller.sessionId ? { callerSessionId: caller.sessionId } : {}),
    };
    return this.sendRequest<MessageType.TASK_REQUEST, TaskResponse>(
      MessageType.TASK_REQUEST,
      request,
      MessageType.TASK_RESPONSE,
      TASK_REQUEST_TIMEOUT_MS,
      TASK_CONNECT_RETRY_MS
    );
  }

  /** `ut open`: show a dev server of this session in the app's preview. */
  async openPreview(request: PreviewOpenRequest): Promise<PreviewOpenResponse> {
    return this.sendRequest<MessageType.PREVIEW_OPEN_REQUEST, PreviewOpenResponse>(
      MessageType.PREVIEW_OPEN_REQUEST,
      request,
      MessageType.PREVIEW_OPEN_RESPONSE
    );
  }
}

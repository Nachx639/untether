/**
 * API Socket Server for Untether control operations
 * Provides a Unix socket interface for CLI commands (ut) to communicate with the server
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { currentBuild } from './build-info.js';
import {
  type GitEventAck,
  type GitEventNotify,
  type GitFollowRequest,
  type GitFollowResponse,
  MessageBuilder,
  MessageParser,
  MessageType,
  type PreviewOpenRequest,
  type PreviewOpenResponse,
  parsePayload,
  type StatusRequest,
  type StatusResponse,
  type TaskRequest,
  type TaskResponse,
} from './pty/socket-protocol.js';
import { TASK_CLI_HELP } from './task-cli.js';
import { createGitError } from './utils/git-error.js';
import { areHooksInstalled, installGitHooks, uninstallGitHooks } from './utils/git-hooks.js';
import { createLogger } from './utils/logger.js';
import { prettifyPath } from './utils/path-prettify.js';
import { BUILD_DATE, VERSION } from './version.js';

const logger = createLogger('api-socket');
const execFile = promisify(require('child_process').execFile);

/**
 * Execute a git command with proper error handling
 */
async function execGit(
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile('git', args, {
      cwd: options.cwd || process.cwd(),
      timeout: options.timeout || 5000,
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // Disable git prompts
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    throw createGitError(error, 'Git command failed');
  }
}

/** Which file a path names right now; null when there is none. */
function fileIdentity(file: string): { dev: number; ino: number } | null {
  try {
    const stat = fs.statSync(file);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

/**
 * API Socket Server that handles CLI commands via Unix socket
 */
export class ApiSocketServer {
  private server: net.Server | null = null;
  private readonly socketPath: string;
  /** The socket file this server made when it listened (stop deletes only that one). */
  private socketFile: { dev: number; ino: number } | null = null;
  private serverPort?: number;
  /**
   * Handles `ut git-event` in-process (wired by the server to routes/git.ts).
   * 2026-10-04: it used to POST to this server's own HTTP API with a freshly minted 24 h JWT
   * (added 2026-10-03 after the relay got 401 with auth on). That gave anyone who could reach
   * the socket the server's authority over HTTP, and sent the token to whatever listened on
   * localhost:<port> when the server was bound elsewhere.
   */
  private gitEventHandler:
    | ((request: { repoPath: string; event: string }) => Promise<{ status: number }>)
    | null = null;
  private serverUrl?: string;

  constructor() {
    // Use control directory from environment or default
    const controlDir = process.env.UNTETHER_CONTROL_DIR || path.join(os.homedir(), '.untether');
    const socketDir = controlDir;

    // Ensure directory exists
    if (!fs.existsSync(socketDir)) {
      fs.mkdirSync(socketDir, { recursive: true });
    }

    // Use a different socket name to avoid conflicts
    this.socketPath = path.join(socketDir, 'api.sock');
  }

  /**
   * Set server info for status queries
   */
  /** Handles `ut open` (wired by the server to the preview registry). */
  private previewOpenHandler:
    | ((request: PreviewOpenRequest) => PreviewOpenResponse | Promise<PreviewOpenResponse>)
    | null = null;
  setPreviewOpenHandler(
    handler: (request: PreviewOpenRequest) => PreviewOpenResponse | Promise<PreviewOpenResponse>
  ): void {
    this.previewOpenHandler = handler;
  }

  /** `ut status`: what the installed app's own update is doing (server-app-update.ts). */
  private appUpdateStatus: (() => string | undefined) | null = null;
  setAppUpdateStatus(status: () => string | undefined): void {
    this.appUpdateStatus = status;
  }

  /** Handles `ut task …` / `ut project …` (wired by the server to task-commands.ts). */
  private taskHandler: ((request: TaskRequest) => Promise<TaskResponse>) | null = null;
  setTaskHandler(handler: (request: TaskRequest) => Promise<TaskResponse>): void {
    this.taskHandler = handler;
  }

  setGitEventHandler(
    handler: (request: { repoPath: string; event: string }) => Promise<{ status: number }>
  ): void {
    this.gitEventHandler = handler;
  }

  setServerInfo(port: number, url: string): void {
    this.serverPort = port;
    this.serverUrl = url;
  }

  /**
   * Start the API socket server
   */
  async start(): Promise<void> {
    // Clean up any existing socket
    try {
      fs.unlinkSync(this.socketPath);
    } catch (_error) {
      // Ignore
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (error) => {
        logger.error('API socket server error:', error);
        reject(error);
      });

      this.server.listen(this.socketPath, () => {
        // Owner only: the socket acts with the server's authority (git events, follow mode,
        // `ut open`), and a new socket gets the umask's permissions (2026-10-04).
        try {
          fs.chmodSync(this.socketPath, 0o600);
        } catch (error) {
          logger.warn(`could not restrict ${this.socketPath} to its owner:`, error);
        }
        this.socketFile = fileIdentity(this.socketPath);
        logger.log(`API socket server listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  /**
   * Stop the API socket server. The socket file is deleted only while it is still this
   * server's (2026-11-11: a server that stopped after its replacement had started deleted the
   * replacement's api.sock, and `ut` could not reach the running server).
   */
  stop(): void {
    const server = this.server;
    this.server = null;
    const ours = this.socketFile;
    this.socketFile = null;
    const current = fileIdentity(this.socketPath);
    const stillOurs = !!ours && !!current && ours.dev === current.dev && ours.ino === current.ino;
    if (!server) return;
    if (!current || stillOurs) {
      // Closing a listening socket deletes its path (libuv); the unlink is for a close that
      // left it behind.
      server.close();
      if (stillOurs) {
        try {
          fs.unlinkSync(this.socketPath);
        } catch (_error) {
          // Ignore
        }
      }
      return;
    }
    // The path is another server's socket now, and closing ours would delete it: it is kept
    // under a second name across the close and put back, all in this one synchronous step.
    const kept = `${this.socketPath}.${process.pid}.keep`;
    try {
      fs.rmSync(kept, { force: true });
      fs.linkSync(this.socketPath, kept);
    } catch (error) {
      logger.warn(`could not keep the newer ${this.socketPath} across this server's stop:`, error);
      server.close();
      return;
    }
    server.close();
    try {
      if (fileIdentity(this.socketPath)) fs.unlinkSync(kept);
      else fs.renameSync(kept, this.socketPath);
    } catch (error) {
      logger.warn(`could not put the newer ${this.socketPath} back:`, error);
    }
  }

  /**
   * Handle incoming socket connections
   */
  private handleConnection(socket: net.Socket): void {
    const parser = new MessageParser();

    socket.on('data', (data) => {
      try {
        parser.addData(data);

        for (const { type, payload } of parser.parseMessages()) {
          this.handleMessage(socket, type, payload);
        }
      } catch (error) {
        logger.warn('Rejecting invalid API socket frame:', error);
        socket.destroy();
      }
    });

    socket.on('error', (error) => {
      logger.error('API socket connection error:', error);
    });
  }

  /**
   * Handle incoming messages
   */
  private async handleMessage(
    socket: net.Socket,
    type: MessageType,
    payload: Buffer
  ): Promise<void> {
    try {
      const data = parsePayload(type, payload);

      switch (type) {
        case MessageType.STATUS_REQUEST:
          await this.handleStatusRequest(socket, data as StatusRequest);
          break;

        case MessageType.GIT_FOLLOW_REQUEST:
          await this.handleGitFollowRequest(socket, data as GitFollowRequest);
          break;

        case MessageType.GIT_EVENT_NOTIFY:
          await this.handleGitEventNotify(socket, data as GitEventNotify);
          break;

        case MessageType.PREVIEW_OPEN_REQUEST: {
          const request = data as PreviewOpenRequest;
          const response: PreviewOpenResponse = this.previewOpenHandler
            ? await this.previewOpenHandler(request)
            : { success: false, error: 'Preview is not available on this server' };
          socket.write(MessageBuilder.previewOpenResponse(response));
          break;
        }

        case MessageType.TASK_REQUEST: {
          const request = data as TaskRequest;
          const valid =
            !!request &&
            typeof request.op === 'string' &&
            (request.args === undefined ||
              (typeof request.args === 'object' && request.args !== null)) &&
            (request.callerSessionId === undefined || typeof request.callerSessionId === 'string');
          let response: TaskResponse;
          if (!valid) {
            response = { ok: false, code: 'bad-request', message: 'Malformed task request' };
          } else if (!this.taskHandler) {
            response = {
              ok: false,
              code: 'unavailable',
              message: 'Tasks are not available on this server',
            };
          } else {
            try {
              response = await this.taskHandler({ ...request, args: request.args ?? {} });
            } catch (error) {
              response = {
                ok: false,
                code: 'error',
                message: error instanceof Error ? error.message : String(error),
              };
            }
          }
          socket.write(MessageBuilder.taskResponse(response));
          break;
        }

        default:
          logger.warn(`Unhandled message type: ${type}`);
      }
    } catch (error) {
      logger.error('Failed to handle message:', error);
      this.sendError(socket, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Handle status request
   */
  private async handleStatusRequest(socket: net.Socket, request: StatusRequest): Promise<void> {
    try {
      // The folder of whoever asks (2026-11-11: it was the server's own, so `ut status` told
      // the follow mode of the folder the server was started in, whatever repository the user
      // stood in). Without one, no follow mode is told.
      const cwd =
        typeof request?.cwd === 'string' && path.isAbsolute(request.cwd) ? request.cwd : null;

      // Check follow mode status
      let followMode: StatusResponse['followMode'];
      try {
        if (!cwd) throw new Error('no folder to look at');
        // Check if we're in a git repo
        const { stdout: repoPathOutput } = await execGit(['rev-parse', '--show-toplevel'], { cwd });
        const repoPath = repoPathOutput.trim();

        // Check if this is a worktree
        const { stdout: gitDirOutput } = await execGit(['rev-parse', '--git-dir'], { cwd });
        const gitDir = gitDirOutput.trim();
        const isWorktree = gitDir.includes('/.git/worktrees/');

        // Find main repo path
        let mainRepoPath = repoPath;
        if (isWorktree) {
          mainRepoPath = gitDir.replace(/\/\.git\/worktrees\/.*$/, '');
        }

        // Check for new worktree-based follow mode
        try {
          const { stdout } = await execGit(['config', 'untether.followWorktree'], {
            cwd: mainRepoPath,
          });
          const followWorktree = stdout.trim();
          if (followWorktree) {
            // Get branch name from worktree for display
            let branchName = path.basename(followWorktree);
            try {
              const { stdout: branchOutput } = await execGit(['branch', '--show-current'], {
                cwd: followWorktree,
              });
              if (branchOutput.trim()) {
                branchName = branchOutput.trim();
              }
            } catch (_e) {
              // Use directory name as fallback
            }

            followMode = {
              enabled: true,
              branch: branchName,
              repoPath: prettifyPath(followWorktree),
            };
          }
        } catch (_e) {
          // No follow mode configured
        }
      } catch (_error) {
        // Not in a git repo
      }

      const response: StatusResponse = {
        running: true,
        port: this.serverPort,
        url: this.serverUrl,
        version: VERSION,
        buildDate: BUILD_DATE,
        // A CLI that fails on a command tells whether it is older than this (build-info.ts).
        build: currentBuild({ help: TASK_CLI_HELP, version: VERSION }),
        appUpdate: this.appUpdateStatus?.(),
        followMode,
      };

      socket.write(MessageBuilder.statusResponse(response));
    } catch (error) {
      logger.error('Failed to get status:', error);
      this.sendError(socket, 'Failed to get server status');
    }
  }

  /**
   * Handle Git follow mode request
   */
  private async handleGitFollowRequest(
    socket: net.Socket,
    request: GitFollowRequest
  ): Promise<void> {
    try {
      const { repoPath, branch, enable, worktreePath, mainRepoPath } = request;

      // Use new fields if available, otherwise fall back to old fields
      const targetMainRepo = mainRepoPath || repoPath;
      if (!targetMainRepo) {
        throw new Error('No repository path provided');
      }

      const absoluteMainRepo = path.resolve(targetMainRepo);
      const absoluteWorktreePath = worktreePath ? path.resolve(worktreePath) : undefined;

      logger.debug(
        `${enable ? 'Enabling' : 'Disabling'} follow mode${absoluteWorktreePath ? ` for worktree: ${absoluteWorktreePath}` : branch ? ` for branch: ${branch}` : ''}`
      );

      if (enable) {
        // Check if Git hooks are already installed
        const hooksAlreadyInstalled = await areHooksInstalled(absoluteMainRepo);

        if (!hooksAlreadyInstalled) {
          // Install Git hooks
          logger.info('Installing Git hooks for follow mode');
          const installResult = await installGitHooks(absoluteMainRepo);

          if (!installResult.success) {
            const response: GitFollowResponse = {
              success: false,
              error: 'Failed to install Git hooks',
            };
            socket.write(MessageBuilder.gitFollowResponse(response));
            return;
          }
        }

        // If we have a worktree path, use that. Otherwise try to find worktree from branch
        let followPath: string;
        let displayName: string;

        if (absoluteWorktreePath) {
          // Direct worktree path provided
          followPath = absoluteWorktreePath;

          // Get the branch name from the worktree for display
          try {
            const { stdout } = await execGit(['branch', '--show-current'], {
              cwd: absoluteWorktreePath,
            });
            displayName = stdout.trim() || path.basename(absoluteWorktreePath);
          } catch {
            displayName = path.basename(absoluteWorktreePath);
          }
        } else if (branch) {
          // Try to find worktree for the branch
          try {
            const { stdout } = await execGit(['worktree', 'list', '--porcelain'], {
              cwd: absoluteMainRepo,
            });

            const lines = stdout.split('\n');
            let foundWorktree: string | undefined;

            for (let i = 0; i < lines.length; i++) {
              if (lines[i].startsWith('worktree ')) {
                const worktreePath = lines[i].substring(9);
                // Check if next lines contain our branch
                if (i + 2 < lines.length && lines[i + 2] === `branch refs/heads/${branch}`) {
                  if (worktreePath !== absoluteMainRepo) {
                    foundWorktree = worktreePath;
                    break;
                  }
                }
              }
            }

            if (!foundWorktree) {
              throw new Error(`No worktree found for branch '${branch}'`);
            }

            followPath = foundWorktree;
            displayName = branch;
          } catch (error) {
            throw new Error(
              `Failed to find worktree: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        } else {
          // No branch or worktree specified - try current branch
          try {
            const { stdout } = await execGit(['branch', '--show-current'], {
              cwd: absoluteMainRepo,
            });
            const currentBranch = stdout.trim();

            if (!currentBranch) {
              throw new Error('Not on a branch (detached HEAD)');
            }

            // Recursively call with the current branch
            return this.handleGitFollowRequest(socket, {
              ...request,
              branch: currentBranch,
            });
          } catch (error) {
            throw new Error(
              `Failed to get current branch: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        // Set the follow mode config with worktree path
        await execGit(['config', '--local', 'untether.followWorktree', followPath], {
          cwd: absoluteMainRepo,
        });

        // Install hooks in both locations
        const mainRepoHooksInstalled = await areHooksInstalled(absoluteMainRepo);
        if (!mainRepoHooksInstalled) {
          logger.info('Installing Git hooks in main repository');
          const installResult = await installGitHooks(absoluteMainRepo);
          if (!installResult.success) {
            throw new Error('Failed to install Git hooks in main repository');
          }
        }

        const worktreeHooksInstalled = await areHooksInstalled(followPath);
        if (!worktreeHooksInstalled) {
          logger.info('Installing Git hooks in worktree');
          const installResult = await installGitHooks(followPath);
          if (!installResult.success) {
            logger.warn('Failed to install Git hooks in worktree, continuing anyway');
          }
        }

        const response: GitFollowResponse = {
          success: true,
          currentBranch: displayName,
        };
        socket.write(MessageBuilder.gitFollowResponse(response));
      } else {
        // The worktree that was being followed, read BEFORE the setting goes (2026-11-10: it
        // was read after the unset, so it was never known and its hooks stayed).
        let followedWorktree: string | undefined;
        try {
          const { stdout } = await execGit(['config', 'untether.followWorktree'], {
            cwd: absoluteMainRepo,
          });
          followedWorktree = stdout.trim();
        } catch {
          // No worktree was being followed
        }

        // Disable follow mode. With nothing set, git's unset exits 5: the hooks below still
        // have to go.
        if (followedWorktree !== undefined) {
          await execGit(['config', '--local', '--unset', 'untether.followWorktree'], {
            cwd: absoluteMainRepo,
          });
        }

        // Uninstall Git hooks from main repo
        logger.info('Uninstalling Git hooks from main repository');
        const mainUninstallResult = await uninstallGitHooks(absoluteMainRepo);

        // Also uninstall from worktree if we know which one was being followed
        if (followedWorktree && followedWorktree !== absoluteMainRepo) {
          logger.info('Uninstalling Git hooks from worktree');
          const worktreeUninstallResult = await uninstallGitHooks(followedWorktree);
          if (!worktreeUninstallResult.success) {
            logger.warn(
              'Failed to uninstall some Git hooks from worktree:',
              worktreeUninstallResult.errors
            );
          }
        }

        if (!mainUninstallResult.success) {
          logger.warn(
            'Failed to uninstall some Git hooks from main repo:',
            mainUninstallResult.errors
          );
          // Continue anyway - follow mode is still disabled
        } else {
          logger.info('Git hooks uninstalled successfully from main repository');
        }

        const response: GitFollowResponse = {
          success: true,
        };
        socket.write(MessageBuilder.gitFollowResponse(response));
      }
    } catch (error) {
      const response: GitFollowResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      socket.write(MessageBuilder.gitFollowResponse(response));
    }
  }

  /**
   * Handle Git event notification
   */
  private async handleGitEventNotify(socket: net.Socket, event: GitEventNotify): Promise<void> {
    logger.debug(`Git event notification received: ${event.type} for ${event.repoPath}`);

    try {
      if (!this.gitEventHandler) throw new Error('no git event handler');
      // The handler detects the branch itself.
      const result = await this.gitEventHandler({ repoPath: event.repoPath, event: event.type });
      if (result.status !== 200) throw new Error(`git event handler returned ${result.status}`);
      logger.debug('Git event processed successfully:', result);

      const ack: GitEventAck = {
        handled: true,
      };
      socket.write(MessageBuilder.gitEventAck(ack));
    } catch (error) {
      logger.error('Failed to forward git event to HTTP endpoint:', error);

      const ack: GitEventAck = {
        handled: false,
      };
      socket.write(MessageBuilder.gitEventAck(ack));
    }
  }

  /**
   * Send error response
   */
  private sendError(socket: net.Socket, message: string): void {
    socket.write(MessageBuilder.error('API_ERROR', message));
  }
}

// Export singleton instance
export const apiSocketServer = new ApiSocketServer();

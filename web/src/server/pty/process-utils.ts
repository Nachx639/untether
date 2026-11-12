/**
 * ProcessUtils - process management utilities (macOS and Linux)
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { colors } from '../utils/colors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('process-utils');

/**
 * Get the appropriate shell configuration file for a given shell
 * @param shellPath The path to the shell executable
 * @returns The path to the shell config file, or null if none found
 */
function getShellConfigFile(shellPath: string): string | null {
  const homeDir = os.homedir();
  const shellName = path.basename(shellPath);

  // Map of shell names to their config files (in order of preference)
  const shellConfigs: Record<string, string[]> = {
    zsh: ['.zshrc', '.zshenv'],
    bash: ['.bashrc', '.bash_profile', '.profile'],
    sh: ['.profile'],
    ksh: ['.kshrc', '.profile'],
    fish: ['.config/fish/config.fish'],
    tcsh: ['.tcshrc', '.cshrc'],
    csh: ['.cshrc'],
    dash: ['.profile'],
  };

  // Get config files for this shell
  const configFiles = shellConfigs[shellName] || [];

  // Check each config file in order of preference
  for (const configFile of configFiles) {
    const fullPath = path.join(homeDir, configFile);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  // Fallback to .profile for unknown shells
  const profilePath = path.join(homeDir, '.profile');
  if (existsSync(profilePath)) {
    return profilePath;
  }

  return null;
}

/**
 * Safe file existence check
 */
function existsSync(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function buildShellCommandArgs(
  shellPath: string,
  command: string[],
  interactive = false,
  login = false
): string[] {
  const shellName = path.basename(shellPath).toLowerCase();
  const [commandName, ...commandArgs] = command;
  const shellArgs: string[] = [];

  // Alias expansion requires a literal command word, so reject anything that could add shell syntax.
  if (!/^[A-Za-z0-9_@%+,./:-]+$/.test(commandName)) {
    throw new Error(`Unsafe shell fallback command name: ${commandName}`);
  }

  if (interactive) {
    shellArgs.push(shellName === 'fish' ? '--interactive' : '-i');
  }
  // csh/tcsh only accept -l as the sole option, so it cannot be combined with -c.
  if (login && shellName !== 'csh' && shellName !== 'tcsh') {
    shellArgs.push(shellName === 'fish' ? '--login' : '-l');
  }

  if (shellName === 'csh' || shellName === 'tcsh') {
    const argReferences = commandArgs.map((_, index) => `"$argv[${index + 1}]:q"`).join(' ');
    const commandText = argReferences ? `${commandName} ${argReferences}` : commandName;
    return [...shellArgs, '-c', commandText, '-b', ...commandArgs];
  }

  if (shellName === 'fish') {
    return [...shellArgs, '-c', `${commandName} $argv`, ...commandArgs];
  }

  return [...shellArgs, '-c', `${commandName} "$@"`, '--', ...commandArgs];
}

/**
 * Check if a process is currently running by PID
 */
export function isProcessRunning(pid: number): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    return isProcessRunningUnix(pid);
  } catch (error) {
    logger.warn(`error checking if process ${pid} is running:`, error);
    return false;
  }
}

/**
 * Unix-like systems process check using kill signal 0
 */
function isProcessRunningUnix(pid: number): boolean {
  try {
    // Send signal 0 to check if process exists
    // This doesn't actually kill the process, just checks existence
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // If we get ESRCH, the process doesn't exist
    // If we get EPERM, the process exists but we don't have permission
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EPERM') {
      // Process exists but we don't have permission to signal it
      return true;
    }
    // ESRCH or other errors mean process doesn't exist
    return false;
  }
}

/**
 * When process `pid` started, as `ps -o lstart=` prints it ("Mon Oct 20 00:12:01 2026"), or
 * null when it doesn't run or ps can't tell. With the pid it names one process: a pid the
 * kernel handed to another program since gives another start time.
 */
export function processStartTime(pid: number): string | null {
  if (!pid || pid <= 0) return null;
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    const text = result.status === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : '';
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` still is the process that had start time `startTime`. Without a recorded
 * start time only its existence can be checked; when ps can't tell, it counts as the same.
 *
 * 2026-10-20: a session left 'running' (its server died) whose pid the kernel gave to another
 * program after a reboot: Kill sent that program SIGTERM, and the Claude status notifier
 * showed someone else's Claude as the session's.
 */
export function isSameProcess(pid: number, startTime: string | undefined | null): boolean {
  if (!isProcessRunning(pid)) return false;
  if (!startTime) return true;
  const now = processStartTime(pid);
  return now === null || now === startTime;
}

/**
 * Get basic process information if available
 * Returns null if process is not running or info cannot be retrieved
 */
export function getProcessInfo(pid: number): { pid: number; exists: boolean } | null {
  if (!isProcessRunning(pid)) {
    return null;
  }

  return {
    pid,
    exists: true,
  };
}

/**
 * Send a signal to a process
 * Returns true if the kill signal was sent successfully
 */
export function killProcess(pid: number, signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  logger.debug(`attempting to kill process ${pid} with signal ${signal}`);

  try {
    process.kill(pid, signal);
    logger.log(colors.green(`signal ${signal} sent to process ${pid}`));
    return true;
  } catch (error) {
    logger.warn(`error killing process ${pid}:`, error);
    return false;
  }
}

/**
 * Wait for a process to exit with timeout
 * Returns true if process exited within timeout, false otherwise
 */
export async function waitForProcessExit(pid: number, timeoutMs: number = 5000): Promise<boolean> {
  const startTime = Date.now();
  const checkInterval = 100; // Check every 100ms

  logger.debug(`waiting for process ${pid} to exit (timeout: ${timeoutMs}ms)`);

  while (Date.now() - startTime < timeoutMs) {
    if (!isProcessRunning(pid)) {
      const elapsed = Date.now() - startTime;
      logger.log(colors.green(`process ${pid} exited after ${elapsed}ms`));
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  logger.log(colors.yellow(`process ${pid} did not exit within ${timeoutMs}ms timeout`));
  return false;
}

/**
 * Check if this is an interactive shell session
 */
function isInteractiveShellCommand(cmdName: string, args: string[]): boolean {
  // Common shells
  const shells = ['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh'];
  const isShell = shells.some((shell) => cmdName === shell || cmdName.endsWith(`/${shell}`));

  if (!isShell) return false;

  // Check for interactive flags
  const interactiveFlags = ['-i', '--interactive', '-l', '--login'];

  // If no args, it's interactive by default
  if (args.length === 0) return true;

  // Check if any args indicate interactive mode
  return args.some((arg) => interactiveFlags.includes(arg));
}

/**
 * Determine how to spawn a command, checking if it exists in PATH or needs shell execution
 * Returns the actual command and args to use for spawning
 */
export function resolveCommand(command: string[]): {
  command: string;
  args: string[];
  useShell: boolean;
  isInteractive?: boolean;
  resolvedFrom?: 'path' | 'alias' | 'builtin' | 'shell';
  originalCommand?: string;
} {
  if (command.length === 0) {
    throw new Error('No command provided');
  }

  const cmdName = command[0];
  const cmdArgs = command.slice(1);

  // Check if command exists in PATH
  try {
    const result = spawnSync('which', [cmdName], {
      encoding: 'utf8',
      timeout: 2000, // 2 second timeout
    });

    if (result.status === 0 && result.stdout && result.stdout.trim()) {
      // Command found in PATH
      logger.debug(`Command '${cmdName}' found at: ${result.stdout.trim()}`);

      // Check if this is an interactive shell command
      if (isInteractiveShellCommand(cmdName, cmdArgs)) {
        logger.log(colors.cyan(`✓ Starting ${cmdName} as login shell to load configuration files`));
        // Add both -i (interactive) and -l/--login flags for proper shell initialization
        // This ensures shell RC files are sourced and the environment is properly set up

        // Don't add flags if they're already present
        const hasInteractiveFlag = cmdArgs.some((arg) => arg === '-i' || arg === '--interactive');
        const hasLoginFlag = cmdArgs.some((arg) => arg === '-l' || arg === '--login');

        // Build args array
        const finalArgs = [...cmdArgs];

        // For fish shell, use --login and --interactive instead of -l and -i
        const isFish = cmdName === 'fish' || cmdName.endsWith('/fish');

        if (!hasInteractiveFlag) {
          finalArgs.unshift(isFish ? '--interactive' : '-i');
        }

        if (!hasLoginFlag) {
          finalArgs.unshift(isFish ? '--login' : '-l');
        }

        return {
          command: cmdName,
          args: finalArgs,
          useShell: false,
          resolvedFrom: 'path',
          originalCommand: cmdName,
          isInteractive: true,
        };
      }

      return {
        command: cmdName,
        args: cmdArgs,
        useShell: false,
        resolvedFrom: 'path',
        originalCommand: cmdName,
      };
    }
  } catch (error) {
    logger.debug(`Failed to check command existence for '${cmdName}':`, error);
  }

  // Command not found in PATH, likely an alias or shell builtin
  // Need to run through shell
  logger.debug(`Command '${cmdName}' not found in PATH, will use shell`);

  // Determine user's shell
  const userShell = getUserShell();

  // Check if this is trying to execute a command (not an interactive shell session)
  // If so, use non-interactive mode to ensure shell exits after execution
  const isCommand = !isInteractiveShellCommand(cmdName, cmdArgs);

  // Use interactive shell to execute the command
  // This ensures aliases and shell functions are available
  // Unix shells: Choose execution mode based on command type
  if (isCommand) {
    // Non-interactive command execution: shell will exit after completion
    // Use interactive mode to ensure aliases and functions are properly expanded
    const shellConfig = getShellConfigFile(userShell);

    if (shellConfig) {
      // Use interactive mode with login shell to ensure aliases are loaded and expanded
      // The -i flag enables interactive mode, which loads aliases
      // The -l flag makes it a login shell, ensuring profile/rc files are sourced
      return {
        command: userShell,
        args: buildShellCommandArgs(userShell, command, true, true),
        useShell: true,
        resolvedFrom: 'alias',
      };
    } else {
      // No shell config found, use basic execution
      return {
        command: userShell,
        args: buildShellCommandArgs(userShell, command),
        useShell: true,
        resolvedFrom: 'shell',
      };
    }
  } else {
    // Interactive shell session: use -i and -l for proper initialization
    return {
      command: userShell,
      args: buildShellCommandArgs(userShell, command, true, true),
      useShell: true,
      resolvedFrom: 'shell',
      isInteractive: true,
    };
  }
}

/**
 * Get the user's preferred shell
 * Falls back to sensible defaults if SHELL env var is not set
 */
export function getUserShell(): string {
  // First try SHELL environment variable (most reliable on Unix)
  if (process.env.SHELL) {
    return process.env.SHELL;
  }

  // Node.js os.userInfo() includes shell on some platforms
  try {
    const userInfo = os.userInfo();
    if ('shell' in userInfo && userInfo.shell) {
      return userInfo.shell as string;
    }
  } catch (_) {
    // userInfo might fail in some environments
  }

  // Check common shell paths in order of preference
  // Prefer bash over zsh to avoid first-run configuration issues in CI
  const commonShells = ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/bin/sh'];
  for (const shell of commonShells) {
    try {
      // Just check if the shell exists and is executable
      const result = spawnSync('test', ['-x', shell], {
        encoding: 'utf8',
        timeout: 500,
      });
      if (result.status === 0) {
        return shell;
      }
    } catch (_) {
      // test command failed, try next shell
    }
  }

  // Final fallback - /bin/sh should always exist on Unix
  return '/bin/sh';
}

/**
 * The exit code a session is recorded with, from what its ended process reported. A clean exit
 * is 0 and stays 0 (2026-11-10: `exitCode || 1` recorded every clean exit as 1, so the list
 * showed it as failed and its push said "ended with errors"). A process a signal ended is
 * 128 + signal, as a shell reports it. 1 only when there is no code at all (the process was
 * never waited for: a zombie found later, a shielded program whose tmux went away).
 */
export function recordedExitCode(ended: {
  exitCode?: number | null;
  signal?: number | null;
}): number {
  const { exitCode, signal } = ended;
  if (typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0) return exitCode;
  if (typeof signal === 'number' && Number.isFinite(signal) && signal > 0) return 128 + signal;
  if (exitCode === 0) return 0;
  return 1;
}

// Re-export as object for backwards compatibility
export const ProcessUtils = {
  isProcessRunning,
  isSameProcess,
  processStartTime,
  getProcessInfo,
  killProcess,
  waitForProcessExit,
  resolveCommand,
  getUserShell,
};

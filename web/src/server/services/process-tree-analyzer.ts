import { exec } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('process-tree-analyzer');

/**
 * A command line as it may appear in the log: the program and how many arguments follow.
 * Arguments can hold prompts and secrets (`claude "…"`, `curl -H "Authorization: …"`), and
 * debug lines reach the log file by default (2026-10-04).
 */
export function commandForLog(command: string): string {
  const words = command.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const program = path.basename(words[0]);
  return words.length > 1 ? `${program} (+${words.length - 1} args)` : program;
}

const execAsync = promisify(exec);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  sid?: number;
  tty?: string;
  command: string;
  state?: string;
  startTime?: string;
}

export class ProcessTreeAnalyzer {
  /**
   * Get the complete process tree for a given root process
   */
  async getProcessTree(rootPid: number): Promise<ProcessInfo[]> {
    try {
      return await this.getUnixProcessTree(rootPid);
    } catch (_error) {
      logger.warn('ProcessTreeAnalyzer', `Failed to get process tree for PID ${rootPid}:`, _error);
      return [];
    }
  }

  /**
   * Get process tree on Unix-like systems (macOS, Linux)
   */
  private async getUnixProcessTree(rootPid: number): Promise<ProcessInfo[]> {
    const isMacOS = process.platform === 'darwin';

    // Always use the recursive approach since process groups aren't working reliably
    logger.debug(
      'ProcessTreeAnalyzer',
      `Using recursive child search for ${rootPid} to find all descendants`
    );

    try {
      return await this.getProcessTreeRecursive(rootPid, isMacOS);
    } catch (fallbackError) {
      logger.warn('ProcessTreeAnalyzer', `Recursive process search failed:`, fallbackError);

      // Final fallback: try to get just the root process
      try {
        const psCommand = isMacOS
          ? `ps -o pid,ppid,pgid,tty,state,lstart,command -p ${rootPid}`
          : `ps -o pid,ppid,pgid,sid,tty,state,lstart,command -p ${rootPid}`;

        const { stdout } = await execAsync(psCommand, { timeout: 5000 });
        return this.parseUnixProcessOutput(stdout, isMacOS);
      } catch (finalError) {
        logger.warn('ProcessTreeAnalyzer', `Final fallback also failed:`, finalError);
        return [];
      }
    }
  }

  /**
   * Parse Unix/Linux ps command output
   */
  private parseUnixProcessOutput(output: string, isMacOS: boolean = false): ProcessInfo[] {
    const lines = output.trim().split('\n');
    const processes: ProcessInfo[] = [];

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        if (isMacOS) {
          // macOS ps output: PID PPID PGID TTY STATE STARTED COMMAND
          // STARTED format: "Mon Jun 23 23:44:31 2025" (contains spaces)
          // We need to handle the multi-word timestamp properly
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 10) {
            const pid = Number.parseInt(parts[0], 10);
            const ppid = Number.parseInt(parts[1], 10);
            const pgid = Number.parseInt(parts[2], 10);
            const tty = parts[3] === '?' ? undefined : parts[3];
            const state = parts[4];
            // STARTED timestamp spans multiple parts: parts[5] through parts[9]
            const startTime = parts.slice(5, 10).join(' ');
            // COMMAND is everything from part 10 onwards
            const command = parts.slice(10).join(' ');

            if (!Number.isNaN(pid) && !Number.isNaN(ppid) && !Number.isNaN(pgid) && command) {
              logger.debug(
                'ProcessTreeAnalyzer',
                `Parsed macOS process: PID=${pid}, COMMAND="${commandForLog(command)}"`
              );
              processes.push({
                pid,
                ppid,
                pgid,
                tty,
                state,
                startTime,
                command: command.trim(),
              });
            }
          }
        } else {
          // Linux ps output: PID PPID PGID SID TTY STATE STARTED COMMAND
          const parts = line.split(/\s+/);
          if (parts.length >= 12) {
            const [pid, ppid, pgid, sid, tty, state] = parts;
            const startTime = parts.slice(6, 11).join(' ');
            const command = parts.slice(11).join(' ');
            const parsedPid = Number.parseInt(pid, 10);
            const parsedPpid = Number.parseInt(ppid, 10);
            const parsedPgid = Number.parseInt(pgid, 10);
            const parsedSid = Number.parseInt(sid, 10);

            if (
              !Number.isNaN(parsedPid) &&
              !Number.isNaN(parsedPpid) &&
              !Number.isNaN(parsedPgid) &&
              !Number.isNaN(parsedSid) &&
              command
            ) {
              processes.push({
                pid: parsedPid,
                ppid: parsedPpid,
                pgid: parsedPgid,
                sid: parsedSid,
                tty: tty === '?' ? undefined : tty,
                state,
                startTime,
                command: command.trim(),
              });
            }
          }
        }
      } catch (_parseError) {
        logger.debug('ProcessTreeAnalyzer', `Failed to parse ps line (${line.length} chars)`);
      }
    }

    return processes;
  }

  /**
   * Get process tree recursively by finding children
   */
  private async getProcessTreeRecursive(rootPid: number, isMacOS: boolean): Promise<ProcessInfo[]> {
    const allProcesses: ProcessInfo[] = [];
    const processedPids = new Set<number>();

    // Get all processes on the system
    const psCommand = isMacOS
      ? 'ps -eo pid,ppid,pgid,tty,state,lstart,command'
      : 'ps -eo pid,ppid,pgid,sid,tty,state,lstart,command';

    logger.debug('ProcessTreeAnalyzer', `Getting all system processes with: ${psCommand}`);
    const { stdout } = await execAsync(psCommand, { timeout: 10000 });
    const allSystemProcesses = this.parseUnixProcessOutput(stdout, isMacOS);

    logger.debug(
      'ProcessTreeAnalyzer',
      `Found ${allSystemProcesses.length} total system processes`
    );

    // Build a map of parent -> children
    const childrenMap = new Map<number, ProcessInfo[]>();
    for (const proc of allSystemProcesses) {
      if (!childrenMap.has(proc.ppid)) {
        childrenMap.set(proc.ppid, []);
      }
      const children = childrenMap.get(proc.ppid);
      if (children) {
        children.push(proc);
      }
    }

    // Check what children exist for our root PID
    const directChildren = childrenMap.get(rootPid) || [];
    logger.debug(
      'ProcessTreeAnalyzer',
      `Direct children of ${rootPid}: ${JSON.stringify(directChildren.map((p) => ({ pid: p.pid, command: commandForLog(p.command) })))}`
    );

    // Recursively collect the process tree starting from rootPid
    const collectProcessTree = (pid: number) => {
      if (processedPids.has(pid)) return;
      processedPids.add(pid);

      // Find the process itself
      const process = allSystemProcesses.find((p) => p.pid === pid);
      if (process) {
        allProcesses.push(process);
      }

      // Find and collect children
      const children = childrenMap.get(pid) || [];
      for (const child of children) {
        collectProcessTree(child.pid);
      }
    };

    collectProcessTree(rootPid);

    logger.debug(
      'ProcessTreeAnalyzer',
      `Final process tree: ${JSON.stringify(allProcesses.map((p) => ({ pid: p.pid, ppid: p.ppid, command: commandForLog(p.command) })))}`
    );

    return allProcesses;
  }
}

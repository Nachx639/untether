#!/usr/bin/env node
// Entry point for the server - imports the modular server which starts automatically

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { constants as osConstants } from 'os';
import * as path from 'path';
import { currentBuild, describeBuild } from './server/build-info.js';
import { startUntetherServer } from './server/server.js';
import { guardHookMain } from './server/services/task-guard-hook.js';
import {
  type CrashMark,
  crashMarkOf,
  crashMarksFile,
  recordCrash,
} from './server/utils/crash-marks.js';
import { exitAfterFlush } from './server/utils/exit-after-flush.js';
import {
  closeLogger,
  createLogger,
  getLogFilePath,
  initLogger,
  VerbosityLevel,
} from './server/utils/logger.js';
import { parseVerbosityFromEnv } from './server/utils/verbosity-parser.js';
import { VERSION } from './server/version.js';

/** "Untether Server v1.0.0 (build e2e429fad, 2026-10-24)": which build this CLI is. */
const versionLine = () => `Untether Server v${VERSION} (${describeBuild(currentBuild())})`;

// Check for version command early - before logger initialization
if (process.argv[2] === 'version') {
  console.log(versionLine());
  process.exit(0);
}

// A task agent's command guard hook (task-guard-hook.ts): decides one tool call and exits,
// before the logger (it must print nothing but its verdict).
if (process.argv[2] === 'guard-hook') guardHookMain(process.argv.slice(3));

// Initialize logger before anything else
// Parse verbosity from environment variables
const verbosityLevel = parseVerbosityFromEnv();

// Check for legacy debug mode (for backward compatibility with initLogger)
const debugMode = process.env.UNTETHER_DEBUG === '1' || process.env.UNTETHER_DEBUG === 'true';

// Client commands talk to a running server: they append to its log, never start it afresh.
const CLIENT_COMMANDS = new Set([
  'version',
  'help',
  '--help',
  '-h',
  'fwd',
  'status',
  'follow',
  'unfollow',
  'open',
  'git-event',
  'task',
  'project',
  'events',
  'check-slot',
]);
initLogger(debugMode, verbosityLevel, { fresh: !CLIENT_COMMANDS.has(process.argv[2] ?? '') });
const logger = createLogger('cli');

// Source maps are only included if built with --sourcemap flag

// Prevent double execution in SEA context where require.main might be undefined
// Use a global flag to ensure we only run once
interface GlobalWithUntether {
  __untetherStarted?: boolean;
}

const globalWithUntether = global as unknown as GlobalWithUntether;

if (globalWithUntether.__untetherStarted) {
  process.exit(0);
}
globalWithUntether.__untetherStarted = true;

/**
 * The server going down on an exception leaves a mark its next start's doctor reads
 * (2026-11-11: it stopped eight times in 16 hours and nobody knew). Only the server: a `ut`
 * command that fails is not the server stopping.
 */
function markCrash(kind: CrashMark['kind'], reason: unknown): void {
  if (CLIENT_COMMANDS.has(process.argv[2] ?? '')) return;
  recordCrash(crashMarksFile(getLogFilePath()), crashMarkOf(kind, reason));
}

// What nothing caught: the process cannot go on. The periodic loops never get here
// (utils/periodic-loop.ts catches their steps and the doctor tells them).
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  logger.error('Stack trace:', error.stack);
  markCrash('uncaughtException', error);
  closeLogger();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  if (reason instanceof Error) {
    logger.error('Stack trace:', reason.stack);
  }
  markCrash('unhandledRejection', reason);
  closeLogger();
  process.exit(1);
});

/**
 * Print help message with version and usage information
 */
function printHelp(): void {
  console.log(`Untether Server v${VERSION}`);
  console.log('');
  console.log('Usage:');
  console.log('  untether [options]                    Start Untether server');
  console.log('  untether fwd [options] <command>      Run command in a forwarded session');
  console.log('  untether status                       Show server and follow mode status');
  console.log('  untether follow [branch]              Enable Git follow mode');
  console.log('  untether unfollow                     Disable Git follow mode');
  console.log('  untether git-event                    Notify server of Git event');
  console.log(
    '  untether open <port|url>              Show a dev server in the app (in a session)'
  );
  console.log('  untether task <command> [args]        Tasks: an agent on its own branch, merged');
  console.log('                                        when done (untether task help)');
  console.log('  untether project <command> [args]     Task settings of a repository (show, set)');
  console.log(
    '  untether events [--follow] [--after ID] Event log: tasks, sessions, doctor, pushes'
  );
  console.log('                                        (untether events --help)');
  console.log(
    '  untether diag input [--since 24h]     Keyboard, key latency, scrolling (diag --help)'
  );
  console.log(
    '  untether doctor [--run] [--json]      What Untether found wrong with itself, and how'
  );
  console.log("                                        the installed app's own update is doing");
  console.log(
    "  untether check-slot run -- <command>  Run a heavy check in one of the Mac's check"
  );
  console.log('                                        slots (untether check-slot --help)');
  console.log('  untether version                      Show version');
  console.log('  untether help                         Show this help');
  console.log('');
  console.log('Examples:');
  console.log('  untether --port 8080 --no-auth');
  console.log('  untether fwd --title-mode static bash');
  console.log('');
  console.log('For more options, run: untether --help');
}

/**
 * Print version information
 */
function printVersion(): void {
  console.log(versionLine());
}

/**
 * Handle command forwarding to a session
 */
async function handleForwardCommand(): Promise<void> {
  const resolveForwarder = (): string | null => {
    const envOverride = process.env.UNTETHER_FWD_BIN;
    if (envOverride && existsSync(envOverride)) {
      return envOverride;
    }

    const candidates: string[] = [];
    // Next to the current executable (SEA/app bundle)
    candidates.push(path.join(path.dirname(process.execPath), 'untether-fwd'));

    // Next to this module (dev and npm installs)
    const moduleDir = __dirname;
    candidates.push(
      path.resolve(
        moduleDir,
        '..',
        'forwarders',
        `${process.platform}-${process.arch}`,
        'untether-fwd'
      )
    );
    candidates.push(path.resolve(moduleDir, '..', 'bin', 'untether-fwd'));
    candidates.push(path.resolve(moduleDir, '..', 'native', 'untether-fwd'));

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  try {
    const forwarder = resolveForwarder();
    if (!forwarder) {
      logger.error(
        `untether-fwd not found. Set UNTETHER_FWD_BIN or build it: cd web && node scripts/build-fwd-rust.js (cwd: ${process.cwd()})`
      );
      closeLogger();
      process.exit(1);
    }

    const args = process.argv.slice(3);
    const child = spawn(forwarder, args, { stdio: 'inherit' });
    child.on('error', (error) => {
      logger.error('Failed to start native forwarder:', error);
      closeLogger();
      process.exit(1);
    });
    child.on('exit', (code) => {
      closeLogger();
      process.exit(code ?? 1);
    });
    return;
  } catch (error) {
    logger.error('Fatal error:', error);
    closeLogger();
    process.exit(1);
  }
}

/**
 * Handle socket API commands
 */
async function handleSocketCommand(command: string): Promise<void> {
  try {
    const { SocketApiClient } = await import('./server/socket-api-client.js');
    const client = new SocketApiClient();

    switch (command) {
      case 'status': {
        const status = await client.getStatus();
        console.log('Untether Server Status:');
        console.log(`  Running: ${status.running ? 'Yes' : 'No'}`);
        if (status.running) {
          console.log(`  Port: ${status.port || 'Unknown'}`);
          console.log(`  URL: ${status.url || 'Unknown'}`);
          if (status.build) console.log(`  Build: ${describeBuild(status.build)}`);
          console.log(`  This CLI: ${describeBuild(currentBuild())}`);
          if (status.appUpdate) console.log(`  App update: ${status.appUpdate}`);

          if (status.followMode) {
            console.log('\nGit Follow Mode:');
            console.log(`  Enabled: ${status.followMode.enabled ? 'Yes' : 'No'}`);
            if (status.followMode.enabled && status.followMode.branch) {
              console.log(`  Following branch: ${status.followMode.branch}`);
              console.log(`  Worktree: ${status.followMode.repoPath || 'Unknown'}`);
            }
          } else {
            console.log('\nGit Follow Mode: Not in a git repository');
          }
        }
        break;
      }

      case 'follow': {
        // Parse command line arguments
        const args = process.argv.slice(3);
        let worktreePath: string | undefined;
        let mainRepoPath: string | undefined;

        // Parse flags
        for (let i = 0; i < args.length; i++) {
          switch (args[i]) {
            case '--from-worktree':
              // Flag handled by ut script
              break;
            case '--worktree-path':
              worktreePath = args[++i];
              break;
            case '--main-repo':
              mainRepoPath = args[++i];
              break;
          }
        }

        const response = await client.setFollowMode({
          enable: true,
          worktreePath,
          mainRepoPath,
          // For backward compatibility, pass repoPath if mainRepoPath not set
          repoPath: mainRepoPath,
        });

        if (response.success) {
          // Success message is already printed by the ut script
        } else {
          console.error(`Failed to enable follow mode: ${response.error || 'Unknown error'}`);
          process.exit(1);
        }
        break;
      }

      case 'unfollow': {
        const repoPath = process.cwd();

        const response = await client.setFollowMode({
          repoPath,
          enable: false,
        });

        if (response.success) {
          console.log('Disabled follow mode');
        } else {
          console.error(`Failed to disable follow mode: ${response.error || 'Unknown error'}`);
          process.exit(1);
        }
        break;
      }

      case 'open': {
        const target = process.argv[3];
        const sessionId = process.env.UNTETHER_SESSION_ID;
        if (!target) {
          console.error(
            'Usage: ut open <port|url>   e.g. ut open 5173, ut open localhost:3000/about'
          );
          process.exit(1);
        }
        if (!sessionId) {
          console.error("Error: 'ut open' only works inside an Untether session.");
          process.exit(1);
        }
        const response = await client.openPreview({ sessionId, target });
        if (response.success) {
          console.log(
            `Preview opened in Untether: localhost:${response.port}${response.path ?? ''}`
          );
        } else {
          console.error(`Could not open the preview: ${response.error || 'Unknown error'}`);
          process.exit(1);
        }
        break;
      }

      case 'git-event': {
        const repoPath = process.cwd();

        await client.sendGitEvent({
          repoPath,
          type: 'other', // We don't know the specific type from command line
        });
        break;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Untether server is not running') {
      console.error('Error: Untether server is not running');
      console.error('Start the server first with: untether');
    } else {
      logger.error('Socket command failed:', error);
    }
    closeLogger();
    process.exit(1);
  }
}

/**
 * `untether task …` / `untether project …` (services/task-commands.ts through the API socket).
 */
async function handleTaskCommand(group: 'task' | 'project'): Promise<void> {
  try {
    const [{ SocketApiClient }, { runTaskCli, TASK_CLI_HELP }, { HANDED_OVER_ENV }] =
      await Promise.all([
        import('./server/socket-api-client.js'),
        import('./server/task-cli.js'),
        import('./server/task-cli/types.js'),
      ]);
    const client = new SocketApiClient({
      onWaiting: () => console.error('Untether server unavailable (restarting?); retrying...'),
    });
    const code = await runTaskCli(group, process.argv.slice(3), {
      task: (op, args, caller) => client.task(op, args, caller),
      env: process.env,
      cwd: process.cwd(),
      readStdin: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks).toString('utf8');
      },
      out: (text) => console.log(text),
      err: (text) => console.error(text),
      builds: {
        cli: () => currentBuild({ help: TASK_CLI_HELP, version: VERSION }),
        server: async () => (await client.getStatus()).build,
      },
      // This ut is older than the running server: the server's own CLI runs the command, with
      // this terminal's stdin (a heredoc) and output (task-cli/run.ts olderThanServer).
      handOver: (cli, argv) =>
        new Promise((resolve) => {
          if (!path.isAbsolute(cli) || !existsSync(cli)) return resolve(undefined);
          const child = spawn(cli, argv, {
            stdio: 'inherit',
            env: { ...process.env, [HANDED_OVER_ENV]: '1' },
          });
          const forward = (signal: NodeJS.Signals) => child.kill(signal);
          process.on('SIGINT', forward);
          process.on('SIGTERM', forward);
          child.on('error', () => resolve(undefined));
          child.on('exit', (code) => resolve(code ?? 1));
        }),
    });
    closeLogger();
    await exitAfterFlush(code);
  } catch (error) {
    if (error instanceof Error && error.message === 'Untether server is not running') {
      console.error('Error: Untether server is not running');
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    closeLogger();
    await exitAfterFlush(1);
  }
}

/** `untether events …`: the public event log (events-cli.ts) through the API socket. */
async function handleEventsCommand(): Promise<void> {
  try {
    const [{ SocketApiClient }, { runEventsCli }] = await Promise.all([
      import('./server/socket-api-client.js'),
      import('./server/events-cli.js'),
    ]);
    const client = new SocketApiClient({
      onWaiting: () => console.error('Untether server unavailable (restarting?); retrying...'),
    });
    const interrupted = new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    });
    const code = await runEventsCli(process.argv.slice(3), {
      task: (op, args) => client.task(op, args),
      cwd: process.cwd(),
      out: (text) => console.log(text),
      err: (text) => console.error(text),
      interrupted,
    });
    closeLogger();
    await exitAfterFlush(code);
  } catch (error) {
    if (error instanceof Error && error.message === 'Untether server is not running') {
      console.error('Error: Untether server is not running');
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    closeLogger();
    await exitAfterFlush(1);
  }
}

/** `untether check-slot …`: a place in the Mac's check slots (check-slot-cli.ts). */
async function handleCheckSlotCommand(): Promise<void> {
  let code = 1;
  try {
    const [{ SocketApiClient }, { runCheckSlotCli }] = await Promise.all([
      import('./server/socket-api-client.js'),
      import('./server/check-slot-cli.js'),
    ]);
    const client = new SocketApiClient();
    let interrupted = false;
    let child: ReturnType<typeof spawn> | undefined;
    // While it waits, a signal ends the wait (its place in line is kept); while the command
    // runs, the signal goes to it and its end frees the slot.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, () => {
        interrupted = true;
        child?.kill(signal);
      });
    }
    code = await runCheckSlotCli(process.argv.slice(3), {
      task: (op, args) => client.task(op, args),
      env: process.env,
      cwd: process.cwd(),
      pid: process.pid,
      ppid: process.ppid,
      out: (text) => console.log(text),
      err: (text) => console.error(text),
      interrupted: () => interrupted,
      spawn: (argv, env) =>
        new Promise((resolve) => {
          child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env });
          child.on('error', (error) => {
            console.error(`Error: could not run ${argv[0]}: ${error.message}`);
            resolve(127);
          });
          child.on('exit', (exitCode, signal) =>
            resolve(exitCode ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0))
          );
        }),
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
  closeLogger();
  await exitAfterFlush(code);
}

/**
 * Start the Untether server with optional startup logging
 */
function handleStartServer(): void {
  // Show startup message at INFO level or when debug is enabled
  if (verbosityLevel !== undefined && verbosityLevel >= VerbosityLevel.INFO) {
    logger.log('Starting Untether server...');
  }
  startUntetherServer();
}

/**
 * Parse command line arguments and execute appropriate action
 */
async function parseCommandAndExecute(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'version':
      printVersion();
      process.exit(0);
      break;

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      process.exit(0);
      break;

    case 'fwd':
      await handleForwardCommand();
      break;

    case 'status':
    case 'follow':
    case 'unfollow':
    case 'open':
    case 'git-event':
      await handleSocketCommand(command);
      break;

    case 'task':
    case 'project':
      await handleTaskCommand(command);
      break;

    case 'events':
      await handleEventsCommand();
      break;

    case 'check-slot':
      await handleCheckSlotCommand();
      break;

    case 'diag': // its own module (server/diag-cli.ts)
      return (await import('./server/diag-cli.js')).handleDiagCommand();

    case 'doctor': // its own module (server/doctor-cli.ts)
      return (await import('./server/doctor-cli.js')).handleDoctorCommand();

    default:
      // No command provided - start the server
      handleStartServer();
      break;
  }
}

/**
 * Check if this module is being run directly (not imported)
 */
function isMainModule(): boolean {
  return (
    require.main === module ||
    require.main === undefined ||
    (require.main?.filename?.endsWith('/untether') ?? false)
  );
}

// Main execution
if (isMainModule()) {
  parseCommandAndExecute().catch((error) => {
    logger.error('Unhandled error in main execution:', error);
    if (error instanceof Error) {
      logger.error('Stack trace:', error.stack);
    }
    closeLogger();
    process.exit(1);
  });
}

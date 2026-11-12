import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { colors } from './colors.js';

/**
 * Where this server logs: next to its control directory, like previews.json. Every server
 * used ~/.untether/log.txt and deleted it on start, so each throwaway test server (agents,
 * the QA server on 4030) wiped the real server's log (2026-10-03).
 * ~/.untether/control → ~/.untether/log.txt (unchanged); ~/.untether-qa/control →
 * ~/.untether-qa/log.txt; a control dir not named "control" (mktemp) keeps it inside.
 */
export function defaultLogFile(
  controlDir: string | undefined = process.env.UNTETHER_CONTROL_DIR,
  home: string = os.homedir()
): string {
  if (!controlDir) return path.join(home, '.untether', 'log.txt');
  const resolved = path.resolve(controlDir);
  const dir = path.basename(resolved) === 'control' ? path.dirname(resolved) : resolved;
  return path.join(dir, 'log.txt');
}

let LOG_FILE = defaultLogFile();
const LOG_DIR = path.dirname(LOG_FILE);

/** The file this server is logging to (the /logs viewer reads the same one). */
export function getLogFilePath(): string {
  return LOG_FILE;
}

/**
 * Set custom log file path
 */
export function setLogFilePath(filePath: string): void {
  closeLogFile();
  loggerClosing = false;
  closeAfterRotation = false;
  pendingFileWrites = [];
  rotationPromise = null;

  LOG_FILE = filePath;

  // Ensure directory exists
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  openLogFile();
}

// Verbosity levels
export enum VerbosityLevel {
  SILENT = 0, // No console output (logs to file only)
  ERROR = 1, // Errors only (default)
  WARN = 2, // Errors and warnings
  INFO = 3, // Errors, warnings, and info
  VERBOSE = 4, // All except debug
  DEBUG = 5, // Everything
}

/**
 * Type-safe mapping of string names to verbosity levels
 */
export const VERBOSITY_MAP: Record<string, VerbosityLevel> = {
  silent: VerbosityLevel.SILENT,
  error: VerbosityLevel.ERROR,
  warn: VerbosityLevel.WARN,
  info: VerbosityLevel.INFO,
  verbose: VerbosityLevel.VERBOSE,
  debug: VerbosityLevel.DEBUG,
} as const;

// Current verbosity level
// Default to ERROR for production
let verbosityLevel: VerbosityLevel = VerbosityLevel.ERROR;

// Debug mode flag (kept for backward compatibility)
let _debugMode = false;

/**
 * Type guard to check if a string is a valid VerbosityLevel key
 */
export function isVerbosityLevel(value: string): value is keyof typeof VERBOSITY_MAP {
  return value.toLowerCase() in VERBOSITY_MAP;
}

/**
 * Parse a string to VerbosityLevel, returns undefined if invalid
 */
export function parseVerbosityLevel(value: string): VerbosityLevel | undefined {
  const normalized = value.toLowerCase();
  return VERBOSITY_MAP[normalized];
}

// File handle for log file
let logFileHandle: fs.WriteStream | null = null;
let bytesWritten = 0;
/**
 * Only the server rotates the log. `ut` client commands append to the same file: when each
 * process rotated on its own, two crossing 50 MB together renamed twice and the second
 * rename threw away the backup the first had just made (found in review, 2026-10-03).
 */
let rotationAllowed = true;
let loggerGeneration = 0;
let loggerClosing = false;
let closeAfterRotation = false;
let pendingFileWrites: string[] = [];
let rotationPromise: Promise<void> | null = null;
let closePromise: Promise<void> | null = null;
const MAX_LOG_SIZE = 50 * 1024 * 1024;

function getLogFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function openLogFile(
  filePath: string = LOG_FILE,
  generation: number = loggerGeneration,
  initialSize: number = getLogFileSize(filePath)
): void {
  try {
    // Owner only when created (2026-10-04): it survives restarts and holds DEBUG lines and
    // client error messages; the umask usually made it world-readable (0644).
    const handle = fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 });
    handle.on('error', () => {
      if (generation === loggerGeneration && logFileHandle === handle) {
        logFileHandle = null;
      }
    });

    if (generation !== loggerGeneration || loggerClosing) {
      handle.end();
      return;
    }

    logFileHandle = handle;
    bytesWritten = initialSize;
  } catch {
    logFileHandle = null;
  }
}

function rotateLogFile(): void {
  if (!logFileHandle || rotationPromise || loggerClosing) {
    return;
  }

  const handle = logFileHandle;
  const logPath = LOG_FILE;
  const generation = loggerGeneration;
  logFileHandle = null;
  let ownInode: number | null = null;
  try {
    const fd = (handle as fs.WriteStream & { fd?: number }).fd;
    if (typeof fd === 'number') ownInode = fs.fstatSync(fd).ino;
  } catch {
    ownInode = null;
  }

  const rotation = new Promise<void>((resolve) => {
    handle.once('close', () => {
      try {
        // Rotate only the file we filled: if another process already moved it aside (or it
        // shrank), renaming again would replace that fresh backup with a near-empty file.
        const onDisk = fs.existsSync(logPath) ? fs.statSync(logPath) : null;
        const stillOurs =
          onDisk !== null &&
          onDisk.size >= MAX_LOG_SIZE &&
          (ownInode === null || onDisk.ino === ownInode);
        if (stillOurs) {
          const backupPath = `${logPath}.1`;
          if (fs.existsSync(backupPath)) {
            fs.unlinkSync(backupPath);
          }
          fs.renameSync(logPath, backupPath);
        }
      } catch {
        // Retry after another 50 MB rather than interrupting logging.
      }
      resolve();
    });
    handle.end();
  });

  rotationPromise = rotation;
  void rotation.finally(() => {
    if (rotationPromise === rotation) {
      rotationPromise = null;
    }
    if (generation !== loggerGeneration || loggerClosing) {
      return;
    }

    openLogFile(logPath, generation);
    const queuedWrites = pendingFileWrites;
    pendingFileWrites = [];
    for (const output of queuedWrites) {
      writeOutput(output, true);
    }

    if (closeAfterRotation && !rotationPromise) {
      closeAfterRotation = false;
      closeLogFile();
    }
  });
}

/**
 * The log file at our path may be deleted or replaced under us: the old Untether CLI inside
 * the Mac app (`ut status`, `ut title`, `ut` sessions…) deletes ~/.untether/log.txt every time
 * it runs, and we kept writing into the unlinked file while log.txt stayed empty (2026-10-03).
 * At most every 5 s, compare our open file with the one at the path and reopen if they differ.
 */
let lastLogIdentityCheck = 0;
const LOG_IDENTITY_CHECK_MS = 5000;
function reopenLogIfReplaced(): void {
  const now = Date.now();
  if (!logFileHandle || rotationPromise || loggerClosing) return;
  if (now - lastLogIdentityCheck < LOG_IDENTITY_CHECK_MS) return;
  lastLogIdentityCheck = now;
  const fd = (logFileHandle as fs.WriteStream & { fd?: number }).fd;
  if (typeof fd !== 'number') return;
  try {
    const open = fs.fstatSync(fd);
    let onDisk: fs.Stats | null = null;
    try {
      onDisk = fs.statSync(LOG_FILE);
    } catch {
      onDisk = null;
    }
    if (onDisk && onDisk.ino === open.ino && onDisk.dev === open.dev) {
      // Client commands append to this file too: count their lines toward the rotation size.
      bytesWritten = Math.max(bytesWritten, open.size);
      return;
    }
  } catch {
    return;
  }
  const stale = logFileHandle;
  logFileHandle = null;
  stale.end();
  openLogFile(LOG_FILE, loggerGeneration, getLogFileSize(LOG_FILE));
}

/** Tests: run the replaced-file check on the next write. */
export function checkLogFileOnNextWriteForTests(): void {
  lastLogIdentityCheck = 0;
}

function writeOutput(output: string, allowWhileClosing: boolean = false): void {
  if (loggerClosing || (closeAfterRotation && !allowWhileClosing)) {
    return;
  }

  if (rotationPromise) {
    pendingFileWrites.push(output);
    return;
  }
  reopenLogIfReplaced();
  if (!logFileHandle) {
    return;
  }

  const outputBytes = Buffer.byteLength(output, 'utf8');
  try {
    logFileHandle.write(output);
    bytesWritten += outputBytes;
    if (bytesWritten >= MAX_LOG_SIZE && rotationAllowed) {
      rotateLogFile();
    }
  } catch {
    // Silently ignore file write errors.
  }
}

function closeLogFile(): void {
  loggerClosing = true;
  loggerGeneration += 1;
  closeAfterRotation = false;
  pendingFileWrites = [];
  rotationPromise = null;
  bytesWritten = 0;
  if (logFileHandle) {
    const handle = logFileHandle;
    logFileHandle = null;
    const closing = new Promise<void>((resolve) => {
      if (handle.closed) {
        resolve();
        return;
      }
      handle.once('close', resolve);
      handle.end();
    });
    closePromise = closing;
    void closing.finally(() => {
      if (closePromise === closing) {
        closePromise = null;
      }
    });
  }
}

// ANSI color codes for stripping from file output
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require control characters
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Initialize the logger - creates log directory and file
 */
export function initLogger(
  debug: boolean = false,
  verbosity?: VerbosityLevel,
  /**
   * Only the server starts a fresh log. `ut open`, `ut status`, `ut fwd`… run while the
   * server is up: deleting the file under it left the server writing into an unlinked file
   * and an empty log.txt on disk (2026-10-03).
   */
  options: { fresh?: boolean } = {}
): void {
  _debugMode = debug;
  loggerClosing = false;
  closeAfterRotation = false;
  rotationAllowed = options.fresh !== false;

  // Set verbosity level
  if (verbosity !== undefined) {
    verbosityLevel = verbosity;
  } else if (debug) {
    // If debug mode is enabled, set verbosity to DEBUG
    verbosityLevel = VerbosityLevel.DEBUG;
  }

  // If already initialized, just update debug mode and return
  if (logFileHandle) {
    return;
  }

  try {
    // Ensure log directory exists
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    // A server start keeps the earlier runs below a marker line. Deleting the log on start
    // threw away whatever happened just before each restart, a deploy included (2026-10-03);
    // the 50 MB rotation keeps it bounded. Client commands just append.
    openLogFile(LOG_FILE, loggerGeneration);
    if (options.fresh !== false) {
      writeOutput(`${new Date().toISOString()} ===== server start (pid ${process.pid}) =====\n`);
    }
  } catch (error) {
    // Don't throw, just log to console
    console.error('Failed to initialize log file:', error);
  }
}

/**
 * Flush the log file buffer
 */
export function flushLogger(): Promise<void> {
  if (rotationPromise) {
    return rotationPromise.then(() => flushLogger());
  }
  if (closePromise) {
    return closePromise.then(() => flushLogger());
  }

  return new Promise((resolve) => {
    if (logFileHandle && !logFileHandle.destroyed) {
      // Force a write of any buffered data
      logFileHandle.write('', () => {
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * Close the logger
 */
export function closeLogger(): void {
  if (rotationPromise) {
    closeAfterRotation = true;
    return;
  }
  closeLogFile();
}

/**
 * Format log message with timestamp
 */
function formatMessage(
  level: string,
  module: string,
  args: unknown[]
): { console: string; file: string } {
  const timestamp = new Date().toISOString();

  // Format arguments
  const message = args
    .map((arg) => {
      if (arg instanceof Error) {
        return arg.stack || `${arg.name}: ${arg.message}`;
      }
      if (typeof arg === 'object') {
        try {
          // Use JSON.stringify with 2-space indent for objects
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(' ');

  // Console format with colors
  const stream = level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout;
  let consoleFormat: string;
  const moduleColor = colors.cyan(`[${module}]`, stream);
  const timestampColor = colors.gray(timestamp, stream);

  switch (level) {
    case 'ERROR':
      consoleFormat = `${timestampColor} ${colors.red(level, stream)} ${moduleColor} ${colors.red(message, stream)}`;
      break;
    case 'WARN':
      consoleFormat = `${timestampColor} ${colors.yellow(level, stream)}  ${moduleColor} ${colors.yellow(message, stream)}`;
      break;
    case 'DEBUG':
      consoleFormat = `${timestampColor} ${colors.magenta(level, stream)} ${moduleColor} ${colors.gray(message, stream)}`;
      break;
    default: // LOG
      consoleFormat = `${timestampColor} ${colors.green(level, stream)}   ${moduleColor} ${message}`;
  }

  // File format (no colors)
  const fileFormat = `${timestamp} ${level.padEnd(5)} [${module}] ${message}`;

  return { console: consoleFormat, file: fileFormat };
}

/**
 * Write to log file
 */
function writeToFile(message: string): void {
  const cleanMessage = message.replace(ANSI_PATTERN, '');
  writeOutput(`${cleanMessage}\n`);
}

/**
 * Enable or disable debug mode
 */
export function setDebugMode(enabled: boolean): void {
  _debugMode = enabled;
  // If enabling debug mode, also set verbosity to DEBUG
  if (enabled) {
    verbosityLevel = VerbosityLevel.DEBUG;
  }
}

/**
 * Set verbosity level
 */
export function setVerbosityLevel(level: VerbosityLevel): void {
  verbosityLevel = level;
  // Update debug mode flag for backward compatibility
  _debugMode = level >= VerbosityLevel.DEBUG;
}

/**
 * Get current verbosity level
 */
export function getVerbosityLevel(): VerbosityLevel {
  return verbosityLevel;
}

/**
 * Check if debug logging is enabled
 */
export function isDebugEnabled(): boolean {
  return verbosityLevel >= VerbosityLevel.DEBUG;
}

/**
 * Check if verbose logging is enabled
 */
export function isVerbose(): boolean {
  return verbosityLevel >= VerbosityLevel.VERBOSE;
}

/**
 * Check if a log level should be output based on current verbosity
 */
function shouldLog(level: string): boolean {
  switch (level) {
    case 'ERROR':
      return verbosityLevel >= VerbosityLevel.ERROR;
    case 'WARN':
      return verbosityLevel >= VerbosityLevel.WARN;
    case 'LOG':
      return verbosityLevel >= VerbosityLevel.INFO;
    case 'DEBUG':
      return verbosityLevel >= VerbosityLevel.DEBUG;
    default:
      return true;
  }
}

/**
 * DEBUG lines reach the log file only when debug verbosity is on (--verbosity debug,
 * UNTETHER_LOG_LEVEL=debug, UNTETHER_DEBUG=1) or UNTETHER_LOG_FILE_DEBUG=1 asks
 * for file-only debug without console noise. LOG/WARN/ERROR are always written.
 *
 * 2026-10-02: DEBUG used to be formatted and written to ~/.untether/log.txt at every
 * verbosity, which made debug-heavy paths (per-request, per-poll, per-socket) pay
 * JSON.stringify + a file write in production and filled the 50 MB rotation fast.
 */
function shouldWriteDebugToFile(): boolean {
  if (verbosityLevel >= VerbosityLevel.DEBUG) return true;
  const flag = process.env.UNTETHER_LOG_FILE_DEBUG;
  return flag === '1' || flag === 'true';
}

/**
 * Log from a specific module (used by client-side API)
 */
export function logFromModule(level: string, module: string, args: unknown[]): void {
  if (level === 'DEBUG' && !shouldWriteDebugToFile() && !shouldLog(level)) return;
  const { console: consoleMsg, file: fileMsg } = formatMessage(level, module, args);

  // LOG/WARN/ERROR always reach the file; DEBUG only when enabled.
  if (level !== 'DEBUG' || shouldWriteDebugToFile()) writeToFile(fileMsg);

  // Check if we should output to console based on verbosity
  if (!shouldLog(level)) return;

  // Log to console
  switch (level) {
    case 'ERROR':
      console.error(consoleMsg);
      break;
    case 'WARN':
      console.warn(consoleMsg);
      break;
    default:
      console.log(consoleMsg);
  }
}

/**
 * Create a logger for a specific module
 * This is the main factory function that should be used
 */
export function createLogger(moduleName: string) {
  // Add [SRV] prefix to server-originated logs unless it already has a prefix
  const prefixedModuleName = moduleName.startsWith('[') ? moduleName : `[SRV] ${moduleName}`;

  return {
    /**
     * @deprecated Use info() instead for clarity
     */
    log: (...args: unknown[]) => {
      const { console: consoleMsg, file: fileMsg } = formatMessage('LOG', prefixedModuleName, args);
      writeToFile(fileMsg); // Always write to file
      if (shouldLog('LOG')) {
        console.log(consoleMsg);
      }
    },
    info: (...args: unknown[]) => {
      const { console: consoleMsg, file: fileMsg } = formatMessage('LOG', prefixedModuleName, args);
      writeToFile(fileMsg); // Always write to file
      if (shouldLog('LOG')) {
        console.log(consoleMsg);
      }
    },
    warn: (...args: unknown[]) => {
      const { console: consoleMsg, file: fileMsg } = formatMessage(
        'WARN',
        prefixedModuleName,
        args
      );
      writeToFile(fileMsg); // Always write to file
      if (shouldLog('WARN')) {
        console.warn(consoleMsg);
      }
    },
    error: (...args: unknown[]) => {
      const { console: consoleMsg, file: fileMsg } = formatMessage(
        'ERROR',
        prefixedModuleName,
        args
      );
      writeToFile(fileMsg); // Always write to file
      if (shouldLog('ERROR')) {
        console.error(consoleMsg);
      }
    },
    debug: (...args: unknown[]) => {
      // Skip formatting (JSON.stringify of objects, colors) when nothing will print.
      if (!shouldWriteDebugToFile() && !shouldLog('DEBUG')) return;
      const { console: consoleMsg, file: fileMsg } = formatMessage(
        'DEBUG',
        prefixedModuleName,
        args
      );
      if (shouldWriteDebugToFile()) writeToFile(fileMsg);
      if (shouldLog('DEBUG')) {
        console.log(consoleMsg);
      }
    },
    setDebugMode: (enabled: boolean) => setDebugMode(enabled),
    setVerbosity: (level: VerbosityLevel) => setVerbosityLevel(level),
  };
}

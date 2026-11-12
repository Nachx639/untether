import { HttpMethod } from '../../shared/types.js';

interface LogLevel {
  log: 'log';
  warn: 'warn';
  error: 'error';
  debug: 'debug';
}

type LogMethod = (...args: unknown[]) => void;

interface Logger {
  log: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  debug: LogMethod;
}

let debugMode = false;
// On globalThis so a module reset (vi.resetModules) keeps the setting.
const SERVER_LOGGING_OFF = Symbol.for('untether.logger.serverLoggingOff');
type LoggingFlagHolder = { [SERVER_LOGGING_OFF]?: boolean };

// Auth config cache to reduce redundant requests
let authConfigCache: { noAuth: boolean; timestamp: number } | null = null;
const AUTH_CONFIG_TTL = 60000; // 1 minute
const AUTH_CONFIG_RETRY_MS = 5000; // after a failed lookup
let authConfigPending: Promise<boolean> | null = null;

/**
 * The server sink is quiet until this time. 2026-11-11: the server takes 120 lines a minute per
 * client (routes/logs.ts) and answers 429 with Retry-After beyond that, but every later line was
 * still posted: a full Playwright run made 17,635 refused requests, each one an error in the
 * browser's console. After a 429 nothing is sent until the time the server named.
 */
let serverSinkQuietUntil = 0;
const SERVER_SINK_QUIET_MS = 60_000;

/**
 * Enable or disable debug mode for all loggers
 * @param enabled - Whether to enable debug logging
 */
export function setDebugMode(enabled: boolean): void {
  debugMode = enabled;
}

/**
 * Turn the server sink (POST /api/logs/client and its /api/auth/config lookup) on or off.
 * Client tests turn it off in src/test/setup.ts: under load its late dynamic import added
 * an /api/auth/config call to tests counting their own fetch calls (2026-11-02).
 */
export function setServerLogging(enabled: boolean): void {
  (globalThis as LoggingFlagHolder)[SERVER_LOGGING_OFF] = !enabled;
}

/**
 * Clear the auth config cache (mainly for testing)
 */
export function clearAuthConfigCache(): void {
  authConfigCache = null;
  authConfigPending = null;
  serverSinkQuietUntil = 0;
}

/**
 * Get cached auth configuration or fetch it
 * @returns Whether no-auth mode is enabled
 */
async function getAuthConfig(): Promise<boolean> {
  const now = Date.now();

  // Return cached value if still valid
  if (authConfigCache && now - authConfigCache.timestamp < AUTH_CONFIG_TTL) {
    return authConfigCache.noAuth;
  }

  // One lookup for every line logged meanwhile; a failure is remembered for a moment (with the
  // server down, every log line asked again, 2026-11-10).
  authConfigPending ??= fetchAuthConfig(now).finally(() => {
    authConfigPending = null;
  });
  return authConfigPending;
}

async function fetchAuthConfig(now: number): Promise<boolean> {
  try {
    const configResponse = await fetch('/api/auth/config');
    if (configResponse.ok) {
      const authConfig = await configResponse.json();
      authConfigCache = { noAuth: authConfig.noAuth === true, timestamp: now };
      return authConfigCache.noAuth;
    }
  } catch {
    // Ignore auth config fetch errors
  }
  authConfigCache = { noAuth: false, timestamp: now - AUTH_CONFIG_TTL + AUTH_CONFIG_RETRY_MS };
  return false;
}

// Normalize separators so camelCase, snake_case and HTTP header names are covered.
const SENSITIVE_FIELD =
  /(?:token|password|passphrase|secret|privatekey|authorization|cookie|apikey|credentials?|signature)$/i;

function redactLogValue(key: string, value: unknown): unknown {
  if (SENSITIVE_FIELD.test(key.replace(/[-_]/g, ''))) return '[REDACTED]';
  if (typeof value === 'string') {
    return value.replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/-]+=*/gi, '$1 [REDACTED]');
  }
  return value;
}

/** Create sanitized snapshots before either logging sink sees the arguments. */
function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    // An Error's fields aren't enumerable: JSON gave "{}" and the server log showed
    // "error loading sessions: {}" with no way to tell what failed (2026-10-03).
    if (arg instanceof Error) {
      return redactLogValue(
        '',
        `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack.split('\n').slice(1, 4).join('\n')}` : ''}`
      );
    }
    if (typeof arg === 'object' && arg !== null) {
      try {
        // Keep console objects inspectable without mutating credentials used by the app.
        return JSON.parse(JSON.stringify(arg, redactLogValue));
      } catch {
        // A custom toString can expose credentials too; never fall back to the original.
        return '[object Object]';
      }
    }
    return redactLogValue('', arg);
  });
}

/** Format sanitized objects as strings to match server logger behavior. */
function formatArgs(args: unknown[]): unknown[] {
  return args.map((arg) =>
    typeof arg === 'object' && arg !== null ? JSON.stringify(arg, null, 2) : arg
  );
}

/**
 * Send log to server endpoint
 */
async function sendToServer(level: keyof LogLevel, module: string, args: unknown[]): Promise<void> {
  if (Date.now() < serverSinkQuietUntil) return;
  try {
    // Import authClient singleton dynamically to avoid circular dependencies
    const { authClient } = await import('../services/auth-client.js');

    // Check if we have authentication before sending logs
    const authHeader = authClient.getAuthHeader();

    // Check if no-auth mode is enabled (cached)
    const isNoAuthMode = await getAuthConfig();

    // Skip sending logs if not authenticated AND not in no-auth mode
    if (!authHeader.Authorization && !isNoAuthMode) {
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Only add auth header if we have one
    if (authHeader.Authorization) {
      headers.Authorization = authHeader.Authorization;
    }

    // Lines that waited for the lookups above while a 429 arrived.
    if (Date.now() < serverSinkQuietUntil) return;
    const response = await fetch('/api/logs/client', {
      method: HttpMethod.POST,
      headers,
      body: JSON.stringify({
        level,
        module,
        args: formatArgs(args),
      }),
    });
    if (response?.status === 429) {
      const retryAfterSec = Number(response.headers?.get('Retry-After'));
      serverSinkQuietUntil =
        Date.now() + (retryAfterSec > 0 ? retryAfterSec * 1000 : SERVER_SINK_QUIET_MS);
    }
  } catch {
    // Silently ignore network errors to avoid infinite loops
  }
}

/**
 * Creates a logger instance for a specific module
 * @param moduleName - The name of the module for log context
 * @returns Logger instance with log, warn, error, and debug methods
 */
export function createLogger(moduleName: string): Logger {
  const createLogMethod = (level: keyof LogLevel): LogMethod => {
    return (...args: unknown[]) => {
      // Skip debug logs if debug mode is disabled
      if (level === 'debug' && !debugMode) return;

      const sanitizedArgs = sanitizeArgs(args);

      // Log to browser console
      console[level](`[${moduleName}]`, ...sanitizedArgs);

      // Send to server (fire and forget)
      if (!(globalThis as LoggingFlagHolder)[SERVER_LOGGING_OFF])
        sendToServer(level, moduleName, sanitizedArgs);
    };
  };

  return {
    log: createLogMethod('log'),
    warn: createLogMethod('warn'),
    error: createLogMethod('error'),
    debug: createLogMethod('debug'),
  };
}

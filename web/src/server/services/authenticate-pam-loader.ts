import * as fs from 'fs';
import * as path from 'path';

export type AuthenticateFunction = (
  username: string,
  password: string,
  callback: (err: Error | null, authenticated?: boolean) => void
) => void;

// Helper function to load native module using dlopen
function loadNativeModule(modulePath: string): { authenticate?: AuthenticateFunction } {
  const module = { exports: {} };
  process.dlopen(module, modulePath);
  return module.exports;
}

/** The first of `candidates` that is there and loads; throws saying why each did not. */
function loadFirst(candidates: string[]): AuthenticateFunction {
  const errors: string[] = [];
  for (const modulePath of candidates) {
    if (!fs.existsSync(modulePath)) continue;
    try {
      const nativeModule = loadNativeModule(modulePath);
      if (nativeModule.authenticate) return nativeModule.authenticate;
      errors.push(`${modulePath}: it does not export authenticate`);
    } catch (error) {
      errors.push(`${modulePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join('; ') || 'authenticate_pam.node was not found');
}

/** Loads authenticate-pam from wherever this build keeps it; throws with the reason. */
function loadAuthenticatePam(): AuthenticateFunction {
  // Check if we're in SEA mode by looking for the native module next to the executable
  const execDir = path.dirname(process.execPath);
  const seaPamPath = path.join(execDir, 'authenticate_pam.node');
  const seaNativePamPath = path.join(execDir, 'native', 'authenticate_pam.node');

  if (fs.existsSync(seaPamPath) || fs.existsSync(seaNativePamPath)) {
    return loadFirst([
      seaPamPath,
      seaNativePamPath,
      // Try different parent levels for native directory
      ...[1, 2, 3].map((levels) =>
        path.join(__dirname, ...Array(levels).fill('..'), 'native', 'authenticate_pam.node')
      ),
    ]);
  }

  // Development mode - use regular require
  let requireError: unknown;
  try {
    const pamModule = require('authenticate-pam');
    // Handle both direct export and default export cases
    return pamModule.authenticate || pamModule.default || pamModule;
  } catch (error) {
    requireError = error;
  }

  // If normal require failed, try the optional-modules location:
  // 1 level up: bundled context (dist-npm/lib/)
  // 3 levels up: development context (src/server/services/)
  // 2 levels up: alternative bundled location
  try {
    return loadFirst(
      [1, 3, 2].map((levels) =>
        path.join(
          __dirname,
          ...Array(levels).fill('..'),
          'optional-modules',
          'authenticate-pam',
          'build',
          'Release',
          'authenticate_pam.node'
        )
      )
    );
  } catch {
    throw requireError instanceof Error ? requireError : new Error(String(requireError));
  }
}

/**
 * `authenticate` over a loader that may fail, and whether the module is loaded.
 *
 * 2026-11-12: the module was loaded once, when the server started, and a failure left a stub
 * for the life of the process with "native module not found" as the only trace. An app build
 * left authenticate-pam built for another Node; the server restarted meanwhile and password
 * login stayed gone after the module was rebuilt, until someone restarted the server again.
 * A module that did not load is now tried again at the next login (at most once every
 * `retryMs`), and the reason it did not load is kept and said.
 */
export function createPamAuthenticate(deps: {
  load: () => AuthenticateFunction;
  now?: () => number;
  retryMs?: number;
  warn?: (message: string) => void;
}): { authenticate: AuthenticateFunction; status: () => { loaded: boolean; error?: string } } {
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? 5000;
  let loaded: AuthenticateFunction | undefined;
  let error: string | undefined;
  let triedAt = Number.NEGATIVE_INFINITY;
  const tryLoad = () => {
    if (loaded || now() - triedAt < retryMs) return;
    triedAt = now();
    try {
      loaded = deps.load();
      error = undefined;
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      if (message !== error) {
        deps.warn?.(
          `Warning: authenticate-pam native module did not load; password login will not work until it does: ${message.replace(/\s+/g, ' ').slice(0, 800)}`
        );
      }
      error = message;
    }
  };
  tryLoad();
  return {
    authenticate: (username, password, callback) => {
      tryLoad();
      if (loaded) loaded(username, password, callback);
      else callback(new Error('PAM authentication not available'));
    },
    status: () => {
      tryLoad();
      return loaded ? { loaded: true } : { loaded: false, error };
    },
  };
}

const pam = createPamAuthenticate({
  load: loadAuthenticatePam,
  warn: (message) => console.warn(message),
});

export const authenticate = pam.authenticate;
/** Whether authenticate-pam is loaded in this process, and why not. */
export const pamStatus = pam.status;

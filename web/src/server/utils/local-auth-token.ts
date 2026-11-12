/**
 * The token that lets the Mac app skip the login on localhost (X-Untether-Local header).
 *
 * 2026-10-27 (security sweep): the app passed it as `--local-auth-token <token>`, so anyone on
 * the Mac (another user, an unprivileged process) read it with `ps -ww` and got a shell through
 * 127.0.0.1. It now arrives in UNTETHER_LOCAL_AUTH_TOKEN: macOS shows a process's environment
 * only to its own user. The server takes it out of its own environment at startup, so nothing
 * it spawns inherits it. Local command-line clients (`ut`) never need it: they talk to the
 * server over ~/.untether/api.sock, readable by its owner only.
 */
export const LOCAL_AUTH_TOKEN_ENV = 'UNTETHER_LOCAL_AUTH_TOKEN';

/** Reads the token from `env` and removes it there; null when it is missing or empty. */
export function takeLocalAuthToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env[LOCAL_AUTH_TOKEN_ENV]?.trim() || null;
  delete env[LOCAL_AUTH_TOKEN_ENV];
  return token;
}

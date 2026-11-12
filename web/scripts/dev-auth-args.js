/**
 * Auth flags dev.js adds to the server command line.
 *
 * Plain `pnpm run dev` (no server arguments) stays open for local hacking: --no-auth, bound to
 * 127.0.0.1 so only this computer can reach it. Anything
 * that passes server arguments owns auth. The Mac app always passes --port and, in its "none"
 * mode, --no-auth itself; in password mode (the default) it passes no auth flag at all.
 *
 * 2026-10-02: dev.js forced --no-auth whatever the app asked, giving anyone who could reach the
 * port a shell. 2026-10-04: the first fix only kept auth when it saw one of a few auth flags, so
 * the app in password mode without a local token still got --no-auth.
 */
function devServerAuthArgs(serverArgs) {
  const given = serverArgs.filter((arg) => arg !== '--');
  // 2026-10-20 (security audit): plain `pnpm run dev` listened on 0.0.0.0 with --no-auth, a
  // shell for anyone on the network. The open dev server is loopback only.
  return given.length === 0 ? ['--no-auth', '--bind', '127.0.0.1'] : [];
}

const LOCAL_AUTH_TOKEN_ENV = 'UNTETHER_LOCAL_AUTH_TOKEN';

/**
 * Takes `--local-auth-token <token>` (or `=token`) out of the server arguments and puts the
 * token in `env`, which dev.js hands to `tsx watch`.
 *
 * 2026-10-27 (security sweep): the token in argv showed to every user of the Mac in `ps`. The
 * Mac app now passes UNTETHER_LOCAL_AUTH_TOKEN; an app built before that still passes the
 * argument, and this keeps it off the tsx and server command lines until it is rebuilt.
 * `tsx watch` keeps the variable, so each reloaded server gets it again; the server removes
 * it from its own environment (src/server/utils/local-auth-token.ts).
 */
function moveLocalAuthTokenToEnv(serverArgs, env) {
  const rest = [];
  for (let i = 0; i < serverArgs.length; i++) {
    const arg = serverArgs[i];
    if (arg === '--local-auth-token') {
      if (i + 1 < serverArgs.length) env[LOCAL_AUTH_TOKEN_ENV] = serverArgs[++i];
    } else if (arg.startsWith('--local-auth-token=')) {
      env[LOCAL_AUTH_TOKEN_ENV] = arg.slice('--local-auth-token='.length);
    } else {
      rest.push(arg);
    }
  }
  return rest;
}

module.exports = { devServerAuthArgs, moveLocalAuthTokenToEnv, LOCAL_AUTH_TOKEN_ENV };

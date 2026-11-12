import { LOCAL_AUTH_TOKEN_ENV } from './local-auth-token.js';

/**
 * Environment for a new terminal session.
 *
 * 2026-10-02: an Untether server started from inside Claude Code (an agent, or `open -a`
 * from its shell) passed Claude Code's own session variables to every terminal. A `claude`
 * started there then believed it was a child session: no ~/.claude/sessions entry, no
 * transcript ("Transcript saving is off"), and the chat view/status badges found nothing.
 * These variables identify the launching Claude Code process and never belong to a new
 * terminal; user configuration (ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK, ...) is kept.
 */
const INHERITED_CLAUDE_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  // Exported next to the token (2026-10-04).
  'CLAUDE_CODE_MESSAGING_SOCKET',
  // An OAuth token handed to the launching process (an SDK host, a bot): a session's own
  // `claude` must use the user's login, not borrow that identity.
  'ANTHROPIC_OAUTH_TOKEN',
  // A task's marker (task-processes.ts) is the session's own, never the launching process's: a
  // server started inside a task would mark every session as that task's (2026-11-02).
  'UNTETHER_TASK_ID',
];

/**
 * The server's own secrets never reach a session: any program run there (an install script,
 * an agent) could read them. UNTETHER_PASSWORD (the env alternative to --password) logs in
 * from elsewhere (2026-10-03); JWT_SECRET signs Untether tokens, so it mints a login for
 * anyone; NGROK_AUTHTOKEN is the operator's ngrok account (2026-10-04). Shielded sessions also
 * write the session environment to their tmux job's plist. Defense in depth: a session runs
 * as the same user, who can still read the persisted JWT secret file.
 * UNTETHER_LOCAL_AUTH_TOKEN skips the login on localhost (utils/local-auth-token.ts,
 * 2026-10-27); the server removes it from its own environment too.
 */
const SERVER_SECRET_VARS = [
  'UNTETHER_PASSWORD',
  'JWT_SECRET',
  'NGROK_AUTHTOKEN',
  LOCAL_AUTH_TOKEN_ENV,
];

/**
 * What the server's own runtime set for itself: never part of a session's environment.
 *
 * 2026-10-24: the dev server (`pnpm dev`) handed every session NODE_ENV=development, NODE_PATH
 * into Untether's node_modules, NODE_OPTIONS and the npm_/PNPM_ variables of its script, the
 * shield tmux server kept them as its global environment, and every task's Claude inherited
 * them: `vite build` in another project bundled React the development way (340 kB) and a
 * forced build would not start. npm_lifecycle_script also carried the server's
 * --local-auth-token. A login shell sets back whatever the user's own profile exports.
 *
 * 2026-11-12: COREPACK_ROOT, which corepack sets for the pnpm it starts (the dev server's), went
 * on to every check. A Node installed that night had no pnpm of its own, so the check's `pnpm`
 * was a plain one (12.16.1), which took the variable for "corepack started me", refused to
 * switch to the project's version and failed every check with ERR_PNPM_BAD_PM_VERSION. The
 * COREPACK_ENABLE_* switches are the user's own settings and stay.
 */
const SERVER_RUNTIME_VARS = [
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE',
  'INIT_CWD',
  'TSX_TSCONFIG_PATH',
  'COREPACK_ROOT',
];
const SERVER_RUNTIME_PREFIXES = ['npm_', 'NPM_', 'PNPM_', 'pnpm_'];

export function isServerRuntimeVar(key: string): boolean {
  return (
    SERVER_RUNTIME_VARS.includes(key) ||
    SERVER_RUNTIME_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/** `env` without the server's runtime variables: for programs run in a user's project. */
export function withoutServerRuntime(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isServerRuntimeVar(key)) out[key] = value;
  }
  return out;
}

export function terminalSessionEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      value !== undefined &&
      !INHERITED_CLAUDE_SESSION_VARS.includes(key) &&
      !SERVER_SECRET_VARS.includes(key) &&
      !isServerRuntimeVar(key)
    ) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

/**
 * The agent's own login: kept so a security sweep's agent can still work (2026-10-23). The
 * agent holds it anyway; everything else that looks like a credential goes.
 */
const AGENT_LOGIN_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_HOME',
];

/** Names that hold credentials: tokens, keys, secrets, passwords, cookies, connection URLs. */
const SECRET_NAME =
  /(TOKEN|SECRET|PASSW(OR)?D|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|COOKIE|SESSION_?KEY|SIGNING|WEBHOOK|DSN|DATABASE_URL|_URI$|CONN(ECTION)?_?STR)/i;

/** A value that is a credential whatever its name (a provider's key prefix, a PEM block). */
const SECRET_VALUE =
  /^(gh[pousr]_|github_pat_|glpat-|xox[abposr]-|sk-[A-Za-z0-9]|sk_live_|rk_live_|AKIA[0-9A-Z]{12}|ASIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{20}|ya29\.|npm_[A-Za-z0-9]{20}|-----BEGIN)/;

/**
 * The environment of a security sweep's agent (2026-10-23): what terminalSessionEnv gives a
 * session, minus every variable that looks like a credential by name or by value, so an
 * agent reading attacked code never holds the user's tokens. Its own login stays.
 */
export function withoutSecrets(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!AGENT_LOGIN_VARS.includes(key) && (SECRET_NAME.test(key) || SECRET_VALUE.test(value))) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

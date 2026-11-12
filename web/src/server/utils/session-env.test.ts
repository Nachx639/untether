import { describe, expect, it } from 'vitest';
import { isServerRuntimeVar, terminalSessionEnv } from './session-env.js';

describe('terminalSessionEnv', () => {
  it("drops the launching Claude Code session's identity but keeps user configuration", () => {
    const env = terminalSessionEnv(
      {
        PATH: '/usr/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'abc',
        CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
        ANTHROPIC_OAUTH_TOKEN: 'launcher-token',
        ANTHROPIC_API_KEY: 'user-key',
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
      { TERM: 'xterm-256color', UNTETHER_SESSION_ID: 's1' }
    );

    expect(env).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'user-key',
      CLAUDE_CODE_USE_BEDROCK: '1',
      TERM: 'xterm-256color',
      UNTETHER_SESSION_ID: 's1',
    });
  });

  it("never passes the server's own runtime environment to a session (2026-10-24)", () => {
    // A task's `vite build` bundled React the development way: NODE_ENV=development came from
    // the dev server. npm_lifecycle_script also carried its --local-auth-token.
    const env = terminalSessionEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/me',
        NODE_ENV: 'development',
        NODE_OPTIONS: '--max-old-space-size=4096',
        NODE_PATH: '/repo/web/node_modules/.pnpm/node_modules',
        NODE: '/opt/homebrew/bin/node',
        INIT_CWD: '/repo/web',
        npm_lifecycle_script: 'node scripts/dev.js --local-auth-token x',
        npm_config_user_agent: 'pnpm/10',
        PNPM_SCRIPT_SRC_DIR: '/repo/web',
        pnpm_config_verify_deps_before_run: 'false',
        NODENAME: 'kept',
      },
      { TERM: 'xterm-256color', UNTETHER_SESSION_ID: 's1' }
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      NODENAME: 'kept',
      TERM: 'xterm-256color',
      UNTETHER_SESSION_ID: 's1',
    });
    expect(isServerRuntimeVar('NODE_ENV')).toBe(true);
    expect(isServerRuntimeVar('NODE_EXTRA_CA_CERTS')).toBe(false);
  });

  it('never passes on that corepack started the server (2026-11-12)', () => {
    // A plain pnpm (12.16.1) that finds COREPACK_ROOT takes itself for one corepack started and
    // refuses to switch to the project's version: every check failed with ERR_PNPM_BAD_PM_VERSION.
    const env = terminalSessionEnv(
      {
        PATH: '/usr/bin',
        COREPACK_ROOT: '/usr/local/lib/node_modules/corepack',
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      },
      {}
    );
    // The user's own corepack switches stay.
    expect(env).toEqual({ PATH: '/usr/bin', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' });
  });

  it('never passes the server’s login password to a session', () => {
    const env = terminalSessionEnv(
      { UNTETHER_PASSWORD: 'hunter2', UNTETHER_USERNAME: 'alice', PATH: '/usr/bin' },
      { TERM: 'xterm-256color' }
    );
    expect(env.UNTETHER_PASSWORD).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('never passes the token signing secret or the ngrok token to a session', () => {
    const env = terminalSessionEnv(
      { JWT_SECRET: 'f00d', NGROK_AUTHTOKEN: 'ngrok-token', PATH: '/usr/bin' },
      { TERM: 'xterm-256color' }
    );
    expect(env).toEqual({ PATH: '/usr/bin', TERM: 'xterm-256color' });
  });

  it('never passes the local auth token to a session (2026-10-27)', () => {
    const env = terminalSessionEnv(
      { UNTETHER_LOCAL_AUTH_TOKEN: 'local-token', PATH: '/usr/bin' },
      { TERM: 'xterm-256color' }
    );
    expect(env).toEqual({ PATH: '/usr/bin', TERM: 'xterm-256color' });
  });

  it('a task marker comes only from the session itself, never the launching process (2026-11-02)', () => {
    const inherited = terminalSessionEnv(
      { UNTETHER_TASK_ID: 'launcher-task', PATH: '/usr/bin' },
      { TERM: 'xterm-256color' }
    );
    expect(inherited).toEqual({ PATH: '/usr/bin', TERM: 'xterm-256color' });
    const own = terminalSessionEnv(
      { UNTETHER_TASK_ID: 'launcher-task', PATH: '/usr/bin' },
      { TERM: 'xterm-256color', UNTETHER_TASK_ID: 'own-task' }
    );
    expect(own.UNTETHER_TASK_ID).toBe('own-task');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_AUTH_TOKEN_ENV, takeLocalAuthToken } from './local-auth-token.js';

// 2026-10-27 (security sweep): `--local-auth-token <token>` showed to every user of the Mac in
// `ps -ww`; the token now comes in the environment and leaves it at startup.
describe('local auth token from the environment', () => {
  it('reads the token and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = { [LOCAL_AUTH_TOKEN_ENV]: ' tok ', PATH: '/usr/bin' };
    expect(takeLocalAuthToken(env)).toBe('tok');
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('gives null for a missing or empty token', () => {
    expect(takeLocalAuthToken({})).toBeNull();
    const env: NodeJS.ProcessEnv = { [LOCAL_AUTH_TOKEN_ENV]: '  ' };
    expect(takeLocalAuthToken(env)).toBeNull();
    expect(LOCAL_AUTH_TOKEN_ENV in env).toBe(false);
  });
});

describe('server startup takes the local auth token', () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    delete process.env[LOCAL_AUTH_TOKEN_ENV];
    vi.resetModules();
  });

  const freshParseArgs = async (...args: string[]) => {
    vi.resetModules();
    process.argv = ['node', 'cli', '--port', '4020', ...args];
    return (await import('../server.js')).parseArgs;
  };

  it('keeps the token from the environment for every parse, and none in process.env', async () => {
    process.env[LOCAL_AUTH_TOKEN_ENV] = 'env-token';
    const parseArgs = await freshParseArgs('--allow-local-bypass');
    expect(parseArgs().localAuthToken).toBe('env-token');
    expect(process.env[LOCAL_AUTH_TOKEN_ENV]).toBeUndefined();
    // startUntetherServer parses twice; the second parse must not lose the token.
    expect(parseArgs().localAuthToken).toBe('env-token');
  });

  it('refuses the token as an argument, where ps shows it (2026-11-11)', async () => {
    // The path kept for an app built before 2026-10-27 is gone: the installed app (built
    // 2026-11-02) sends the environment variable.
    const parseArgs = await freshParseArgs(
      '--allow-local-bypass',
      '--local-auth-token',
      'arg-token'
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      expect(() => parseArgs()).toThrow('exit 1');
    } finally {
      exit.mockRestore();
    }
  });

  it('has no token when none is given', async () => {
    const parseArgs = await freshParseArgs('--allow-local-bypass');
    expect(parseArgs().localAuthToken).toBeNull();
  });
});

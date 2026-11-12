import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { devServerAuthArgs, moveLocalAuthTokenToEnv } = require('../../../scripts/dev-auth-args.js');

describe('dev server auth arguments', () => {
  it('leaves plain `pnpm run dev` open for local hacking, on loopback only', () => {
    // 2026-10-20 (security audit): it used to listen on 0.0.0.0 without auth.
    expect(devServerAuthArgs([])).toEqual(['--no-auth', '--bind', '127.0.0.1']);
    expect(devServerAuthArgs(['--'])).toEqual(['--no-auth', '--bind', '127.0.0.1']);
  });

  it('never opens a server the Mac app launched in password mode, token or not', () => {
    // DevServerManager.buildDevServerArguments, password mode, without a local token.
    expect(devServerAuthArgs(['--port', '4020', '--bind', '127.0.0.1'])).toEqual([]);
    expect(
      devServerAuthArgs([
        '--port',
        '4020',
        '--bind',
        '127.0.0.1',
        '--allow-local-bypass',
        '--local-auth-token',
        't',
      ])
    ).toEqual([]);
  });

  it('adds nothing when the caller disables auth itself', () => {
    expect(devServerAuthArgs(['--port', '4020', '--no-auth'])).toEqual([]);
  });

  it('moves the local auth token from the arguments to the watcher environment', () => {
    // 2026-10-27 (security sweep): an app built before the change still passes the argument;
    // it must not reach the tsx and server command lines (`ps -ww` shows them to every user).
    const env: Record<string, string> = {};
    expect(
      moveLocalAuthTokenToEnv(
        [
          '--port',
          '4020',
          '--allow-local-bypass',
          '--local-auth-token',
          'tok',
          '--bind',
          '0.0.0.0',
        ],
        env
      )
    ).toEqual(['--port', '4020', '--allow-local-bypass', '--bind', '0.0.0.0']);
    expect(env).toEqual({ UNTETHER_LOCAL_AUTH_TOKEN: 'tok' });

    const env2: Record<string, string> = {};
    expect(moveLocalAuthTokenToEnv(['--local-auth-token=-tok', '--no-auth'], env2)).toEqual([
      '--no-auth',
    ]);
    expect(env2).toEqual({ UNTETHER_LOCAL_AUTH_TOKEN: '-tok' });

    const untouched: Record<string, string> = {};
    expect(moveLocalAuthTokenToEnv(['--port', '4020'], untouched)).toEqual(['--port', '4020']);
    expect(untouched).toEqual({});
  });
});

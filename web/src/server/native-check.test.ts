import { describe, expect, it, vi } from 'vitest';
import { checkNativeModules } from './native-check.js';
import { createPamAuthenticate } from './services/authenticate-pam-loader.js';

// 2026-11-12: nothing asked a built app whether its native modules load with the Node it
// embeds; `untether check-native` is what the build and the release ask before signing.
describe('untether check-native', () => {
  it('says each module is good when all of them load', () => {
    const lines = checkNativeModules({
      bundleDir: '/bundle',
      pam: () => ({ loaded: true }),
      openPty: () => {},
      executable: () => true,
    });
    expect(lines.map((line) => `${line.ok} ${line.name}`)).toEqual(
      process.platform === 'darwin'
        ? ['true pty.node', 'true authenticate_pam.node', 'true spawn-helper']
        : ['true pty.node', 'true authenticate_pam.node']
    );
  });

  it('names the module built for another Node, with what Node said', () => {
    const abi =
      "The module '/bundle/authenticate_pam.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 147. This version of Node.js requires\nNODE_MODULE_VERSION 137.";
    const lines = checkNativeModules({
      bundleDir: '/bundle',
      pam: () => ({ loaded: false, error: abi }),
      openPty: () => {
        throw new Error('dlopen failed\nmore');
      },
      executable: () => false,
    });
    expect(lines[0]).toEqual({ name: 'pty.node', ok: false, detail: 'dlopen failed more' });
    expect(lines[1].ok).toBe(false);
    expect(lines[1].detail).toContain('NODE_MODULE_VERSION 147');
    expect(lines[1].detail).toContain('NODE_MODULE_VERSION 137');
    if (process.platform === 'darwin') expect(lines[2]).toMatchObject({ ok: false });
  });

  it('asks nothing about spawn-helper of a server that is not a bundle', () => {
    const lines = checkNativeModules({ pam: () => ({ loaded: true }), openPty: () => {} });
    expect(lines.map((line) => line.name)).toEqual(['pty.node', 'authenticate_pam.node']);
  });
});

// 2026-11-12: authenticate-pam was loaded once, at start. Built for another Node by an app
// build, it left a stub for the life of the server: login stayed gone after it was rebuilt.
describe('authenticate-pam, loaded again after a failure', () => {
  const call = (pam: ReturnType<typeof createPamAuthenticate>) =>
    new Promise<string>((resolve) =>
      pam.authenticate('u', 'p', (error, ok) => resolve(error ? error.message : String(ok)))
    );

  it('answers "not available" while the module does not load, and says why', async () => {
    const warn = vi.fn();
    const pam = createPamAuthenticate({
      load: () => {
        throw new Error('was compiled against a different Node.js version');
      },
      warn,
      now: () => 0,
    });
    expect(await call(pam)).toBe('PAM authentication not available');
    expect(pam.status()).toEqual({
      loaded: false,
      error: 'was compiled against a different Node.js version',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('was compiled against a different Node.js version');
  });

  it('loads it at the next login once it is rebuilt, without a restart', async () => {
    let rebuilt = false;
    let now = 0;
    const load = vi.fn(() => {
      if (!rebuilt) throw new Error('another ABI');
      return (_u: string, _p: string, done: (error: Error | null, ok?: boolean) => void) =>
        done(null, true);
    });
    const pam = createPamAuthenticate({ load, now: () => now, retryMs: 5000 });
    expect(await call(pam)).toBe('PAM authentication not available');
    rebuilt = true;
    // Not on every call: a flood of logins does not become a flood of dlopen.
    now = 1000;
    expect(await call(pam)).toBe('PAM authentication not available');
    expect(load).toHaveBeenCalledTimes(1);
    now = 6000;
    expect(await call(pam)).toBe('true');
    expect(pam.status()).toEqual({ loaded: true });
    // Loaded: never loaded again.
    now = 60_000;
    await call(pam);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

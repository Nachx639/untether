import { describe, expect, it, vi } from 'vitest';
import {
  checkNativeModules,
  checkNativeReport,
  nodeThatLoads,
  openWithNode,
} from './native-check.js';
import { createPamAuthenticate, withoutRebuildAdvice } from './services/authenticate-pam-loader.js';

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

// 2026-11-14: a task's `ut` (its session's Node 24) ran the source of the checkout the server
// runs from on Node 26; authenticate-pam, built for 26 (ABI 147) as it must be, was reported to
// every command as "compiled against a different Node.js version … Please try re-compiling".
describe("a checkout's native modules are judged with the Node that loads them", () => {
  const node24 = { execPath: '/nvm/v24/bin/node', version: 'v24.22.3', modules: '137' };
  const node26 = { execPath: '/brew/node/26/bin/node', version: 'v26.13.1', modules: '147' };
  const main = { commit: 'abc', dev: true, cli: '/repo/web/bin/untether-dev' };
  const abiError = (built: string, needs: string) =>
    `Error: The module '/repo/web/node_modules/authenticate-pam/build/Release/authenticate_pam.node' was compiled against a different Node.js version using NODE_MODULE_VERSION ${built}. This version of Node.js requires NODE_MODULE_VERSION ${needs}. Please try re-compiling or re-installing the module (for instance, using \`npm rebuild\` or \`npm install\`).`;
  /** Addons built for `built`, opened by `node`: what dlopen in that Node would do. */
  const check = (built: string, loader: ReturnType<typeof nodeThatLoads>) => {
    const open = () => {
      if (loader.node.modules !== built) throw new Error(abiError(built, loader.node.modules));
    };
    return checkNativeReport(
      checkNativeModules({
        pam: () => {
          try {
            open();
            return { loaded: true };
          } catch (error) {
            return { loaded: false, error: (error as Error).message };
          }
        },
        openPty: open,
      }),
      loader,
      { own: node24, checkout: true }
    );
  };

  it('natives for the server (Node 26), asked from Node 24: nothing to say', () => {
    const loader = nodeThatLoads({
      own: node24,
      cli: main,
      server: { build: main, node: node26 },
    });
    expect(loader).toEqual({ node: node26, server: true });
    const report = check('147', loader);
    expect(report.slice(0, 2)).toEqual(['ok pty.node: loads', 'ok authenticate_pam.node: loads']);
    expect(report.join('\n')).toContain('the Node of the server running from this checkout');
    expect(report.join('\n')).not.toMatch(/FAILED|NODE_MODULE_VERSION|re-compil|rebuild/i);
  });

  it("natives that do not match the server's Node are told, without advice to rebuild", () => {
    const loader = nodeThatLoads({
      own: node24,
      cli: main,
      server: { build: main, node: node26 },
    });
    // Built for the asking Node 24 (what an app build left on 2026-11-11): the server cannot.
    const report = check('137', loader);
    expect(report[1]).toContain('FAILED authenticate_pam.node');
    expect(report[1]).toContain('NODE_MODULE_VERSION 137');
    expect(report.join('\n')).not.toMatch(/re-compil|re-install|npm rebuild/i);
  });

  it('the server of another checkout (or none) says nothing about this one', () => {
    const worktree = { commit: 'def', dev: true, cli: '/worktrees/task/web/bin/untether-dev' };
    const other = nodeThatLoads({
      own: node24,
      cli: worktree,
      server: { build: main, node: node26 },
    });
    expect(other).toEqual({ node: node24, server: false });
    expect(nodeThatLoads({ own: node24, cli: main })).toEqual({ node: node24, server: false });
    // An installed app's server is not a checkout's.
    const app = { commit: 'abc', cli: '/Applications/Untether.app/Contents/Resources/untether' };
    expect(
      nodeThatLoads({ own: node24, cli: main, server: { build: app, node: node26 } }).server
    ).toBe(false);
    // Nobody runs from it: opened with the asking Node, said as that and nothing to rebuild.
    const report = check('147', nodeThatLoads({ own: node24, cli: main }));
    expect(report[1]).toContain('FAILED authenticate_pam.node');
    expect(report.at(-1)).toContain('No server runs from this checkout');
    expect(report.join('\n')).not.toMatch(/re-compil|re-install|npm rebuild/i);
  });

  it("a module opens in a child of the Node given, and its error is that Node's", () => {
    expect(() => openWithNode(process.execPath, '/no/such/addon.node')).toThrow(/addon\.node/);
  });

  it('importing the loader opens nothing: only a login or status() does', async () => {
    const warn = vi.fn();
    const load = vi.fn(() => {
      throw new Error(abiError('147', '137'));
    });
    const pam = createPamAuthenticate({ load, warn, now: () => 0 });
    // What every `ut` command does: nothing.
    expect(load).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    // The server, at its start, asks; it is told why, without Node's advice to rebuild.
    expect(pam.status().loaded).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('NODE_MODULE_VERSION 147');
    expect(warn.mock.calls[0][0]).not.toMatch(/re-compil|re-install|npm rebuild/i);
  });

  it("Node's advice is cut from its message, the rest kept", () => {
    expect(withoutRebuildAdvice(abiError('147', '137'))).toMatch(
      /requires NODE_MODULE_VERSION 137\.$/
    );
    expect(withoutRebuildAdvice('dlopen failed\nmore')).toBe('dlopen failed more');
    // Cut short by whoever quoted it (a few lines of a stack): still no advice left.
    expect(withoutRebuildAdvice('requires 137. Please try re-compiling or re-installing')).toBe(
      'requires 137.'
    );
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

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

const require = createRequire(import.meta.url);
const { buildNativeAddon, resolvePrebuild } = require('../../../scripts/native-modules.js');

// 2026-10-12: `npm rebuild` / `pnpm rebuild` silently built nothing under ignore-scripts=true,
// so the Mac bundle lost authenticate_pam.node. The helper must build in the package's real
// (pnpm store) directory and fail loudly when node-gyp produces nothing.
describe('native addon builder', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, RM_TEST_DIR);
  });

  function fakePackage() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-addon-')));
    dirs.push(root);
    const real = path.join(root, 'store', 'authenticate-pam');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'package.json'), '{}');
    const link = path.join(root, 'node_modules', 'authenticate-pam');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link);
    const resolve = (id: string) => path.join(root, 'node_modules', id);
    return { real, resolve };
  }

  it('runs node-gyp in the realpath of the package and returns the .node file', () => {
    const { real, resolve } = fakePackage();
    const exec = vi.fn((_cmd: string, _args: string[], opts: { cwd: string }) => {
      fs.mkdirSync(path.join(opts.cwd, 'build', 'Release'), { recursive: true });
      fs.writeFileSync(path.join(opts.cwd, 'build', 'Release', 'authenticate_pam.node'), '');
    });
    const out = buildNativeAddon('authenticate-pam', 'authenticate_pam.node', { exec, resolve });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][1]).toContain('rebuild');
    expect(exec.mock.calls[0][2].cwd).toBe(real);
    expect(out).toBe(path.join(real, 'build', 'Release', 'authenticate_pam.node'));
  });

  it('throws when node-gyp produced no .node file', () => {
    const { resolve } = fakePackage();
    const exec = vi.fn();
    expect(() =>
      buildNativeAddon('authenticate-pam', 'authenticate_pam.node', { exec, resolve })
    ).toThrow(/did not produce/);
  });
});

// 2026-11-11: build-npm.js ran `npx prebuild`, which downloads and runs the tool when it is not
// installed. It comes from web/node-pty's own node_modules or the build stops.
describe('prebuild for the npm package', () => {
  it('is the one installed in node-pty, run with this node', () => {
    const resolve = (id: string) => `/checkout/web/node-pty/node_modules/${id}`;
    expect(resolvePrebuild('/checkout/web/node-pty', resolve)).toEqual([
      process.execPath,
      ['/checkout/web/node-pty/node_modules/prebuild/bin.js'],
    ]);
  });

  it('says what to run when it is not installed, and never names npx as the way', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'no-prebuild-')));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      expect(() => resolvePrebuild(dir)).toThrow(/pnpm install --frozen-lockfile/);
      expect(() => resolvePrebuild(dir)).toThrow(/never downloaded/);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });
});

// 2026-11-12 (third time): the app's build rebuilt the addons in node_modules for the Node it
// embeds; the development server that runs from that tree could no longer load authenticate-pam
// and node-pty's spawn-helper was gone while it compiled. A bundle's addons are built from a
// copy of their sources, out of the tree.
describe('native addons for a bundle (isolated build)', () => {
  const { buildNativeAddonIsolated, assertAddonsLoad, packageDir } =
    require('../../../scripts/native-modules.js');
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, RM_TEST_DIR);
  });
  const scratch = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'addon-isolated-')));
    dirs.push(dir);
    return dir;
  };
  const sha = (file: string) =>
    require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  /** node-gyp's stand-in: writes the files a build makes, in the folder it is run in. */
  const gyp = (files: string[]) =>
    vi.fn((_cmd: string, _args: string[], opts: { cwd: string }) => {
      fs.mkdirSync(path.join(opts.cwd, 'build', 'Release'), { recursive: true });
      for (const file of files) {
        fs.writeFileSync(path.join(opts.cwd, 'build', 'Release', file), 'built for the bundle');
      }
    });

  /**
   * An installed tree like web/node_modules: each addon with its sources, a dependency its
   * binding.gyp asks node for, and the build a running server has loaded.
   * (Not the real one: the suite's own test servers may rebuild a module there meanwhile.)
   */
  const installedTree = () => {
    const root = scratch();
    const packages = [
      ['node-pty', 'node-addon-api', ['pty.node', 'spawn-helper']],
      ['authenticate-pam', 'nan', ['authenticate_pam.node']],
    ] as const;
    for (const [name, dependency, files] of packages) {
      const dir = path.join(root, 'node_modules', name);
      fs.mkdirSync(path.join(dir, 'build', 'Release'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, dependencies: { [dependency]: '*' } })
      );
      fs.writeFileSync(path.join(dir, 'binding.gyp'), '{}');
      fs.writeFileSync(path.join(dir, 'src', 'addon.cc'), '// sources');
      for (const file of files) {
        fs.writeFileSync(path.join(dir, 'build', 'Release', file), `${file} of the running server`);
      }
      const dependencyDir = path.join(root, 'node_modules', dependency);
      fs.mkdirSync(dependencyDir, { recursive: true });
      fs.writeFileSync(
        path.join(dependencyDir, 'package.json'),
        JSON.stringify({ name: dependency })
      );
    }
    const resolve = (id: string) => path.join(root, 'node_modules', id);
    return { root, packages, resolve };
  };

  it('leaves every built file of node_modules as it was (same hash, same inode and time)', () => {
    const { root, packages, resolve } = installedTree();
    const everyFile = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? everyFile(full) : [full];
      });
    const state = () =>
      everyFile(path.join(root, 'node_modules'))
        .sort()
        .map((file) => {
          const stat = fs.statSync(file);
          return `${file} ${sha(file)} ${stat.ino} ${stat.mtimeMs}`;
        });
    const before = state();
    expect(before.filter((line) => line.includes('/build/Release/'))).toHaveLength(3);
    const outDir = scratch();
    for (const [name, dependency, files] of packages) {
      const exec = gyp([...files]);
      const built = buildNativeAddonIsolated(name, {
        outDir,
        target: 'v24.16.0',
        exec,
        files,
        resolve,
      });
      const [, args, opts] = exec.mock.calls[0];
      expect(opts.cwd).toBe(path.join(outDir, name));
      expect(opts.cwd).not.toContain('node_modules');
      expect(args).toEqual(expect.arrayContaining(['rebuild', '--target=24.16.0']));
      for (const file of files) {
        expect(built[file]).toBe(path.join(outDir, name, 'build', 'Release', file));
        expect(fs.readFileSync(built[file], 'utf8')).toBe('built for the bundle');
      }
      // The sources were copied, the server's build of them was not; what binding.gyp asks
      // node for is linked in.
      expect(fs.existsSync(path.join(outDir, name, 'src', 'addon.cc'))).toBe(true);
      expect(
        fs.existsSync(path.join(outDir, name, 'node_modules', dependency, 'package.json'))
      ).toBe(true);
    }
    // Nothing of the installed tree was written, removed or added.
    expect(state()).toEqual(before);
  });

  it('refuses to build inside the package, and says so when node-gyp makes nothing', () => {
    const inside = path.join(packageDir('authenticate-pam'), 'build');
    expect(() =>
      buildNativeAddonIsolated('authenticate-pam', {
        outDir: path.dirname(inside),
        target: 'v24.16.0',
        exec: vi.fn(),
      })
    ).toThrow(/needs outDir|inside the package/);
    expect(() =>
      buildNativeAddonIsolated('authenticate-pam', {
        outDir: scratch(),
        target: 'v24.16.0',
        exec: vi.fn(),
      })
    ).toThrow(/did not produce/);
  });

  it('opens the addons with the Node that will run them and names the one that does not load', () => {
    const pty = path.join(packageDir('node-pty'), 'build', 'Release', 'pty.node');
    expect(() => assertAddonsLoad(process.execPath, [pty])).not.toThrow();
    const bad = path.join(scratch(), 'authenticate_pam.node');
    fs.writeFileSync(bad, 'not an addon');
    expect(() => assertAddonsLoad(process.execPath, [pty, bad])).toThrow(
      /authenticate_pam\.node does not load with .*Error/
    );
    // What a module of another ABI says reaches the message.
    const exec = vi.fn(() => {
      throw Object.assign(new Error('Command failed'), {
        stderr:
          "node:internal/modules/cjs/loader:1\nError: The module 'x.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 147. This version of Node.js requires\nNODE_MODULE_VERSION 137.",
      });
    });
    expect(() => assertAddonsLoad('/custom/node', ['x.node'], { exec })).toThrow(
      /x\.node does not load with \/custom\/node: .*NODE_MODULE_VERSION 147.*NODE_MODULE_VERSION 137/
    );
  });
});

// 2026-11-12: every `pnpm install --frozen-lockfile` put the file: dependency node-pty in place
// again without its build/ (no pty.node, no spawn-helper, in the tree the server runs from).
// The app's build installs only when node_modules is not what the lockfile asks for.
describe('deps-in-sync (whether the app build needs pnpm install)', () => {
  const { depsInSync, lockfileSpecifiers } = require('../../../scripts/deps-in-sync.js');
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, RM_TEST_DIR);
  });
  const LOCK = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      express:',
    '        specifier: ^5.3.0',
    '        version: 5.3.0',
    '      node-pty:',
    '        specifier: file:node-pty',
    '        version: file:node-pty',
    '    devDependencies:',
    "      '@types/node':",
    '        specifier: ^26.1.1',
    '        version: 26.1.1',
    '',
    'packages:',
    '',
    '  express@5.3.0:',
    '    resolution: {integrity: sha512-x}',
    '',
  ].join('\n');
  const web = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deps-in-sync-')));
    dirs.push(dir);
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    };
    write('pnpm-lock.yaml', LOCK);
    write('node_modules/.pnpm/lock.yaml', LOCK);
    write(
      'package.json',
      JSON.stringify({
        dependencies: { express: '^5.3.0', 'node-pty': 'file:node-pty' },
        devDependencies: { '@types/node': '^26.1.1' },
      })
    );
    for (const root of ['node-pty', 'node_modules/node-pty']) {
      write(`${root}/package.json`, '{"name":"node-pty"}');
      write(`${root}/src/unix/pty.cc`, '// pty');
    }
    // What only one side has by nature: the vendored folder's own files, the installed build.
    write('node-pty/pnpm-lock.yaml', 'x');
    write('node_modules/node-pty/build/Release/pty.node', 'built');
    return { dir, write };
  };

  it('reads what the lockfile says the project asks for', () => {
    expect(lockfileSpecifiers(LOCK)).toEqual({
      dependencies: { express: '^5.3.0', 'node-pty': 'file:node-pty' },
      devDependencies: { '@types/node': '^26.1.1' },
    });
  });

  it('is in sync when nothing changed since the install: no install, node-pty keeps its build', () => {
    expect(depsInSync(web().dir)).toEqual({ inSync: true });
  });

  it('is in sync for this very checkout as installed', () => {
    const real = path.resolve(__dirname, '../../..');
    const lock = fs.readFileSync(path.join(real, 'pnpm-lock.yaml'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
    expect(lockfileSpecifiers(lock).dependencies).toEqual(manifest.dependencies);
    expect(lockfileSpecifiers(lock).devDependencies).toEqual(manifest.devDependencies);
  });

  it.each([
    [
      'the lockfile changed',
      (w: ReturnType<typeof web>) => w.write('pnpm-lock.yaml', `${LOCK}# new\n`),
      /changed since the last install/,
    ],
    [
      'nothing is installed',
      (w: ReturnType<typeof web>) => fs.rmSync(path.join(w.dir, 'node_modules'), RM_TEST_DIR),
      /no install/,
    ],
    [
      'package.json asks for something the lockfile does not have',
      (w: ReturnType<typeof web>) =>
        w.write(
          'package.json',
          JSON.stringify({
            dependencies: { express: '^6.0.0', 'node-pty': 'file:node-pty' },
            devDependencies: { '@types/node': '^26.1.1' },
          })
        ),
      /differ on express \(dependencies\): \^6\.0\.0 vs \^5\.3\.0/,
    ],
    [
      'a source of node-pty changed',
      (w: ReturnType<typeof web>) => w.write('node-pty/src/unix/pty.cc', '// new'),
      /node-pty\/src\/unix\/pty\.cc is not the one installed/,
    ],
    [
      'node-pty gained a source',
      (w: ReturnType<typeof web>) => w.write('node-pty/src/new.cc', '//'),
      /node-pty\/src\/new\.cc/,
    ],
    [
      'node-pty lost a source',
      (w: ReturnType<typeof web>) => w.write('node_modules/node-pty/src/old.cc', '//'),
      /no longer has/,
    ],
  ])('is not in sync when %s', (_name, change, why) => {
    const made = web();
    change(made);
    const result = depsInSync(made.dir);
    expect(result.inSync).toBe(false);
    expect(result.why).toMatch(why);
  });
});

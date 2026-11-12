/**
 * Builds the native addons (authenticate-pam, node-pty) with node-gyp: in their real pnpm store
 * directory for the checkout's own use (buildNativeAddon), or from a copy of their sources in a
 * folder of the caller's for a bundle that embeds another Node (buildNativeAddonIsolated).
 *
 * 2026-10-12: with `ignore-scripts=true` in ~/.npmrc (a deliberate user setting), pnpm leaves
 * both packages in `pendingBuilds`, and neither `npm rebuild authenticate-pam` nor
 * `pnpm rebuild authenticate-pam` builds anything (both report success). The Mac bundle then
 * shipped without authenticate_pam.node unless someone ran node-gyp by hand. node-gyp does not
 * read ignore-scripts or pnpm's bookkeeping, so it is called directly and its output checked.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** [command, leading args] that run node-gyp. */
function resolveNodeGyp() {
  try {
    return [process.execPath, [require.resolve('node-gyp/bin/node-gyp.js')]];
  } catch {}
  const bundled = path.join(
    path.dirname(process.execPath),
    '..',
    'lib',
    'node_modules',
    'npm',
    'node_modules',
    'node-gyp',
    'bin',
    'node-gyp.js'
  );
  if (fs.existsSync(bundled)) return [process.execPath, [bundled]];
  return ['npx', ['--yes', 'node-gyp']];
}

/** Real directory of an installed package (follows pnpm's symlinks). */
function packageDir(name, resolve = require.resolve) {
  return fs.realpathSync(path.dirname(resolve(`${name}/package.json`)));
}

/**
 * [command, leading args] that run `prebuild` (the tool that packs a native addon per Node ABI
 * for the npm package). It is a devDependency of web/node-pty, pinned by that package's lockfile.
 * 2026-11-11: build-npm.js called `npx prebuild`, which downloads and runs whatever version the
 * registry serves that day when it is not installed. It is never fetched: missing, this throws
 * with what to run.
 */
function resolvePrebuild(nodePtyDir, resolve) {
  const find =
    resolve || require('module').createRequire(path.join(nodePtyDir, 'package.json')).resolve;
  let bin;
  try {
    bin = find('prebuild/bin.js');
  } catch {
    throw new Error(
      `prebuild is not installed in ${nodePtyDir}. Run \`pnpm install --frozen-lockfile --ignore-scripts\` there ` +
        '(it is a devDependency of web/node-pty); it is never downloaded with npx.'
    );
  }
  return [process.execPath, [bin]];
}

/**
 * Runs `node-gyp rebuild` in the package and returns the path of the expected .node file.
 * Throws when node-gyp fails or doesn't produce it.
 */
function buildNativeAddon(
  name,
  nodeFile,
  { extraArgs = [], env = process.env, exec = execFileSync, resolve = require.resolve } = {}
) {
  const dir = packageDir(name, resolve);
  const [cmd, pre] = resolveNodeGyp();
  exec(cmd, [...pre, 'rebuild', ...extraArgs], { cwd: dir, stdio: 'inherit', env });
  const out = path.join(dir, 'build', 'Release', nodeFile);
  if (!fs.existsSync(out)) {
    throw new Error(`node-gyp did not produce ${out}`);
  }
  return out;
}

/** What a build makes for each addon, in build/Release. */
const ADDON_FILES = {
  'node-pty': process.platform === 'darwin' ? ['pty.node', 'spawn-helper'] : ['pty.node'],
  'authenticate-pam': ['authenticate_pam.node'],
};

/** What of a package is not its sources: a build of it, its own dependencies, packed builds. */
const NOT_SOURCES = new Set(['build', 'node_modules', 'prebuilds', '.git']);

/**
 * Builds an addon for a given Node WITHOUT writing in node_modules: its sources are copied to
 * `<outDir>/<name>`, node-gyp runs there, and the files come out in `<outDir>/<name>/build/Release`.
 * Returns { file name: path }.
 *
 * 2026-11-12 (third time; 11-nov rebuilding the installed app, 12-nov during a release): the
 * app's build ran `node-gyp rebuild --target=<embedded Node 24>` in node_modules, the tree the
 * development server (Node 26) runs from. authenticate-pam (not N-API: one build per ABI) could
 * no longer be loaded by that server and password login was gone; node-pty's spawn-helper was
 * missing while it compiled, the doctor rebuilt it in the middle and the two raced. A bundle's
 * addons are now built here, out of the tree: nothing a running server loads is written.
 *
 * The addon's dependencies (nan, node-addon-api: headers its binding.gyp asks node for) are
 * linked into the copy, read-only use.
 */
function buildNativeAddonIsolated(
  name,
  {
    outDir,
    target,
    extraArgs = [],
    env = process.env,
    exec = execFileSync,
    resolve = require.resolve,
    resolveDependency = (fromDir, dependency) =>
      path.dirname(
        require('module')
          .createRequire(path.join(fromDir, 'package.json'))
          .resolve(`${dependency}/package.json`)
      ),
    files = ADDON_FILES[name],
  }
) {
  if (!outDir || !target) throw new Error('buildNativeAddonIsolated needs outDir and target');
  const source = packageDir(name, resolve);
  const stage = path.resolve(outDir, name);
  const inside = path.relative(source, stage);
  if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) {
    throw new Error(`${stage} is inside the package it would build (${source})`);
  }
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const entry of fs.readdirSync(source)) {
    if (NOT_SOURCES.has(entry)) continue;
    fs.cpSync(path.join(source, entry), path.join(stage, entry), { recursive: true });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    const link = path.join(stage, 'node_modules', dependency);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(fs.realpathSync(resolveDependency(source, dependency)), link, 'dir');
  }
  const [cmd, pre] = resolveNodeGyp();
  // node-addon-api needs C++17 or later; the headers of a --target do not always ask for it.
  const buildEnv = { ...env, CXXFLAGS: env.CXXFLAGS || '-std=c++20' };
  exec(
    cmd,
    [...pre, 'rebuild', `--target=${String(target).replace(/^v/, '')}`, ...extraArgs],
    { cwd: stage, stdio: 'inherit', env: buildEnv }
  );
  const built = {};
  for (const file of files) {
    const out = path.join(stage, 'build', 'Release', file);
    if (!fs.existsSync(out)) throw new Error(`node-gyp did not produce ${out}`);
    built[file] = out;
  }
  return built;
}

/**
 * Opens each addon with the Node that will run it (`nodeExe`: the one a bundle embeds); throws
 * naming the first that does not load. An addon built for another ABI fails here, at build time,
 * instead of at the first login of the shipped app.
 */
function assertAddonsLoad(nodeExe, addonFiles, { exec = execFileSync } = {}) {
  for (const file of addonFiles) {
    try {
      exec(nodeExe, ['-e', 'process.dlopen({ exports: {} }, process.argv[1])', path.resolve(file)], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '' },
        timeout: 60_000,
      });
    } catch (error) {
      const said = String((error && error.stderr) || (error && error.message) || error);
      const lines = said.split('\n');
      const from = Math.max(
        0,
        lines.findIndex((text) => /Error/.test(text))
      );
      const why = lines
        .slice(from, from + 5)
        .join(' ')
        .replace(/\s+/g, ' ')
        .replace(file, 'it')
        .trim();
      throw new Error(`${file} does not load with ${nodeExe}: ${why.slice(0, 400)}`);
    }
  }
}

function buildAuthenticatePam(options) {
  return buildNativeAddon('authenticate-pam', 'authenticate_pam.node', options);
}

function buildNodePty(options) {
  return buildNativeAddon('node-pty', 'pty.node', options);
}

module.exports = {
  resolveNodeGyp,
  resolvePrebuild,
  packageDir,
  buildNativeAddon,
  buildNativeAddonIsolated,
  assertAddonsLoad,
  ADDON_FILES,
  buildAuthenticatePam,
  buildNodePty,
};

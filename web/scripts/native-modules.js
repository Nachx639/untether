/**
 * Builds the native addons (authenticate-pam, node-pty) with node-gyp in their real pnpm store
 * directory.
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
  buildAuthenticatePam,
  buildNodePty,
};

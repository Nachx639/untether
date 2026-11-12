#!/usr/bin/env node

/**
 * Ensures native modules are built and available for tests
 * This script handles pnpm's symlink structure where node-pty might be in .pnpm directory
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { buildAuthenticatePam, buildNodePty, packageDir } = require('./native-modules.js');

console.log('Ensuring native modules are built for tests...');

// Find the actual node-pty location (could be in .pnpm directory)
let nodePtyPath;
try {
  nodePtyPath = require.resolve('node-pty/package.json');
} catch (e) {
  console.error('Could not find node-pty module');
  process.exit(1);
}

const nodePtyDir = path.dirname(nodePtyPath);
const buildDir = path.join(nodePtyDir, 'build');
const releaseDir = path.join(buildDir, 'Release');

console.log(`Found node-pty at: ${nodePtyDir}`);

// Check if native modules are built
if (!fs.existsSync(releaseDir) || !fs.existsSync(path.join(releaseDir, 'pty.node'))) {
  console.log('Native modules not found, building...');
  
  try {
    // Build using node-gyp directly to avoid TypeScript issues
    buildNodePty();
  } catch (e) {
    console.error('Failed to build native modules:', e.message);
    process.exit(1);
  }
}

// 2026-10-12: with ignore-scripts=true in ~/.npmrc, pnpm never builds authenticate-pam either,
// and PAM tests then fail confusingly. Build it the same way.
try {
  const pamFile = path.join(packageDir('authenticate-pam'), 'build', 'Release', 'authenticate_pam.node');
  if (!fs.existsSync(pamFile)) {
    console.log('authenticate-pam not built, building...');
    buildAuthenticatePam();
  }
} catch (e) {
  console.error('Failed to build authenticate-pam:', e.message);
  process.exit(1);
}

// For pnpm, ensure the symlinked node_modules/node-pty has the build directory
const symlinkNodePty = path.join(__dirname, '../node_modules/node-pty');
if (fs.existsSync(symlinkNodePty) && fs.lstatSync(symlinkNodePty).isSymbolicLink()) {
  const symlinkBuildDir = path.join(symlinkNodePty, 'build');
  
  // If the symlinked location doesn't have a build directory, create a symlink to the real one
  if (!fs.existsSync(symlinkBuildDir) && fs.existsSync(buildDir)) {
    console.log('Creating symlink for build directory in node_modules/node-pty...');
    try {
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(buildDir, symlinkBuildDir, symlinkType);
      console.log('Created build directory symlink');
    } catch (e) {
      // If symlink fails, try copying instead
      console.log('Symlink failed, trying to copy build directory...');
      fs.cpSync(buildDir, symlinkBuildDir, { recursive: true });
      console.log('Copied build directory');
    }
  }
}

console.log('Native modules are ready for tests');

// Ensure Rust forwarder exists (required now that Node forwarder is removed)
const webRoot = path.join(__dirname, '..');
const nativeForwarderPath = path.join(webRoot, 'native', 'untether-fwd');
const binForwarderPath = path.join(webRoot, 'bin', 'untether-fwd');
const { forwarderStale } = require('./fwd-source-hash');

// 2026-11-02: a merge of the base brought ut-fwd sources with a new flag
// (--compact-cast-until) while the binary built before it stayed: forwarder tests failed with
// "invalid arguments". A binary older than its sources is rebuilt, not only a missing one.
const forwarderSources = path.join(webRoot, '..', 'native', 'ut-fwd');
// Each copy is judged by the hash of the sources it was built from (build-fwd-rust.js), by mtimes
// only when it has no hash yet (fwd-source-hash.js forwarderStale).
const forwarderMissing = !fs.existsSync(nativeForwarderPath) || !fs.existsSync(binForwarderPath);
if (
  forwarderMissing ||
  forwarderStale(forwarderSources, [nativeForwarderPath, binForwarderPath])
) {
  console.log(
    forwarderMissing
      ? 'Rust forwarder not found, building...'
      : 'Rust forwarder older than its sources, rebuilding...'
  );

  try {
    execSync('node scripts/build-fwd-rust.js', {
      cwd: webRoot,
      stdio: 'inherit',
      shell: true,
    });
  } catch (e) {
    console.error('Failed to build Rust forwarder:', e.message);
    process.exit(1);
  }
}

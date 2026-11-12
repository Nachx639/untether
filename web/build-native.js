#!/usr/bin/env node

/**
 * Build standalone untether executable using Node.js SEA (Single Executable Application)
 *
 * This script creates a portable executable that bundles the Untether server into a single
 * binary using Node.js's built-in SEA feature. The resulting executable can run on any machine
 * with the same OS/architecture without requiring Node.js to be installed.
 *
 * ## Output
 * Creates a `native/` directory with just 3 files:
 * - `untether` - The standalone executable (includes all JS code and sourcemaps)
 * - `pty.node` - Native binding for terminal emulation
 * - `spawn-helper` - Helper binary for spawning processes (Unix only)
 *
 * ## Usage
 * ```bash
 * node build-native.js                    # Build with system Node.js
 * node build-native.js --sourcemap        # Build with inline sourcemaps
 * node build-native.js --custom-node      # Auto-discover custom Node.js (uses most recent)
 * node build-native.js --custom-node=/path/to/node  # Use specific custom Node.js binary
 * node build-native.js --custom-node /path/to/node  # Alternative syntax
 * ```
 */

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createNativeRebuildEnv } = require('./scripts/native-rebuild-env.js');
const { buildAuthenticatePam, buildNodePty } = require('./scripts/native-modules.js');

// Parse command line arguments
const includeSourcemaps = process.argv.includes('--sourcemap');
let customNodePath = null;

// Parse --custom-node argument
for (let i = 0; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--custom-node=')) {
    customNodePath = arg.split('=')[1];
  } else if (arg === '--custom-node') {
    if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
      // Next argument is the path
      customNodePath = process.argv[i + 1];
    } else {
      // No path provided, use auto-discovery
      customNodePath = 'auto';
    }
  }
}

console.log('Building standalone untether executable using Node.js SEA...');
console.log(`System Node.js version: ${process.version}`);
if (includeSourcemaps) {
  console.log('Including sourcemaps in build');
}

function assertSupportedNodeVersion(versionText, label) {
  const normalizedVersion = versionText.trim().replace(/^v/, '');
  const [nodeMajor, nodeMinor] = normalizedVersion.split('.').map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
    console.error(`Error: ${label} Node.js 22.12 or higher is required for SEA feature (found ${versionText.trim()})`);
    process.exit(1);
  }
}

// Check the host Node.js version before running SEA build steps.
assertSupportedNodeVersion(process.version, 'Host');

function readNodeVersion(nodeExe) {
  return execFileSync(nodeExe, ['--version'], { encoding: 'utf8' }).trim();
}

// Cleanup function
function cleanup() {
  if (fs.existsSync('build') && !process.argv.includes('--keep-build')) {
    console.log('Cleaning up build directory...');
    fs.rmSync('build', { recursive: true, force: true });
  }
}

// Ensure cleanup happens on exit
process.on('exit', cleanup);
process.on('SIGINT', () => {
  console.log('\nBuild interrupted');
  process.exit(1);
});
process.on('SIGTERM', () => {
  console.log('\nBuild terminated');
  process.exit(1);
});

// No patching needed - SEA support is built into our vendored node-pty

async function main() {
  try {
    // No patching needed - SEA support is built into our vendored node-pty
    console.log('Using vendored node-pty with built-in SEA support...');
    
    // Ensure native modules are built (in case postinstall didn't run)
    const nativePtyFile = 'node_modules/node-pty/build/Release/pty.node';
    const nativeAuthFile = 'node_modules/authenticate-pam/build/Release/authenticate_pam.node';

    // 2026-10-12: check the .node files, not the Release directory (a half-finished build left
    // the directory and skipped the rebuild), and build with node-gyp directly: with
    // ignore-scripts=true in ~/.npmrc, `npm rebuild` / `pnpm rebuild` silently build nothing and
    // the bundle shipped without PAM. See scripts/native-modules.js.
    try {
      if (!fs.existsSync(nativePtyFile)) {
        console.log('Building node-pty native module (node-gyp)...');
        buildNodePty();
      }
      if (!fs.existsSync(nativeAuthFile)) {
        console.log('Building authenticate-pam native module (node-gyp)...');
        buildAuthenticatePam();
      }
    } catch (error) {
      console.error(`Error: native module build failed: ${error.message}`);
      process.exit(1);
    }
    
    // Create build directory
    if (!fs.existsSync('build')) {
      fs.mkdirSync('build');
    }

    // Create native directory
    if (!fs.existsSync('native')) {
      fs.mkdirSync('native');
    }

    // 0. Determine which Node.js to use
    let nodeExe = process.execPath;
    if (customNodePath) {
      if (customNodePath === 'auto') {
        // Auto-discover custom Node.js build
        const buildDir = path.join(__dirname, '.node-builds');
        if (fs.existsSync(buildDir)) {
          // Find the most recent custom Node.js build
          const builds = fs.readdirSync(buildDir)
            .filter(name => name.startsWith('node-v') && name.endsWith('-minimal'))
            .map(name => {
              const nodePath = path.join(buildDir, name, 'out', 'Release', 'node');
              if (fs.existsSync(nodePath)) {
                const match = name.match(/node-v(.+)-minimal/);
                if (!match || !match[1]) {
                  console.warn(`Warning: Skipping directory with invalid name format: ${name}`);
                  return null;
                }
                return {
                  path: nodePath,
                  version: match[1],
                  mtime: fs.statSync(nodePath).mtime
                };
              }
              return null;
            })
            .filter(Boolean)
            .sort((a, b) => b.mtime - a.mtime);
          
          if (builds.length > 0) {
            customNodePath = builds[0].path;
            console.log(`Auto-discovered custom Node.js v${builds[0].version} at ${customNodePath}`);
          } else {
            console.error('Error: No custom Node.js builds found in .node-builds/');
            console.error('Build one using: node build-custom-node.js');
            process.exit(1);
          }
        } else {
          console.error('Error: No .node-builds directory found');
          console.error('Build a custom Node.js using: node build-custom-node.js');
          process.exit(1);
        }
      } else {
        // Validate custom node exists at specified path
        if (!fs.existsSync(customNodePath)) {
          console.error(`Error: Custom Node.js not found at ${customNodePath}`);
          console.error('Build one using: node build-custom-node.js');
          process.exit(1);
        }
      }
      nodeExe = customNodePath;
    }

    const selectedNodeVersion = customNodePath ? readNodeVersion(nodeExe) : process.version;
    assertSupportedNodeVersion(selectedNodeVersion, customNodePath ? 'Custom' : 'Selected');

    console.log(`Using Node.js binary: ${nodeExe}`);
    const nodeStats = fs.statSync(nodeExe);
    console.log(`Node.js binary size: ${(nodeStats.size / 1024 / 1024).toFixed(2)} MB`);

    // 1. Rebuild native modules if using custom Node.js
    if (customNodePath) {
      console.log('\nCustom Node.js detected - rebuilding native modules...');
      const customVersion = selectedNodeVersion;
      console.log(`Custom Node.js version: ${customVersion}`);
      
      const cleanEnv = createNativeRebuildEnv(
        process.env,
        process.execPath,
        customVersion,
        process.arch
      );
      
      console.log('Using clean PATH to avoid Homebrew dependencies during native module rebuild...');

      // 2026-10-12: `pnpm rebuild node-pty authenticate-pam` was a silent no-op (pnpm 10 with
      // ignore-scripts), so the existing system-ABI modules were shipped. Build with node-gyp
      // against the custom Node and check that fresh .node files came out.
      const rebuildStart = Date.now();
      const gypOptions = {
        extraArgs: [`--target=${customVersion.replace(/^v/, '')}`, '--dist-url=https://nodejs.org/dist'],
        env: cleanEnv,
      };
      try {
        for (const built of [buildNodePty(gypOptions), buildAuthenticatePam(gypOptions)]) {
          if (fs.statSync(built).mtimeMs < rebuildStart - 1000) {
            throw new Error(`${built} was not rebuilt for Node ${customVersion}`);
          }
        }
      } catch (error) {
        console.error(`Error: rebuilding native modules for custom Node failed: ${error.message}`);
        process.exit(1);
      }
    }

    // 2. Bundle TypeScript with esbuild
    console.log('\nBundling TypeScript with esbuild...');
    
    // Use deterministic timestamps based on git commit or source
    let buildDate = new Date().toISOString();
    let buildTimestamp = Date.now();
    
    try {
      // Try to use the last commit date for reproducible builds
      const gitDate = execSync('git log -1 --format=%cI', { encoding: 'utf8' }).trim();
      buildDate = gitDate;
      buildTimestamp = new Date(gitDate).getTime();
      console.log(`Using git commit date for reproducible build: ${buildDate}`);
    } catch (e) {
      // Fallback to current time
      console.warn('Warning: Using current time for build - output will not be reproducible');
    }

    let esbuildCmd = `NODE_NO_WARNINGS=1 npx esbuild src/cli.ts \\
      --bundle \\
      --platform=node \\
      --target=node22 \\
      --outfile=build/bundle.js \\
      --format=cjs \\
      --keep-names \\
      --external:authenticate-pam \\
      --external:../build/Release/pty.node \\
      --external:./build/Release/pty.node \\
      --define:process.env.BUILD_DATE='"${buildDate}"' \\
      --define:process.env.BUILD_TIMESTAMP='"${buildTimestamp}"' \\
      --define:process.env.UNTETHER_SEA='"true"'`;
    
    // Also inject git commit hash for version tracking
    try {
      const gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
      esbuildCmd += ` \\\n      --define:process.env.GIT_COMMIT='"${gitCommit}"'`;
    } catch (e) {
      esbuildCmd += ` \\\n      --define:process.env.GIT_COMMIT='"unknown"'`;
    }

    if (includeSourcemaps) {
      esbuildCmd += ' \\\n      --sourcemap=inline \\\n      --source-root=/';
    }

    console.log('Running:', esbuildCmd);
    execSync(esbuildCmd, { 
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1'
      }
    });

    // 2b. Post-process bundle to ensure UNTETHER_SEA is properly set
    console.log('\nPost-processing bundle for SEA compatibility...');
    let bundleContent = fs.readFileSync('build/bundle.js', 'utf8');
    
    // Remove shebang line if present (not valid in SEA bundles)
    if (bundleContent.startsWith('#!')) {
      bundleContent = bundleContent.substring(bundleContent.indexOf('\n') + 1);
    }
    
    // Add UNTETHER_SEA environment variable at the top of the bundle
    // This ensures the patched node-pty knows it's running in SEA mode
    const seaEnvSetup = `// Set UNTETHER_SEA environment variable for SEA mode
if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  process.env.UNTETHER_SEA = 'true';
}

`;
    
    bundleContent = seaEnvSetup + bundleContent;
    
    fs.writeFileSync('build/bundle.js', bundleContent);
    console.log('Bundle post-processing complete');

    // 3. Create SEA configuration
    console.log('\nCreating SEA configuration...');
    const seaConfig = {
      main: 'build/bundle.js',
      output: 'build/sea-prep.blob',
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false
    };

    fs.writeFileSync('build/sea-config.json', JSON.stringify(seaConfig, null, 2));

    // 4. Generate SEA blob
    console.log(`Generating SEA blob with ${selectedNodeVersion}...`);
    execFileSync(nodeExe, ['--experimental-sea-config', 'build/sea-config.json'], {
      stdio: 'inherit'
    });

    // 5. Create executable
    console.log('\nCreating executable...');
    const targetExe = process.platform === 'win32' ? 'native/untether.exe' : 'native/untether';

    // Copy node binary
    fs.copyFileSync(nodeExe, targetExe);
    if (process.platform !== 'win32') {
      fs.chmodSync(targetExe, 0o755);
    }

    // 6. Inject the blob
    console.log('Injecting SEA blob...');
    let postjectCmd = `npx postject ${targetExe} NODE_SEA_BLOB build/sea-prep.blob \\
      --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`;

    if (process.platform === 'darwin') {
      postjectCmd += ' --macho-segment-name NODE_SEA';
    }

    execSync(postjectCmd, { stdio: 'inherit' });

    // 7. Strip the executable first (before signing)
    console.log('Stripping final executable...');
    try {
      execSync(`strip -S ${targetExe} 2>&1 | grep -v "warning: changes being made" || true`, {
        stdio: 'inherit',
        shell: true
      });
    } catch (error) {
      console.warn('Strip command had warnings (this is normal):', error.message);
    }

    // Ensure executable permissions after stripping
    if (process.platform !== 'win32') {
      fs.chmodSync(targetExe, 0o755);
    }
    
    // 8. Sign on macOS (after stripping)
    if (process.platform === 'darwin') {
      console.log('Signing executable...');
      execSync(`codesign --sign - ${targetExe}`, { stdio: 'inherit' });
    }

    // Check final size
    const finalStats = fs.statSync(targetExe);
    console.log(`Final executable size: ${(finalStats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(
      `Embedded payload overhead: ${((finalStats.size - nodeStats.size) / 1024 / 1024).toFixed(2)} MB`
    );

    // 9. Copy native modules
    console.log('\nCopying native modules...');
    
    // Find the actual node-pty build directory (could be in .pnpm directory)
    const nodePtyPath = require.resolve('node-pty/package.json');
    const nodePtyBaseDir = path.dirname(nodePtyPath);
    const nativeModulesDir = path.join(nodePtyBaseDir, 'build/Release');

    // Check if native modules exist
    if (!fs.existsSync(nativeModulesDir)) {
      console.error(`Error: Native modules directory not found at ${nativeModulesDir}`);
      console.error('This usually means the native module build failed.');
      process.exit(1);
    }

    // Copy pty.node
    const ptyNodePath = path.join(nativeModulesDir, 'pty.node');
    if (!fs.existsSync(ptyNodePath)) {
      console.error('Error: pty.node not found. Native module build may have failed.');
      process.exit(1);
    }
    fs.copyFileSync(ptyNodePath, 'native/pty.node');
    console.log('  - Copied pty.node');

    // Copy spawn-helper (macOS only)
    // Note: spawn-helper is only built and required on macOS where it's used for pty_posix_spawn()
    // On Linux, node-pty uses forkpty() directly and doesn't need spawn-helper
    if (process.platform === 'darwin') {
      const spawnHelperPath = path.join(nativeModulesDir, 'spawn-helper');
      if (!fs.existsSync(spawnHelperPath)) {
        console.error('Error: spawn-helper not found. Native module build may have failed.');
        process.exit(1);
      }
      fs.copyFileSync(spawnHelperPath, 'native/spawn-helper');
      fs.chmodSync('native/spawn-helper', 0o755);
      console.log('  - Copied spawn-helper');
    }

    // Copy authenticate_pam.node
    const authPamPath = 'node_modules/authenticate-pam/build/Release/authenticate_pam.node';
    if (fs.existsSync(authPamPath)) {
      fs.copyFileSync(authPamPath, 'native/authenticate_pam.node');
      console.log('  - Copied authenticate_pam.node');
    } else {
      console.error('Error: authenticate_pam.node not found. PAM authentication is required.');
      process.exit(1);
    }

    const buildInfo = {
      schemaVersion: 1,
      customNode: Boolean(customNodePath),
      nodeVersion: selectedNodeVersion,
      nodeSize: nodeStats.size,
      executableSize: finalStats.size,
      platform: process.platform,
      arch: process.arch
    };
    fs.writeFileSync('native/untether-build.json', `${JSON.stringify(buildInfo, null, 2)}\n`);

    console.log('\n✅ Build complete!');
    console.log(`\nPortable executable created in native/ directory:`);
    console.log(`  - untether (executable)`);
    console.log(`  - pty.node`);
    if (process.platform === 'darwin') {
      console.log(`  - spawn-helper`);
    }
    console.log(`  - authenticate_pam.node`);
    console.log(`  - untether-build.json`);
    console.log('\nAll files must be kept together in the same directory.');
    console.log('This bundle will work on any machine with the same OS/architecture.');
    
    // Verify the executable works
    if (process.env.CI || process.argv.includes('--verify')) {
      console.log('\nVerifying native executable...');
      try {
        execSync('node scripts/verify-native.js', { stdio: 'inherit', cwd: __dirname });
      } catch (error) {
        console.error('Native executable verification failed!');
        process.exit(1);
      }
    }

  } catch (error) {
    console.error('\n❌ Build failed:', error.message);
    process.exit(1);
  }
}

main();

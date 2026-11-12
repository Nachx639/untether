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
const { assertAddonsLoad, buildNativeAddonIsolated } = require('./scripts/native-modules.js');

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

    // 1. Build the native modules for the Node the executable embeds, out of node_modules.
    // 2026-11-12: they were rebuilt in node_modules (`node-gyp rebuild --target=<custom Node>`),
    // the tree a running development server loads them from: its authenticate-pam was left
    // built for another ABI and node-pty's spawn-helper went missing while it compiled. Without
    // a custom Node, whatever node_modules held was packed, built for whichever Node last
    // touched it. Both cases now build a copy of the sources in build/native-addons for exactly
    // the Node that is embedded (scripts/native-modules.js buildNativeAddonIsolated).
    console.log(`\nBuilding native modules for Node.js ${selectedNodeVersion} (outside node_modules)...`);
    const addonEnv = customNodePath
      ? createNativeRebuildEnv(process.env, process.execPath, selectedNodeVersion, process.arch)
      : process.env;
    let addons;
    try {
      const options = {
        outDir: path.join(__dirname, 'build', 'native-addons'),
        target: selectedNodeVersion,
        extraArgs: ['--dist-url=https://nodejs.org/dist', `--arch=${process.arch}`],
        env: addonEnv,
      };
      addons = {
        ...buildNativeAddonIsolated('node-pty', options),
        ...buildNativeAddonIsolated('authenticate-pam', options),
      };
      assertAddonsLoad(nodeExe, [addons['pty.node'], addons['authenticate_pam.node']]);
      console.log(`  - pty.node and authenticate_pam.node load with ${nodeExe}`);
    } catch (error) {
      console.error(`Error: building native modules for Node ${selectedNodeVersion} failed: ${error.message}`);
      process.exit(1);
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
    
    for (const [file, from] of Object.entries(addons)) {
      fs.copyFileSync(from, path.join('native', file));
      if (file === 'spawn-helper') fs.chmodSync('native/spawn-helper', 0o755);
      console.log(`  - Copied ${file}`);
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

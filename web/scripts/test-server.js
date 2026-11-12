#!/usr/bin/env node

// Test server runner that builds and runs the JavaScript version to avoid tsx/node-pty issues
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const projectRoot = path.join(__dirname, '..');

// Check if we're in UNTETHER_SEA mode and have the native executable
const nativeExecutable = path.join(projectRoot, 'native/untether');
const distCliPath = path.join(projectRoot, 'dist/cli.js');
let cliPath;
let useNode = true;

function getLatestSourceMtimeMs(dir) {
  let latest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return latest;
  }

  for (const entry of entries) {
    // Skip heavy / irrelevant directories
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '.git' ||
      entry.name === 'native' ||
      entry.name === 'test-results'
    ) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, getLatestSourceMtimeMs(fullPath));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|js|mjs|cjs|json)$/.test(entry.name)) continue;

    try {
      const stat = fs.statSync(fullPath);
      latest = Math.max(latest, stat.mtimeMs);
    } catch {
      // ignore
    }
  }

  return latest;
}

function isDistUpToDate(distPath) {
  try {
    const distStat = fs.statSync(distPath);
    const latestSourceMtimeMs = getLatestSourceMtimeMs(path.join(projectRoot, 'src'));
    return distStat.mtimeMs >= latestSourceMtimeMs;
  } catch {
    return false;
  }
}

function isClientUpToDate() {
  const bundlePaths = [
    path.join(projectRoot, 'public', 'bundle', 'client-bundle.js'),
    path.join(projectRoot, 'public', 'bundle', 'styles.css'),
    path.join(projectRoot, 'public', 'sw.js'),
  ];

  try {
    const latestClientMtimeMs = Math.max(
      getLatestSourceMtimeMs(path.join(projectRoot, 'src', 'client')),
      getLatestSourceMtimeMs(path.join(projectRoot, 'src', 'shared'))
    );

    for (const bundlePath of bundlePaths) {
      const stat = fs.statSync(bundlePath);
      if (stat.mtimeMs < latestClientMtimeMs) return false;
    }

    return true;
  } catch {
    return false;
  }
}

// The native executable only when it is not older than the code (2026-11-11: with UNTETHER_SEA
// set, one left by an earlier build was run as it was, whatever had changed since).
const nativeIsCurrent =
  process.env.UNTETHER_SEA === 'true' &&
  fs.existsSync(nativeExecutable) &&
  isDistUpToDate(nativeExecutable);
if (process.env.UNTETHER_SEA === 'true' && !nativeIsCurrent) {
  console.log('UNTETHER_SEA is set but native/untether is missing or older than src: using the TypeScript build');
}

if (nativeIsCurrent) {
  console.log('Using native executable for tests (UNTETHER_SEA mode)');
  cliPath = nativeExecutable;
  useNode = false;
} else if (fs.existsSync(distCliPath)) {
  // Not forced in CI: the workflow has just built it, and the dates tell when it has not.
  const shouldRebuild = process.env.FORCE_TEST_BUILD === 'true' || !isDistUpToDate(distCliPath);

  if (shouldRebuild) {
    console.log('Building server TypeScript files for tests...');
    try {
      execSync('pnpm exec tsc6 -p tsconfig.server.json', {
        stdio: 'inherit',
        cwd: projectRoot,
      });
      console.log('TypeScript build completed successfully');
    } catch (error) {
      console.error('Failed to build server TypeScript files:', error);
      console.error('Build command exit code:', error.status);
      console.error('Build command signal:', error.signal);
      process.exit(1);
    }
  } else {
    console.log('Using TypeScript compiled version for tests');
  }

  cliPath = distCliPath;
} else {
  // Fallback: build TypeScript files if needed
  console.log('Building server TypeScript files for tests...');
  try {
    execSync('pnpm exec tsc6 -p tsconfig.server.json', {
      stdio: 'inherit',
      cwd: projectRoot
    });
    console.log('TypeScript build completed successfully');
    cliPath = distCliPath;
  } catch (error) {
    console.error('Failed to build server TypeScript files:', error);
    console.error('Build command exit code:', error.status);
    console.error('Build command signal:', error.signal);
    process.exit(1);
  }
}

// Ensure native modules are available
execSync('node scripts/ensure-native-modules.js', { 
  stdio: 'inherit',
  cwd: projectRoot
});

// Ensure static assets exist (incl. ghostty-web WASM in public/)
execSync('node scripts/copy-assets.js', {
  stdio: 'inherit',
  cwd: projectRoot,
});

// Ensure client bundle is up-to-date (Playwright runs against public/bundle)
const shouldRebuildClient = process.env.FORCE_TEST_BUILD === 'true' || !isClientUpToDate();

if (shouldRebuildClient) {
  console.log('Building client bundles for tests...');
  execSync('node scripts/build-client.js', {
    stdio: 'inherit',
    cwd: projectRoot,
  });
} else {
  console.log('Client bundles up-to-date for tests');
}

// Check if the CLI file exists
if (!fs.existsSync(cliPath)) {
  console.error(`CLI not found at ${cliPath}`);
  console.error('Available files:');
  
  // Check native directory
  const nativePath = path.join(projectRoot, 'native');
  if (fs.existsSync(nativePath)) {
    console.error('Native directory contents:');
    const files = fs.readdirSync(nativePath);
    files.forEach(file => console.error(`  - ${file}`));
  }
  
  // Check dist directory
  const distPath = path.join(projectRoot, 'dist');
  if (fs.existsSync(distPath)) {
    console.error('Dist directory contents:');
    const files = fs.readdirSync(distPath);
    files.forEach(file => console.error(`  - ${file}`));
  }
  
  process.exit(1);
}

// Verify executable permissions for native executable
if (!useNode) {
  try {
    fs.accessSync(cliPath, fs.constants.X_OK);
    console.log('Native executable has execute permissions');
  } catch (error) {
    console.error('Native executable is not executable! Attempting to fix...');
    try {
      fs.chmodSync(cliPath, 0o755);
      console.log('Fixed executable permissions');
    } catch (chmodError) {
      console.error('Failed to fix permissions:', chmodError.message);
    }
  }
}

// Prepare arguments based on whether we're using node or native executable
const args = useNode ? [cliPath, ...process.argv.slice(2)] : process.argv.slice(2);
const command = useNode ? 'node' : cliPath;

// The port is the caller's choice (playwright.config.ts picks a free one per run): never a default
// another run or another checkout could be using.
const portArgIndex = process.argv.indexOf('--port');
const port = portArgIndex === -1 ? Number.NaN : Number(process.argv[portArgIndex + 1]);
if (!Number.isInteger(port) || port <= 0) {
  console.error('test-server.js needs --port <number>');
  process.exit(1);
}

// Spawn the server
console.log(`Starting test server: ${command} ${args.join(' ')}`);
console.log(`Working directory: ${projectRoot}`);
console.log(`Port: ${port}`);

// Capture output for debugging in CI
const stdio = process.env.CI ? ['inherit', 'pipe', 'pipe'] : 'inherit';

// The test server never touches the real install: a throwaway HOME and control dir of its own.
// 2026-11-10: it ran with the developer's HOME and no UNTETHER_CONTROL_DIR, so a local
// `pnpm run test:e2e` listed, typed into and deleted sessions of ~/.untether/control, took
// ~/.untether/api.sock and wrote to the real log (CI never showed it: its HOME is disposable).
// In /tmp, not os.tmpdir(): each session has a unix socket under the control dir (104 characters
// at most on macOS) and macOS's per-user temporary folder alone takes half of that.
const testHomeBase = fs.realpathSync(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir());
// Playwright ends this script with SIGKILL when a run is over, so its own cleanup below does not
// always run: folders of earlier runs whose script is gone are removed here (owner pid in .pid).
for (const name of fs.readdirSync(testHomeBase)) {
  if (!name.startsWith('ut-pw-')) continue;
  const stale = path.join(testHomeBase, name);
  let owner = 0;
  try {
    owner = Number(fs.readFileSync(path.join(stale, '.pid'), 'utf8'));
  } catch {
    continue; // not one of ours, or still being created
  }
  let alive = true;
  try {
    process.kill(owner, 0);
  } catch (error) {
    alive = error.code === 'EPERM';
  }
  if (alive) continue;
  removeTestHomeAt(stale);
}

/** Ends the shield tmux server of that folder's control dir (its own socket) and removes the folder. */
function removeTestHomeAt(home) {
  try {
    execSync('tmux -S "$UT_PW_SOCKET" kill-server', {
      stdio: 'ignore',
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        TMUX_TMPDIR: path.join(home, 'tmux'),
        UT_PW_SOCKET: path.join(home, '.untether', 'control', '.shield-tmux'),
      },
    });
  } catch {
    // No server left (the usual case).
  }
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}

const testHome = fs.mkdtempSync(
  path.join(testHomeBase, 'ut-pw-')
);
fs.writeFileSync(path.join(testHome, '.pid'), String(process.pid));
const testControl = path.join(testHome, '.untether', 'control');
fs.mkdirSync(testControl, { recursive: true });
fs.mkdirSync(path.join(testHome, 'tmux'), { recursive: true });
const testEnv = {
  ...process.env,
  // Ensure we're not in SEA mode for tests (unless we're already using the native executable)
  UNTETHER_SEA: useNode ? '' : 'true',
  PORT: port.toString(),
  HOME: testHome,
  UNTETHER_CONTROL_DIR: testControl,
  TMUX_TMPDIR: path.join(testHome, 'tmux'),
  // Nothing of the Mac outside that folder: no Tailscale routes, no launchd job, no fixed ports
  // the real server holds (same as scripts/gemelo.sh).
  UNTETHER_SKIP_TAILSCALE: '1',
  UNTETHER_SHIELD_LAUNCHD: '0',
  UNTETHER_CONNECTOR_PORT: 'off',
  UNTETHER_PREVIEW_PORT: 'off',
  // The real server's doctor removes the folder if this run dies without cleaning up.
  UNTETHER_TEST_RUN_DIR: testHome,
  // The server ends when this script is gone, however it went (server-config.ts).
  UNTETHER_EXIT_WITH_PARENT: '1',
};
// Never the developer's tmux server (a session of theirs may be where this runs).
delete testEnv.TMUX;
delete testEnv.TMUX_PANE;
console.log(`Test HOME: ${testHome}`);

let cleaned = false;
function removeTestHome() {
  if (cleaned) return;
  cleaned = true;
  removeTestHomeAt(testHome);
}

const child = spawn(command, args, {
  stdio: stdio,
  cwd: projectRoot,
  env: testEnv,
});

// Playwright stops this script with a signal: the server goes first, then its folder.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.once('exit', () => {
        removeTestHome();
        process.exit(0);
      });
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    } else {
      removeTestHome();
      process.exit(0);
    }
  });
}

// Capture output in CI for debugging
let stdout = '';
let stderr = '';
let hasExited = false;

if (process.env.CI) {
  child.stdout.on('data', (data) => {
    const str = data.toString();
    stdout += str;
    process.stdout.write(str);
  });
  
  child.stderr.on('data', (data) => {
    const str = data.toString();
    stderr += str;
    process.stderr.write(str);
  });
}

// Add error handling
child.on('error', (error) => {
  console.error('Failed to start server process:', error);
  if (error.code === 'ENOENT') {
    console.error('The executable was not found. Path:', command);
  } else if (error.code === 'EACCES') {
    console.error('The executable does not have execute permissions');
  }
  removeTestHome();
  process.exit(1);
});

// Log when process starts
child.on('spawn', () => {
  console.log('Server process spawned successfully');
  console.log(`Server PID: ${child.pid}`);
});

// Handle early exit
child.on('exit', (code, signal) => {
  hasExited = true;
  if (code !== 0 || signal) {
    console.error(`\nServer process exited unexpectedly with code ${code}, signal ${signal}`);
    if (stderr) {
      console.error('Last stderr output:', stderr.slice(-1000));
    }
    if (stdout) {
      console.error('Last stdout output:', stdout.slice(-1000));
    }
    
    // If using native executable, try to diagnose the issue
    if (!useNode && process.env.CI) {
      console.error('\nAttempting to diagnose native executable issue...');
      try {
        // Try running with --version to see if it works at all
        const versionResult = require('child_process').spawnSync(cliPath, ['--version'], {
          encoding: 'utf8',
          env: { ...process.env, NODE_ENV: 'test' }
        });
        console.error('Version test result:', versionResult);
      } catch (e) {
        console.error('Failed to run version test:', e.message);
      }
    }
  }
  removeTestHome();
  // A server killed by a signal has no code: that is a failure, not a clean exit.
  process.exit(code ?? 1);
});

// Wait for server to be ready before allowing parent process to continue
if (process.env.CI || process.env.WAIT_FOR_SERVER) {
  // Give server a moment to start
  setTimeout(() => {
    if (hasExited) {
      console.error('Server exited before we could check if it was ready');
      return;
    }
    
    const waitChild = spawn('node', [path.join(projectRoot, 'scripts/wait-for-server.js')], {
      stdio: 'inherit',
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: port.toString()
      }
    });
    
    waitChild.on('exit', (code) => {
      if (code !== 0) {
        console.error('Server failed to become ready');
        child.kill();
        process.exit(1);
      } else {
        console.log('Server is ready, tests can proceed');
        
        // In CI, add periodic health checks
        if (process.env.CI) {
          const healthCheckInterval = setInterval(() => {
            if (hasExited) {
              clearInterval(healthCheckInterval);
              return;
            }
            
            const http = require('http');
            http.get(`http://localhost:${port}/api/health`, (res) => {
              if (res.statusCode !== 200) {
                console.error(`Health check failed with status ${res.statusCode}`);
              }
            }).on('error', (err) => {
              console.error(`Health check error: ${err.message}`);
            });
          }, 10000); // Check every 10 seconds
        }
      }
    });
  }, 3000); // Wait 3 seconds before checking
}

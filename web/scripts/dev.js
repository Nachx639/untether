const { spawn } = require('child_process');
const path = require('path');
const esbuild = require('esbuild');
const { devOptions, clientAppBuild, cleanClientChunks } = require('./esbuild-config.js');
const {
  devServerAuthArgs,
  moveLocalAuthTokenToEnv,
  LOCAL_AUTH_TOKEN_ENV,
} = require('./dev-auth-args.js');

console.log('Starting development mode...');

// Validate version sync first
require('child_process').execSync('node scripts/validate-version-sync.js', { stdio: 'inherit' });

// node-pty is a local native module: `pnpm update` relinks it without its build, and the
// server cannot open a terminal without it (2026-10-20). Rebuilt here when missing.
require('child_process').execSync('node scripts/ensure-native-modules.js', { stdio: 'inherit' });

// Parse command line arguments using Node's built-in parseArgs
const { parseArgs } = require('util');

const { values, positionals } = parseArgs({
  options: {
    'client-only': {
      type: 'boolean',
      default: false,
    },
    port: {
      type: 'string',
    },
    bind: {
      type: 'string',
    },
  },
  allowPositionals: true,
  strict: false, // Allow unknown options to be passed through
});

const watchServer = !values['client-only'];

// Build server args from parsed values and pass through all unknown args
const serverArgs = [];
if (values.port) {
  serverArgs.push('--port', values.port);
}
if (values.bind) {
  serverArgs.push('--bind', values.bind);
}

// Pass through all command line args except the ones we handle
const allArgs = process.argv.slice(2);
const handledArgs = new Set(['--client-only']);

// Track which indices we've already processed to avoid duplicates
const processedIndices = new Set();

// Add indices of handled args to processedIndices
for (let i = 0; i < allArgs.length; i++) {
  const arg = allArgs[i];
  if (arg === '--client-only') {
    processedIndices.add(i);
  } else if (arg === '--port' && values.port) {
    processedIndices.add(i);
    if (i + 1 < allArgs.length && allArgs[i + 1] === values.port) {
      processedIndices.add(i + 1);
    }
  } else if (arg === '--bind' && values.bind) {
    processedIndices.add(i);
    if (i + 1 < allArgs.length && allArgs[i + 1] === values.bind) {
      processedIndices.add(i + 1);
    }
  }
}

// Known boolean flags that don't take values
const booleanFlags = new Set([
  '--verbose', '-v',
  '--debug', '-d',
  '--quiet', '-q',
  '--force', '-f',
  '--help', '-h',
  '--version',
  '--no-auth',
  '--inspect',
  '--trace-warnings'
]);

// Add any args that weren't handled by parseArgs
for (let i = 0; i < allArgs.length; i++) {
  const arg = allArgs[i];
  
  // Skip the '--' separator that pnpm adds
  if (arg === '--') {
    continue;
  }
  
  // Skip if we've already processed this index
  if (processedIndices.has(i)) {
    continue;
  }
  
  // Add the argument
  serverArgs.push(arg);
  
  // Check if this is a flag that takes a value
  if (arg.startsWith('-') && !booleanFlags.has(arg)) {
    // If next arg exists and doesn't start with -, treat it as a value
    if (i + 1 < allArgs.length && !allArgs[i + 1].startsWith('-')) {
      serverArgs.push(allArgs[i + 1]);
      processedIndices.add(i + 1);
      i++; // Skip the value in next iteration
    }
  }
}

// Initial build of assets and CSS
console.log('Initial build...');
require('child_process').execSync('node scripts/ensure-dirs.js', { stdio: 'inherit' });
require('child_process').execSync('node scripts/copy-assets.js', { stdio: 'inherit' });
// The stylesheet is built after the first app build below: it declares that build's id.
// In-process watcher, not `postcss --watch` (~95 % of a core, see scripts/css-watch.js).
const startStyles = () =>
  require('./css-watch.js').watchStyles({
    input: path.resolve(__dirname, '../src/client/styles.css'),
    output: path.resolve(__dirname, '../public/bundle/styles.css'),
    plugins: require('../postcss.config.js').plugins,
  });

// Build the command parts
const commands = [];

// Password login needs the authenticate-pam native module. pnpm never builds it (the package
// only ships a binding.gyp) and 1.0.5 needs patches/authenticate-pam@1.0.5.patch for Node 24+.
// Without it every phone login fails while the app requires auth (2026-10-02), so rebuild it.
function ensurePasswordLogin() {
  const { execSync } = require('child_process');
  const canLoad = () => {
    try {
      execSync(`"${process.execPath}" -e "require('authenticate-pam')"`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  if (canLoad()) return;
  console.warn('authenticate-pam is not built; rebuilding it for password login...');
  try {
    const dir = path.dirname(require.resolve('authenticate-pam/package.json'));
    execSync('npx --yes node-gyp rebuild', { cwd: dir, stdio: 'ignore' });
  } catch (error) {
    console.error('authenticate-pam rebuild failed:', error.message);
  }
  if (!canLoad()) {
    console.error(
      'ERROR: password login is unavailable (authenticate-pam). Remote logins will fail until it builds.'
    );
  }
}

// Add server watching if not client-only
let serverCommand = null;
if (watchServer) {
  // Plain `pnpm run dev` stays open for local hacking; with server arguments (the Mac app
  // always passes some) the caller owns auth. See scripts/dev-auth-args.js.
  const authArgs = devServerAuthArgs(serverArgs);
  if (![...authArgs, ...serverArgs].includes('--no-auth')) ensurePasswordLogin();
  // Never on a command line: into the environment the watcher inherits (dev-auth-args.js).
  const watchedArgs = moveLocalAuthTokenToEnv(serverArgs, process.env);
  // Not `tsx watch`: scripts/server-watch.js batches the restarts merges cause (2026-11-02).
  serverCommand = ['node', ['scripts/server-watch.js', ...authArgs, ...watchedArgs]];
  commands.push(serverCommand);
}

/** How often the dev server looks for a new Node on PATH (see currentNode). */
const NODE_CHECK_MS = 5000;
/** How long after a watched process ends on its own it is started again. */
const PROCESS_RESTART_MS = 2000;

/** The real path of the `node` a fresh `pnpm exec` would run, or null when none is found. */
function currentNode() {
  const fs = require('fs');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      return fs.realpathSync(path.join(dir, 'node'));
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

// Set up esbuild contexts for watching
async function startBuilding() {
  try {
    // Create esbuild contexts
    cleanClientChunks();
    const clientContext = await esbuild.context({
      ...devOptions,
      ...clientAppBuild,
    });

    const testContext = await esbuild.context({
      ...devOptions,
      entryPoints: ['src/client/test-entry.ts'],
      outfile: 'public/bundle/test.js',
    });


    const swContext = await esbuild.context({
      ...devOptions,
      entryPoints: ['src/client/sw.ts'],
      outfile: 'public/sw.js',
      format: 'iife', // Service workers need IIFE format
    });

    // The app first, then the stylesheet with its build id, before anything watches: the CSS
    // watcher rebuilds when public/bundle/.build-id changes, and a change it hasn't started
    // watching yet would leave the pair on two ids (scripts/client-build-id.js).
    await clientContext.rebuild();
    const styles = startStyles();
    await styles.ready;

    // Start watching
    await clientContext.watch();
    await testContext.watch();
    await swContext.watch();
    console.log('ESBuild watching client bundles...');

    const assets = require('./assets-watch.js').watchAssets();

    // Start other processes
    const startProcess = ([cmd, args], index) => {
      // Create env without UNTETHER_SEA for development mode
      const env = { ...process.env };
      delete env.UNTETHER_SEA;
      // The local auth token is for the server watcher only, not the asset watchers.
      if (commands[index] !== serverCommand) delete env[LOCAL_AUTH_TOKEN_ENV];
      
      const proc = spawn(cmd, args, { 
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: env
      });
      
      proc.on('error', (err) => {
        console.error(`Process ${index} error:`, err);
      });
      // A process that ends on its own (not stopped, not being replaced for a new node) starts
      // again: without the server watcher dev mode stays up with nobody running the server.
      proc.on('exit', (code, signal) => {
        if (stopping || restartingServer || processes[index] !== proc) return;
        console.error(`Process ${index} exited (${signal ?? code}); starting it again...`);
        setTimeout(() => {
          if (stopping || processes[index] !== proc) return;
          processes[index] = startProcess(commands[index], index);
        }, PROCESS_RESTART_MS).unref();
      });
      
      return proc;
    };
    const processes = commands.map(startProcess);

    // 2026-10-18: `brew upgrade` replaced Node (and the libsimdjson it links) under a running
    // dev server. `tsx watch` keeps restarting the server with the Node it started on, which
    // now died in dyld ("Library not loaded: libsimdjson.33.dylib"), and the server stayed
    // down until the Mac app noticed (~50 s). When the node on PATH changes, the server
    // watcher starts again on the new one.
    const serverIndex = watchServer ? processes.length - 1 : -1;
    let watchedNode = currentNode();
    let restartingServer = false;
    const nodeCheck = setInterval(() => {
      const node = currentNode();
      if (serverIndex < 0 || restartingServer || !node || node === watchedNode) return;
      console.log(`Node changed (${watchedNode} -> ${node}); restarting the server watcher...`);
      watchedNode = node;
      restartingServer = true;
      const old = processes[serverIndex];
      const restart = () => {
        if (stopping) return;
        processes[serverIndex] = startProcess(commands[serverIndex], serverIndex);
        restartingServer = false;
      };
      if (old.exitCode !== null || old.signalCode !== null) return restart();
      old.once('exit', restart);
      old.kill('SIGTERM');
    }, NODE_CHECK_MS);
    nodeCheck.unref();

    // Handle exit. SIGTERM matters as much as SIGINT: the Mac app stops the dev server with
    // SIGTERM, and without a handler this process died alone, leaving `tsx watch` and the
    // server holding the port (2026-10-12). Children get SIGTERM, then SIGKILL after 3 s.
    let stopping = false;
    const stopAll = async (signal) => {
      if (stopping) return;
      stopping = true;
      clearInterval(nodeCheck);
      styles.close();
      console.log(`\nStopping all processes (${signal})...`);
      const forceTimer = setTimeout(() => {
        processes.forEach((proc) => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        });
        process.exit(0);
      }, 3000);
      forceTimer.unref();
      processes.forEach((proc) => proc.kill('SIGTERM'));
      await Promise.allSettled([
        assets.close(), clientContext.dispose(), testContext.dispose(), swContext.dispose(),
      ]);
      await Promise.all(
        processes.map((proc) =>
          proc.exitCode !== null || proc.signalCode !== null
            ? Promise.resolve()
            : new Promise((resolve) => proc.once('exit', resolve))
        )
      );
      process.exit(0);
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(signal, () => stopAll(signal));
    }

    console.log(`Development mode started (${watchServer ? 'full' : 'client only'})`);
  } catch (error) {
    console.error('Failed to start build:', error);
    process.exit(1);
  }
}

startBuilding();

const path = require('path');
const { LOCAL_AUTH_TOKEN_ENV } = require('./dev-auth-args.js');

/** Watch after dev.js's initial copy, batching changes without overlapping copy processes. */
function watchAssets({
  watch = require('chokidar').watch,
  spawn = require('child_process').spawn,
  debounceMs = 400,
  log = (message) => console.error(message),
} = {}) {
  const cwd = path.resolve(__dirname, '..');
  const env = { ...process.env };
  delete env.UNTETHER_SEA;
  delete env[LOCAL_AUTH_TOKEN_ENV];
  let timer = null;
  let child = null;
  let pending = false;
  let closed = false;
  let copying = Promise.resolve();
  let closing = null;

  const copy = () => {
    if (closed || child || !pending) return;
    pending = false;
    try {
      child = spawn(process.execPath, [path.join(__dirname, 'copy-assets.js')], {
        cwd,
        env,
        stdio: 'inherit',
        shell: false,
      });
    } catch (error) {
      log(`assets-watch: copy failed: ${error.message}`);
      return;
    }
    copying = new Promise((resolve) => {
      child.once('error', (error) => log(`assets-watch: copy failed: ${error.message}`));
      // 'close', including after a spawn error, means the process and its stdio are done.
      child.once('close', (code, signal) => {
        child = null;
        if (!closed && code !== 0) log(`assets-watch: copy exited with ${signal || code}`);
        resolve();
        if (!timer) copy();
      });
    });
  };

  // Chokidar 5 watches directories recursively; it no longer expands glob patterns.
  const watcher = watch(
    [path.join(cwd, 'src/client/assets'), path.join(cwd, 'src/client/styles/looks')],
    { ignoreInitial: true }
  );
  watcher.on('all', () => {
    if (closed) return;
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      copy();
    }, debounceMs);
  });
  watcher.on('error', (error) => log(`assets-watch: watcher failed: ${error.message}`));

  return {
    close() {
      if (closing) return closing;
      closed = true;
      if (timer) clearTimeout(timer);
      const active = child;
      // Finish before dev.js's three-second shutdown deadline, even if a copy hangs.
      const forceTimer = active && setTimeout(() => active.kill('SIGKILL'), 1000);
      if (forceTimer) forceTimer.unref();
      if (active) active.kill('SIGTERM');
      closing = Promise.all([watcher.close(), copying]).finally(() => {
        if (forceTimer) clearTimeout(forceTimer);
      });
      return closing;
    },
  };
}

module.exports = { watchAssets };

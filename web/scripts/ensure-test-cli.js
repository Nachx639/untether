const fs = require('fs');
const path = require('path');
const { buildCli } = require('./build-cli.js');

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Newest change under src that the CLI bundle is made from: not the client, not the tests. */
function newestCliSourceMtimeMs(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'client' || entry.name === 'test' || entry.name === 'node_modules') continue;
      newest = Math.max(newest, newestCliSourceMtimeMs(fullPath));
    } else if (entry.isFile() && /\.(ts|js|json)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      newest = Math.max(newest, fs.statSync(fullPath).mtimeMs);
    }
  }
  return newest;
}

/**
 * 2026-11-10 (scripts/docs audit): the bundle was built only when missing, so after the first
 * `pnpm test` in a checkout every later run tested the CLI as it was that day. It is rebuilt
 * whenever a source file it is made from is newer.
 */
function cliBundleIsStale(bundledCliPath, srcDir) {
  let bundleMtimeMs;
  try {
    bundleMtimeMs = fs.statSync(bundledCliPath).mtimeMs;
  } catch {
    return true;
  }
  return newestCliSourceMtimeMs(srcDir) > bundleMtimeMs;
}

/**
 * The CLI the tests start: native/untether-test, a launcher of the bundle made from the code as
 * it is now. 2026-11-11: with a native/untether in the checkout (left by any build of the Mac
 * app) nothing was built and the tests ran that binary, however old; and a test file run on its
 * own in a checkout without a build (a task's worktree) found no CLI at all. It is always the
 * bundle, and the tests that need it call this themselves.
 */
async function ensureTestCli() {
  const webRoot = path.join(__dirname, '..');
  const bundledCliPath = path.join(webRoot, 'dist', 'untether-cli');
  if (cliBundleIsStale(bundledCliPath, path.join(webRoot, 'src'))) {
    // 2026-10-23: sessions the dev server starts inherit NODE_ENV=development, which makes the
    // node-pty plugin bundle node-pty itself ("No loader is configured for .node files"), so
    // `pnpm test` failed here in every fresh worktree. The test CLI always takes the stub.
    if (process.env.NODE_ENV === 'development') delete process.env.NODE_ENV;
    await buildCli();
  }

  const testCliPath = path.join(webRoot, 'native', 'untether-test');
  const launcher = `#!/bin/sh
exec ${shellQuote(process.execPath)} ${shellQuote(bundledCliPath)} "$@"
`;

  fs.mkdirSync(path.dirname(testCliPath), { recursive: true });
  let current;
  try {
    current = fs.readFileSync(testCliPath, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== launcher) {
    // Written aside and renamed: a test starting it meanwhile never reads half a file.
    const temporary = `${testCliPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, launcher, { encoding: 'utf8', mode: 0o755 });
    fs.renameSync(temporary, testCliPath);
    console.log(`Created test CLI launcher: ${testCliPath}`);
  }
  return testCliPath;
}

if (require.main === module) {
  ensureTestCli().catch((error) => {
    console.error('Failed to prepare the test CLI:', error);
    process.exit(1);
  });
}

module.exports = { cliBundleIsStale, ensureTestCli };

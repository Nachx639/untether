/**
 * The hash of a ut-fwd source tree (src/**, Cargo.toml, Cargo.lock), written next to each
 * forwarder binary the build makes as `<binary>.source-hash` (2026-11-02: comparing mtimes made
 * every checkout or merge that touched native/ut-fwd look like a source change, and rebuilt the
 * forwarder for nothing). The doctor (web/src/server/services/doctor-checks-build.ts,
 * forwarderSourceHash) computes the same hash; a test keeps both in step.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function forwarderSourceFiles(sourceDir) {
  const files = [];
  for (const name of ['Cargo.toml', 'Cargo.lock']) {
    try {
      if (fs.statSync(path.join(sourceDir, name)).isFile()) files.push(name);
    } catch {
      // Not there: not part of the hash.
    }
  }
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(sourceDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  walk('src');
  return files.sort();
}

/** sha256 over each file's path (relative, `/`-separated) and contents, in path order. */
function forwarderSourceHash(sourceDir) {
  const hash = crypto.createHash('sha256');
  for (const rel of forwarderSourceFiles(sourceDir)) {
    const body = fs.readFileSync(path.join(sourceDir, ...rel.split('/')));
    hash.update(`${rel}\0${body.length}\0`);
    hash.update(body);
  }
  return hash.digest('hex');
}

/** The hash file recorded next to a forwarder binary. */
function sourceHashFile(binary) {
  return `${binary}.source-hash`;
}

/** Writes the hash next to the binary (aside, then renamed: never half a hash). */
function writeSourceHash(binary, sourceHash) {
  const file = sourceHashFile(binary);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${sourceHash}\n`);
  fs.renameSync(temp, file);
}

function readSourceHash(binary) {
  try {
    return fs.readFileSync(sourceHashFile(binary), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Newest change time of the forwarder's sources (its Cargo files and src/, not target/). */
function newestForwarderSource(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name.startsWith('.')) continue;
    const file = path.join(dir, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestForwarderSource(file) : fs.statSync(file).mtimeMs
    );
  }
  return newest;
}

/**
 * Whether any of the built copies is behind the sources. Each copy is judged on its own: by its
 * recorded hash when it has one, by mtimes only when it has none yet (AI review 2026-11-02: one
 * copy without a hash made both fall back to mtimes, so a copy whose hash said "old" passed as
 * current with a recent mtime).
 */
function forwarderStale(sourceDir, binaries) {
  if (!fs.existsSync(sourceDir)) return false;
  let current;
  let newest;
  return binaries.some((binary) => {
    const recorded = readSourceHash(binary);
    if (recorded) {
      current ??= forwarderSourceHash(sourceDir);
      return recorded !== current;
    }
    newest ??= newestForwarderSource(sourceDir);
    return newest > fs.statSync(binary).mtimeMs;
  });
}

module.exports = {
  forwarderSourceHash,
  forwarderStale,
  readSourceHash,
  sourceHashFile,
  writeSourceHash,
};

/**
 * The forwarder the tests run (native/ut-fwd/target/<profile>/untether-fwd) built again when
 * its sources are newer than it. 2026-11-02: server code began using a new forwarder option
 * (--compact-cast-until) while the binaries in task worktrees were older builds, so the
 * session-recordings tests failed in every task's check until someone ran cargo by hand.
 * A checkout that never built it (no target/) and a machine without cargo are left alone.
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Newest modification time of the files under `dir` (recursively), 0 when there are none. */
export function newestMtime(dir: string): number {
  let newest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else if (entry.isFile()) newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

/** The profiles whose built binary is older than the crate's sources. */
export function staleForwarderProfiles(crate: string): string[] {
  const sources = Math.max(
    newestMtime(path.join(crate, 'src')),
    ...['Cargo.toml', 'Cargo.lock'].map((name) => {
      try {
        return fs.statSync(path.join(crate, name)).mtimeMs;
      } catch {
        return 0;
      }
    })
  );
  const stale: string[] = [];
  for (const profile of ['release', 'debug']) {
    const binary = path.join(crate, 'target', profile, 'untether-fwd');
    if (!fs.existsSync(binary)) continue;
    if (fs.statSync(binary).mtimeMs < sources) stale.push(profile);
  }
  return stale;
}

/** Rebuilds the stale profiles; returns what it did, for the run's log. */
export function refreshForwarder(crate: string): string | undefined {
  const stale = staleForwarderProfiles(crate);
  if (stale.length === 0) return undefined;
  try {
    for (const profile of stale) {
      execFileSync('cargo', ['build', ...(profile === 'release' ? ['--release'] : [])], {
        cwd: crate,
        stdio: 'ignore',
        timeout: 5 * 60_000,
      });
    }
    return `rebuilt the forwarder (${stale.join(', ')}): its sources were newer`;
  } catch (error) {
    return `the forwarder (${stale.join(', ')}) is older than its sources and could not be rebuilt: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/** Whether `cargo` answers, so the forwarder can be built from source. */
function cargoAvailable(): boolean {
  try {
    return spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** Where the e2e tests look for the forwarder (src/test/e2e/*.e2e.test.ts `resolveForwarderPath`). */
export function installedForwarderPaths(webRoot: string): string[] {
  return [path.join(webRoot, 'native', 'untether-fwd'), path.join(webRoot, 'bin', 'untether-fwd')];
}

/** Modification time of `file`, or 0 when it is not there. */
function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Builds the release binary when there is none, then copies it to each given install path. */
export function installForwarder(crate: string, dests: string[]): string | undefined {
  if (dests.length === 0) return undefined;
  const releaseBinary = path.join(crate, 'target', 'release', 'untether-fwd');
  if (!fs.existsSync(releaseBinary)) {
    if (!cargoAvailable()) {
      return 'the forwarder is not built and cargo is not available to build it';
    }
    try {
      execFileSync('cargo', ['build', '--release'], {
        cwd: crate,
        stdio: 'ignore',
        timeout: 5 * 60_000,
      });
    } catch (error) {
      return `the forwarder could not be built: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  try {
    for (const dest of dests) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(releaseBinary, dest);
      fs.chmodSync(dest, 0o755);
    }
    return `installed the forwarder for the tests (${dests
      .map((dest) => path.basename(path.dirname(dest)))
      .join(', ')})`;
  } catch (error) {
    return `the forwarder could not be installed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Make sure the forwarder the e2e tests run exists and is current. 2026-11-08: a change to a
 * widely-imported file pulls the ut-wrapper/forwarder e2e tests into `vitest related`, and in a
 * fresh task worktree they failed hard ("untether-fwd not found") — the worktree never built the
 * binary and refreshForwarder only rebuilds an existing one. It now also builds and installs the
 * binary where the tests look when it is missing there. A machine without cargo is left alone (the
 * message says so; nothing this can do). Returns a one-line note for the run's log, or undefined.
 *
 * A stale install is refreshed too: after refreshForwarder rebuilds the binary (its Rust sources
 * changed), web/native and web/bin keep the older copies the e2e tests would run, so any install
 * older than the freshly built binary is copied over again, not only a missing one.
 */
export function ensureForwarder(crate: string, webRoot: string): string | undefined {
  const notes: string[] = [];
  const refreshed = refreshForwarder(crate);
  if (refreshed) notes.push(refreshed);
  const releaseMtime = mtimeOf(path.join(crate, 'target', 'release', 'untether-fwd'));
  const outdated = installedForwarderPaths(webRoot).filter((dest) => {
    const destMtime = mtimeOf(dest);
    // Missing, or older than the built binary (a rebuild left this copy behind).
    return destMtime === 0 || (releaseMtime > 0 && destMtime < releaseMtime);
  });
  const installed = installForwarder(crate, outdated);
  if (installed) notes.push(installed);
  return notes.length ? notes.join('; ') : undefined;
}

import fs from 'node:fs';
import path from 'node:path';

/**
 * The real forwarder this checkout built (cargo build in native/ut-fwd), when it is built from
 * the sources it has now.
 *
 * 2026-11-02: a task worktree built untether-fwd, then merged its base, which added
 * `--compact-cast-until`. The binary in target/ was older than its sources and the doctor test
 * failed with "untether-fwd: invalid arguments". A binary older than any of its sources is not
 * this checkout's forwarder: those tests then use their stand-in, as when cargo never ran.
 */
const NATIVE_DIR = path.resolve(__dirname, '../../../../native/ut-fwd');

function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(full));
    else newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

export function builtForwarder(): string | undefined {
  if (!fs.existsSync(path.join(NATIVE_DIR, 'src'))) return undefined;
  let sources = newestSourceMtime(path.join(NATIVE_DIR, 'src'));
  for (const file of ['Cargo.toml', 'Cargo.lock']) {
    const full = path.join(NATIVE_DIR, file);
    if (fs.existsSync(full)) sources = Math.max(sources, fs.statSync(full).mtimeMs);
  }
  return ['release', 'debug']
    .map((profile) => path.join(NATIVE_DIR, 'target', profile, 'untether-fwd'))
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).mtimeMs >= sources);
}

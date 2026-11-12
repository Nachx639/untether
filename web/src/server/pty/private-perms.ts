/**
 * Untether's state is private to the user: sessions' output (stdout casts), session.json,
 * uploads, logs, notifications, projects and tasks. 2026-10-20 audit: each session's ipc.sock
 * was chmod 0666 (any local user could type into a session), ~/.untether and control/<id>/
 * were 0755 and the files in them 0644, readable by every account on the Mac.
 *
 * The state folder is kept 0700 (checked on every start): nothing under it can then be read by
 * another account. Files the session code writes get 0600 and folders 0700 themselves; what was
 * written before is fixed once by securePrivateTree (group and other bits removed, nothing else
 * changed, nothing deleted). No process-wide umask: sessions' programs inherit the server's,
 * and the user's own files (a git checkout by Claude) must keep their usual modes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('private-perms');

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Marker of a finished one-time fix (bump the version to run it again). */
export const PERMS_MARKER = '.private-perms-v1';
const MAX_DEPTH = 8;
const MAX_ENTRIES = 50_000;

/**
 * The Untether state folder holding `controlPath`: its parent when that is a `.untether`
 * folder (~/.untether/control), else the control folder itself.
 */
export function untetherStateRoot(controlPath: string): string {
  const parent = path.dirname(path.resolve(controlPath));
  return path.basename(parent) === '.untether' ? parent : path.resolve(controlPath);
}

/**
 * Remove group and other permission bits under `root` (the root included), once: files and
 * folders owned by this user only, symlinks never followed, at most MAX_DEPTH levels and
 * MAX_ENTRIES entries. Owner bits (an executable's x) stay. Returns how many were changed.
 */
export function securePrivateTree(root: string, options: { force?: boolean } = {}): number {
  const marker = path.join(root, PERMS_MARKER);
  const uid = process.getuid?.();
  if (uid === undefined) return 0;
  // The folder itself on every start: while it is 0700 nothing in it can be read by another
  // account, whatever mode a later writer gives its files.
  if (!options.force && fs.existsSync(marker)) return makePrivate(root, uid) ? 1 : 0;
  let changed = 0;
  let seen = 0;
  const visit = (entry: string, depth: number) => {
    if (seen++ > MAX_ENTRIES) return;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entry);
    } catch {
      return;
    }
    if (stat.isSymbolicLink() || stat.uid !== uid) return;
    if ((stat.mode & 0o077) !== 0) {
      try {
        fs.chmodSync(entry, stat.mode & 0o700);
        changed++;
      } catch (error) {
        logger.debug(`could not make ${entry} private: ${error}`);
      }
    }
    if (!stat.isDirectory() || depth >= MAX_DEPTH) return;
    let children: string[];
    try {
      children = fs.readdirSync(entry);
    } catch {
      return;
    }
    for (const child of children) visit(path.join(entry, child), depth + 1);
  };
  visit(root, 0);
  try {
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: PRIVATE_FILE_MODE });
  } catch (error) {
    logger.debug(`could not write ${marker}: ${error}`);
  }
  if (changed) logger.log(`made ${changed} files and folders under ${root} private to the user`);
  return changed;
}

function makePrivate(entry: string, uid: number): boolean {
  try {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) === 0) return false;
    fs.chmodSync(entry, stat.mode & 0o700);
    return true;
  } catch {
    return false;
  }
}

/** securePrivateTree for the state folder of `controlPath`, never the home folder itself. */
export function secureUntetherState(controlPath: string): number {
  const root = untetherStateRoot(controlPath);
  if (root === os.homedir() || root === path.parse(root).root) return 0;
  try {
    return securePrivateTree(root);
  } catch (error) {
    logger.warn(`could not make ${root} private: ${error}`);
    return 0;
  }
}

import { execFile } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname } from 'node:path';

const LSOF = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : '/usr/bin/lsof';
const EXECUTABLES = new Set([
  '/usr/bin/tailscaled',
  '/usr/sbin/tailscaled',
  '/usr/local/bin/tailscaled',
  '/opt/homebrew/bin/tailscaled',
]);

// Team ID: https://tailscale.com/docs/integrations/mdm/mac
// Verify the running PID, not an on-disk path that could be replaced after launch.
const MAC_TAILSCALE_REQUIREMENT =
  '=anchor apple generic and certificate leaf[subject.OU] = "W5364U7YZB" and ' +
  '(identifier "io.tailscale.ipn.macsys" or identifier "io.tailscale.ipn.macos" or ' +
  'identifier "io.tailscale.ipn.macsys.network-extension" or ' +
  'identifier "io.tailscale.ipn.macos.network-extension")';

function inspect(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3000, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolve(!error && typeof stdout === 'string' ? stdout : null)
    );
  });
}

function knownDaemon(file: string): boolean {
  if (EXECUTABLES.has(file)) return true;
  // lsof reports the mapped Cellar executable, not Homebrew's bin symlink. Protect that
  // executable and its parents; the bin directory is not an ancestor of the running code.
  return [...EXECUTABLES].some((installed) => {
    try {
      return realpathSync(installed) === file;
    } catch {
      return false;
    }
  });
}

/** A known executable that another local account cannot replace, including via a parent. */
export function isProtectedTailscaleExecutable(file: string, ownerUid = 0): boolean {
  if (!knownDaemon(file)) return false;
  try {
    // Check both the named path and its resolved path, including symlink parents.
    for (const start of new Set([file, realpathSync(file)])) {
      let current = start;
      while (true) {
        const stat = lstatSync(current);
        if (
          (stat.uid !== 0 && stat.uid !== ownerUid) ||
          (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)
        )
          return false;
        if (current === start && !stat.isFile() && !stat.isSymbolicLink()) return false;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Kernel-reported owner and code identity, never argv or the process name. On macOS,
 * validate Tailscale's signature on the running process: /Applications is normally 0775
 * and App Store extensions run as the logged-in user. Only root or the server account may
 * supply identity. Unsigned daemons still need protected executable mappings; a privileged
 * server never trusts another account's Homebrew installation.
 */
export async function isTrustedTailscaleProcess(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const mac = platform() === 'darwin';
  const ownerUid = mac ? (process.geteuid?.() ?? 0) : 0;
  if (mac) {
    const uid = (await inspect('/bin/ps', ['-p', String(pid), '-o', 'uid=']))?.trim();
    if (!uid || !/^\d+$/.test(uid) || (Number(uid) !== 0 && Number(uid) !== ownerUid)) return false;
    const signed = await inspect('/usr/bin/codesign', [
      '--verify',
      '--strict',
      '-R',
      MAC_TAILSCALE_REQUIREMENT,
      String(pid),
    ]);
    if (signed !== null) return true;
  }
  const output = await inspect(LSOF, ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-Fpun']);
  if (output === null) return false;
  const lines = output.split('\n');
  if (lines.filter((line) => line.startsWith('p')).join() !== `p${pid}`) return false;
  const uid = lines.filter((line) => line.startsWith('u')).join();
  if (uid !== 'u0' && uid !== `u${ownerUid}`) return false;
  return lines.some(
    (line) => line.startsWith('n') && isProtectedTailscaleExecutable(line.slice(1), ownerUid)
  );
}

/**
 * The doctor's checks of sessions and their tmux: moved projects, replaced sessions, shields,
 * environments and what test runs left behind.
 */

import * as path from 'path';
import { isServerRuntimeVar } from '../utils/session-env.js';
import { execFileAsync, MINUTE } from './doctor-checks-shared.js';
import { shieldLaunchdLabel, shieldSocketArgs } from './shielded-tmux.js';
import { STABLE_TMUX_IDENTIFIER, type StableTmuxStatus } from './stable-tmux.js';
import {
  envFromPsE,
  isUnder,
  isUserControlDir,
  markerEnded,
  parsePs,
  pidAlive,
  type ShieldServerInfo,
  shieldSelection,
  shieldServers,
  TEST_RUN_ENV,
  type TestDirInfo,
  type TestMarker,
  testRunEnded,
} from './stray-tmux.js';
import type { DoctorCheck, DoctorFinding } from './untether-doctor.js';

/**
 * Stores still keyed by a folder a project moved away from (2026-10-25: toolshed renamed to
 * bakery left orchestrators.json on toolshed and `ut project tell bakery` failed). Every
 * known move is told again to every store that follows them; one that changed is reported.
 */
export function movedProjectsCheck(deps: {
  /** ProjectSettingsStore.replayMoves: the followers that still held an old folder. */
  replay: () => Promise<Array<{ name: string; changed: number }>>;
}): DoctorCheck {
  return {
    id: 'moved-projects',
    async run() {
      return (await deps.replay()).map(({ name, changed }) => ({
        key: `moved-projects:${name}`,
        check: 'moved-projects',
        severity: 'warning' as const,
        problem: `${name}: ${changed} entr${changed === 1 ? 'y' : 'ies'} still on the old folder of a moved project`,
        healed: 'moved to the current folder',
      }));
    },
  };
}

/**
 * Stores still pointing at a session that ended while its Claude conversation runs on in
 * another one: a reopen (Blindar, Llevar a Untether, a resume) whose SessionReplacements call
 * never came, or a store that did not follow it (2026-10-25: moving bakery's orchestrator
 * out of its Terminal window had to carry its role, its tasks and its confirmations). Each such
 * id is followed to the session that runs the conversation now, through the same registry.
 */
export function replacedSessionsCheck(deps: {
  sessions: () => Array<{ id: string; status: string; claudeSessionId?: string }>;
  /** Every session id a store keeps (tasks, orchestrators, confirmations…). */
  referenced: () => string[];
  /** SessionReplacements.replaced: every store follows `from` to `to`; the ones that moved. */
  follow: (from: string, to: string) => Promise<Array<{ name: string; moved: number }>>;
}): DoctorCheck {
  return {
    id: 'replaced-sessions',
    async run() {
      const sessions = deps.sessions();
      const byId = new Map(sessions.map((session) => [session.id, session]));
      const live = new Map<string, string[]>();
      for (const session of sessions) {
        if (session.status !== 'running' || !session.claudeSessionId) continue;
        live.set(session.claudeSessionId, [
          ...(live.get(session.claudeSessionId) ?? []),
          session.id,
        ]);
      }
      const findings: DoctorFinding[] = [];
      for (const id of new Set(deps.referenced())) {
        const old = byId.get(id);
        if (!old || old.status === 'running' || !old.claudeSessionId) continue;
        const now = live.get(old.claudeSessionId) ?? [];
        // One session runs it: two would be a conflict for the user, not something to guess.
        if (now.length !== 1 || now[0] === id) continue;
        const moves = await deps.follow(id, now[0]);
        // 2026-10-25: it reported "healed" with nothing moved; a store that keeps the id but
        // won't move it is not something left behind.
        if (moves.length === 0) continue;
        const stores = moves.map(({ name, moved }) => `${name} (${moved})`).join(', ');
        findings.push({
          key: `replaced-sessions:${id}`,
          check: 'replaced-sessions',
          severity: 'warning',
          problem: `session ${id} ended but its conversation runs in ${now[0]}; still pointing at ${id}: ${stores}`,
          healed: `followed to ${now[0]}`,
        });
      }
      return findings;
    },
  };
}

/** Claude conversations running unshielded: a server restart ends them mid-work. */
export function unshieldedCheck(deps: {
  sessions: () => Array<{
    id: string;
    name?: string;
    status: string;
    shielded?: boolean;
    claude?: boolean;
  }>;
  shieldAvailable: () => boolean;
}): DoctorCheck {
  return {
    id: 'unshielded',
    run() {
      if (!deps.shieldAvailable()) return [];
      return deps
        .sessions()
        .filter((session) => session.status === 'running' && session.claude && !session.shielded)
        .map((session) => ({
          key: `unshielded:${session.id}`,
          check: 'unshielded',
          severity: 'info' as const,
          problem: `Claude session ${session.id.slice(0, 8)} "${session.name ?? ''}" runs unshielded: a restart would end it`,
        }));
    },
  };
}

/**
 * Sessions that started with the server's runtime environment (2026-10-24: every task's Claude
 * had NODE_ENV=development from the dev server through the shield tmux server, and `vite
 * build` in another project bundled React the development way). Heals the shield tmux
 * server's environment; a running program keeps the one it started with, so those are told:
 * restarting the session gives it a clean one.
 */
export function sessionEnvCheck(deps: {
  cleanShieldEnvironment: () => Promise<string[]>;
  /** Running sessions with the pid of the program Untether started in each. */
  sessions: () => Array<{ id: string; name?: string; pid?: number }>;
  /** Names in a process's environment, or null when it can't be read. */
  envNames: (pid: number) => Promise<string[] | null>;
}): DoctorCheck {
  return {
    id: 'session-env',
    async run() {
      const findings: DoctorFinding[] = [];
      const removed = await deps.cleanShieldEnvironment();
      if (removed.length) {
        findings.push({
          key: 'session-env:shield-tmux',
          check: 'session-env',
          severity: 'warning',
          problem: `the shield tmux server handed new sessions ${removed.join(', ')}`,
          healed: 'removed from its environment',
        });
      }
      for (const session of deps.sessions()) {
        if (!session.pid) continue;
        const leaked = ((await deps.envNames(session.pid)) ?? []).filter(isServerRuntimeVar);
        if (!leaked.length) continue;
        findings.push({
          key: `session-env:${session.id}`,
          check: 'session-env',
          severity: 'warning',
          problem: `session ${session.id.slice(0, 8)} "${session.name ?? ''}" runs with Untether's own ${leaked.join(', ')}: builds and tests there behave as in Untether's dev server until it restarts`,
        });
      }
      return findings;
    },
  };
}

/** Names in the environment `ps -wwE` prints after a process's command line. */
export function envNamesFromPs(output: string): string[] {
  const names = new Set<string>();
  for (const token of output.trim().split(/\s+/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token);
    if (match) names.add(match[1]);
  }
  return [...names];
}

/** Names in a process's environment (macOS `ps -E`; the user's own processes only). */
export async function processEnvNames(pid: number): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-wwE', '-o', 'command=', '-p', String(pid)], {
      timeout: 10_000,
    });
    return envNamesFromPs(stdout);
  } catch {
    return null;
  }
}

/**
 * The stable, user-signed tmux copy (stable-tmux.ts, 2026-10-31: every `brew upgrade tmux`
 * gave tmux a new ad hoc identity and macOS forgot its Full Disk Access). Renews the copy when
 * the installed tmux changed (running shield servers keep theirs) and tells, once while it
 * lasts, what it can't fix: a signing that failed (not retried on its own, so no keychain
 * prompt in a loop) or the permission missing for the copy.
 *
 * The old tmux (2026-10-31, the user: no rubbish left from the move): its Full Disk Access
 * entry stays in System Settings and only the user can remove it. While any Untether tmux
 * server on the shield socket still runs another binary nothing is said (it still needs that
 * permission); once every one runs the copy and the copy has the permission, the user's phone
 * is told once that the old one can go, and never again.
 */
export function stableTmuxCheck(deps: {
  refresh: () => Promise<StableTmuxStatus>;
  /** Executables of every tmux server on the shield socket (null: unreadable). */
  serverBinaries: () => Promise<string[] | null>;
  /** Full Disk Access of the running shield tmux server, as macOS sees it. */
  fullDiskAccess: () => Promise<'granted' | 'denied' | 'no-server' | 'unknown'>;
  /** The tmux before the copy, kept in tmux.json (StableTmux). */
  oldTmux: {
    note: (binary: string) => void;
    toTell: () => string | null;
    told: () => void;
  };
  /** Tells the user the old tmux can leave Full Disk Access: true when it reached them. */
  tellOldTmux: (binary: string) => Promise<boolean>;
}): DoctorCheck {
  return {
    id: 'stable-tmux',
    async run() {
      const status = await deps.refresh();
      const findings: DoctorFinding[] = [];
      const finding = (key: string, severity: DoctorFinding['severity'], problem: string) =>
        findings.push({ key: `stable-tmux:${key}`, check: 'stable-tmux', severity, problem });
      switch (status.state) {
        case 'off':
          return [];
        case 'no-source':
          finding('no-source', 'info', 'a tmux signing identity is set but tmux is not installed');
          return findings;
        case 'failed':
          finding(
            'sign-failed',
            'warning',
            `the stable tmux copy could not be signed with identity ${status.identity}: ${status.error}. Shielded sessions run ${status.bin ?? 'the installed tmux'}${status.bin ? '' : ', whose macOS permissions are lost on every tmux upgrade'}. Not retried until tmux or the identity changes, or the setting is saved again`
          );
          return findings;
        case 'deferred':
          finding(
            `deferred:${status.version}`,
            'info',
            `tmux ${status.version} is installed but can't talk to the running shield tmux server (${status.running ?? 'older'}): the stable copy moves to it once that server ends`
          );
          return findings;
        case 'renewed':
          // Recorded in the doctor's history; info is not told to anyone.
          finding(
            `renewed:${status.version}`,
            'info',
            `the stable tmux copy was renewed to tmux ${status.version}${status.from ? ` (was ${status.from})` : ''}: ${status.reason}`
          );
          break;
        case 'current':
          break;
      }
      const servers = await deps.serverBinaries();
      if (!servers?.length) return findings;
      const copy = path.resolve(status.bin);
      const old = [...new Set(servers.filter((bin) => path.resolve(bin) !== copy))];
      if (old.length) {
        deps.oldTmux.note(old[0]);
        finding(
          'server-not-copy',
          'info',
          `${old.length === servers.length ? 'the shield tmux server runs' : `${old.length} of the shield tmux servers run`} ${old.join(', ')}, not the stable copy ${status.bin}: they move to the copy the next time they start`
        );
        return findings;
      }
      if ((await deps.fullDiskAccess()) === 'denied') {
        finding(
          'no-full-disk-access',
          'warning',
          `the stable tmux copy ${status.bin} (${STABLE_TMUX_IDENTIFIER}) has no Full Disk Access: shielded sessions can't read protected folders. Add it in System Settings → Privacy & Security → Full Disk Access`
        );
        return findings;
      }
      const leftover = deps.oldTmux.toTell();
      if (leftover && (await deps.tellOldTmux(leftover))) {
        deps.oldTmux.told();
        finding(
          'old-tmux-permission',
          'info',
          `every shield tmux server runs the stable copy: told the user they can remove the old tmux (${leftover}) from Full Disk Access`
        );
      }
      return findings;
    },
  };
}

/** An unmarked shield tmux server is told from this age. */
export const STRAY_SHIELD_MIN_AGE_MS = 6 * 60 * MINUTE;

/**
 * Shield tmux servers left by tests and QA starts (2026-11-01: four had run 18-20 days with idle
 * bash panes, and one QA `-L untether-<hash>` server had no session at all). Only a server the
 * test harness marked (UNTETHER_TEST_RUN_DIR in its environment) whose run has ended and with no
 * client attached is closed; what runs in its panes never decides it. Any other shield server
 * that is not the active control dir's nor the user's own (~/.untether*\/control), with no client
 * and older than STRAY_SHIELD_MIN_AGE_MS, is told, never closed.
 */
export function strayShieldTmuxCheck(deps: {
  activeControlDir: string;
  servers: () => Promise<ShieldServerInfo[]>;
  /** Kills a server (and unloads its launchd job): true when it is gone. */
  close: (server: ShieldServerInfo) => Promise<boolean>;
  isUserControlDir?: (dir: string) => boolean;
  testRunEnded?: (runDir: string) => boolean;
  minAgeMs?: number;
}): DoctorCheck {
  const userDir = deps.isUserControlDir ?? isUserControlDir;
  const ended = deps.testRunEnded ?? ((runDir: string) => testRunEnded(runDir));
  const minAge = deps.minAgeMs ?? STRAY_SHIELD_MIN_AGE_MS;
  const active = shieldSocketArgs(deps.activeControlDir).join(' ');
  return {
    id: 'stray-shield-tmux',
    async run() {
      const findings: DoctorFinding[] = [];
      for (const server of await deps.servers()) {
        const selection = server.select.join(' ');
        if (selection === active) continue;
        if (server.controlDir && isUnder(server.controlDir, [deps.activeControlDir])) continue;
        if (server.controlDir && userDir(server.controlDir)) continue;
        if (server.clients > 0) continue;
        const hours = (server.ageMs / (60 * MINUTE)).toFixed(1);
        const programs = [...new Set(server.programs)];
        const what = `shield tmux server ${server.pid} (tmux ${selection}${server.controlDir ? `, control dir ${server.controlDir}` : ''}) has run ${hours} h with no Untether attached${programs.length ? `, running ${programs.join(', ')}` : ', with no session'}`;
        const key = `stray-shield-tmux:${selection}`;
        if (server.testRunDir) {
          if (!ended(server.testRunDir)) continue;
          const closed = await deps.close(server).catch(() => false);
          findings.push({
            key,
            check: 'stray-shield-tmux',
            severity: 'warning',
            problem: `${what}; its test run ${server.testRunDir} has ended${closed ? '' : ' and closing it failed'}`,
            ...(closed ? { healed: 'closed' } : {}),
          });
          continue;
        }
        if (server.ageMs < minAge) continue;
        findings.push({
          key,
          check: 'stray-shield-tmux',
          severity: 'warning',
          problem: `${what}. Not started by a test run, so not closed: end it with 'tmux ${selection} kill-server' if nobody needs it`,
        });
      }
      return findings;
    },
  };
}

/** Unmarked test-looking dirs untouched this long are told. */
export const STALE_TEST_DIR_AGE_MS = 24 * 60 * MINUTE;

/**
 * Temporary dirs of tests and QA starts (2026-11-01, with the stray shield servers). A dir the
 * test harness marked (stray-tmux.ts) is removed, exactly that dir, once its marker ended (pid
 * gone, or over 6 h old) and no process has it as cwd, among its open files or as HOME. Unmarked
 * dirs that look like a test's or a QA start's (a run dir, an Untether home or control dir right
 * in /tmp or $TMPDIR) untouched for STALE_TEST_DIR_AGE_MS are only told, all in one finding.
 */
export function staleTestDirsCheck(deps: {
  dirs: () => TestDirInfo[];
  /** Whether a live process uses the dir (cwd, open files, HOME); unknown counts as yes. */
  inUse: (dir: string) => Promise<boolean>;
  remove: (dir: string) => void;
  markerEnded?: (marker: TestMarker) => boolean;
  now?: () => number;
  minAgeMs?: number;
}): DoctorCheck {
  const now = deps.now ?? Date.now;
  const ended = deps.markerEnded ?? ((marker: TestMarker) => markerEnded(marker, now()));
  const minAge = deps.minAgeMs ?? STALE_TEST_DIR_AGE_MS;
  return {
    id: 'stale-test-dirs',
    async run() {
      const findings: DoctorFinding[] = [];
      const unmarked: string[] = [];
      for (const info of deps.dirs()) {
        if (!info.marker) {
          if (now() - info.touchedAt >= minAge) unmarked.push(info.dir);
          continue;
        }
        if (!ended(info.marker)) continue;
        if (await deps.inUse(info.dir).catch(() => true)) continue;
        const key = `stale-test-dir:${info.dir}`;
        const problem = `test dir ${info.dir} (marked by pid ${info.marker.pid}, which has ended) was left behind`;
        try {
          deps.remove(info.dir);
          findings.push({
            key,
            check: 'stale-test-dirs',
            severity: 'info',
            problem,
            healed: 'removed',
          });
        } catch (error) {
          findings.push({
            key,
            check: 'stale-test-dirs',
            severity: 'warning',
            problem: `${problem}; removing it failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      if (unmarked.length) {
        findings.push({
          key: 'stale-test-dirs:unmarked',
          check: 'stale-test-dirs',
          severity: 'info',
          problem: `${unmarked.length} unmarked test/QA dir(s) untouched for over a day, not removed (no test harness marker): ${unmarked.slice(0, 10).join(', ')}${unmarked.length > 10 ? ', …' : ''}`,
        });
      }
      return findings;
    },
  };
}

/** The shield tmux servers on this Mac, from `ps` (their environment read with `ps -E`). */
export async function scanShieldServers(): Promise<ShieldServerInfo[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,etime=,command='], {
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows = parsePs(stdout);
  const envs = new Map<number, Record<string, string> | null>();
  for (const row of rows) {
    if (row.ppid !== 1 || !shieldSelection(row.command)) continue;
    envs.set(
      row.pid,
      await execFileAsync('ps', ['-wwE', '-o', 'command=', '-p', String(row.pid)], {
        timeout: 10_000,
      })
        .then(({ stdout: out }) => envFromPsE(out, ['HOME', 'UNTETHER_CONTROL_DIR', TEST_RUN_ENV]))
        .catch(() => null)
    );
  }
  return shieldServers(rows, (pid) => envs.get(pid) ?? null);
}

/** Ends a shield server: its launchd job first (when its control dir is known), then SIGTERM, then SIGKILL. */
export async function closeShieldServer(server: ShieldServerInfo): Promise<boolean> {
  const uid = process.getuid?.();
  if (process.platform === 'darwin' && uid !== undefined && server.controlDir) {
    await execFileAsync('launchctl', [
      'bootout',
      `gui/${uid}/${shieldLaunchdLabel(server.controlDir)}`,
    ]).catch(() => undefined);
  }
  const alive = () => pidAlive(server.pid);
  try {
    process.kill(server.pid, 'SIGTERM');
  } catch {
    return !alive();
  }
  for (let i = 0; i < 30 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (alive()) {
    try {
      process.kill(server.pid, 'SIGKILL');
    } catch {
      // Gone meanwhile.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !alive();
}

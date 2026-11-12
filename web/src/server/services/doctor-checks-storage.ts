/**
 * The doctor's checks of what Untether keeps on disk: recordings, the control folder, the
 * log, free space and backups.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TaskRecord } from '../../shared/tasks.js';
import type { Session } from '../../shared/types.js';
import { type BackupdWatch, type BackupExclusion, describeBackupd } from './backup-exclusion.js';
import { execFileAsync, HOUR, MINUTE, readTail } from './doctor-checks-shared.js';
import {
  type CastCompactor,
  type CompactResult,
  controlDirUsage,
  diskBytes,
  rotateCasts,
  rotationLimits,
} from './session-recordings.js';
import type { DoctorCheck, DoctorFinding } from './untether-doctor.js';

/**
 * Session recordings stay bounded on disk (session-recordings.ts). They grew without end: an
 * Inkwell orchestrator's reached 760 MB, 2026-10-22 a Claude session up for four days 1.6 GB of
 * a 3.3 GB control dir, and 2026-11-01 the control dir held 4.7 GB though every replay reads
 * at most the last 16 MB. A live cast using more than its cap of disk (config
 * recordings.rotateMB, 64 MB) is rotated: the forwarder punches its old middle out
 * (native/ut-fwd/src/cast_compact.rs), its header and last half stay, as do its size and every
 * offset, and a snapshot of the terminal size and modes goes into the end of the hole. That is
 * routine, only logged; a cast still over the cap afterwards is the finding (no forwarder that
 * knows --compact-cast, an error). Measured by real disk use, never by size, which stays.
 */
export function bigCastsCheck(deps: {
  controlDir: string;
  compact: CastCompactor;
  /** The cap and what stays; read on every run (the config may change). */
  limits?: () => { rotateBytes: number; keepBytes: number };
  log?: (message: string) => void;
}): DoctorCheck {
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  return {
    id: 'big-casts',
    async run() {
      const { rotateBytes: cap, keepBytes: keep } = (
        deps.limits ?? (() => rotationLimits(undefined))
      )();
      let entries: string[];
      try {
        entries = fs.readdirSync(deps.controlDir);
      } catch {
        return [];
      }
      const big = new Map<string, number>();
      for (const entry of entries) {
        const file = path.join(deps.controlDir, entry, 'stdout');
        try {
          const bytes = diskBytes(file);
          if (bytes > cap) big.set(file, bytes);
        } catch {
          // No recording.
        }
      }
      if (big.size === 0) return [];
      let results: Map<string, CompactResult>;
      try {
        results = await rotateCasts([...big.keys()], cap, keep, deps.compact, deps.log);
      } catch (error) {
        results = new Map([...big.keys()].map((file) => [file, { error: String(error) }]));
      }
      const findings: DoctorFinding[] = [];
      for (const [file, before] of big) {
        const session = path.basename(path.dirname(file));
        let after = before;
        try {
          after = diskBytes(file);
        } catch {
          continue; // Gone meanwhile.
        }
        if (after <= cap) {
          deps.log?.(
            `rotated the recording of session ${session}: ${mb(before)} → ${mb(after)} MB on disk`
          );
          continue;
        }
        const why = results.has(file)
          ? results.get(file)?.error
          : 'the forwarder did not report on it';
        findings.push({
          key: `big-cast:${session}`,
          check: 'big-casts',
          severity: 'warning',
          problem: `the recording of session ${session.slice(0, 8)} uses ${mb(after)} MB of disk and could not be shrunk${why ? `: ${why}` : ''}`,
        });
      }
      return findings;
    },
  };
}

/**
 * Compacts casts with the first forwarder among `candidates` that knows --compact-cast (an older
 * one, like the Mac app's until it is rebuilt, rejects the option and the next is tried).
 */
export function compactCastsWithForwarder(candidates: () => string[]): CastCompactor {
  return async (files, capBytes, keepBytes, holeEnd) => {
    const failures: string[] = [];
    for (const forwarder of new Set(candidates())) {
      if (!fs.existsSync(forwarder)) continue;
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          forwarder,
          holeEnd === undefined
            ? ['--compact-cast', String(capBytes), String(keepBytes), ...files]
            : ['--compact-cast-until', String(capBytes), String(holeEnd), ...files],
          { timeout: 5 * MINUTE, maxBuffer: 4 * 1024 * 1024 }
        ));
      } catch (error) {
        const { stderr, message } = error as { stderr?: string; message: string };
        failures.push(`${forwarder}: ${stderr?.trim() || message.split('\n')[0]}`);
        continue;
      }
      const results = new Map<string, CompactResult>();
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as {
            path?: string;
            error?: string;
            report?: { punched?: number };
          };
          if (!parsed.path) continue;
          results.set(
            parsed.path,
            parsed.error
              ? { error: parsed.error }
              : { punched: Number(parsed.report?.punched) || 0 }
          );
        } catch {
          // Not ours.
        }
      }
      return results;
    }
    throw new Error(
      failures.length > 0
        ? `no forwarder knows --compact-cast${holeEnd === undefined ? '' : '-until'} (${failures.join('; ')})`
        : 'no untether-fwd found'
    );
  };
}

/**
 * CONTROL_DIR's disk use over a threshold (config recordings.controlWarnGB, 3 GB): what uses it,
 * so the next growth is seen before the disk fills (2026-11-01: 4.7 GB in 245 folders, the
 * disk at 1 GB free). Session folders are named with their state and title.
 */
export function controlDirCheck(deps: {
  controlDir: string;
  warnBytes: () => number;
  sessions: () => Pick<Session, 'id' | 'name' | 'status' | 'suspended'>[];
}): DoctorCheck {
  const size = (bytes: number) =>
    bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
      : `${Math.round(bytes / 1024 ** 2)} MB`;
  return {
    id: 'control-dir',
    run() {
      const usage = controlDirUsage(deps.controlDir);
      const warn = deps.warnBytes();
      if (usage.totalBytes <= warn) return [];
      const sessions = new Map(deps.sessions().map((session) => [session.id, session]));
      let live = 0;
      let finished = 0;
      let other = 0;
      for (const entry of usage.entries) {
        const session = sessions.get(entry.name);
        if (!session) other += entry.bytes;
        else if (session.status === 'exited' && !session.suspended) finished += entry.bytes;
        else live += entry.bytes;
      }
      const biggest = usage.entries.slice(0, 5).map((entry) => {
        const session = sessions.get(entry.name);
        const what = session
          ? `${entry.name.slice(0, 8)} «${session.name}» (${session.suspended ? 'suspended' : session.status === 'exited' ? 'finished' : 'running'})`
          : entry.name;
        return `${what} ${size(entry.bytes)}`;
      });
      return [
        {
          key: 'control-dir:big',
          check: 'control-dir',
          severity: 'warning',
          problem: `${deps.controlDir} uses ${size(usage.totalBytes)} of disk (over ${size(warn)}): running or suspended sessions ${size(live)}, finished ${size(finished)}, the rest ${size(other)}; biggest: ${biggest.join(', ')}. Finished sessions' recordings are trimmed after config recordings.finishedDays, live ones rotated past recordings.rotateMB`,
        },
      ];
    },
  };
}

/** A burst of errors in the server log: the same message many times in a few minutes. */
export function logErrorsCheck(deps: {
  logPath: () => string;
  now?: () => number;
  windowMs?: number;
  threshold?: number;
}): DoctorCheck {
  const now = deps.now ?? Date.now;
  const window = deps.windowMs ?? 10 * MINUTE;
  const threshold = deps.threshold ?? 30;
  return {
    id: 'log-errors',
    run() {
      const text = readTail(deps.logPath(), 2 * 1024 * 1024);
      const counts = new Map<string, number>();
      for (const line of text.split('\n')) {
        const match = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+ERROR\s+(.*)$/.exec(line);
        if (!match) continue;
        if (now() - Date.parse(match[1]) > window) continue;
        // The same error for other ids, ports, tokens counts as one.
        const shape = match[2]
          .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
          .replace(/\d+/g, '<n>')
          .slice(0, 160);
        counts.set(shape, (counts.get(shape) ?? 0) + 1);
      }
      return Array.from(counts.entries())
        .filter(([, count]) => count >= threshold)
        .map(([shape, count]) => ({
          key: `log-errors:${shape}`,
          check: 'log-errors',
          severity: 'warning' as const,
          problem: `${count} errors in ${Math.round(window / MINUTE)} min: ${shape}`,
        }));
    },
  };
}

/**
 * Free disk space: casts, worktrees and caches stop when the disk fills. 2026-11-01: the
 * finding said only "1 GB free" while claude-mem's index had grown to 81 GB; with `growth` it
 * names what grew lately (disk-growth.ts), and keeps a baseline while the disk is nearly low
 * (under twice the minimum, or under 10 % of the volume) to compare with.
 */
export function diskCheck(deps: {
  dir: string;
  minFreeBytes?: number;
  statfs?: (dir: string) => { freeBytes: number; totalBytes: number };
  growth?: { baseline(): Promise<void>; describe(): Promise<string> };
}): DoctorCheck {
  const min = deps.minFreeBytes ?? 5 * 1024 * 1024 * 1024;
  const statfs =
    deps.statfs ??
    ((dir: string) => {
      const stat = fs.statfsSync(dir);
      return { freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
    });
  return {
    id: 'disk',
    async run() {
      const { freeBytes: free, totalBytes: total } = statfs(deps.dir);
      if (free >= min) {
        if (deps.growth && (free < 2 * min || (total > 0 && free < total * 0.1))) {
          await deps.growth.baseline().catch(() => undefined);
        }
        return [];
      }
      const growing = deps.growth ? await deps.growth.describe().catch(() => '') : '';
      return [
        {
          key: 'disk:low',
          check: 'disk',
          severity: 'critical',
          problem: `only ${(free / 1024 / 1024 / 1024).toFixed(1)} GB free on the disk of ${deps.dir}${
            growing ? `; growing lately: ${growing}` : '; nothing big found growing lately'
          }`,
        },
      ];
    },
  };
}

/** Hours backupd must stay busy before the doctor names it. */
export const BACKUPD_BUSY_HOURS = 2;

/**
 * Untether's disposable folders still in Time Machine (2026-11-02: a 14 h backup of 339 GB,
 * mostly task worktrees, recordings and task logs, kept the load at 28 and held task admission
 * over an hour). With config.json excludeFromBackups on (the default) each one found included
 * is marked excluded now; with it off the doctor says nothing (the user chose).
 */
export function backupExclusionCheck(deps: {
  exclusion: Pick<
    BackupExclusion,
    'enabled' | 'available' | 'allowed' | 'isExcluded' | 'exclude' | 'forget'
  >;
  dirs: () => string[];
}): DoctorCheck {
  return {
    id: 'backup-exclusion',
    async run() {
      const { exclusion } = deps;
      if (!exclusion.enabled() || !exclusion.available()) return [];
      const findings: DoctorFinding[] = [];
      for (const dir of deps.dirs()) {
        if (!exclusion.allowed(dir)) continue;
        const excluded = await exclusion.isExcluded(dir);
        if (excluded !== false) continue;
        // Unmarked since (by hand, a restore): ask tmutil again.
        exclusion.forget(dir);
        const healed = (await exclusion.exclude(dir)) && (await exclusion.isExcluded(dir)) === true;
        findings.push({
          key: `backup-exclusion:${dir}`,
          check: 'backup-exclusion',
          severity: healed ? 'info' : 'warning',
          problem: `${dir} (Untether's own, disposable) was included in Time Machine backups`,
          ...(healed ? { healed: `excluded it (tmutil addexclusion ${dir})` } : {}),
        });
        if (!healed) {
          findings[findings.length - 1].problem +=
            `; tmutil addexclusion failed, run it by hand or set excludeFromBackups: false in config.json`;
        }
      }
      return findings;
    },
  };
}

/**
 * Time Machine's backupd at high CPU for hours (2026-11-02: 14 h at ~100%). Told once it has
 * kept at least half a core busy for BACKUPD_BUSY_HOURS, with the tasks it keeps waiting.
 */
export function backupdCpuCheck(deps: {
  watch: Pick<BackupdWatch, 'sample' | 'busy'>;
  tasks: () => TaskRecord[];
}): DoctorCheck {
  return {
    id: 'backupd-cpu',
    async run() {
      await deps.watch.sample();
      const busy = deps.watch.busy();
      if (!busy || busy.forMs < BACKUPD_BUSY_HOURS * HOUR) return [];
      const waiting = deps
        .tasks()
        .filter((task) => task.state === 'queued' && task.queued?.resources?.short.length).length;
      return [
        {
          key: 'backupd-cpu',
          check: 'backupd-cpu',
          severity: waiting ? 'warning' : 'info',
          problem: `${describeBackupd(busy)}${waiting ? `; ${waiting} task(s) wait for room on the Mac partly because of it` : ''}; it ends on its own ('tmutil stopbackup' stops it now)`,
        },
      ];
    },
  };
}

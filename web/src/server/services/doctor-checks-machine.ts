/**
 * The doctor's checks of the Mac and of Untether's own configuration: memory and load, the
 * security sweep, config.json.
 */

import type { TaskRecord } from '../../shared/tasks.js';
import { describeBackupd } from './backup-exclusion.js';
import { HOUR, MINUTE } from './doctor-checks-shared.js';
import { BACKUPD_BUSY_HOURS } from './doctor-checks-storage.js';
import {
  describeMemoryHolders,
  describeSample,
  GRANT_STALL_WARN,
  type MemoryHolder,
  type ResourceMonitor,
} from './resource-monitor.js';
import type { DoctorCheck, DoctorFinding } from './untether-doctor.js';

/**
 * The resource sampler behind task admission (2026-11-01, resource-monitor.ts): it failing
 * means tasks start without looking at the Mac's room (it fails open), so the doctor says so;
 * tasks that have waited for room over an hour are named with what is short, so a threshold
 * set too tight (or something else eating the Mac) is seen instead of a silent queue.
 */
export function resourcesCheck(deps: {
  monitor: Pick<ResourceMonitor, 'latest' | 'lastError' | 'settings'> &
    Partial<
      Pick<
        ResourceMonitor,
        'lastStartedAt' | 'steadySwapGrant' | 'grantStalls' | 'forcedGrants' | 'room'
      >
    >;
  tasks: () => TaskRecord[];
  /**
   * The programs holding the most memory (2026-11-07), named as a hint when tasks wait on a
   * high but steady swap; nothing is killed.
   */
  memoryHolders?: () => Promise<MemoryHolder[]>;
  /** Time Machine's backupd busy for a while (2026-11-02): named as a reason for the wait. */
  backupd?: () => { forMs: number; share: number } | null;
  now?: () => number;
}): DoctorCheck {
  const now = deps.now ?? Date.now;
  return {
    id: 'resources',
    async run() {
      const findings: DoctorFinding[] = [];
      if (!deps.monitor.settings().enabled) return findings;
      const error = deps.monitor.lastError();
      const latest = deps.monitor.latest();
      if (error || !latest || now() - latest.at > 2 * MINUTE) {
        findings.push({
          key: 'resources:sampler',
          check: 'resources',
          severity: 'warning',
          problem: `the memory/CPU sampler has no fresh sample${error ? ` (${error})` : ''}: new tasks start without waiting for room`,
        });
      }
      // 2026-11-11: how full the Mac is against the admission target and how many more tasks
      // fit, or why none is let in. Always there (info), so a slow line is read in one look.
      const room = deps.monitor.room?.();
      if (room) {
        findings.push({
          key: 'resources:room',
          check: 'resources',
          severity: 'info',
          problem: `task admission: ${room.line}`,
        });
      }
      const waiting = deps
        .tasks()
        .filter(
          (task) =>
            task.state === 'queued' &&
            task.queued?.resources?.short.length &&
            now() - Date.parse(task.stateSince) > 60 * MINUTE
        );
      // 2026-11-02: on a busy Mac the line still moved (one let in every cpuOnlyMaxWaitMin), yet
      // a long line warned as if stuck. Only a line nobody left lately is a problem.
      const lastStart = deps.monitor.lastStartedAt?.() ?? 0;
      const moving = lastStart > 0 && now() - lastStart < 45 * MINUTE;
      // 2026-11-07: a high but steady swap (macOS slow to give it back, pressure left at warn)
      // lets one task in every steadySwapMaxWaitMin; who holds the memory
      // is the hint, for the user to close (nothing here kills).
      // The monitor's own grant (its long steady-swap clock, the rule on), not a fresh judgement:
      // a swap creeping up never gets a task in and must not be told it does.
      const grant = waiting.length > 0 ? deps.monitor.steadySwapGrant?.() : undefined;
      const steady = grant !== undefined;
      let holders = '';
      if (steady && deps.memoryHolders) {
        try {
          const found = await deps.memoryHolders();
          if (found.length) holders = `; holding the most memory: ${describeMemoryHolders(found)}`;
        } catch {
          // Only the hint is lost.
        }
      }
      if (steady && moving) {
        findings.push({
          key: 'resources:steady-swap',
          check: 'resources',
          severity: 'info',
          problem: `${waiting.length} task(s) wait on swap that is high but steady (${latest ? describeSample(latest) : ''}): memory has room, so one task is let in every ${grant?.waitMin} min; closing big programs gives swap back sooner${holders}`,
        });
      }
      if (waiting.length && !moving) {
        const first = waiting[0];
        const backupd = deps.backupd?.();
        const cause =
          backupd && backupd.forMs >= BACKUPD_BUSY_HOURS * HOUR
            ? `; ${describeBackupd(backupd)}, a reason for the wait`
            : '';
        findings.push({
          key: 'resources:waiting',
          check: 'resources',
          severity: 'warning',
          problem: `${waiting.length} task(s) have waited over an hour for room on the Mac (${first.queued?.resources?.detail}${latest ? `; now ${describeSample(latest)}` : ''}${cause}${steady ? `; swap is high but steady with memory room, one task is let in every ${grant?.waitMin} min` : ''}${holders}); config.json taskAdmission sets the thresholds, 'ut task retry <id>' starts one now`,
        });
      }
      // 2026-11-10: a turn cancelled GRANT_FORCE_AFTER times running let a task in anyway. Told
      // for an hour (info): tasks did get in, but a signal is flapping around its threshold.
      const forced = deps.monitor.forcedGrants?.();
      if (forced?.last && now() - forced.last.at < 60 * MINUTE) {
        findings.push({
          key: 'resources:grant-forced',
          check: 'resources',
          severity: 'info',
          problem: `task admission: the ${forced.last.clock} turn was cancelled ${forced.last.cancelled}× without letting a task in (its condition flaps around the threshold), so one task was let in anyway ${Math.round((now() - forced.last.at) / MINUTE)} min ago (${forced.count} so far); tasks keep coming in one at a time`,
        });
      }
      // 2026-11-08: a grant clock whose condition keeps flapping around the threshold was
      // cancelled before it fired, so the «one task every N min» rule never let anyone in. Since
      // 2026-11-10 the turn survives a wobble, keeps the time it waited and is forced after
      // GRANT_FORCE_AFTER cancellations (resource-monitor.ts); a counter reaching
      // GRANT_STALL_WARN with tasks waiting for room means none of that got a task in.
      const stalls = deps.monitor.grantStalls?.();
      const queuedForRoom = deps
        .tasks()
        .some((task) => task.state === 'queued' && task.queued?.resources?.short.length);
      if (stalls && queuedForRoom) {
        const which = [
          stalls.steady >= GRANT_STALL_WARN ? `steady-swap (${stalls.steady}×)` : '',
          stalls.cpu >= GRANT_STALL_WARN ? `CPU-only (${stalls.cpu}×)` : '',
        ].filter(Boolean);
        if (which.length) {
          findings.push({
            key: 'resources:grant-flapping',
            check: 'resources',
            severity: 'warning',
            problem: `a task-admission grant clock keeps resetting without ever letting a task in (${which.join(' and ')}): its condition flaps around the threshold, so the "one task every N min" rule never fires and tasks wait for room that is granted but never taken; config.json taskAdmission sets the thresholds, 'ut task retry <id>' starts one now`,
          });
        }
      }
      return findings;
    },
  };
}

/**
 * Security sweeps that stopped happening (2026-10-23): a project with the sweep on whose
 * rounds or advisory checks keep failing or being held back, which nobody would see otherwise.
 */
export function securitySweepCheck(deps: {
  stale: () => Array<{ repoPath: string; problem: string }>;
}): DoctorCheck {
  return {
    id: 'security-sweep',
    run() {
      return deps.stale().map(({ repoPath, problem }) => ({
        key: `security-sweep:${repoPath}:${problem.split(' in ')[0]}`,
        check: 'security-sweep',
        severity: 'warning' as const,
        problem: `${repoPath}: ${problem}`,
      }));
    },
  };
}

/**
 * config.json that cannot be saved (2026-11-11: the file was left read-only to stop a rewrite
 * loop with an older Mac app, and every setting changed after that failed with a line in the log
 * alone). Told while the last save failed or the file is not writable: settings changed
 * meanwhile live in memory only and are gone at the next restart.
 */
export function configWritableCheck(deps: {
  /** Why config.json cannot be saved (ConfigService.getSaveProblem); undefined when it can. */
  saveProblem: () => string | undefined;
  configPath: string;
}): DoctorCheck {
  return {
    id: 'config-writable',
    run() {
      const reason = deps.saveProblem();
      if (!reason) return [];
      return [
        {
          key: 'config-writable',
          check: 'config-writable',
          severity: 'warning',
          problem: `The server cannot save ${deps.configPath} (${reason}): settings changed from now on are not kept across a restart.`,
        },
      ];
    },
  };
}

/**
 * config.json that did not pass when the server read it (2026-11-11: it was replaced by the
 * defaults, and config.backup.json with it, with a warning in the log alone). The server runs
 * with what is valid in it and never rewrites it from the load; told until the file reads well.
 */
export function configValidCheck(deps: {
  /** What is wrong with config.json (ConfigService.getLoadProblem); undefined when nothing. */
  loadProblem: () => string | undefined;
}): DoctorCheck {
  return {
    id: 'config-valid',
    run() {
      const problem = deps.loadProblem();
      if (!problem) return [];
      return [{ key: 'config-valid', check: 'config-valid', severity: 'warning', problem }];
    },
  };
}

/** owner/name of a GitHub address (https or ssh), lower case; nothing for any other address. */
export function githubRepoOf(url: string): string | undefined {
  const match =
    /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(
      url.trim()
    );
  return match?.[1].toLowerCase();
}

/** How long an answer of the public repository's rules is kept: GitHub is not asked every run. */
export const PUBLIC_RULES_EVERY_MS = HOUR;

/**
 * What keeps the working history out of the public repository (2026-11-12: the working
 * repository went private and the public one receives a clean copy; the only guard was a hook
 * written by hand in one Mac's .git/hooks, which a fresh clone elsewhere would not have).
 * Only in the working repository, known by its tracked scripts/git-hooks: the public copy and
 * the installed app carry none and are not looked at.
 *
 *   - the push guard is the hook git would run (scripts/git-hooks/install.sh --check); when it
 *     is not, it is installed again, and only a failed install is a warning;
 *   - no remote of the repository (worktrees share them) points at the public repository;
 *   - the public repository has its rulesets (scripts/public-repo-rules.sh --check): missing
 *     ones are a warning; a repository still private, or GitHub out of reach, is a note.
 */
export function publishGuardCheck(deps: {
  /** The checkout the server runs from. */
  repo: string;
  /** owner/name of the public repository (the "homepage" of web/package.json). */
  publicRepo: () => string | undefined;
  exists: (file: string) => boolean;
  /** Runs a command in the repository; never throws: the exit status and what it printed. */
  run: (command: string, args: string[]) => Promise<{ code: number; output: string }>;
  now?: () => number;
}): DoctorCheck {
  const now = deps.now ?? Date.now;
  let rules: { at: number; code: number; output: string } | undefined;
  const lastLine = (output: string) => output.trim().split('\n').pop()?.trim() ?? '';
  return {
    id: 'publish-guard',
    async run() {
      const installer = `${deps.repo}/scripts/git-hooks/install.sh`;
      if (!deps.exists(installer)) return [];
      const findings: DoctorFinding[] = [];

      const guard = await deps.run('bash', [installer, '--check']);
      if (guard.code !== 0) {
        const install = await deps.run('bash', [installer]);
        const healed = install.code === 0;
        findings.push({
          key: 'publish-guard:hook',
          check: 'publish-guard',
          severity: healed ? 'info' : 'warning',
          problem: healed
            ? `The push guard of the working repository was not in place (${lastLine(guard.output)})`
            : `The push guard of the working repository is NOT in place and could not be installed: ${lastLine(install.output) || lastLine(guard.output)}. Until it is, a push from ${deps.repo} can reach any repository`,
          ...(healed ? { healed: 'installed again' } : {}),
        });
      }

      const publicRepo = deps.publicRepo()?.toLowerCase();
      // Remotes are read in every worktree: they share one configuration unless
      // extensions.worktreeConfig gives a worktree remotes of its own.
      const listed = await deps.run('git', ['-C', deps.repo, 'worktree', 'list', '--porcelain']);
      const worktrees = new Set([deps.repo]);
      for (const line of listed.code === 0 ? listed.output.split('\n') : []) {
        if (line.startsWith('worktree ')) worktrees.add(line.slice('worktree '.length).trim());
      }
      const told = new Set<string>();
      for (const worktree of worktrees) {
        if (worktree !== deps.repo && !deps.exists(worktree)) continue;
        const remotes = await deps.run('git', [
          '-C',
          worktree,
          'config',
          '--get-regexp',
          '^remote\\..*\\.(url|pushurl)$',
        ]);
        for (const line of remotes.code === 0 ? remotes.output.split('\n') : []) {
          const [key, url] = line.trim().split(/\s+/, 2);
          if (!key || !url || !publicRepo || githubRepoOf(url) !== publicRepo) continue;
          const name = key.replace(/^remote\./, '').replace(/\.(url|pushurl)$/, '');
          if (told.has(name)) continue;
          told.add(name);
          findings.push({
            key: `publish-guard:remote:${name}`,
            check: 'publish-guard',
            severity: 'warning',
            problem: `Remote '${name}' of the working repository (seen in ${worktree}) points at the public repository ${publicRepo}: the working history must never be pushed there. Remove it: git -C ${worktree} remote remove ${name}`,
          });
        }
      }

      const script = `${deps.repo}/scripts/public-repo-rules.sh`;
      if (deps.exists(script)) {
        if (!rules || now() - rules.at >= PUBLIC_RULES_EVERY_MS) {
          rules = { at: now(), ...(await deps.run('bash', [script, '--check'])) };
        }
        if (rules.code === 1) {
          const missing = rules.output
            .split('\n')
            .filter((line) => /^(MISSING|STALE)\s/.test(line))
            .map((line) => line.replace(/^(MISSING|STALE)\s+/, ''));
          findings.push({
            key: 'publish-guard:rules',
            check: 'publish-guard',
            severity: 'warning',
            problem: `The public repository ${publicRepo ?? ''} is visible without its rules: ${missing.join('; ') || lastLine(rules.output)}. Run: ${script} --apply`,
          });
        } else if (rules.code !== 0) {
          findings.push({
            key: `publish-guard:rules-unknown:${rules.code === 4 ? 'private' : 'unreachable'}`,
            check: 'publish-guard',
            severity: 'info',
            problem:
              rules.code === 4
                ? `The public repository ${publicRepo ?? ''} is still private, where GitHub's plan has no rulesets: run ${script} --apply right after making it public`
                : `The rules of the public repository could not be checked (${lastLine(rules.output)})`,
          });
        }
      }
      return findings;
    },
  };
}

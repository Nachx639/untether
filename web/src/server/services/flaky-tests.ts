/**
 * Tests flaky under load, per project (2026-11-02). A task's check that failed while the Mac
 * was over its load threshold runs again once the load drops (task-merge.ts); when that rerun
 * passes, the tests the first run failed are kept here, so they get fixed instead of hidden by
 * the rerun. `ut doctor` lists them per project (doctor-checks-tasks.ts flakyUnderLoadCheck).
 *
 * One JSON file, keyed by the project's folder (it follows renamed folders through
 * ProjectSettingsStore.followedBy). A test not seen again for `maxAgeDays` drops off (fixed,
 * or gone); each project keeps at most `maxPerProject`, the most recently seen.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface FlakyTest {
  /** How the check's output named it (`file > suite > test`). */
  name: string;
  /** How many reruns it failed before passing. */
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** The task whose check saw it last, and the peak load of that first run. */
  lastTaskId?: string;
  lastLoad?: number;
}

interface FlakyFile {
  version: 1;
  projects: Record<string, FlakyTest[]>;
}

export interface FlakyTestStoreOptions {
  maxAgeDays?: number;
  maxPerProject?: number;
  now?: () => number;
}

const DAY = 24 * 60 * 60 * 1000;

export class FlakyTestStore {
  private projects: Record<string, FlakyTest[]> = {};
  private readonly maxAgeMs: number;
  private readonly maxPerProject: number;
  private readonly now: () => number;

  constructor(
    private readonly file: string,
    options: FlakyTestStoreOptions = {}
  ) {
    this.maxAgeMs = (options.maxAgeDays ?? 14) * DAY;
    this.maxPerProject = options.maxPerProject ?? 50;
    this.now = options.now ?? Date.now;
    this.load();
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<FlakyFile>;
      if (data && typeof data.projects === 'object' && data.projects) {
        for (const [repo, tests] of Object.entries(data.projects)) {
          if (!Array.isArray(tests)) continue;
          const kept = tests.filter(
            (test): test is FlakyTest =>
              !!test && typeof test.name === 'string' && typeof test.lastSeen === 'string'
          );
          if (kept.length) this.projects[repo] = kept;
        }
      }
    } catch {
      // No file yet, or unreadable: start empty (the next record writes a good one).
    }
  }

  private save(): void {
    const data: FlakyFile = { version: 1, projects: this.projects };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // A list that could not be written is still in memory for the doctor.
    }
  }

  /** Drops tests not seen for maxAgeDays; true when something went. */
  private prune(): boolean {
    const cutoff = this.now() - this.maxAgeMs;
    let changed = false;
    for (const [repo, tests] of Object.entries(this.projects)) {
      const kept = tests.filter((test) => Date.parse(test.lastSeen) >= cutoff);
      if (kept.length !== tests.length) changed = true;
      if (kept.length) this.projects[repo] = kept;
      else delete this.projects[repo];
    }
    return changed;
  }

  /**
   * One rerun that passed after a failure under load: each named test counted. No names (the
   * first run named none) are kept as one entry with the run's last line, so it still shows.
   */
  record(
    repoPath: string,
    names: readonly string[],
    seen: { taskId?: string; load?: number; fallback?: string } = {}
  ): void {
    const list = names.length ? names : [`(no test named) ${seen.fallback ?? 'check failed'}`];
    const at = new Date(this.now()).toISOString();
    const tests = this.projects[repoPath] ?? [];
    for (const name of list) {
      const known = tests.find((test) => test.name === name);
      const entry: FlakyTest = known ?? { name, count: 0, firstSeen: at, lastSeen: at };
      entry.count++;
      entry.lastSeen = at;
      if (seen.taskId) entry.lastTaskId = seen.taskId;
      if (seen.load !== undefined) entry.lastLoad = seen.load;
      if (!known) tests.push(entry);
    }
    tests.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.count - a.count);
    this.projects[repoPath] = tests.slice(0, this.maxPerProject);
    this.prune();
    this.save();
  }

  /** Every project with tests flaky under load, the most recently seen first. */
  list(): Array<{ repoPath: string; tests: FlakyTest[] }> {
    if (this.prune()) this.save();
    return Object.entries(this.projects).map(([repoPath, tests]) => ({
      repoPath,
      tests: [...tests],
    }));
  }

  /** A project folder renamed or moved (ProjectSettingsStore.followedBy). */
  projectsMoved(moved: ReadonlyArray<{ from: string; to: string }>): number {
    let changed = 0;
    for (const { from, to } of moved) {
      const tests = this.projects[from];
      if (!tests) continue;
      const into = this.projects[to] ?? [];
      for (const test of tests) {
        const known = into.find((other) => other.name === test.name);
        if (!known) into.push(test);
        else {
          known.count += test.count;
          if (test.lastSeen > known.lastSeen) known.lastSeen = test.lastSeen;
          if (test.firstSeen < known.firstSeen) known.firstSeen = test.firstSeen;
        }
      }
      this.projects[to] = into;
      delete this.projects[from];
      changed++;
    }
    if (changed) this.save();
    return changed;
  }
}

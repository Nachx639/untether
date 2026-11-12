/**
 * Finished tasks' metrics per project (2026-11-03, shared/task-metrics.ts): what each cost, the
 * quality signals it showed and the saving features it ran with. tasks.json keeps only the
 * latest 100 settled tasks of every project together, too few and too mixed to compare the
 * saving features on; this ledger keeps each project's last `maxPerProject` (500).
 *
 * One JSON file, keyed by the project's folder (it follows renamed folders through
 * ProjectSettingsStore.followedBy), written atomically. A task is written again when its
 * metrics change after it finished (undone later, its last usage read). Without a file it
 * lives in memory only (tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentUsage,
  TaskCheckMetrics,
  TaskConflictMetrics,
  TaskQuality,
  TaskSavings,
} from '../../shared/task-metrics.js';
import type { TaskAgent, TaskState } from '../../shared/tasks.js';

export interface TaskMetricsEntry {
  taskId: string;
  name: string;
  agent: TaskAgent;
  state: TaskState;
  finishedAt: string;
  savings: TaskSavings;
  quality: TaskQuality;
  usage?: AgentUsage;
  cost?: number;
  /** The external model provider it ran against (model-providers.ts); kept out of comparisons. */
  modelProvider?: string;
  /** Its cost in US dollars, for a priced provider task. */
  usd?: number;
  /** What it shared with the project's other tasks and its conflict rounds (2026-11-11). */
  conflicts?: TaskConflictMetrics;
  /** Its check runs: made, reused, failed by load (2026-11-11). */
  checks?: TaskCheckMetrics;
}

interface LedgerFile {
  version: 1;
  projects: Record<string, TaskMetricsEntry[]>;
}

const valid = (entry: unknown): entry is TaskMetricsEntry => {
  const e = entry as Partial<TaskMetricsEntry> | null;
  return (
    !!e &&
    typeof e.taskId === 'string' &&
    typeof e.finishedAt === 'string' &&
    !!e.savings &&
    typeof e.savings.on === 'object' &&
    !!e.quality &&
    Array.isArray(e.quality.riskRules)
  );
};

export class TaskMetricsLedger {
  private projects: Record<string, TaskMetricsEntry[]> = {};
  private dirty = false;

  constructor(
    private readonly file?: string,
    private readonly maxPerProject = 500
  ) {
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<LedgerFile>;
      for (const [repo, entries] of Object.entries(data?.projects ?? {})) {
        if (!Array.isArray(entries)) continue;
        const kept = entries.filter(valid);
        if (kept.length) this.projects[repo] = kept;
      }
    } catch {
      // No file yet, or unreadable: start empty (the next finished task writes a good one).
    }
  }

  /** Adds a finished task, or replaces what was known of it. Written by flush(). */
  upsert(repoPath: string, entry: TaskMetricsEntry): void {
    const entries = (this.projects[repoPath] ?? []).filter((e) => e.taskId !== entry.taskId);
    entries.push(structuredClone(entry));
    entries.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
    this.projects[repoPath] = entries.slice(-this.maxPerProject);
    this.dirty = true;
  }

  /** Writes what changed since the last write. */
  flush(): void {
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    const data: LedgerFile = { version: 1, projects: this.projects };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // Still in memory for the report; the next change tries again.
      this.dirty = true;
    }
  }

  /** The project's finished tasks, newest last; at most the last `last`. */
  list(repoPath: string, last?: number): TaskMetricsEntry[] {
    const entries = this.projects[repoPath] ?? [];
    return last !== undefined ? entries.slice(-last) : [...entries];
  }

  /** A project folder renamed or moved (ProjectSettingsStore.followedBy). */
  projectsMoved(moved: ReadonlyArray<{ from: string; to: string }>): number {
    let changed = 0;
    for (const { from, to } of moved) {
      const entries = this.projects[from];
      if (!entries) continue;
      delete this.projects[from];
      for (const entry of entries) this.upsert(to, entry);
      changed++;
    }
    if (changed) this.flush();
    return changed;
  }
}

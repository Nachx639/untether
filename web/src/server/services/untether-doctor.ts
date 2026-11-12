/**
 * Untether's doctor (2026-10-20, user request: "a full suite that checks everything that can
 * fail, repairs it by itself, always checking"). Every few minutes it runs small checks, each
 * for a class of trouble seen for real (a dependency update that left node-pty unbuilt, tasks
 * and orchestrators stuck in a state with no way out, Claude Code changing its status words,
 * logs and casts growing without end, a burst of errors). A check heals what is safe to heal
 * (rebuild a native module, flush a stalled queue); what it can't, it tells once: to Untether's
 * own orchestrator when one runs (it fixes the code), else to the phone when it matters.
 * Each problem is told again only after it cleared, and its history is kept in doctor.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { every } from '../utils/periodic-loop.js';
import type { EventInput } from './event-log.js';

export type DoctorSeverity = 'info' | 'warning' | 'critical';

export interface DoctorFinding {
  /** One kind of trouble on one thing: stays the same while the trouble lasts. */
  key: string;
  check: string;
  severity: DoctorSeverity;
  /** What is wrong, in one English line (logs, the orchestrator). */
  problem: string;
  /** Set when the check fixed it now. */
  healed?: string;
}

export interface DoctorCheck {
  id: string;
  run(): Promise<DoctorFinding[]> | DoctorFinding[];
}

export interface DoctorReport {
  at: string;
  findings: DoctorFinding[];
  /** Checks that threw: a broken check is a finding too. */
  failedChecks: string[];
}

export interface UntetherDoctorDeps {
  checks: DoctorCheck[];
  /** Told once per problem: true when someone took it (Untether's orchestrator). */
  tellOrchestrator: (text: string) => boolean;
  /** The phone, for what matters and nobody else took. */
  push: (title: string, body: string) => void;
  log: (message: string) => void;
  /** The public event log (event-log.ts): each problem found, healed or cleared. */
  recordEvent?: (event: EventInput) => void;
  statePath?: string;
  now?: () => number;
  intervalMs?: number;
  firstRunMs?: number;
}

const HISTORY_MAX = 200;

interface DoctorState {
  /** Problems told and not cleared yet: key → when first seen. */
  open: Record<string, string>;
  history: Array<{ at: string; key: string; problem: string; healed?: string; cleared?: true }>;
  last?: DoctorReport;
}

export class UntetherDoctor {
  private state: DoctorState = { open: {}, history: [] };
  private timer?: NodeJS.Timeout;
  private running?: Promise<DoctorReport>;
  private readonly now: () => number;

  constructor(private readonly deps: UntetherDoctorDeps) {
    this.now = deps.now ?? Date.now;
    this.load();
  }

  start(): void {
    const intervalMs = this.deps.intervalMs ?? 5 * 60 * 1000;
    const first = setTimeout(
      () => {
        void this.runOnce();
        this.timer = every('doctor', () => this.runOnce(), intervalMs);
        this.timer.unref?.();
      },
      this.deps.firstRunMs ?? 60 * 1000
    );
    first.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The last report (GET /api/doctor, `ut project doctor`). */
  get lastReport(): DoctorReport | undefined {
    return this.state.last;
  }

  get history(): DoctorState['history'] {
    return this.state.history;
  }

  /** Run every check now (one run at a time). */
  runOnce(): Promise<DoctorReport> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** The check each open finding came from (this server's passes only). */
  private readonly openCheck = new Map<string, string>();

  private async run(): Promise<DoctorReport> {
    const at = new Date(this.now()).toISOString();
    const findings: DoctorFinding[] = [];
    const failedChecks: string[] = [];
    for (const check of this.deps.checks) {
      try {
        findings.push(...(await check.run()));
      } catch (error) {
        failedChecks.push(check.id);
        findings.push({
          key: `doctor-check-failed:${check.id}`,
          check: check.id,
          severity: 'warning',
          problem: `the doctor's check "${check.id}" itself failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const seen = new Set(findings.map((finding) => finding.key));
    const fresh: DoctorFinding[] = [];
    for (const finding of findings) {
      if (finding.healed) {
        this.record(at, finding.key, finding.problem, finding.healed);
        this.deps.log(`doctor healed ${finding.key}: ${finding.problem} → ${finding.healed}`);
        this.recordFinding(finding);
        fresh.push(finding);
        continue;
      }
      if (this.state.open[finding.key]) continue;
      this.state.open[finding.key] = at;
      this.record(at, finding.key, finding.problem);
      this.deps.log(`doctor found ${finding.key}: ${finding.problem}`);
      this.recordFinding(finding);
      fresh.push(finding);
    }
    for (const finding of findings) this.openCheck.set(finding.key, finding.check);
    for (const key of Object.keys(this.state.open)) {
      if (seen.has(key)) continue;
      // A check that failed this pass said nothing about its findings: they stay open
      // (2026-11-10: they were "cleared" and told again as new on the next pass). A key
      // whose check is not known (opened before this server started) waits for a pass with
      // no failed check.
      const check = this.openCheck.get(key);
      if (failedChecks.length && (check === undefined || failedChecks.includes(check))) continue;
      this.openCheck.delete(key);
      delete this.state.open[key];
      this.state.history.push({ at, key, problem: 'cleared', cleared: true });
      this.deps.recordEvent?.({ type: 'doctor.cleared', key });
    }
    this.tell(fresh);
    const report = { at, findings, failedChecks };
    this.state.last = report;
    this.save();
    return report;
  }

  /** New problems (and what was healed) go out in one note; critical ones nobody took, a push. */
  private tell(fresh: DoctorFinding[]): void {
    const worth = fresh.filter((finding) => finding.severity !== 'info' || finding.healed);
    if (!worth.length) return;
    const lines = worth.map(
      (finding) =>
        `- ${finding.healed ? 'healed' : finding.severity} · ${finding.check}: ${finding.problem}${finding.healed ? ` (${finding.healed})` : ''}`
    );
    const text = [
      "[untether] Untether's doctor (automatic checks of Untether itself, not the user):",
      ...lines,
      "Fix the cause in Untether's code (a task in this project), with a test; healed ones too, so they stop happening. Tell the user only what needs them.",
    ].join('\n');
    if (this.deps.tellOrchestrator(text)) return;
    const critical = worth.filter((finding) => finding.severity === 'critical' && !finding.healed);
    if (critical.length) {
      this.deps.push(
        'Untether needs a look',
        critical
          .map((finding) => finding.problem)
          .join(' · ')
          .slice(0, 300)
      );
    }
  }

  private recordFinding(finding: DoctorFinding): void {
    this.deps.recordEvent?.({
      type: 'doctor.finding',
      key: finding.key,
      check: finding.check,
      severity: finding.severity,
      message: finding.problem,
      healed: finding.healed,
    });
  }

  private record(at: string, key: string, problem: string, healed?: string): void {
    this.state.history.push({ at, key, problem, ...(healed ? { healed } : {}) });
    if (this.state.history.length > HISTORY_MAX) {
      this.state.history.splice(0, this.state.history.length - HISTORY_MAX);
    }
  }

  private load(): void {
    const file = this.deps.statePath;
    if (!file) return;
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DoctorState>;
      this.state = {
        open: stored.open && typeof stored.open === 'object' ? stored.open : {},
        history: Array.isArray(stored.history) ? stored.history.slice(-HISTORY_MAX) : [],
        ...(stored.last ? { last: stored.last } : {}),
      };
    } catch {
      // None yet, or unreadable: start clean.
    }
  }

  private save(): void {
    const file = this.deps.statePath;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      this.deps.log(`doctor state could not be saved: ${error}`);
    }
  }
}

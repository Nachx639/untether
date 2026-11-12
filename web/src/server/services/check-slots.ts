/**
 * Check slots for runs Untether does not start itself (2026-11-10): a task agent's heavy
 * check (check-slot-wrap.ts, through its PreToolUse hook) and a project's own scripts
 * (`ut check-slot run -- …`, check-slot-cli.ts) take a place in the SAME limiter as the merge
 * pipeline's verification runs (task-verify.ts checkLimiter): at most checkLoad.maxConcurrent
 * heavy runs per Mac whoever started them, none while the Mac is over checkLoad.maxLoadPerCore
 * or short of memory (up to checkLoad.maxWaitSec, then anyway), first come first served.
 *
 * A ticket is asked for over the API socket (op `check-slot`), polled while it waits and given
 * back when its run ends. Its holder is a process (the shell that runs the check, or `ut
 * check-slot run`): a ticket whose holder is gone is freed, and so is a waiting one nobody asks
 * about any more. One that leaves the line without having run (its Bash call timed out, a
 * Ctrl-C) keeps its place for PLACE_KEPT_MS: the same run asked again goes back where it was.
 * Running tickets are kept in a file, so a server restart does not let a second run start
 * beside one that still holds its slot.
 *
 * A run that says what it is (`command`: a check and nothing else, check-slot-wrap.ts
 * `onlyCheck`) is not made when the same command passed on the very same files before
 * (check-results.ts): asked at once, and again at its turn (the same tree in line twice runs
 * once). The ticket then says 'reused' and holds no slot. A run that ends with exit code 0, on
 * files that are the same before and after it, is kept for the next one.
 *
 * The scheduler asks `taskWait` so the wait of a task's agent is neither agent time
 * (task-scheduler-budgets.ts) nor a stall (task-scheduler-stall.ts).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import type { TaskResponse } from '../pty/socket-protocol.js';
import { every } from '../utils/periodic-loop.js';
import {
  type CheckIdentity,
  type CheckPass,
  type CheckResults,
  checkIdentity,
} from './check-results.js';
import { DEFAULT_CHECK_LOAD, type Limiter, type LoadGate } from './task-verify.js';

/** A waiting ticket nobody asked about for this long is taken out of the line. */
export const WAITING_SILENCE_MS = 30_000;
/** A place in line is kept this long after its ticket left without running. */
export const PLACE_KEPT_MS = 15 * 60_000;
/** A running ticket is freed after this long whatever its holder does. */
export const MAX_HOLD_MS = 3 * 60 * 60_000;
/** How often tickets are looked at (holder gone, silent, held too long). */
export const SWEEP_MS = 5_000;

export interface CheckSlotView {
  id: string;
  /** 'reused': not to be run, the same command passed on the same files (`reused`). */
  state: 'waiting' | 'running' | 'reused';
  /** When that run passed (ms), how long it took, and the tree it ran on. */
  reused?: { at: number; ms: number; tree: string };
  /** Runs in line in front of it. */
  ahead: number;
  /** Heavy runs going now, and how many may at once. */
  running: number;
  limit: number;
  /** The Mac is over its load threshold or short of memory: nothing starts meanwhile. */
  busy?: { load: number; threshold: number; memory?: string };
  /** When it joined the line (ms): kept by the caller across a server restart. */
  since: number;
  /** How long the caller waits at most before it runs without a slot. */
  maxWaitSec: number;
}

interface Ticket {
  id: string;
  pid: number;
  taskId?: string;
  label: string;
  key: string;
  since: number;
  state: 'waiting' | 'running' | 'reused';
  /** A check and nothing else: what it runs and where (asked about in the kept passes). */
  check?: { command: string; cwd: string };
  /** What it runs on, read as its run started. */
  identity?: CheckIdentity;
  reused?: CheckPass;
  /** Resolves once its kept pass was looked up as it asked (then it is in line, or reused). */
  looked?: Promise<void>;
  polledAt: number;
  startedAt?: number;
  /** Ends its turn in the limiter (set once it runs there). */
  free?: () => void;
  /** Whether its run was let go already (a release before the limiter started it). */
  done?: boolean;
  abort: AbortController;
}

export interface CheckSlotsOptions {
  limiter: Limiter;
  gate?: Pick<LoadGate, 'sample'>;
  /** config.json checkLoad.maxSlotWaitSec. */
  maxWaitSec?: () => number;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  /** Where the running tickets are kept across a restart. */
  file?: string;
  log?: (message: string) => void;
  /** The kept passes (check-results.ts); none: every run is made and none is kept. */
  results?: CheckResults;
  /** What a check started in `cwd` now would run on (tests swap it). */
  identify?: (cwd: string) => Promise<CheckIdentity | null>;
  /**
   * A run that took a slot ended (`ms`: how long it held it), or was not made because the same
   * tree had passed (`reusedMs`: how long that run took).
   */
  onRun?: (run: { taskId?: string; label: string; ms: number; reusedMs?: number }) => void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;

export class CheckSlots {
  private readonly tickets = new Map<string, Ticket>();
  private readonly places = new Map<string, { since: number; at: number }>();
  /** Per task: when its agent's last wait for a slot ended. */
  private readonly waitEnded = new Map<string, number>();
  private readonly now: () => number;
  private readonly pidAlive: (pid: number) => boolean;
  private timer: NodeJS.Timeout | undefined;
  /** The passes being kept (each reads the files once more after its run). */
  private keeping: Promise<void> = Promise.resolve();

  constructor(private readonly options: CheckSlotsOptions) {
    this.now = options.now ?? Date.now;
    this.pidAlive = options.pidAlive ?? alive;
    this.adopt();
  }

  /** Looks at the tickets every SWEEP_MS (the server; tests call sweep themselves). */
  start(): void {
    if (this.timer) return;
    this.timer = every('check slots sweep', () => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The API socket's `check-slot` op: acquire, status, release, list. */
  async handle(args: Record<string, unknown>): Promise<TaskResponse> {
    const action = args.action;
    if (action === 'list') return { ok: true, status: 'done', data: { ...this.summary() } };
    if (action === 'acquire') {
      const pid = Number(args.pid);
      if (!Number.isInteger(pid) || pid <= 1) {
        return {
          ok: false,
          code: 'bad-request',
          message: 'check-slot acquire needs its holder pid',
        };
      }
      const first = this.acquire({
        pid,
        label: text(args.label, 200) ?? 'check',
        taskId: text(args.taskId, 100),
        cwd: text(args.cwd, 4096),
        since: typeof args.since === 'number' ? args.since : undefined,
        command: text(args.command, 20_000),
      });
      // A check is told at once when it is not to be run (its kept pass is looked up first).
      await this.tickets.get(first.id)?.looked;
      const view = this.status(first.id) ?? first;
      return { ok: true, status: 'done', data: { ...view } };
    }
    const id = text(args.id, 100);
    if (!id) return { ok: false, code: 'bad-request', message: 'check-slot needs a ticket id' };
    if (action === 'status') {
      const view = this.status(id);
      return view
        ? { ok: true, status: 'done', data: { ...view } }
        : { ok: false, code: 'not-found', message: 'No such check slot ticket' };
    }
    if (action === 'release') {
      const released = this.release(id, {
        keepPlace: args.keepPlace === true,
        ...(typeof args.exitCode === 'number' ? { exitCode: args.exitCode } : {}),
      });
      return { ok: true, status: 'done', data: { released } };
    }
    return {
      ok: false,
      code: 'bad-request',
      message: `unknown check-slot action: ${String(action)}`,
    };
  }

  acquire(request: {
    pid: number;
    label: string;
    taskId?: string;
    cwd?: string;
    since?: number;
    /** The run is this check and nothing else: a kept pass of it stands for the run. */
    command?: string;
  }): CheckSlotView {
    this.sweep();
    const check =
      this.options.results && request.command?.trim() && request.cwd
        ? { command: request.command, cwd: request.cwd }
        : undefined;
    const at = this.now();
    const key = `${request.taskId ?? request.cwd ?? ''}\n${request.label}`;
    const place = this.places.get(key);
    this.places.delete(key);
    // The caller's own `since` is only a claim (it keeps a waiter's place across a server
    // restart, when no place is saved here): never earlier than the longest a caller waits,
    // so nobody jumps the line with since=0. A place saved here is the server's own word.
    const maxWaitMs = (this.options.maxWaitSec?.() ?? DEFAULT_CHECK_LOAD.maxSlotWaitSec) * 1000;
    const claimed =
      request.since !== undefined && Number.isFinite(request.since)
        ? Math.max(request.since, at - maxWaitMs)
        : at;
    const since = Math.min(at, place?.since ?? at, claimed);
    const ticket: Ticket = {
      id: crypto.randomBytes(8).toString('hex'),
      pid: request.pid,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      label: request.label,
      key,
      since,
      state: 'waiting',
      ...(check ? { check } : {}),
      polledAt: at,
      abort: new AbortController(),
    };
    this.tickets.set(ticket.id, ticket);
    if (check) {
      // Passed before on these very files: it does not even join the line. Else it joins it
      // where it stood when it asked (`since`).
      ticket.looked = this.look(check).then(({ pass }) => {
        if (ticket.done) return;
        if (pass) this.reuse(ticket, pass);
        else this.enter(ticket);
      });
    } else {
      this.enter(ticket);
    }
    return this.view(ticket);
  }

  status(id: string): CheckSlotView | undefined {
    const ticket = this.tickets.get(id);
    if (!ticket) return undefined;
    ticket.polledAt = this.now();
    // Told once that it is not to be run: nothing is left of it.
    if (ticket.state === 'reused') this.tickets.delete(id);
    return this.view(ticket);
  }

  /** Resolves once every pass being kept is (tests; a pass is kept after its slot is free). */
  settled(): Promise<void> {
    return this.keeping;
  }

  /** What `check` would run on now, and a kept pass of it. */
  private async look(check: {
    command: string;
    cwd: string;
  }): Promise<{ identity?: CheckIdentity; pass?: CheckPass }> {
    try {
      // A run that just ended may be keeping its pass: the same check behind it finds it.
      await this.keeping;
      const identity = await (this.options.identify ?? checkIdentity)(check.cwd);
      if (!identity) return {};
      const pass = this.options.results?.find(identity, check.command, 'shell');
      return { identity, ...(pass ? { pass } : {}) };
    } catch (error) {
      this.options.log?.(`[check-slot] could not read what ${check.cwd} holds: ${error}`);
      return {};
    }
  }

  private noteReused(pass: CheckPass, run: { taskId?: string; label: string }): void {
    this.options.log?.(
      `[check-slot] ${run.label}: reused, the same tree (${pass.tree.slice(0, 12)}) passed ${new Date(pass.at).toISOString()}`
    );
    try {
      this.options.onRun?.({
        ...(run.taskId ? { taskId: run.taskId } : {}),
        label: run.label,
        ms: 0,
        reusedMs: pass.ms,
      });
    } catch {
      // A failing listener never stops a run.
    }
  }

  /** Not to be run: a kept pass stands for it. Its slot, if it held one, goes to the next. */
  private reuse(ticket: Ticket, pass: CheckPass): void {
    ticket.reused = pass;
    ticket.state = 'reused';
    ticket.polledAt = this.now();
    if (ticket.taskId) this.waitEnded.set(ticket.taskId, this.now());
    ticket.done = true;
    ticket.free?.();
    this.noteReused(pass, ticket);
  }

  private reusedView(id: string, pass: CheckPass): CheckSlotView {
    const limiter = this.options.limiter;
    return {
      id,
      state: 'reused',
      reused: { at: pass.at, ms: pass.ms, tree: pass.tree },
      ahead: 0,
      running: limiter.active,
      limit: limiter.limit,
      since: this.now(),
      maxWaitSec: this.options.maxWaitSec?.() ?? DEFAULT_CHECK_LOAD.maxSlotWaitSec,
    };
  }

  /** Its turn came: it holds its slot from now. */
  private started(ticket: Ticket): void {
    if (ticket.state === 'waiting' && ticket.taskId) {
      this.waitEnded.set(ticket.taskId, this.now());
    }
    ticket.state = 'running';
    ticket.startedAt ??= this.now();
    this.persist();
  }

  /**
   * The turn of a run that is a check and nothing else: the files are read now (they may have
   * changed while it waited, and the same check may have passed on them meanwhile). A kept
   * pass: not run, its slot goes to the next. Else it runs, on what was read.
   */
  private async begin(ticket: Ticket): Promise<void> {
    const found = ticket.check ? await this.look(ticket.check) : {};
    if (ticket.done) return;
    if (found.pass) {
      this.reuse(ticket, found.pass);
      return;
    }
    if (found.identity) ticket.identity = found.identity;
    this.started(ticket);
  }

  /** A run that held a slot ended: counted, and its pass kept when the files did not change. */
  private ended(ticket: Ticket, at: number, exitCode: number | undefined): void {
    const ms = Math.max(0, at - (ticket.startedAt ?? at));
    try {
      this.options.onRun?.({
        ...(ticket.taskId ? { taskId: ticket.taskId } : {}),
        label: ticket.label,
        ms,
      });
    } catch {
      // A failing listener never stops a run.
    }
    const { check, identity } = ticket;
    const results = this.options.results;
    if (exitCode !== 0 || !check || !identity || !results) return;
    this.keeping = this.keeping
      .then(async () => {
        const after = await (this.options.identify ?? checkIdentity)(check.cwd);
        // Edited meanwhile (or the check rewrote files): its pass is of no tree in particular.
        if (!after || after.tree !== identity.tree || after.lock !== identity.lock) return;
        results.record({
          ...identity,
          command: check.command,
          runner: 'shell',
          ms,
          at,
          ...(ticket.taskId ? { taskId: ticket.taskId } : {}),
        });
      })
      .catch((error) => {
        this.options.log?.(`[check-slot] could not keep the pass of ${ticket.label}: ${error}`);
      });
  }

  /**
   * Gives a ticket back: a running one frees its slot, a waiting one leaves the line
   * (`keepPlace`: it did not run, the same run asked again gets its place back).
   */
  release(id: string, options: { keepPlace?: boolean; exitCode?: number } = {}): boolean {
    const ticket = this.tickets.get(id);
    if (!ticket) return false;
    this.tickets.delete(id);
    const at = this.now();
    if (ticket.state === 'running') this.ended(ticket, at, options.exitCode);
    if (ticket.state === 'waiting') {
      if (ticket.taskId) this.waitEnded.set(ticket.taskId, at);
      if (options.keepPlace) this.places.set(ticket.key, { since: ticket.since, at });
    }
    ticket.done = true;
    ticket.abort.abort();
    ticket.free?.();
    this.persist();
    return true;
  }

  /**
   * Whether a task's agent waits for a check slot now, and when its last such wait ended:
   * that time is not its agent's work, and its end counts as progress.
   */
  taskWait(taskId: string): { waiting: boolean; endedAt?: number } {
    let waiting = false;
    for (const ticket of this.tickets.values()) {
      if (ticket.taskId === taskId && ticket.state === 'waiting') waiting = true;
    }
    const endedAt = this.waitEnded.get(taskId);
    return { waiting, ...(endedAt !== undefined ? { endedAt } : {}) };
  }

  /** Frees tickets whose holder is gone, silent waiting ones and ones held too long. */
  sweep(): void {
    const at = this.now();
    // A ticket freed here leaves the map while it is walked: a Map allows that.
    for (const ticket of this.tickets.values()) {
      if (!this.pidAlive(ticket.pid)) {
        this.options.log?.(
          `[check-slot] ${ticket.id} (${ticket.label}): its holder ${ticket.pid} is gone, ${ticket.state === 'running' ? 'slot freed' : 'out of the line'}`
        );
        this.release(ticket.id, { keepPlace: true });
      } else if (ticket.state !== 'running' && at - ticket.polledAt > WAITING_SILENCE_MS) {
        this.release(ticket.id, { keepPlace: true });
      } else if (ticket.state === 'running' && at - (ticket.startedAt ?? at) > MAX_HOLD_MS) {
        this.options.log?.(
          `[check-slot] ${ticket.id} (${ticket.label}): held for over ${MAX_HOLD_MS / 3_600_000} h, slot freed`
        );
        this.release(ticket.id);
      }
    }
    for (const [key, place] of this.places) {
      if (at - place.at > PLACE_KEPT_MS) this.places.delete(key);
    }
    for (const [taskId, ended] of this.waitEnded) {
      if (at - ended > 24 * 3_600_000) this.waitEnded.delete(taskId);
    }
  }

  /** The tickets now (`ut check-slot status`, the doctor). */
  summary(): {
    running: number;
    limit: number;
    queued: number;
    tickets: Array<Pick<Ticket, 'id' | 'pid' | 'taskId' | 'label' | 'state' | 'since'>>;
  } {
    const limiter = this.options.limiter;
    return {
      running: limiter.active,
      limit: limiter.limit,
      queued: limiter.queued,
      tickets: [...this.tickets.values()].map(({ id, pid, taskId, label, state, since }) => ({
        id,
        pid,
        ...(taskId ? { taskId } : {}),
        label,
        state,
        since,
      })),
    };
  }

  /** The ticket takes its place in the shared limiter and holds its slot until released. */
  private enter(ticket: Ticket): void {
    this.options.limiter
      .run(
        () =>
          new Promise<void>((resolve) => {
            if (ticket.done) return resolve();
            ticket.free = resolve;
          }),
        () => {
          if (ticket.done) return;
          if (ticket.check && ticket.state === 'waiting') void this.begin(ticket);
          else this.started(ticket);
        },
        ticket.abort.signal,
        undefined,
        undefined,
        ticket.since
      )
      .catch(() => {
        // Left the line before it ran (release): nothing held.
      });
  }

  private view(ticket: Ticket): CheckSlotView {
    if (ticket.state === 'reused' && ticket.reused)
      return this.reusedView(ticket.id, ticket.reused);
    const limiter = this.options.limiter;
    let busy: CheckSlotView['busy'];
    // Said only when a slot is free and it is first: otherwise what it waits for is its turn
    // (2026-11-10: with the one slot taken it read "the Mac is short of memory").
    if (
      ticket.state === 'waiting' &&
      limiter.active < limiter.limit &&
      limiter.ahead(ticket.since) === 0
    ) {
      try {
        const sample = this.options.gate?.sample();
        if (sample?.high) {
          busy = {
            load: Math.round(sample.load * 10) / 10,
            threshold: sample.threshold,
            ...(sample.memory ? { memory: sample.memory } : {}),
          };
        }
      } catch {
        busy = undefined;
      }
    }
    return {
      id: ticket.id,
      state: ticket.state,
      ahead: ticket.state === 'waiting' ? limiter.ahead(ticket.since) : 0,
      running: limiter.active,
      limit: limiter.limit,
      ...(busy ? { busy } : {}),
      since: ticket.since,
      maxWaitSec: this.options.maxWaitSec?.() ?? DEFAULT_CHECK_LOAD.maxSlotWaitSec,
    };
  }

  /** The running tickets, for the next server start. */
  private persist(): void {
    const file = this.options.file;
    if (!file) return;
    const running = [...this.tickets.values()]
      .filter((ticket) => ticket.state === 'running')
      .map(({ id, pid, taskId, label, key, since, startedAt }) => ({
        id,
        pid,
        ...(taskId ? { taskId } : {}),
        label,
        key,
        since,
        startedAt,
      }));
    try {
      if (!running.length) {
        fs.rmSync(file, { force: true });
        return;
      }
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(running)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      this.options.log?.(`[check-slot] could not save the running tickets: ${error}`);
    }
  }

  /**
   * After a restart: the runs that held a slot and still go on take it again (first in line,
   * by when they joined), so the limiter counts them. Their holders see them running all along.
   */
  private adopt(): void {
    const file = this.options.file;
    if (!file) return;
    let saved: unknown;
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(saved)) return;
    const at = this.now();
    for (const entry of saved as Array<Record<string, unknown>>) {
      const pid = Number(entry.pid);
      const id = text(entry.id, 100);
      const startedAt = Number(entry.startedAt);
      if (!id || !Number.isInteger(pid) || pid <= 1 || !this.pidAlive(pid)) continue;
      if (!Number.isFinite(startedAt) || at - startedAt > MAX_HOLD_MS) continue;
      const ticket: Ticket = {
        id,
        pid,
        ...(text(entry.taskId, 100) ? { taskId: text(entry.taskId, 100) } : {}),
        label: text(entry.label, 200) ?? 'check',
        key: typeof entry.key === 'string' ? entry.key : '',
        since: Number.isFinite(Number(entry.since)) ? Number(entry.since) : startedAt,
        state: 'running',
        polledAt: at,
        startedAt,
        abort: new AbortController(),
      };
      this.tickets.set(id, ticket);
      this.enter(ticket);
    }
    this.persist();
  }
}

/**
 * Task-engine actions waiting for the user's OK (shared/task-confirmations.ts). Kept on disk
 * when a store path is given (2026-10-20: they lived in memory, a server restart dropped them
 * silently, the phone had nothing to approve and the orchestrator that asked still told the
 * user to approve it). Each one pushes "task-confirm"
 * (deep link /?confirm=<id>) and expires after CONFIRMATION_TTL_MS. Approving runs the stored
 * action through `run` (task-commands.ts runs it as the user); this store never decides what
 * needs an OK, it only keeps what does.
 *
 * autoApprove (the user's setting in config.json, off by default; 2026-10-24: "nothing should
 * wait for my OK"): `submit` approves at once instead of keeping it pending. The action runs
 * through the same `run` a phone approval uses, whoever asked gets its result directly, the
 * outcome is kept with the settled ones (autoApproved) and logged, and one informational
 * "task-auto-approved" push says what was done instead of the "task-confirm" one.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  CONFIRMATION_TTL_MS,
  type ConfirmationKind,
  MAX_PENDING_CONFIRMATIONS,
  type TaskConfirmation,
} from '../../shared/task-confirmations.js';
import type { NotificationPayload } from './push-notification-service.js';

export interface ConfirmationRequest<A> {
  kind: ConfirmationKind;
  where: string;
  summary: string;
  detail?: string[];
  taskId?: string;
  repoPath?: string;
  requestedBy: { sessionId?: string; name?: string };
  /** What runs once approved. */
  action: A;
  /** Same key while one is pending → that one is returned instead of a second push. */
  key: string;
}

/**
 * What became of a confirmation (`outcome`): waiting, or how it ended. Kept in memory for
 * SETTLED_KEEP_MS so whoever asked can learn the answer (`ut project orchestrate --wait`,
 * 2026-10-23); a restart forgets it (undefined: unknown).
 */
export type ConfirmationOutcome<R> =
  | { status: 'pending'; confirmation: TaskConfirmation }
  | { status: 'approved'; confirmation: TaskConfirmation; result: R }
  | { status: 'declined' | 'expired'; confirmation: TaskConfirmation }
  /** Approved, but running it threw. */
  | { status: 'failed'; confirmation: TaskConfirmation; message: string };

/** What `submit` did: kept it for the user's OK, or (autoApprove) ran it at once. */
export type SubmitOutcome<R> = Extract<
  ConfirmationOutcome<R>,
  { status: 'pending' | 'approved' | 'failed' }
>;

/** How long an answered or expired confirmation's outcome is kept, and how many at most. */
export const SETTLED_KEEP_MS = 24 * 60 * 60 * 1000;
const SETTLED_MAX = 200;

export type ConfirmationAnswer<R> =
  | { status: 'approved'; result: R }
  | { status: 'declined' }
  | { status: 'gone' };

interface Pending<A> {
  confirmation: TaskConfirmation;
  action: A;
  key: string;
}

export class TaskConfirmations<A, R> {
  private pending = new Map<string, Pending<A>>();
  private settled = new Map<string, { outcome: ConfirmationOutcome<R>; at: number }>();
  /** Auto-approved actions running now, by key: the same request again waits for that run. */
  private running = new Map<string, Promise<SubmitOutcome<R>>>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly deps: {
      run: (action: A) => Promise<R>;
      notify: (payload: NotificationPayload) => void;
      /**
       * A confirmation dropped unanswered (expired). 2026-10-20: whoever asked (an
       * orchestrator) was never told and waited for an answer that could not come.
       */
      onExpired?: (confirmation: TaskConfirmation) => void;
      /** Drops pushes still held for being seen that `matches` picks. */
      withdrawPush?: (matches: (payload: NotificationPayload) => boolean) => void;
      now?: () => number;
      ttlMs?: number;
      /** Where the pending ones survive a restart (private: 0600); none = memory only. */
      storePath?: string;
      onError?: (message: string) => void;
      /** The user's autoApprove setting, read on every submit; none = off. */
      autoApprove?: () => boolean;
      /** Why an approved action's result says it did not work (else undefined). */
      failedOf?: (result: R) => string | undefined;
      /** What was done without asking, for the server's log. */
      log?: (message: string) => void;
    }
  ) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? CONFIRMATION_TTL_MS;
    this.load();
  }

  /** The ones a restart left: back, each expiring when it was going to. */
  private load(): void {
    const file = this.deps.storePath;
    if (!file) return;
    let stored: unknown;
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.onError?.(`pending confirmations could not be read: ${error}`);
      }
      return;
    }
    const entries = (stored as { pending?: unknown })?.pending;
    if (!Array.isArray(entries)) return;
    for (const entry of entries as Pending<A>[]) {
      const id = entry?.confirmation?.id;
      if (typeof id !== 'string' || typeof entry.key !== 'string' || !entry.action) continue;
      this.pending.set(id, entry);
      this.expireLater(entry.confirmation);
    }
    // Ones that expired while the server was down are told now.
    this.prune();
  }

  private save(): void {
    const file = this.deps.storePath;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ pending: [...this.pending.values()] })}\n`, {
        mode: 0o600,
      });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
    } catch (error) {
      this.deps.onError?.(`pending confirmations could not be saved: ${error}`);
    }
  }

  /**
   * The session that asked for the waiting ones was reopened as `newSessionId`
   * (SessionReplacements): the answer reaches it there. `moveAction` points the stored action
   * at it too. Returns how many changed.
   */
  sessionReplaced(
    oldSessionId: string,
    newSessionId: string,
    moveAction: (action: A) => A = (action) => action
  ): number {
    let moved = 0;
    for (const entry of this.pending.values()) {
      if (entry.confirmation.requestedBy.sessionId !== oldSessionId) continue;
      entry.confirmation = {
        ...entry.confirmation,
        requestedBy: { ...entry.confirmation.requestedBy, sessionId: newSessionId },
      };
      entry.action = moveAction(entry.action);
      moved++;
    }
    if (moved) this.save();
    return moved;
  }

  /** The sessions that asked for the waiting ones (sessionReplaced moves these). */
  requesters(): string[] {
    return [...this.pending.values()]
      .map((entry) => entry.confirmation.requestedBy.sessionId ?? '')
      .filter(Boolean);
  }

  /** Its expiry is noticed when it comes, not only on the next look. */
  private expireLater(confirmation: TaskConfirmation): void {
    const left = Date.parse(confirmation.expiresAt) - this.now();
    const timer = setTimeout(() => this.prune(), Math.max(0, left) + 1000);
    timer.unref?.();
  }

  /**
   * `request`, unless the user's autoApprove is on: then it is approved at once (one that
   * waited from before with the same key too) and the caller gets what running it did.
   */
  async submit(request: ConfirmationRequest<A>): Promise<SubmitOutcome<R>> {
    if (!this.deps.autoApprove?.()) {
      return { status: 'pending', confirmation: this.request(request) };
    }
    this.prune();
    for (const [id, entry] of this.pending) {
      if (entry.key === request.key) return this.approveWaiting(id);
    }
    const running = this.running.get(request.key);
    if (running) return running;
    const job = this.runApproved(
      { ...this.build(request), autoApproved: true },
      request.action
    ).finally(() => this.running.delete(request.key));
    this.running.set(request.key, job);
    return job;
  }

  /**
   * Every one still waiting, approved now (the user just turned autoApprove on: nothing waits
   * any more), oldest first. Each settled outcome is returned so whoever asked can be told.
   */
  async approveAllWaiting(): Promise<SubmitOutcome<R>[]> {
    this.prune();
    const outcomes: SubmitOutcome<R>[] = [];
    for (const id of this.pending.keys()) {
      if (this.pending.has(id)) outcomes.push(await this.approveWaiting(id));
    }
    return outcomes;
  }

  private approveWaiting(id: string): Promise<SubmitOutcome<R>> {
    const entry = this.pending.get(id) as Pending<A>;
    this.pending.delete(id);
    this.save();
    return this.runApproved({ ...entry.confirmation, autoApproved: true }, entry.action);
  }

  /** An action approved by the autoApprove setting: run, kept as settled, logged, told. */
  private async runApproved(confirmation: TaskConfirmation, action: A): Promise<SubmitOutcome<R>> {
    let outcome: SubmitOutcome<R>;
    let failed: string | undefined;
    try {
      const result = await this.deps.run(action);
      failed = this.deps.failedOf?.(result);
      outcome = { status: 'approved', confirmation, result };
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
      outcome = { status: 'failed', confirmation, message: failed };
    }
    this.settle(outcome);
    this.deps.log?.(
      `Approved without asking (autoApprove): ${confirmation.summary}${failed ? ` (it did not work: ${failed})` : ''}`
    );
    try {
      this.deps.notify(autoApprovedPayload(confirmation, failed));
    } catch (error) {
      this.deps.onError?.(`the auto-approved notice could not be sent: ${error}`);
    }
    return structuredClone(outcome);
  }

  /** Keep `request` until the user answers, and push it (once per key while it waits). */
  request(request: ConfirmationRequest<A>): TaskConfirmation {
    this.prune();
    for (const entry of this.pending.values()) {
      if (entry.key === request.key) return structuredClone(entry.confirmation);
    }
    while (this.pending.size >= MAX_PENDING_CONFIRMATIONS) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      const dropped = this.pending.get(oldest);
      this.pending.delete(oldest);
      if (dropped) this.deps.onExpired?.(structuredClone(dropped.confirmation));
      this.save();
    }
    const confirmation = this.build(request);
    this.pending.set(confirmation.id, { confirmation, action: request.action, key: request.key });
    this.save();
    this.expireLater(confirmation);
    this.deps.notify(confirmationPayload(confirmation));
    return structuredClone(confirmation);
  }

  private build(request: ConfirmationRequest<A>): TaskConfirmation {
    const now = this.now();
    return {
      id: randomUUID(),
      kind: request.kind,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      where: request.where,
      summary: request.summary,
      detail: (request.detail ?? []).slice(0, 40).map((line) => line.slice(0, 2000)),
      requestedBy: request.requestedBy,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.repoPath ? { repoPath: request.repoPath } : {}),
    };
  }

  /** The ones still waiting, oldest first. */
  list(): TaskConfirmation[] {
    this.prune();
    return [...this.pending.values()].map((entry) => structuredClone(entry.confirmation));
  }

  get(id: string): TaskConfirmation | undefined {
    this.prune();
    const entry = this.pending.get(id);
    return entry ? structuredClone(entry.confirmation) : undefined;
  }

  /** The user's answer; an approved action runs now. Each confirmation is answered once. */
  async answer(id: string, approve: boolean): Promise<ConfirmationAnswer<R>> {
    this.prune();
    const entry = this.pending.get(id);
    if (!entry) return { status: 'gone' };
    this.pending.delete(id);
    this.save();
    const confirmation = entry.confirmation;
    if (!approve) {
      this.settle({ status: 'declined', confirmation });
      return { status: 'declined' };
    }
    try {
      const result = await this.deps.run(entry.action);
      this.settle({ status: 'approved', confirmation, result });
      return { status: 'approved', result };
    } catch (error) {
      // Approved, but it threw: the asker must not wait for a start that never comes.
      const message = error instanceof Error ? error.message : String(error);
      this.settle({ status: 'failed', confirmation, message });
      throw error;
    }
  }

  /** Waiting, approved (with what it did), declined or expired; undefined: unknown id. */
  outcome(id: string): ConfirmationOutcome<R> | undefined {
    this.prune();
    const entry = this.pending.get(id);
    if (entry) return { status: 'pending', confirmation: structuredClone(entry.confirmation) };
    const settled = this.settled.get(id)?.outcome;
    return settled ? structuredClone(settled) : undefined;
  }

  private settle(outcome: ConfirmationOutcome<R>): void {
    const now = this.now();
    const { id: settledId } = outcome.confirmation;
    this.deps.withdrawPush?.(
      (push) => push.type === 'task-confirm' && push.data?.confirmId === settledId
    );
    this.settled.set(outcome.confirmation.id, { outcome, at: now });
    for (const [id, entry] of this.settled) {
      if (this.settled.size <= SETTLED_MAX && now - entry.at < SETTLED_KEEP_MS) break;
      this.settled.delete(id);
    }
  }

  /** Drops the expired ones (each told once through onExpired). Called on every look. */
  prune(): void {
    const now = this.now();
    let changed = false;
    for (const [id, entry] of this.pending) {
      if (Date.parse(entry.confirmation.expiresAt) <= now) {
        this.pending.delete(id);
        changed = true;
        this.settle({ status: 'expired', confirmation: entry.confirmation });
        try {
          this.deps.onExpired?.(structuredClone(entry.confirmation));
        } catch {
          // A listener's trouble never keeps the store from pruning.
        }
      }
    }
    if (changed) this.save();
  }
}

/** The "task-confirm" push; the phone shows the kind in its language (sw-notify-i18n.ts). */
export function confirmationPayload(confirmation: TaskConfirmation): NotificationPayload {
  const detail = confirmation.detail[0] ?? '';
  return {
    type: 'task-confirm',
    title: `🔐 Confirm · ${confirmation.where}`,
    body: confirmation.summary.slice(0, 200),
    icon: '/apple-touch-icon.png',
    badge: '/favicon-32.png',
    tag: `untether-confirm-${confirmation.id}`,
    requireInteraction: true,
    actions: [
      { action: 'view-session', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
    data: {
      type: 'task-confirm',
      confirmId: confirmation.id,
      kind: confirmation.kind,
      where: confirmation.where,
      detail: detail.slice(0, 200),
      ...(confirmation.taskId ? { taskId: confirmation.taskId } : {}),
      timestamp: confirmation.createdAt,
    },
  };
}

/**
 * The push for an action the autoApprove setting approved at once: informational, nothing to
 * answer ("✅ Done without asking"; the phone words it in its language, sw-notify-i18n.ts).
 * `failed`: it was approved but did not work.
 */
export function autoApprovedPayload(
  confirmation: TaskConfirmation,
  failed?: string
): NotificationPayload {
  const detail = confirmation.detail[0] ?? '';
  const body = failed ? `${confirmation.summary}: ${failed}` : confirmation.summary;
  return {
    type: 'task-auto-approved',
    title: failed
      ? `⚠️ Approved without asking, but it failed · ${confirmation.where}`
      : `✅ Done without asking · ${confirmation.where}`,
    body: body.slice(0, 200),
    icon: '/apple-touch-icon.png',
    badge: '/favicon-32.png',
    tag: `untether-auto-approved-${confirmation.id}`,
    actions: [
      { action: 'view-session', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
    data: {
      type: 'task-auto-approved',
      confirmId: confirmation.id,
      kind: confirmation.kind,
      where: confirmation.where,
      detail: detail.slice(0, 200),
      ...(failed ? { failed: failed.slice(0, 200) } : {}),
      ...(confirmation.taskId ? { taskId: confirmation.taskId } : {}),
      timestamp: confirmation.createdAt,
    },
  };
}

/**
 * Suspended sessions on the client (2026-10-31, server: services/session-suspender.ts). Untether
 * suspends an idle Claude session to free memory: the server records it as exited with a
 * `suspended` record, but to the user it is paused, not finished. It stays where it was in the
 * lists (with a "paused" mark) and a tap wakes it (same session id) and opens it.
 */
import type { Session } from '../../shared/types.js';
import { type MessageKey, t } from '../i18n/index.js';

type Listed = { status?: string; suspended?: unknown };

/** Paused by Untether to free memory (it wakes when opened). */
export function isSuspended(session: Listed | null | undefined): boolean {
  return !!session?.suspended;
}

/** Finished for good: exited and not merely suspended. Lists use this, not `status`. */
export function isFinishedSession(session: Listed): boolean {
  return session.status === 'exited' && !session.suspended;
}

/** Wakes in flight, per session: a double tap or two views share one wake. */
const wakes = new Map<string, Promise<{ sessionId: string }>>();

/**
 * Wakes a suspended session (POST /api/sessions/:id/wake); resolves once its Claude runs its
 * conversation again. Throws with the server's reason when it could not wake: the session then
 * stays suspended, with that error shown on its row and a tap to retry.
 */
export function wakeSession(
  sessionId: string,
  authHeader?: Record<string, string>
): Promise<{ sessionId: string }> {
  const pending = wakes.get(sessionId);
  if (pending) return pending;
  const attempt = (async () => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
    });
    const body = (await response.json().catch(() => ({}))) as {
      sessionId?: unknown;
      error?: unknown;
    };
    if (!response.ok) {
      throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
    }
    return { sessionId: typeof body.sessionId === 'string' ? body.sessionId : sessionId };
  })().finally(() => wakes.delete(sessionId));
  wakes.set(sessionId, attempt);
  return attempt;
}

/** The session's "keep awake" (never suspended). Resolves to whether the server took it. */
export async function setKeepAwake(
  sessionId: string,
  keepAwake: boolean,
  authHeader?: Record<string, string>
): Promise<boolean> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/keep-awake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ keepAwake }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** A Claude session Untether may suspend (where "keep awake" means something). */
export function canKeepAwake(session: Pick<Session, 'shielded' | 'command' | 'status'> & Listed) {
  return (
    !!session.shielded &&
    !isFinishedSession(session) &&
    (session.command ?? []).some((arg) => arg.split('/').pop() === 'claude')
  );
}

// ---- The "Suspended" section and "Suspend" by hand (2026-10-31) ---------------------------

/**
 * The lists' two parts: live sessions (running or starting) and suspended ones, which have
 * their own "Suspended (n)" section so they are not mixed with the live ones. Finished
 * sessions are in neither.
 */
export function splitSuspended<T extends Listed>(
  sessions: readonly T[]
): { live: T[]; suspended: T[] } {
  const live: T[] = [];
  const suspended: T[] = [];
  for (const session of sessions) {
    if (isSuspended(session)) suspended.push(session);
    else if (session.status === 'running' || session.status === 'starting') live.push(session);
  }
  return { live, suspended };
}

/** When it was suspended (epoch ms), or undefined. */
export function suspendedAt(session: { suspended?: { at?: unknown } | null }): number | undefined {
  const at = session.suspended?.at;
  const ms = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

/** Suspended sessions, the most recently paused first. */
export function sortSuspended<T extends { suspended?: { at?: unknown } | null }>(
  sessions: readonly T[]
): T[] {
  return [...sessions].sort((a, b) => (suspendedAt(b) ?? 0) - (suspendedAt(a) ?? 0));
}

/** What keeps a session awake, by kind (server: blockerKind in session-suspender.ts). */
export type SuspendBlockerKind =
  | 'busy'
  | 'question'
  | 'draft'
  | 'background'
  | 'scheduled'
  | 'tasks'
  | 'waking'
  | 'notAllowed'
  | 'unknown';

const BLOCKER_KINDS: readonly SuspendBlockerKind[] = [
  'busy',
  'question',
  'draft',
  'background',
  'scheduled',
  'tasks',
  'waking',
  'notAllowed',
  'unknown',
];

export interface SuspendBlocker {
  kind: SuspendBlockerKind;
  /** The server's own reason (English), for the detail. */
  reason: string;
}

export type SuspendResult =
  | { ok: true }
  | { ok: false; blockers: SuspendBlocker[] }
  | { ok: false; error: string };

/** A shielded Claude session that runs: "Suspend" is offered (nowhere else). */
export function canSuspend(session: Pick<Session, 'shielded' | 'command' | 'status'> & Listed) {
  return canKeepAwake(session) && session.status === 'running' && !isSuspended(session);
}

/**
 * Suspends a session now (POST /api/sessions/:id/suspend). The server suspends it only when
 * nothing keeps it awake; otherwise it answers each reason (`blockers`) and nothing changes.
 */
export async function suspendSession(
  sessionId: string,
  authHeader?: Record<string, string>
): Promise<SuspendResult> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/suspend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      blockers?: unknown;
    };
    if (response.ok) return { ok: true };
    if (response.status === 409 && Array.isArray(body.blockers)) {
      const blockers = body.blockers
        .filter(
          (entry): entry is { kind: unknown; reason: unknown } =>
            !!entry && typeof entry === 'object'
        )
        .map((entry) => ({
          kind: BLOCKER_KINDS.includes(entry.kind as SuspendBlockerKind)
            ? (entry.kind as SuspendBlockerKind)
            : 'unknown',
          reason: typeof entry.reason === 'string' ? entry.reason : '',
        }));
      return { ok: false, blockers };
    }
    return {
      ok: false,
      error: typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** One line per kind of reason, in the user's language, in the order they came. */
export function blockerLines(blockers: readonly SuspendBlocker[]): string[] {
  const kinds = [...new Set(blockers.map((blocker) => blocker.kind))];
  return kinds.map((kind) => t(`suspend.reason.${kind}` as MessageKey));
}

/**
 * "Suspend" from a menu: suspends it and tells how it went (a toast); when something keeps it
 * awake, each reason in the user's language. Resolves to whether it was suspended.
 */
export async function suspendWithFeedback(
  session: Pick<Session, 'id'>,
  authHeader?: Record<string, string>
): Promise<boolean> {
  const result = await suspendSession(session.id, authHeader);
  // Loaded here: this module is also read where there is no DOM (pinned-sessions, the server's
  // tests), and the toast pulls in the icons.
  const { toast } = await import('./action-toast.js');
  if (result.ok) {
    toast({ kind: 'success', text: t('suspend.done') });
    return true;
  }
  if ('blockers' in result) {
    const lines = blockerLines(result.blockers);
    toast({
      kind: 'attention',
      text: `${t('suspend.blocked')} ${lines.join(' · ')}`,
      key: `suspend-blocked-${session.id}`,
      timeoutMs: 10_000,
    });
  } else {
    toast({ kind: 'error', text: t('suspend.failed', { error: result.error }) });
  }
  return false;
}

/**
 * The "Suspended" section's project groups, from a grouping by project (project-groups.ts
 * groupSessionsByRepo, which keeps a paused orchestrator in its project): each group's
 * sessions the most recently paused first, the groups by their latest pause, no project last.
 */
export function suspendedGroups<T extends { suspended?: { at?: unknown } | null }>(
  groups: ReadonlyMap<string | null, readonly T[]>
): Array<{ key: string | null; sessions: T[] }> {
  const latest = (sessions: readonly T[]) =>
    Math.max(0, ...sessions.map((s) => suspendedAt(s) ?? 0));
  return [...groups.entries()]
    .map(([key, sessions]) => ({ key, sessions: sortSuspended(sessions) }))
    .sort((a, b) => {
      if ((a.key === null) !== (b.key === null)) return a.key === null ? 1 : -1;
      return latest(b.sessions) - latest(a.sessions);
    });
}
